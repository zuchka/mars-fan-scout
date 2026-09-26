# Mars Weather Report — weekend build plan

> Historical plan for the archived `/archive.html` experience. The meeting-ready primary workflow and its current limitations are in [NEXT_LEVEL_PLAN.md](NEXT_LEVEL_PLAN.md) and [README.md](README.md).

## The 90-second meeting demo

1. Open a real HiRISE observation from Mars's south polar spring. The image begins unmarked.
2. Run Roboflow inference, then reveal **pixel-level dark-deposit masks** on the image. Each predicted outline and confidence is inspectable.
3. Switch to **wind field**. Where a model mask is near a Planet Four catalog mark, its historical bearing contributes to an animated, explicitly labeled catalog-guided field. The interface never claims wind speed or a live weather forecast.
4. Select one vector to trace the evidence backward: vector → model mask → Planet Four bearing → source image. Toggle to the cyan catalog-location layer for comparison.
5. Run a second, held-out image through the Roboflow model in the meeting. This is the proof that the result is vision inference rather than pre-drawn animation.

## Why Roboflow is essential

The input is imagery, not a weather table. A Roboflow instance-segmentation model locates individual dark deposits and outlines them at pixel level. The app cross-references each predicted mask with a nearby Planet Four fan mark, using that catalog mark's orientation for the historical wind direction. Spatial binning turns matched detections into the animated field; unmatched model masks remain visible as review candidates. Without Roboflow predictions, the model-guided field cannot be produced. Roboflow also provides a dataset version, validation images, model endpoint, and an inspectable prediction result.

The bundled Planet Four annotations are explicitly **reference data**, useful for training and comparison. The interface must never label them as model predictions.

## Work packages

### A. Data and provenance

- Use Planet Four v3.1 fan catalog (CC BY 4.0) and HiRISE image products (NASA/JPL-Caltech/UArizona attribution).
- Extract small image chips from real map-projected HiRISE images. Export a single-class COCO polygon dataset from fan geometry, retaining observation and tile IDs.
- Split by observation, not random chip, to prevent nearby patches leaking into validation.
- Curate three great-looking scenes: a sparse scene that makes individual fans legible, a dense scene with a dramatic field, and a held-out scene for inference.

### B. Model

- Use the Roboflow instance-segmentation project `matt-abrams/mars-polar-fan-masks`; import the refined COCO data and check polygon placement in Annotate. Keep `mars-polar-wind-fans` as the failed first baseline.
- Generate a version with conservative preprocessing; train a segmentation model; inspect precision, recall, and failure examples on held-out observations.
- Connect the version's hosted endpoint through a server-side API key. The browser receives only predictions, never the key.
- Cross-reference predicted mask locations with nearby catalog fan marks; draw arrows only for matched masks and label the resulting field as catalog-guided. Keep unmatched predictions visible for review.

### C. Product/UI

- Desktop-first observatory composition: large real image, restrained mission telemetry, dark-ice palette, rust and electric-cyan inference layers.
- Three-stage reveal: raw image → individual detections → coherent wind field. Each stage uses the same pixel positions; motion never changes the underlying evidence.
- Reference/model toggle, source metadata, selected-fan detail, confidence threshold, pause/replay, and reduced-motion support.
- Clear model-connection state. When the model is unavailable, the reference demonstration remains useful and honestly labeled.

### D. Rehearsal

- Run one known image and one held-out image through the actual model. Save outputs for an offline fallback, labeled as recorded model output.
- Test at projector resolution, laptop resolution, and mobile width. Verify source attribution and ensure no API key appears in client assets or logs.
- Rehearse the 90-second path and confirm a fresh inference completes within an acceptable pause.

## Build status — September 26

- Roboflow workspace **Mars Weather Lab** and project **Mars Polar Wind Fans** are created. Version 1 has 86 768-pixel image chips and a 68/9/9 train/validation/test split. The validation and test chips are from an orbit absent from training.
- The first RF-DETR Instance Segmentation Small model, `matt-abrams/mars-polar-wind-fans-1-rfdetr-seg-small-t1`, completed but scored 0% mAP@50 on its held-out test set. Live API calls returned zero predictions on all three bundled observations. It is a failed baseline, not a meeting-ready model. The local app has a private key in ignored `.env.local`; that model remains disabled in the UI.
- Visual review found that the first exported fan polygons used a sector cap rather than Planet Four's rounded downstream cap. The local generator, reference layer, and COCO export now use the correct semicircle. **Version 1 still contains the earlier approximate polygons**; evaluate it before deciding whether to upload/train a corrected version.
- A second Roboflow project, [Mars Polar Fan Masks](https://app.roboflow.com/matt-abrams/mars-polar-fan-masks/1), uses catalog-guided adaptive contrast to snap approximate fan locations to dark image regions. Its 86 chips contain 2,606 refined weak-label polygons: 68 train chips from three orbits, then 9 validation and 9 test chips from a fourth orbit absent from training. The masks were sampled visually, but are still algorithmically derived and incomplete.
- Its RF-DETR Instance Segmentation Small model, `matt-abrams/mars-polar-fan-masks-1-rfdetr-seg-small-t1`, completed around 8:23 AM Pacific. Roboflow reports **30.5% mAP@50, 43.1% precision, 55.0% recall, 48.3% F1** on the held-out test chips. Training consumed 0.42 credits. The test set is from an orbit absent from training, though validation chips share that orbit.
- Live hosted inference works on all three bundled observations. At a 20% server threshold, Roboflow returned 99, 97, and 88 masks respectively; at the app's default 35% threshold, the unseen orbit shows 22 masks, 16 near a catalog mark. Mask-only direction estimates proved unstable, so the app transparently uses Planet Four orientation to guide arrows at model-matched locations. It does not claim an independent model bearing.
- The local app is connected to the refined model. Its API key is held only server-side in ignored `.env.local`. Real responses for all three observations are saved under `recorded/`; `ROBOFLOW_REPLAY=1` enables a visibly labeled meeting fallback. Live mode remains the default.

## Sources

- Planet Four v3.1 data: https://zenodo.org/records/20054589
- Planet Four project and interpretation: https://michaelaye.github.io/projects/planet-four/
- HiRISE observation source: https://hirise.lpl.arizona.edu/ESP_011296_0975
- Roboflow hosted inference: https://inference.roboflow.com/quickstart/roboflow_ecosystem/
- Roboflow refined project version: https://app.roboflow.com/matt-abrams/mars-polar-fan-masks/1
- Roboflow trained model evaluation: https://app.roboflow.com/matt-abrams/mars-polar-fan-masks/trainings/22b4ae29b600c34ab81f?fromVersion=1
