import crypto from "node:crypto";
import { tokenizeParts } from "./text-tokenizer.js";

export const DEFAULT_EMBEDDING_DIMENSIONS = 32;

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

export const createEmbeddingProvider = (config = {}) => {
  const enabled = config.retrievalVectorEnabled !== false;
  const providerName = String(config.embeddingProvider || "mock").trim().toLowerCase() || "mock";
  const model = String(config.embeddingModel || "mock-hash-v1").trim() || "mock-hash-v1";
  const dimensions = dimensionsFor(config.embeddingDimensions);
  const info = { provider: providerName, model, dimensions };

  const unavailable = (message = "embedding provider is unavailable", code = "EMBEDDING_PROVIDER_UNAVAILABLE") => {
    throw fail(message, code);
  };

  return {
    ...info,
    enabled,
    async embedText(text, { signal } = {}) {
      if (signal?.aborted) unavailable("embedding request was cancelled", "TASK_CANCELLED");
      if (!enabled || providerName === "none" || providerName === "disabled") unavailable("embedding retrieval is disabled", "EMBEDDING_DISABLED");
      if (providerName === "timeout" || config.embeddingFailureMode === "timeout") unavailable("embedding provider timed out", "EMBEDDING_TIMEOUT");
      if (providerName === "failed" || providerName === "mock-failure" || config.embeddingFailureMode === "failed") unavailable("embedding provider failed", "EMBEDDING_FAILED");
      if (providerName !== "mock" && providerName !== "mock-hash") unavailable(`embedding provider '${providerName}' is not configured`, "EMBEDDING_PROVIDER_UNAVAILABLE");
      const started = Date.now();
      const vector = mockVector(text, dimensions);
      return { ...info, vector, durationMs: Date.now() - started };
    }
  };
};
