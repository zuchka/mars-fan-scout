const DECISIONS = new Set(["accepted", "rejected", "unsure"]);

export function isReviewed(reviews, candidateId) {
  return DECISIONS.has(reviews[candidateId]?.decision);
}

export function normalizeReviews(reviews) {
  return Object.fromEntries(
    Object.entries(reviews || {}).filter(([, record]) => DECISIONS.has(record?.decision)),
  );
}

export function reviewProgress(candidates, reviews) {
  return candidates.filter((candidate) => isReviewed(reviews, candidate.id)).length;
}

export function nextUnreviewed(candidates, reviews, currentId) {
  const current = candidates.findIndex((candidate) => candidate.id === currentId);
  for (let offset = 1; offset < candidates.length; offset++) {
    const candidate = candidates[(current + offset) % candidates.length];
    if (!isReviewed(reviews, candidate.id)) return candidate;
  }
  return null;
}

export function setReview(reviews, candidateId, decision, sourceHash, at) {
  if (decision === "pending") {
    delete reviews[candidateId];
    return;
  }
  if (!DECISIONS.has(decision)) throw new Error("Unknown review decision");
  reviews[candidateId] = {
    decision,
    at,
    candidate_id: candidateId,
    source_sha256: sourceHash,
  };
}

export function recordsForScan(result, records) {
  const ids = new Set(result.candidates.map((candidate) => candidate.id));
  const keep = (items) => result.retry_of
    ? Object.fromEntries(Object.entries(items).filter(([id]) => ids.has(id)))
    : {};
  return {
    reviews: keep(records.reviews),
    refined: keep(records.refined),
    edits: keep(records.edits),
    fringes: keep(records.fringes),
  };
}
