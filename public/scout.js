import { polygonAxis, directionEstimate, circularSummary, compassPoint } from "./fan-direction.mjs";

const NS = "http://www.w3.org/2000/svg";
const SAMPLE = {
  title:"Spiders in Manhattan",
  observation:"ESP_082142_0935",
  captured:"2024-02-03",
  source:"https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935",
  crop_raw_pixels:[2304,6976,4352,9024],
  source_scale_m_per_pixel:0.5,
  image_path:"/images/scout-2024-dev.jpg",
  pixel_scale_m:1,
  north_angle_deg:99.6,
  north_reference:"HiRISE RED PDS polar-stereographic map label, calculated at crop center",
  sample:true
};
const state = {
  canvas:null, imageURL:null, file:null, meta:null, hash:null, predictions:[],
  selected:null, threshold:.35, modelId:null, modelReady:false,
  scanning:false, scanToken:0, controller:null, thumbnailCache:new Map(), hasRevealed:false
};
const $ = id => document.getElementById(id);
const number = value => Number(value).toLocaleString();

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.hidden = true, 5000);
}

function setStep(step) {
  const order = ["source","scan","review"];
  order.forEach((name, index) => {
    $("step-" + name).classList.toggle("active", name === step);
    $("step-" + name).classList.toggle("done", index < order.indexOf(step));
  });
}

async function modelStatus() {
  try {
    const response = await fetch("/api/status");
    const result = await response.json();
    state.modelReady = !!result.scout_ready;
    state.modelId = result.model_id;
    $("status-text").textContent = result.scout_ready ? "MODEL CONNECTED" : (result.mode === "recorded" ? "LIVE MODEL REQUIRED" : "MODEL UNAVAILABLE");
    $("model-status").classList.toggle("ready", state.modelReady);
  } catch (_) {
    state.modelReady = false;
    $("status-text").textContent = "MODEL UNAVAILABLE";
  }
  updateScanButton();
}

async function loadEvaluation() {
  try {
    const response=await fetch("/api/scout/evaluation");
    if (!response.ok) return;
    const data=await response.json();
    if (data.model_id!==state.modelId) return;
    const considered=data.matched_deposits+data.unmatched_predictions;
    $("field-check-ratio").textContent=data.matched_deposits+"/"+considered;
    $("field-check-detail").textContent=data.matched_deposits+"/"+data.visible_clear_deposits+" clear deposits surfaced across "+data.sample_crops+" crops; "+data.ignored_predictions+" edge or ambiguous predictions excluded.";
    $("field-check-method").textContent=data.method+" This is a small, non-expert visual check, not a scientific accuracy guarantee. Source: "+data.observation+". Threshold: "+Math.round(data.threshold*100)+"%.";
    $("field-check").hidden=false;
  } catch (_) {}
}

function updateScanButton() {
  const button = $("scan-button");
  button.disabled = !state.canvas || !state.modelReady || state.scanning;
  button.classList.toggle("busy", state.scanning);
  button.innerHTML = (state.scanning ? "Scanning Mars…" : !state.canvas ? "Load an image first" : !state.modelReady ? "Connect Roboflow" : state.predictions.length ? "Scan again" : "Scan with Roboflow") + ' <span aria-hidden="true">↗</span>';
}

function imageDigest(file, scale) {
  return file.arrayBuffer().then(async buffer => {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,"0")).join("") + ":" + scale;
  });
}

function canvasBlob(canvas, quality=.91) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare image")), "image/jpeg", quality));
}

