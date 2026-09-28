import { mkdir, readFile, writeFile } from "node:fs/promises";
import { makeEvidence, imageInfo } from "../review-agent/evidence.mjs";
import { QUESTION, STATE } from "../review-agent/provider.mjs";

// Deliberately selected from a different observation before running either model.
// These are visual non-fan probes, not scientific ground truth.
const probes = [
  { id: "rock-shadow", image: "holdout-02.jpg", x: 345, y: 80, side: 70 },
  { id: "plain-terrain", image: "holdout-02.jpg", x: 500, y: 450, side: 70 },
  { id: "textured-ridge", image: "holdout-03.jpg", x: 770, y: 330, side: 70 },
];
const cases = [];
const gallery = new URL("../evaluation/demo-repair/gallery/", import.meta.url);
await mkdir(gallery, { recursive: true });
for (const probe of probes) {
  const bytes = await readFile(new URL(`../evaluation/demo-repair/holdout/${probe.image}`, import.meta.url));
  const info = await imageInfo(bytes);
  const half = probe.side / 2;
  const candidate = { confidence: 1, polygon: [
    [probe.x - half, probe.y - half], [probe.x + half, probe.y - half],
    [probe.x + half, probe.y + half], [probe.x - half, probe.y + half],
  ] };
  const evidence = await makeEvidence(bytes, info, candidate, "initial");
  await writeFile(new URL(`${probe.id}.jpg`, gallery), evidence.overlay);
  cases.push({ source_index: probe.id, version: "context", image_base64: evidence.overlay.toString("base64"), state: STATE, question: QUESTION });
}
const output = "/tmp/mars-negative-probes.json";
await writeFile(output, JSON.stringify({ model: "akhilaaa3/Jev-Omni", cases }));
console.log(JSON.stringify({ output, cases: cases.length, bytes: (await readFile(output)).length }));
