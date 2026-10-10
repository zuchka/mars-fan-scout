import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { validateAnnotation } from "../public/boundary-metrics.js";
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: node scripts/validate_boundary_benchmark.mjs manifest.json",
  );
const manifest = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(manifest.annotations) || !manifest.annotations.length)
  throw new Error("Benchmark requires an annotations array of file paths");
const observations = new Map(),
  sources = new Set(),
  counts = { train: 0, development: 0, final: 0 };
const exposed = new Set([
  "ESP_082142_0935",
  "ESP_082241_0950",
  "ESP_092344_0970",
]);
const queue = JSON.parse(
  await readFile(
    resolve(
      import.meta.dirname,
      "../evaluation/demo-repair/annotation-queue.json",
    ),
    "utf8",
  ),
);
for (const chip of queue.chips) exposed.add(chip.observation);
for (const file of manifest.annotations) {
  const a = validateAnnotation(
    JSON.parse(await readFile(resolve(dirname(path), file), "utf8")),
  );
  if (!(a.split in counts))
    throw new Error("Split must be train, development, or final");
  const s = a.source;
  if (sources.has(s.original_sha256)) throw new Error("Duplicate source image");
  sources.add(s.original_sha256);
  if (
    observations.has(s.observation) &&
    observations.get(s.observation) !== a.split
  )
    throw new Error(`Observation leaks between splits: ${s.observation}`);
  if (a.split === "final" && exposed.has(s.observation))
    throw new Error(
      `Already inspected observation cannot be a fresh final test: ${s.observation}`,
    );
  observations.set(s.observation, a.split);
  counts[a.split]++;
}
console.log(
  JSON.stringify(
    {
      valid: true,
      images: counts,
      observations: Object.fromEntries(observations),
      note: "Also group shared geographic sites/seasons manually; IDs alone do not establish independence.",
    },
    null,
    2,
  ),
);
