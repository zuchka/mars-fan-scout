import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { imageInfo, sha256, validateCandidate } from "./evidence.mjs";

const idPattern = /^[a-f0-9-]{36}$/;
const clean = value => typeof value === "string" ? value.slice(0, 300) : null;

export class ReviewStore {
  constructor(root) { this.root = root; this.sessions = new Map(); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!idPattern.test(name)) continue;
      try {
        const session = JSON.parse(await readFile(resolve(this.root, name, "session.json"), "utf8"));
        for (const run of Object.values(session.runs || {})) {
          if (["queued", "running"].includes(run.status)) {
            run.status = "interrupted";
            run.finished_at = new Date().toISOString();
            for (const cid of run.candidates) if (!run.results[cid]) run.results[cid] = { action: "send_to_human", explanation: "Agent run interrupted; billing may be unknown", status: "interrupted" };
          }
        }
        this.sessions.set(name, session);
        await this.save(session);
      } catch (_) { /* Corrupt sessions stay inaccessible rather than being guessed. */ }
    }
  }
  get(id) { return idPattern.test(id || "") ? this.sessions.get(id) : null; }
  path(id, file) { if (!idPattern.test(id)) throw new Error("Invalid session ID"); return resolve(this.root, id, file); }
  async save(session) {
    const path = this.path(session.id, "session.json");
    const tmp = path + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
    await rename(tmp, path);
  }
  async event(session, type, detail) {
    const row = { at: new Date().toISOString(), type, ...detail };
    const file = await open(this.path(session.id, "events.jsonl"), "a", 0o600);
    try { await file.appendFile(JSON.stringify(row) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await this.save(session);
    return row;
  }
  async create(body) {
    if (!body || typeof body.image_base64 !== "string" || body.image_base64.length > 56 * 1024 * 1024 || !Array.isArray(body.candidates) || body.candidates.length < 1 || body.candidates.length > 250) throw new Error("Invalid review session");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image_base64)) throw new Error("Invalid image encoding");
    const image = Buffer.from(body.image_base64, "base64");
    const info = await imageInfo(image);
    const candidates = [];
    const seen = new Set();
    for (const [index, item] of body.candidates.entries()) {
      validateCandidate(item, info);
      const polygon = item.polygon.map(point => point.map(Number));
      const confidence = Number(item.confidence);
      const canonical = JSON.stringify({ index, polygon, confidence });
      const id = sha256(info.sha256 + canonical).slice(0, 20);
      if (seen.has(id)) throw new Error("Duplicate candidate");
      seen.add(id);
      candidates.push({ id, label: clean(item.label) || `RF-${index + 1}`, polygon, confidence,
        arm: item.arm === "baseline" ? "baseline" : "assisted" });
    }
    const rawDetector = JSON.stringify(Array.isArray(body.detector_responses) ? body.detector_responses : []);
    if (Buffer.byteLength(rawDetector) > 10 * 1024 * 1024) throw new Error("Detector snapshot exceeds 10 MB");
    const id = randomUUID();
    const snapshot_sha256 = sha256(JSON.stringify(candidates));
    const session = { format: "mars-fan-scout-review-v3", id, created_at: new Date().toISOString(),
      image: { ...info, original_sha256: clean(body.original_sha256), name: clean(body.name), observation: clean(body.observation) },
      snapshot_sha256, detector_model: clean(body.detector_model), detector_responses_sha256: sha256(rawDetector),
      fixture_id: clean(body.fixture_id), candidates, runs: {}, reviews: {}, evidence: {}, idempotency: {} };
    await mkdir(this.path(id, ""), { mode: 0o700 });
    await writeFile(this.path(id, "working-image." + (info.format === "png" ? "png" : "jpg")), image, { mode: 0o600 });
    await writeFile(this.path(id, "detector-responses.json"), rawDetector, { mode: 0o600 });
    this.sessions.set(id, session);
    await this.event(session, "session_created", { snapshot_sha256, candidate_count: candidates.length });
    return session;
  }
  async source(session) { return readFile(this.path(session.id, "working-image." + (session.image.format === "png" ? "png" : "jpg"))); }
  async saveEvidence(session, evidence) {
    const id = randomUUID();
    const sourceName = `${id}-source.jpg`, overlayName = `${id}-mask.jpg`;
    await writeFile(this.path(session.id, sourceName), evidence.pixels, { mode: 0o600 });
    await writeFile(this.path(session.id, overlayName), evidence.overlay, { mode: 0o600 });
    return { id, ...evidence.meta, source_name: sourceName, overlay_name: overlayName };
  }
  async review(session, body) {
    const candidate = session.candidates.find(item => item.id === body?.candidate_id);
    if (!candidate || !["accepted", "rejected", "unsure"].includes(body.decision) || !["reference", "timed", "adjudication"].includes(body.stage)) throw new Error("Invalid human review");
    if (typeof body.reviewer !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(body.reviewer)) throw new Error("Invalid reviewer ID");
    const key = `${candidate.id}:${body.stage}:${body.reviewer}`;
    if (session.fixture_id && body.stage === "timed") {
      if (!session.candidates.every(item => Object.values(session.reviews).some(review => review.candidate_id === item.id && review.stage === "reference"))) throw new Error("Complete blinded reference reviews first");
      if (Object.values(session.reviews).some(review => review.stage === "reference" && review.reviewer === body.reviewer)) throw new Error("Timed reviewer must be different from the reference reviewer");
    }
    if (session.reviews[key]) {
      if (session.reviews[key].decision !== body.decision) throw new Error("This review is already saved; revisions require a new adjudication record");
      return session.reviews[key];
    }
    const duration_ms = Number.isFinite(body.duration_ms) && body.duration_ms >= 0 && body.duration_ms <= 3600000 ? Math.round(body.duration_ms) : null;
    const record = { candidate_id: candidate.id, stage: body.stage, reviewer: body.reviewer, decision: body.decision, duration_ms,
      arm: candidate.arm, at: new Date().toISOString() };
    session.reviews[key] = record;
    await this.event(session, "human_review", record);
    return record;
  }
}
