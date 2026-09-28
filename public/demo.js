import { predictionsFromRoboflow, showcaseCandidates } from "./candidates.js";

const $ = id => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const SAMPLE = { path: "/images/scout-2024-dev.jpg", name: "Spiders in Manhattan", observation: "ESP_082142_0935" };
const SESSION_KEY = "mars-fan-scout-showcase-session";
const state = {
  code: "", access: false, modelId: null, agentReady: false, canvas: null, file: null,
  imageUrl: null, sample: true, session: null, candidates: [], selectedId: null,
  phase: "locked", busy: false, pollTimer: null, evidenceUrls: new Map(), generation: 0, dailyRemaining: null,
};

function authHeaders() { return state.code ? { "x-demo-access-code": state.code } : {}; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`);
  return body;
}
function status(message, kind = "") {
  $("top-status").textContent = message;
  $("status-dot").className = kind;
}
function phase(name) {
  state.phase = name;
  const order = ["roboflow", "jev", "done"];
  const step = name === "partial" ? "done" : name;
  for (const [index, id] of ["roboflow-step", "jev-step", "answer-step"].entries()) {
    const node = $(id);
    node.classList.toggle("active", order[index] === step);
    node.classList.toggle("done", order.indexOf(step) > index);
  }
  $("image-scan").hidden = name !== "roboflow";
  $("run-light").textContent = name === "done" ? "COMPLETE" : name === "partial" ? "PARTIAL" : name === "roboflow" ? "SCANNING" : name === "jev" ? "JEV IS LOOKING" : name === "error" ? "NEEDS RETRY" : "WAITING";
  $("run-light").className = "run-light" + (name === "done" ? " done" : ["roboflow", "jev", "partial"].includes(name) ? " active" : "");
  if (["roboflow", "jev"].includes(name)) status("Live models working", "busy");
  else if (name === "done") status("Live run complete", "ready");
  else if (name === "partial") status("Some checks could not finish");
  else if (name === "error") status("Run interrupted");
  else if (name === "locked") status("Meeting code needed");
}
function error(message) {
  $("run-error").textContent = message;
  $("run-error").hidden = false;
  $("footer-status").textContent = "The image is still here. Try the run again.";
  $("run-again").hidden = !state.access;
  phase("error");
  state.busy = false;
  $("image-input").disabled = false;
}
function clearError() { $("run-error").hidden = true; $("run-error").textContent = ""; }
function sessionId() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } }
function saveSessionId(id) { try { localStorage.setItem(SESSION_KEY, id); } catch { /* The current run still works. */ } }
function clearSessionId() { try { localStorage.removeItem(SESSION_KEY); } catch { /* Nothing to clear. */ } }
function canvasBlob(canvas, type = "image/jpeg") {
  return new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not prepare the image")), type, .91));
}
async function setImage(file, { sample = false, name = file.name, observation = null } = {}) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error("Choose a JPG, PNG, or WebP crop under 8 MB.");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width < 256 || bitmap.height < 256 || bitmap.width > 3072 || bitmap.height > 3072) {
    bitmap.close();
    throw new Error("Choose a Mars crop between 256 and 3072 pixels on each side.");
  }
  const factor = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * factor);
  canvas.height = Math.round(bitmap.height * factor);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(await canvasBlob(canvas));
  state.canvas = canvas;
  state.file = file;
  state.sample = sample;
  $("mars-image").src = state.imageUrl;
  $("mars-image").alt = sample ? `NASA HiRISE crop from ${observation}` : `Uploaded Mars crop ${name}`;
  $("candidate-overlay").setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
  $("image-title").textContent = name;
  $("image-label").textContent = sample ? `NASA HiRISE · ${observation}` : `${canvas.width} × ${canvas.height} px working crop`;
  $("image-stamp").textContent = "ORIGINAL IMAGE";
  state.candidates = [];
  state.selectedId = null;
  state.session = null;
  $("candidate-overlay").replaceChildren();
  $("results-area").hidden = true;
  $("other-regions").open = false;
  $("candidate-detail").hidden = true;
  $("roboflow-line").textContent = "Waiting for the image scan.";
  $("jev-line").textContent = "It can ask for one wider view before suggesting a label.";
  $("answer-line").textContent = "Fan, not a fan, or unsure—shown beside the evidence.";
}
async function loadSample() {
  const response = await fetch(SAMPLE.path);
  if (!response.ok) throw new Error("The sample Mars image is unavailable.");
  const blob = await response.blob();
  await setImage(new File([blob], "ESP_082142_0935_crop.jpg", { type: "image/jpeg" }),
    { sample: true, name: SAMPLE.name, observation: SAMPLE.observation });
}
function polygonBounds(points) {
  return { left: Math.min(...points.map(p => p[0])), top: Math.min(...points.map(p => p[1])),
    right: Math.max(...points.map(p => p[0])), bottom: Math.max(...points.map(p => p[1])) };
}
function checkedCandidates() { return state.candidates.slice(0, 3); }
function contextBounds(candidate) {
  const box = polygonBounds(candidate.polygon);
  const side = Math.ceil(Math.max(105, box.right - box.left, box.bottom - box.top) * 1.65);
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  return { left: Math.max(0, Math.floor(cx - side / 2)), top: Math.max(0, Math.floor(cy - side / 2)),
    right: Math.min(state.canvas.width, Math.ceil(cx + side / 2)), bottom: Math.min(state.canvas.height, Math.ceil(cy + side / 2)) };
}
function drawMasks() {
  const overlay = $("candidate-overlay");
  overlay.replaceChildren();
  state.candidates.forEach((candidate, index) => {
    if (index >= 3 && candidate.id !== state.selectedId) return;
    const polygon = document.createElementNS(NS, "polygon");
    polygon.setAttribute("points", candidate.polygon.map(point => point.join(",")).join(" "));
    polygon.setAttribute("class", "candidate-mask" + (candidate.id === state.selectedId ? " active" : ""));
    overlay.appendChild(polygon);
    const bounds = polygonBounds(candidate.polygon);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(Math.max(15, bounds.left)));
    label.setAttribute("y", String(Math.max(30, bounds.top - 6)));
    label.setAttribute("class", "candidate-number");
    label.textContent = String(index + 1).padStart(2, "0");
    overlay.appendChild(label);
  });
  const selected = state.candidates.find(candidate => candidate.id === state.selectedId);
  if (selected) {
    const box = contextBounds(selected);
    const window = document.createElementNS(NS, "rect");
    window.setAttribute("x", String(box.left)); window.setAttribute("y", String(box.top));
    window.setAttribute("width", String(box.right - box.left)); window.setAttribute("height", String(box.bottom - box.top));
    window.setAttribute("class", "context-window");
    overlay.appendChild(window);
  }
  $("image-stamp").textContent = state.candidates.length ? `${checkedCandidates().length} JEV CHECKS · ${state.candidates.length} ROBOFLOW REGIONS` : "ORIGINAL IMAGE";
}
function latestRun() { return Object.values(state.session?.runs || {}).at(-1) || null; }
function agentResult(id) { return latestRun()?.results?.[id] || null; }
function verdictInfo(result) {
  if (!result) return { label: "Jev-Omni is looking…", className: "" };
  if (result.status !== "complete") return { label: "Could not finish", className: "error" };
  if (result.verdict === "fan") return { label: "Fan", className: "fan" };
  if (result.verdict === "not_fan") return { label: "Not a fan", className: "not_fan" };
  return { label: "Unsure", className: "unsure" };
}
function renderResults() {
  if (!state.candidates.length) return;
  $("results-area").hidden = false;
  const completed = Object.values(latestRun()?.results || {}).filter(result => result.status === "complete").length;
  $("results-count").textContent = latestRun()?.status === "complete"
    ? `${completed} checked of ${state.candidates.length}`
    : `${completed} checked · ${checkedCandidates().length} selected of ${state.candidates.length}`;
  const list = $("results-list");
  list.replaceChildren();
  const otherList = $("other-results-list");
  otherList.replaceChildren();
  $("other-regions").hidden = state.candidates.length <= 3;
  $("other-regions-count").textContent = String(Math.max(0, state.candidates.length - 3));
  state.candidates.forEach((candidate, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-card" + (candidate.id === state.selectedId ? " active" : "");
    button.setAttribute("aria-pressed", String(candidate.id === state.selectedId));
    const number = document.createElement("span"); number.className = "index"; number.textContent = String(index + 1);
    const name = document.createElement("span"); name.className = "name"; name.textContent = `Shape ${String(index + 1).padStart(2, "0")}`;
    const confidence = document.createElement("small"); confidence.textContent = `Roboflow ${Math.round(candidate.confidence * 100)}%`; name.appendChild(confidence);
    const info = index < 3 ? verdictInfo(agentResult(candidate.id)) : { label: "Not checked", className: "" };
    const verdict = document.createElement("span"); verdict.className = "verdict " + info.className; verdict.textContent = info.label;
    button.append(number, name, verdict);
    button.addEventListener("click", () => { state.selectedId = candidate.id; drawMasks(); renderResults(); showDetail(); });
    (index < 3 ? list : otherList).appendChild(button);
  });
}
async function evidenceImage(sessionId, evidenceId) {
  const key = `${sessionId}:${evidenceId}`;
  if (state.evidenceUrls.has(key)) return state.evidenceUrls.get(key);
  const response = await fetch(`/api/scout/review-sessions/${sessionId}/evidence/${evidenceId}/mask`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Evidence crop unavailable");
  const url = URL.createObjectURL(await response.blob());
  state.evidenceUrls.set(key, url);
  return url;
}
function explanation(result) {
  if (result.status !== "complete") return result.trace?.some(event => event.type === "wider_view_created") ? "Jev-Omni asked for a wider view, but the follow-up did not finish." : "Jev-Omni could not finish this check. The source pixels are still visible above.";
  const wider = result.trace?.some(event => event.type === "wider_view_created");
  if (result.verdict === "fan") return `${wider ? "Jev-Omni asked to see more of the image, then checked again. " : ""}Its Fan score cleared the demo threshold. Check the source pixels before accepting it.`;
  if (result.verdict === "not_fan") return `${wider ? "Jev-Omni asked to see more of the image, then checked again. " : ""}Its Not a fan score cleared the demo threshold. Check the source pixels before rejecting it.`;
  return wider ? "The first view was ambiguous. Jev-Omni requested a wider crop, checked again, and stayed unsure." : "The visible region did not support a confident Fan or Not a fan call.";
}
function localSourceCrop(candidate) {
  const box = contextBounds(candidate);
  const x = box.left, y = box.top, width = box.right - x, height = box.bottom - y;
  const crop = document.createElement("canvas"); crop.width = width; crop.height = height;
  crop.getContext("2d").drawImage(state.canvas, x, y, width, height, 0, 0, width, height);
  return crop.toDataURL("image/jpeg", .9);
}
async function showDetail() {
  const candidate = state.candidates.find(item => item.id === state.selectedId);
  if (!candidate) { $("candidate-detail").hidden = true; return; }
  const result = agentResult(candidate.id);
  const index = state.candidates.indexOf(candidate) + 1;
  $("candidate-detail").hidden = false;
  $("detail-name").textContent = `SHAPE ${String(index).padStart(2, "0")}`;
  const checked = index <= 3;
  $("detail-verdict").textContent = checked ? verdictInfo(result).label : "Not checked";
  $("detail-explanation").textContent = checked ? result ? explanation(result) : "Jev-Omni is inspecting this region. The answer will appear here automatically." : "Roboflow proposed this region. Jev checked only the three featured regions; inspect these source pixels yourself.";
  $("detail-timing").textContent = result?.status === "complete" ? `${result.trace?.filter(event => event.type === "provider_call_completed").length || 1} visual look${result.trace?.filter(event => event.type === "provider_call_completed").length === 1 ? "" : "s"} · ${(result.elapsed_ms / 1000).toFixed(1)}s` : "";
  $("evidence-grid").hidden = true;
  $("wider-figure").hidden = true;
  if (!checked && state.canvas) {
    $("initial-evidence").src = localSourceCrop(candidate);
    $("initial-caption").textContent = "Source pixels · Jev did not check this region";
    $("evidence-grid").hidden = false;
    return;
  }
  $("initial-caption").textContent = "The region Jev-Omni saw";
  if (!result?.trace || !state.session) return;
  const initial = result.trace.find(event => event.type === "evidence_created");
  const wider = result.trace.find(event => event.type === "wider_view_created");
  if (!initial) return;
  const selected = candidate.id;
  try {
    const urls = await Promise.all([evidenceImage(state.session.id, initial.evidence_id), wider ? evidenceImage(state.session.id, wider.evidence_id) : null]);
    if (state.selectedId !== selected) return;
    $("initial-evidence").src = urls[0];
    if (urls[1]) { $("wider-evidence").src = urls[1]; $("wider-figure").hidden = false; }
    $("evidence-grid").hidden = false;
  } catch { /* The verdict remains visible if an evidence thumbnail fails. */ }
}
function renderSession() {
  if (!state.session) return;
  state.candidates = state.session.candidates;
  if (!state.selectedId || !state.candidates.some(item => item.id === state.selectedId)) state.selectedId = state.candidates[0]?.id || null;
  drawMasks(); renderResults(); showDetail();
  const run = latestRun();
  const completed = run ? Object.keys(run.results || {}).length : 0;
  const widerCount = Object.values(run?.results || {}).filter(result => result.trace?.some(event => event.type === "wider_view_created")).length;
  const checked = run?.candidates?.length || checkedCandidates().length;
  $("roboflow-line").textContent = `Found ${state.candidates.length} possible regions; Jev-Omni is checking ${checked}.`;
  const runTime = Number.isFinite(run?.elapsed_ms) ? ` in ${(run.elapsed_ms / 1000).toFixed(1)}s` : "";
  $("jev-line").textContent = run?.status === "complete" ? `Finished ${checked} visual check${checked === 1 ? "" : "s"}${runTime}${widerCount ? `; requested a wider view ${widerCount} time${widerCount === 1 ? "" : "s"}` : ""}.` : `Checking marked regions… ${completed} of ${checked} done.`;
  if (run?.status === "interrupted") {
    error("Jev-Omni was interrupted while checking this image. Run the demo again to retry.");
  } else if (run?.status === "complete") {
    const counts = { fan: 0, not_fan: 0, unsure: 0, unfinished: 0 };
    for (const result of Object.values(run.results || {})) counts[result.status === "complete" ? result.verdict : "unfinished"]++;
    $("answer-line").textContent = `${counts.fan} fan · ${counts.not_fan} not a fan · ${counts.unsure} unsure${counts.unfinished ? ` · ${counts.unfinished} could not finish` : ""}. Select a shape to see what Jev-Omni saw.`;
    $("run-again").hidden = false;
    $("image-input").disabled = false;
    state.busy = false;
    if (counts.unfinished === checked) {
      error(run.provider_unavailable || "Jev-Omni could not complete the visual checks. The GPU endpoint may be unavailable.");
      $("footer-status").textContent = "Roboflow found the shapes; Jev-Omni is unavailable right now.";
    } else if (counts.unfinished) {
      $("jev-line").textContent = `Jev-Omni checked ${checked - counts.unfinished} of ${checked} regions${runTime}; ${counts.unfinished} could not finish.`;
      $("footer-status").textContent = `Partial result. ${run.provider_unavailable || "Jev-Omni could not finish every check."} The source pixels remain available.`;
      phase("partial");
    } else {
      $("footer-status").textContent = "Live Roboflow and Jev-Omni check complete.";
      phase("done");
    }
  } else {
    $("footer-status").textContent = "The results will fill in automatically.";
    phase("jev");
  }
}
function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
async function pollSession(id, generation) {
  stopPolling();
  if (generation !== state.generation) return;
  try {
    state.session = await api(`/api/scout/review-sessions/${id}`);
    if (generation !== state.generation) return;
    renderSession();
    if (!["complete", "interrupted"].includes(latestRun()?.status)) state.pollTimer = setTimeout(() => pollSession(id, generation), 1800);
  } catch (cause) { if (generation === state.generation) error(`Jev-Omni status could not be loaded: ${cause.message}`); }
}
async function runAgent(generation) {
  if (generation !== state.generation || !state.session) return;
  const run = await api(`/api/scout/review-sessions/${state.session.id}/runs`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidate_ids: state.session.candidates.slice(0, 3).map(item => item.id), idempotency_key: crypto.randomUUID() }) });
  // Keep one request open while Sprite finishes the GPU checks. The ordinary status
  // poll still gives the viewer progressive results and survives a dropped wait.
  void api(`/api/scout/review-sessions/${state.session.id}/runs/${run.id}?wait=1`).catch(() => {});
  await pollSession(state.session.id, generation);
}
async function startRun() {
  if (!state.access || !state.canvas || state.busy) return;
  if (state.dailyRemaining === 0) { error("Today's Roboflow scan allowance is exhausted. The last result remains available if you reload this page."); return; }
  const generation = ++state.generation;
  state.busy = true;
  stopPolling(); clearError(); clearSessionId();
  $("run-again").hidden = true;
  $("image-input").disabled = true;
  $("candidate-detail").hidden = true;
  $("results-area").hidden = true;
  $("other-regions").open = false;
  state.candidates = []; state.session = null; state.selectedId = null;
  $("candidate-overlay").replaceChildren();
  $("image-stamp").textContent = "SCANNING IMAGE";
  $("roboflow-line").textContent = "Finding possible fans in the image now…";
  $("jev-line").textContent = "Waiting for Roboflow's marked shapes.";
  $("answer-line").textContent = "The verdicts will appear automatically.";
  $("footer-status").textContent = "A live Roboflow inference is running.";
  phase("roboflow");
  try {
    const inferenceStarted = performance.now();
    const blob = await canvasBlob(state.canvas);
    const response = await fetch("/api/scout/infer", { method: "POST", headers: { ...authHeaders(), "content-type": "image/jpeg" }, body: blob });
    const data = await response.json();
    const browserInferMs = Math.round(performance.now() - inferenceStarted);
    if (!response.ok) throw new Error(data.error || "Roboflow could not scan the image");
    if (generation !== state.generation) return;
    const found = predictionsFromRoboflow(data, state.canvas);
    const chosen = showcaseCandidates(found, state.canvas);
    if (!chosen.length) {
      $("roboflow-line").textContent = "No possible fans appeared in this crop.";
      $("jev-line").textContent = "Nothing was sent to Jev-Omni.";
      $("answer-line").textContent = "Try another Mars crop.";
      $("footer-status").textContent = "No candidates in this image.";
      $("run-again").hidden = false;
      $("image-input").disabled = false;
      state.busy = false; phase("done"); return;
    }
    $("roboflow-line").textContent = `Found ${found.length} possible regions; sending ${chosen.length} substantial regions to Jev-Omni.`;
    $("jev-line").textContent = "Jev-Omni is looking at the marked regions and nearby pixels…";
    $("footer-status").textContent = "Jev-Omni may ask for more of the image before it answers.";
    phase("jev");
    const sessionStarted = performance.now();
    const imageBase64 = state.canvas.toDataURL("image/jpeg", .91).split(",")[1];
    state.session = await api("/api/scout/review-sessions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: true, image_base64: imageBase64, name: state.file.name, observation: state.sample ? SAMPLE.observation : null,
        detector_model: state.modelId, detector_responses: [{ tile: { x: 0, y: 0, width: state.canvas.width, height: state.canvas.height }, response: data }],
        candidates: [...chosen, ...found.filter(item => !chosen.includes(item))].map((item, index) => ({ label: `RF-${String(index + 1).padStart(3, "0")}`, polygon: item.polygon, confidence: item.confidence, arm: "assisted" })) }) });
    saveSessionId(state.session.id);
    console.info("Mars Scout preparation timing", { browser_infer_ms: browserInferMs,
      roboflow_request_ms: data.scout_timing?.roboflow_request_ms ?? null,
      session_create_ms: Math.round(performance.now() - sessionStarted), proposals: found.length });
    renderSession();
    await runAgent(generation);
  } catch (cause) { if (generation === state.generation) error(cause.message); }
}
async function restoreOrRun() {
  const id = sessionId();
  if (id) {
    try {
      const session = await api(`/api/scout/review-sessions/${id}`);
      const response = await fetch(`/api/scout/review-sessions/${id}/image`, { headers: authHeaders() });
      if (!response.ok) throw new Error("Saved image unavailable");
      const blob = await response.blob();
      await setImage(new File([blob], session.image.name || "Mars crop.jpg", { type: blob.type || "image/jpeg" }),
        { sample: session.image.observation === SAMPLE.observation, name: session.image.observation === SAMPLE.observation ? SAMPLE.name : session.image.name || "Mars crop", observation: session.image.observation });
      state.session = session;
      renderSession();
      if (!latestRun()) { state.busy = true; await runAgent(state.generation); }
      else if (!["complete", "interrupted"].includes(latestRun().status)) { state.busy = true; await pollSession(id, state.generation); }
      return;
    } catch { clearSessionId(); await loadSample(); }
  }
  await startRun();
}
async function checkAccess() {
  const statusData = await api("/api/status");
  state.access = !!statusData.access_granted;
  state.modelId = statusData.model_id;
  state.agentReady = !!statusData.review_agent?.enabled;
  state.dailyRemaining = statusData.daily_remaining;
  if (!state.access) { $("access-panel").hidden = false; phase("locked"); return false; }
  $("access-panel").hidden = true;
  if (!statusData.scout_ready) throw new Error("Roboflow is not connected on this Sprite yet.");
  if (!state.agentReady) throw new Error("Jev-Omni is not connected on this Sprite yet.");
  status("Ready to run", "ready");
  return true;
}
async function init() {
  try { state.code = sessionStorage.getItem("mars-fan-scout-access") || ""; } catch { state.code = ""; }
  $("access-form").addEventListener("submit", async event => {
    event.preventDefault();
    state.code = $("access-code").value.trim();
    try { sessionStorage.setItem("mars-fan-scout-access", state.code); } catch { /* Current page still works. */ }
    $("access-error").hidden = true;
    try {
      if (await checkAccess()) await restoreOrRun();
      else { $("access-error").textContent = "That code did not unlock the demo."; $("access-error").hidden = false; }
    } catch (cause) { error(cause.message); }
  });
  $("image-input").addEventListener("change", async event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || state.busy) return;
    try { await setImage(file, { name: file.name.replace(/\.[^.]+$/, "") }); clearSessionId(); if (state.access) await startRun(); }
    catch (cause) { error(cause.message); }
  });
  $("run-again").addEventListener("click", () => startRun());
  try {
    await loadSample();
    if (await checkAccess()) await restoreOrRun();
  } catch (cause) { error(cause.message); }
}
init();
