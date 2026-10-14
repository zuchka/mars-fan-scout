import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, createReadStream } from "node:fs";
import { SourceStore } from "./scout/source-store.mjs";
import { ScanJobs } from "./scout/jobs.mjs";
import { clipRegion, tilesForRegion } from './public/geometry.js';
import { decodeRLE } from "./public/masks.js";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createDemoAccess } from "./demo-access.mjs";
import { zipSync, strToU8 } from "fflate";
import { ReviewStore } from "./review-agent/store.mjs";
import { ReviewRunner } from "./review-agent/runner.mjs";
import type { Point, Region, RLE } from "./public/types.js";
import type { ModelResponse, ScanRequest } from "./scout/types.js";
import type { ReviewSession } from "./review-agent/types.js";

type Scene = { id: string; image: string };
type Fixture = { id: string; image: string; observation: string; detector_response: string;
  candidates: ReviewSession["candidates"] };
type FixtureManifest = { format: string; model_id: string; selection: unknown; crops: Fixture[] };
type RefineInput = { image: Buffer; width: number; height: number; boxes: Array<{ box: Region | null }>; format?: "polygon" | "rle" };
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
const mime: Record<string, string> = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".webp":"image/webp", ".svg":"image/svg+xml" };
const sceneData = JSON.parse(readFileSync(resolve(publicDir, "scenes.json"), "utf8")) as Scene[];
const sceneAssets = new Map(sceneData.map(scene => [scene.id, scene.image]));
const recordedDir = resolve(root, "recorded");
const evaluationFile = resolve(root, "evaluation/locked/score.json");
const recordingsComplete = sceneData.every(scene => existsSync(resolve(recordedDir, scene.id + ".json")));
const ready = replay ? recordingsComplete : configured && !training;
const reviewStore = new ReviewStore(resolve(root, process.env.REVIEW_AGENT_DATA_DIR || ".review-agent"));
await reviewStore.init();
// Keep historical review sessions readable and exportable, but never start a model review.
const reviewRunner = new ReviewRunner({ store: reviewStore, budget: null, provider: null });
const reviewFixtures = JSON.parse(readFileSync(resolve(root, "evaluation/agent-review/manifest.json"), "utf8")) as FixtureManifest;

function send(response: ServerResponse, status: number, data: unknown, type = "application/json; charset=utf-8"): void {
  response.writeHead(status, { "content-type":type, "cache-control":"no-store", "x-content-type-options":"nosniff" });
  response.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

async function readBody<T = Record<string, unknown>>(request: IncomingMessage, max = 4096): Promise<T> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > max) throw new Error("Request too large");
  }
  return JSON.parse(body) as T;
}

async function readLargeJson<T = Record<string, unknown>>(request: IncomingMessage, max = 70 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function publicReviewSession(session: ReviewSession) {
  const complete = session.candidates.every(candidate => Object.values(session.reviews).some(review => review.candidate_id === candidate.id && review.stage === "timed"));
  return { format: session.format, id: session.id, created_at: session.created_at, demo: session.demo === true, image: session.image, fixture_id: session.fixture_id,
    snapshot_sha256: session.snapshot_sha256, detector_model: session.detector_model, detector_responses_sha256: session.detector_responses_sha256, candidates: session.candidates,
    runs: Object.fromEntries(Object.entries(session.runs).map(([id, run]) => [id, reviewRunner.publicRun(session, run)])),
    reviews: Object.values(session.reviews).map(review => complete || review.stage === "timed" ? review :
      { candidate_id: review.candidate_id, stage: review.stage, reviewer: review.reviewer, at: review.at, decision: null }), complete };
}

function needsReviewAuth(request: IncomingMessage, response: ServerResponse): boolean {
  if (!access.accessRequired || !access.authorized(request.headers["x-demo-access-code"])) {
    send(response, 401, { error: "Meeting code is required for review sessions" }); return true;
  }
  return false;
}

async function readImage(request: IncomingMessage, max = 3 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
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

async function inferImage(data: Buffer): Promise<ModelResponse> {
  const started = performance.now();
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
    return { status:200, body:{ ...await response.json() as Record<string, unknown>, scout_timing: { roboflow_request_ms: Math.round(performance.now() - started) } } };
  } catch (_) {
    return { status:502, body:{ error:"Roboflow returned an unreadable response" } };
  }
}

function polygonArea(points: Point[]): number {
  return Math.abs(points.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length];
    return sum + x * nextY - nextX * y;
  }, 0)) / 2;
}

