import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { predictionsFromRoboflow, showcaseCandidates } from "../public/candidates.js";

const modelId = process.argv[2];
if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(modelId || "")) throw new Error("Pass the trained workspace/model ID");
const envPath = new URL("../.env.local", import.meta.url);
const privateEnv = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
const key = process.env.ROBOFLOW_API_KEY || privateEnv.match(/^ROBOFLOW_API_KEY=(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
if (!key) throw new Error("ROBOFLOW_API_KEY is required");
const root = new URL("../", import.meta.url);
const outputDir = new URL("../evaluation/demo-repair/box-predictions/", import.meta.url);
await mkdir(outputDir, { recursive: true });
const marks = JSON.parse(await readFile(new URL("evaluation/locked/review-points.json", root)));
const imageFiles = [
  { id: "sample", path: "public/images/scout-2024-dev.jpg" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `locked-0${index + 1}`, path: `evaluation/locked/images/locked-0${index + 1}.jpg` })),
  ...Array.from({ length: 3 }, (_, index) => ({ id: `holdout-0${index + 1}`, path: `evaluation/demo-repair/holdout/holdout-0${index + 1}.jpg` })),
];
const [workspace, model] = modelId.split("/");
const rows = [];
for (const item of imageFiles) {
  const image = await readFile(new URL(item.path, root));
  const url = new URL(`https://serverless.roboflow.com/${workspace}/${model}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("confidence", ".2");
  const started = performance.now();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: image.toString("base64"), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${item.id}: Roboflow HTTP ${response.status}`);
  const body = await response.json();
  await writeFile(new URL(`${item.id}.json`, outputDir), JSON.stringify(body, null, 2) + "\n");
  const info = { width: Number(body.image?.width) || 1024, height: Number(body.image?.height) || 1024 };
  const proposals = predictionsFromRoboflow(body, info);
  const featured = showcaseCandidates(proposals, info);
  const review = marks.crops.find(row => row.id === item.id);
  const near = candidate => review?.points_px.some(([x, y]) => {
    const centerX = (candidate.bounds.left + candidate.bounds.right) / 2;
    const centerY = (candidate.bounds.top + candidate.bounds.bottom) / 2;
    return Math.hypot(x - centerX, y - centerY) <= 75;
  });
  const matched = candidates => review?.points_px.filter(([x, y]) => candidates.some(candidate => {
    const centerX = (candidate.bounds.left + candidate.bounds.right) / 2;
    const centerY = (candidate.bounds.top + candidate.bounds.bottom) / 2;
    return Math.hypot(x - centerX, y - centerY) <= 75;
  })).length ?? null;
  rows.push({ id: item.id, request_ms: Math.round(performance.now() - started), raw_count: body.predictions?.length || 0,
    deduplicated_count: proposals.length, featured_count: featured.length,
    featured_near_clear_mark: review ? featured.filter(near).length : null,
    clear_marks_total: review?.points_px.length ?? null,
    clear_marks_near_any_proposal: matched(proposals), clear_marks_near_featured: matched(featured),
    featured: featured.map(candidate => ({ source_index: candidate.sourceIndex, confidence: candidate.confidence,
      area_px: Math.round(candidate.area), bounds: candidate.bounds })) });
  console.log(JSON.stringify(rows.at(-1)));
}
const report = { model_id: modelId, method: "Same 20% floor and 75px non-expert center proximity as baseline; no outline-quality score", rows };
await writeFile(new URL("../evaluation/demo-repair/box-comparator-report.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
