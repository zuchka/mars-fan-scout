import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { makeEvidence } from "../review-agent/evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const sessionId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(sessionId || "")) throw new Error("Pass a local demo session ID");
const sessionDir = resolve(root, ".review-agent", sessionId);
const session = JSON.parse(await readFile(resolve(sessionDir, "session.json")));
const image = await readFile(resolve(sessionDir, "working-image." + (session.image.format === "png" ? "png" : "jpg")));
const run = Object.values(session.runs).at(-1);
if (!run || run.status !== "complete") throw new Error("The demo run must be complete");

const oldState = "This is a crop of a south-polar HiRISE image of Mars. The thin orange outline identifies one Roboflow candidate; judge only the deposit inside that outline using the image pixels. A polar fan is a dark, asymmetric deposit that spreads from a narrower source. A dark spot, shadow, image seam, or indistinct shape need not be a fan. Choose Unsure when the visible pixels cannot distinguish the possibilities. Do not infer wind direction.";
const oldQuestion = "Is the orange-outlined candidate a Martian polar fan deposit?";
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const rows = [];
for (const id of run.candidates) {
  const candidate = session.candidates.find(item => item.id === id);
  const evidence = await makeEvidence(image, session.image, candidate, "initial");
  const [x, y, x2, y2] = evidence.meta.actual_bounds_px;
  const { output_width: width, output_height: height } = evidence.meta;
  const points = candidate.polygon.map(([px, py]) => `${((px - x) * width / (x2 - x)).toFixed(2)},${((py - y) * height / (y2 - y)).toFixed(2)}`).join(" ");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polygon points="${escape(points)}" fill="#ff704a" fill-opacity="0.13" stroke="#ff704a" stroke-width="3"/></svg>`);
  const oldOverlay = await sharp(evidence.pixels).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer();
  const started = performance.now();
  const response = await fetch("http://127.0.0.1:8765/classify", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_base64: oldOverlay.toString("base64"), state: oldState, question: oldQuestion,
      options: ["Fan", "Not a fan", "Unsure"], image_tokens: 70 }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Local Jev HTTP ${response.status}`);
  const old = await response.json();
  const newCalls = run.results[id].trace.filter(item => item.type === "provider_call_completed");
  rows.push({ candidate_id: id, confidence: candidate.confidence, old: { prediction: old.prediction, probabilities: old.probabilities,
    elapsed_ms: Math.round(performance.now() - started) }, new: newCalls.map(item => ({ prediction: item.raw_prediction,
    probabilities: item.probabilities, wider: item.wider, latency_ms: item.latency_ms })), final_verdict: run.results[id].verdict });
}
const report = { observation: session.image.observation, backend: "mlx-4bit", old_prompt: "mars-fan-jev-choice-1",
  new_prompt: run.prompt_version, note: "Development comparison on the local MLX conversion; these are not CUDA endpoint results or human ground truth.", rows };
const output = resolve(root, "evaluation/demo-repair/local-jev-view-comparison.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, rows: rows.map(row => ({ old: row.old.prediction, new: row.new.map(call => call.prediction), final: row.final_verdict })) }));
