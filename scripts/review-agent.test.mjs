import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { ReviewStore } from "../review-agent/store.mjs";
import { ReviewBudget } from "../review-agent/budget.mjs";
import { ReviewRunner } from "../review-agent/runner.mjs";
import { imageInfo, makeEvidence } from "../review-agent/evidence.mjs";
import { makeJevProvider, MODEL_REPO, MODEL_REVISION, validatePrediction } from "../review-agent/provider.mjs";
import { reviewDecision } from "../review-agent/jev-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(await readFile(resolve(root, "evaluation/agent-review/manifest.json"), "utf8")).crops[0];
const image = await readFile(resolve(root, fixture.image));
const candidate = fixture.candidates[0];

async function setup(t, arm = "assisted", { demo = false, count = 1 } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "mars-agent-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReviewStore(resolve(dir, "sessions"));
  await store.init();
  const session = await store.create({ demo, image_base64: image.toString("base64"), detector_model: "frozen-test",
    candidates: fixture.candidates.slice(0, count).map(item => ({ ...item, arm })) });
  const budget = new ReviewBudget(resolve(dir, "budget.json"), { dailyCallLimit: 4, reservationUsd: 0 });
  return { dir, store, session, budget };
}
async function waitRun(run, runner) {
  for (let i = 0; i < 200 && (run.status !== "complete" || runner.working); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.status, "complete");
  assert.equal(runner.working, false);
}

test("the wider view contains verified additional pixels and a matching overlay", async () => {
  const info = await imageInfo(image);
  const first = await makeEvidence(image, info, candidate, "initial");
  const wider = await makeEvidence(image, info, candidate, "wider");
  assert.ok(wider);
  const a = first.meta.actual_bounds_px, b = wider.meta.actual_bounds_px;
  assert.ok(b[0] <= a[0] && b[1] <= a[1] && b[2] >= a[2] && b[3] >= a[3]);
  assert.ok(b.some((value, index) => value !== a[index]));
  const source = await sharp(wider.pixels).metadata();
  const mask = await sharp(wider.overlay).metadata();
  assert.equal(source.width, mask.width);
  assert.equal(source.height, mask.height);
});

test("one wider request leads to a second visual call, saved evidence, and required human review", async t => {
  const { store, session, budget } = await setup(t);
  const observations = [];
  const provider = async args => {
    observations.push(args);
    return { prediction: args.wider ? "Not a fan" : "Unsure",
      probabilities: args.wider ? { Fan: .02, "Not a fan": .96, Unsure: .02 } : { Fan: .08, "Not a fan": .02, Unsure: .9 },
      usage: { input_tokens: 229, generated_tokens: 0 }, cost_usd: null, response_id: "fake", elapsed_ms: 3 };
  };
  const runner = new ReviewRunner({ store, budget, provider });
  const run = await runner.enqueue(session, [session.candidates[0].id], "widercase123");
  await waitRun(run, runner);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].wider, false);
  assert.equal(observations[1].wider, true);
  assert.notDeepEqual(observations[0].evidence.pixels, observations[1].evidence.pixels);
  const result = run.results[session.candidates[0].id];
  assert.equal(result.action, "propose_reject");
  assert.equal(result.verdict, "not_fan");
  assert.equal(result.explanation_source, "application_rule");
  assert.equal(result.human_review_required, true);
  assert.ok(result.trace.some(item => item.type === "wider_view_created"));
  assert.equal(Object.keys(session.evidence).length, 2);
  assert.equal(budget.state.calls, 2);
  assert.equal(session.reviews[session.candidates[0].id], undefined);
  const repeated = await runner.enqueue(session, [session.candidates[0].id], "widercase123");
  assert.equal(repeated.id, run.id);
  await assert.rejects(runner.enqueue(session, [session.candidates[0].id], "anotherkey1"), /already has an agent run/);
});

