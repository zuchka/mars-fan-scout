import { readFile, writeFile } from "node:fs/promises";
import {
  validateAnnotation,
  rasterGeometry,
  boundaryMetrics,
  matchInstances,
} from "../public/boundary-metrics.js";
const [annotationPath, exportPath, outputPath, method = "detector"] =
  process.argv.slice(2);
if (
  !annotationPath ||
  !exportPath ||
  !outputPath ||
  !["detector", "sam"].includes(method)
)
  throw new Error(
    "Usage: node scripts/score_boundaries.mjs annotation.json mars-review.json report.json [detector|sam]",
  );
const annotation = validateAnnotation(
    JSON.parse(await readFile(annotationPath, "utf8")),
  ),
  run = JSON.parse(await readFile(exportPath, "utf8"));
if (
  run.format !== "mars-native-review-v1" ||
  run.source.original_sha256 !== annotation.source.original_sha256 ||
  run.source.width !== annotation.source.width ||
  run.source.height !== annotation.source.height
)
  throw new Error(
    "Review and predictions must identify exactly the same source bytes",
  );
const { width, height } = annotation.source,
  area = run.run?.region;
if (
  run.run?.status !== "complete" ||
  area?.x !== 0 ||
  area?.y !== 0 ||
  area?.width !== width ||
  area?.height !== height
)
  throw new Error(
    "Complete-image recall requires a completed scan covering this entire annotation image",
  );
const render = (g) => rasterGeometry(g, width, height),
  unknown = render(annotation.unknown || {});
const labels = annotation.instances.map((instance) => ({
  ...instance,
  coreMask: render(instance.core),
  envelopeMask: render(instance.envelope),
  visibleMask: instance.visible ? render(instance.visible) : null,
}));
// Uncertain instances are not silently scored as negative terrain.
for (const label of labels.filter((l) => l.class === "uncertain"))
  label.envelopeMask.forEach((v, i) => {
    if (v) unknown[i] = 1;
  });
const truth = labels.filter((l) => l.class === "fan"),
  raw = run.run.candidates;
if (method === "sam" && raw.some((c) => !run.refinements?.[c.id]))
  throw new Error(
    "SAM comparison requires tracing every proposal; scoring only successful selected traces would bias the comparison",
  );
const candidates = raw.map((c) => {
  const refined = run.refinements?.[c.id];
  return {
    ...c,
    mask: render(
      method === "sam" ? { ...refined, region: refined.input.region } : c,
    ),
  };
});
const known = (mask) => Uint8Array.from(mask, (v, i) => (unknown[i] ? 0 : v));
// An empty returned mask is still an unmatched proposal, not an unknown region.
const considered = candidates.filter(
  (c) => !c.mask.some(Boolean) || known(c.mask).some(Boolean),
);
const pairs = matchInstances(
    considered.map((c) => known(c.mask)),
    truth.map((t) => known(t.envelopeMask)),
    0.25,
  ),
  matched = new Set(pairs.map((p) => p.prediction));
const metrics = pairs.map((p) => ({
  candidate_id: considered[p.prediction].id,
  instance_id: truth[p.truth].id,
  match_iou: p.iou,
  ...boundaryMetrics(
    considered[p.prediction].mask,
    truth[p.truth].coreMask,
    truth[p.truth].envelopeMask,
    unknown,
    width,
    height,
    truth[p.truth].visibleMask,
    2,
  ),
}));
const union = (masks) => {
  const result = new Uint8Array(width * height);
  for (const mask of masks)
    mask.forEach((v, i) => {
      if (v) result[i] = 1;
    });
  return result;
};
const aggregate = boundaryMetrics(
  union(candidates.map((c) => c.mask)),
  union(truth.map((t) => t.coreMask)),
  union(truth.map((t) => t.envelopeMask)),
  unknown,
  width,
  height,
);
const possibleMerges = candidates
  .filter(
    (c) =>
      truth.filter((t) => {
        let core = 0,
          hit = 0;
        t.coreMask.forEach((v, i) => {
          if (v && !unknown[i]) {
            core++;
            if (c.mask[i]) hit++;
          }
        });
        return core && hit / core >= 0.25;
      }).length > 1,
  )
  .map((c) => c.id);
const count = pairs.length,
  ratio = (a, b) => (b ? a / b : null);
const report = {
  format: "mars-boundary-score-v1",
  method,
  source: annotation.source,
  split: annotation.split,
  reviewers: [annotation.reviewer, annotation.second_reviewer],
  model_id: run.run.model_id,
  analysis: run.run.analysis,
  match_rule:
    "one-to-one maximum-cardinality envelope IoU >= 0.25, excluding unknown pixels",
  boundary_tolerance_source_pixels: 2,
  counts: {
    definite_fans: truth.length,
    considered_predictions: considered.length,
    matched: count,
    unmatched_predictions: considered.length - count,
    missed_fans: truth.length - count,
    unknown_only_predictions: candidates.length - considered.length,
    empty_masks: candidates.filter((c) => !c.mask.some(Boolean)).length,
    uncertain_instances: labels.filter((l) => l.class === "uncertain").length,
  },
  precision: ratio(count, considered.length),
  recall: ratio(count, truth.length),
  aggregate,
  possible_merge_candidate_ids: possibleMerges,
  instances: metrics,
  unmatched_candidate_ids: considered
    .filter((_, i) => !matched.has(i))
    .map((c) => c.id),
  notes: [
    "Single-image report; aggregate by observation, not as independent pixels.",
    "IoU/Dice exclude explicit unknown pixels; when no visible mask exists, also exclude the core/envelope band.",
    "Metrics do not establish calibrated probability or physical dust density.",
  ],
};
const featuredIds = new Set(raw.slice(0, 3).map((c) => c.id));
report.featured = {
  considered: considered.filter((c) => featuredIds.has(c.id)).length,
  matched: pairs.filter((p) => featuredIds.has(considered[p.prediction].id))
    .length,
};
report.featured.precision = ratio(
  report.featured.matched,
  report.featured.considered,
);
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    output: outputPath,
    counts: report.counts,
    precision: report.precision,
    recall: report.recall,
  }),
);
