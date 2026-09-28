import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { predictionsFromRoboflow, showcaseCandidates } from "../public/candidates.js";

const base = new URL("../evaluation/demo-repair/holdout/", import.meta.url);
const rows = [];
for (const id of ["holdout-01", "holdout-02", "holdout-03"]) {
  const image = await readFile(new URL(`${id}.jpg`, base));
  const response = JSON.parse(await readFile(new URL(`${id}.roboflow.json`, base)));
  const info = await sharp(image).metadata();
  const unique = predictionsFromRoboflow(response, info);
  const selected = showcaseCandidates(unique, info);
  rows.push({ id, raw_count: response.predictions.length, deduplicated_count: unique.length,
    featured: selected.map(item => ({ source_index: item.sourceIndex, confidence: item.confidence,
      area_px: Math.round(item.area), bounds: item.bounds })) });
  const shapes = selected.map((item, index) => {
    const b = item.bounds;
    return `<rect x="${b.left}" y="${b.top}" width="${b.right - b.left}" height="${b.bottom - b.top}" fill="none" stroke="#ff704a" stroke-width="3"/><text x="${b.left}" y="${Math.max(25, b.top - 8)}" fill="#ff704a" font-size="25" font-family="sans-serif">${index + 1}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">${shapes}</svg>`);
  await writeFile(new URL(`${id}.featured.jpg`, base), await sharp(image).composite([{ input: svg }]).jpeg({ quality: 91 }).toBuffer());
}
await writeFile(new URL("detector-report.json", base), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(rows));