async function loadFile(file, meta={}) {
  if (!["image/jpeg","image/png","image/webp"].includes(file.type)) throw new Error("Choose a JPG, PNG, or WebP image.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Image must be under 8 MB.");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width > 3072 || bitmap.height > 3072 || bitmap.width < 256 || bitmap.height < 256) {
    bitmap.close();
    throw new Error("Choose a crop between 256 and 3072 pixels on each side.");
  }
  if (state.controller) state.controller.abort();
  state.scanToken++;
  const chosenScale = meta.sample ? 1 : $("source-scale").value;
  const factor = chosenScale === "unknown" ? 1 : Number(chosenScale);
  const width = Math.round(bitmap.width * factor), height = Math.round(bitmap.height * factor);
  if (width < 256 || height < 256) {
    bitmap.close();
    throw new Error("This crop becomes too small at the selected pixel scale. Choose a larger crop.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", {willReadFrequently:true}).drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const normalized = await canvasBlob(canvas);
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  state.imageURL = URL.createObjectURL(normalized);
  state.canvas = canvas;
  state.file = file;
  state.meta = { ...meta, title:meta.title || file.name.replace(/\.[^.]+$/, ""), observation:meta.observation || null, pixel_scale_m:chosenScale === "unknown" ? null : 1, source_scale_m_per_pixel:meta.source_scale_m_per_pixel ?? (chosenScale === "unknown" ? null : Number(chosenScale)), original_width:Math.round(width/factor), original_height:Math.round(height/factor), north_angle_deg:Number.isFinite(meta.north_angle_deg)?meta.north_angle_deg:null, north_reference:meta.north_reference||null };
  state.hash = await imageDigest(file, chosenScale);
  if (!meta.sample && meta.north_angle_deg === undefined) {
    try {
      const stored = localStorage.getItem("mars-fan-scout-north:" + state.hash);
      const savedNorth = Number(stored);
      if (stored !== null && Number.isFinite(savedNorth) && savedNorth >= 0 && savedNorth < 360) {
        state.meta.north_angle_deg = savedNorth;
        state.meta.north_reference = "User-supplied orientation, not verified by the app";
      }
    } catch (_) {}
  }
  state.predictions = [];
  state.selected = null;
  state.hasRevealed = false;
  state.thumbnailCache.clear();
  state.scanning = false;
  $("image-wrap").hidden = false;
  $("empty-state").hidden = true;
  $("field-image").src = state.imageURL;
  $("field-image").alt = (meta.sample ? "NASA HiRISE crop from " + meta.observation : "Uploaded image " + file.name) + " awaiting model review";
  $("image-wrap").style.setProperty("--image-ratio", width + "/" + height);
  $("mask-overlay").setAttribute("viewBox", "0 0 " + width + " " + height);
  $("direction-overlay").setAttribute("viewBox", "0 0 " + width + " " + height);
  $("tile-overlay").setAttribute("viewBox", "0 0 " + width + " " + height);
  $("image-title").textContent = state.meta.title;
  $("image-id").textContent = state.meta.observation || "USER IMAGE";
  $("image-eyebrow").innerHTML = (meta.sample ? "HIRISE <span class='slash'>/</span> NEWER OBSERVATION" : "USER IMAGE <span class='slash'>/</span> SOURCE UNVERIFIED");
  $("image-resolution").textContent = width + " × " + height + " PX";
  $("image-scale").textContent = state.meta.pixel_scale_m ? "EFFECTIVE 1 M / PX" : "SCALE UNKNOWN";
  $("caption-right").textContent = meta.sample ? "IMAGE: NASA / JPL-CALTECH / UARIZONA" : "IMAGE: USER PROVIDED · SOURCE NOT VERIFIED";
  $("caption-left").textContent = meta.sample ? "2024 HiRISE crop · no Planet Four lookup" : "Predictions are valid only for comparable Mars polar imagery";
  $("north-angle").disabled=!!meta.sample;
  $("north-angle").value=state.meta.north_angle_deg ?? "";
  $("north-hint").textContent=meta.sample ? "North is derived from the HiRISE map projection at this crop's center (about 99.6° clockwise from image top)." : "For uploaded crops, supply north orientation to show compass bearings. Otherwise arrows stay image-relative.";
  $("image-top-label").textContent = "SOURCE PIXELS · NO MODEL OUTPUT";
  $("image-wrap").classList.remove("scanning");
  $("tile-overlay").replaceChildren();
  $("scan-progress").hidden = true;
  setStep("source");
  render();
  updateScanButton();
}

async function loadSample() {
  try {
    $("source-scale").value = "1";
    const response = await fetch(SAMPLE.image_path);
    if (!response.ok) throw new Error("The 2024 source crop is unavailable.");
    const blob = await response.blob();
    await loadFile(new File([blob], "ESP_082142_0935_crop.jpg", {type:"image/jpeg"}), SAMPLE);
  } catch (error) { toast(error.message); }
}

function starts(size, tile=1024, overlap=128) {
  if (size <= tile) return [0];
  const result = [0], stride = tile - overlap;
  while (result.at(-1) + tile < size) {
    const next = Math.min(size - tile, result.at(-1) + stride);
    if (next === result.at(-1)) break;
    result.push(next);
  }
  return result;
}

function tilesForCanvas(canvas) {
  const result = [];
  for (const y of starts(canvas.height)) for (const x of starts(canvas.width)) {
    result.push({x,y,width:Math.min(1024,canvas.width-x),height:Math.min(1024,canvas.height-y)});
  }
  return result;
}

function polygonArea(points) {
  let sum = 0;
  for (let i=0;i<points.length;i++) {
    const a=points[i], b=points[(i+1)%points.length];
    sum += a[0]*b[1]-b[0]*a[1];
  }
  return Math.abs(sum)/2;
}

function boxOf(points) {
  return {left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1]))};
}

