# Mars Fan Scout: bounded review-agent experiment

Implementation plan · September 27, 2026 · Status: Jev-Omni ran locally on real Mars evidence; live CUDA endpoint and human evaluation pending

Implementation note: the frozen detector responses produce **44** candidates after the app's duplicate suppression: 32 at confidence ≥35% and 12 seeded from 20–35%. The original 45-candidate estimate counted one duplicate. The manifest is in `evaluation/agent-review/manifest.json`. The live pilot remains disabled until the private GPU endpoint, call allowance, curator category check, and human reviewers are available. See [jev-runtime/README.md](jev-runtime/README.md) for the pinned model and deployment contract.

**Question:** Can a vision agent save a human time when the detector is unsure, without hiding real fans?

Keep Mars Fan Scout as the evidence viewer. Add a small review runner to the existing Sprite service. Every selected candidate still requires a human decision. The deliverable is a working, auditable experiment and an honest result, including a negative or inconclusive result.

The wider-view branch implements perception, decision, action, and verification: the agent requests additional pixels, the server creates the crop, and the agent inspects the returned evidence before deciding again. This follows the loop described in [Roboflow's agentic vision guide](https://blog.roboflow.com/agentic-computer-vision/). Human review separately evaluates whether the recommendation was correct.

## 1. Build on the current app

| Existing component | Implementation consequence |
| --- | --- |
| `server.mjs` proxies JPEG tiles to Roboflow; it does not retain full uploaded images. | Add an explicit experiment session that stores the full working image, so the Sprite can crop beyond a detector tile. |
| `public/scout.js` normalizes and merges masks, renders evidence, and stores human decisions in local storage. | Reuse those masks and UI; add server-persisted experiment records and stable candidate identities. |
| Candidate labels such as `RF-001` depend on confidence sorting; restored decisions use nearby centers. | Neither is a durable experiment key. Freeze a candidate snapshot and use its identity for agent and human records. |
| `demo-access.mjs` provides meeting-code access and a persistent Roboflow tile allowance. | Reuse authorization, but give Jev calls their own persistent daily call allowance; GPU hosting is billed separately. |
| `evaluation/locked/` contains six source crops and frozen detector responses. | Create a separate agent-evaluation manifest referencing them; preserve the old detector evaluation. |
| Human acceptance and a human-selected source end drive directions. | Agent actions never write `decision`, `source_end`, north orientation, or direction fields. |

Use the existing Node service and plain browser JavaScript. Add no general agent framework, database service, retraining pipeline, or Roboflow Workflow migration for this pilot.

## 2. Freeze the agent contract

The initial evidence includes an unmarked source crop and a separate aligned mask overlay, candidate ID, detector version/confidence, and coordinate metadata. Jev receives the marked crop as its one image input; the unmarked crop remains available to humans. Do not send human labels, old point matches, source-end choices, or wind bearings to the model.

Jev returns probabilities for the fixed options **Fan / Not a fan / Unsure** and no generated explanation. A versioned application rule maps those scores to an advisory verdict and one of these actions. Scores below the frozen probability or margin threshold become `unsure`, even when Jev's top option is Fan or Not a fan; record both the raw top option and rule verdict.

| Action | Server behavior |
| --- | --- |
| `propose_reject` | Save Jev's Not a fan scores and the rule decision; leave the candidate pending for a human. |
| `request_wider_view` | Generate one deterministic larger crop from the same uploaded working image, persist it, and make one follow-up vision call. |
| `send_to_human` | Save Jev's Fan or Unsure scores and the rule decision; leave the candidate pending for a human. |

After a wider crop, the rule can only return `propose_reject` or `send_to_human`. The trace identifies both evidence IDs and whether the rule remains unsure. A low detector score alone is insufficient grounds for rejection; unresolved fan-like shapes go to a human. Never invent a visual explanation on Jev's behalf.

Default bounds, frozen before evaluation:

- One crop request and at most two provider calls per candidate, including retries; disable implicit SDK retries.
- One running candidate job per Sprite initially, with a bounded queue.
- A 60-second timeout per provider call and a 130-second execution deadline per candidate; record queue time separately.
- A positive daily Jev call limit before enabling the shared deployment. Hosted GPU run time is governed by the provider account, not this app.
- Invalid probabilities, unavailable context, provider error, timeout, or exhausted allowance ends as `send_to_human` with a recorded reason. No automatic rerun after an unknown provider outcome.

`propose_reject` is an advisory result, never an automatic reject. Both terminal actions persist a human-review task; the controller verifies that the task and trace were saved. The crop branch additionally checks the generated image and obtains a real second visual assessment. Merely logging “looked again” does not count.

## 3. Persist evidence and implement the crop tool

When someone starts an experiment session, encode the complete `state.canvas` as a lossless PNG and upload it with the frozen candidate snapshot and provenance. This preserves the working pixels from which the JPEG detector tiles were made; the current display JPEG is a separate, lossy encoding. The server decodes the image, verifies bounds, and computes its own hash. Preserve the original-file hash separately: original upload bytes and working-image bytes are different assets. Use a dedicated bounded binary/multipart reader, a 40 MB encoded limit, and the existing maximum of 3072 pixels per side; do not reuse the current 3 MB JPEG-tile reader. Fixed-set sessions instead use the exact saved source JPEG and identify it explicitly.

Store records outside `public/`, under a configurable `.review-agent/` data directory excluded from Git. For this single-process pilot, use immutable session manifests, evidence files, and a serialized append-only event journal. Use atomic manifest writes, durable journal writes, and explicit incomplete-job recovery. A restart turns interrupted jobs into visible human-review fallbacks rather than silently repeating calls.

Use stable IDs derived from the working-image hash, detector snapshot hash, and canonical candidate entry. Keep `RF-001` as a display label only. Retain raw detector responses in `runScan()` instead of discarding them after normalization; store the detector model, raw response provenance, tile offsets and tile-byte hashes, normalization/deduplication version, and any partial-scan failures with the snapshot. A rescan creates a new snapshot; old advice cannot attach to changed masks. Fixed-set sessions load their predictions from the server-owned frozen files.

Implement `request_wider_view(candidate_id)` as a server-controlled operation:

1. Start with a square centered on the candidate, using the current evidence framing: side length `1.65 × max(105, bbox width, bbox height)` working pixels.
2. The wider request uses twice that side length, clipped to the complete uploaded working image. It cannot fetch a larger HiRISE observation or invent missing pixels.
3. Save the unmarked crop and a separate mask overlay, actual bounds, requested bounds, clipping flags, working-to-crop transform, output dimensions, encoding, and hashes. Keep the same appearance normalization as the uploaded image.
4. Verify it decodes, contains the candidate, and covers additional source pixels. If clipping leaves no additional context, save `context_unavailable` and route to a human without another model call.
5. Pass the actual generated overlay to the second call; retain the first scores and rule decision in the trace. Record any output resizing so the apparent resolution is auditable.

Use Sharp for server image decoding, extraction, and overlay rendering; pin a compatible version after checking the Sprite runtime and installation. Its [installation requirements](https://sharp.pixelplumbing.com/install/) and [extraction API](https://sharp.pixelplumbing.com/api-resize/#extract) support this small image-processing role. Add a package manifest and lockfile because the app currently has neither.

Experiment enrollment must explain that the working image, requested crops, and review trace will now be retained on the Sprite and that marked crops go to the configured private Jev service. Require the existing meeting code on session, evidence, run, review, and export endpoints. Keep endpoint credentials server-side, use opaque session IDs, and serve evidence only through authenticated routes. Document a retention period and an operator cleanup/export command; retain evaluation artifacts through analysis.

## 4. Implement the runner and audit record

Proposed modules and routes:

| Component | Responsibility |
| --- | --- |
| `review-agent/runner.mjs` | Explicit state transitions, bounded calls, crop dispatch, terminal human tasks, cancellation and fallback. |
| `review-agent/provider.mjs` | Pinned Jev service, three-way probability validation, backend/revision checks, usage and latency capture. |
| `review-agent/jev-policy.mjs` | Frozen score thresholds and mapping to wider-view or terminal advisory actions. |
| `review-agent/evidence.mjs` | Image validation, crop generation, overlays and coordinate transforms. |
| `review-agent/store.mjs` | Session manifests, event journal, immutable evidence, idempotency and recovery. |
| `review-agent/budget.mjs` | Persistent Jev call reservations and daily limit. |
| `POST /api/scout/review-sessions` | Create a session and freeze its image/candidates. |
| `POST /api/scout/review-sessions/:id/runs` | Enqueue explicitly selected candidate IDs; return a run ID immediately. |
| `GET /api/scout/review-sessions/:id/runs/:runId` | Poll progress and retrieve allowed trace fields. |
| `POST /api/scout/review-sessions/:id/reviews` | Append human decisions and timing events; acknowledge durable save. |
| `GET /api/scout/review-sessions/:id/evidence/:evidenceId` | Retrieve an authorized source crop or overlay. |
| `GET /api/scout/review-sessions/:id/export` | Export the complete review record and an evidence bundle. |

Use idempotency keys for run creation and review submission. Switching images must not attach a late result to the new image. Cancel queued work explicitly; persist the outcome of already-started calls even if the browser disconnects. Polling and page refreshes must not initiate inference.

The chosen reviewer is Jev-Omni, with the original CUDA checkpoint and independent MLX feasibility conversion pinned separately. The live endpoint must report its expected revision and backend. Freeze the image format, prompt, token settings where applicable, and score thresholds before the fixed-set run. Record the GPU provider's hourly rate and pause it when the demo ends.

Each record contains:

- **Identity:** experiment/session/run/candidate IDs, source and working-image hashes, detector response hash, model versions, prompt/schema/code versions, frozen configuration, selection stratum and randomized study arm.
- **Evidence/actions:** ordered action events, Jev's three probabilities and top choice, the application's rule outcome, initial/wider evidence IDs, requested/actual crop coordinates, image hashes, provider request IDs, validation failures and terminal outcome.
- **Human review:** reviewer pseudonym, blinded reference label, timed-review decision, advice exposure, final adjudication if needed, and append-only decision revisions. Keep `unsure` distinct from `rejected`.
- **Timing:** queue, provider, crop, total agent and human active/wall times; log focus/pause events and revisions.
- **Costs:** Jev inference latency, model-reported input/image token metrics when available, estimated active GPU cost from a recorded hourly rate, and unmeasured costs. Keep the provider's actual running/idle bill distinct from the app estimate. Record Roboflow tile usage separately.

Reserve a daily call slot before each model call. This prevents duplicate or interrupted runs from silently spending additional inference time. The separate GPU endpoint must be paused or scaled down by its operator to stop hosting charges. Preserve the existing Roboflow daily tile limit.

Exports use `mars-fan-scout-review-v4` with separate agent run results and human reviews while retaining image/model/candidate fields. Include exact evidence bytes in a downloadable bundle with a manifest; JSON-only export contains their hashes and authenticated references. The existing ordinary browser-local workflow remains available; experiment reviews use isolated storage and server acknowledgments.

## 5. Add the experiment UI

Extend `public/index.html`, `public/scout.js`, and `public/scout.css`:

- Add an explicit “Run review agent” control for a selected candidate or fixed experiment set. Ordinary candidate selection does not spend model credits.
- Show pending/running/completed/error states, initial evidence, requested wider evidence, a compact action timeline, final advice, latency, and cost/unknown-cost status.
- Label recommendations “Agent proposes reject — human review required” or “Agent defers to human.” Keep all frozen candidates in the queue regardless of score or advice; the confidence slider cannot hide enrolled candidates in experiment mode.
- Keep accept/reject/unsure as human actions. Count a candidate reviewed only after an explicit human decision is saved. Review completion requires every enrolled candidate, including agent errors and abstentions.
- Provide unmarked pixels and a mask toggle for initial and wider crops. Give both study arms access to manual wider viewing and the full source image.
- In the human-only arm, the server withholds agent advice and trace until that review is submitted; do not merely hide already-delivered advice with CSS.
- Measure active review time from evidence becoming usable to decision, including advice reading, crop inspection, and revisions. Pause on tab hiding or explicit pause; record interruptions instead of silently discarding them.

The agent never accepts candidates, selects source ends, changes wind summaries, declares discoveries, or publishes directions. Existing direction controls continue to require explicit human inputs.

## 6. Run a small fixed experiment

**Candidate set.** Use the existing six frozen crops as a practical feasibility benchmark. Their raw responses contain 33 candidates at confidence ≥35%; the app's duplicate suppression leaves 32. The previous evaluation considered 25 and excluded eight edge/ambiguous raw predictions; keep all deduplicated high-confidence candidates here, including any of those previously excluded that survive suppression. Add two seeded selections per crop from the 20–35% band for a total of 44 candidates. The selected masks and study arms are frozen in `evaluation/agent-review/manifest.json` before any agent calls.

A human curator inspects this set without agent output to confirm it includes clear fan-like deposits, obvious false positives, and ambiguous shapes. If a category is absent, supplement from separate development crops before freezing and record the rule. Old unmatched point-proximity predictions are not automatically false positives. Report the final stratum counts and selection process. The existing images have already been inspected, so describe this as a reused, frozen pilot set rather than a new untouched test set.

**Development.** Exercise the fixed question and options, crop geometry, and model on separate candidates from the bundled development observation. Then freeze model, question, call limits, timeouts, inclusion rules, timing protocol, and metrics. Do not tune them in response to the pilot results. A revised question or threshold requires a separately labeled run and preferably new evaluation imagery.

**Human protocol.** Use two people where possible:

1. Reviewer A labels every fixed candidate `accepted`, `rejected`, or `unsure` without agent advice. These are non-expert reference judgments, not scientific ground truth.
2. Run the frozen agent on every candidate, retaining its advice privately.
3. Reviewer B, who has not previously reviewed the set, reviews every candidate once. Assign roughly half to human-only and half to agent-assisted review with seeded randomization balanced within source crop and reference/confidence strata. Randomize order and use separate practice examples first. Both arms have identical image controls.
4. Preserve Reviewer B's final decision independently. Recheck disagreements against the pixels with advice hidden; retain unresolved cases rather than forcing a binary answer.

Precomputing advice isolates human inspection time. Report agent latency and total experiment elapsed time separately; do not claim that this directly measures an on-demand end-to-end speedup. If only one reviewer is available, collect blinded labels first and treat subsequent assisted timing as exploratory because memory confounds the comparison. A stronger time-saving claim then remains untested.

**Metrics, with counts and denominators:**

| Question | Report |
| --- | --- |
| Did it save inspection time? | Human-only versus assisted active seconds per candidate, distributions and stratum counts; descriptive absolute/relative difference. Record wall time and interruptions separately. |
| Would its proposed rejections lose human-accepted fans? | Number of `propose_reject` candidates labeled accepted in blinded/adjudicated review, divided by all human-accepted candidates; also show this count among proposed rejections. |
| How useful are the rejection proposals? | Human-rejected proposals / all proposals; show accepted and unsure outcomes separately. |
| How often does it help or abstain? | Proposal, wider-view, deferral, failure and context-unavailable rates over all enrolled candidates. |
| Did more context help? | Show every wider-view trajectory, initial scores and rule result, final recommendation, and agreement with blinded review. This is descriptive, not a causal ablation. |
| What does it cost? | Estimated active GPU compute, separately recorded actual endpoint bill when available, cost per human-confirmed rejection, provider/crop/queue latency and unknown-usage count. Historical detector expense is separate. |
| Did advice change human judgments? | Timed-review disagreement with blinded/adjudicated labels in each arm, retaining unsure cases. |

No candidate disappears from the actual human queue; the missed-fan metric measures hypothetical loss if advice were automated. This experiment does not measure detector recall for fans that never became candidates. The small curated set cannot establish population safety or a statistically reliable time saving. Zero observed missed fans means zero in this sample only.

Predeclare an encouraging pilot as lower human review time with no observed human-accepted fan proposed for rejection and no increase in observed human review errors. Report all components separately and do not interpret that result as authorization for automatic rejection. Any harmful proposal, time increase, cost disadvantage, or uncertain comparison is a publishable finding.

## 7. Build order and acceptance checks

1. **Freeze protocol and schema.** Add the manifest builder, record schema, decision rule and configuration. Confirm Sprite Node compatibility, image library installation, and Jev with development evidence.
2. **Build persistence and evidence.** Implement session upload, hashes, stable IDs, crop generation, access checks, audit journal and export. Reconstruct a stored crop exactly from its manifest.
3. **Build the bounded runner.** Start with a fake Jev service covering each action and failure path; then make one real development run. Add idempotency, persistent call reservations and restart recovery before batch execution.
4. **Integrate the UI and human records.** Add the advisory panel, complete experiment queue, timing and study-arm behavior. Verify that all decisions and directions still require a human.
5. **Deploy the disabled feature to the existing Sprite.** Update `README.md`, `DEPLOY_SPRITES.md`, `.env.example`, and `.gitignore`; install pinned dependencies and smoke-test through the existing domain. Connect the private GPU endpoint and set a positive call limit server-side, then enable the experiment for the meeting code. A feature flag disables further agent runs while preserving human review and saved records. The demo limit can be small; the full 44-candidate pilot needs up to 88 Jev calls.
6. **Run and report.** Execute the frozen set, finish all human reviews, export evidence/traces, and produce `evaluation/agent-review/report.md` plus machine-readable metrics. Include a useful rejection, a wider-view case if one occurred, and failures/disagreements. A scripted branch demonstration must be labeled as such; never invent a live wider-view decision.

Focused automated checks: crop coordinates at image edges and scale changes; invalid/out-of-bounds masks; wider view crossing detector-tile boundaries; stable IDs across sorting/rescans; exactly one crop/two calls maximum; malformed responses/refusals/timeouts; no budget overspend under duplicate/concurrent requests; persistence after restart; unknown billing outcomes; baseline advice withheld; server review acknowledgment; agent inability to mutate human/direction fields; and complete evidence export. Run the existing direction and demo-access tests as regression checks.

Browser checks: fresh upload, frozen set, mask toggle, human disagreement, image switch during an agent call, page refresh, exhausted budget, all candidates remaining visible, and an export that reconstructs a real wider-view trace. Confirm ordinary live scanning still works through the domain.

**Done:** a genuine wider-view action can run and be checked; all enrolled candidates receive human decisions; the exact inspected pixels, actions, costs, and timing can be audited; the report answers the question to the extent the evidence permits. No autonomous discovery or publication feature is added.
