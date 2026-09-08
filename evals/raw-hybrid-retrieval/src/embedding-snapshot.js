import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEmbeddingProvider, validateEmbeddingVector } from "@myknow/db";
import {
  SNAPSHOT_SCHEMA_VERSION,
  assertRealEmbeddingConfig,
  corpusSha256,
  embeddingInputForChunk,
  embeddingInputHashForChunk,
  evaluationDataPaths,
  inputHashesForCorpus,
  loadEvaluationData,
  validateEmbeddingSnapshot
} from "./contracts.js";

const atomicWriteJson = (target, value) => {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let movedExisting = false;
  const backup = `${target}.${process.pid}.${crypto.randomUUID()}.bak`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, target);
    if (movedExisting) fs.rmSync(backup, { force: true });
  } catch (caught) {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {}
    if (movedExisting && !fs.existsSync(target) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, target); } catch {}
    }
    throw caught;
  }
};

export const writeEmbeddingSnapshotAtomically = atomicWriteJson;

const positiveTimeout = (value, label) => {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) throw Object.assign(new Error(`${label} must be a positive integer`), { code: "EVAL_TIMEOUT_INVALID" });
  return timeout;
};

export const preflightRawHybridEmbedding = async ({ dataDir, config, env = process.env, sampleSize = 3, timeoutMs = Number(env.RAW_HYBRID_EMBEDDING_TIMEOUT_MS || 120_000) } = {}) => {
  const data = loadEvaluationData({ dataDir, requireSnapshot: false });
  const providerConfig = assertRealEmbeddingConfig(config, env);
  timeoutMs = positiveTimeout(timeoutMs, "embedding preflight timeoutMs");
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > data.corpus.chunks.length) {
    throw Object.assign(new Error(`embedding preflight sampleSize must be an integer between 1 and ${data.corpus.chunks.length}`), { code: "EVAL_PREFLIGHT_INVALID" });
  }
  const provider = createEmbeddingProvider({
    ...config,
    retrievalVectorEnabled: true,
    embeddingProvider: providerConfig.provider,
    embeddingModel: providerConfig.model,
    embeddingDimensions: providerConfig.dimensions
  });
  const samples = [];
  for (const chunk of [...data.corpus.chunks].sort((left, right) => left.chunkId.localeCompare(right.chunkId)).slice(0, sampleSize)) {
    const input = embeddingInputForChunk(chunk);
    let result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { result = await provider.embedText(input, { signal: controller.signal }); validateEmbeddingVector(result.vector, providerConfig.dimensions); }
    catch (caught) { throw Object.assign(new Error(`embedding preflight failed for raw child chunk '${chunk.chunkId}': ${caught.message}`), { code: controller.signal.aborted ? "EVAL_PREFLIGHT_TIMEOUT" : caught.code || "EVAL_PREFLIGHT_FAILED", cause: caught }); }
    finally { clearTimeout(timer); }
    if (result.provider !== providerConfig.provider || result.model !== providerConfig.model || result.dimensions !== providerConfig.dimensions) throw Object.assign(new Error(`embedding preflight returned incompatible metadata for raw child chunk '${chunk.chunkId}'`), { code: "EVAL_EMBEDDING_MANIFEST_MISMATCH" });
    samples.push({ chunkId: chunk.chunkId, inputCharacters: Array.from(input).length, dimensions: result.vector.length, durationMs: result.durationMs ?? null });
  }
  return { provider: providerConfig, sampleSize: samples.length, samples };
};

export const prepareRawHybridEmbeddingSnapshot = async ({ dataDir, config, env = process.env, timeoutMs = Number(env.RAW_HYBRID_EMBEDDING_TIMEOUT_MS || 120_000) } = {}) => {
  const data = loadEvaluationData({ dataDir, requireSnapshot: false });
  const outputPaths = evaluationDataPaths(dataDir);
  const providerConfig = assertRealEmbeddingConfig(config, env);
  timeoutMs = positiveTimeout(timeoutMs, "embedding preparation timeoutMs");
  const provider = createEmbeddingProvider({
    ...config,
    retrievalVectorEnabled: true,
    embeddingProvider: providerConfig.provider,
    embeddingModel: providerConfig.model,
    embeddingDimensions: providerConfig.dimensions
  });
  const inputHashes = inputHashesForCorpus(data.corpus);
  const vectors = [];
  // ponytail: keep the first 5,183-document preparation pass serial and
  // restart-from-scratch; add resumable batching when corpus size or provider
  // cost makes a full retry impractical.
  for (const chunk of [...data.corpus.chunks].sort((left, right) => left.chunkId.localeCompare(right.chunkId))) {
    const input = embeddingInputForChunk(chunk);
    const inputSha256 = embeddingInputHashForChunk(chunk);
    let result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      result = await provider.embedText(input, { signal: controller.signal });
      validateEmbeddingVector(result.vector, providerConfig.dimensions);
    } catch (caught) {
      throw Object.assign(new Error(`embedding preparation failed for raw child chunk '${chunk.chunkId}': ${caught.message}`), { code: controller.signal.aborted ? "EVAL_EMBEDDING_TIMEOUT" : caught.code || "EVAL_EMBEDDING_PREPARATION_FAILED", cause: caught });
    } finally { clearTimeout(timer); }
    if (result.provider !== providerConfig.provider || result.model !== providerConfig.model || result.dimensions !== providerConfig.dimensions) {
      throw Object.assign(new Error(`embedding provider returned metadata incompatible with the requested provider manifest for raw child chunk '${chunk.chunkId}'`), { code: "EVAL_EMBEDDING_MANIFEST_MISMATCH" });
    }
    vectors.push({ chunkId: chunk.chunkId, inputSha256, vector: [...result.vector] });
  }
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifest: {
      provider: providerConfig.provider,
      model: providerConfig.model,
      dimensions: providerConfig.dimensions,
      endpoint: providerConfig.endpoint,
      corpusSha256: corpusSha256(data.corpus),
      inputHashes,
      generatedAt: new Date().toISOString()
    },
    vectors
  };
  const validated = validateEmbeddingSnapshot(snapshot, data.corpus, providerConfig);
  atomicWriteJson(outputPaths.snapshot, validated);
  return { path: outputPaths.snapshot, snapshot: validated };
};