function boxIoU(a,b) {
  const intersection=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const areaA=(a.right-a.left)*(a.bottom-a.top), areaB=(b.right-b.left)*(b.bottom-b.top);
  return intersection / Math.max(1,areaA+areaB-intersection);
}

function normalizePredictions(result,tile) {
  const imageWidth=Number(result.image?.width)||tile.width, imageHeight=Number(result.image?.height)||tile.height;
  return (Array.isArray(result.predictions)?result.predictions:[]).map(prediction => {
    const raw=Array.isArray(prediction.points)?prediction.points:(Array.isArray(prediction.polygon)?prediction.polygon:[]);
    const polygon=raw.map(point => Array.isArray(point)?point:[point.x,point.y]).map(point=>[Number(point[0])*tile.width/imageWidth+tile.x,Number(point[1])*tile.height/imageHeight+tile.y]).filter(point=>point.every(Number.isFinite));
    if (polygon.length<3 || Number(prediction.confidence)<.2) return null;
    const bounds=boxOf(polygon);
    return {polygon,bounds,center:[(bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2],area_px2:polygonArea(polygon),confidence:Number(prediction.confidence),decision:"pending",source_end:null,axis:polygonAxis(polygon),tile:[tile.x,tile.y]};
  }).filter(Boolean);
}

function mergePredictions(predictions) {
  const merged=[];
  for (const item of predictions.sort((a,b)=>b.confidence-a.confidence)) {
    const duplicate=merged.some(existing => {
      const distance=Math.hypot(existing.center[0]-item.center[0],existing.center[1]-item.center[1]);
      return boxIoU(existing.bounds,item.bounds)>.42 || (distance<18 && Math.max(existing.area_px2,item.area_px2)/Math.max(1,Math.min(existing.area_px2,item.area_px2))<3);
    });
    if (!duplicate) merged.push(item);
  }
  merged.forEach((item,index)=>item.id="RF-"+String(index+1).padStart(3,"0"));
  return merged;
}

function decisionKey() { return "mars-fan-scout-review:" + state.hash; }
function restoreDecisions() {
  try {
    const saved=JSON.parse(localStorage.getItem(decisionKey())||"[]");
    for (const candidate of state.predictions) {
      const match=saved.find(item=>Math.hypot(item.center[0]-candidate.center[0],item.center[1]-candidate.center[1])<16);
      if (match) {
        candidate.decision=match.decision;
        candidate.source_end=match.decision==="accepted" && candidate.axis?.usable && ["a","b"].includes(match.source_end) ? match.source_end : null;
      }
    }
  } catch (_) {}
}
function saveDecisions() {
  try {
    const saved=state.predictions.filter(item=>item.decision!=="pending").map(item=>({center:item.center,decision:item.decision,source_end:item.source_end}));
    localStorage.setItem(decisionKey(),JSON.stringify(saved));
  } catch (_) { toast("Browser storage is unavailable; export your review before leaving."); }
}

async function runScan() {
  if (!state.canvas || !state.modelReady || state.scanning) return;
  const token=++state.scanToken;
  const controller=new AbortController();
  state.controller=controller;
  state.scanning=true;
  state.predictions=[];
  state.selected=null;
  state.hasRevealed=false;
  state.thumbnailCache.clear();
  const tiles=tilesForCanvas(state.canvas);
  let next=0, completed=0, failures=0;
  const collected=[];
  $("image-wrap").classList.add("scanning");
  $("scan-progress").hidden=false;
  $("progress-fill").style.width="0%";
  $("progress-percent").textContent="0%";
  $("image-top-label").textContent="LIVE ROBOFLOW INFERENCE";
  $("review-intro").textContent="Roboflow is examining the image in tiles. Candidate masks will appear when the scan completes.";
  setStep("scan");
  updateScanButton();
  async function worker() {
    while (next<tiles.length && token===state.scanToken) {
      const index=next++, tile=tiles[index];
      const svg=$("tile-overlay");
      svg.replaceChildren();
      const rect=document.createElementNS(NS,"rect");
      for (const [key,value] of Object.entries({x:tile.x,y:tile.y,width:tile.width,height:tile.height,class:"tile-rect"})) rect.setAttribute(key,String(value));
      svg.appendChild(rect);
      $("progress-label").textContent="SCANNING TILE "+(index+1)+" / "+tiles.length;
      const crop=document.createElement("canvas");
      crop.width=tile.width;crop.height=tile.height;
      crop.getContext("2d").drawImage(state.canvas,tile.x,tile.y,tile.width,tile.height,0,0,tile.width,tile.height);
      try {
        const blob=await canvasBlob(crop);
        const response=await fetch("/api/scout/infer",{method:"POST",headers:{"content-type":"image/jpeg"},body:blob,signal:controller.signal});
        const data=await response.json();
        if (!response.ok) throw new Error(data.error||"Inference failed");
        if (token===state.scanToken) collected.push(...normalizePredictions(data,tile));
      } catch (error) {
        if (error.name!=="AbortError" && token===state.scanToken) failures++;
      }
      if (token!==state.scanToken) return;
      completed++;
      const percent=Math.round(completed/tiles.length*100);
      $("progress-fill").style.width=percent+"%";
      $("progress-percent").textContent=percent+"%";
    }
  }
  await Promise.all(Array.from({length:Math.min(3,tiles.length)},worker));
  if (token!==state.scanToken) return;
  state.scanning=false;
  state.controller=null;
  $("image-wrap").classList.remove("scanning");
  $("tile-overlay").replaceChildren();
  $("progress-label").textContent=failures ? "PARTIAL SCAN · "+(tiles.length-failures)+" / "+tiles.length+" TILES" : "SCAN COMPLETE · "+tiles.length+" "+(tiles.length===1?"TILE":"TILES");
  if (failures===tiles.length) {
    $("image-top-label").textContent="SCAN FAILED";
    $("review-intro").textContent="Roboflow did not return results. Check the connection and try again.";
    toast("The Roboflow scan failed. Please try again.");
    setStep("source");
  } else {
    state.predictions=mergePredictions(collected);
    $("status-text").textContent="LIVE INFERENCE VERIFIED";
    restoreDecisions();
    $("image-top-label").textContent=failures ? "PARTIAL MODEL SCAN · "+failures+" TILES FAILED" : "ROBOFLOW MODEL OUTPUT · LIVE";
    $("review-intro").textContent=failures ? "Some image tiles failed; review the visible candidates as a partial result." : "Each outline is a model candidate. Inspect the pixels before accepting or rejecting it.";
    setStep("review");
    toast(state.predictions.length+" model masks; "+visiblePredictions().length+" shown above "+Math.round(state.threshold*100)+"% confidence"+(failures?" · partial scan":"")+".");
  }
  render();
  updateScanButton();
}

function visiblePredictions() { return state.predictions.filter(item=>item.confidence>=state.threshold); }
function maskPath(points) { return points.map((point,index)=>(index?"L":"M")+point[0].toFixed(1)+" "+point[1].toFixed(1)).join(" ")+" Z"; }
function svgNode(name, attributes={}, content=null) {
  const node=document.createElementNS(NS,name);
  for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,String(value));
  if (content!==null) node.textContent=content;
  return node;
}
function reviewedDirection(candidate) {
  return candidate.decision==="accepted" ? directionEstimate(candidate.axis,candidate.source_end,state.meta?.north_angle_deg) : null;
}

