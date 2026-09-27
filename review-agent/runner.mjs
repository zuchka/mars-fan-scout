import { randomUUID } from "node:crypto";
import { makeEvidence } from "./evidence.mjs";
import { MODEL, PROMPT_VERSION, RATE, validateAction } from "./provider.mjs";

const now = () => new Date().toISOString();

export class ReviewRunner {
  constructor({ store, budget, provider }) {
    this.store = store; this.budget = budget; this.provider = provider;
    this.queue = []; this.working = false;
  }
  get enabled() { return !!this.provider && this.budget.enabled; }
  async enqueue(session, ids, key) {
    if (!this.enabled) throw new Error("Review agent is not configured");
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => !session.candidates.some(item => item.id === id)) || new Set(ids).size !== ids.length) throw new Error("Invalid candidate selection");
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(key)) throw new Error("Idempotency key required");
    if (session.idempotency[key]) return session.runs[session.idempotency[key]];
    if (session.fixture_id && (!session.candidates.every(item => Object.values(session.reviews).some(review => review.candidate_id === item.id && review.stage === "reference")) || ids.length !== session.candidates.length)) throw new Error("Complete the fixed blinded set, then run the full queue once");
    if (Object.values(session.runs).some(run => run.candidates.some(id => ids.includes(id)))) throw new Error("Candidate already has an agent run");
    const id = randomUUID();
    const run = { id, status: "queued", created_at: now(), started_at: null, finished_at: null,
      candidates: ids, results: {}, model: MODEL, prompt_version: PROMPT_VERSION, rate: RATE };
    session.runs[id] = run;
    session.idempotency[key] = id;
    await this.store.event(session, "run_queued", { run_id: id, candidates: ids });
    this.queue.push({ session, run });
    queueMicrotask(() => { this.drain().catch(error => console.error("Review runner stopped:", error.message)); });
    return run;
  }
  async drain() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const { session, run } = this.queue.shift();
        run.status = "running"; run.started_at = now();
        await this.store.event(session, "run_started", { run_id: run.id });
        for (const id of run.candidates) {
          const candidate = session.candidates.find(item => item.id === id);
          try { run.results[id] = await this.reviewCandidate(session, run, candidate); }
          catch (error) { run.results[id] = { action: "send_to_human", explanation: "Agent error: " + String(error.message).slice(0, 180), status: "error", trace: [] }; }
          await this.store.event(session, "candidate_terminal", { run_id: run.id, candidate_id: id, result: run.results[id] });
        }
        run.status = "complete"; run.finished_at = now();
        await this.store.event(session, "run_complete", { run_id: run.id });
      }
    } finally { this.working = false; }
  }
  async reviewCandidate(session, run, candidate) {
    const started = performance.now();
    const trace = [];
    const image = await this.store.source(session);
    const first = await makeEvidence(image, session.image, candidate, "initial");
    const initial = await this.store.saveEvidence(session, first);
    session.evidence[initial.id] = { ...initial, candidate_id: candidate.id };
    trace.push({ type: "evidence_created", evidence_id: initial.id, meta: first.meta, at: now() });
    await this.store.event(session, "evidence_created", { run_id: run.id, candidate_id: candidate.id, evidence_id: initial.id, meta: first.meta });
    const firstCall = await this.call(session, run, candidate, first, false, null, trace, started);
    if (!firstCall) return this.fallback(trace, started, "Provider unavailable or budget exhausted");
    if (firstCall.action.action !== "request_wider_view") return this.terminal(firstCall.action, trace, started);
    const wider = await makeEvidence(image, session.image, candidate, "wider");
    if (!wider) return this.fallback(trace, started, "Wider context unavailable at image boundary", "context_unavailable");
    const wide = await this.store.saveEvidence(session, wider);
    session.evidence[wide.id] = { ...wide, candidate_id: candidate.id };
    trace.push({ type: "wider_view_created", evidence_id: wide.id, meta: wider.meta, at: now() });
    await this.store.event(session, "wider_view_created", { run_id: run.id, candidate_id: candidate.id, evidence_id: wide.id, meta: wider.meta });
    const second = await this.call(session, run, candidate, wider, true, firstCall.action, trace, started);
    if (!second) return this.fallback(trace, started, "Follow-up unavailable or budget exhausted");
    return this.terminal(second.action, trace, started);
  }
  async call(session, run, candidate, evidence, wider, firstAction, trace, started) {
    const remaining = 75000 - (performance.now() - started);
    if (remaining <= 0) return null;
    const requestId = randomUUID();
    if (!this.budget.reserve(requestId, `${run.id}:${candidate.id}`)) return null;
    trace.push({ type: "provider_call_started", request_id: requestId, wider, reserved_usd: 0.01, at: now() });
    await this.store.event(session, "provider_call_started", { run_id: run.id, candidate_id: candidate.id, request_id: requestId, wider, reserved_usd: 0.01 });
    try {
      const result = await this.provider({ candidate, evidence, wider, firstAction, timeout_ms: remaining });
      const action = validateAction(result.action, wider);
      this.budget.reconcile(requestId, result.cost_usd);
      const event = { type: "provider_call_completed", request_id: requestId, wider, action, response_id: result.response_id || null,
        usage: result.usage || null, cost_usd: result.cost_usd ?? null, latency_ms: result.elapsed_ms ?? null, at: now() };
      trace.push(event);
      await this.store.event(session, "provider_call_completed", { run_id: run.id, candidate_id: candidate.id, ...event });
      return { action };
    } catch (error) {
      const event = { type: "provider_call_failed", request_id: requestId, wider, error: String(error.message).slice(0, 180), cost_usd: null, at: now() };
      trace.push(event);
      await this.store.event(session, "provider_call_failed", { run_id: run.id, candidate_id: candidate.id, ...event });
      return null;
    }
  }
  terminal(action, trace, started) { return { ...action, status: "complete", trace, elapsed_ms: Math.round(performance.now() - started), human_review_required: true }; }
  fallback(trace, started, explanation, status = "fallback") {
    return { action: "send_to_human", explanation, context_check: "unresolved", status, trace,
      elapsed_ms: Math.round(performance.now() - started), human_review_required: true };
  }
  publicRun(session, run) {
    return { ...run, results: Object.fromEntries(Object.entries(run.results).map(([id, result]) => {
      const candidate = session.candidates.find(item => item.id === id);
      const reviewed = Object.values(session.reviews).some(item => item.candidate_id === id && item.stage === "timed");
      return [id, candidate?.arm === "baseline" && !reviewed ? { hidden_until_review: true, status: result.status } : result];
    })) };
  }
}
