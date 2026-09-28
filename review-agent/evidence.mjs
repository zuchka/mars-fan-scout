import sharp from "sharp";
import { createHash } from "node:crypto";

export const sha256 = value => createHash("sha256").update(value).digest("hex");

export async function imageInfo(bytes) {
  if (bytes.length > 40 * 1024 * 1024) throw new Error("Working image exceeds 40 MB");
  const { format, width, height } = await sharp(bytes, { limitInputPixels: 3072 * 3072 }).metadata();
  if (!["png", "jpeg"].includes(format) || !width || !height || width < 256 || height < 256 || width > 3072 || height > 3072) {
    throw new Error("Expected a PNG or JPEG working image between 256 and 3072 pixels per side");
  }
  return { format, width, height, sha256: sha256(bytes) };
}

function clipSquare(candidate, width, height, factor) {
  const xs = candidate.polygon.map(point => point[0]);
  const ys = candidate.polygon.map(point => point[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const side = Math.ceil(Math.max(105, right - left, bottom - top) * 1.65 * factor);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const x = Math.max(0, Math.floor(cx - side / 2)), y = Math.max(0, Math.floor(cy - side / 2));
  const x2 = Math.min(width, Math.ceil(cx + side / 2)), y2 = Math.min(height, Math.ceil(cy + side / 2));
  return { requested: [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2], actual: [x, y, x2, y2], clipped: x === 0 || y === 0 || x2 === width || y2 === height };
}

const svgEscape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export async function makeEvidence(imageBytes, info, candidate, kind) {
  const box = clipSquare(candidate, info.width, info.height, kind === "wider" ? 2 : 1);
  const [x, y, x2, y2] = box.actual;
  if (kind === "wider") {
    const first = clipSquare(candidate, info.width, info.height, 1).actual;
    if (first.every((value, index) => value === box.actual[index])) return null;
  }
  const width = x2 - x, height = y2 - y;
  if (width <= 0 || height <= 0) throw new Error("Empty evidence crop");
  const outputScale = Math.min(1, 1024 / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * outputScale));
  const outHeight = Math.max(1, Math.round(height * outputScale));
  const pixels = await sharp(imageBytes).extract({ left: x, top: y, width, height }).resize(outWidth, outHeight).jpeg({ quality: 90 }).toBuffer();
  const xs = candidate.polygon.map(point => point[0]), ys = candidate.polygon.map(point => point[1]);
  const left = (Math.min(...xs) - x) * outWidth / width, top = (Math.min(...ys) - y) * outHeight / height;
  const markerWidth = (Math.max(...xs) - Math.min(...xs)) * outWidth / width;
  const markerHeight = (Math.max(...ys) - Math.min(...ys)) * outHeight / height;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}"><rect x="${svgEscape(left.toFixed(2))}" y="${svgEscape(top.toFixed(2))}" width="${svgEscape(markerWidth.toFixed(2))}" height="${svgEscape(markerHeight.toFixed(2))}" fill="none" stroke="#ff704a" stroke-width="2" stroke-dasharray="6 4"/></svg>`);
  const overlay = await sharp(pixels).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer();
  await imageInfoForCrop(pixels, outWidth, outHeight);
  return { pixels, overlay, meta: { kind, overlay_style: "region_pointer_v2", requested_bounds_px: box.requested, actual_bounds_px: box.actual, clipped: box.clipped, output_width: outWidth, output_height: outHeight, scale_x: outWidth / width, scale_y: outHeight / height, source_sha256: sha256(pixels), overlay_sha256: sha256(overlay) } };
}

async function imageInfoForCrop(bytes, width, height) {
  const info = await sharp(bytes).metadata();
  if (info.width !== width || info.height !== height) throw new Error("Crop verification failed");
}

export function validateCandidate(candidate, info) {
  if (!candidate || !Array.isArray(candidate.polygon) || candidate.polygon.length < 3 || candidate.polygon.length > 1024 || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new Error("Invalid candidate");
  if (!candidate.polygon.every(point => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[0] >= 0 && point[1] >= 0 && point[0] <= info.width && point[1] <= info.height)) throw new Error("Candidate lies outside working image");
}
