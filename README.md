# Mars Fan Scout

A live Mars image demo. RF-DETR Seg proposes possible dark fan deposits in a HiRISE crop. The viewer features three substantial regions and keeps every proposal inspectable. An optional SAM 3 call uses RF-DETR boxes to trace fuller edges. Select a region to inspect its source pixels. Neither model confirms that a region is a fan.

The viewer shows no fan-likelihood percentage. RF-DETR confidence ranks detections, but it has not been calibrated as a probability that a proposed region is a genuine Martian fan. SAM 3's box-prompt score describes its segmentation response, not an independent fan classification. A future fan-versus-lookalike model would need reviewed positive and hard-negative crops plus a separate held-out calibration check.

## Native pixels and diffuse boundaries

The bundled sample now retains a **2048 × 2048, 16-bit source extraction**. Supported uploads preserve their exact original bytes and dimensions. A separate overview keeps navigation fast; native region reads power pan/zoom, 1:1 inspection, and selected-candidate SAM tracing. Display and current model inputs use a documented 8-bit derivative. Download original returns the retained source.

Detection offers a scale-matched baseline (1 m/pixel for the sample) and native-pixel tiles as an experiment. Neither setting bypasses any resizing inside the hosted model; its effective internal resolution is not verified. Native scans use overlapping 1024-pixel tiles, up to 25 per job, with two concurrent provider calls. Preview resolution never defines stored geometry. The app shows request estimates, coverage, partial results, cancellation and retry of unfinished tiles. Requests already dispatched may finish after cancellation and still count toward the allowance.

Select any proposal and choose **Trace selected with SAM 3**. It receives a native crop with surrounding terrain, with tighter/standard/wider context controls. Orange is the detector proposal; cyan is the SAM raster boundary. The new path requests COCO RLE and retains disconnected components and holes in display and export. It does not receive raw logits or claim calibrated boundary probabilities. API capability is documented by the provider's [OpenAPI schema](https://serverless.roboflow.com/openapi.json).

**Explore diffuse extent** is an optional, experimental local-contrast estimate. It grows connected dark signal from detector or user seeds, shows a continuous relative-contrast field, permits include/exclude clicks, undo and reset, and flags weak contrast, excessive growth, crop-edge contact and sensitivity to threshold changes. The analysis grid is explicitly shown (up to 512 pixels per side); this limit affects the experiment, not the original or native SAM crop. It is not validated fan membership, an alpha matte or a physical dust measurement. The initial automatic estimate and edited result remain separate in exports.

Accept/reject/unsure decisions belong to the human reviewer. IndexedDB restores reviews by source hash, model and preprocessing; saved results show their original timestamps. Raw model results, transforms, scan coverage, raster masks, edit seeds, relative-contrast fields and decisions can be exported as JSON and re-imported on a deployment with the matching source/model. Returning to the sample restores its saved review. Server uploads/jobs live in `.scout/`, outside public assets. Browser quota failure prompts an export rather than silently claiming persistence. Uploads share the meeting-code access boundary; this demo does not provide separate user accounts.

