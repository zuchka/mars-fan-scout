import type { FringeEdit } from "./fringe.js";
import type { Point, Region, RLE, ReviewMap } from "./types.js";
import type { ModelBody, RegionImage, ScanJob, ScanRequest, ScanTile, SourceMeta } from "../scout/types.js";
import type { estimateFringe } from "./fringe.js";

export type ScanView = ScanJob & {
  candidates: Array<{ id: string; tile_id: string; polygon: Point[]; confidence: number;
    area: number; clipped?: boolean; duplicate_ids: string[] }>;
  completed: number; total: number; in_flight: number; daily_remaining: number | null;
};
export type JobView = ScanView & { submission?: ScanRequest };
export type PendingJob = { id: string; status: string; region: Region; scale: number;
  tiles: ScanTile[]; completed: number; total: number; submission: ScanRequest };
export type RefinedMask = { polygons: Point[][]; rle: RLE | null; mask_format: string;
  holes_preserved: boolean; job_id: string; created_at: string;
  input: Omit<RegionImage, "bytes">; raw_response: ModelBody };
export type FringeField = ReturnType<typeof estimateFringe> & {
  region: Region; created_at?: string; edits?: FringeEdit[]; hidden?: boolean;
  baseline?: FringeField | null;
};
export type DemoState = {
  code: string; access: boolean; source: SourceMeta | null; run: ScanView | null;
  job: JobView | PendingJob | null; selected: string | null;
  refined: Record<string, RefinedMask>; reviews: ReviewMap;
  edits: Record<string, FringeEdit[]>; fringes: Record<string, FringeField>;
  busy: boolean; refining: boolean; uploading: boolean; generation: number;
  detailToken: number; remaining: number | null; model: string | null;
  restored: boolean; hidden: boolean; estimate: number;
  worker: Worker | null;
  pendingRefine: { job_id: string; candidate_id: string; submission?: ScanRequest } | null;
  detail: { candidateId: string; region: Region; canvas: HTMLCanvasElement } | null;
  features: { native_refinement?: boolean; tiled_detection?: boolean; experimental_fringe?: boolean };
};
export type PersistedDemo = Pick<DemoState,
  "source" | "run" | "job" | "selected" | "refined" | "reviews" | "edits" |
  "fringes" | "model" | "pendingRefine"> & { version: number; pipeline: string };
