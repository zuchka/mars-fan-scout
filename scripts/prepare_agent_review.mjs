import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const locked = resolve(root, "evaluation/locked");
const output = resolve(root, "evaluation/agent-review");
const hash = text => createHash("sha256").update(text).digest("hex");
const polygonArea = points => Math.abs(points.reduce((sum, a, index) => {
  const b = points[(index + 1) % points.length];
  return sum + a[0] * b[1] - b[0] * a[1];
}, 0)) / 2;
const manifest = JSON.parse(await readFile(resolve(locked, "manifest.json"), "utf8"));
const result = [];

for (const crop of manifest) {
  const raw = JSON.parse(await readFile(resolve(locked, `predictions/${crop.id}.json`), "utf8"));
  const sx = crop.width / (Number(raw.image?.width) || crop.width);
  const sy = crop.height / (Number(raw.image?.height) || crop.height);
  const all = (raw.predictions || []).map((item, index) => {
    const polygon = (item.points || item.polygon || []).map(point => Array.isArray(point) ? [point[0] * sx, point[1] * sy] : [point.x * sx, point.y * sy]);
    if (polygon.length < 3 || polygon.some(point => !point.every(Number.isFinite))) return null;
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    const bounds = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    return { source_index: index, polygon, area_px2: polygonArea(polygon), confidence: Number(item.confidence), bounds,
      center: [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2] };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const item of all) {
    const duplicate = kept.some(existing => {
      const a = item.bounds, b = existing.bounds;
      const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const aa = (a.right - a.left) * (a.bottom - a.top), ba = (b.right - b.left) * (b.bottom - b.top);
      const iou = intersection / Math.max(1, aa + ba - intersection);
      const distance = Math.hypot(item.center[0] - existing.center[0], item.center[1] - existing.center[1]);
      return iou > .42 || (distance < 18 && Math.max(existing.area_px2, item.area_px2) / Math.max(1, Math.min(existing.area_px2, item.area_px2)) < 3);
    });
    if (!duplicate) kept.push(item);
  }
  const high = kept.filter(item => item.confidence >= .35);
  const low = kept.filter(item => item.confidence >= .2 && item.confidence < .35)
    .sort((a, b) => hash(`${crop.id}:${a.source_index}`).localeCompare(hash(`${crop.id}:${b.source_index}`))).slice(0, 2);
  const chosen = [...high, ...low];
  for (const group of [high, low]) {
    group.sort((a, b) => hash(`arm:${crop.id}:${a.source_index}`).localeCompare(hash(`arm:${crop.id}:${b.source_index}`)));
    group.forEach((item, index) => { item.arm = index % 2 ? "assisted" : "baseline"; });
  }
  const candidates = chosen.map(item => ({ label: `${crop.id}-RF-${String(item.source_index + 1).padStart(3, "0")}`, source_index: item.source_index,
    confidence: item.confidence, polygon: item.polygon, arm: item.arm }));
  result.push({ id: crop.id, observation: crop.observation, image: `evaluation/locked/${crop.image}`, width: crop.width, height: crop.height,
    detector_response: `evaluation/locked/predictions/${crop.id}.json`, candidates });
}
await mkdir(output, { recursive: true });
const data = { format: "mars-fan-agent-fixtures-v1", created_at: "2026-09-27",
  model_id: "matt-abrams/mars-polar-fan-masks-1-rfdetr-seg-small-t1", selection: "All deduplicated candidates at >=35%, plus two SHA-256 seeded candidates per crop at 20-35%; arms alternate after seeded shuffle within crop/confidence band.",
  crops: result };
const polygons = new Map();
let serial = JSON.stringify(data, (key, value) => {
  if (key !== "polygon") return value;
  const marker = `__FROZEN_POLYGON_${polygons.size}__`;
  polygons.set(marker, JSON.stringify(value));
  return marker;
}, 2);
for (const [marker, points] of polygons) serial = serial.replace(`"${marker}"`, points);
await writeFile(resolve(output, "manifest.json"), serial + "\n");
console.log(`${result.length} crops, ${result.reduce((sum, crop) => sum + crop.candidates.length, 0)} candidates`);