test("a baseline result stays hidden until a separate timed human decision", async t => {
  const { store, session, budget } = await setup(t, "baseline");
  const provider = async () => ({ prediction: "Fan", probabilities: { Fan: .94, "Not a fan": .03, Unsure: .03 }, cost_usd: null });
  const runner = new ReviewRunner({ store, budget, provider });
  const cid = session.candidates[0].id;
  const run = await runner.enqueue(session, [cid], "blindcase123");
  await waitRun(run, runner);
  assert.deepEqual(runner.publicRun(session, run).results[cid], { hidden_until_review: true, status: "complete" });
  await store.review(session, { candidate_id: cid, stage: "timed", reviewer: "reviewer-b", decision: "unsure", duration_ms: 1234 });
  assert.equal(runner.publicRun(session, run).results[cid].action, "send_to_human");
  assert.equal(runner.publicRun(session, run).results[cid].verdict, "fan");
  await assert.rejects(store.review(session, { candidate_id: cid, stage: "timed", reviewer: "reviewer-b", decision: "accepted" }), /already saved/);
});

test("malformed follow-up and exhausted budget fail toward human review", async t => {
  assert.throws(() => validatePrediction({ prediction: "Not a fan", probabilities: { Fan: .3, "Not a fan": .3, Unsure: .3 } }));
  const { store, session, budget } = await setup(t);
  budget.dailyCallLimit = 1;
  let calls = 0;
  const runner = new ReviewRunner({ store, budget, provider: async () => {
    calls++;
    return { prediction: "Unsure", probabilities: { Fan: .04, "Not a fan": .04, Unsure: .92 }, cost_usd: null };
  } });
  const cid = session.candidates[0].id;
  const run = await runner.enqueue(session, [cid], "budgetcase12");
  await waitRun(run, runner);
  assert.equal(calls, 1);
  assert.equal(run.results[cid].action, "send_to_human");
  assert.equal(budget.state.calls, 1);
});

test("Jev provider sends one marked image and verifies the pinned model identity", async () => {
  const info = await imageInfo(image);
  const evidence = await makeEvidence(image, info, candidate, "initial");
  let request;
  const provider = makeJevProvider({ url: "http://127.0.0.1:8765", fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model_repo: MODEL_REPO, model_revision: MODEL_REVISION, backend: "cuda-bf16",
      request_id: "test-response", prediction: "Fan", probabilities: { Fan: .9, "Not a fan": .05, Unsure: .05 },
      metrics: { generated_tokens: 0 } }) };
  } });
  const result = await provider({ candidate, evidence, wider: false, timeout_ms: 1234.5 });
  assert.equal(result.prediction, "Fan");
  assert.equal(request.options.length, 3);
  assert.deepEqual(Buffer.from(request.image_base64, "base64"), evidence.overlay);
  assert.equal(result.cost_usd, null);
});

test("hosted Jev calls wait for a scaled-to-zero endpoint", async () => {
  let headers;
  const provider = makeJevProvider({
    url: "https://example.endpoints.huggingface.cloud", token: "test-token",
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return { ok: true, json: async () => ({ model_repo: MODEL_REPO, model_revision: MODEL_REVISION,
        backend: "cuda-bf16", prediction: "Unsure", probabilities: { Fan: .1, "Not a fan": .1, Unsure: .8 } }) };
    },
  });
  const result = await provider({ evidence: { overlay: Buffer.from("test") } });
  assert.equal(result.prediction, "Unsure");
  assert.equal(headers["x-scale-up-timeout"], "600");
  assert.equal(headers.authorization, "Bearer test-token");
});

test("hosted endpoint failure is identified so the demo can stop promptly", async () => {
  const provider = makeJevProvider({
    url: "https://example.endpoints.huggingface.cloud", token: "test-token",
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({
      error: "Bad Request: Your endpoint is in error, check its status on endpoints.huggingface.co", code: "BAD_REQUEST",
    }) }),
  });
  await assert.rejects(provider({ evidence: { overlay: Buffer.from("test") }, timeout_ms: 45000 }),
    error => error.endpointUnavailable === true && /HTTP 400/.test(error.message));
});

