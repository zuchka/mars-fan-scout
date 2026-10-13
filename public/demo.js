import {
  bounds,
  candidateRegion,
  tilesForRegion,
  mapPoints,
} from "./geometry.js";
import { ImageViewer } from "./image-viewer.js";
import { saveSession, loadSession } from "./session-store.js";
import { maskRGBA, decodeRLE } from "./masks.js";
import { isReviewed, nextUnreviewed, reviewProgress, setReview } from "./review-flow.js";
const $ = (id) => document.getElementById(id),
  NS = "http://www.w3.org/2000/svg";
const rasterCache = new Map();
const state = {
  code: "",
  access: false,
  source: null,
  run: null,
  job: null,
  selected: null,
  refined: {},
  reviews: {},
  edits: {},
  fringes: {},
  busy: false,
  refining: false,
  generation: 0,
  detailToken: 0,
  remaining: null,
  model: null,
  restored: false,
  hidden: false,
};
const headers = () => (state.code ? { "x-demo-access-code": state.code } : {});
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.error || `Request failed (${response.status})`,
    );
    error.terminal = response.status >= 400 && response.status < 500;
    throw error;
  }
  return data;
}
async function blob(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {}
    throw new Error(data?.error || "Could not load source pixels");
  }
  return response.blob();
}
const post = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const selected = () =>
  state.run?.candidates.find((c) => c.id === state.selected);
