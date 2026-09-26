# Mars Fan Scout — weekend upgrade plan

## Implementation status · September 26, 2026

The primary app now accepts compatible image uploads, performs live Roboflow inference in overlapping 1024-pixel tiles, places segmentation masks on the new image, supports accept/reject/unsure review with browser-local persistence, and exports a self-contained JSON record. A bundled 2024 observation is available for the meeting; the historical catalog workflow is preserved separately. The upload path, a fresh crop from another observation, and a four-tile scan have been exercised in the browser.

A human-assisted historical wind-direction estimate is also implemented. Accepted elongated masks expose two possible source ends; the reviewer selects one, then the app draws the dust-travel arrow and a direction rose. The bundled crop uses north orientation derived from its HiRISE map label; uploads can provide north or stay image-relative. This direction feature has no independent accuracy measurement and does not report wind speed or current weather.

The independent check covered six crops, fewer than the planned 12–20. At the frozen 35% threshold, 16/25 considered candidates matched one of 16 clear pre-marked deposits within a generous 75 pixels; eight edge/ambiguous predictions were excluded. The proposed ≥70% over ≥30-candidate decision gate was **not met**. The app is therefore presented as human-assisted review, with these limited counts disclosed. Georeferencing, scientific validation, full-orbit JP2 ingestion, and returning corrections to Roboflow remain later work.

## Goal for Monday

Turn the current Mars Weather Report into a credible **candidate-discovery and review tool**. A visitor supplies a compatible HiRISE image crop (or selects a newly sourced observation), Roboflow outlines possible seasonal fans, and the visitor can inspect, accept, or reject each candidate. The result must not depend on a Planet Four lookup. The old catalog remains an optional historical comparison, not the source of the new image's answer.

This is a model-assisted survey of archived imagery, **not** a weather forecast or a claim of scientific discovery. A candidate becomes a confirmed fan only after human review.

## The 90-second demo

1. Open a 2024 south-polar HiRISE observation and show its NASA source, capture date, and the fact that it is outside our training observations and Planet Four's Mars Years 28–33 catalog.
2. Drop in a crop from that observation (or choose the sourced crop), then press **Scan image**. Animate real tile-by-tile inference; every outline comes from the Roboflow endpoint, not from saved marks.
3. Zoom to a few candidate fans. Show the source pixels, model confidence, mask, and estimated mask area. Accept one plausible candidate and reject a false positive. The queue and summary update immediately.
4. Show the **independent review card**: how many predictions were accepted and how many visible fans were missed on hand-checked, unseen crops. State the sample size and limitations.
5. Export the reviewed candidate list with image coordinates, mask geometry, confidence, reviewer decision, source observation ID, and model version. This is a useful artifact for follow-up analysis or improved training.

## Source and evaluation design

- Candidate source: [HiRISE ESP_082142_0935](https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935), captured February 3, 2024. Its map-projected RED JP2 and label are available from the [HiRISE PDS archive](https://hirise-pds.lpl.arizona.edu/PDS/RDR/ESP/ORB_082100_082199/ESP_082142_0935/). The JP2 is about 102 MB. Its label reports 0.5 m/pixel, so downsample by 2 before inference to match the existing training images' 1 m/pixel scale. Verify that the chosen crop visibly contains fans; a NASA article about an observation is not a ground-truth annotation.
- Choose a **second** post-catalog HiRISE observation for the locked evaluation set. Neither new observation may enter training, weak-label generation, or the app's reference lookup. Use the first observation for development and threshold tuning; leave the second untouched until the model and threshold are frozen. Record observation IDs and crop coordinates.
- Hand-check approximately 12–20 768-pixel crops across the two observations, including visually sparse/empty crops. On the locked set, mark all visible fans in each sampled crop and review all displayed model candidates. Report candidate precision and fan recall at the chosen threshold, the denominator for each, and examples of misses and false positives. These are limited human-review results, not expert-validated planetary-science ground truth.
- Retain the current 30.5% mAP@50 only as a **weak-label baseline**. Never call it 30.5% accuracy. Do not use catalog proximity as proof that an unmatched prediction is a new fan.

## Build order

### Saturday: prove the model contributes useful information

1. Download and visually inspect the 2024 source; extract 768-pixel crops at an effective 1 m/pixel without leaking catalog marks into the image or inference path.
2. Run the existing Roboflow model on several fan-rich and fan-poor crops. Review its results at multiple thresholds using only this development observation. If obvious false positives dominate, correct labels from the original training observations in Roboflow and train a new version. Freeze the chosen model and operating threshold before touching the independent evaluation images.
3. Select and reserve a second observation now, without inspecting its predictions. Hand-label a small, complete set of its crops after the model is frozen. Score candidate precision and fan recall once at the chosen threshold.
4. **Decision gate:** Aim for at least 70% of displayed high-confidence candidates to survive human review on at least 30 predictions from the locked observation; report recall separately across all visible fans in the reviewed crops. This is a demo-quality target, not a scientific performance standard. If the frozen model misses this target, do not quietly retune against the locked images. Present an honest human-in-the-loop error review rather than automated discovery, or collect a *new* untouched observation for another final test.

### Sunday: make it a product people can use

5. Add JPEG/PNG/WebP crop upload, input validation, and a server-side inference route. Keep the Roboflow key on the server. Accept appropriately scaled Mars polar imagery; explain the expected source and scale in the interface. A random landscape photo is out of scope.
6. Tile larger uploaded crops into the model's 768-pixel input with overlap, then merge predictions into the original coordinate system and suppress duplicates at tile boundaries. Cap upload dimensions for the meeting build. Full 100 MB JP2 observation ingestion is a later milestone; the curated 2024 crop can be extracted ahead of time.
7. Add a candidate review panel: zoomed evidence, confidence, predicted area in pixels (or approximate square meters only when scale is known), accept/reject/unsure, counts, and export. Store review decisions locally for the prototype; make the export self-contained.
8. Rework the motion around actual processing: overview → scanning tiles → candidates appearing → reviewed map. Show live/recorded state plainly. Remove the catalog-guided wind field from the primary path; preserve the current experience as a labeled historical comparison if time allows.
9. Rehearse on a fresh upload and the locked evaluation crop. Check latency, projector readability, mobile layout, API failures, accessibility/reduced motion, attribution, and that no key appears in browser assets. Save a clearly labeled recording only as a network fallback.

## Definition of done

- A user can submit a compatible image crop and receive **live Roboflow** predictions in the app.
- The new-image result works with **zero Planet Four records** for that observation.
- Every displayed measurement comes from a predicted mask, source metadata, or an explicit reviewer action, with its provenance visible.
- A reviewer can correct results and export decisions; no candidate is automatically labeled a discovery.
- The Monday presentation includes a fresh image, a real inference request, and independently hand-checked precision/recall with sample sizes. If accuracy is weak, the presentation says so.

## After Monday

Support entering any HiRISE observation ID and fetching/cropping its full map-projected product, georeference masks, persist reviewer decisions, send confirmed corrections back into Roboflow for retraining, and evaluate on more seasons and regions before scientific or public-use claims.

## References

- [Planet Four v3.1 catalog](https://zenodo.org/records/20054589) and [project overview](https://michaelaye.github.io/projects/planet-four/) (469 HiRISE observations, Mars Years 28–33).
- [HiRISE 2024 source observation](https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935) and [PDS RED product directory](https://hirise-pds.lpl.arizona.edu/PDS/RDR/ESP/ORB_082100_082199/ESP_082142_0935/).
- [Current Roboflow model](https://app.roboflow.com/matt-abrams/mars-polar-fan-masks/1).