async function refineMasks(body: { image_base64: string; boxes: Region[] }): Promise<RefineInput> {
  if (typeof body?.image_base64 !== "string" || body.image_base64.length > 4 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image_base64)) throw new Error("Invalid JPEG image");
  const image = Buffer.from(body.image_base64, "base64");
  if (image.length > 3 * 1024 * 1024 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
    throw new Error("Invalid JPEG image");
  }
  const { width, height, format } = await sharp(image).metadata();
  if (format !== "jpeg" || !width || !height || width > 1024 || height > 1024) throw new Error("Expected a JPEG crop up to 1024 pixels wide");
  if (!Array.isArray(body.boxes) || body.boxes.length < 1 || body.boxes.length > 3) throw new Error("Choose one to three regions");
  const boxes = body.boxes.map((box: Region) => {
    const { x, y, width: boxWidth, height: boxHeight } = box || {};
    if (![x, y, boxWidth, boxHeight].every(Number.isFinite) || boxWidth < 4 || boxHeight < 4 ||
        x < 0 || x > width || y < 0 || y > height || boxWidth > width * 2 || boxHeight > height * 2) {
      throw new Error("Invalid region box");
    }
    return { box: { x, y, width: boxWidth, height: boxHeight } };
  });
  return { image, width, height, boxes };
}

async function inferSam3({ image, width, height, boxes, format = 'polygon' }: RefineInput): Promise<ModelResponse> {
  const started = performance.now();
  const endpoint = new URL("https://serverless.roboflow.com/sam3/visual_segment");
  endpoint.searchParams.set("api_key", apiKey);
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: { type: "base64", value: image.toString("base64") }, prompts: { prompts: boxes },
        multimask_output: false, format }), signal: AbortSignal.timeout(35000) });
  } catch (_) { return { status: 502, body: { error: "SAM 3 is temporarily unreachable" } }; }
  if (!response.ok) return { status: 502, body: { error: `SAM 3 returned HTTP ${response.status}` } };
  let data: { predictions?: Array<{ masks: RLE | Point[][]; confidence?: number }>; resolved_model?: string; inference_id?: string };
  try { data = await response.json() as typeof data; }
  catch (_) { return { status: 502, body: { error: "SAM 3 returned an unreadable response" } }; }
  if (!Array.isArray(data.predictions) || data.predictions.length !== boxes.length) {
    return { status: 502, body: { error: "SAM 3 returned an unexpected number of masks" } };
  }
  let masks;
  try { masks = data.predictions.map(prediction => {
    if (format === 'rle') {
      const raster = decodeRLE(prediction.masks as RLE, 2048 * 2048);
      if (raster.width !== width || raster.height !== height) throw new Error('Unexpected SAM mask dimensions');
      return { rle: prediction.masks, format: 'rle', holes_preserved: true, area: raster.pixels.reduce((a,b)=>a+b,0), confidence: Number.isFinite(prediction.confidence) ? prediction.confidence : null };
    }
    const polygons = Array.isArray(prediction.masks) ? prediction.masks : [];
    const valid = polygons.map(points => Array.isArray(points) ? points.filter(point => Array.isArray(point) && point.length === 2 &&
      point.every(Number.isFinite) && point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height) : [])
      .filter(points => points.length >= 3 && points.length <= 10000 && polygonArea(points) >= 20);
    valid.sort((a, b) => polygonArea(b) - polygonArea(a));
    return { polygon: valid[0] || null, polygons: valid, format: "polygon", holes_preserved: false, confidence: Number.isFinite(prediction.confidence) ? prediction.confidence : null };
  }); } catch (_) { return { status: 502, body: { error: 'SAM returned an invalid raster mask; the previous trace is retained' } }; }
  return { status: 200, body: { masks, resolved_model: data.resolved_model || null, inference_id: data.inference_id || null, sam3_request_ms: Math.round(performance.now() - started) } };
}

