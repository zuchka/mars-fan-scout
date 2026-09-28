import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { makeEvidence, imageInfo } from "../review-agent/evidence.mjs";
import { QUESTION, STATE } from "../review-agent/provider.mjs";
import { predictionsFromRoboflow, showcaseCandidates } from "../public/candidates.js";

const root = new URL("../", import.meta.url);
const image = await readFile(new URL("public/images/scout-2024-dev.jpg", root));
const info = await imageInfo(image);
const frozen = JSON.parse(await readFile(new URL("evaluation/demo-repair/sample-roboflow.json", root)));
const selected = showcaseCandidates(predictionsFromRoboflow(frozen.response, info), info);
const oldState = "This is a crop of a south-polar HiRISE image of Mars. The thin orange outline identifies one Roboflow candidate; judge only the deposit inside that outline using the image pixels. A polar fan is a dark, asymmetric deposit that spreads from a narrower source. A dark spot, shadow, image seam, or indistinct shape need not be a fan. Choose Unsure when the visible pixels cannot distinguish the possibilities. Do not infer wind direction.";
const oldQuestion = "Is the orange-outlined candidate a Martian polar fan deposit?";
const rows = [];
const gallery = new URL("../evaluation/demo-repair/gallery/", import.meta.url);
await mkdir(gallery, { recursive: true });
for (const candidate of selected) {
  const evidence = await makeEvidence(image, info, candidate, "initial");
  const [x, y, x2, y2] = evidence.meta.actual_bounds_px;
  const { output_width: width, output_height: height } = evidence.meta;
  const points = candidate.polygon.map(([px, py]) => `${((px - x) * width / (x2 - x)).toFixed(2)},${((py - y) * height / (y2 - y)).toFixed(2)}`).join(" ");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polygon points="${points}" fill="#ff704a" fill-opacity="0.13" stroke="#ff704a" stroke-width="3"/></svg>`);
  const oldOverlay = await sharp(evidence.pixels).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer();
  for (const [version, bytes, state, question] of [["old", oldOverlay, oldState, oldQuestion], ["new", evidence.overlay, STATE, QUESTION]]) {
    await writeFile(new URL(`sample-${candidate.sourceIndex}-${version}.jpg`, gallery), bytes);
    rows.push({ source_index: candidate.sourceIndex, version, image_base64: bytes.toString("base64"), state, question });
  }
}
const output = "/tmp/mars-hosted-comparison-input.json";
await writeFile(output, JSON.stringify({ model: frozen.model_id, cases: rows }));
console.log(JSON.stringify({ output, cases: rows.length, bytes: (await readFile(output)).length }));
