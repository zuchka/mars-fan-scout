import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { predictionsFromRoboflow, showcaseCandidates } from "../public/candidates.js";

const root = resolve(import.meta.dirname, "..");
const image = { width: 1024, height: 1024 };
const sample = JSON.parse(await readFile(resolve(root, "evaluation/demo-repair/sample-roboflow.json")));
const marks = JSON.parse(await readFile(resolve(root, "evaluation/locked/review-points.json")));
const all = predictionsFromRoboflow(sample.response, image);
const selected = showcaseCandidates(all, image);
const summarize = item => ({ source_index: item.sourceIndex, confidence: Number(item.confidence.toFixed(3)),
  area_px: Math.round(item.area), center_px: [Math.round((item.bounds.left + item.bounds.right) / 2),
    Math.round((item.bounds.top + item.bounds.bottom) / 2)] });
const rows = [];
for (const crop of marks.crops) {
  const response = JSON.parse(await readFile(resolve(root, `evaluation/locked/predictions/${crop.id}.json`)));
  const proposals = predictionsFromRoboflow(response, image);
  const featured = showcaseCandidates(proposals, image);
  const near = (item, point) => Math.hypot((item.bounds.left + item.bounds.right) / 2 - point[0],
    (item.bounds.top + item.bounds.bottom) / 2 - point[1]) <= marks.matching_tolerance_px;
  rows.push({ crop: crop.id, marked_clear_deposits: crop.points_px.length, proposals: proposals.length,
    featured: featured.map(summarize), clear_marks_near_any_proposal: crop.points_px.filter(point => proposals.some(item => near(item, point))).length,
    clear_marks_near_featured: crop.points_px.filter(point => featured.some(item => near(item, point))).length });
}
const report = { format: "mars-fan-demo-candidate-report-v1", model_id: sample.model_id,
  method: "Frozen model responses, bbox-center proximity within the existing 75px tolerance; non-expert marks and no mask boundary score.",
  sample: { raw_predictions: sample.response.predictions.length, deduplicated: all.length,
    raw_sub_50px_proposals: all.filter(item => item.area < 50).length, featured: selected.map(summarize) },
  locked: { crops: rows, clear_marks_total: rows.reduce((sum, row) => sum + row.marked_clear_deposits, 0),
    clear_marks_near_any_proposal: rows.reduce((sum, row) => sum + row.clear_marks_near_any_proposal, 0),
    clear_marks_near_featured: rows.reduce((sum, row) => sum + row.clear_marks_near_featured, 0) } };
const output = resolve(root, "evaluation/demo-repair/candidate-report.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ sample: report.sample, locked: { clear_marks_total: report.locked.clear_marks_total,
  near_any: report.locked.clear_marks_near_any_proposal, near_featured: report.locked.clear_marks_near_featured } }));
