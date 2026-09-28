# Mars Fan Scout: end-to-end repair plan

**Goal:** Open the page, run one Mars image automatically, and watch a credible visual check finish quickly. Roboflow should find useful candidate regions; Jev-Omni should judge the image pixels around each region as **Fan / Not a fan / Unsure**. The page should make it obvious what each model saw and let a person disagree. A small mask or a Jev label is a suggestion, not a discovery.

## What is broken now

- The detector was trained on *weak* masks derived from approximate Planet Four wedges and a hard dark-pixel contrast threshold. The threshold can cut off a fan's diffuse edge. The refined dataset has 68 training chips and 1,813 derived masks; its validation and test chips both come from the same held-out observation. The reported 30.5% mAP@50 is against these weak labels, so it does not tell us whether an outline includes the visible fan.
- The homepage accepts polygons down to 20% confidence and chooses the highest, middle, and **lowest** ranked detections. On the current bundled image, that last choice is a tiny speck. This makes the model look worse and wastes a Jev call.
- Jev receives the outlined crop with an instruction to judge *only inside the outline*. When Roboflow marks the dark core but misses a wider plume, that instruction can turn an obvious fan-like region into “Not a fan.” Requesting a wider crop does not fix the instruction.
- A recent hosted run took roughly 71 seconds for three candidates, with much of the time outside model computation. The Hugging Face endpoint has also failed after scaling to zero. We need stage-level timings and a dependable warm-demo path.

## 1. Freeze examples and measure the whole path

Make a small, versioned gallery from the bundled image and at least two other HiRISE observations. Include clear fans, diffuse fans, dark spots/shadows, seams, edge cases, and tiny false positives. Keep one observation untouched until final evaluation. For each region, save the source crop, detector input, raw Roboflow response, displayed mask, Jev crop, Jev result, and a human label: **fan / not fan / genuinely unsure**. Also mark whether the outline is *usable*, *clips the fan*, or *covers unrelated pixels*. Start with the two current fan-like regions and the speck. Compare the source resolution and contrast with the 1 m/pixel working image to see whether resizing itself erases faint plumes.

Add timing for image preparation, Roboflow request, candidate selection, evidence generation/storage, endpoint HTTP wait, Jev inference, and browser rendering. Record cold and warm runs separately. This gives us a baseline that identifies whether a change improves quality or just changes which three shapes we show.

**Deliverable:** one reviewable gallery and a baseline report with raw candidate counts, failure examples, accuracy against the human labels, and timing by stage.

## 2. Repair the candidate-to-Jev contract first

Keep all Roboflow proposals available for inspection, but automatically send only three useful, spatially distinct regions through the demo. Reject obvious specks using a size/shape floor calibrated against the fixed gallery; do not make low confidence alone a reason to hide a plausible diffuse fan. Show “Jev checked 3 of N possible regions” and allow a simple way to inspect the others.

Send Jev a clean source crop plus a **region pointer** (box or subtle marker). Treat the segmentation outline as a hypothesis, not a boundary Jev must obey. Change the prompt to judge the candidate *and nearby plume* from visible pixels. Compare current mask-only, marked-region, and unmarked-context evidence on exactly the same fixed examples; use the version with fewer missed clear fans. If the first view is genuinely ambiguous, one wider view is enough. Keep “Unsure” visible when the model lacks evidence.

**Deliverable:** the current image no longer spends a call on the tiny dot; the previously clipped fan-like regions are judged from their full visual context; all proposals remain inspectable.

## 3. Repair labels, then compare detector designs

Write one short annotation rule for faint gradients: mark the visible fan body, mark the uncertain fringe consistently, and mark shadows/spots as negatives. Hand-correct a first batch of 20–30 **complete** chips from several observations, annotating every visible fan in each chip so unlabeled fans do not become accidental negatives. Emphasize diffuse boundaries and confusing negatives; expand the batch only if the comparison shows a gain. Keep the original weak labels and model version for an apples-to-apples comparison. Split by **observation**, never by chips from one observation; reserve a fresh observation for the final check.

Train a new Roboflow segmentation version on the corrected labels. Also test a box/region detector as the proposal source, because Fan / Not a fan may work better with a good region than with a brittle exact mask. Compare both against the same gallery for: clear-fan proposal recall, hard-negative load, and the fraction of masks that actually cover the visible plume. Tune confidence and size filters on validation observations only. Use the untouched observation for the final decision. Promote a new version only when it finds more real fans without swamping the page with false proposals.

**Deliverable:** versioned model comparison, corrected training data, and a detector choice based on visible-region quality rather than the old weak-label score alone.

## 4. Check Jev as a classifier, then fix speed and reliability

Run the same human-labeled regions through Jev with the chosen evidence format. Count especially the human-confirmed fans that Jev confidently calls “Not a fan.” If that still happens, use “Unsure / inspect this” for those cases rather than presenting a confident rejection; compare another visual classifier before relying on Jev for the label. Model probabilities are scores on this task, not calibrated scientific confidence.

Use the stage timings to remove avoidable image/storage/network overhead. Reuse prepared crops, avoid repeated large transfers, and tune the image-token budget only after checking whether smaller views lose faint fan detail. For the public page, choose a paid endpoint setting that stays warm during the interview and verify its actual idle cost. Keep the local M3 MLX route as a fallback for a screen-shared demo, but benchmark it on the same crops before promising a faster result. Add a short timeout and a clear “Jev unavailable” state so an endpoint failure never appears as “Not a fan.”

**Deliverable:** five consecutive warm runs complete without failure; target first visible result within 10 seconds and the three-region check within 30 seconds. Report actual cold-start behavior separately.

## 5. Ship one simple demo and verify it live

The primary page should load the sample automatically, show the source image and three region cards, then fill each with Jev's answer and the pixels it saw. Clicking a card should reveal the full crop and mask; advanced thresholds, session controls, and adjudication stay on `/research.html`. Keep one clear sentence that these are model suggestions a person can correct.

Before switching the live site, run the fixed gallery through the final pipeline and record proposal recall, usable-outline rate if segmentation is shown, clear-fan false rejections, total latency, and failure count. Set the demo gate to **no specks among the three chosen cards, no confident Jev rejection of the clear fans in the fixed gallery, all proposals still inspectable, and five successful warm runs**. A small gallery is a demo gate, not a claim of scientific accuracy. Deploy behind versioned settings, check the actual live page on the meeting path, and preserve a one-command rollback to the previous model and prompt.

**Order:** baseline and candidate/Jev input changes first; corrected labels and detector comparison next; runtime tuning and simplified page in parallel with model evaluation; live rollout only after the gate passes.
