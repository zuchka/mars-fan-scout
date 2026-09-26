const NS = "http://www.w3.org/2000/svg";
const state = { scenes: [], sceneIndex: 0, stage: "raw", source: "reference", modelReady: false, modelTraining: false, modelRecorded: false, modelVerified: false, modelResults: {}, threshold: .35, selected: null, replayTimers: [] };
const $ = (id) => document.getElementById(id);

function element(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  if (parent) parent.appendChild(node);
  return node;
}

function scene() { return state.scenes[state.sceneIndex]; }
function marks() { return state.source === "reference" ? (scene()?.markings || []) : (state.modelResults[scene()?.id] || []).filter(mark => mark.confidence >= state.threshold); }
function sortedVotes(list) { return [...list].sort((a, b) => (b.votes || b.confidence || 0) - (a.votes || a.confidence || 0)); }
function compass(degrees) {
  const names = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return names[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}
function meanBearing(list) {
  const bearings = list.map(m => m.bearing).filter(Number.isFinite);
  if (!bearings.length) return null;
  let x = 0, y = 0;
  for (const value of bearings) { x += Math.sin(value * Math.PI / 180); y += Math.cos(value * Math.PI / 180); }
  if (Math.hypot(x, y) / bearings.length < .12) return null;
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

function renderSceneList() {
  const list = $("scene-list");
  list.replaceChildren();
  state.scenes.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scene-item" + (index === state.sceneIndex ? " active" : "");
    button.innerHTML = '<span class="scene-top"><span>0' + (index + 1) + ' / 0' + state.scenes.length + '</span><span>' + (item.role === "validation" ? "HELD OUT" : "SPRING") + '</span></span><strong>' + item.title + '</strong><small>' + item.subtitle + '</small>';
    button.addEventListener("click", () => setScene(index));
    list.appendChild(button);
  });
  $("observation-total").textContent = String(state.scenes.length).padStart(2, "0");
}

function clearReplay() { state.replayTimers.forEach(clearTimeout); state.replayTimers = []; }
function setScene(index) {
  if (!state.scenes[index]) return;
  clearReplay();
  state.sceneIndex = index;
  state.selected = null;
  const item = scene();
  $("scene-image").src = "/" + item.image;
  $("scene-image").alt = "HiRISE orbital image " + item.obsid + " showing the southern seasonal polar cap of Mars";
  $("scene-title").textContent = item.title;
  $("scene-id").textContent = item.obsid;
  $("viewer-coordinate").textContent = Math.abs(item.location[0]).toFixed(2) + "° S / " + item.location[1].toFixed(2) + "° E";
  const northVector = item.basis_bearings.map(value => Math.cos(value * Math.PI / 180));
  $("north-arrow").style.setProperty("--north-deg", (Math.atan2(northVector[0], -northVector[1]) * 180 / Math.PI).toFixed(2) + "deg");
  $("hirise-link").href = item.source_url;
  $("caption-source").textContent = "IMAGE: NASA / JPL-CALTECH / UARIZONA";
  document.querySelector(".report-number").textContent = "REPORT 00" + (index + 1) + " / 00" + state.scenes.length;
  renderSceneList();
  renderAll();
}