function thumbnail(candidate) {
  if (state.thumbnailCache.has(candidate.id)) return state.thumbnailCache.get(candidate.id);
  const canvas=document.createElement("canvas");canvas.width=70;canvas.height=70;
  const context=canvas.getContext("2d");
  const span=Math.max(100,candidate.bounds.right-candidate.bounds.left,candidate.bounds.bottom-candidate.bounds.top)*1.5;
  context.drawImage(state.canvas,candidate.center[0]-span/2,candidate.center[1]-span/2,span,span,0,0,70,70);
  const url=canvas.toDataURL("image/jpeg",.85);
  state.thumbnailCache.set(candidate.id,url);
  return url;
}

function selectCandidate(candidate) {
  state.selected=candidate;
  render();
  const panel=$("evidence-panel");
  if (window.innerWidth<760) panel.scrollIntoView({behavior:"smooth",block:"nearest"});
}

function renderOverlay(list) {
  const svg=$("mask-overlay");
  svg.replaceChildren();
  list.forEach((candidate,index)=>{
    const path=document.createElementNS(NS,"path");
    path.setAttribute("d",maskPath(candidate.polygon));
    path.setAttribute("class","candidate-mask "+candidate.decision+(state.selected===candidate?" selected":"")+(state.hasRevealed?" instant":""));
    path.setAttribute("style","--delay:"+Math.min(index*22,900)+"ms");
    path.setAttribute("tabindex","0");
    path.setAttribute("role","button");
    path.setAttribute("aria-label","Inspect "+candidate.id+", "+Math.round(candidate.confidence*100)+" percent model confidence");
    path.addEventListener("click",()=>selectCandidate(candidate));
    path.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectCandidate(candidate)}});
    svg.appendChild(path);
  });
}

