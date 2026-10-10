# Mars Fan Scout improvement plan

Prepared October 9, 2026. Status: engineering implementation is available locally; deployment and human-reviewed accuracy gates remain pending. This is the current roadmap for the RF-DETR and SAM 3 homepage. Earlier plans remain historical records.

Preserve the original image and its pixel values, inspect deposits at native resolution, improve candidate tracing, and represent diffuse boundaries honestly. Deliver the reliable viewing and refinement improvements first. Promote new segmentation methods only after comparison with reviewed examples, including faint deposits and rocky lookalikes.

The intended demo experience is: open a sourced Mars image, zoom into its original pixels, scan a chosen area, compare a proposed core with an estimated extent, correct or reject a proposal, and export the evidence. A small overview can make navigation fast while the original remains available for every detailed operation.

## Implementation status — October 9, 2026

Implemented: immutable source uploads and 16-bit native sample, bounded original-region decoding, native viewer, layer controls, explicit image transforms, source hashes, saved-result provenance, overlapping tiled jobs with accounting/cancel/retry/restart recovery, mask-overlap deduplication, selectable native SAM crops with verified RLE output, optional connected-contrast fringe experiment with edit seeds and stability warnings, review/export, persistent jobs, upload quota/cache bounds, and independent feature flags. The 24-chip annotation queue now has source-hashed empty review templates plus split validation and boundary/instance scoring tools.

Verified locally: the sample aligns with the historical image; a JP2 native region exactly matches the retained source under the same normalization; live RF-DETR and raster SAM requests work; browser restoration and evidence export preserve results. See `evaluation/native-validation.json` for the final verification record. Browser inspection uses native pixels while detection can retain the scale-matched baseline. The fringe experiment explicitly uses a bounded grid and is not promoted as validated segmentation.

Still required: complete human boundary labels and second reviews, fresh final observations, corrected-label training and operating-point selection, quantitative accuracy/latency/memory promotion gates, random-walker/matting comparisons, numeric 16-bit analysis, arbitrary full-observation ingestion/projection validity masks, and deployed origin/proxy rehearsal. The hosted model's internal resizing remains unverified. No model accuracy improvement is claimed, and this implementation has not been deployed.

The sections below preserve the original rationale and acceptance gates. Their original “current implementation” findings describe the pre-change baseline.

## 1. What the current implementation establishes

| Finding | Consequence | Relevant source |
| --- | --- | --- |
| The homepage accepts images up to 3072 pixels per side and 8 MB, then fits them inside 1024 pixels and encodes JPEG. | Fine detail is discarded before both inspection and refinement. | [public/demo.js](public/demo.js) |
| The bundled 1024-pixel sample corresponds to a 2048-pixel source crop at 0.5 m/pixel. | Recovering the native crop supplies twice the linear resolution and four times the pixel count. Upscaling the JPEG cannot recover that detail. | [scripts/calculate_sample_north.py](scripts/calculate_sample_north.py) |
| The original sample product is present locally as a roughly 97 MiB JP2. Its label specifies 17007 by 16131 pixels and 16-bit unsigned samples. | Retain this source product. Decoding the entire image into browser RGBA would require roughly 1.02 GiB before copies and model buffers. Use region decoding and a tiled viewer. | `../data/planet-four/images/ESP_082142_0935_RED.JP2` and its `.LBL` |
| Local Sharp reports no JP2 input support. Existing preparation scripts use OpenJPEG. | Reuse a verified region decoder; do not assume a larger upload limit makes JP2 usable. Check decoder availability on the Sprite separately. | [scripts/prepare_locked_review.py](scripts/prepare_locked_review.py) |
| The weak-label generator thresholds local darkness and converts surviving regions to polygons. The recorded refined training set contains 68 images and 1813 masks. | Faint fringes and unmarked deposits may be missing from training supervision. Correct labels before expecting a new model to solve this. | [scripts/refine_masks.py](scripts/refine_masks.py), `training/refined-coco/manifest.json` |
| SAM 3 receives the same reduced whole image, with boxes enlarged by 1.8, and returns one retained polygon per proposal. | Context, prompt placement, resolution, and lost mask components can all affect the result. | [public/demo.js](public/demo.js), [server.mjs](server.mjs) |
| The historical atlas already contains tiling, coordinate mapping, review decisions, and export code. | Extract useful pieces into shared modules without restoring the retired model workflow. | [public/scout.js](public/scout.js) |
| The existing evaluation uses approximate center matching, with a 35% threshold; the homepage accepts proposals down to 20% and features a subset. | Neither boundary quality nor the current homepage operating point is validated by the old summary. | [evaluation/locked/score.json](evaluation/locked/score.json), [public/candidates.js](public/candidates.js) |
| Previously inspected rocky crops produce many proposals. | Fan recognition and boundary quality need separate evaluation. A fuller outline does not establish a fan. | [evaluation/demo-repair/README.md](evaluation/demo-repair/README.md) |