test("demo checks candidates concurrently and preserves terminal results", async t => {
  const { dir, store, session, budget } = await setup(t, "assisted", { demo: true, count: 3 });
  let active = 0, peak = 0, calls = 0;
  const provider = async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    return { prediction: "Fan", probabilities: { Fan: .94, "Not a fan": .03, Unsure: .03 }, cost_usd: null };
  };
  const runner = new ReviewRunner({ store, budget, provider });
  const run = await runner.enqueue(session, session.candidates.map(item => item.id), "demoparallel123");
  await waitRun(run, runner);
  assert.equal(calls, 3);
  assert.ok(peak > 1);
  assert.equal(Object.keys(run.results).length, 3);
  assert.ok(Object.values(run.results).every(result => result.status === "complete"));
  const saved = JSON.parse(await readFile(resolve(dir, "sessions", session.id, "session.json"), "utf8"));
  assert.equal(saved.runs[run.id].status, "complete");
  assert.equal(Object.keys(saved.runs[run.id].results).length, 3);
});

test("unavailable endpoint stops a research run after the first call", async t => {
  const { store, session, budget } = await setup(t, "assisted", { count: 3 });
  let calls = 0;
  const provider = async () => { calls++; const error = new Error("Jev service HTTP 400"); error.endpointUnavailable = true; throw error; };
  const runner = new ReviewRunner({ store, budget, provider });
  const run = await runner.enqueue(session, session.candidates.map(item => item.id), "unavailable123");
  await waitRun(run, runner);
  assert.equal(calls, 1);
  assert.equal(Object.keys(run.results).length, 3);
  assert.ok(Object.values(run.results).every(result => result.status === "unavailable"));
  assert.match(run.provider_unavailable, /GPU endpoint is unavailable/);
});

test("Jev scores produce three explicit verdicts and conservative wider-view requests", () => {
  const notFan = { prediction: "Not a fan", probabilities: { Fan: .02, "Not a fan": .95, Unsure: .03 } };
  const fan = { prediction: "Fan", probabilities: { Fan: .93, "Not a fan": .03, Unsure: .04 } };
  const weak = { prediction: "Not a fan", probabilities: { Fan: .3, "Not a fan": .45, Unsure: .25 } };
  assert.equal(reviewDecision(notFan).action, "propose_reject");
  assert.equal(reviewDecision(fan).verdict, "fan");
  assert.equal(reviewDecision(fan).action, "send_to_human");
  assert.equal(reviewDecision(weak).action, "request_wider_view");
  assert.equal(reviewDecision(weak, { wider: true }).verdict, "unsure");
});

test("local Jev call allowance does not mistake compute estimates for an API spending cap", async t => {
  const { dir } = await setup(t);
  const budget = new ReviewBudget(resolve(dir, "jev-budget.json"), { dailyCallLimit: 2, reservationUsd: 0 });
  assert.equal(budget.reserve("first", "run"), true);
  budget.reconcile("first", .001);
  assert.equal(budget.reserve("second", "run"), true);
  assert.equal(budget.reserve("third", "run"), false);
});

test("restart turns an interrupted paid run into visible human review without retrying", async t => {
  const { dir, store, session, budget } = await setup(t);
  const cid = session.candidates[0].id;
  session.runs["bfc945a5-c5e4-49ae-96e1-c4a9e562d4a9"] = { id: "bfc945a5-c5e4-49ae-96e1-c4a9e562d4a9",
    status: "running", candidates: [cid], results: {}, created_at: new Date().toISOString() };
  assert.equal(budget.reserve("unresolved-call", "interrupted-candidate"), true);
  await store.save(session);
  const restarted = new ReviewStore(resolve(dir, "sessions"));
  await restarted.init();
  const recovered = restarted.get(session.id).runs["bfc945a5-c5e4-49ae-96e1-c4a9e562d4a9"];
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.results[cid].action, "send_to_human");
  const newBudget = new ReviewBudget(resolve(dir, "budget.json"), { dailyCallLimit: 4, reservationUsd: 0 });
  assert.equal(newBudget.state.calls, 1);
  assert.equal(newBudget.state.reservations["unresolved-call"].cost_usd, null);
});
