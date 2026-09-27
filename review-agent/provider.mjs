export const MODEL = "gpt-4.1-mini-2025-04-14";
export const PROMPT_VERSION = "fan-triage-1";
export const RATE = { input_per_million_usd: 0.4, output_per_million_usd: 1.6, effective_date: "2026-09-27",
  basis: "Uncached standard token rates; costs are estimates from reported usage" };
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["propose_reject", "request_wider_view", "send_to_human"] },
    explanation: { type: "string" },
    context_check: { type: "string", enum: ["not_requested", "resolved", "unresolved"] },
  }, required: ["action", "explanation", "context_check"],
};

export function validateAction(value, wider = false) {
  if (!value || !["propose_reject", "request_wider_view", "send_to_human"].includes(value.action) || typeof value.explanation !== "string" || !value.explanation.trim() || value.explanation.length > 500 || !["not_requested", "resolved", "unresolved"].includes(value.context_check)) throw new Error("Invalid vision response");
  if (wider && (value.action === "request_wider_view" || value.context_check === "not_requested")) throw new Error("Invalid follow-up action");
  if (wider && value.action === "propose_reject" && value.context_check !== "resolved") throw new Error("Unresolved wider context cannot support rejection");
  if (!wider && value.context_check !== "not_requested") throw new Error("Invalid initial context check");
  return { action: value.action, explanation: value.explanation.trim(), context_check: value.context_check };
}

export function makeOpenAIProvider({ key, fetchImpl = fetch }) {
  if (!key) throw new Error("Vision provider key is missing");
  return async ({ candidate, evidence, wider, firstAction, timeout_ms = 30000 }) => {
    const prompt = wider
      ? `This is the wider view requested for candidate ${candidate.id}. Initial ambiguity: ${firstAction.explanation}. Inspect the new source pixels and aligned mask. Return propose_reject only if visual evidence now supports a clear non-fan explanation; otherwise send_to_human. State whether the wider view resolved the ambiguity. JSON only.`
      : `Candidate ${candidate.id} has Roboflow confidence ${(candidate.confidence * 100).toFixed(1)}%. Inspect the unmarked source crop and the same crop with its detector mask. Choose propose_reject, request_wider_view, or send_to_human. A low detector score alone does not justify rejection. If the shape could be a real fan or the pixels are unclear, request more context or defer. Do not infer direction, source end, wind, or scientific discovery. Give a concise visual explanation. JSON only.`;
    const input = [{ role: "user", content: [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: `data:image/jpeg;base64,${evidence.pixels.toString("base64")}`, detail: "high" },
      { type: "input_image", image_url: `data:image/jpeg;base64,${evidence.overlay.toString("base64")}`, detail: "high" },
    ] }];
    const started = performance.now();
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, store: false, temperature: 0, max_output_tokens: 180, input,
        text: { format: { type: "json_schema", name: "fan_review_action", strict: true, schema } } }),
      signal: AbortSignal.timeout(Math.min(30000, timeout_ms)),
    });
    const elapsed_ms = Math.round(performance.now() - started);
    if (!response.ok) throw new Error(`Vision provider HTTP ${response.status}`);
    const data = await response.json();
    const text = data.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text;
    if (data.status !== "completed" || !text) throw new Error("Vision provider returned no completed action");
    const action = validateAction(JSON.parse(text), wider);
    const usage = data.usage ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null;
    const cost_usd = usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? (usage.input_tokens * RATE.input_per_million_usd + usage.output_tokens * RATE.output_per_million_usd) / 1e6 : null;
    return { action, usage, cost_usd, response_id: data.id || null, elapsed_ms };
  };
}
