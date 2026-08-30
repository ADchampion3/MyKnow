import crypto from "node:crypto";
import { normalizeTokenCounter, tokenizeParts } from "./text-tokenizer.js";

export const DEFAULT_EMBEDDING_DIMENSIONS = 32;

export const embeddingInputSha256 = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");

export const embeddingInputText = ({ ownerType, title = "", content = "", contextHeader = "" }) => ownerType === "wiki_page" ? `${title}\n${content}` : [contextHeader, content].filter(Boolean).join("\n\n");

export const validateEmbeddingVector = (vector, expectedDimensions = null) => {
  if (!Array.isArray(vector) || vector.length < 4 || vector.length > 4096 || (expectedDimensions !== null && vector.length !== expectedDimensions) || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw fail(expectedDimensions !== null ? `embedding vector must contain ${expectedDimensions} finite values` : "embedding vector must contain finite values", expectedDimensions !== null ? "EMBEDDING_DIMENSION_MISMATCH" : "EMBEDDING_RESPONSE_INVALID");
  }
  if (!vector.some((value) => value !== 0)) throw fail("embedding vector must not be empty", "EMBEDDING_RESPONSE_INVALID");
  return vector;
};

const fail = (message, code) => Object.assign(new Error(message), { code });
const dimensionsFor = (value) => {
  const dimensions = Number(value ?? DEFAULT_EMBEDDING_DIMENSIONS);
  if (!Number.isInteger(dimensions) || dimensions < 4 || dimensions > 4096) throw fail("embedding dimensions must be an integer between 4 and 4096", "EMBEDDING_CONFIG_INVALID");
  return dimensions;
};

const normalize = (vector) => {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) return vector.map(() => 0);
  return vector.map((value) => value / length);
};

const mockVector = (value, dimensions) => {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const part of tokenizeParts(value)) {
    const digest = crypto.createHash("sha256").update(part).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] & 1 ? -1 : 1;
    vector[index] += sign;
    vector[digest.readUInt32BE(5) % dimensions] += sign * 0.5;
  }
  return normalize(vector);
};

const HTTP_PROVIDER_NAMES = new Set(["openai", "openai-compatible"]);
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const isLocalEndpoint = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && localHosts.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
};
const embeddingEndpoint = (baseUrl) => {
  let url;
  try { url = new URL(String(baseUrl || "").trim()); }
  catch { throw fail("embedding API base URL is invalid", "EMBEDDING_PROVIDER_UNAVAILABLE"); }
  if (!["http:", "https:"].includes(url.protocol)) throw fail("embedding API base URL must use HTTP or HTTPS", "EMBEDDING_PROVIDER_UNAVAILABLE");
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (!pathname.endsWith("/embeddings")) url.pathname = `${pathname}/embeddings`;
  return url;
};

const responseVector = (payload) => {
  const vector = payload?.data?.[0]?.embedding;
  return validateEmbeddingVector(vector);
};

export const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftLength += a * a;
    rightLength += b * b;
  }
  if (!leftLength || !rightLength) return 0;
  return dot / Math.sqrt(leftLength * rightLength);
};

export const createEmbeddingProvider = (config = {}, { tokenizer = config.embeddingTokenizer } = {}) => {
  const enabled = config.retrievalVectorEnabled !== false;
  const providerName = String(config.embeddingProvider || "mock").trim().toLowerCase() || "mock";
  const model = String(config.embeddingModel || "mock-hash-v1").trim() || "mock-hash-v1";
  const dimensions = dimensionsFor(config.embeddingDimensions);
  const tokenCounter = normalizeTokenCounter(tokenizer);
  const info = { provider: providerName, model, dimensions };

  const unavailable = (message = "embedding provider is unavailable", code = "EMBEDDING_PROVIDER_UNAVAILABLE") => {
    throw fail(message, code);
  };

  return {
    ...info,
    enabled,
    tokenizer: tokenCounter,
    tokenizerAvailable: Boolean(tokenCounter),
    tokenization: tokenCounter ? "provider" : "heuristic",
    countTokens: (text) => tokenCounter ? tokenCounter.countTokens(text) : null,
    async embedText(text, { signal } = {}) {
      if (signal?.aborted) unavailable("embedding request was cancelled", "TASK_CANCELLED");
      if (!enabled || providerName === "none" || providerName === "disabled") unavailable("embedding retrieval is disabled", "EMBEDDING_DISABLED");
      if (providerName === "timeout" || config.embeddingFailureMode === "timeout") unavailable("embedding provider timed out", "EMBEDDING_TIMEOUT");
      if (providerName === "failed" || providerName === "mock-failure" || config.embeddingFailureMode === "failed") unavailable("embedding provider failed", "EMBEDDING_FAILED");
      const started = Date.now();
      if (providerName === "mock" || providerName === "mock-hash") {
        const vector = mockVector(text, dimensions);
        return { ...info, vector, durationMs: Date.now() - started };
      }
      if (!HTTP_PROVIDER_NAMES.has(providerName)) unavailable(`embedding provider '${providerName}' is not configured`, "EMBEDDING_PROVIDER_UNAVAILABLE");
      if (typeof text !== "string" || !text.trim()) throw fail("embedding text must be a non-empty string", "VALIDATION_ERROR");
      if (config.aiEgressMode === "local_only" && !isLocalEndpoint(config.embeddingApiBaseUrl)) unavailable("embedding egress is blocked in local_only mode", "EMBEDDING_EGRESS_BLOCKED");
      const endpoint = embeddingEndpoint(config.embeddingApiBaseUrl);
      const headers = { "content-type": "application/json" };
      const apiKey = String(config.embeddingApiKey || "").trim();
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      let response;
      try {
        response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model, input: text, dimensions }), signal });
      } catch (caught) {
        if (caught?.name === "AbortError") throw fail(signal?.aborted ? "embedding request was cancelled" : "embedding provider timed out", signal?.aborted ? "TASK_CANCELLED" : "EMBEDDING_TIMEOUT");
        throw fail("embedding provider request failed", "EMBEDDING_FAILED");
      }
      if (!response.ok) throw fail(`embedding provider returned HTTP ${response.status}`, response.status >= 500 ? "EMBEDDING_FAILED" : "EMBEDDING_PROVIDER_UNAVAILABLE");
      let payload;
      try { payload = await response.json(); }
      catch { throw fail("embedding provider returned invalid JSON", "EMBEDDING_RESPONSE_INVALID"); }
      const vector = responseVector(payload);
      validateEmbeddingVector(vector, dimensions);
      return { ...info, dimensions: vector.length, requestedDimensions: dimensions, vector, durationMs: Date.now() - started };
    }
  };
};