function renderQueue(list) {
  const container=$("candidate-list");
  container.replaceChildren();
  if (!list.length) {
    const empty=document.createElement("div");
    empty.className="queue-empty";
    const mark=document.createElement("span");mark.textContent="◌";
    const note=document.createElement("p");
    note.textContent=state.predictions.length?"No candidates above this confidence. Lower the threshold to review more.":"The review queue will appear after a live scan.";
    empty.append(mark,note);container.appendChild(empty);
    return;
  }
  list.forEach(candidate=>{
    const button=document.createElement("button");button.type="button";
    button.className="candidate-item"+(state.selected===candidate?" active":"");
    const image=document.createElement("img");image.className="candidate-thumb";image.alt="";image.src=thumbnail(candidate);
    const meta=document.createElement("span");meta.className="candidate-meta";
    const title=document.createElement("strong");title.textContent=candidate.id;
    const info=document.createElement("small");
    const direction=reviewedDirection(candidate);
    info.textContent=Math.round(candidate.confidence*100)+"% CONF. · "+number(Math.round(candidate.area_px2))+" PX²"+(direction?" · "+(direction.towardDegrees===null?Math.round(direction.imageDegrees)+"° IMAGE":Math.round(direction.towardDegrees)+"° DOWNWIND"):"");
    meta.append(title,info);
    const decision=document.createElement("span");decision.className="candidate-state "+candidate.decision;decision.textContent=candidate.decision.toUpperCase();
    button.append(image,meta,decision);
    button.addEventListener("click",()=>selectCandidate(candidate));
    container.appendChild(button);
  });
}

function renderDirections(list) {
  const svg=$("direction-overlay");
  svg.replaceChildren();
  for (const candidate of list) {
    const direction=reviewedDirection(candidate);
    if (!direction) continue;
    const [x1,y1]=direction.source,[x2,y2]=direction.tip;
    const length=Math.hypot(x2-x1,y2-y1), ux=(x2-x1)/length, uy=(y2-y1)/length;
    svg.appendChild(svgNode("line",{x1,y1,x2,y2,class:"wind-arrow"+(state.selected===candidate?" selected":"")}));
    svg.appendChild(svgNode("path",{d:`M ${x2} ${y2} L ${x2-ux*10-uy*5} ${y2-uy*10+ux*5} L ${x2-ux*10+uy*5} ${y2-uy*10-ux*5} Z`,class:"wind-arrow-tip"}));
  }
  const candidate=state.selected;
  if (!candidate?.axis?.usable) return;
  if (!reviewedDirection(candidate)) svg.appendChild(svgNode("line",{x1:candidate.axis.a[0],y1:candidate.axis.a[1],x2:candidate.axis.b[0],y2:candidate.axis.b[1],class:"candidate-axis"}));
  for (const end of ["a","b"]) {
    const point=candidate.axis[end], label=end.toUpperCase();
    svg.appendChild(svgNode("circle",{cx:point[0],cy:point[1],r:12,class:"axis-end"+(candidate.source_end===end?" chosen":"")}));
    svg.appendChild(svgNode("text",{x:point[0],y:point[1]+5,"text-anchor":"middle",class:"axis-label"},label));
  }
}

function renderWindSummary(list) {
  const panel=$("wind-panel"), rose=$("wind-rose");
  panel.hidden=!state.predictions.length;
  rose.replaceChildren();
  if (!state.predictions.length) return;
  const hasNorth=Number.isFinite(state.meta?.north_angle_deg);
  const estimates=list.map(reviewedDirection).filter(Boolean);
  const angles=estimates.map(item=>hasNorth?item.towardDegrees:item.imageDegrees);
  const summary=circularSummary(angles);
  $("wind-count").textContent=summary.count+" "+(summary.count===1?"FAN":"FANS");
  rose.setAttribute("aria-label",summary.count?summary.count+" reviewed dust-travel directions" : "No reviewed directions yet");
  rose.appendChild(svgNode("circle",{cx:80,cy:80,r:52,class:"rose-ring"}));
  rose.appendChild(svgNode("circle",{cx:80,cy:80,r:29,class:"rose-ring inner"}));
  rose.appendChild(svgNode("line",{x1:80,y1:28,x2:80,y2:132,class:"rose-cross"}));
  rose.appendChild(svgNode("line",{x1:28,y1:80,x2:132,y2:80,class:"rose-cross"}));
  const labels=hasNorth?["N","E","S","W"]:["UP","R","DN","L"];
  for (const [index,[x,y]] of [[80,17],[143,83],[80,152],[17,83]].entries()) rose.appendChild(svgNode("text",{x,y,"text-anchor":"middle",class:"rose-cardinal"},labels[index]));
  for (const angle of angles) {
    const radians=angle*Math.PI/180;
    rose.appendChild(svgNode("line",{x1:80,y1:80,x2:80+Math.sin(radians)*51,y2:80-Math.cos(radians)*51,class:"rose-ray"}));
  }
  if (summary.meanDegrees!==null) {
    const radians=summary.meanDegrees*Math.PI/180;
    rose.appendChild(svgNode("line",{x1:80,y1:80,x2:80+Math.sin(radians)*62,y2:80-Math.cos(radians)*62,class:"rose-mean"}));
  }
  rose.appendChild(svgNode("circle",{cx:80,cy:80,r:4,class:"rose-center"}));
  if (!summary.count) {
    $("wind-heading").textContent="—";
    $("wind-subheading").textContent="AWAITING REVIEWED FANS";
    $("wind-detail").textContent="Accept a directional fan and choose whether A or B is its source end.";
  } else if (summary.meanDegrees===null) {
    $("wind-heading").textContent="MIXED";
    $("wind-subheading").textContent="NO SINGLE DOMINANT DIRECTION";
    $("wind-detail").textContent="Reviewed fan directions disagree. Inspect the individual arrows instead of averaging them.";
  } else {
    const toward=Math.round(summary.meanDegrees)%360;
    $("wind-heading").textContent=toward+"°";
    $("wind-subheading").textContent=hasNorth?"DUST TRAVELED TOWARD "+compassPoint(summary.meanDegrees):"CLOCKWISE FROM IMAGE TOP";
    $("wind-detail").textContent=hasNorth?"Estimated wind-from bearing: "+Math.round((summary.meanDegrees+180)%360)+"° ("+compassPoint(summary.meanDegrees+180)+"). "+summary.count+" reviewed "+(summary.count===1?"fan":"fans")+" above the display threshold.":"Image-relative direction only. Supply north orientation for a compass bearing.";
  }
}

