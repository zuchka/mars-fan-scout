import { OPTIONS, validatePrediction } from "./provider.mjs";

export const POLICY_VERSION = "jev-triage-1";

export function reviewDecision(raw, { wider = false, minProbability = 0.8, minMargin = 0.25 } = {}) {
  const { prediction, probabilities } = validatePrediction(raw);
  if (![minProbability, minMargin].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Invalid Jev review thresholds");
  const sorted = OPTIONS.map(option => probabilities[option]).sort((a, b) => b - a);
  const decisive = sorted[0] >= minProbability && sorted[0] - sorted[1] >= minMargin;
  const verdict = decisive && prediction !== "Unsure" ? prediction === "Fan" ? "fan" : "not_fan" : "unsure";
  const action = verdict === "unsure" && !wider ? "request_wider_view" : verdict === "not_fan" ? "propose_reject" : "send_to_human";
  const explanation = verdict === "unsure" ? (wider ? "Jev remained unsure after the wider crop; human review required." : "Jev was unsure or below the frozen decision threshold; inspect a wider crop.")
    : verdict === "not_fan" ? "Jev's Not a fan score met the frozen threshold; this is an advisory rejection only."
      : "Jev's Fan score met the frozen threshold; human review is still required.";
  return { action, verdict, prediction, probabilities, explanation, explanation_source: "application_rule",
    context_check: wider ? verdict === "unsure" ? "unresolved" : "resolved" : "not_requested" };
}
