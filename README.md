# Mars Fan Scout

A live Mars image demo. RF-DETR Seg proposes possible dark fan deposits in a HiRISE crop. The viewer features three substantial regions and keeps every proposal inspectable. An optional SAM 3 call uses RF-DETR boxes to trace fuller edges. Select a region to inspect its source pixels. Neither model confirms that a region is a fan.

The viewer shows no fan-likelihood percentage. RF-DETR confidence ranks detections, but it has not been calibrated as a probability that a proposed region is a genuine Martian fan. SAM 3's box-prompt score describes its segmentation response, not an independent fan classification. A future fan-versus-lookalike model would need reviewed positive and hard-negative crops plus a separate held-out calibration check.

## Optional SAM 3 tracing

After RF-DETR proposes regions, **Trace with SAM 3** sends the original crop and padded boxes for the three featured regions to Roboflow's [SAM 3 box-prompt endpoint](https://blog.roboflow.com/gpt-6-astra-for-segmentation/). Orange remains the RF-DETR core; cyan is SAM 3's proposed edge. Three boxes are batched into one additional Roboflow request, which counts against the daily scan allowance. The browser remembers the scan and traced edges across refreshes in the current tab.

The [three-region sample comparison](evaluation/sam3-pilot/comparison.jpg) shows fuller dark outlines on the bundled crop, but a box centered on only part of a plume can still miss the rest or include adjacent terrain. One local three-box request on 2026-10-01 took 1.2 seconds; this is a single-crop observation, not a latency guarantee or a validated boundary score. Roboflow's [published serverless rates](https://docs.roboflow.com/deployment/roboflow-cloud/serverless-api/model-pricing) on 2026-10-01 are 0.25 credits per 1,000 images for RF-DETR Seg Small and 0.5 for SAM 3.

**Live deployment:** [mars.zuchka.dev](https://mars.zuchka.dev/) runs through a Cloudflare Worker and a Fly Sprite. The meeting code gates paid Roboflow calls. See [deployment instructions](DEPLOY_SPRITES.md). The source checkout may have changes that have not yet been deployed.

The prior visual-review model experiment is retired from the live demo. Its historical plans and evaluation artifacts remain in the repository for audit, and existing review records remain readable/exportable. The server does not connect to or call its GPU service.

## Run the demo

From this directory:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4173>. The existing local `.env.local` contains the configured Roboflow API key; it is ignored and must not be committed or shared. On another computer, copy `.env.example` to `.env.local` and set `ROBOFLOW_API_KEY`, `ROBOFLOW_MODEL_ID`, and `ROBOFLOW_MODEL_TRAINING=0`. The server keeps the key out of browser assets. The primary app requires a live model connection; a replay is available only in the clearly labeled historical atlas.

For a walkthrough, enter the meeting code and let the home page scan the bundled **Spiders in Manhattan** crop. Select a proposed region to inspect its source pixels, then optionally trace the featured edges with SAM 3. The source crop is from [HiRISE ESP_082142_0935](https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935), captured February 3, 2024. The outlines are review suggestions, not confirmed fan discoveries.

To test a fresh upload on the home page, use a map-projected HiRISE south-polar crop in JPG, PNG, or WebP format, at most 8 MB and 3072 pixels on either side. The browser fits it within 1024 pixels, then sends that working crop to Roboflow. The simple home page does not infer pixel scale or wind direction. For the older tiled scanning and direction workflow, use `/archive.html`. Full HiRISE JP2 ingestion, georeferencing, and persistent shared review accounts are future work.

The historical atlas saves reviews and any user-entered north orientation in browser local storage by image hash and pixel scale. Its **Download review JSON** and **View / copy JSON** controls expose source and model provenance, image-relative polygons, approximate area, human decisions, selected source ends, and derived bearings. Coordinates are **not georeferenced**. The bundled crop's 99.6° north orientation is calculated at its center from the HiRISE polar-stereographic map label with `scripts/calculate_sample_north.py`; uploaded-image orientations are user supplied and unverified.

## What the model actually contributes

Roboflow finds and outlines candidate dark deposits in new image pixels without a Planet Four record for that observation. The home page makes those masks inspectable; SAM 3 can suggest fuller edges. In the historical atlas, a reviewer can accept a mask and choose its source end, allowing local geometry to estimate the direction dust traveled **when that deposit formed**. The models do **not** verify that a mask is a real fan, infer wind speed, or make a present-day weather forecast. The atlas also uses Planet Four directions; those arrows should not be described as model predictions.

**Direction accuracy has not been measured.** The held-out check below evaluates whether mask candidates appeared near hand-marked deposits; it does not validate source-end choices or bearings. Treat the arrows as review hypotheses, especially where masks merge deposits or the fan shape is ambiguous.

The trained RF-DETR segmentation model reported **30.5% mAP@50, 43.1% precision, and 55.0% recall** on weak labels from an orbit held out of training. These are benchmark metrics against imperfect derived masks, **not 30.5% accuracy** or a scientific ground truth result.

A second, newer HiRISE observation, [ESP_082241_0950](https://hirise.lpl.arizona.edu/ESP_082241_0950), was reserved for a small independent visual check. Before seeing predictions, a non-expert marked 16 clear complete deposits across six fixed crops. At the frozen 35% threshold, 16 of those 16 marks had one model candidate center within 75 pixels; 9 additional considered predictions were unmatched; 8 edge/ambiguous predictions were excluded under recorded rules. Thus **16 of 25 considered displayed candidates matched a clear mark (64%)**. This is a point-proximity triage check on selected clear deposits, not expert-verified precision or comprehensive recall. The sample is small and the 75-pixel tolerance is generous. The target in [NEXT_LEVEL_PLAN.md](NEXT_LEVEL_PLAN.md) was at least 70% accepted candidates over at least 30 predictions, so **the gate was not met**. Present the system as assisted review, not autonomous discovery.

The reproducible crop coordinates and review marks are in `evaluation/locked/manifest.json` and `evaluation/locked/review-points.json`; frozen model responses and scoring are in `evaluation/locked/predictions/` and `evaluation/locked/score.json`. `scripts/prepare_locked_review.py` rebuilds crops from the source JP2, and `scripts/evaluate_locked.py` scores the frozen responses. Large JP2 source files live in `../data/planet-four/images/` and are not served by the app.

## Attribution

HiRISE image credit: NASA/JPL-Caltech/UArizona. Historical Planet Four catalog: Aye et al. 2026, CC BY 4.0 ([data](https://zenodo.org/records/20054589)).
