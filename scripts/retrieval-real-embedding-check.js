import assert from "node:assert/strict";
import { loadConfig } from "@myknow/config";
import { createEmbeddingProvider, executeRetrieval, queueEmbeddingTask } from "@myknow/db";
import { createEmbeddingTaskProcessor } from "../apps/worker/src/retrieval/embeddings.js";
import { createRetrievalFixture } from "./retrieval-fixture.js";

const providerName = process.env.REAL_EMBEDDING_PROVIDER || "openai-compatible";
const model = process.env.REAL_EMBEDDING_MODEL || "qwen3-embedding-8b";
const dimensions = Number(process.env.REAL_EMBEDDING_DIMENSIONS || 1024);
const endpoint = process.env.REAL_EMBEDDING_API_URL || process.env.EMBEDDING_API_BASE_URL || "http://localhost:9000/v1/embeddings";
const config = { ...loadConfig({ ...process.env, EMBEDDING_PROVIDER: providerName, EMBEDDING_MODEL: model, EMBEDDING_DIMENSIONS: String(dimensions), EMBEDDING_API_BASE_URL: endpoint }), retrievalVectorEnabled: true };
const query = "RAG 中向量检索是怎么工作的？";

assert.equal(config.embeddingProvider, providerName);
assert.equal(config.embeddingModel, model);
assert.equal(config.embeddingDimensions, dimensions);

const fixture = createRetrievalFixture();
try {
  const provider = createEmbeddingProvider(config);
  const direct = await provider.embedText(query);
  assert.equal(direct.provider, providerName);
  assert.equal(direct.model, model);
  assert.equal(direct.requestedDimensions, dimensions);
  assert.equal(direct.dimensions, direct.vector.length);
  assert.ok(direct.vector.length >= 4 && direct.vector.length <= 4096);
  assert.ok(direct.vector.some((value) => value !== 0));

  const wikiVersionId = fixture.ids.pageVersion.get(fixture.ids.seed);
  const processEmbedding = createEmbeddingTaskProcessor({ config, sqlite: fixture.sqlite, audit: () => {} });
  const wikiTask = queueEmbeddingTask(fixture.sqlite, { ownerType: "wiki_page", ownerId: fixture.ids.seed, pageVersionId: wikiVersionId, reason: "real-embedding-check" });
  const rawTask = queueEmbeddingTask(fixture.sqlite, { ownerType: "raw_chunk", ownerId: fixture.ids.rawChunk, resourceVersionId: fixture.ids.resourceVersion, processingRunId: fixture.ids.processingRun, reason: "real-embedding-check" });
  await processEmbedding(wikiTask);
  await processEmbedding(rawTask);
  const wikiEmbedding = fixture.sqlite.prepare("SELECT dimensions,vector_json FROM retrieval_embeddings WHERE owner_type='wiki_page' AND owner_id=?").get(fixture.ids.seed);
  const rawEmbedding = fixture.sqlite.prepare("SELECT dimensions,vector_json FROM retrieval_embeddings WHERE owner_type='raw_chunk' AND owner_id=?").get(fixture.ids.rawChunk);
  assert.equal(wikiEmbedding.dimensions, direct.dimensions);
  assert.equal(rawEmbedding.dimensions, direct.dimensions);
  assert.equal(JSON.parse(wikiEmbedding.vector_json).length, direct.dimensions);
  assert.equal(JSON.parse(rawEmbedding.vector_json).length, direct.dimensions);

  const trace = await executeRetrieval({ sqlite: fixture.sqlite, config, input: { knowledgeBaseId: fixture.ids.kb, query, contextBudgetTokens: 8000 } });
  assert.equal(trace.status, "succeeded");
  assert.equal(trace.vector.status, "used");
  assert.equal(trace.vector.keywordFallback, false);
  assert.equal(trace.vector.provider, providerName);
  assert.equal(trace.vector.model, model);
  assert.equal(trace.vector.requestedDimensions, dimensions);
  assert.equal(trace.vector.dimensions, direct.dimensions);
  assert.ok(trace.wiki.seeds.some((result) => Number.isFinite(result.vectorScore)));
  assert.ok(trace.raw.results.some((result) => Number.isFinite(result.vectorScore)));

  console.log(JSON.stringify({
    status: "passed",
    provider: providerName,
    model,
    dimensions,
    directRequest: { query, requestedDimensions: direct.requestedDimensions, vectorLength: direct.vector.length, nonZero: direct.vector.some((value) => value !== 0) },
    retrieval: { vectorStatus: trace.vector.status, requestedDimensions: trace.vector.requestedDimensions, vectorDimensions: trace.vector.dimensions, wikiCount: trace.wiki.seeds.length, rawCount: trace.raw.results.length, vectorDurationMs: trace.vector.durationMs }
  }));
} finally {
  fixture.close();
}
