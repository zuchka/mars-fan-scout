import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha } from "./source-store.mjs";
import {
  tilesForRegion,
  clipRegion,
  mapPoints,
  bounds,
  mergeCandidates,
} from "../public/geometry.js";
import { polygonArea } from "../public/candidates.js";
import type { Proposal } from "../public/types.js";
import type { createDemoAccess } from "../demo-access.mjs";
import type { ModelResponse, ScanJob, ScanRequest, ScanTile } from "./types.js";
import type { SourceStore } from "./source-store.mjs";
export class ScanJobs {
  directory: string;
  sources: SourceStore;
  access: ReturnType<typeof createDemoAccess>;
  infer: (image: Buffer) => Promise<ModelResponse>;
  refine: (request: { image: Buffer; width: number; height: number;
    boxes: Array<{ box: ScanJob["box"] }>; format: "rle" }) => Promise<ModelResponse>;
  modelId: string;
  concurrency: number;
  jobs: Map<string, ScanJob>;
  saves: Map<string, Promise<void>>;
  running: number;
  pumping: boolean;

  constructor({
    directory,
    sources,
    access,
    infer,
    refine,
    modelId,
    concurrency = 2,
  }: { directory: string; sources: SourceStore; access: ReturnType<typeof createDemoAccess>;
    infer: ScanJobs["infer"]; refine: ScanJobs["refine"]; modelId: string; concurrency?: number }) {
    this.directory = directory;
    this.sources = sources;
    this.access = access;
    this.infer = infer;
    this.refine = refine;
    this.modelId = modelId;
    this.concurrency = concurrency;
    this.jobs = new Map();
    this.saves = new Map();
    this.running = 0;
    this.pumping = false;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        let job: ScanJob;
        try {
          job = JSON.parse(await readFile(join(this.directory, name), "utf8")) as ScanJob;
          if (job.id + ".json" !== name || !Array.isArray(job.tiles))
            throw new Error("Invalid saved job");
        } catch {
          await rename(
            join(this.directory, name),
            join(this.directory, name + ".invalid"),
          );
          console.warn(`Quarantined unreadable scan job ${name}`);
          continue;
        }
        if (["running", "queued", "cancelled"].includes(job.status)) {
          if (job.status !== "cancelled") job.status = "interrupted";
          job.finished_at = new Date().toISOString();
          for (const tile of job.tiles)
            if (tile.status === "running") {
              tile.status = tile.dispatched_at ? "unknown" : "queued";
              tile.error = tile.dispatched_at
                ? "Server restarted after dispatch; provider outcome unknown"
                : "Interrupted before provider dispatch";
            }
        }
        this.jobs.set(job.id, job);
        await this.save(job);
      }
  }
  save(job: ScanJob): Promise<void> {
    const snapshot = JSON.stringify(job),
      previous = this.saves.get(job.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const path = join(this.directory, job.id + ".json");
        await writeFile(path + ".tmp", snapshot, { mode: 0o600 });
        await rename(path + ".tmp", path);
      });
    this.saves.set(job.id, next);
    return next;
  }
  async create(body: ScanRequest): Promise<ScanJob> {
    if (!/^[a-f0-9-]{36}$/.test(body.id || ""))
      throw new Error("A unique request ID is required");
    const source = await this.sources.meta(body.source_id);
    if (body.kind && !["scan", "refine"].includes(body.kind))
      throw new Error("Unknown scan type");
    const kind = body.kind === "refine" ? "refine" : "scan";
    const region = clipRegion(body.region, source),
      scale = Number(body.scale || 1);
    const analysis = {
      normalization: source.normalization || null,
      display_sha256: source.display_sha256 || null,
      encoding: "png",
      sampling: "fixed-source-scale-v1",
      tile_size: 1024,
      overlap: 128,
      proposal_floor: 0.2,
      provider_internal_resolution: null,
      mask_format: kind === "refine" ? "rle" : "polygon",
    };
    const config: Pick<ScanJob, "source_id" | "source_sha256" | "model_id" | "kind" | "region" | "scale" | "box" | "analysis" | "pipeline" | "retry_of"> = {
      source_id: source.id,
      source_sha256: source.original_sha256,
      model_id: kind === "scan" ? this.modelId : "sam3/visual_segment",
      kind,
      region,
      scale,
      box: kind === "refine" ? body.box ?? null : null,
      analysis,
      pipeline: "native-v1",
      retry_of: body.retry_of || null,
    };
    if (![1, 2, 4].includes(scale)) throw new Error("Invalid image scale");
    if (kind === "refine") {
      if (scale !== 1) throw new Error("Native tracing requires scale 1");
      const b = body.box;
      if (
        !b ||
        ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
        b.width < 4 ||
        b.height < 4 ||
        b.x < 0 ||
        b.y < 0 ||
        b.x > region.width ||
        b.y > region.height ||
        b.width > region.width * 2 ||
        b.height > region.height * 2
      )
        throw new Error("Invalid source-region box");
      if (Math.max(region.width, region.height) > 2048)
        throw new Error(
          "This region exceeds 2048 native pixels. Choose a smaller context for native tracing",
        );
    }
    const fingerprint = sha(Buffer.from(JSON.stringify(config)));
    if (this.jobs.has(body.id)) {
      const existing = this.jobs.get(body.id)!;
      if (existing.fingerprint !== fingerprint)
        throw new Error("Request ID is already used for different inputs");
      return existing;
    }
    if (
      [...this.jobs.values()].filter((j) =>
        ["queued", "running"].includes(j.status),
      ).length >= 4
    )
      throw new Error("Four jobs are already active. Wait or cancel a scan");
    let tiles: ScanTile[] = (
      kind === "scan"
        ? tilesForRegion(region, scale)
        : [{ ...region, scale: 1 }]
    ).map((t, i) => ({ ...t, id: String(i), status: "queued" }));
    if (tiles.length > 25)
      throw new Error(
        "This view needs more than 25 requests. Zoom in or choose a smaller scan area",
      );
    if (body.retry_of) {
      const previous = this.jobs.get(body.retry_of);
      if (
        !previous ||
        previous.source_id !== config.source_id ||
        previous.source_sha256 !== config.source_sha256 ||
        previous.model_id !== config.model_id ||
        previous.kind !== kind ||
        previous.scale !== scale ||
        JSON.stringify(previous.analysis) !== JSON.stringify(analysis) ||
        JSON.stringify(previous.region) !== JSON.stringify(region) ||
        JSON.stringify(previous.box) !== JSON.stringify(config.box) ||
        ["queued", "running"].includes(previous.status) ||
        previous.tiles.some((t) => t.status === "running")
      )
        throw new Error("Retry must match a finished job and its settings");
      tiles = tiles.map((t) =>
        previous.tiles.find((p) => p.id === t.id)?.status === "complete"
          ? structuredClone(previous.tiles.find((p) => p.id === t.id)!)
          : t,
      );
    }
    const needed = tiles.filter((t) => t.status === "queued").length,
      remaining = this.access.remaining();
    if (remaining !== null && needed > remaining)
      throw new Error(
        `This scan needs ${needed} requests; ${remaining} remain today`,
      );
    const job: ScanJob = {
      id: body.id,
      ...config,
      fingerprint,
      source,
      created_at: new Date().toISOString(),
      status: needed ? "queued" : "complete",
      tiles,
    };
    this.jobs.set(job.id, job);
    try {
      await this.save(job);
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    void this.pump();
    return job;
  }
  async cancel(id: string): Promise<ScanJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job");
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelled";
      for (const tile of job.tiles)
        if (tile.status === "queued") tile.status = "cancelled";
      job.finished_at = new Date().toISOString();
      await this.save(job);
    }
    return job;
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running < this.concurrency) {
        const job = [...this.jobs.values()].find(
          (j) =>
            ["queued", "running"].includes(j.status) &&
            j.tiles.some((t) => t.status === "queued"),
        );
        if (!job) break;
        const tile = job.tiles.find((t) => t.status === "queued")!;
        tile.status = "running";
        job.status = "running";
        this.running++;
        void this.execute(job, tile)
          .catch((error: unknown) => {
            job.status = "failed";
            tile.status = "failed";
            tile.error = `Job persistence failed: ${error instanceof Error ? error.message : String(error)}`;
          })
          .finally(() => {
            this.running--;
            void this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }
  async execute(job: ScanJob, tile: ScanTile): Promise<void> {
    try {
      tile.started_at = new Date().toISOString();
      await this.save(job);
      const image = await this.sources.region(
        job.source_id,
        tile,
        job.kind === "refine" ? 2048 : 1024,
        { analysisScale: job.kind === "refine" ? 1 : tile.scale },
      );
      if (job.status === "cancelled") {
        tile.status = "cancelled";
        return;
      }
      if (!this.access.reserve())
        throw new Error("Daily provider request allowance exhausted");
      tile.dispatched_at = new Date().toISOString();
      tile.input = {
        region: {
          x: image.region.x,
          y: image.region.y,
          width: image.region.width,
          height: image.region.height,
        },
        output: image.output,
        encoding: image.encoding,
        sha256: image.sha256,
        normalization: image.normalization,
      };
      await this.save(job);
      const response =
        job.kind === "refine"
          ? await this.refine({
              image: image.bytes,
              width: image.output.width,
              height: image.output.height,
              boxes: [{ box: job.box }],
              format: "rle",
            })
          : await this.infer(image.bytes);
      if (response.status !== 200)
        throw new Error(response.body.error || "Model request failed");
      tile.response = response.body;
      tile.status = "complete";
      tile.finished_at = new Date().toISOString();
    } catch (error) {
      tile.status = "failed";
      tile.error = String(error instanceof Error ? error.message : error);
      tile.finished_at = new Date().toISOString();
    } finally {
      if (
        job.status !== "cancelled" &&
        !job.tiles.some((t) => ["queued", "running"].includes(t.status))
      ) {
        job.status = job.tiles.every((t) => t.status === "complete")
          ? "complete"
          : job.tiles.some((t) => t.status === "complete")
            ? "partial"
            : "failed";
        job.finished_at = new Date().toISOString();
      }
      await this.save(job);
    }
  }
  public(job: ScanJob | null): ScanJob & { candidates: Array<Proposal & { duplicate_ids: string[] }>;
    completed: number; total: number; in_flight: number; daily_remaining: number | null } {
    if (!job) throw new Error("Unknown job");
    let candidateOrigin = job;
    const ancestors = new Set<string>();
    while (candidateOrigin.retry_of && this.jobs.has(candidateOrigin.retry_of) &&
      !ancestors.has(candidateOrigin.retry_of)) {
      ancestors.add(candidateOrigin.id);
      candidateOrigin = this.jobs.get(candidateOrigin.retry_of)!;
    }
    const candidates: Proposal[] = [];
    if (job.kind === "scan")
      for (const tile of job.tiles.filter((t) => t.status === "complete")) {
        const response = tile.response!;
        for (const [i, p] of (response.predictions || []).entries()) {
          if (
            Number(p.confidence) < 0.2 ||
            !Number.isFinite(Number(p.confidence)) ||
            !Array.isArray(p.points) ||
            p.points.length < 3
          )
            continue;
          const input =
            response.image?.width && response.image?.height
              ? { width: response.image.width, height: response.image.height }
              : tile.input!.output;
          const polygon = mapPoints(p.points, tile, input);
          if (
            !polygon.flat().every(Number.isFinite) ||
            polygon.some(
              ([x, y]) =>
                x < tile.x ||
                y < tile.y ||
                x > tile.x + tile.width ||
                y > tile.y + tile.height,
            )
          )
            continue;
          const b = bounds(polygon),
            margin = tile.scale * 2;
          candidates.push({
            id: `${candidateOrigin.id}:${tile.id}:${i}`,
            tile_id: tile.id,
            polygon,
            confidence: Number(p.confidence),
            area: polygonArea(polygon),
            clipped:
              b.x <= tile.x + margin ||
              b.y <= tile.y + margin ||
              b.x + b.width >= tile.x + tile.width - margin ||
              b.y + b.height >= tile.y + tile.height - margin,
          });
        }
      }
    return {
      ...job,
      candidates: mergeCandidates(candidates),
      completed: job.tiles.filter((t) => t.status === "complete").length,
      total: job.tiles.length,
      in_flight: job.tiles.filter((t) => t.status === "running").length,
      daily_remaining: this.access.remaining(),
    };
  }
}
