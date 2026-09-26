# Mars Fan Scout

A live, human-in-the-loop Mars image review demo. Upload a compatible south-polar HiRISE crop, or use the bundled 2024 crop. The app sends image tiles to a Roboflow instance-segmentation model, places its predicted masks back on the source image, and lets a person accept, reject, or flag each candidate. The primary workflow makes **no Planet Four catalog lookup**. The original catalog-guided Mars Weather Report remains at `/archive.html` as a historical comparison.

## Run the demo

From this directory:

```sh
node server.mjs
```

Open <http://127.0.0.1:4173>. The existing local `.env.local` contains the configured Roboflow API key; it is ignored and must not be committed or shared. On another computer, copy `.env.example` to `.env.local` and set `ROBOFLOW_API_KEY`, `ROBOFLOW_MODEL_ID`, and `ROBOFLOW_MODEL_TRAINING=0`. The server keeps the key out of browser assets. The primary app requires a live model connection; a replay is available only in the clearly labeled historical atlas.

For the Monday walkthrough, select **Spiders in Manhattan**, press **Scan with Roboflow**, open a directional mask, and accept it. The enlarged source crop marks the two ends of the mask A and B. Choose the end where the dust appears to originate; the app draws a dust-travel arrow and adds that reviewed fan to the direction rose. Flip A/B to show why the human decision matters, then reject a different candidate and show **View / copy JSON**. The 2024 source crop is from [HiRISE ESP_082142_0935](https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935), captured February 3, 2024. Its source label reports 0.5 m/pixel; the bundled crop is resampled to the model's 1 m/pixel working scale. It is a development/demo image, not the independent check. The live scan typically takes a few seconds, subject to the inference service.

To test a fresh upload, use a map-projected HiRISE south-polar crop in JPG, PNG, or WebP format, at most 8 MB and 3072 pixels on either side. Choose the source pixel scale before scanning. At known 0.25 or 0.5 m/pixel scales, the browser downsamples to 1 m/pixel; unknown scale remains uncalibrated and area is reported only in pixels. The upload is tiled at up to 1024 working pixels with 128-pixel overlap, sent live to Roboflow through the local server, and duplicate predictions are suppressed. You may enter the angle of geographic north clockwise from image top for an uploaded crop. If you do not know that orientation, the app keeps the direction estimate relative to image top and does not claim a compass bearing. Full HiRISE JP2 ingestion, georeferencing, and persistent shared review accounts are future work.

Reviews and any user-entered north orientation are saved in browser local storage by image hash and pixel scale. **Download review JSON** produces a file where browser downloads are supported; **View / copy JSON** exposes the same record for browsers that block local downloads. The version 2 record includes source and model provenance, all masks above the 20% inference floor, the current display threshold, image-relative polygons, approximate area, human decisions, reviewer-selected source ends, and any derived dust-travel and wind-from bearings. Coordinates are **not georeferenced**. The bundled crop's 99.6° north orientation is calculated at its center from the HiRISE polar-stereographic map label with `scripts/calculate_sample_north.py`; uploaded-image orientations are user supplied and unverified.

## What the model actually contributes

Roboflow finds and outlines candidate dark deposits in new image pixels without a Planet Four record for that observation. The app then makes those masks inspectable and correctable. For an accepted, elongated mask, local geometry finds its long axis, and a reviewer identifies the source end. The resulting arrow estimates the direction dust traveled **when that deposit formed**. If image north is known, the app also shows compass bearings and the opposite wind-from bearing. The model itself does **not** choose the source end, infer wind speed, make a present-day weather forecast, or verify that any one mask is a real fan. Round or small masks do not get a direction. The historical atlas separately uses Planet Four directions; its wind arrows should not be described as model predictions.

**Direction accuracy has not been measured.** The held-out check below evaluates whether mask candidates appeared near hand-marked deposits; it does not validate source-end choices or bearings. Treat the arrows as review hypotheses, especially where masks merge deposits or the fan shape is ambiguous.

The trained RF-DETR segmentation model reported **30.5% mAP@50, 43.1% precision, and 55.0% recall** on weak labels from an orbit held out of training. These are benchmark metrics against imperfect derived masks, **not 30.5% accuracy** or a scientific ground truth result.

A second, newer HiRISE observation, [ESP_082241_0950](https://hirise.lpl.arizona.edu/ESP_082241_0950), was reserved for a small independent visual check. Before seeing predictions, a non-expert marked 16 clear complete deposits across six fixed crops. At the frozen 35% threshold, 16 of those 16 marks had one model candidate center within 75 pixels; 9 additional considered predictions were unmatched; 8 edge/ambiguous predictions were excluded under recorded rules. Thus **16 of 25 considered displayed candidates matched a clear mark (64%)**. This is a point-proximity triage check on selected clear deposits, not expert-verified precision or comprehensive recall. The sample is small and the 75-pixel tolerance is generous. The target in [NEXT_LEVEL_PLAN.md](NEXT_LEVEL_PLAN.md) was at least 70% accepted candidates over at least 30 predictions, so **the gate was not met**. Present the system as assisted review, not autonomous discovery.

The reproducible crop coordinates and review marks are in `evaluation/locked/manifest.json` and `evaluation/locked/review-points.json`; frozen model responses and scoring are in `evaluation/locked/predictions/` and `evaluation/locked/score.json`. `scripts/prepare_locked_review.py` rebuilds crops from the source JP2, and `scripts/evaluate_locked.py` scores the frozen responses. Large JP2 source files live in `../data/planet-four/images/` and are not served by the app.

## Attribution

HiRISE image credit: NASA/JPL-Caltech/UArizona. Historical Planet Four catalog: Aye et al. 2026, CC BY 4.0 ([data](https://zenodo.org/records/20054589)).
