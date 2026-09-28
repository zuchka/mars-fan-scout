export const MODEL_REPO = "akhilaaa3/Jev-Omni";
export const MODEL_REVISION = "5addda86ddee081a68fb067477ea100c221b8917";
export const MLX_SOURCE_REVISION = "c050d51354147985d13286cf4acf90f562f2c631";
export const MODEL = `${MODEL_REPO}@${MODEL_REVISION}`;
export const PROMPT_VERSION = "mars-fan-jev-choice-2-context";
export const OPTIONS = ["Fan", "Not a fan", "Unsure"];
export const QUESTION = "Does the marked region and its contiguous nearby plume show a Martian polar fan deposit?";
export const STATE = "This is a crop of a south-polar HiRISE image of Mars. The orange marker points to one Roboflow candidate. Its detection boundary may cover only the dark core: inspect the surrounding source pixels for a contiguous plume, while ignoring separate nearby shapes. A polar fan is a dark, asymmetric deposit that spreads from a narrower source. A dark spot, shadow, image seam, or indistinct shape need not be a fan. Choose Unsure when the visible pixels cannot distinguish the possibilities. Do not infer wind direction.";

const scoreKeys = new Set(OPTIONS);

export function validatePrediction(value) {
  if (!value || typeof value !== "object" || !value.probabilities || typeof value.probabilities !== "object") throw new Error("Invalid Jev response");
  const keys = Object.keys(value.probabilities);
  if (keys.length !== OPTIONS.length || !keys.every(key => scoreKeys.has(key))) throw new Error("Invalid Jev options");
  const probabilities = Object.fromEntries(OPTIONS.map(option => [option, Number(value.probabilities[option])]));
  const scores = Object.values(probabilities);
  if (!scores.every(score => Number.isFinite(score) && score >= 0 && score <= 1) || Math.abs(scores.reduce((a, b) => a + b, 0) - 1) > 0.01) throw new Error("Invalid Jev probabilities");
  if (!scoreKeys.has(value.prediction)) throw new Error("Invalid Jev prediction");
  const best = OPTIONS.reduce((a, b) => probabilities[b] > probabilities[a] ? b : a);
  if (value.prediction !== best) throw new Error("Jev prediction disagrees with probabilities");
  return { prediction: best, probabilities };
}

export function validateServiceUrl(value, token = "") {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback && (url.protocol !== "https:" || !token)) throw new Error("Remote Jev service requires HTTPS and a bearer token");
  if (loopback && !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid Jev service protocol");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Jev service URL must be an origin");
  return url.origin;
}

export function makeJevProvider({ url, token = "", imageTokens = null, expectedRevision = MODEL_REVISION,
  expectedBackend = "cuda-bf16",
  computeUsdPerHour = null, fetchImpl = fetch }) {
  const origin = validateServiceUrl(url, token);
  const hostedEndpoint = new URL(origin).hostname.endsWith(".endpoints.huggingface.cloud");
  const maxCallMs = hostedEndpoint ? 660000 : 60000;
  if (imageTokens !== null && ![20, 35, 70, 140, 280].includes(Number(imageTokens))) throw new Error("Invalid Jev image token budget");
  const hourly = computeUsdPerHour === null || computeUsdPerHour === "" ? null : Number(computeUsdPerHour);
  if (hourly !== null && (!Number.isFinite(hourly) || hourly < 0)) throw new Error("Invalid Jev compute rate");
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const metadata = { provider: "Jev-Omni", model: `${MODEL_REPO}@${expectedRevision}`, backend: expectedBackend,
    prompt_version: PROMPT_VERSION, options: OPTIONS, image_tokens: imageTokens === null ? null : Number(imageTokens),
    compute_usd_per_hour: hourly, cost_basis: hourly === null ? "Compute cost unmeasured; no OpenAI API charge" : "Request wall time times instance rate; not the provider bill" };
  const provider = async ({ evidence, timeout_ms = maxCallMs }) => {
    const started = performance.now();
    const limitMs = Math.max(1, Math.floor(Math.min(maxCallMs, timeout_ms)));
    const response = await fetchImpl(`${origin}/classify`, {
      method: "POST", headers: { ...headers, "content-type": "application/json",
        ...(hostedEndpoint ? { "x-scale-up-timeout": String(Math.min(600, Math.max(1, Math.floor(limitMs / 1000)))) } : {}) },
      body: JSON.stringify({ image_base64: evidence.overlay.toString("base64"), state: STATE,
        question: QUESTION, options: OPTIONS, image_tokens: imageTokens === null ? null : Number(imageTokens) }),
      signal: AbortSignal.timeout(limitMs),
    });
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch { /* The HTTP status still identifies the failure. */ }
      const error = new Error(`Jev service HTTP ${response.status}`);
      error.endpointUnavailable = [429, 502, 503, 504].includes(response.status) ||
        (response.status === 400 && body?.code === "BAD_REQUEST" && /endpoint is in error/i.test(body?.error || ""));
      throw error;
    }
    const body = await response.json();
    if (body.model_repo !== MODEL_REPO || body.model_revision !== expectedRevision || body.backend !== expectedBackend) throw new Error("Jev checkpoint mismatch");
    const prediction = validatePrediction(body);
    const elapsed_ms = Math.round(performance.now() - started);
    return { ...prediction, elapsed_ms, response_id: typeof body.request_id === "string" ? body.request_id : null,
      usage: body.metrics && typeof body.metrics === "object" ? body.metrics : null,
      cost_usd: hourly === null ? null : elapsed_ms * hourly / 3600000,
      cost_basis: metadata.cost_basis };
  };
  provider.metadata = metadata;
  const checkHealth = async (timeoutMs, scaleUpSeconds = null) => {
    const response = await fetchImpl(`${origin}/health`, { headers: { ...headers,
      ...(scaleUpSeconds === null ? {} : { "x-scale-up-timeout": String(scaleUpSeconds) }) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Jev health HTTP ${response.status}`);
    const body = await response.json();
    if (!body.ready || body.model_repo !== MODEL_REPO || body.model_revision !== expectedRevision || body.backend !== expectedBackend) throw new Error("Jev service is not ready with the pinned checkpoint");
    return body;
  };
  provider.probe = () => checkHealth(5000);
  let warmPromise = null;
  let lastWarmAt = 0;
  let lastWarmResult = null;
  provider.warm = () => {
    if (!hostedEndpoint) return provider.probe();
    if (warmPromise) return warmPromise;
    if (lastWarmResult && Date.now() - lastWarmAt < 120000) return Promise.resolve(lastWarmResult);
    warmPromise = checkHealth(90000, 80).then(result => {
      lastWarmAt = Date.now(); lastWarmResult = result; return result;
    }).finally(() => { warmPromise = null; });
    return warmPromise;
  };
  return provider;
}