function setStage(next) {
  if (!["raw", "fans", "wind"].includes(next)) return;
  state.stage = next;
  document.querySelectorAll(".stage").forEach(button => {
    const active = button.dataset.stage === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderAll();
  if (next === "fans") {
    const frame = $("image-frame");
    frame.classList.remove("scanning");
    void frame.offsetWidth;
    frame.classList.add("scanning");
  }
}

function setSource(next) {
  state.source = next;
  state.selected = null;
  $("reference-tab").classList.toggle("active", next === "reference");
  $("model-tab").classList.toggle("active", next === "model");
  $("reference-tab").setAttribute("aria-pressed", String(next === "reference"));
  $("model-tab").setAttribute("aria-pressed", String(next === "model"));
  $("threshold-control").hidden = next !== "model";
  renderAll();
}

function polygonPath(points) {
  return points.map((point, index) => (index ? "L" : "M") + Number(point[0]).toFixed(1) + " " + Number(point[1]).toFixed(1)).join(" ") + " Z";
}

function selectMark(mark) {
  state.selected = mark;
  $("overlay").querySelectorAll(".reference-marker,.fan-shape,.wind-arrow").forEach(node => node.classList.toggle("selected", node.getAttribute("data-mark-id") === mark.id));
  renderInspection();
}

function renderOverlay() {
  const svg = $("overlay");
  svg.replaceChildren();
  const frame = $("image-frame");
  frame.classList.toggle("stage-raw", state.stage === "raw");
  frame.classList.toggle("stage-wind", state.stage === "wind");
  frame.classList.toggle("source-model", state.source === "model");
  const list = marks();
  if (state.stage === "raw" || !list.length) return;
  const visibleMarks = sortedVotes(list);
  visibleMarks.forEach((mark, index) => {
    if (state.source === "reference") {
      if (!mark.base || !mark.vector) return;
      const [x, y] = mark.base;
      const group = element("g", { class:"reference-marker visible" + (state.selected?.id === mark.id ? " selected" : ""), "data-mark-id":mark.id, transform:"translate(" + x + " " + y + ")", style:"--delay:" + Math.min(index * 5, 900) + "ms", tabindex:"0", role:"button", "aria-label":"Inspect Planet Four mark " + (index + 1) + ", bearing " + Math.round(mark.bearing) + " degrees" }, svg);
      element("circle", { cx:0, cy:0, r:5.3 }, group);
      element("path", { d:"M " + (mark.vector[0] * 8).toFixed(1) + " " + (mark.vector[1] * 8).toFixed(1) + " L " + (mark.vector[0] * 20).toFixed(1) + " " + (mark.vector[1] * 20).toFixed(1) }, group);
      element("circle", { cx:0, cy:0, r:15, fill:"transparent", stroke:"none" }, group);
      group.addEventListener("click", () => selectMark(mark));
      group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectMark(mark); } });
      return;
    }
    if (!Array.isArray(mark.polygon) || mark.polygon.length < 3) return;
    const path = element("path", {
      d: polygonPath(mark.polygon),
      class: "fan-shape visible" + (state.selected?.id === mark.id ? " selected" : ""),
      "data-mark-id":mark.id,
      style: "--delay:" + Math.min(index * 9, 950) + "ms",
      tabindex: "0", role: "button",
      "aria-label": "Inspect fan " + (index + 1) + (Number.isFinite(mark.bearing) ? ", bearing " + Math.round(mark.bearing) + " degrees" : ", direction uncertain"),
    }, svg);
    path.addEventListener("click", () => selectMark(mark));
    path.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectMark(mark); } });
  });
  if (state.stage === "wind") drawWindField(svg, list);
}

function drawWindField(svg, list) {
  const bins = new Map();
  for (const mark of list) {
    if (!mark.base || !mark.vector) continue;
    const [x, y] = mark.base;
    const [vx, vy] = mark.vector;
    const mag = Math.hypot(vx, vy);
    if (mag < .1) continue;
    const col = Math.max(0, Math.min(5, Math.floor(x / (1024 / 6))));
    const row = Math.max(0, Math.min(5, Math.floor(y / (1024 / 6))));
    const key = row + ":" + col;
    if (!bins.has(key)) bins.set(key, { col, row, dx: 0, dy: 0, count: 0 });
    const bin = bins.get(key);
    bin.dx += vx / mag;
    bin.dy += vy / mag;
    bin.count++;
  }
  [...bins.values()].filter(bin => bin.count >= (state.source === "model" ? 1 : 2)).sort((a, b) => a.row - b.row || a.col - b.col).forEach((bin, index) => {
    const certainty = Math.hypot(bin.dx, bin.dy) / bin.count;
    if (certainty < .2) return;
    const cx = (bin.col + .5) * 1024 / 6, cy = (bin.row + .5) * 1024 / 6;
    const degrees = Math.atan2(bin.dy, bin.dx) * 180 / Math.PI;
    const len = Math.min(130, 85 + bin.count * 4);
    const group = element("g", { class: "wind-arrow visible", transform: "translate(" + cx + " " + cy + ") rotate(" + degrees + ")", style: "--delay:" + (300 + index * 34) + "ms;opacity:" + Math.max(.46, certainty).toFixed(2), tabindex:"0", role:"button", "aria-label":"Inspect image evidence for this wind vector" }, svg);
    element("path", { d: "M " + (-len / 2) + " 0 Q 0 -10 " + (len / 2) + " 0 M " + (len / 2 - 18) + " -12 L " + (len / 2) + " 0 L " + (len / 2 - 18) + " 12" }, group);
    element("circle", { cx: -len / 2, cy: 0, r: 4.5, class:"wind-origin", stroke: "none" }, group);
    element("circle", { cx: 0, cy: 0, r: 34, fill: "transparent", stroke: "none" }, group);
    const representative = list.filter(mark => mark.base && Math.floor(mark.base[0] / (1024 / 6)) === bin.col && Math.floor(mark.base[1] / (1024 / 6)) === bin.row)
      .sort((left, right) => Math.hypot(left.base[0]-cx,left.base[1]-cy) - Math.hypot(right.base[0]-cx,right.base[1]-cy))[0];
    if (representative) {
      group.setAttribute("data-mark-id", representative.id);
      group.addEventListener("click", () => selectMark(representative));
      group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectMark(representative); } });
    }
  });
}