function renderEvidence() {
  const candidate=state.selected;
  $("evidence-panel").hidden=!candidate;
  if (!candidate) return;
  $("evidence-id").textContent=candidate.id;
  $("evidence-confidence").textContent=Math.round(candidate.confidence*100)+"%";
  $("evidence-area").textContent=number(Math.round(candidate.area_px2))+(state.meta?.pixel_scale_m?" m²":" px²");
  const canvas=$("evidence-crop"), context=canvas.getContext("2d");
  const span=Math.max(105,candidate.bounds.right-candidate.bounds.left,candidate.bounds.bottom-candidate.bounds.top)*1.65;
  const originX=candidate.center[0]-span/2,originY=candidate.center[1]-span/2;
  context.clearRect(0,0,140,140);
  context.drawImage(state.canvas,originX,originY,span,span,0,0,140,140);
  context.beginPath();
  candidate.polygon.forEach((point,index)=>{const x=(point[0]-originX)/span*140,y=(point[1]-originY)/span*140;index?context.lineTo(x,y):context.moveTo(x,y)});
  context.closePath();context.lineWidth=2;context.strokeStyle="#ffad86";context.stroke();
  if (candidate.axis?.usable) {
    const direction=reviewedDirection(candidate);
    if (direction) {
      const start=[(direction.source[0]-originX)/span*140,(direction.source[1]-originY)/span*140];
      const end=[(direction.tip[0]-originX)/span*140,(direction.tip[1]-originY)/span*140];
      const radians=Math.atan2(end[1]-start[1],end[0]-start[0]);
      context.beginPath();context.moveTo(...start);context.lineTo(...end);context.strokeStyle="#bafbe6";context.lineWidth=2.5;context.stroke();
      context.beginPath();context.moveTo(...end);context.lineTo(end[0]-9*Math.cos(radians-.48),end[1]-9*Math.sin(radians-.48));context.moveTo(...end);context.lineTo(end[0]-9*Math.cos(radians+.48),end[1]-9*Math.sin(radians+.48));context.stroke();
    }
    for (const end of ["a","b"]) {
      const point=candidate.axis[end],x=(point[0]-originX)/span*140,y=(point[1]-originY)/span*140;
      context.beginPath();context.arc(x,y,9,0,Math.PI*2);context.fillStyle=candidate.source_end===end?"#bafbe6":"#f6b78d";context.fill();
      context.fillStyle="#122021";context.font="bold 11px Arial";context.textAlign="center";context.textBaseline="middle";context.fillText(end.toUpperCase(),x,y+.5);
    }
  }
  for (const decision of ["accept","reject","unsure"]) $(""+decision+"-button").classList.toggle("active",candidate.decision===({accept:"accepted",reject:"rejected",unsure:"unsure"}[decision]));
  const canPoint=candidate.decision==="accepted" && candidate.axis?.usable;
  for (const end of ["a","b"]) {
    $("origin-"+end+"-button").disabled=!canPoint;
    $("origin-"+end+"-button").classList.toggle("active",candidate.source_end===end);
  }
  $("origin-clear-button").disabled=!candidate.source_end;
  $("direction-instruction").textContent=!candidate.axis?.usable ? "This mask is too round or small for a defensible long-axis estimate. Review it as a deposit only." : candidate.decision!=="accepted" ? "Accept this fan first. Then use A or B in the source crop to identify its narrow source end." : "Which end is the source? Choose A or B. The arrow points where dust traveled when this deposit formed.";
  const direction=reviewedDirection(candidate);
  $("direction-result").textContent=!direction ? "No direction assigned" : direction.towardDegrees===null ? "Estimated dust travel: "+Math.round(direction.imageDegrees)+"° clockwise from image top · compass north unknown" : "Estimated dust travel toward "+Math.round(direction.towardDegrees)+"° "+compassPoint(direction.towardDegrees)+" · wind from "+Math.round(direction.fromDegrees)+"° "+compassPoint(direction.fromDegrees);
}