**Live deployment:** [mars.zuchka.dev](https://mars.zuchka.dev/) runs through a Cloudflare Worker and a Fly Sprite. These native-pipeline changes are local until deployed; see [deployment instructions](DEPLOY_SPRITES.md).

**Implementation roadmap:** [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) records completed engineering and remaining data/model validation. The [boundary evaluation workbench](evaluation/boundaries/README.md) supplies 24 pending review templates, source/split validation, and boundary scoring. No corrected-label model or new accuracy claim has been produced.

The prior visual-review model experiment is retired from the live demo. Its historical plans and evaluation artifacts remain in the repository for audit, and existing review records remain readable/exportable. The server does not connect to or call its GPU service.

## Run the demo

From this directory:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4173>. The existing local `.env.local` contains the configured Roboflow API key; it is ignored and must not be committed or shared. On another computer, copy `.env.example` to `.env.local` and set `ROBOFLOW_API_KEY`, `ROBOFLOW_MODEL_ID`, and `ROBOFLOW_MODEL_TRAINING=0`. The server keeps the key out of browser assets. The primary app requires a live model connection; a replay is available only in the clearly labeled historical atlas.

For a walkthrough, enter the meeting code and let the home page scan the bundled **Spiders in Manhattan** crop. Select a proposed region to inspect its source pixels, then optionally trace the selected region with SAM 3 and explore its diffuse extent. The source crop is from [HiRISE ESP_082142_0935](https://hirise.lpl.arizona.edu/hipod/ESP_082142_0935), captured February 3, 2024. The outlines are review suggestions, not confirmed fan discoveries.

To test a fresh upload, use a HiRISE south-polar JPG, PNG, or WebP, at most **32 MiB / 16 megapixels**, with each side at least 256 pixels. The server retains original bytes, applies EXIF orientation only to derivatives, and extracts bounded analysis crops. Unknown pixel scale remains unknown. These limits are enforced rather than silently shrinking larger uploads.

The optional **Full observation** button opens the existing 17007 × 16131 JP2 through bounded OpenJPEG region decoding. Set `SCOUT_ORBIT_PATH` to the exact prepared product and `SCOUT_PYTHON` to Python with NumPy/Pillow; install OpenJPEG so `opj_decompress` is on PATH. The original hash is checked at startup. The local checkout auto-detects the source in `../data/planet-four/images/`. General JP2 uploads, arbitrary observation ingestion, georeferencing, and persistent shared review accounts remain future work.

Run `npm test` for regression checks. Rebuild native sample assets with `scripts/prepare_native_sources.py` only when changing their versioned preparation recipe. Current full-observation cache limits are 48 regions / 256 MiB; source uploads have a default 2 GiB quota. Cached derivatives may be evicted, while originals remain until an explicit operator removal. Preserve `.scout/` and `.demo-usage.json` across restarts.

The historical atlas saves reviews and any user-entered north orientation in browser local storage by image hash and pixel scale. Its **Download review JSON** and **View / copy JSON** controls expose source and model provenance, image-relative polygons, approximate area, human decisions, selected source ends, and derived bearings. Coordinates are **not georeferenced**. The bundled crop's 99.6° north orientation is calculated at its center from the HiRISE polar-stereographic map label with `scripts/calculate_sample_north.py`; uploaded-image orientations are user supplied and unverified.

## What the model actually contributes

Roboflow finds and outlines candidate dark deposits in new image pixels without a Planet Four record for that observation. The home page makes those masks inspectable; SAM 3 can suggest fuller edges. In the historical atlas, a reviewer can accept a mask and choose its source end, allowing local geometry to estimate the direction dust traveled **when that deposit formed**. The models do **not** verify that a mask is a real fan, infer wind speed, or make a present-day weather forecast. The atlas also uses Planet Four directions; those arrows should not be described as model predictions.

**Direction accuracy has not been measured.** The held-out check below evaluates whether mask candidates appeared near hand-marked deposits; it does not validate source-end choices or bearings. Treat the arrows as review hypotheses, especially where masks merge deposits or the fan shape is ambiguous.

The trained RF-DETR segmentation model reported **30.5% mAP@50, 43.1% precision, and 55.0% recall** on weak labels from an orbit held out of training. These are benchmark metrics against imperfect derived masks, **not 30.5% accuracy** or a scientific ground truth result.

A historical visual check used a second HiRISE observation, [ESP_082241_0950](https://hirise.lpl.arizona.edu/ESP_082241_0950), which was initially reserved before predictions were inspected. It has since informed development and is no longer an untouched final test. Before seeing predictions, a non-expert marked 16 clear complete deposits across six fixed crops. At the frozen 35% threshold, 16 of those 16 marks had one model candidate center within 75 pixels; 9 additional considered predictions were unmatched; 8 edge/ambiguous predictions were excluded under recorded rules. Thus **16 of 25 considered displayed candidates matched a clear mark (64%)**. This is a point-proximity triage check on selected clear deposits, not expert-verified precision or comprehensive recall. The sample is small and the 75-pixel tolerance is generous. The target in [NEXT_LEVEL_PLAN.md](NEXT_LEVEL_PLAN.md) was at least 70% accepted candidates over at least 30 predictions, so **the gate was not met**. Present the system as assisted review, not autonomous discovery.

The reproducible crop coordinates and review marks are in `evaluation/locked/manifest.json` and `evaluation/locked/review-points.json`; frozen model responses and scoring are in `evaluation/locked/predictions/` and `evaluation/locked/score.json`. `scripts/prepare_locked_review.py` rebuilds crops from the source JP2, and `scripts/evaluate_locked.py` scores the frozen responses. Large JP2 source files live in `../data/planet-four/images/` and are region-decoded only when the full-observation source is configured; its original can then be downloaded explicitly.

## Attribution

HiRISE image credit: NASA/JPL-Caltech/UArizona. Historical Planet Four catalog: Aye et al. 2026, CC BY 4.0 ([data](https://zenodo.org/records/20054589)).
