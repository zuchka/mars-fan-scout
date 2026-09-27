import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass one or more completed session export JSON files");
const sessions = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8"))));
for (const session of sessions) {
  if (!session.candidates?.length || !session.candidates.every(candidate => Object.values(session.reviews || {}).some(review => review.candidate_id === candidate.id && review.stage === "timed"))) {
    throw new Error(`Session ${session.id} has incomplete timed reviews`);
  }
  if (!session.candidates.every(candidate => Object.values(session.runs || {}).some(run => run.results?.[candidate.id]))) {
    throw new Error(`Session ${session.id} has candidates without a terminal agent result`);
  }
}
const rows = [];
for (const session of sessions) for (const candidate of session.candidates) {
  const reviews = Object.values(session.reviews).filter(item => item.candidate_id === candidate.id);
  const reference = reviews.find(item => item.stage === "reference");
  const timed = reviews.find(item => item.stage === "timed");
  const adjudicated = reviews.find(item => item.stage === "adjudication");
  const result = Object.values(session.runs).find(run => run.candidates.includes(candidate.id))?.results?.[candidate.id] || null;
  rows.push({ session_id: session.id, candidate_id: candidate.id, label: candidate.label, arm: candidate.arm,
    reference: (adjudicated || reference)?.decision || null, timed: timed?.decision || null,
    active_ms: timed?.duration_ms ?? null, result });
}
const count = predicate => rows.filter(predicate).length;
const median = numbers => {
  const values = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2 : null;
};
const seconds = arm => rows.filter(row => row.arm === arm).map(row => row.active_ms === null ? null : row.active_ms / 1000).filter(Number.isFinite);
const baseline = seconds("baseline"), assisted = seconds("assisted");
const proposed = rows.filter(row => row.result?.action === "propose_reject");
const calls = rows.flatMap(row => row.result?.trace?.filter(item => item.type === "provider_call_completed" || item.type === "provider_call_failed") || []);
const knownCost = calls.reduce((sum, item) => sum + (Number.isFinite(item.cost_usd) ? item.cost_usd : 0), 0);
const unknownCost = calls.filter(item => !Number.isFinite(item.cost_usd)).length;
const metrics = {
  sessions: sessions.length, candidates: rows.length,
  arms: { baseline: baseline.length, assisted: assisted.length },
  median_active_seconds: { baseline: median(baseline), assisted: median(assisted) },
  descriptive_median_difference_seconds: median(baseline) !== null && median(assisted) !== null ? median(baseline) - median(assisted) : null,
  proposed_rejections: proposed.length,
  proposed_rejections_reference_accepted: proposed.filter(row => row.reference === "accepted").length,
  proposed_rejections_reference_rejected: proposed.filter(row => row.reference === "rejected").length,
  proposed_rejections_reference_unsure: proposed.filter(row => row.reference === "unsure").length,
  reference_accepted: count(row => row.reference === "accepted"),
  harmful_proposal_rate_among_reference_accepted: count(row => row.reference === "accepted") ? proposed.filter(row => row.reference === "accepted").length / count(row => row.reference === "accepted") : null,
  wider_requests: count(row => row.result?.trace?.some(item => item.type === "wider_view_created")),
  agent_fallbacks: count(row => row.result && row.result.status !== "complete"),
  agent_latency_median_seconds: median(rows.map(row => Number.isFinite(row.result?.elapsed_ms) ? row.result.elapsed_ms / 1000 : null)),
  provider_latency_median_seconds: median(calls.map(item => Number.isFinite(item.latency_ms) ? item.latency_ms / 1000 : null)),
  timed_reference_disagreements: count(row => row.reference && row.timed && row.reference !== row.timed),
  disagreements_by_arm: {
    baseline: count(row => row.arm === "baseline" && row.reference && row.timed && row.reference !== row.timed),
    assisted: count(row => row.arm === "assisted" && row.reference && row.timed && row.reference !== row.timed),
  },
  known_agent_cost_usd: knownCost, calls_with_unknown_cost: unknownCost,
  cost_per_reference_confirmed_rejection_usd: proposed.filter(row => row.reference === "rejected").length && !unknownCost ? knownCost / proposed.filter(row => row.reference === "rejected").length : null,
  rows,
};
const format = value => value === null ? "not available" : String(value);
const widerRows = rows.filter(row => row.result?.trace?.some(item => item.type === "wider_view_created"));
const widerTable = widerRows.length ? "\n## Wider-view trajectories\n\n| Candidate | Initial reason | Final advice | Human reference |\n| --- | --- | --- | --- |\n" +
  widerRows.map(row => {
    const first = row.result.trace.find(item => item.type === "provider_call_completed" && item.action?.action === "request_wider_view");
    const cell = value => String(value ?? "unknown").replaceAll("|", "\\|").replaceAll("\n", " ");
    return `| ${cell(row.label)} | ${cell(first?.action?.explanation)} | ${cell(row.result.action)}: ${cell(row.result.explanation)} | ${cell(row.reference)} |`;
  }).join("\n") + "\n" : "\nNo wider views were requested.\n";
const report = `# Bounded review-agent pilot\n\nGenerated from ${sessions.length} completed session export(s). These reused locked crops are a small non-expert pilot, not new independent scientific ground truth.\n\n` +
  `- Candidates: ${rows.length}; timed human-only reviews: ${baseline.length}; timed assisted reviews: ${assisted.length}.\n` +
  `- Median active human review time: human-only ${format(metrics.median_active_seconds.baseline)} s; assisted ${format(metrics.median_active_seconds.assisted)} s. Descriptive difference: ${format(metrics.descriptive_median_difference_seconds)} s.\n` +
  `- Agent proposed rejection for ${proposed.length} candidates. Blinded/adjudicated outcomes: ${metrics.proposed_rejections_reference_accepted} accepted, ${metrics.proposed_rejections_reference_rejected} rejected, ${metrics.proposed_rejections_reference_unsure} unsure.\n` +
  `- ${metrics.wider_requests} wider views; ${metrics.agent_fallbacks} fallbacks; ${metrics.timed_reference_disagreements} timed-review disagreements with blinded/adjudicated labels (${metrics.disagreements_by_arm.baseline} human-only, ${metrics.disagreements_by_arm.assisted} assisted). Median agent latency: ${format(metrics.agent_latency_median_seconds)} s.\n` +
  `- Estimated incremental vision-provider cost at uncached list rates: $${knownCost.toFixed(5)}; ${unknownCost} calls have unknown cost. Estimated cost per reference-confirmed rejection: ${format(metrics.cost_per_reference_confirmed_rejection_usd)} USD. Roboflow detector expense is separate.\n\n` +
  `The arms contain different candidates; timing is descriptive. The agent never removed candidates from human review. Missed-fan counts describe hypothetical automation of proposed rejections, not detector recall or a safety guarantee.\n` + widerTable;
const output = resolve(import.meta.dirname, "../evaluation/agent-review");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
await writeFile(resolve(output, "report.md"), report);
console.log(report);