The previous assessment ran the 22 existing tests successfully. Most cover existing utilities and historical review behavior; they do not establish high-resolution or SAM 3 end-to-end correctness.

## 2. Preserve the source and make every transformation explicit

Keep three representations with distinct purposes:

1. **Original source:** immutable uploaded bytes or the original JP2 plus label, source hash, dimensions, bit depth, observation identifier, and known pixel scale. Preserve the original product values; do not describe them as calibrated physical dust measurements.
2. **Display assets:** a small overview and zoom tiles derived from the source. Record the display stretch and gamma. Contrast changes affect the viewer independently of model preprocessing.
3. **Analysis inputs:** bounded crops or tiles extracted from the original with a recorded transform, encoding, pixel scale, and preprocessing recipe. Model input dimensions and output-mask dimensions are separate metadata.

Use original-image coordinates as the common coordinate system. Specify a pixel-center/edge convention and retain transformations for crop offsets, scaling, padding, and orientation. Never overwrite original geometry with display coordinates. Tests should verify round trips at corners, tile seams, and non-square images, with a maximum numerical mapping error of 0.5 source pixel excluding the model's own localization error.

Retain native spatial resolution for detailed inspection and refinement. Detection may also use a scale-matched derivative because the current detector learned from imagery at approximately 1 m/pixel. Compare that path with native-resolution tiled detection; do not assume more input pixels always improve an unchanged model.

