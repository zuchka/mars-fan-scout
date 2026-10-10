# Boundary review and evaluation

This workbench separates fan recognition from extent quality. It does not contain completed human labels or an accuracy claim. The 24 files in `pending/` are empty review templates generated from the existing training queue; weak masks have deliberately not been copied into them.

## Annotation contract

`mars-boundary-review-v1` identifies the exact retained image with SHA-256, dimensions, observation, coordinate convention and normalization. Geometry uses pixel edges in that image, with x right and y down. The current queue consists of retained training JPEG chips: these are not claimed to be full-resolution parent JP2s.

Each instance has a unique `id`, `class` (`fan`, `lookalike`, `uncertain`), conservative `core`, and plausible `envelope`. Optionally add a reviewed binary `visible` extent. Supply explicit image-level `unknown` regions wherever the image cannot be judged. Geometry is either `{ "polygons": [[[x,y], ...], ...] }` or `{ "rle": { "size": [height,width], "counts": [...] } }`. Polygon lists represent a union; use COCO RLE for holes. RLE may use compressed COCO counts. A cropped raster must also supply `region: {x,y,width,height}` in source coordinates. Preserve the original grid whenever practical.

A core must fit inside its envelope. A visible extent must contain the core and fit inside the envelope. Do not derive these annotations by simply accepting detector masks. Review the source before revealing predictions. Complete every visible fan, touching instance, ridge/shadow/rock lookalike, and unjudgeable region. Record `coverage_complete: true` only after reviewing the entire chip; an empty instance list otherwise says nothing about negatives. `reviewer` and `second_reviewer` must identify two different human reviewers. Review particularly ambiguous boundaries and all proposed negative chips twice.

Assign `split` as `train`, `development`, or `final`. Keep neighboring crops, observations and where possible related sites/seasons in the same split. The inspected sample, locked check and rocky stress observation are development evidence. They cannot become a fresh final test by renaming the folder.

## Commands

```sh
# Creates missing templates without overwriting existing annotations.
npm run prepare:boundary-review

# manifest.json contains {"annotations":["path/to/completed-review.json", ...]}.
npm run validate:benchmark -- manifest.json

# Export a completed entire-image scan from the homepage, using the same bytes.
npm run score:boundaries -- reviewed.json mars-review.json detector-score.json detector
npm run score:boundaries -- reviewed.json mars-review.json sam-score.json sam
```

The validator requires completed coverage, two reviewer identities, valid geometry, one split per observation and no duplicate sources. It rejects already exposed observations as final tests. Geographic independence still needs human review. The scorer requires a matching source hash and complete-image scan. It refuses selective SAM comparisons until every displayed proposal has a trace. It uses a fixed maximum-cardinality, one-to-one envelope IoU match threshold of 0.25; do not tune this threshold on final results.

Reports include all-proposal and featured-subset precision, comprehensive recall, missed cores, background leakage, IoU/Dice on evaluable pixels, optional visible-boundary F1 at two source pixels, and possible instance merges. Explicit unknown pixels and uncertain instances are excluded. Without an explicit visible mask, the core/envelope band is also excluded from IoU/Dice. Aggregate omission/leakage includes unmatched predictions and missed fans. Boundary scores for matched instances are reported separately to avoid disguising missed detections. Null metrics mean the denominator is empty, not a perfect score.

Compare the same extents and observations with the old reduced baseline, native-crop SAM, native/scale-matched tiled detection, and optional fringe estimation. Aggregate by observation and report denominators; individual pixels are not independent samples. The fringe field is relative darkness connected to seeds, not a calibrated probability, opacity matte, or dust density. Use its recorded grid, parameters and sensitivity-area range to study instability; the current scorer scores binary detector/SAM masks only. Fringe comparisons need a declared threshold before evaluation.

## Promotion gates still pending

- Complete the 24-chip training queue with actual human reviews and hard negatives.
- Select fresh final observations before looking at model output, and freeze acceptable recall and leakage thresholds on development data.
- Retrain RF-DETR on corrected masks; check the hosted trainer's ignore-band support. Standard COCO polygons alone cannot encode unknown bands or continuous targets.
- Compare corrected models and classical/learned extent methods. No new detector has been trained or promoted by this implementation.
