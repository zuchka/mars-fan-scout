import type { Region, Size } from "../public/types.js";
import type { Point } from "../public/types.js";

export type SourceMeta = Size & {
  id: string; name: string; observation: string | null; original_sha256: string;
  display_sha256: string | null; original_format: string; preview: string;
  normalization: Record<string, unknown> | null;
  native_focus?: { x: number; y: number };
};
export type RegionImage = {
  bytes: Buffer; region: Region; output: Size; encoding: "png";
  sha256: string; normalization: SourceMeta["normalization"];
};

export type ModelBody = {
  error?: string;
  image?: Partial<Size>;
  predictions?: Array<{ confidence: number; points?: Array<Point | { x: number; y: number }> }>;
  [key: string]: unknown;
};
export type ModelResponse = { status: number; body: ModelBody };
export type ScanTile = Region & {
  scale: number; id: string; status: string; started_at?: string; dispatched_at?: string;
  finished_at?: string; error?: string; input?: Omit<RegionImage, "bytes">;
  response?: ModelBody;
};
export type ScanJob = {
  id: string; source_id: string; source_sha256: string; model_id: string;
  kind: "scan" | "refine"; region: Region; scale: number; box: Region | null;
  analysis: Record<string, unknown>; pipeline: string; retry_of: string | null;
  fingerprint: string; source: SourceMeta; created_at: string; status: string;
  tiles: ScanTile[]; finished_at?: string;
};
export type ScanRequest = { id: string; source_id: string; kind?: "scan" | "refine";
  region: Region; scale?: number; box?: Region; retry_of?: string };
