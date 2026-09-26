import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoAccess } from "./demo-access.mjs";

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
      return send(response, 200, { ready, scout_ready:configured && !training && !replay, configured, training:training && !replay, mode:replay ? "recorded" : "live", model_id:modelIdValid ? modelId : null, access_required:access.accessRequired, access_granted:granted, daily_remaining:granted ? access.remaining() : null });
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