async function infer(sceneId: string): Promise<ModelResponse> {
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

const scoutFeatures = { native_refinement: process.env.SCOUT_NATIVE_REFINEMENT !== '0', tiled_detection: process.env.SCOUT_TILED_DETECTION !== '0', experimental_fringe: process.env.SCOUT_EXPERIMENTAL_FRINGE !== '0' };
const scoutDir = resolve(root, process.env.SCOUT_DATA_DIR || ".scout");
const defaultOrbit = resolve(root, "../data/planet-four/images/ESP_082142_0935_RED.JP2");
const orbitPath = process.env.SCOUT_ORBIT_PATH || (existsSync(defaultOrbit) ? defaultOrbit : null);
const sources = new SourceStore(root, resolve(scoutDir, "sources"), { orbitPath: orbitPath ?? undefined, python: process.env.SCOUT_PYTHON || "python3", maxSourceBytes: Number(process.env.SCOUT_SOURCE_QUOTA_MIB || 2048) * 1024**2 });
await sources.init();
const jobs = new ScanJobs({ directory: resolve(scoutDir,"jobs"), sources, access, infer: inferImage, refine: inferSam3, modelId });
await jobs.init();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/status") {
      const granted = access.authorized(request.headers["x-demo-access-code"]);
      return send(response, 200, { ready, scout_ready:configured && !training && !replay, configured, training:training && !replay,
        native_pipeline: "native-v1", features: scoutFeatures, full_observation_available: !!orbitPath, mode:replay ? "recorded" : "live", model_id:modelIdValid ? modelId : null,
        access_required:access.accessRequired, access_granted:granted, daily_remaining:granted ? access.remaining() : null });
    }
    if (url.pathname === "/api/scout/sources" && request.method === "POST") {
      if (!access.authorized(request.headers["x-demo-access-code"])) return send(response,401,{error:"Enter the meeting code to upload"});
      try {
        const chunks=[]; let size=0;
        for await (const chunk of request) { size+=chunk.length; if(size>32*1024*1024) throw new Error("Choose an image under 32 MiB"); chunks.push(chunk); }
        const sourceName = request.headers["x-source-name"];
        return send(response,201,await sources.add(Buffer.concat(chunks),decodeURIComponent(Array.isArray(sourceName) ? sourceName[0] : sourceName || "Uploaded Mars crop")));
      } catch(error) { return send(response,400,{error:errorMessage(error)}); }
    }
    const sourceMatch=url.pathname.match(/^\/api\/scout\/sources\/(sample|orbit|[a-f0-9]{64})(?:\/(preview|region|original))?$/);
    if(sourceMatch && request.method === "GET") {
      const [,id,action]=sourceMatch;
      if(!["sample","orbit"].includes(id)&&!access.authorized(request.headers["x-demo-access-code"])) return send(response,401,{error:"Meeting code required"});
      try {
        const meta=await sources.meta(id);
        if(!action) return send(response,200,meta);
        if(action==='preview') return send(response,200,await sources.preview(id),'image/jpeg');
        if(action==='original') {
          const path=await sources.original(id);
          response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${id}-original.${meta.original_format}"`,'cache-control':'no-store'});
          const stream=createReadStream(path);stream.on('error',()=>response.destroy());return stream.pipe(response);
        }
        const region={x:Number(url.searchParams.get('x')),y:Number(url.searchParams.get('y')),width:Number(url.searchParams.get('width')),height:Number(url.searchParams.get('height'))};
        const image=await sources.region(id,region,Number(url.searchParams.get('max')||1024));
        return send(response,200,image.bytes,'image/png');
      } catch(error) { return send(response,400,{error:errorMessage(error)}); }
    }
    if(url.pathname === '/api/scout/jobs' && request.method==='POST') {
      if(!access.authorized(request.headers['x-demo-access-code'])) return send(response,401,{error:'Meeting code required'});
      if(!configured||training||replay) return send(response,503,{error:'Live inference is unavailable'});
      try { const body=await readBody<ScanRequest>(request,16384);if(body.kind==='refine'&&!scoutFeatures.native_refinement)throw new Error('Native tracing is disabled on this deployment');if(body.kind!=='refine'&&!scoutFeatures.tiled_detection){const meta=await sources.meta(body.source_id);const region=clipRegion(body.region,meta);if(tilesForRegion(region,Number(body.scale||1)).length>1)throw new Error('Multi-tile scanning is disabled on this deployment');}return send(response,202,jobs.public(await jobs.create(body))); }
      catch(error) { return send(response,400,{error:errorMessage(error)}); }
    }
    const jobMatch=url.pathname.match(/^\/api\/scout\/jobs\/([a-f0-9-]{36})(?:\/(cancel))?$/);
    if(jobMatch) {
      if(!access.authorized(request.headers['x-demo-access-code'])) return send(response,401,{error:'Meeting code required'});
      try {
        if(request.method==='POST'&&jobMatch[2]==='cancel') return send(response,200,jobs.public(await jobs.cancel(jobMatch[1])));
        if(request.method==='GET'&&!jobMatch[2]) return send(response,200,jobs.public(jobs.jobs.get(jobMatch[1]) ?? null));
        return send(response,405,{error:'Method not allowed'});
      } catch(error) { return send(response,404,{error:errorMessage(error)}); }
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
      let body: Parameters<ReviewStore["create"]>[0];
      try { body = await readLargeJson<Parameters<ReviewStore["create"]>[0]>(request); }
      catch (error) { return send(response, 400, { error: errorMessage(error) }); }
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
      catch (error) { return send(response, 400, { error: errorMessage(error) }); }
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
        return send(response, 410, { error: "The visual review model has been retired" });
      }
      const runMatch = tail.match(/^runs\/([a-f0-9-]{36})$/);
      if (request.method === "GET" && runMatch) {
        const run = session.runs[runMatch[1]];
        if (run && url.searchParams.get("wait") === "1") {
          const deadline = Date.now() + 55000;
          while (["queued", "running"].includes(run.status) && Date.now() < deadline && !response.destroyed) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          if (response.destroyed) return;
        }
        return run ? send(response, 200, reviewRunner.publicRun(session, run)) : send(response, 404, { error: "Unknown agent run" });
      }
      if (request.method === "POST" && tail === "reviews") {
        let body;
        try { body = await readBody<Parameters<ReviewStore["review"]>[1]>(request, 4096); }
        catch (_) { return send(response, 400, { error: "Invalid review request" }); }
        try { return send(response, 201, await reviewStore.review(session, body)); }
        catch (error) { return send(response, 400, { error: errorMessage(error) }); }
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
        const files: Record<string, Uint8Array> = { "review.json": strToU8(JSON.stringify(record, null, 2)), "events.jsonl": new Uint8Array(await readFile(reviewStore.path(session.id, "events.jsonl"))) };
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
      catch (error) { return send(response, 400, { error:errorMessage(error) }); }
      if (!access.reserve()) return send(response, 429, { error:"The demo has reached its daily scan limit" });
      const result = await inferImage(image);
      return send(response, result.status, result.body);
    }
    if (request.method === "POST" && url.pathname === "/api/scout/refine") {
      if (!access.authorized(request.headers["x-demo-access-code"])) return send(response, 401, { error: "Enter the demo access code to refine masks" });
      if (!apiKey || replay) return send(response, 503, { error: "Live SAM 3 refinement is unavailable" });
      let input;
      try { input = await refineMasks(await readLargeJson<{ image_base64: string; boxes: Region[] }>(request, 5 * 1024 * 1024)); }
      catch (error) { return send(response, 400, { error: errorMessage(error) }); }
      if (!access.reserve()) return send(response, 429, { error: "The demo has reached its daily scan limit" });
      const result = await inferSam3(input);
      return send(response, result.status, result.body);
    }
    if (request.method === "POST" && url.pathname === "/api/infer") {
      if (!access.authorized(request.headers["x-demo-access-code"])) return send(response, 401, { error:"Enter the demo access code to scan" });
      let input;
      try { input = await readBody<{ sceneId: string }>(request); }
      catch (_) { return send(response, 400, { error:"Invalid inference request" }); }
      if (!input || !sceneAssets.has(input.sceneId)) return send(response, 404, { error:"Unknown observation" });
      if (!ready) return send(response, 503, { error:"Roboflow model is not connected" });
      if (!replay && !access.reserve()) return send(response, 429, { error:"The demo has reached its daily scan limit" });
      const result = await infer(input.sceneId);
      return send(response, result.status, result.body);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, { error:"Method not allowed" });
    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (requested === "/research.html") {
      response.writeHead(302, { location: "/", "cache-control": "no-store" });
      return response.end();
    }
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
