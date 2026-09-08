import { describe, expect, it } from "vitest";
import {
  CORPUS_SCHEMA_VERSION,
  QRELS_SCHEMA_VERSION,
  QUERIES_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  assertRealEmbeddingConfig,
  corpusSha256,
  embeddingInputHashForChunk,
  inputHashesForCorpus,
  validateCorpus,
  validateEmbeddingSnapshot,
  validateQrels,
  validateQueries
} from "../evals/raw-hybrid-retrieval/src/contracts.js";

const baseCorpus = () => ({
  schemaVersion: CORPUS_SCHEMA_VERSION,
  knowledgeBaseId: "00000000-0000-4000-8000-000000000001",
  chunks: [{
    chunkId: "chunk-alpha",
    resourceId: "resource-alpha",
    resourceVersionId: "version-alpha",
    processingRunId: "run-alpha",
    resourceName: "Alpha source",
    title: "Alpha source",
    contextHeader: "Alpha section",
    content: "Alpha evidence.",
    parentChunkId: "parent-alpha",
    parentContent: "Alpha parent context.",
    locator: { page: 1 }
  }]
});

const baseQueries = () => ({
  schemaVersion: QUERIES_SCHEMA_VERSION,
  queries: [{ id: "query-alpha", query: "alpha", tags: ["smoke"] }]
});

const baseQrels = () => ({
  schemaVersion: QRELS_SCHEMA_VERSION,
  judgments: [{ queryId: "query-alpha", relevant: [{ chunkId: "chunk-alpha", grade: 2 }] }]
});

describe("raw hybrid evaluation data contracts", () => {
  it("normalizes and hashes the production raw child embedding input", () => {
    const corpus = validateCorpus(baseCorpus());
    const queries = validateQueries(baseQueries());
    const qrels = validateQrels(baseQrels(), { corpus, queries });
    const inputHashes = inputHashesForCorpus(corpus);
    expect(Object.keys(inputHashes)).toEqual(["chunk-alpha"]);
    expect(inputHashes["chunk-alpha"]).toBe(embeddingInputHashForChunk(corpus.chunks[0]));
    expect(qrels.judgments[0].relevant).toEqual([{ chunkId: "chunk-alpha", grade: 2 }]);

    const snapshot = validateEmbeddingSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      manifest: {
        provider: "openai-compatible",
        model: "eval-model",
        dimensions: 4096,
        corpusSha256: corpusSha256(corpus),
        inputHashes
      },
      vectors: [{ chunkId: "chunk-alpha", inputSha256: inputHashes["chunk-alpha"], vector: Array.from({ length: 4096 }, (_, index) => index === 0 ? 1 : 0) }]
    }, corpus);
    expect(snapshot.vectors[0].vector).toHaveLength(4096);
  });

  it("rejects duplicate IDs, incomplete qrels, bad grades, stale hashes, and zero vectors", () => {
    const duplicateCorpus = baseCorpus();
    duplicateCorpus.chunks.push({ ...duplicateCorpus.chunks[0], content: "different" });
    expect(() => validateCorpus(duplicateCorpus)).toThrow(/duplicate identifier/u);

    const corpus = validateCorpus(baseCorpus());
    const queries = validateQueries(baseQueries());
    expect(() => validateQrels({ ...baseQrels(), judgments: [{ ...baseQrels().judgments[0], relevant: [{ chunkId: "chunk-alpha", grade: 3 }] }] }, { corpus, queries })).toThrow(/grade 0, 1, or 2/u);
    expect(() => validateQrels({ ...baseQrels(), judgments: [{ queryId: "query-alpha", relevant: [{ chunkId: "chunk-alpha", grade: 0 }] }] }, { corpus, queries })).toThrow(/greater than zero/u);
    expect(() => validateQueries({ ...baseQueries(), queries: [{ id: "query-alpha", query: "   " }] })).toThrow(/must not be empty/u);

    const inputHashes = inputHashesForCorpus(corpus);
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      manifest: {
        provider: "openai-compatible",
        model: "eval-model",
        dimensions: 4096,
        corpusSha256: corpusSha256(corpus),
        inputHashes: { ...inputHashes, "chunk-alpha": "0".repeat(64) }
      },
      vectors: [{ chunkId: "chunk-alpha", inputSha256: "0".repeat(64), vector: [0, 0, 0, 0] }]
    };
    expect(() => validateEmbeddingSnapshot(snapshot, corpus)).toThrow(/stale/u);

    const zeroVectorSnapshot = {
      ...snapshot,
      manifest: { ...snapshot.manifest, inputHashes },
      vectors: [{ chunkId: "chunk-alpha", inputSha256: inputHashes["chunk-alpha"], vector: Array(4096).fill(0) }]
    };
    expect(() => validateEmbeddingSnapshot(zeroVectorSnapshot, corpus)).toThrow(/must not be empty/u);
  });

  it("requires an explicit real 4096-dimension provider and enforces local-only egress", () => {
    const local = {
      aiEgressMode: "local_only",
      embeddingProvider: "openai-compatible",
      embeddingModel: "eval-model",
      embeddingDimensions: 4096,
      retrievalVectorEnabled: true,
      embeddingApiBaseUrl: "http://127.0.0.1:43123/v1"
    };
    expect(assertRealEmbeddingConfig(local, {})).toMatchObject({ provider: "openai-compatible", model: "eval-model", dimensions: 4096, endpoint: "http://127.0.0.1:43123/v1/embeddings" });
    expect(() => assertRealEmbeddingConfig({ ...local, embeddingProvider: "mock", embeddingModel: "mock-hash-v1" }, {})).toThrow(/real EMBEDDING_PROVIDER/u);
    expect(() => assertRealEmbeddingConfig({ ...local, embeddingModel: "" }, {})).toThrow(/explicit non-mock EMBEDDING_MODEL/u);
    expect(() => assertRealEmbeddingConfig({ ...local, embeddingApiBaseUrl: "https://api.example.test/v1" }, {})).toThrow(/egress is blocked/u);
    expect(() => assertRealEmbeddingConfig({ ...local, embeddingDimensions: 32 }, {})).toThrow(/4096/u);
  });
});
