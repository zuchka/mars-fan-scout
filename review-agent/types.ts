import type { Point } from "../public/types.js";
import type { WorkingImageInfo } from "./evidence.mjs";

export type ReviewCandidate = {
  id: string; label: string; polygon: Point[]; confidence: number; arm: "baseline" | "assisted";
};
export type HumanReview = {
  candidate_id: string; stage: "reference" | "timed" | "adjudication"; reviewer: string;
  decision: "accepted" | "rejected" | "unsure"; duration_ms: number | null;
  arm: ReviewCandidate["arm"]; at: string;
};
export type ReviewTrace = { type: string; at: string; [key: string]: unknown };
export type ReviewResult = {
  action: string; verdict: string; explanation: string; explanation_source: string;
  status: string; human_review_required: boolean; trace?: ReviewTrace[];
  elapsed_ms?: number; [key: string]: unknown;
};
export type ReviewRun = {
  id: string; status: string; created_at: string; started_at: string | null; finished_at: string | null;
  candidates: string[]; results: Record<string, ReviewResult>; model: string;
  provider: Record<string, unknown>; prompt_version: string; policy_version: string;
  policy: { minProbability: number; minMargin: number };
  provider_unavailable?: string; image_read_ms?: number | null; elapsed_ms?: number;
};
export type StoredEvidence = {
  id: string; candidate_id: string; source_name: string; overlay_name: string;
  [key: string]: unknown;
};
export type ReviewSession = {
  format: string; id: string; created_at: string; demo: boolean;
  image: WorkingImageInfo & { original_sha256: string | null; name: string | null; observation: string | null };
  snapshot_sha256: string; detector_model: string | null; detector_responses_sha256: string;
  fixture_id: string | null; candidates: ReviewCandidate[]; runs: Record<string, ReviewRun>;
  reviews: Record<string, HumanReview>; evidence: Record<string, StoredEvidence>;
  idempotency: Record<string, string>;
};
