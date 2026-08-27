import assert from "node:assert/strict";
import { createEmbeddingProvider, cosineSimilarity, ensurePendingEmbeddingTasks, executeRetrieval, persistEmbedding, queueEmbeddingTask } from "@myknow/db";
import { createEmbeddingTaskProcessor } from "../apps/worker/src/retrieval/embeddings.js";
import { createRetrievalFixture } from "./retrieval-fixture.js";

const fixture = createRetrievalFixture();
try {
  const config = { ...fixture.config, retrievalVectorEnabled: true };
  const provider = createEmbeddingProvider(config);
  const wikiVersionId = fixture.ids.pageVersion.get(fixture.ids.seed);
  const wikiText = fixture.sqlite.prepare("SELECT title,content_markdown FROM wiki_pages p JOIN wiki_page_versions v ON v.id=p.current_version_id WHERE p.id=?").get(fixture.ids.seed);
  const wikiEmbedding = await provider.embedText(`${wikiText.title}\n${wikiText.content_markdown}`);
  const rawText = fixture.sqlite.prepare("SELECT context_header,content FROM chunks WHERE id=?").get(fixture.ids.rawChunk);
  const rawEmbedding = await provider.embedText(`${rawText.context_header}\n\n${rawText.content}`);
  persistEmbedding(fixture.sqlite, { ownerType: "wiki_page", ownerId: fixture.ids.seed, pageVersionId: wikiVersionId, provider: wikiEmbedding.provider, model: wikiEmbedding.model, vector: wikiEmbedding.vector });
  persistEmbedding(fixture.sqlite, { ownerType: "raw_chunk", ownerId: fixture.ids.rawChunk, resourceVersionId: fixture.ids.resourceVersion, processingRunId: fixture.ids.processingRun, provider: rawEmbedding.provider, model: rawEmbedding.model, vector: rawEmbedding.vector });
  assert.equal(cosineSimilarity(wikiEmbedding.vector, wikiEmbedding.vector), 1);
  const used = await executeRetrieval({ sqlite: fixture.sqlite, config, input: { knowledgeBaseId: fixture.ids.kb, query: "release deployment runbook", contextBudgetTokens: 8000 } });
  assert.equal(used.vector.status, "used");
  assert.equal(used.vector.keywordFallback, false);
  assert.ok(Number.isFinite(used.wiki.seeds[0].vectorScore) && used.wiki.seeds[0].vectorScore > 0);
  assert.ok(Number.isFinite(used.raw.results[0].vectorScore) && used.raw.results[0].vectorScore > 0);
  assert.equal(used.wiki.seeds[0].vectorRank, 1);
  assert.equal(used.raw.results[0].vectorRank, 1);
  assert.equal(used.vector.error, null);

  const timeout = await executeRetrieval({ sqlite: fixture.sqlite, config: { ...config, embeddingProvider: "timeout" }, input: { knowledgeBaseId: fixture.ids.kb, query: "release deployment runbook", contextBudgetTokens: 8000 } });
  assert.equal(timeout.status, "succeeded");
  assert.equal(timeout.vector.status, "degraded");
  assert.equal(timeout.vector.error.code, "EMBEDDING_TIMEOUT");
  assert.ok(timeout.wiki.seeds.length > 0);
  assert.ok(timeout.raw.results.length > 0);

  const disabled = await executeRetrieval({ sqlite: fixture.sqlite, config: { ...config, retrievalVectorEnabled: false }, input: { knowledgeBaseId: fixture.ids.kb, query: "release deployment runbook", contextBudgetTokens: 8000 } });
  assert.equal(disabled.vector.status, "disabled");
  assert.ok(disabled.wiki.seeds.length > 0);

  const workerFixture = createRetrievalFixture();
  try {
    const audits = [];
    const task = queueEmbeddingTask(workerFixture.sqlite, { ownerType: "wiki_page", ownerId: workerFixture.ids.seed, pageVersionId: workerFixture.ids.pageVersion.get(workerFixture.ids.seed), reason: "vector-check" });
    const processEmbedding = createEmbeddingTaskProcessor({ config: { ...workerFixture.config, retrievalVectorEnabled: true }, sqlite: workerFixture.sqlite, audit: (...args) => audits.push(args) });
    await processEmbedding(task);
    const ready = workerFixture.sqlite.prepare("SELECT * FROM retrieval_embeddings WHERE owner_type='wiki_page' AND owner_id=?").get(workerFixture.ids.seed);
    assert.equal(ready.status, "ready");
    assert.equal(JSON.parse(ready.vector_json).length, 32);
    assert.ok(audits.some(([eventType]) => eventType === "embedding_ready"));
    workerFixture.sqlite.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(task.id);
    const wikiSeedEmbeddingTaskCount = () => workerFixture.sqlite.prepare("SELECT payload FROM tasks WHERE type='retrieval:embed'").all().filter((row) => { const payload = JSON.parse(row.payload); return payload.ownerType === "wiki_page" && payload.ownerId === workerFixture.ids.seed; }).length;
    const beforeStartupRepair = wikiSeedEmbeddingTaskCount();
    ensurePendingEmbeddingTasks(workerFixture.sqlite, "startup-check");
    assert.equal(wikiSeedEmbeddingTaskCount(), beforeStartupRepair);
  } finally {
    workerFixture.close();
  }

  const failedFixture = createRetrievalFixture();
  try {
    const failedTask = queueEmbeddingTask(failedFixture.sqlite, { ownerType: "wiki_page", ownerId: failedFixture.ids.seed, pageVersionId: failedFixture.ids.pageVersion.get(failedFixture.ids.seed), reason: "failure-check" });
    const processEmbedding = createEmbeddingTaskProcessor({ config: { ...failedFixture.config, retrievalVectorEnabled: true, embeddingProvider: "failed" }, sqlite: failedFixture.sqlite, audit: () => {} });
    await assert.rejects(() => processEmbedding(failedTask), (caught) => caught.code === "EMBEDDING_FAILED");
    const failed = failedFixture.sqlite.prepare("SELECT status,error_summary FROM retrieval_embeddings WHERE owner_type='wiki_page' AND owner_id=?").get(failedFixture.ids.seed);
    assert.equal(failed.status, "failed");
    assert.match(failed.error_summary, /EMBEDDING_FAILED/);
  } finally {
    failedFixture.close();
  }

  await assert.rejects(() => createEmbeddingProvider({ embeddingProvider: "openai", embeddingApiKey: "secret" }).embedText("query"), (caught) => caught.code === "EMBEDDING_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(used), /secret/);
  console.log(JSON.stringify({ status: "passed", vector: { provider: used.vector.provider, model: used.vector.model, dimensions: used.vector.dimensions, status: used.vector.status }, degraded: { status: timeout.vector.status, error: timeout.vector.error.code, keywordWikiCount: timeout.wiki.seeds.length, keywordRawCount: timeout.raw.results.length }, disabled: disabled.vector.status, workerEmbedding: "ready", failedEmbedding: "recorded_without_losing_keyword_path" }));
} finally {
  fixture.close();
}