function renderRose(list) {
  const svg = $("direction-rose");
  svg.replaceChildren();
  const center = [170, 90], count = 16, values = new Array(count).fill(0);
  for (const mark of list) if (Number.isFinite(mark.bearing)) values[Math.round(mark.bearing / 22.5) % count]++;
  element("circle", { cx: center[0], cy: center[1], r: 60, class: "rose-grid" }, svg);
  element("circle", { cx: center[0], cy: center[1], r: 36, class: "rose-grid" }, svg);
  element("circle", { cx: center[0], cy: center[1], r: 12, class: "rose-grid" }, svg);
  for (let i = 0; i < count; i++) {
    if (!values[i]) continue;
    const theta = (i * 22.5 - 90) * Math.PI / 180;
    const length = values[i] ? 17 + 43 * values[i] / Math.max(1, ...values) : 8;
    const x1 = center[0] + Math.cos(theta) * 15, y1 = center[1] + Math.sin(theta) * 15;
    const x2 = center[0] + Math.cos(theta) * length, y2 = center[1] + Math.sin(theta) * length;
    element("line", { x1, y1, x2, y2, class: "rose-bar" + (state.source === "model" ? " model" : ""), stroke: "#a7e6d9", "stroke-width": i % 4 === 0 ? 8 : 5, "stroke-linecap": "round", opacity: .85 }, svg);
  }
  [["N",170,11],["E",258,94],["S",170,176],["W",82,94]].forEach(([label,x,y]) => {
    const text = element("text", { x, y, class: "rose-label", "text-anchor": "middle" }, svg);
    text.textContent = label;
  });
}

function renderInspection() {
  const mark = state.selected;
  $("inspection-prompt").hidden = !!mark;
  $("inspection-grid").hidden = !mark;
  $("selection-callout").hidden = !mark;
  $("inspection-source").textContent = mark ? (state.source === "reference" ? "PLANET FOUR · " + mark.tile_id : (mark.catalogMatch ? "ROBOFLOW MASK · PLANET FOUR BEARING" : "ROBOFLOW MASK · NO CATALOG MATCH")) : "";
  $("selection-number").textContent = mark ? mark.id : "—";
  if (mark) {
    $("inspection-bearing").textContent = Number.isFinite(mark.bearing) ? Math.round(mark.bearing) + "° " + compass(mark.bearing) : "UNCERTAIN";
    $("inspection-score-label").textContent = state.source === "reference" ? "CITIZEN VOTES" : "MODEL CONFIDENCE";
    $("inspection-score").textContent = state.source === "reference" ? String(mark.votes) : Math.round(mark.confidence * 100) + "%";
    $("selection-callout-label").textContent = state.source === "reference" ? "PLANET FOUR MARK" : "ROBOFLOW MASK";
    $("selection-callout-main").textContent = Number.isFinite(mark.bearing) ? Math.round(mark.bearing) + "° " + compass(mark.bearing) : "DIRECTION UNKNOWN";
    $("selection-callout-detail").textContent = state.source === "reference" ? mark.votes + " citizen votes" : Math.round(mark.confidence * 100) + "% confidence · " + (mark.catalogMatch ? "catalog guided" : "no catalog match");
  }
}

function updateActionNote() {
  const note = $("model-action-note");
  if ($("run-model").classList.contains("loading")) {
    note.textContent = state.modelRecorded ? "Loading a saved Roboflow response…" : "Sending this observation to Roboflow…";
  } else if (state.modelResults[scene()?.id]) {
    if (state.source === "reference") {
      note.textContent = (state.modelRecorded ? "Recorded" : "Live") + " model result ready · switch sources to compare";
    } else {
      const visible = state.modelResults[scene().id].filter(mark => mark.confidence >= state.threshold);
      note.textContent = visible.length + " visible masks · " + visible.filter(mark => mark.catalogMatch).length + " catalog matched at " + Math.round(state.threshold * 100) + "%";
    }
  } else if (state.modelRecorded) {
    note.textContent = state.modelReady ? "Saved response ready for this observation" : "Saved Roboflow responses are missing";
  } else if (state.modelTraining) {
    note.textContent = "Roboflow is fitting the segmentation model";
  } else {
    note.textContent = state.modelReady ? "Ready to test live instance segmentation" : "Connect a trained model to enable live inference.";
  }
}

