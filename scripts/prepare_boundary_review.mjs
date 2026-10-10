import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import sharp from "sharp";
import { sha } from "../scout/source-store.mjs";
const root = resolve(import.meta.dirname, ".."),
  queue = JSON.parse(
    await readFile(
      resolve(root, "evaluation/demo-repair/annotation-queue.json"),
      "utf8",
    ),
  );
const directory = resolve(
  process.argv[2] || resolve(root, "evaluation/boundaries/pending"),
);
await mkdir(directory, { recursive: true });
for (const chip of queue.chips) {
  const image = await readFile(resolve(root, chip.local_image)),
    meta = await sharp(image).metadata();
  const template = {
    format: "mars-boundary-review-v1",
    status: "needs_human_annotation",
    source: {
      name: chip.image,
      original_sha256: sha(image),
      width: meta.width,
      height: meta.height,
      observation: chip.observation,
      image: chip.local_image,
      pixel_scale_m: null,
      coordinate_convention:
        "pixel edges in this retained chip; not coordinates in the parent JP2",
      normalization:
        "Existing training JPEG; pre-export stretch not recoverable",
    },
    split: "train",
    reviewer: null,
    second_reviewer: null,
    coverage_complete: false,
    unknown: { polygons: [] },
    instances: [],
    notes: [
      "Annotate the source before exposing model proposals. No weak labels have been copied into this template.",
      "Do not mark coverage complete until every visible instance and ambiguous region has been reviewed.",
    ],
  };
  try {
    await writeFile(
      resolve(directory, basename(chip.image) + ".json"),
      JSON.stringify(template, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
console.log(
  `Prepared ${queue.chips.length} review templates in ${directory}; existing annotations preserved.`,
);