Roboflow documents model-specific internal resolutions; for example, the current standard RF-DETR Seg Small configuration is listed at 384 by 384. This does not establish the resolution of our custom hosted checkpoint. Retrieve or verify its actual preprocessing before choosing tile size. A 2048-pixel upload can still be resized internally by a model. [RF-DETR documentation](https://rfdetr.roboflow.com/latest/learn/run/segmentation/)

**Acceptance:** selecting a native detail crop reads from the retained source; regenerating a preview never changes the source hash; exports identify every conversion; no enlarged preview is labeled native resolution.

## 3. Phase A — recover detail and improve inspection

Provisional engineering estimate: 2–3 working days, excluding deployment surprises. This phase supplies the first useful release without retraining.

- [x] Reconstruct the bundled native 2048 by 2048 crop from raw bounds `(2304, 6976, 4352, 9024)`. Preserve an unmodified 16-bit extraction and make a lossless display derivative with a recorded stretch. Verify alignment against the existing sample before replacing its display assets.
- [x] Introduce a shared image-source interface that provides metadata, overview, display tile, and native region reads. Support browser files and prepared server assets through the same interface.
- [x] Keep uploaded JPG/PNG/WebP bytes and dimensions. Replace the destructive whole-image resize with a separate overview. Start with a proposed 32 MiB encoded / 16-megapixel browser upload cap, subject to memory testing. Larger inputs move to server processing; they must not be silently reduced.
- [ ] Preserve higher-bit-depth originals even when the browser display is 8-bit. Route numeric 16-bit processing through a decoder that retains those values. An 8-bit canvas is not the source of truth.
- [x] Add pan, zoom, fit-to-view, and a verified 1:1 inspection view. Load only the necessary image tiles for large sources; bound caches and release decoded bitmaps and object URLs.
- [x] Add independent RF-DETR and SAM layer toggles, fill-opacity control, and a hold-to-hide-overlays interaction. Keep a clearly accessible button equivalent for keyboard and touch use.
- [x] Show original dimensions, inspected resolution, and known meters per pixel in a compact source panel. Keep unknown scale explicitly unknown.
- [x] Provide a single-click return to the sample after an upload. Correct the source title and attribution when the displayed image changes.
- [ ] Store small run metadata separately from image bytes. Use IndexedDB for recoverable browser sources if quota allows, with an explicit source-reselection path when it does not. Match restored results by source hash, model version, and preprocessing version.
- [x] Label restored results with their actual run timestamp and saved/live status. Preserve successful results while a fresh scan is pending or fails.

**Acceptance:** the sample's native crop can be inspected without interpolation at 1:1; overlays stay aligned through zoom and image changes; a failed scan does not discard the previous result; a restored result never claims a new live inference occurred.

## 4. Phase B — scan and refine from the original pixels

Provisional engineering estimate: 2–3 additional days. Depends on Phase A's source interface and coordinate contract.

- [ ] Extract and test the atlas tile planner and coordinate mapping as shared code. Start experiments with 1024-pixel source tiles and 128–256 pixels of overlap, then choose tile size using the hosted model's real input resolution and deposit scale.
- [x] Support both a selected-area scan and an explicit complete-crop scan. A fast overview pass can prioritize regions, but it must not gate all detailed inference: faint deposits absent from the overview still need an independent coverage path.
- [x] Use an asynchronous scan job with stable tile IDs and visible queued/running/partial/complete/cancelled/failed states. Start with two concurrent provider requests and measure before increasing it. Keep coverage geometry so an unscanned region is never treated as a negative result.
- [x] Merge overlapping detections in source coordinates using mask overlap and source context. The current box-overlap deduplication can suppress nearby distinct deposits; do not simply reuse it as the final merge rule. Flag clipped masks, prefer complete interior views, and avoid unioning neighboring fans.
- [ ] Refine the selected candidate from a native-resolution region containing the suspected full deposit and surrounding terrain. Replace the fixed 1.8-times box assumption with a bounded context rule and a manual expand-region control. Show when the source boundary clips the crop.
- [ ] Map SAM prompts into region coordinates and results back into source coordinates. A crop that still exceeds the provider's effective resolution needs an explicit multi-scale or tiled strategy, with its actual analysis resolution recorded.
- [x] Permit refinement of any selected candidate, not only the three featured ones. Bound the number of outstanding refinements and discard stale responses after source or candidate changes.
- [ ] Probe the pinned SAM 3 endpoint for raster/RLE output, multiple components, holes, positive/negative prompts, and raw logits. Preserve supported raster geometry and derive polygons for display/export. Do not assume a bitmap or RLE response contains soft probabilities; do not infer SAM 3 capabilities from a different SAM API.
- [ ] Retain all supported mask components and holes. Record alternate masks when available rather than silently selecting the largest component as the complete deposit.
- [ ] Prefer lossless analysis transport when the endpoint accepts it. If JPEG is required, encode directly from the source-derived crop once at a documented quality and measure its effect. Update the JPEG-only route validators deliberately rather than just raising limits.
- [ ] Compare current scale-matched detection plus native refinement with native tiled detection plus native refinement. Keep the better-supported mode as the default while retaining the original source in both cases.

**Request budgeting:** at 1024-pixel tiles with 256-pixel overlap, complete square scans of 2048, 3072, and 4096 pixels require 9, 16, and 25 detector requests respectively. Separate native SAM crops may also require separate requests instead of today's single three-box batch. Calculate the count before starting; cap each job and total daily use on the server. A selected-area scan is the practical default for a full observation.

Reserve/account for requests atomically, make job submissions idempotent, and distinguish queued reservations from dispatched attempts. Cancellation stops future dispatch; it cannot undo a billable request already sent. Retry only failed work under a bounded policy and account for uncertain provider outcomes. Report latency and request counts separately from any dollar estimate; verify current billing before quoting cost.

**Acceptance:** every requested tile is accounted for; partial scans remain visible as partial; no duplicated charges from repeated job submission; masks align across crop boundaries; adjacent deposits remain separately inspectable; source-scale changes are recorded and evaluated.

## 5. Phase C — estimate diffuse extent without hiding ambiguity

Provisional engineering estimate: 2–4 additional days for a bounded classical prototype and UI, plus review. This is an experimental feature until the boundary evaluation passes.

Begin with a reviewed candidate core, an uncertain surrounding band, and user-confirmed background examples. A detector or SAM mask is a proposal and must not automatically become certain foreground. Model disagreement can guide review, but agreement is not proof of correctness.

- [ ] Define separate data fields for raw local contrast, estimated pixel membership, model object score, and human classification. Never call one field another, and never interpret darkness as dust thickness or membership as calibrated fan probability.
- [ ] Estimate background from nearby reviewed terrain with a robust local surface or comparable method. Use valid-pixel masks and exclude the candidate and neighboring deposits where possible. A blur alone can absorb a broad deposit into the estimated background and erase its interior.
- [ ] Compare several smoothing/background scales, expressed in meters when scale is known and explicitly in pixels otherwise. Preserve the original signal alongside every result. Avoid automatic contrast enhancement as an unrecorded change to inference inputs.
- [ ] Prototype seed-connected expansion with conservative and permissive contrast levels. Compare it with a seeded random-walker method using image differences and spatial continuity. Both need bounds, competing-background seeds, and leakage checks for shadows, ridges, and touching deposits. [Random-walker reference](https://scikit-image.org/docs/stable/auto_examples/segmentation/plot_random_walker_segmentation.html)
- [ ] Keep the output as a per-pixel field on its stated grid. Show a core, estimated extent, and ambiguous fringe, with source pixels always accessible. A sensitivity slider may show how the estimate changes; save the setting and method, and label the slider as extent sensitivity rather than confidence.
- [ ] Detect unstable results: growth into adjacent deposits, large changes under small parameter shifts, prompt sensitivity, disconnected patches, and crop-boundary contact. Return an explicit needs-review state instead of silently presenting an expanded region as improved.
- [ ] Add include/exclude clicks or short scribbles, undo, reset, and before/after comparison. Keep automated results and user edits as separate revisions.
- [ ] If classical methods leak excessively, retain only the inspection and correction UI in the demo. Keep the experimental layer available for development comparisons rather than promoting a misleading result.

Image matting is a later comparator. A model such as Matting Anything predicts an alpha matte, which is related to but different from membership uncertainty. Its natural-image performance does not establish validity for deposits on Mars. Test on reviewed native crops before adding a GPU service or replacing the current stack. Arbitrary blur around a polygon is not a matting result. [Matting Anything](https://arxiv.org/abs/2306.05399)

**Acceptance:** the method recovers reviewed visible extent while keeping leakage controlled; output meaning and resolution are explicit; uncertain or unstable areas remain visible; users can correct a result without losing its original version.

## 6. Phase D — repair training data and evaluate models

This work can begin as soon as the annotation format is fixed. Human annotation, second review, and model training are separate scheduling dependencies; they cannot be replaced by engineering time estimates.

- [ ] Complete the existing 24-chip training review queue, marking every visible fan and recording complete-chip coverage. Revisit source/label registration and record provenance. An unmarked image is not automatically a negative.
- [ ] Annotate conservative core, plausible outer envelope, unknown pixels, separate instances, and fan/lookalike/uncertain decisions. Preserve original-resolution coordinates and the display stretch used during review. Have a second reviewer check ambiguous fringes and proposed negatives.
- [ ] Add deliberately reviewed shadows, ridges, dark rocks, image seams, and empty terrain. Sample these from training observations. Keep final evaluation observations out of both training and label-generation heuristics.
- [ ] Split by observation and, where feasible, geographic site/season to reduce leakage between related images. Keep crop neighbors together. The current validation/test files come from the same held-out observation and should not be treated as independent domains.
- [ ] Check the hosted training pipeline's support for unknown pixels and soft labels. Ordinary polygon COCO labels cannot represent a continuous target or an ignore band by themselves. If unsupported, use consistent reviewed binary masks for RF-DETR and retain fringe annotations for separate refinement; use a custom training path only when its value is demonstrated.
- [ ] Retrain the existing detector first with corrected masks and hard negatives. Compare a dedicated semantic extent model or matting model only after this baseline. Preserve instance identity for touching fans even if an extent model is semantic.
- [ ] Apply physically plausible scale and contrast augmentation with a recorded recipe. Keep train and inference normalization compatible. Preserve original bit depth in the data archive even if the chosen model consumes 8-bit inputs.
- [ ] Version data, annotations, splits, model artifacts, preprocessing, and inference settings together. Do not promote a model on training metrics alone.

For binary masks, use a documented visible-extent convention. For a custom model supporting uncertainty, ignore unknown pixels in the relevant loss or use justified soft supervision from independent annotations. Do not assign invented probability targets merely to make an attractive gradient.

## 7. Evaluation design and promotion gates

Create the evaluation protocol before parameter tuning. Freeze the current app as the baseline, including its model ID, 20% proposal floor, candidate selection, preprocessing, and optional SAM step. The old 35% center-match score remains a historical result.

Use inspected observations for development/regression testing. Reserve at least two fresh observations for a final check if available, with approximately 12–20 completely reviewed crops and a target of at least 100 reviewed candidate proposals. Include empty areas, faint deposits, different terrain, tile seams, image boundaries, and overlapping fans. If the sample is smaller, report that limitation and do not imply the target was met. Review source images before viewing model output for the final set.

The existing `evaluation/locked/` set and the 2025 rocky crops have already informed development. Keep their frozen files intact, but stop describing them as untouched final tests. Add corrected provenance metadata for the stale holdout statement that says inference has not run, retaining the original selection history.

| Question | Measure |
| --- | --- |
| Does the system find actual candidate fans? | One-to-one instance precision and recall against complete reviewed labels; report ambiguous cases separately. Score all displayed proposals and the featured subset separately. |
| Are clear deposits being clipped? | Fraction of reviewed definite-core pixels missed; compare the same source regions across methods. |
| Does refinement spill into terrain? | Predicted area in reviewed definite background and outside the permissible envelope; record merges with neighboring deposits separately. |
| Are identifiable boundaries better? | IoU/Dice on evaluable pixels and a boundary-distance/tolerance measure in source pixels or meters; exclude genuinely unknown bands rather than scoring them as certainly negative. |
| Is a soft result stable? | Sensitivity to crop context, modest display/preprocessing variations, and reasonable prompts; reviewer disagreement and threshold-dependent area range. These are not calibrated confidence intervals. |
| Is resolution helping? | Paired comparisons on the same source extents with all results mapped to original coordinates. |
| Is the demo reliable? | Time to first result, completion latency, failure/partial rate, requests per job, peak browser/server memory, and manual correction time. |

Run the following ablations in sequence so a result has an interpretable cause: current baseline; preserved-source viewer with unchanged inference; native-crop SAM; tiled/scale-matched detector variants; diffuse-extent refinement; corrected-label detector; optional learned extent or matting model. Change one component at a time before evaluating a combined release.

Proposed promotion rules:

1. Source preservation, geometry, request accounting, cache provenance, and scan-state checks must all pass. They are release requirements, independent of model accuracy.
2. On the frozen development comparison, a boundary method must reduce definite-core omission without increasing mean background leakage or instance merges, under thresholds chosen before scoring. If there is a tradeoff, report it and keep the method optional.
3. A detector change must meet a declared precision/recall operating point and be compared at matched recall as well as the selected deployment threshold. Use the earlier project target of at least 70% reviewed candidate precision as a provisional demo target, with comprehensive recall now reported. The old 16 marked centers cannot establish that recall target. Freeze an acceptable recall floor using the new development annotations before opening final results.
4. Report denominators and uncertainty by observation; pixels from one image are not independent evaluation samples. If final results are inconclusive or fail a gate, retain the established default and show the new method only as an explicitly experimental option.
5. Target first proposals within 5 seconds on the bundled crop and completion of a bounded nine-tile scan within 20 seconds on a warm deployment. These are provisional UX targets, not measured guarantees. Measure cold starts separately and reduce default scan scope if necessary.

## 8. Full observation support

Preserve the entire original JP2 from the first release where it is already available, while using a prepared native crop for the initial demo. General full-observation ingestion is a separate stage because of decoding, storage, and scan volume.

- [ ] Store immutable original products and labels in a non-public source directory with explicit lifecycle rules. Start with existing Sprite storage and measured quotas; additional storage infrastructure is only necessary if observed volume requires it.
- [ ] Build a zoom pyramid and an indexed native-region extraction path using OpenJPEG or another verified decoder. Record source validity masks, projection metadata, and normalization. Preserve the original file through cache eviction.
- [ ] Add observation selection and region-of-interest navigation. Serve viewport tiles and run inference on the selected area; full-observation scanning is an explicit bounded background job with a request estimate.
- [ ] Add resumable processing, decoder time/memory limits, disk accounting, and authenticated access for user uploads. Persist jobs and manifests across Sprite restarts; keep raw uploaded images out of the public static directory.
- [ ] Test original-format upload/download through the actual proxy and origin. Inspect current deployment limits before choosing a maximum. Keep large binary uploads separate from base64 inference payloads.
- [ ] Make original-file deletion an explicit user action. Temporary derived caches can be evicted independently. Explain when a browser-local source requires reselection after storage eviction.

**Acceptance:** browsing a full observation does not allocate a full-resolution browser canvas; source downloads preserve the original hash; native regions align with the overview; interrupted jobs resume without rerunning completed provider calls.

## 9. Review records and export

Bring accept/reject/unsure decisions and evidence export into the simple homepage. Use stable candidate IDs derived from a run and retained associations, not list position. A changed model or geometry creates a revision requiring review rather than inheriting an old verdict through a loose center match.

Each export should identify the source hash and dimensions; observation and pixel scale when known; source crop bounds; orientation and coordinate convention; model and preprocessing versions; requested/completed scan coverage; each input transform and encoding; raw model response references; raster masks or soft-map files with their grid and meaning; derived polygons with components/holes; user edits; reviewer decisions; and actual inference timestamps. Include model output separately from human-confirmed geometry. Pixel coordinates remain image-relative until georeferencing is implemented and verified.

## 10. Implementation sequence and code ownership boundaries

| Work package | Existing integration points | Proposed new modules or artifacts |
| --- | --- | --- |
| Source preservation and native sample | `public/demo.js`, sample assets, preparation scripts | `public/image-source.js`, `scripts/prepare_native_sources.py`, versioned source manifests |
| Viewer and comparison controls | `public/index.html`, `public/demo.css`, `public/demo.js` | `public/image-viewer.js` |
| Tiling and geometry | `public/scout.js`, `public/candidates.js` | Shared tile/transform module and seam fixtures |
| Scan jobs and accounting | `server.mjs`, `demo-access.mjs` | Job store, bounded queue, source/region validators |
| Native SAM refinement | `server.mjs`, `public/demo.js` | Provider adapter and raster-mask representation |
| Diffuse extent experiment | Source/region pipeline and viewer | Local refinement module, parameter manifest, comparison report |
| Corrections and export | Historical review/export utilities | Versioned homepage review schema and export builder |
| Data repair and measurement | Existing annotation queue and evaluation scripts | Boundary annotation schema, immutable benchmark manifests, scoring report |

Implement these as small reviewable changes in dependency order. Preserve the historical atlas and retired review records. Do not reactivate the retired visual classifier as part of this work.

Focused verification should cover transform correctness, tile coverage/deduplication, genuine adjacent instances, raster holes/components, non-square and oriented inputs, source hash preservation, stale-response races, cancellation, partial failure, refresh/restoration, corrupted cache recovery, source storage quota failure, large-image memory bounds, and concurrent request budgeting. Add browser checks for the primary user journey and the SAM path, which existing tests do not exercise. Run the existing test suite as a regression check.

## 11. Demo cutlines and deployment

The demo date is not yet specified. These are scope choices, not delivery promises; engineering estimates exclude annotation availability and provider training time.

| Available window | Release scope |
| --- | --- |
| 1–2 days | Prioritize native sample recovery, source preservation for supported crops, native detail inspection, layer toggles, truthful saved/live state, and rehearsal. Include native SAM only if geometry and provider checks pass. Keep the established detector configuration. |
| About a week | Aim for Phases A and B, homepage decisions/export, a development benchmark, and a bounded optional fringe prototype if its tests pass. Begin annotation concurrently with implementation when a reviewer is available. |
| More than a week | Complete boundary review and corrected-label training, evaluate learned refinement alternatives, and add general full-observation browsing/ingestion as capacity permits. |

Before release, rehearse the bundled image, a compatible fresh upload, a faint deposit, a known lookalike, an empty result, a cancelled/partial scan, and an unavailable-provider path. Measure cold and warm behavior on the deployed origin, verify original-pixel alignment after the proxy path, and check projector-size and narrow-screen readability. Prepare a clearly timestamped saved-result fallback that remains inspectable without paid calls.

Use independently switchable flags for native refinement, tiled detection, and experimental extent rendering. Deploy a pinned application version with a recorded model/configuration manifest and a known rollback version. Preserve source assets and review records across rollback. Update the README and demo script to describe only the capabilities actually enabled.

The first implementation task is to recover and verify the native sample, establish the source/coordinate contract, and add native inspection. That foundation benefits every subsequent segmentation experiment without assuming that a particular new model will succeed.
