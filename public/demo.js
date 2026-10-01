import { predictionsFromRoboflow, showcaseCandidates } from "./candidates.js";

const $ = id => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const SAMPLE = { path: "/images/scout-2024-dev.jpg", name: "Spiders in Manhattan", observation: "ESP_082142_0935" };
const CACHE_KEY = "mars-fan-scout-mask-demo-v1";
const state = { code: "", access: false, canvas: null, imageUrl: null, sample: true, name: SAMPLE.name,
  candidates: [], selectedId: null, refined: new Map(), busy: false, refining: false, generation: 0, remaining: null };

function headers() { return state.code ? { "x-demo-access-code": state.code } : {}; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`);
  return body;
}
function phase(name) {
  $("image-scan").hidden = name !== "scanning";
  $("run-light").textContent = { scanning: "SCANNING", done: "READY TO INSPECT", error: "NEEDS RETRY", locked: "WAITING" }[name];
  $("run-light").className = "run-light" + (name === "done" ? " done" : name === "scanning" ? " active" : "");
  $("top-status").textContent = { scanning: "Roboflow is scanning", done: "Regions ready to inspect", error: "Scan interrupted", locked: "Meeting code needed" }[name];
  $("status-dot").className = name === "done" ? "ready" : name === "scanning" ? "busy" : "";
  $("roboflow-step").classList.toggle("active", name === "scanning");
  $("roboflow-step").classList.toggle("done", name === "done");
  $("sam-step").classList.toggle("active", name === "done");
  $("answer-step").classList.toggle("done", name === "done");
}
function fail(message) {
  $("run-error").textContent = message; $("run-error").hidden = false;
  $("footer-status").textContent = "The image is still here. Try the scan again.";
  $("run-again").hidden = !state.access; $("image-input").disabled = false;
  state.busy = false; phase("error");
}
function jpeg(canvas) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare the image")), "image/jpeg", .91)); }
async function setImage(file, { sample = false, name = file.name, observation = null } = {}) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error("Choose a JPG, PNG, or WebP crop under 8 MB.");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width < 256 || bitmap.height < 256 || bitmap.width > 3072 || bitmap.height > 3072) {
    bitmap.close(); throw new Error("Choose a Mars crop between 256 and 3072 pixels on each side.");
  }
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(await jpeg(canvas));
  state.canvas = canvas; state.sample = sample; state.name = name;
  $("mars-image").src = state.imageUrl;
  $("mars-image").alt = sample ? `NASA HiRISE crop from ${observation}` : `Uploaded Mars crop ${name}`;
  $("candidate-overlay").setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
  $("image-title").textContent = name;
  $("image-label").textContent = sample ? `NASA HiRISE · ${observation}` : `${canvas.width} × ${canvas.height} px working crop`;
  state.candidates = []; state.selectedId = null; state.refined.clear(); state.refining = false;
  $("candidate-overlay").replaceChildren(); $("results-area").hidden = true;
  $("candidate-detail").hidden = true; $("refine-button").hidden = true;
  $("image-stamp").textContent = "ORIGINAL IMAGE";
}
async function loadSample() {
  const response = await fetch(SAMPLE.path);
  if (!response.ok) throw new Error("The sample Mars image is unavailable.");
  await setImage(new File([await response.blob()], "ESP_082142_0935_crop.jpg", { type: "image/jpeg" }),
    { sample: true, name: SAMPLE.name, observation: SAMPLE.observation });
}
function bounds(points) { return { left: Math.min(...points.map(p => p[0])), top: Math.min(...points.map(p => p[1])),
  right: Math.max(...points.map(p => p[0])), bottom: Math.max(...points.map(p => p[1])) }; }
function context(candidate) {
  const b = bounds(candidate.polygon), side = Math.ceil(Math.max(105, b.right - b.left, b.bottom - b.top) * 2.2);
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  return { left: Math.max(0, Math.floor(cx - side / 2)), top: Math.max(0, Math.floor(cy - side / 2)),
    right: Math.min(state.canvas.width, Math.ceil(cx + side / 2)), bottom: Math.min(state.canvas.height, Math.ceil(cy + side / 2)) };
}
function polygon(points, className) {
  const element = document.createElementNS(NS, "polygon");
  element.setAttribute("points", points.map(point => point.join(",")).join(" "));
  element.setAttribute("class", className);
  return element;
}
function drawMasks() {
  const overlay = $("candidate-overlay"); overlay.replaceChildren();
  state.candidates.forEach((candidate, index) => {
    if (index >= 3 && candidate.id !== state.selectedId) return;
    const active = candidate.id === state.selectedId ? " active" : "";
    overlay.appendChild(polygon(candidate.polygon, "candidate-mask" + active));
    if (state.refined.has(candidate.id)) overlay.appendChild(polygon(state.refined.get(candidate.id), "sam3-mask" + active));
    const b = bounds(candidate.polygon), label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(Math.max(15, b.left))); label.setAttribute("y", String(Math.max(30, b.top - 6)));
    label.setAttribute("class", "candidate-number"); label.textContent = String(index + 1).padStart(2, "0"); overlay.appendChild(label);
  });
  const selected = state.candidates.find(item => item.id === state.selectedId);
  if (selected) {
    const b = context(selected), window = document.createElementNS(NS, "rect");
    for (const [key, value] of Object.entries({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top })) window.setAttribute(key, String(value));
    window.setAttribute("class", "context-window"); overlay.appendChild(window);
  }
  $("image-stamp").textContent = state.candidates.length ? `${state.candidates.length} RF-DETR REGIONS${state.refined.size ? ` · ${state.refined.size} SAM 3 EDGES` : ""}` : "ORIGINAL IMAGE";
  $("mask-legend").textContent = state.refined.size ? "Orange = RF-DETR core · cyan = SAM 3 suggested edge · dashed square = selected crop" : "Orange = RF-DETR core · dashed square = selected crop";
}
function showDetail() {
  const candidate = state.candidates.find(item => item.id === state.selectedId);
  if (!candidate) { $("candidate-detail").hidden = true; return; }
  const index = state.candidates.indexOf(candidate) + 1, b = context(candidate), crop = document.createElement("canvas");
  crop.width = b.right - b.left; crop.height = b.bottom - b.top;
  crop.getContext("2d").drawImage(state.canvas, b.left, b.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
  $("candidate-detail").hidden = false;
  $("detail-name").textContent = `SHAPE ${String(index).padStart(2, "0")}`;
  $("detail-verdict").textContent = "Candidate";
  $("detail-explanation").textContent = state.refined.has(candidate.id)
    ? "Compare the cyan SAM 3 edge with the orange RF-DETR core and source pixels. The larger outline is still a proposal, not a confirmed fan."
    : "RF-DETR proposed this dark region. Inspect the source pixels and surrounding shape before calling it a fan.";
  $("source-evidence").src = crop.toDataURL("image/jpeg", .9);
}
function renderResults() {
  $("results-area").hidden = !state.candidates.length;
  $("results-count").textContent = `${state.candidates.length} regions · no fan probability assigned`;
  const list = $("results-list"), other = $("other-results-list"); list.replaceChildren(); other.replaceChildren();
  $("other-regions").hidden = state.candidates.length <= 3;
  $("other-regions-count").textContent = String(Math.max(0, state.candidates.length - 3));
  state.candidates.forEach((candidate, index) => {
    const button = document.createElement("button"); button.type = "button";
    button.className = "result-card" + (candidate.id === state.selectedId ? " active" : "");
    button.setAttribute("aria-pressed", String(candidate.id === state.selectedId));
    const number = document.createElement("span"); number.className = "index"; number.textContent = String(index + 1);
    const name = document.createElement("span"); name.className = "name"; name.textContent = `Shape ${String(index + 1).padStart(2, "0")}`;
    const source = document.createElement("small"); source.textContent = "RF-DETR proposal"; name.appendChild(source);
    const tag = document.createElement("span"); tag.className = "verdict"; tag.textContent = state.refined.has(candidate.id) ? "SAM 3 edge" : "Inspect";
    button.append(number, name, tag);
    button.addEventListener("click", () => { state.selectedId = candidate.id; drawMasks(); renderResults(); showDetail(); });
    (index < 3 ? list : other).appendChild(button);
  });
}
function renderScan() {
  if (!state.candidates.some(item => item.id === state.selectedId)) state.selectedId = state.candidates[0]?.id || null;
  drawMasks(); renderResults(); showDetail();
  $("refine-button").hidden = !state.access || !state.candidates.length;
  $("refine-button").textContent = state.refined.size ? "Retrace with SAM 3" : "Trace with SAM 3";
  $("roboflow-line").textContent = state.candidates.length ? `Found ${state.candidates.length} possible dark regions. Three substantial regions are featured; all remain inspectable.` : "No possible fan regions appeared in this crop.";
  $("sam-line").textContent = state.refined.size ? `${state.refined.size} featured regions have a SAM 3 edge. Compare it with the RF-DETR core.` : "Optional: ask SAM 3 to redraw the three featured edges using RF-DETR boxes.";
  $("answer-line").textContent = "Select a shape and inspect its source pixels. These masks are candidate deposits, not confirmed fans.";
  $("footer-status").textContent = state.candidates.length ? "Scan complete. Compare outlines or try another Mars crop." : "Try another Mars crop.";
  $("run-again").hidden = false; $("image-input").disabled = false; state.busy = false; phase("done");
}
function saveCache() {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, sample: state.sample, name: state.name,
    image_base64: state.sample ? null : state.canvas.toDataURL("image/jpeg", .91).split(",")[1],
    candidates: state.candidates, refined: [...state.refined] })); }
  catch { /* A full browser store does not prevent the current demo from working. */ }
}
async function restoreCache() {
  let saved; try { saved = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null"); } catch { return false; }
  if (saved?.version !== 1 || !Array.isArray(saved.candidates) || saved.candidates.length > 250) return false;
  if (!saved.sample) {
    if (typeof saved.image_base64 !== "string") return false;
    const response = await fetch(`data:image/jpeg;base64,${saved.image_base64}`);
    await setImage(new File([await response.blob()], `${saved.name || "Mars crop"}.jpg`, { type: "image/jpeg" }), { name: saved.name || "Mars crop" });
  }
  state.candidates = saved.candidates.filter(item => item && typeof item.id === "string" && Array.isArray(item.polygon) && item.polygon.length >= 3);
  const ids = new Set(state.candidates.slice(0, 3).map(item => item.id));
  state.refined = new Map(Array.isArray(saved.refined) ? saved.refined.filter(item => Array.isArray(item) && ids.has(item[0]) && Array.isArray(item[1]) && item[1].length >= 3) : []);
  renderScan(); return true;
}
async function refineFeatured() {
  if (!state.access || !state.canvas || !state.candidates.length || state.refining) return;
  const featured = state.candidates.slice(0, 3), generation = state.generation;
  state.refining = true; $("refine-button").disabled = true; $("refine-button").textContent = "Tracing…";
  $("refine-status").hidden = false; $("refine-status").textContent = "SAM 3 is tracing the featured regions through Roboflow.";
  try {
    const boxes = featured.map(candidate => { const b = bounds(candidate.polygon); return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2,
      width: (b.right - b.left) * 1.8, height: (b.bottom - b.top) * 1.8 }; });
    const result = await api("/api/scout/refine", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_base64: state.canvas.toDataURL("image/jpeg", .91).split(",")[1], boxes }) });
    if (generation !== state.generation) return;
    state.refined.clear();
    result.masks.forEach((mask, index) => { if (Array.isArray(mask.polygon) && mask.polygon.length >= 3) state.refined.set(featured[index].id, mask.polygon); });
    if (Number.isFinite(state.remaining)) state.remaining = Math.max(0, state.remaining - 1);
    saveCache(); renderScan();
    $("refine-status").textContent = state.refined.size ? `SAM 3 traced ${state.refined.size} of ${featured.length} regions in ${(result.sam3_request_ms / 1000).toFixed(1)}s. Inspect the cyan edges.` : "SAM 3 returned no usable outlines for these regions.";
  } catch (cause) { if (generation === state.generation) $("refine-status").textContent = `SAM 3 could not trace these regions: ${cause.message}`; }
  finally { if (generation === state.generation) { state.refining = false; $("refine-button").disabled = false; $("refine-button").textContent = state.refined.size ? "Retrace with SAM 3" : "Trace with SAM 3"; } }
}
async function startRun() {
  if (!state.access || !state.canvas || state.busy) return;
  if (state.remaining === 0) { fail("Today's Roboflow scan allowance is exhausted. A saved result may be available after you reload."); return; }
  const generation = ++state.generation; state.busy = true; state.refining = false;
  $("run-error").hidden = true; state.candidates = []; state.selectedId = null; state.refined.clear();
  $("candidate-overlay").replaceChildren(); $("results-area").hidden = true; $("candidate-detail").hidden = true;
  $("refine-button").hidden = true; $("refine-button").disabled = false; $("refine-status").hidden = true; $("run-again").hidden = true; $("image-input").disabled = true;
  $("image-stamp").textContent = "SCANNING IMAGE";
  $("roboflow-line").textContent = "Finding possible dark fan deposits in the image…";
  $("sam-line").textContent = "Available after the RF-DETR scan.";
  $("answer-line").textContent = "Source pixels will appear for each candidate.";
  $("footer-status").textContent = "A live Roboflow inference is running."; phase("scanning");
  try {
    const data = await api("/api/scout/infer", { method: "POST", headers: { "content-type": "image/jpeg" }, body: await jpeg(state.canvas) });
    if (generation !== state.generation) return;
    const found = predictionsFromRoboflow(data, state.canvas), chosen = showcaseCandidates(found, state.canvas);
    state.candidates = [...chosen, ...found.filter(item => !chosen.includes(item))].map((item, index) => ({
      id: `RF-${String(index + 1).padStart(3, "0")}`, polygon: item.polygon, confidence: item.confidence }));
    if (Number.isFinite(state.remaining)) state.remaining = Math.max(0, state.remaining - 1);
    saveCache(); renderScan();
  } catch (cause) { if (generation === state.generation) fail(cause.message); }
}
async function checkAccess() {
  const data = await api("/api/status");
  state.access = !!data.access_granted; state.remaining = data.daily_remaining;
  if (!state.access) { $("access-panel").hidden = false; phase("locked"); return false; }
  $("access-panel").hidden = true;
  if (!data.scout_ready) throw new Error("Roboflow is not connected on this server yet.");
  return true;
}
async function init() {
  $("refine-button").addEventListener("click", refineFeatured);
  try { state.code = sessionStorage.getItem("mars-fan-scout-access") || ""; } catch { state.code = ""; }
  $("access-form").addEventListener("submit", async event => {
    event.preventDefault(); state.code = $("access-code").value.trim();
    try { sessionStorage.setItem("mars-fan-scout-access", state.code); } catch { /* The current page still works. */ }
    $("access-error").hidden = true;
    try { if (await checkAccess()) { if (!await restoreCache()) await startRun(); }
      else { $("access-error").textContent = "That code did not unlock the demo."; $("access-error").hidden = false; } }
    catch (cause) { fail(cause.message); }
  });
  $("image-input").addEventListener("change", async event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || state.busy) return;
    try { await setImage(file, { name: file.name.replace(/\.[^.]+$/, "") }); if (state.access) await startRun(); }
    catch (cause) { fail(cause.message); }
  });
  $("run-again").addEventListener("click", startRun);
  try { await loadSample(); if (await checkAccess() && !await restoreCache()) await startRun(); }
  catch (cause) { fail(cause.message); }
}
init();