function message(text) {
  $("run-error").textContent = text;
  $("run-error").hidden = !text;
}
function status(text, busy = false) {
  $("top-status").textContent = text;
  $("run-light").textContent = text;
  $("status-dot").className = busy ? "busy" : "ready";
  $("run-light").className = "run-light " + (busy ? "active" : "done");
}
function sourceRegion(region, max = 1024) {
  const query = new URLSearchParams({ ...region, max });
  return blob(`/api/scout/sources/${state.source.id}/region?${query}`);
}
const viewer = new ImageViewer(
  $("image-frame"),
  $("mars-image"),
  $("candidate-overlay"),
  sourceRegion,
  (error) => {
    if (!state.source) return;
    $("zoom-label").textContent =
      `${Math.round(viewer.zoom * 100)}%${error ? " · detail pending" : ""}`;
    updateEstimate();
    scaleLabels();
  },
);
async function persist() {
  try {
    await saveSession({
      version: 2,
      source: state.source,
      run: state.run,
      job: state.job,
      selected: state.selected,
      refined: state.refined,
      reviews: state.reviews,
      edits: state.edits,
      fringes: state.fringes,
      model: state.model,
      pipeline: "native-v1",
      pendingRefine: state.pendingRefine,
    });
    $("storage-status").textContent = "";
  } catch {
    $("storage-status").textContent =
      "Browser storage is unavailable. Export your review before leaving.";
  }
}
async function setSource(source, { remember = true } = {}) {
  if (state.source && remember) await persist();
  const generation = ++state.generation;
  state.detailToken++;
  state.worker?.terminate();
  const preview = await createImageBitmap(await blob(source.preview));
  if (generation !== state.generation) {
    preview.close();
    return;
  }
  rasterCache.clear();
  state.source = source;
  state.run = null;
  state.job = null;
  state.selected = null;
  state.refined = {};
  state.reviews = {};
  state.edits = {};
  state.fringes = {};
  state.pendingRefine = null;
  state.restored = false;
  state.detail = null;
  state.busy = false;
  state.refining = false;
  document.body.classList.remove("has-results");
  $("image-stamp").textContent = "ORIGINAL PIXELS RETAINED";
  $("image-title").textContent = source.name;
  $("image-label").textContent =
    `${source.width.toLocaleString()} × ${source.height.toLocaleString()} native pixels`;
  $("source-name").textContent = source.name;
  $("source-observation").textContent = source.observation
    ? `HiRISE · ${source.observation}`
    : "User-provided source";
  $("source-link").hidden = !source.observation;
  $("image-credit").textContent = source.observation
    ? "IMAGE: NASA / JPL-CALTECH / UARIZONA"
    : "IMAGE: USER PROVIDED";
  $("source-meta").textContent =
    `Original ${source.bit_depth}-bit source retained · ${source.pixel_scale_m ? `${source.pixel_scale_m} m/pixel` : "pixel scale unknown"} · display and model crops use an 8-bit derivative.${source.id === "orbit" ? " Black gaps contain no source coverage." : ""}`;
  $("scan-scale").value = source.pixel_scale_m === 0.5 ? "2" : "1";
  $("scan-scale").options[0].disabled = !source.pixel_scale_m;
  $("scan-scale").options[0].textContent = source.pixel_scale_m
    ? `${source.pixel_scale_m * 2} m/pixel · scale-matched`
    : "Scale unknown";
  $("view-contrast").value = "100";
  $("mars-image").style.filter = "";
  $("candidate-overlay").replaceChildren();
  $("candidate-detail").hidden = true;
  $("results-area").hidden = true;
  $("scan-progress").hidden = true;
  $("cancel-scan").hidden = true;
  $("retry-scan").hidden = true;
  $("refine-status").hidden = true;
  await viewer.setSource(source, preview);
  message("");
  $("roboflow-line").textContent =
    "Choose an area and scan. The original remains available.";
  $("sam-line").textContent = "Trace a selected region from its native pixels.";
  $("answer-line").textContent =
    "Review each proposed region before accepting it.";
  $("footer-status").textContent = "Source ready. No new inference yet.";
  status(state.access ? "Ready to scan" : "Meeting code needed");
  updateControls();
}
function scanRegion() {
  return $("scan-area").value === "full"
    ? { x: 0, y: 0, width: state.source.width, height: state.source.height }
    : viewer.visible();
}
function updateEstimate() {
  if (!state.source) return;
  const scale = Number($("scan-scale").value);
  const region = scanRegion();
  const count = tilesForRegion(region, scale).length;
  state.estimate = count;
  $("scan-estimate").textContent =
    `${region.width.toLocaleString()} × ${region.height.toLocaleString()} source pixels · ${count} detector request${count === 1 ? "" : "s"}${count > 25 ? " · zoom in (25 maximum)" : ""}${state.remaining !== null ? ` · ${state.remaining} remaining today` : ""}`;
  updateControls();
}
function updateControls() {
  $("review-input").disabled = !!(
    state.busy ||
    state.refining ||
    state.uploading
  );

  $("scan-button").disabled =
    !state.access ||
    state.busy ||
    state.uploading ||
    state.refining ||
    state.estimate > 25 ||
    (state.features?.tiled_detection === false && state.estimate > 1) ||
    state.remaining === 0;
  for (const id of [
    "image-input",
    "sample-button",
    "orbit-button",
    "scan-area",
    "scan-scale",
  ])
    $(id).disabled =
      state.busy ||
      state.refining ||
      state.uploading ||
      (id === "image-input" && !state.access);
  $("refine-button").disabled =
    state.features?.native_refinement === false ||
    !state.access ||
    state.busy ||
    state.uploading ||
    state.refining ||
    !selected() ||
    state.remaining === 0;
  $("export-review").disabled = !state.run;
  $("context-size").disabled = state.refining;
  for (const input of [$("image-input"), $("review-input")]) {
    input
      .closest("label")
      .setAttribute("aria-disabled", String(input.disabled));
    input.closest("label").tabIndex = input.disabled ? -1 : 0;
  }
}
function svgPolygon(points, className) {
  const node = document.createElementNS(NS, "polygon");
  node.setAttribute("points", points.map((p) => p.join(",")).join(" "));
  node.setAttribute("class", className);
  node.style.fillOpacity = String(Number($("fill-opacity").value) / 100);
  return node;
}
function svgRaster(refined) {
  const opacity = Number($("fill-opacity").value) / 100,
    key = `${refined.job_id}:${opacity}`;
  if (!rasterCache.has(key)) {
    const { rgba, width, height } = maskRGBA(refined.rle, opacity),
      canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")
      .putImageData(new ImageData(rgba, width, height), 0, 0);
    rasterCache.set(key, canvas.toDataURL("image/png"));
    if (rasterCache.size > 24)
      rasterCache.delete(rasterCache.keys().next().value);
  }
  const image = document.createElementNS(NS, "image"),
    r = refined.input.region;
  for (const prop of ["x", "y", "width", "height"])
    image.setAttribute(prop, r[prop]);
  image.setAttribute("href", rasterCache.get(key));
  image.setAttribute("preserveAspectRatio", "none");
  return image;
}
function drawMasks() {
  const overlay = $("candidate-overlay");
  overlay.replaceChildren();
  overlay.style.visibility = state.hidden ? "hidden" : "visible";
  if (!state.run) return;
  state.run.candidates.forEach((c, i) => {
    if (i >= 3 && c.id !== state.selected) return;
    const active = c.id === state.selected ? " active" : "";
    if ($("rf-layer").checked)
      overlay.append(svgPolygon(c.polygon, "candidate-mask" + active));
    if ($("sam-layer").checked) {
      const refined = state.refined[c.id];
      if (refined?.rle) overlay.append(svgRaster(refined));
      else
        for (const polygon of refined?.polygons || [])
          overlay.append(svgPolygon(polygon, "sam3-mask" + active));
    }
    const b = bounds(c.polygon),
      text = document.createElementNS(NS, "text");
    text.setAttribute("x", b.x);
    text.setAttribute("y", b.y - 8);
    text.setAttribute("class", "candidate-number");
    text.textContent = String(i + 1).padStart(2, "0");
    overlay.append(text);
  });
  scaleLabels();
  $("image-stamp").textContent =
    `${state.restored ? "SAVED" : "LIVE"} · ${state.run.status.toUpperCase()} · ${state.run.completed}/${state.run.total} TILES`;
}
function scaleLabels() {
  for (const text of $("candidate-overlay").querySelectorAll("text")) {
    text.style.fontSize = `${14 / viewer.zoom}px`;
    text.style.strokeWidth = `${3 / viewer.zoom}px`;
  }
}
function renderResults() {
  const items = state.run?.candidates || [];
  $("results-area").hidden = !items.length;
  $("results-count").textContent = `${reviewProgress(items, state.reviews)} of ${items.length} reviewed`;
  $("other-regions").hidden = items.length <= 3;
  $("other-regions-count").textContent = String(Math.max(0, items.length - 3));
  if (items.findIndex((candidate) => candidate.id === state.selected) >= 3)
    $("other-regions").open = true;
  $("results-list").replaceChildren();
  $("other-results-list").replaceChildren();
  items.forEach((c, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "result-card" + (c.id === state.selected ? " active" : "");
    button.setAttribute("aria-pressed", String(c.id === state.selected));
    const number = document.createElement("span");
    number.className = "index";
    number.textContent = i + 1;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `Shape ${String(i + 1).padStart(2, "0")}`;
    const small = document.createElement("small");
    small.textContent = c.clipped
      ? "Touches a tile boundary"
      : "RF-DETR proposal";
    name.append(small);
    const tag = document.createElement("span");
    tag.className = "verdict";
    tag.textContent = isReviewed(state.reviews, c.id)
      ? state.reviews[c.id].decision
      : "Not reviewed";
    button.append(number, name, tag);
    button.addEventListener("click", () => {
      state.selected = c.id;
      drawMasks();
      renderResults();
      void showDetail({ focus: true });
      void persist();
    });
    $(i < 3 ? "results-list" : "other-results-list").append(button);
  });
}
async function showDetail({ focus = false } = {}) {
  const candidate = selected(),
    token = ++state.detailToken;
  state.worker?.terminate();
  if (!candidate) {
    $("candidate-detail").hidden = true;
    return;
  }
  state.detail = null;
  $("candidate-detail").hidden = false;
  $("detail-name").textContent =
    `SHAPE ${String(state.run.candidates.indexOf(candidate) + 1).padStart(2, "0")}`;
  $("detail-verdict").textContent =
    isReviewed(state.reviews, candidate.id)
      ? state.reviews[candidate.id].decision
      : "Not reviewed";
  $("detail-explanation").textContent =
    "Inspect the source and surrounding terrain. A fuller outline is still a proposal.";
  for (const button of $("review-buttons").querySelectorAll("button"))
    button.setAttribute(
      "aria-pressed",
      String(
        state.reviews[candidate.id]?.decision === button.dataset.decision,
      ),
    );
  $("clear-review").disabled = !isReviewed(state.reviews, candidate.id);
  $("next-unreviewed").disabled = !nextUnreviewed(
    state.run.candidates, state.reviews, candidate.id,
  );
  $("next-unreviewed").textContent = reviewProgress(state.run.candidates, state.reviews) === state.run.candidates.length
    ? "All proposals reviewed"
    : "Next unreviewed →";
  if (focus) {
    $("candidate-detail").focus({ preventScroll: true });
    $("candidate-detail").scrollIntoView({ block: "start" });
  }
  $("fringe-status").textContent = "";
  $("evidence-caption").textContent = "Loading native context…";
  updateControls();
  const region = candidateRegion(
    candidate,
    state.source,
    Number($("context-size").value),
  );
  try {
    const bitmap = await createImageBitmap(await sourceRegion(region, 1024));
    if (token !== state.detailToken) {
      bitmap.close();
      return;
    }
    const off = document.createElement("canvas");
    off.width = bitmap.width;
    off.height = bitmap.height;
    off.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    state.detail = { candidateId: candidate.id, region, canvas: off };
    $("evidence-caption").textContent =
      `${region.width} × ${region.height} source pixels${region.width > 1024 || region.height > 1024 ? " · reduced context preview; original preserved" : " · native context"} · edits apply to this region`;
    drawEvidence();
    if (state.fringes[candidate.id])
      $("fringe-status").textContent =
        state.fringes[candidate.id].warnings.join(" · ") ||
        "Experimental connected dark signal; inspect the extent.";
  } catch (error) {
    if (token === state.detailToken)
      $("evidence-caption").textContent = error.message;
  }
}
function drawEvidence() {
  const detail = state.detail;
  if (!detail) return;
  const canvas = $("source-evidence");
  canvas.width = detail.canvas.width;
  canvas.height = detail.canvas.height;
  const c = canvas.getContext("2d");
  c.drawImage(detail.canvas, 0, 0);
  const f = state.fringes[detail.candidateId];
  if (
    f &&
    !f.hidden &&
    state.features?.experimental_fringe !== false &&
    JSON.stringify(f.region) === JSON.stringify(detail.region)
  ) {
    const layer = document.createElement("canvas");
    layer.width = f.width;
    layer.height = f.height;
    const ctx = layer.getContext("2d"),
      pixels = ctx.createImageData(f.width, f.height);
    for (let i = 0; i < f.alpha.length; i++) {
      pixels.data[i * 4] = 244;
      pixels.data[i * 4 + 1] = 202;
      pixels.data[i * 4 + 2] = 121;
      pixels.data[i * 4 + 3] = f.alpha[i] * 0.6;
    }
    ctx.putImageData(pixels, 0, 0);
    c.drawImage(layer, 0, 0, canvas.width, canvas.height);
  }
  for (const p of state.edits[detail.candidateId] || []) {
    c.beginPath();
    c.arc(
      ((p.x - detail.region.x) * canvas.width) / detail.region.width,
      ((p.y - detail.region.y) * canvas.height) / detail.region.height,
      5,
      0,
      Math.PI * 2,
    );
    c.fillStyle = p.label === "include" ? "#9ed9aa" : "#ff9c9c";
    c.fill();
    c.strokeStyle = "#101719";
    c.lineWidth = 2;
    c.stroke();
  }
}
function renderRun() {
  if (!state.run) return;
  if (!state.run.candidates.some((c) => c.id === state.selected))
    state.selected = state.run.candidates[0]?.id || null;
  drawMasks();
  renderResults();
  document.body.classList.toggle("has-results", state.run.candidates.length > 0);
  $("roboflow-line").textContent =
    `${state.run.candidates.length} proposed regions from ${state.run.completed}/${state.run.total} completed tiles. ${state.run.status === "complete" ? "Requested area scanned." : "Coverage is incomplete."} Run scale: ${state.run.scale === 1 ? "native pixels" : `${state.run.scale}× source reduction`}.`;
  $("sam-line").textContent =
    `${state.run?.candidates.filter((c) => state.refined[c.id]).length || 0} regions traced from native crops.`;
  $("footer-status").textContent =
    `${state.restored ? "Saved result" : "Inference"} · ${new Date(state.run.created_at).toLocaleString()} · ${state.run.status}`;
  $("retry-scan").hidden = ![
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ].includes(state.run.status);
  void showDetail();
  updateControls();
}
async function pollJob(jobId, onUpdate, generation) {
  for (;;) {
    const job = await api(`/api/scout/jobs/${jobId}`);
    if (generation !== state.generation) return null;
    state.remaining = job.daily_remaining;
    await onUpdate(job);
    if (!["queued", "running"].includes(job.status) && !job.in_flight)
      return job;
    await wait(750);
  }
}
async function startScan(retry = false) {
  if (!state.access || state.busy || state.refining) return;
  const generation = state.generation;
  const previous = state.run,
    prior = retry ? state.job || state.run : null;
  state.busy = true;
  message("");
  status("Scanning", true);
  $("cancel-scan").hidden = false;
  $("scan-progress").hidden = false;
  $("scan-progress").value = 0;
  updateControls();
  try {
    const reconnect = prior && ["queued", "running"].includes(prior.status);
    const config = {
      id: crypto.randomUUID(),
      source_id: state.source.id,
      kind: "scan",
      region: prior?.region || scanRegion(),
      scale: prior?.scale || Number($("scan-scale").value),
      retry_of: prior?.id,
    };
    // Save the request ID before dispatch. Reconnection can safely resubmit this
    // exact ID if the POST response was lost after the server accepted the job.
    state.job = reconnect
      ? prior
      : {
          ...config,
          status: "queued",
          submission: config,
          completed: 0,
          total: state.estimate,
          tiles: [],
        };
    $("cancel-scan").disabled = true;
    await persist();
    const job = reconnect
      ? prior.submission
        ? await post("/api/scout/jobs", prior.submission)
        : await api(`/api/scout/jobs/${prior.id}`)
      : await post("/api/scout/jobs", config);
    state.job = job;
    $("cancel-scan").disabled = false;
    await persist();
    await pollJob(
      job.id,
      async (result) => {
        state.job = result;
        $("scan-progress").max = result.total;
        $("scan-progress").value = result.completed;
        $("roboflow-line").textContent =
          `${result.completed}/${result.total} tiles complete · ${result.status}`;
        if (result.completed || result.status === "complete") {
          state.run = result;
          state.restored = false;
          renderRun();
        }
        await persist();
      },
      generation,
    );
    if (generation !== state.generation) return;
    const result = state.job;
    if (!result.completed && result.status !== "complete") {
      state.run = previous;
      message(
        `Scan ${result.status}. ${result.tiles.find((t) => t.error)?.error || "No completed tiles."}${previous ? " Previous results retained." : ""}`,
      );
    }
    $("retry-scan").textContent = "Retry unfinished tiles";
    $("retry-scan").hidden = ![
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(result.status);
    status(
      result.status === "complete"
        ? "Ready to inspect"
        : `Scan ${result.status}`,
    );
  } catch (error) {
    if (generation === state.generation) {
      if (error.terminal && state.job?.submission) state.job = null;
      message(
        `${error.message}${state.job && ["queued", "running"].includes(state.job.status) ? " The server may still be scanning. Reconnect to recover its result." : ""}`,
      );
      $("retry-scan").textContent = "Reconnect scan";
      $("retry-scan").hidden = !state.job;
      status("Scan interrupted");
    }
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      $("cancel-scan").hidden = true;
      updateEstimate();
      await persist();
    }
  }
}
async function refineSelected() {
  const candidate = selected();
  if (!candidate || state.busy || state.refining) return;
  const generation = state.generation,
    region = candidateRegion(
      candidate,
      state.source,
      Number($("context-size").value),
    );
  const b = bounds(candidate.polygon);
  state.refining = true;
  updateControls();
  $("refine-status").hidden = false;
  $("refine-status").textContent =
    "Tracing the selected region from its native crop…";
  try {
    const config = {
      id: crypto.randomUUID(),
      source_id: state.source.id,
      kind: "refine",
      region,
      scale: 1,
      box: {
        x: b.x + b.width / 2 - region.x,
        y: b.y + b.height / 2 - region.y,
        width: b.width * 1.8,
        height: b.height * 1.8,
      },
    };
    state.pendingRefine ||= {
      job_id: config.id,
      candidate_id: candidate.id,
      submission: config,
    };
    await persist();
    if (state.pendingRefine.submission) {
      await post("/api/scout/jobs", state.pendingRefine.submission);
      delete state.pendingRefine.submission;
      await persist();
    }
    await finishRefine(
      state.pendingRefine.job_id,
      state.pendingRefine.candidate_id,
      generation,
    );
    state.pendingRefine = null;
  } catch (error) {
    if (error.terminal) state.pendingRefine = null;
    if (generation === state.generation)
      $("refine-status").textContent = error.message;
  } finally {
    if (generation === state.generation) {
      state.refining = false;
      updateControls();
      await persist();
    }
  }
}
async function finishRefine(jobId, candidateId, generation) {
  const job = await pollJob(jobId, () => {}, generation);
  if (!job) return;
  if (job.status !== "complete") {
    const error = new Error(job.tiles[0].error || `Trace ${job.status}`);
    error.terminal = true;
    throw error;
  }
  const tile = job.tiles[0],
    mask = tile.response.masks[0];
  const polygons = (mask.polygons || (mask.polygon ? [mask.polygon] : [])).map(
    (p) => mapPoints(p, tile, tile.input.output),
  );
  state.refined[candidateId] = {
    polygons,
    rle: mask.rle || null,
    mask_format: mask.format,
    holes_preserved: mask.holes_preserved,
    job_id: job.id,
    created_at: job.created_at,
    input: tile.input,
    raw_response: tile.response,
  };
  $("refine-status").textContent =
    mask.rle && mask.area
      ? "Native raster traced · holes and components retained · proposed extent, not confirmation."
      : polygons.length
        ? `Native crop traced · ${polygons.length} component${polygons.length === 1 ? "" : "s"} · proposed extent, not confirmation.`
        : "SAM returned no usable mask. The detector proposal is unchanged.";
  drawMasks();
  $("sam-line").textContent =
    `${state.run?.candidates.filter((c) => state.refined[c.id]).length || 0} regions traced from native crops.`;
}
function estimate() {
  const detail = state.detail,
    candidate = selected();
  if (!detail || !candidate) return;
  state.worker?.terminate();
  const worker = new Worker("/fringe-worker.js", { type: "module" });
  state.worker = worker;
  const token = state.detailToken;
  const grid = document.createElement("canvas");
  const scale = Math.min(
    1,
    512 / Math.max(detail.canvas.width, detail.canvas.height),
  );
  grid.width = Math.round(detail.canvas.width * scale);
  grid.height = Math.round(detail.canvas.height * scale);
  const c = grid.getContext("2d");
  c.drawImage(detail.canvas, 0, 0, grid.width, grid.height);
  const data = c.getImageData(0, 0, grid.width, grid.height).data,
    gray = new Uint8Array(grid.width * grid.height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = Math.round(
      0.2126 * data[i * 4] +
        0.7152 * data[i * 4 + 1] +
        0.0722 * data[i * 4 + 2],
    );
  const transform = (p) => [
    ((p[0] - detail.region.x) * grid.width) / detail.region.width,
    ((p[1] - detail.region.y) * grid.height) / detail.region.height,
  ];
  const points = (state.edits[candidate.id] || []).map((p) => {
    const [x, y] = transform([p.x, p.y]);
    return { x, y, label: p.label };
  });
  $("fringe-status").textContent = "Estimating connected dark signal…";
  worker.onmessage = async (event) => {
    worker.terminate();
    if (token !== state.detailToken) return;
    if (event.data.error) {
      $("fringe-status").textContent = event.data.error;
      return;
    }
    state.fringes[candidate.id] = {
      ...event.data,
      baseline:
        state.fringes[candidate.id]?.baseline ||
        ((state.edits[candidate.id] || []).length
          ? null
          : { ...event.data, region: detail.region }),
      region: detail.region,
      created_at: new Date().toISOString(),
      edits: structuredClone(state.edits[candidate.id] || []),
    };
    $("fringe-status").textContent =
      `${grid.width} × ${grid.height} analysis grid · ${event.data.warnings.join(" · ") || "Inspect this experimental extent; the detector supplied its initial seeds."}`;
    drawEvidence();
    await persist();
  };
  worker.onerror = () => {
    $("fringe-status").textContent = "The fringe estimate could not finish.";
    worker.terminate();
  };
  worker.postMessage(
    {
      gray,
      width: grid.width,
      height: grid.height,
      polygon: candidate.polygon.map(transform),
      points,
      sensitivity: Number($("fringe-sensitivity").value) / 100,
    },
    [gray.buffer],
  );
}
function rle(values) {
  const runs = [];
  let previous = -1;
  for (const value of values) {
    if (value === previous) runs[runs.length - 1][1]++;
    else {
      runs.push([value, 1]);
      previous = value;
    }
  }
  return runs;
}
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function restore(sourceId) {
  let saved;
  try {
    saved = await loadSession(sourceId);
  } catch {
    return false;
  }
  if (
    !saved ||
    saved.version !== 2 ||
    saved.pipeline !== "native-v1" ||
    !saved.source
  )
    return false;
  try {
    const source = await api(`/api/scout/sources/${saved.source.id}`);
    if (source.original_sha256 !== saved.source.original_sha256) {
      message(
        "The saved source changed. Choose the source again before scanning.",
      );
      return true;
    }
    await setSource(source, { remember: false });
    if (
      saved.model !== state.model ||
      source.display_sha256 !== saved.source.display_sha256 ||
      JSON.stringify(source.normalization) !==
        JSON.stringify(saved.source.normalization)
    ) {
      message(
        "The model or preprocessing changed. Source restored; start a fresh scan.",
      );
      return true;
    }
    state.run = saved.run;
    state.job = saved.job;
    state.selected = saved.selected;
    state.refined = saved.refined || {};
    state.reviews = saved.reviews || {};
    state.edits = saved.edits || {};
    state.fringes = saved.fringes || {};
    state.restored = true;
    state.pendingRefine = saved.pendingRefine;
    renderRun();
    status(state.run ? "Saved result" : "Ready to scan");
    if (
      state.job &&
      ["queued", "running"].includes(state.job.status) &&
      state.access
    ) {
      state.busy = true;
      updateControls();
      $("cancel-scan").hidden = false;
      $("scan-progress").hidden = false;
      if (state.job.submission)
        state.job = await post("/api/scout/jobs", state.job.submission);
      await pollJob(
        state.job.id,
        async (job) => {
          state.job = job;
          $("scan-progress").max = job.total;
          $("scan-progress").value = job.completed;
          if (job.completed || job.status === "complete") state.run = job;
          renderRun();
          $("retry-scan").hidden=!["partial","failed","cancelled","interrupted"].includes(job.status);
          $("retry-scan").textContent='Retry unfinished tiles';
          if(job.tiles.some(t=>t.status==='unknown'))message('Some dispatched calls have unknown outcomes. Retrying them may create another provider charge; completed tiles will be reused.');
          await persist();
        },
        state.generation,
      );
      state.busy = false;
      $("cancel-scan").hidden = true;
      updateControls();
      status(state.job.status);
    }
    if (state.pendingRefine && state.access) {
      state.refining = true;
      updateControls();
      try {
        if (state.pendingRefine.submission) {
          await post("/api/scout/jobs", state.pendingRefine.submission);
          delete state.pendingRefine.submission;
        }
        await finishRefine(
          state.pendingRefine.job_id,
          state.pendingRefine.candidate_id,
          state.generation,
        );
        state.pendingRefine = null;
      } finally {
        state.refining = false;
        updateControls();
        await persist();
      }
    }
    return true;
  } catch (error) {
    state.busy = false;
    state.refining = false;
    $("cancel-scan").hidden = true;
    updateControls();
    $("retry-scan").hidden = !state.job;
    $("retry-scan").textContent = "Reconnect scan";
    message(
      `Saved session needs attention: ${error.message}. No new inference was started.`,
    );
    status("Saved session needs attention");
    return true;
  }
}
async function checkAccess() {
  const data = await api("/api/status");
  state.access = data.access_granted;
  state.remaining = data.daily_remaining;
  state.model = data.model_id;
  state.features = data.features || {};
  document.querySelector(".fringe-controls").hidden =
    state.features.experimental_fringe === false;
  $("access-panel").hidden = state.access;
  $("orbit-button").hidden = !data.full_observation_available;
  updateControls();
  return state.access && data.scout_ready;
}
async function init() {
  for (const label of document.querySelectorAll('.upload-link[role="button"]'))
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        label.querySelector("input").click();
      }
    });

  try {
    state.code = sessionStorage.getItem("mars-fan-scout-access") || "";
  } catch {}
  $("fit-view").onclick = () => viewer.fit();
  $("native-view").onclick = () => viewer.native();
  $("zoom-in").onclick = () => viewer.scaleAt(1.4);
  $("zoom-out").onclick = () => viewer.scaleAt(1 / 1.4);
  $("hide-overlays").onclick = () => {
    state.hidden = !state.hidden;
    $("hide-overlays").setAttribute("aria-pressed", String(state.hidden));
    $("hide-overlays").textContent = state.hidden
      ? "Show overlays"
      : "Hide overlays";
    drawMasks();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && e.target === $("image-frame")) {
      e.preventDefault();
      $("candidate-overlay").style.visibility = "hidden";
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " ") drawMasks();
  });
  for (const id of ["rf-layer", "sam-layer", "fill-opacity"])
    $(id).addEventListener("input", drawMasks);
  $("view-contrast").oninput = () => {
    $("mars-image").style.filter = `contrast(${$("view-contrast").value}%)`;
  };
  $("scan-area").onchange = updateEstimate;
  $("scan-scale").onchange = updateEstimate;
  $("scan-button").onclick = () => startScan();
  $("retry-scan").onclick = () => startScan(true);
  $("cancel-scan").onclick = async () => {
    if (!state.job) return;
    try {
      state.job = await post(`/api/scout/jobs/${state.job.id}/cancel`, {});
    } catch (error) {
      message(error.message);
    }
  };
  $("refine-button").onclick = refineSelected;
  $("context-size").onchange = showDetail;
  $("inspect-native").onclick = () => {
    const c = selected();
    if (c) {
      const b = bounds(c.polygon);
      viewer.native({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      if (window.matchMedia("(max-width:1050px)").matches)
        $("image-frame").scrollIntoView({ block: "center", behavior: "auto" });
    }
  };
  $("review-buttons").onclick = (event) => {
    const decision = event.target.dataset.decision,
      c = selected();
    if (!decision || !c) return;
    setReview(state.reviews, c.id, decision, state.source.original_sha256, new Date().toISOString());
    renderResults();
    $("detail-verdict").textContent = decision;
    for (const b of $("review-buttons").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.decision === decision));
    $("clear-review").disabled = false;
    $("next-unreviewed").disabled = !nextUnreviewed(state.run.candidates, state.reviews, c.id);
    $("next-unreviewed").textContent = reviewProgress(state.run.candidates, state.reviews) === state.run.candidates.length
      ? "All proposals reviewed" : "Next unreviewed →";
    void persist();
  };
  $("clear-review").onclick = () => {
    const c = selected();
    if (!c || !isReviewed(state.reviews, c.id)) return;
    setReview(state.reviews, c.id, "pending");
    renderResults();
    $("detail-verdict").textContent = "Not reviewed";
    for (const b of $("review-buttons").querySelectorAll("button"))
      b.setAttribute("aria-pressed", "false");
    $("clear-review").disabled = true;
    $("next-unreviewed").disabled = !nextUnreviewed(state.run.candidates, state.reviews, c.id);
    $("next-unreviewed").textContent = "Next unreviewed →";
    void persist();
  };
  $("next-unreviewed").onclick = () => {
    const next = nextUnreviewed(state.run?.candidates || [], state.reviews, state.selected);
    if (!next) return;
    state.selected = next.id;
    drawMasks();
    renderResults();
    void showDetail({ focus: true });
    void persist();
  };
  $("fringe-button").onclick = estimate;
  let sensitivityTimer;
  $("fringe-sensitivity").oninput = () => {
    clearTimeout(sensitivityTimer);
    sensitivityTimer = setTimeout(estimate, 180);
  };
  $("fringe-clear").onclick = () => {
    if (selected() && state.fringes[selected().id])
      state.fringes[selected().id].hidden = true;
    drawEvidence();
    $("fringe-status").textContent = "Fringe hidden.";
    void persist();
  };
  $("source-evidence").onclick = (event) => {
    const detail = state.detail,
      mode = $("edit-mode").value;
    if (!detail || mode === "inspect") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x:
        detail.region.x +
        ((event.clientX - rect.left) / rect.width) * detail.region.width,
      y:
        detail.region.y +
        ((event.clientY - rect.top) / rect.height) * detail.region.height,
      label: mode,
    };
    (state.edits[detail.candidateId] ||= []).push(point);
    drawEvidence();
    estimate();
  };
  $("undo-edit").onclick = () => {
    if (selected()) {
      state.edits[selected().id]?.pop();
      estimate();
    }
  };
  $("reset-edits").onclick = () => {
    if (selected()) {
      state.edits[selected().id] = [];
      estimate();
    }
  };
  $("sample-button").onclick = async () => {
    try {
      await persist();
      if (!(await restore("sample")))
        await setSource(await api("/api/scout/sources/sample"));
      await persist();
    } catch (error) {
      message(error.message);
    }
  };
  $("orbit-button").onclick = async () => {
    try {
      await setSource(await api("/api/scout/sources/orbit"));
      $("scan-area").value = "view";
      updateEstimate();
      await persist();
    } catch (error) {
      message(error.message);
    }
  };
  $("image-input").onchange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) {
      message("Choose an image under 32 MiB.");
      return;
    }
    try {
      state.uploading = true;
      updateControls();
      status("Preserving original", true);
      await setSource(
        await api("/api/scout/sources", {
          method: "POST",
          headers: {
            "content-type": file.type,
            "x-source-name": encodeURIComponent(file.name),
          },
          body: file,
        }),
      );
      await persist();
    } catch (error) {
      message(error.message);
      status("Upload interrupted");
    } finally {
      state.uploading = false;
      updateControls();
    }
  };
  $("download-source").onclick = async () => {
    try {
      const original = await blob(state.source.original);
      download(
        original,
        `${state.source.id}-original.${state.source.original_format}`,
        "application/octet-stream",
      );
    } catch (error) {
      message(error.message);
    }
  };
  $("review-input").onchange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (state.busy || state.refining)
        throw new Error("Finish or cancel the active request before importing");
      if (file.size > 32 * 1024 ** 2)
        throw new Error("Review JSON exceeds 32 MiB");
      const record = JSON.parse(await file.text());
      if (
        record.format !== "mars-native-review-v1" ||
        !record.source ||
        !record.run ||
        !Array.isArray(record.run.candidates)
      )
        throw new Error("Unsupported review file");
      const source = await api(`/api/scout/sources/${record.source.id}`);
      if (
        source.original_sha256 !== record.source.original_sha256 ||
        record.run.source_sha256 !== source.original_sha256 ||
        record.run.model_id !== state.model ||
        JSON.stringify(source.normalization) !==
          JSON.stringify(record.source.normalization)
      )
        throw new Error(
          "Review source, model or preprocessing does not match this deployment",
        );
      for (const c of record.run.candidates)
        if (
          !c.id ||
          !Array.isArray(c.polygon) ||
          c.polygon.length < 3 ||
          c.polygon.length > 10000 ||
          !c.polygon.every(
            (p) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every(Number.isFinite) &&
              p[0] >= 0 &&
              p[1] >= 0 &&
              p[0] <= source.width &&
              p[1] <= source.height,
          )
        )
          throw new Error("Invalid candidate geometry");
      for (const refinement of Object.values(record.refinements || {}))
        if (refinement.rle) decodeRLE(refinement.rle, 2048 ** 2);
      const unpack = (f) => {
        if (
          !Number.isInteger(f.width) ||
          !Number.isInteger(f.height) ||
          f.width < 1 ||
          f.height < 1 ||
          f.width * f.height > 512 ** 2 ||
          !Array.isArray(f.alpha_rle)
        )
          throw new Error("Invalid fringe grid");
        const alpha = new Uint8Array(f.width * f.height);
        let offset = 0;
        for (const [value, count] of f.alpha_rle) {
          if (
            !Number.isInteger(value) ||
            value < 0 ||
            value > 255 ||
            !Number.isInteger(count) ||
            count < 1 ||
            offset + count > alpha.length
          )
            throw new Error("Invalid fringe runs");
          alpha.fill(value, offset, offset + count);
          offset += count;
        }
        if (offset !== alpha.length) throw new Error("Incomplete fringe field");
        return {
          ...f,
          alpha,
          baseline: f.baseline ? unpack(f.baseline) : null,
        };
      };
      const fringes = Object.fromEntries(
        Object.entries(record.fringes || {}).map(([id, f]) => [id, unpack(f)]),
      );
      await setSource(source);
      state.run = record.run;
      // Imported files are evidence, never permission to dispatch a pending job.
      state.job = ["queued", "running"].includes(
        (record.latest_job || record.run).status,
      )
        ? null
        : record.latest_job || record.run;
      state.selected = record.run.candidates[0]?.id || null;
      state.refined = record.refinements || {};
      state.reviews = record.reviews || {};
      state.edits = record.edits || {};
      state.fringes = fringes;
      state.restored = true;
      renderRun();
      status("Imported saved result");
      await persist();
    } catch (error) {
      message(error.message);
    }
  };
  $("export-review").onclick = () => {
    const fringes = Object.fromEntries(
      Object.entries(state.fringes).map(([id, f]) => [
        id,
        {
          ...f,
          alpha: undefined,
          baseline: f.baseline
            ? {
                ...f.baseline,
                alpha: undefined,
                alpha_rle: rle(f.baseline.alpha),
              }
            : null,
          alpha_rle: rle(f.alpha),
          encoding: "row-major [uint8 value,count] runs",
        },
      ]),
    );
    const exported = {
      format: "mars-native-review-v1",
      exported_at: new Date().toISOString(),
      source: state.source,
      run: state.run,
      latest_job: state.job,
      refinements: state.refined,
      reviews: state.reviews,
      edits: state.edits,
      fringes,
      notes: [
        "Coordinates are image-relative pixel edges, not georeferenced.",
        "Fringe values are relative contrast, not probability or physical dust density.",
        "Model proposals and human decisions are separate.",
      ],
    };
    download(
      JSON.stringify(exported, null, 2),
      "mars-review.json",
      "application/json",
    );
  };
  $("access-form").onsubmit = async (event) => {
    event.preventDefault();
    state.code = $("access-code").value.trim();
    $("access-error").hidden = true;
    try {
      if (await checkAccess()) {
        try {
          sessionStorage.setItem("mars-fan-scout-access", state.code);
        } catch {}
        if (!(await restore()) && !state.run) await startScan();
      } else {
        $("access-error").hidden = false;
        $("access-error").textContent = "That code did not unlock scanning.";
      }
    } catch (error) {
      message(error.message);
    }
  };
  try {
    await setSource(await api("/api/scout/sources/sample"));
    const ready = await checkAccess();
    const restored = await restore();
    if (ready && !restored) {
      $("scan-area").value = "full";
      updateEstimate();
      await startScan();
    }
  } catch (error) {
    message(error.message);
    status("Needs attention");
  }
}
init();