function render() {
  const list=visiblePredictions();
  if (state.selected && !list.includes(state.selected)) state.selected=null;
  $("candidate-count").textContent=state.predictions.length?number(list.length):(state.canvas?"0":"—");
  $("reviewed-count").textContent=state.predictions.length?number(list.filter(item=>item.decision!=="pending").length):(state.canvas?"0":"—");
  const area=list.reduce((sum,item)=>sum+item.area_px2,0);
  $("area-label").textContent=state.meta?.pixel_scale_m?"EST. AREA · M²":"EST. AREA · PX²";
  $("area-count").textContent=state.predictions.length?(area>=1000?(area/1000).toFixed(1)+"k":number(Math.round(area))):(state.canvas?"0":"—");
  $("queue-total").textContent=String(list.length).padStart(2,"0");
  $("export-button").disabled=!state.predictions.length;
  $("copy-button").disabled=!state.predictions.length;
  if (!state.predictions.length) $("review-json-panel").hidden=true;
  else if (!$("review-json-panel").hidden) $("review-json").value=JSON.stringify(buildRecord(),null,2);
  if (state.meta) $("provenance-text").textContent=(state.meta.observation||"User image")+" · "+(state.modelId||"model pending")+" · "+(state.meta.pixel_scale_m?"1 m/px working scale":"unknown pixel scale")+" · "+(Number.isFinite(state.meta.north_angle_deg)?"north reference: "+state.meta.north_angle_deg+"°":"compass north unknown")+" · reviewer-selected source ends.";
  renderOverlay(list);
  renderQueue(list);
  renderEvidence();
  renderDirections(list);
  renderWindSummary(list);
  if (state.predictions.length) state.hasRevealed=true;
}

function review(decision) {
  if (!state.selected) return;
  state.selected.decision=decision;
  if (decision!=="accepted") state.selected.source_end=null;
  saveDecisions();
  render();
}

function selectOrigin(end) {
  const candidate=state.selected;
  if (!candidate || candidate.decision!=="accepted" || !candidate.axis?.usable) return;
  candidate.source_end=end;
  saveDecisions();
  render();
}

function buildRecord() {
  return {
    format:"mars-fan-scout-review-v2",
    exported_at:new Date().toISOString(),
    warning:"Model candidates and derived directions are not confirmed scientific measurements. Direction requires a reviewer-selected source end; wind speed and current weather are not inferred. Pixel coordinates are not georeferenced.",
    image:{name:state.file.name,sha256:state.hash.split(":")[0],width:state.canvas.width,height:state.canvas.height,source:state.meta.source||null,observation:state.meta.observation||null,captured:state.meta.captured||null,crop_raw_pixels:state.meta.crop_raw_pixels||null,source_scale_m_per_pixel:state.meta.source_scale_m_per_pixel||null,working_scale_m_per_pixel:state.meta.pixel_scale_m,north_clockwise_from_image_top_deg:state.meta.north_angle_deg,north_reference:state.meta.north_reference||null},
    model:{provider:"Roboflow",id:state.modelId,confidence_floor:.2,display_threshold:state.threshold,direction_method:"Area-weighted mask major axis with a human-selected source end; minimum 1.5 elongation and 20-pixel span"},
    summary:{model_candidates_above_floor:state.predictions.length,displayed_at_threshold:visiblePredictions().length,accepted:state.predictions.filter(item=>item.decision==="accepted").length,rejected:state.predictions.filter(item=>item.decision==="rejected").length,unsure:state.predictions.filter(item=>item.decision==="unsure").length,accepted_with_direction:state.predictions.filter(item=>reviewedDirection(item)).length},
    candidates:state.predictions.map(item=>{
      const direction=reviewedDirection(item);
      return {id:item.id,confidence:item.confidence,shown_at_export:item.confidence>=state.threshold,decision:item.decision,center_px:item.center.map(value=>Math.round(value*10)/10),area_px2:Math.round(item.area_px2),estimated_area_m2:state.meta.pixel_scale_m?Math.round(item.area_px2*state.meta.pixel_scale_m**2):null,polygon_px:item.polygon.map(point=>point.map(value=>Math.round(value*10)/10)),axis_elongation:item.axis?Math.round(item.axis.elongation*100)/100:null,source_end_selected_by_reviewer:item.source_end,direction:direction?{source_px:direction.source.map(value=>Math.round(value*10)/10),tip_px:direction.tip.map(value=>Math.round(value*10)/10),clockwise_from_image_top_deg:Math.round(direction.imageDegrees*10)/10,dust_toward_bearing_deg:direction.towardDegrees===null?null:Math.round(direction.towardDegrees*10)/10,wind_from_bearing_deg:direction.fromDegrees===null?null:Math.round(direction.fromDegrees*10)/10}:null};
    })
  };
}

