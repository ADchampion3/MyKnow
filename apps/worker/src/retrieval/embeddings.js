import { createEmbeddingProvider, embeddingInputSha256, embeddingInputText, persistEmbedding, validateEmbeddingVector } from "@myknow/db";

const payloadFor = (task) => {
  try { return JSON.parse(task.payload || "{}"); } catch { throw Object.assign(new Error("embedding task payload is invalid"), { code: "VALIDATION_ERROR" }); }
};

export const createEmbeddingTaskProcessor = ({ config, sqlite, audit, provider: suppliedProvider = null }) => {
  const provider = suppliedProvider || createEmbeddingProvider(config);

  return async (task) => {
    const payload = payloadFor(task);
    const { ownerType, ownerId, pageVersionId, resourceVersionId, processingRunId } = payload;
    let source;
    if (ownerType === "wiki_page") {
      source = sqlite.prepare("SELECT p.title,v.content_markdown FROM wiki_pages p JOIN wiki_page_versions v ON v.id=? WHERE p.id=? AND v.page_id=p.id").get(pageVersionId, ownerId);
    } else if (ownerType === "raw_chunk") {
      source = sqlite.prepare("SELECT c.content,c.context_header FROM chunks c JOIN resource_versions rv ON rv.id=c.resource_version_id WHERE c.id=? AND c.resource_version_id=? AND c.processing_run_id=? AND c.chunk_type='text' AND c.status='active'").get(ownerId, resourceVersionId, processingRunId);
    } else throw Object.assign(new Error("embedding owner type is invalid"), { code: "VALIDATION_ERROR" });
    if (!source) throw Object.assign(new Error("embedding source is no longer available"), { code: "NOT_FOUND" });
    const text = embeddingInputText({ ownerType, title: source.title, content: source.content_markdown || source.content, contextHeader: source.context_header });
    const inputSha256 = embeddingInputSha256(text);
    const cache = sqlite.prepare("SELECT * FROM retrieval_embeddings WHERE input_sha256=? AND provider=? AND model=? AND dimensions=? AND status='ready' ORDER BY updated_at DESC,id DESC LIMIT 1").get(inputSha256, provider.provider, provider.model, provider.dimensions);
    try {
      let result;
      let cacheHit = false;
      if (cache) {
        const vector = JSON.parse(cache.vector_json || "null");
        validateEmbeddingVector(vector, provider.dimensions);
        result = { provider: cache.provider, model: cache.model, dimensions: cache.dimensions, vector, durationMs: 0 };
        cacheHit = true;
      } else {
        result = await provider.embedText(text, { signal: task.signal });
        validateEmbeddingVector(result.vector, provider.dimensions);
      }
      persistEmbedding(sqlite, { ownerType, ownerId, pageVersionId: pageVersionId || null, resourceVersionId: resourceVersionId || null, processingRunId: processingRunId || null, provider: result.provider, model: result.model, inputSha256, vector: result.vector });
      audit("embedding_ready", "retrieval_embedding", `${ownerType}:${ownerId}`, { ownerType, ownerId, versionKey: pageVersionId || resourceVersionId, provider: result.provider, model: result.model, dimensions: result.dimensions, durationMs: result.durationMs, cacheHit, providerCallCount: cacheHit ? 0 : 1, inputSha256 });
    } catch (caught) {
      persistEmbedding(sqlite, { ownerType, ownerId, pageVersionId: pageVersionId || null, resourceVersionId: resourceVersionId || null, processingRunId: processingRunId || null, provider: provider.provider, model: provider.model, inputSha256, errorCode: caught.code || "EMBEDDING_FAILED", errorSummary: caught.message || "embedding provider failed" });
      audit("embedding_failed", "retrieval_embedding", `${ownerType}:${ownerId}`, { ownerType, ownerId, versionKey: pageVersionId || resourceVersionId, provider: provider.provider, model: provider.model, errorCode: caught.code || "EMBEDDING_FAILED", inputSha256 });
      throw caught;
    }
  };
};
