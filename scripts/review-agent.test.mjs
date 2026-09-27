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
import { makeOpenAIProvider, validateAction } from "../review-agent/provider.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(await readFile(resolve(root, "evaluation/agent-review/manifest.json"), "utf8")).crops[0];
const image = await readFile(resolve(root, fixture.image));
const candidate = fixture.candidates[0];

async function setup(t, arm = "assisted") {
  const dir = await mkdtemp(resolve(tmpdir(), "mars-agent-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReviewStore(resolve(dir, "sessions"));
  await store.init();
  const session = await store.create({ image_base64: image.toString("base64"), detector_model: "frozen-test",
    candidates: [{ ...candidate, arm }] });
  const budget = new ReviewBudget(resolve(dir, "budget.json"), { dailyCallLimit: 4, dailyUsdLimit: 1, perRunUsdLimit: .02 });
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
    return { action: args.wider ? { action: "propose_reject", explanation: "Wider pixels show a straight image seam", context_check: "resolved" }
      : { action: "request_wider_view", explanation: "The edge is ambiguous", context_check: "not_requested" },
      usage: { input_tokens: 1000, output_tokens: 60 }, cost_usd: .0005, response_id: "fake", elapsed_ms: 3 };
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
  const provider = async () => ({ action: { action: "send_to_human", explanation: "Uncertain shape", context_check: "not_requested" }, cost_usd: .0004 });
  const runner = new ReviewRunner({ store, budget, provider });
  const cid = session.candidates[0].id;
  const run = await runner.enqueue(session, [cid], "blindcase123");
  await waitRun(run, runner);
  assert.deepEqual(runner.publicRun(session, run).results[cid], { hidden_until_review: true, status: "complete" });
  await store.review(session, { candidate_id: cid, stage: "timed", reviewer: "reviewer-b", decision: "unsure", duration_ms: 1234 });
  assert.equal(runner.publicRun(session, run).results[cid].action, "send_to_human");
  await assert.rejects(store.review(session, { candidate_id: cid, stage: "timed", reviewer: "reviewer-b", decision: "accepted" }), /already saved/);
});

test("malformed follow-up and exhausted budget fail toward human review", async t => {
  assert.throws(() => validateAction({ action: "propose_reject", explanation: "Maybe", context_check: "unresolved" }, true));
  const { store, session, budget } = await setup(t);
  budget.dailyCallLimit = 1;
  let calls = 0;
  const runner = new ReviewRunner({ store, budget, provider: async () => {
    calls++;
    return { action: { action: "request_wider_view", explanation: "Need context", context_check: "not_requested" }, cost_usd: .0005 };
  } });
  const cid = session.candidates[0].id;
  const run = await runner.enqueue(session, [cid], "budgetcase12");
  await waitRun(run, runner);
  assert.equal(calls, 1);
  assert.equal(run.results[cid].action, "send_to_human");
  assert.equal(budget.state.calls, 1);
});

test("provider sends two real image inputs, structured action schema, and no server-side storage request", async () => {
  const info = await imageInfo(image);
  const evidence = await makeEvidence(image, info, candidate, "initial");
  let request;
  const provider = makeOpenAIProvider({ key: "test-only", fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: "completed", id: "test-response", usage: { input_tokens: 900, output_tokens: 40 },
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "send_to_human", explanation: "Unclear pixels", context_check: "not_requested" }) }] }] }) };
  } });
  const result = await provider({ candidate, evidence, wider: false });
  assert.equal(result.action.action, "send_to_human");
  assert.equal(request.store, false);
  assert.equal(request.input[0].content.filter(item => item.type === "input_image").length, 2);
  assert.equal(request.text.format.type, "json_schema");
  assert.ok(result.cost_usd > 0);
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
  const newBudget = new ReviewBudget(resolve(dir, "budget.json"), { dailyCallLimit: 4, dailyUsdLimit: 1, perRunUsdLimit: .02 });
  assert.equal(newBudget.state.calls, 1);
  assert.equal(newBudget.state.reservations["unresolved-call"].cost_usd, null);
});