function renderAll() {
  if (!scene()) return;
  const list = marks();
  const bearing = meanBearing(list);
  const isRaw = state.stage === "raw";
  const isReference = state.source === "reference";
  const lackingModel = !isReference && !state.modelResults[scene().id];
  const noDetections = !isReference && !lackingModel && !list.length;
  const directionalCount = list.filter(mark => Number.isFinite(mark.bearing)).length;
  $("model-message").hidden = !lackingModel;
  if (lackingModel) $("model-message").textContent = state.modelTraining ? "The Roboflow model is training. Planet Four marks remain available as a separate reference layer." : (state.modelReady ? "No model output for this image yet. Run live inference below; reference markings are kept separate." : "A Roboflow model is not connected. These images and reference marks are ready, but no model predictions are being shown.");
  $("fan-count").textContent = isRaw ? "—" : (lackingModel ? "—" : list.length.toLocaleString());
  $("dominant-bearing").textContent = isRaw || bearing === null ? "—" : Math.round(bearing) + "°";
  $("count-label").textContent = isReference ? "CATALOG MARKS" : "MODEL DETECTIONS";
  $("count-foot").textContent = isReference ? "Approximate fan locations" : directionalCount + " catalog matched";
  $("bearing-label").textContent = isReference ? "DOMINANT BEARING" : "GUIDED BEARING";
  $("bearing-foot").textContent = isReference ? "Catalog orientation" : "Matched catalog marks";
  $("rose-note").textContent = isReference ? "CATALOG" : "MODEL + CATALOG";
  $("frame-status").textContent = isRaw ? "RAW IMAGE" : (state.stage === "fans" ? (isReference ? "CATALOG LOCATIONS" : "ROBOFLOW MASKS") : (isReference ? "CATALOG WIND FIELD" : "CATALOG-GUIDED FIELD"));
  $("caption-primary").textContent = isRaw ? "Orbital image · no analysis overlay" : (isReference ? "Approximate fan locations · Planet Four v3.1" : (state.modelRecorded ? "Recorded Roboflow segmentation · saved model response" : "Pixel-level instance segmentation · Roboflow model"));
  if (isRaw) {
    $("finding-title").innerHTML = "The surface holds<br>a record of <i>wind.</i>";
    $("finding-description").textContent = "Reveal the fan markings to see how a pattern of dark deposits becomes a directional field.";
  } else if (lackingModel) {
    $("finding-title").innerHTML = "Awaiting a<br><i>trained model.</i>";
    $("finding-description").textContent = "Connect a Roboflow instance-segmentation model and run inference to produce an independent wind field.";
  } else if (noDetections) {
    $("finding-title").innerHTML = "No fans above<br><i>this threshold.</i>";
    $("finding-description").textContent = "Lower the confidence threshold or try another observation. The model did not provide enough evidence for a direction here.";
  } else if (state.stage === "fans") {
    $("finding-title").innerHTML = "Each dark fan<br>is a <i>clue.</i>";
    $("finding-description").textContent = isReference ? "Volunteer marks locate fans and indicate their orientation; they are not pixel-level outlines." : "Roboflow outlines dark deposits. Nearby Planet Four marks provide bearings; unmatched masks are candidates for review.";
  } else {
    $("finding-title").innerHTML = "A field of<br><i>directions.</i>";
    $("finding-description").textContent = isReference ? "Nearby fan directions combine into a local wind pattern. Each arrow traces back to a volunteer mark." : "Arrows appear where a Roboflow mask matches a nearby Planet Four orientation. Each arrow traces back to both sources.";
  }
  renderOverlay();
  renderRose(isRaw ? [] : list);
  renderInspection();
  updateActionNote();
}

