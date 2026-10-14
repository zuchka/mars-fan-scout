import type { ReviewDecision, ReviewMap, ReviewRecord } from "./types.js";

const DECISIONS: ReadonlySet<string> = new Set<ReviewDecision>(["accepted", "rejected", "unsure"]);
type Identified = { id: string };
type ScanRecords = {
  reviews: ReviewMap;
  refined: Record<string, unknown>;
  edits: Record<string, unknown>;
  fringes: Record<string, unknown>;
};

export function isReviewed(reviews: ReviewMap, candidateId: string): boolean {
  return DECISIONS.has(reviews[candidateId]?.decision);
}

export function normalizeReviews(reviews: Record<string, Partial<ReviewRecord>> | null | undefined): ReviewMap {
  return Object.fromEntries(
    Object.entries(reviews || {}).filter((entry): entry is [string, ReviewRecord] => DECISIONS.has(entry[1]?.decision ?? "")),
  );
}

export function reviewProgress(candidates: Identified[], reviews: ReviewMap): number {
  return candidates.filter((candidate) => isReviewed(reviews, candidate.id)).length;
}

export function nextUnreviewed<T extends Identified>(candidates: T[], reviews: ReviewMap, currentId: string | null): T | null {
  const current = candidates.findIndex((candidate) => candidate.id === currentId);
  for (let offset = 1; offset < candidates.length; offset++) {
    const candidate = candidates[(current + offset) % candidates.length];
    if (!isReviewed(reviews, candidate.id)) return candidate;
  }
  return null;
}

export function setReview(reviews: ReviewMap, candidateId: string, decision: string, sourceHash = "", at = ""): void {
  if (decision === "pending") {
    delete reviews[candidateId];
    return;
  }
  if (!DECISIONS.has(decision)) throw new Error("Unknown review decision");
  reviews[candidateId] = {
    decision: decision as ReviewDecision,
    at,
    candidate_id: candidateId,
    source_sha256: sourceHash,
  };
}

export function recordsForScan(result: { candidates: Identified[]; retry_of?: string | null }, records: ScanRecords): ScanRecords {
  const ids = new Set(result.candidates.map((candidate) => candidate.id));
  const keep = <T>(items: Record<string, T>): Record<string, T> => result.retry_of
    ? Object.fromEntries(Object.entries(items).filter(([id]) => ids.has(id)))
    : {};
  return {
    reviews: keep(records.reviews),
    refined: keep(records.refined),
    edits: keep(records.edits),
    fringes: keep(records.fringes),
  };
}
