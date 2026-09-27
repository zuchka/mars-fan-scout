import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoAccess } from "./demo-access.mjs";
import { zipSync, strToU8 } from "fflate";
import { ReviewStore } from "./review-agent/store.mjs";
import { ReviewBudget } from "./review-agent/budget.mjs";
import { ReviewRunner } from "./review-agent/runner.mjs";
import { makeOpenAIProvider, MODEL as reviewModel } from "./review-agent/provider.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = resolve(root, "public");
const localEnv = resolve(root, ".env.local");
if (existsSync(localEnv)) {
  for (const line of readFileSync(localEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const apiKey = process.env.ROBOFLOW_API_KEY || "";
const modelId = process.env.ROBOFLOW_MODEL_ID || "";
const modelIdValid = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(modelId);
const configured = !!apiKey && modelIdValid;
const training = process.env.ROBOFLOW_MODEL_TRAINING === "1";
const replay = process.env.ROBOFLOW_REPLAY === "1";
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const dailyLimit = Number(process.env.DEMO_DAILY_LIMIT || 0);
if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error("DEMO_DAILY_LIMIT must be a nonnegative integer");
const access = createDemoAccess({ code:process.env.DEMO_ACCESS_CODE || "", dailyLimit, usagePath:resolve(root, ".demo-usage.json") });
if (!["127.0.0.1", "localhost", "::1"].includes(host) && (!access.accessRequired || dailyLimit === 0)) {
  throw new Error("Network binding requires DEMO_ACCESS_CODE and a positive DEMO_DAILY_LIMIT");
}
const mime = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".webp":"image/webp", ".svg":"image/svg+xml" };
const sceneData = JSON.parse(readFileSync(resolve(publicDir, "scenes.json"), "utf8"));
const sceneAssets = new Map(sceneData.map(scene => [scene.id, scene.image]));
const recordedDir = resolve(root, "recorded");
const evaluationFile = resolve(root, "evaluation/locked/score.json");
const recordingsComplete = sceneData.every(scene => existsSync(resolve(recordedDir, scene.id + ".json")));
const ready = replay ? recordingsComplete : configured && !training;
const reviewStore = new ReviewStore(resolve(root, process.env.REVIEW_AGENT_DATA_DIR || ".review-agent"));
await reviewStore.init();
const reviewBudget = new ReviewBudget(resolve(root, ".review-agent-budget.json"), {
  dailyCallLimit: process.env.REVIEW_AGENT_DAILY_CALL_LIMIT,
  dailyUsdLimit: process.env.REVIEW_AGENT_DAILY_USD_LIMIT,
  perRunUsdLimit: process.env.REVIEW_AGENT_PER_CANDIDATE_USD_LIMIT,
});
const reviewProvider = process.env.REVIEW_AGENT_ENABLED === "1" && process.env.OPENAI_API_KEY
  ? makeOpenAIProvider({ key: process.env.OPENAI_API_KEY }) : null;
const reviewRunner = new ReviewRunner({ store: reviewStore, budget: reviewBudget, provider: reviewProvider });
const reviewFixtures = JSON.parse(readFileSync(resolve(root, "evaluation/agent-review/manifest.json"), "utf8"));

function send(response, status, data, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type":type, "cache-control":"no-store", "x-content-type-options":"nosniff" });
  response.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

async function readBody(request, max = 4096) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > max) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

async function readLargeJson(request, max = 70 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicReviewSession(session) {
  const complete = session.candidates.every(candidate => Object.values(session.reviews).some(review => review.candidate_id === candidate.id && review.stage === "timed"));
  return { format: session.format, id: session.id, created_at: session.created_at, image: session.image, fixture_id: session.fixture_id,
    snapshot_sha256: session.snapshot_sha256, detector_model: session.detector_model, detector_responses_sha256: session.detector_responses_sha256, candidates: session.candidates,
    runs: Object.fromEntries(Object.entries(session.runs).map(([id, run]) => [id, reviewRunner.publicRun(session, run)])),
    reviews: Object.values(session.reviews).map(review => complete || review.stage === "timed" ? review :
      { candidate_id: review.candidate_id, stage: review.stage, reviewer: review.reviewer, at: review.at, decision: null }), complete };
}

function needsReviewAuth(request, response) {
  if (!access.accessRequired || !access.authorized(request.headers["x-demo-access-code"])) {
    send(response, 401, { error: "Meeting code is required for review sessions" }); return true;
  }
  return false;
}

async function readImage(request, max = 3 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error("Image tile is too large");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
    throw new Error("Expected a JPEG image tile");
  }
  return data;
}

async function inferImage(data) {
  const [workspace, model] = modelId.split("/");
  const endpoint = new URL("https://serverless.roboflow.com/" + encodeURIComponent(workspace) + "/" + encodeURIComponent(model));
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("confidence", "0.2");
  let response;
  try {
    response = await fetch(endpoint, {
      method:"POST",
      headers:{ "content-type":"application/x-www-form-urlencoded" },
      body:data.toString("base64"),
      signal:AbortSignal.timeout(45000),
    });
  } catch (_) {
    return { status:502, body:{ error:"Roboflow inference is temporarily unreachable" } };
  }
  if (!response.ok) return { status:502, body:{ error:"Roboflow returned HTTP " + response.status + ". Check the model ID, training status, and API key." } };
  try {
    return { status:200, body:await response.json() };
  } catch (_) {
    return { status:502, body:{ error:"Roboflow returned an unreadable response" } };
  }
}

async function infer(sceneId) {
  const asset = sceneAssets.get(sceneId);
  if (!asset) return { status:404, body:{ error:"Unknown observation" } };
  if (!ready) return { status:503, body:{ error:"Roboflow model is not connected" } };
  if (replay) {
    try {
      const saved = JSON.parse(await readFile(resolve(recordedDir, sceneId + ".json"), "utf8"));
      if (saved.model_id !== modelId) return { status:503, body:{ error:"Recorded result does not match the configured model" } };
      return { status:200, body:{ ...saved.response, recorded:true, recorded_at:saved.recorded_at } };
    } catch (_) {
      return { status:503, body:{ error:"Recorded result is unavailable" } };
    }
  }
  const jpegAsset = asset.replace(/\.webp$/, ".jpg");
  const file = resolve(publicDir, existsSync(resolve(publicDir, jpegAsset)) ? jpegAsset : asset);
  return inferImage(await readFile(file));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/status") {
      const granted = access.authorized(request.headers["x-demo-access-code"]);
      return send(response, 200, { ready, scout_ready:configured && !training && !replay, configured, training:training && !replay, mode:replay ? "recorded" : "live", model_id:modelIdValid ? modelId : null, access_required:access.accessRequired, access_granted:granted, daily_remaining:granted ? access.remaining() : null,
        review_agent: granted ? { ...reviewBudget.status(), enabled: reviewRunner.enabled && reviewBudget.status().enabled, model: reviewModel } : { enabled: false } });
    }
    if (request.method === "GET" && url.pathname === "/api/scout/evaluation") {
      try {
        const result = JSON.parse(await readFile(evaluationFile, "utf8"));
        return send(response, 200, {
          model_id:result.model_id, observation:result.observation, threshold:result.threshold,
          sample_crops:result.sample_crops, visible_clear_deposits:result.visible_clear_deposits,
          matched_deposits:result.matched_deposits, unmatched_predictions:result.unmatched_predictions,
          ignored_predictions:result.ignored_predictions, candidate_precision:result.candidate_precision,
          deposit_recall:result.deposit_recall, method:result.method,
        });
      } catch (_) { return send(response, 404, { error:"No independent review is available yet" }); }
    }
    if (url.pathname === "/api/scout/review-sessions" && request.method === "POST") {
      if (needsReviewAuth(request, response)) return;
      let body;
      try { body = await readLargeJson(request); }
      catch (error) { return send(response, 400, { error: error.message }); }
      try {
        if (body?.fixture_id) {
          const fixture = reviewFixtures.crops.find(crop => crop.id === body.fixture_id);
          if (!fixture) throw new Error("Unknown fixed crop");
          body = { fixture_id: fixture.id, image_base64: (await readFile(resolve(root, fixture.image))).toString("base64"),
            name: fixture.id + ".jpg", observation: fixture.observation, detector_model: reviewFixtures.model_id,
            candidates: fixture.candidates, detector_responses: [JSON.parse(await readFile(resolve(root, fixture.detector_response), "utf8"))] };
        }
        return send(response, 201, publicReviewSession(await reviewStore.create(body)));
      }
      catch (error) { return send(response, 400, { error: error.message }); }
    }
    if (request.method === "GET" && url.pathname === "/api/scout/review-fixtures") {
      if (needsReviewAuth(request, response)) return;
      return send(response, 200, { format: reviewFixtures.format, model_id: reviewFixtures.model_id, selection: reviewFixtures.selection,
        crops: reviewFixtures.crops.map(crop => ({ id: crop.id, observation: crop.observation, candidates: crop.candidates.length })) });
    }
    const fixtureMatch = url.pathname.match(/^\/api\/scout\/review-fixtures\/(locked-0[1-6])(?:\/(image))?$/);
    if (request.method === "GET" && fixtureMatch) {
      if (needsReviewAuth(request, response)) return;
      const fixture = reviewFixtures.crops.find(crop => crop.id === fixtureMatch[1]);
      if (!fixture) return send(response, 404, { error: "Unknown fixed crop" });
      if (fixtureMatch[2] === "image") return send(response, 200, await readFile(resolve(root, fixture.image)), "image/jpeg");
      return send(response, 200, { ...fixture, detector_model: reviewFixtures.model_id,
        detector_responses: [JSON.parse(await readFile(resolve(root, fixture.detector_response), "utf8"))] });
    }
    const reviewMatch = url.pathname.match(/^\/api\/scout\/review-sessions\/([a-f0-9-]{36})(?:\/(.*))?$/);
    if (reviewMatch) {
      if (needsReviewAuth(request, response)) return;
      const session = reviewStore.get(reviewMatch[1]);
      if (!session) return send(response, 404, { error: "Unknown review session" });
      const tail = reviewMatch[2] || "";
      if (request.method === "GET" && !tail) return send(response, 200, publicReviewSession(session));
      if (request.method === "GET" && tail === "image") return send(response, 200, await reviewStore.source(session), session.image.format === "png" ? "image/png" : "image/jpeg");
      if (request.method === "POST" && tail === "runs") {
        let body;
        try { body = await readBody(request, 8192); }
        catch (_) { return send(response, 400, { error: "Invalid run request" }); }
        try { return send(response, 202, reviewRunner.publicRun(session, await reviewRunner.enqueue(session, body.candidate_ids, body.idempotency_key))); }
        catch (error) { return send(response, reviewRunner.enabled ? 400 : 503, { error: error.message }); }
      }
      const runMatch = tail.match(/^runs\/([a-f0-9-]{36})$/);
      if (request.method === "GET" && runMatch) {
        const run = session.runs[runMatch[1]];
        return run ? send(response, 200, reviewRunner.publicRun(session, run)) : send(response, 404, { error: "Unknown agent run" });
      }
      if (request.method === "POST" && tail === "reviews") {
        let body;
        try { body = await readBody(request, 4096); }
        catch (_) { return send(response, 400, { error: "Invalid review request" }); }
        try { return send(response, 201, await reviewStore.review(session, body)); }
        catch (error) { return send(response, 400, { error: error.message }); }
      }
      const evidenceMatch = tail.match(/^evidence\/([a-f0-9-]{36})\/(source|mask)$/);
      if (request.method === "GET" && evidenceMatch) {
        const item = session.evidence?.[evidenceMatch[1]];
        if (!item) return send(response, 404, { error: "Unknown evidence" });
        const candidate = session.candidates.find(candidate => candidate.id === item.candidate_id);
        const reviewed = Object.values(session.reviews).some(review => review.candidate_id === item.candidate_id && review.stage === "timed");
        if (candidate?.arm === "baseline" && !reviewed) return send(response, 403, { error: "Evidence withheld until timed review" });
        const bytes = await readFile(reviewStore.path(session.id, evidenceMatch[2] === "source" ? item.source_name : item.overlay_name));
        return send(response, 200, bytes, "image/jpeg");
      }
      if (request.method === "GET" && (tail === "export" || tail === "bundle")) {
        const complete = session.candidates.every(candidate => Object.values(session.reviews).some(review => review.candidate_id === candidate.id && review.stage === "timed"));
        if (!complete) return send(response, 409, { error: "Review every candidate before full export" });
        const record = { ...session, exported_at: new Date().toISOString(), model_note: "Agent suggestions are advisory. Only human decisions determine accepted fans." };
        if (tail === "export") return send(response, 200, record);
        const files = { "review.json": strToU8(JSON.stringify(record, null, 2)), "events.jsonl": new Uint8Array(await readFile(reviewStore.path(session.id, "events.jsonl"))) };
        const sourceName = "working-image." + (session.image.format === "png" ? "png" : "jpg");
        files[sourceName] = new Uint8Array(await reviewStore.source(session));
        files["detector-responses.json"] = new Uint8Array(await readFile(reviewStore.path(session.id, "detector-responses.json")));
        for (const evidence of Object.values(session.evidence)) {
          files[`evidence/${evidence.source_name}`] = new Uint8Array(await readFile(reviewStore.path(session.id, evidence.source_name)));
          files[`evidence/${evidence.overlay_name}`] = new Uint8Array(await readFile(reviewStore.path(session.id, evidence.overlay_name)));
        }
        const zip = zipSync(files, { level: 0 });
        response.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="mars-fan-review-${session.id}.zip"`, "cache-control": "no-store" });
        return response.end(Buffer.from(zip));
      }
      return send(response, 404, { error: "Unknown review route" });
    }
    if (request.method === "POST" && url.pathname === "/api/scout/infer") {
      if (!access.authorized(request.headers["x-demo-access-code"])) return send(response, 401, { error:"Enter the demo access code to scan" });
      if (!configured || training || replay) return send(response, 503, { error:"Live Roboflow inference is unavailable" });
      let image;
      try { image = await readImage(request); }
      catch (error) { return send(response, 400, { error:error.message }); }
      if (!access.reserve()) return send(response, 429, { error:"The demo has reached its daily scan limit" });
      const result = await inferImage(image);
      return send(response, result.status, result.body);
    }
    if (request.method === "POST" && url.pathname === "/api/infer") {
      if (!access.authorized(request.headers["x-demo-access-code"])) return send(response, 401, { error:"Enter the demo access code to scan" });
      let input;
      try { input = await readBody(request); }
      catch (_) { return send(response, 400, { error:"Invalid inference request" }); }
      if (!input || !sceneAssets.has(input.sceneId)) return send(response, 404, { error:"Unknown observation" });
      if (!ready) return send(response, 503, { error:"Roboflow model is not connected" });
      if (!replay && !access.reserve()) return send(response, 429, { error:"The demo has reached its daily scan limit" });
      const result = await infer(input.sceneId);
      return send(response, result.status, result.body);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, { error:"Method not allowed" });
    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const path = resolve(publicDir, "." + requested);
    if (!path.startsWith(publicDir + "/")) return send(response, 403, { error:"Forbidden" });
    let data;
    try { data = await readFile(path); }
    catch (_) { return send(response, 404, { error:"Not found" }); }
    response.writeHead(200, { "content-type":mime[extname(path)] || "application/octet-stream", "cache-control":"no-cache", "x-content-type-options":"nosniff" });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch (_) {
    send(response, 500, { error:"Unexpected server error" });
  }
});

server.listen(port, host, () => {
  process.stdout.write("Mars Fan Scout ready at http://" + host + ":" + port + "\n");
  process.stdout.write(replay ? (ready ? "Recorded Roboflow inference ready\n" : "Recorded results missing\n") : (training ? "Roboflow model training\n" : (ready ? "Roboflow model configured\n" : "Reference mode: Roboflow model not configured\n")));
});
