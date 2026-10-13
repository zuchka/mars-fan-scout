import assert from "node:assert/strict";
import test from "node:test";
import { isReviewed, nextUnreviewed, normalizeReviews, recordsForScan, reviewProgress, setReview } from "../public/review-flow.js";

test("clearing a review removes its saved decision and progress", () => {
  const candidates = [{ id: "a" }, { id: "b" }];
  const reviews = {};
  setReview(reviews, "a", "accepted", "source-hash", "2026-10-13T00:00:00Z");
  assert.equal(reviewProgress(candidates, reviews), 1);
  assert.equal(reviews.a.source_sha256, "source-hash");
  setReview(reviews, "a", "pending");
  assert.equal(isReviewed(reviews, "a"), false);
  assert.equal(reviewProgress(candidates, reviews), 0);
  assert.equal(Object.hasOwn(reviews, "a"), false);
  assert.deepEqual(normalizeReviews({ a: { decision: "pending" }, b: { decision: "unsure" } }),
    { b: { decision: "unsure" } });
});

test("next unreviewed skips completed decisions and wraps through the queue", () => {
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const reviews = { b: { decision: "rejected" }, c: { decision: "unsure" } };
  assert.equal(nextUnreviewed(candidates, reviews, "b")?.id, "a");
  assert.equal(nextUnreviewed(candidates, reviews, "a"), null);
  setReview(reviews, "a", "accepted", "hash", "now");
  assert.equal(reviewProgress(candidates, reviews), 3);
  assert.equal(nextUnreviewed(candidates, reviews, "b"), null);
});

test("a fresh scan clears associations while a retry keeps matching candidate IDs", () => {
  const records = {
    reviews: { a: { decision: "accepted" }, b: { decision: "unsure" } },
    refined: { a: { mask: true } },
    edits: { b: [{ x: 1 }] },
    fringes: {},
  };
  const candidates = [{ id: "a" }, { id: "c" }];
  assert.deepEqual(recordsForScan({ candidates }, records), {
    reviews: {}, refined: {}, edits: {}, fringes: {},
  });
  assert.deepEqual(recordsForScan({ candidates, retry_of: "prior-run" }, records), {
    reviews: { a: { decision: "accepted" } },
    refined: { a: { mask: true } }, edits: {}, fringes: {},
  });
});