function exportRecord() {
  if (!state.predictions.length) return;
  const blob=new Blob([JSON.stringify(buildRecord(),null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");link.href=url;link.download="mars-fan-scout-"+(state.meta.observation||"review")+"-"+new Date().toISOString().slice(0,10)+".json";
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast("Review record exported with model provenance and your decisions.");
}

function showReviewJSON() {
  if (!state.predictions.length) return;
  $("review-json").value=JSON.stringify(buildRecord(),null,2);
  $("review-json-panel").hidden=false;
  $("review-json").focus();
  $("review-json").select();
  $("review-json-panel").scrollIntoView({behavior:"smooth",block:"nearest"});
}

async function copyReviewJSON() {
  if (!state.predictions.length) return;
  showReviewJSON();
  try {
    await navigator.clipboard.writeText($("review-json").value);
    toast("Review JSON copied. It includes the model, polygons, and your decisions.");
  } catch (_) {
    toast("Select all in the review record and copy it from the text box.");
  }
}

function init() {
  $("load-sample").addEventListener("click",loadSample);
  $("image-input").addEventListener("change",async event=>{
    const file=event.target.files?.[0];
    if (!file) return;
    try { await loadFile(file); } catch(error) { toast(error.message); }
    event.target.value="";
  });
  const drop=$("upload-box");
  for (const name of ["dragenter","dragover"]) drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add("dragover")});
  for (const name of ["dragleave","drop"]) drop.addEventListener(name,event=>{event.preventDefault();drop.classList.remove("dragover")});
  drop.addEventListener("drop",async event=>{const file=event.dataTransfer.files?.[0];if(file)try{await loadFile(file)}catch(error){toast(error.message)}});
  $("source-scale").addEventListener("change",async()=>{if(state.file&&!state.meta?.sample)try{await loadFile(state.file,{north_angle_deg:state.meta.north_angle_deg,north_reference:state.meta.north_reference})}catch(error){toast(error.message)}});
  $("north-angle").addEventListener("input",()=>{
    if (!state.meta || state.meta.sample) return;
    const raw=$("north-angle").value.trim();
    const value=raw===""?null:Number(raw);
    if (value!==null && (!Number.isFinite(value)||value<0||value>=360)) {
      $("north-angle").value="";
      state.meta.north_angle_deg=null;
      state.meta.north_reference=null;
      toast("North orientation must be between 0° and 359.9° clockwise from image top.");
    } else {
      state.meta.north_angle_deg=value;
      state.meta.north_reference=value===null?null:"User-supplied orientation, not verified by the app";
    }
    try {
      const key="mars-fan-scout-north:"+state.hash;
      if (state.meta.north_angle_deg===null) localStorage.removeItem(key);
      else localStorage.setItem(key,String(state.meta.north_angle_deg));
    } catch (_) { toast("Browser storage is unavailable; export your review before leaving."); }
    render();
  });
  $("scan-button").addEventListener("click",runScan);
  $("confidence-slider").addEventListener("input",event=>{state.threshold=Number(event.target.value)/100;$("confidence-value").textContent=event.target.value+"%";render()});
  $("accept-button").addEventListener("click",()=>review("accepted"));
  $("reject-button").addEventListener("click",()=>review("rejected"));
  $("unsure-button").addEventListener("click",()=>review("unsure"));
  $("origin-a-button").addEventListener("click",()=>selectOrigin("a"));
  $("origin-b-button").addEventListener("click",()=>selectOrigin("b"));
  $("origin-clear-button").addEventListener("click",()=>selectOrigin(null));
  $("export-button").addEventListener("click",exportRecord);
  $("copy-button").addEventListener("click",()=>{
    if ($("review-json-panel").hidden) showReviewJSON();
    else $("review-json-panel").hidden=true;
  });
  $("copy-json-button").addEventListener("click",copyReviewJSON);
  modelStatus().then(()=>{loadEvaluation();loadSample()});
}
document.addEventListener("DOMContentLoaded",init);