function normalizePredictions(payload) {
  const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
  const width = payload.image?.width || 1024, height = payload.image?.height || 1024;
  const output = [];
  predictions.forEach((prediction, index) => {
    const raw = Array.isArray(prediction.points) ? prediction.points : (Array.isArray(prediction.polygon) ? prediction.polygon : []);
    const polygon = raw.map(p => Array.isArray(p) ? [Number(p[0]),Number(p[1])] : [Number(p.x),Number(p.y)]).filter(p => p.every(Number.isFinite)).map(([x,y]) => [x*1024/width,y*1024/height]);
    if (polygon.length < 3 || Number(prediction.confidence || 0) < .2) return;
    const center = [polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length, polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length];
    let nearest = null, distance = Infinity;
    for (const reference of scene().markings || []) {
      const gap = Math.hypot(center[0] - reference.base[0], center[1] - reference.base[1]);
      if (gap < distance) { nearest = reference; distance = gap; }
    }
    const catalogMatch = distance <= 45 ? nearest : null;
    output.push({ id:"RF-" + String(index+1).padStart(3,"0"), polygon, base:catalogMatch ? center : null, vector:catalogMatch ? catalogMatch.vector : null, bearing:catalogMatch ? catalogMatch.bearing : null, catalogMatch:catalogMatch?.id || null, confidence:Number(prediction.confidence || 0) });
  });
  return output;
}

async function runModel() {
  if (!state.modelReady || !scene()) return;
  const button = $("run-model");
  const frame = $("image-frame");
  const inferenceScene = scene();
  button.disabled = true;
  button.classList.add("loading");
  button.textContent = state.modelRecorded ? "Replaying Roboflow result…" : "Roboflow is scanning…";
  setSource("model");
  setStage("raw");
  frame.classList.add("inferring");
  frame.setAttribute("aria-busy", "true");
  $("frame-status").textContent = state.modelRecorded ? "REPLAYING MODEL OUTPUT" : "ROBOFLOW SCANNING";
  let failed = false;
  try {
    const response = await fetch("/api/infer", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({sceneId:inferenceScene.id}) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Inference failed");
    if (scene()?.id !== inferenceScene.id) return;
    const normalized = normalizePredictions(payload);
    state.modelResults[inferenceScene.id] = normalized;
    state.modelVerified = true;
    $("model-pill-text").textContent = state.modelRecorded ? "RECORDED MODEL OUTPUT" : "LIVE INFERENCE VERIFIED";
    setSource("model");
    setStage("fans");
  } catch (error) {
    failed = true;
    $("model-message").hidden = false;
    $("model-message").textContent = error.message;
    $("model-action-note").textContent = "Inference could not complete";
  } finally {
    frame.classList.remove("inferring");
    frame.removeAttribute("aria-busy");
    if (state.stage === "raw") $("frame-status").textContent = "RAW IMAGE";
    button.disabled = false;
    button.classList.remove("loading");
    button.innerHTML = (state.modelRecorded ? 'Replay saved Roboflow result' : 'Run Roboflow on this image') + ' <span aria-hidden="true">↗</span>';
    if (!failed) updateActionNote();
  }
}

async function checkModel() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    state.modelReady = !!status.ready;
    state.modelTraining = !!status.training;
    state.modelRecorded = status.mode === "recorded";
  } catch (_) { state.modelReady = false; }
  $("model-pill").classList.toggle("connected", state.modelReady);
  $("model-pill-text").textContent = state.modelRecorded && state.modelReady ? "RECORDED MODEL OUTPUT" : (state.modelVerified ? "LIVE INFERENCE VERIFIED" : (state.modelTraining ? "MODEL TRAINING" : (state.modelReady ? "MODEL CONFIGURED" : "MODEL NOT CONNECTED")));
  $("run-model").disabled = !state.modelReady;
  $("run-model").innerHTML = (state.modelRecorded ? "Replay saved Roboflow result" : "Run Roboflow on this image") + ' <span aria-hidden="true">↗</span>';
  renderAll();
}

async function init() {
  document.querySelectorAll(".stage").forEach(button => button.addEventListener("click", () => { clearReplay(); setStage(button.dataset.stage); }));
  $("reference-tab").addEventListener("click", () => setSource("reference"));
  $("model-tab").addEventListener("click", () => setSource("model"));
  $("run-model").addEventListener("click", runModel);
  $("threshold").addEventListener("input", event => {
    state.threshold = Number(event.target.value) / 100;
    $("threshold-value").textContent = event.target.value + "%";
    state.selected = null;
    renderAll();
  });
  $("replay-button").addEventListener("click", () => {
    clearReplay(); setStage("raw");
    state.replayTimers.push(setTimeout(() => setStage("fans"), 650));
    state.replayTimers.push(setTimeout(() => setStage("wind"), 2450));
  });
  try {
    const response = await fetch("/scenes.json");
    if (!response.ok) throw new Error("Could not load observations");
    state.scenes = await response.json();
    setScene(0);
    await checkModel();
  } catch (error) {
    $("scene-title").textContent = "Observation unavailable";
    $("finding-description").textContent = error.message;
  }
}

document.addEventListener("DOMContentLoaded", init);
