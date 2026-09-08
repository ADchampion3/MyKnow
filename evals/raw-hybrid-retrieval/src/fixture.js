import {
  createDatabase,
  migrate,
  rebuildRetrievalIndexes,
  sha256
} from "@myknow/db";
import { validateEmbeddingSnapshot } from "./contracts.js";

const timestamp = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? {});

const versionContent = (corpus, resourceVersionId) => corpus.chunks
  .filter((chunk) => chunk.resourceVersionId === resourceVersionId)
  .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
  .map((chunk) => [chunk.contextHeader, chunk.content].filter(Boolean).join("\n\n"))
  .join("\n\n");

const seedFixture = (sqlite, { corpus, snapshot }) => {
  const now = timestamp();
  sqlite.pragma("defer_foreign_keys = ON");
  sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO knowledge_bases (id,name,description,chunking_config,wiki_default_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(corpus.knowledgeBaseId, "Raw hybrid retrieval evaluation", "Isolated evaluation fixture", json({}), "retrieval_only", "active", now, now);

    const resources = new Map(corpus.chunks.map((chunk) => [chunk.resourceId, chunk]));
    const insertResource = sqlite.prepare("INSERT INTO resources (id,name,source_type,wiki_mode,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
    const insertVersion = sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,title,parser_name,parser_version,chunking_config,ocr_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertRun = sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,parser_name,parser_version,chunker_name,chunker_version,chunking_config,input_sha256,actual_provider,adapter_name,adapter_version,canonical_sha256,canonical_byte_size,block_count,parent_count,child_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertAssociation = sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)");
    for (const [resourceId, firstChunk] of resources) {
      const versionChunks = corpus.chunks.filter((chunk) => chunk.resourceVersionId === firstChunk.resourceVersionId);
      const content = versionContent(corpus, firstChunk.resourceVersionId);
      const contentBytes = Buffer.from(content || firstChunk.content, "utf8");
      insertResource.run(resourceId, firstChunk.resourceName, "text", null, "indexed", null, now, now);
      insertVersion.run(firstChunk.resourceVersionId, resourceId, sha256(contentBytes), `evaluation/${firstChunk.resourceVersionId}.txt`, "text/plain", contentBytes.length || 1, firstChunk.title, "evaluation-fixture", "1", json({}), "off", "indexed", now, now);
      const parentCount = new Set(versionChunks.filter((chunk) => chunk.parentChunkId).map((chunk) => chunk.parentChunkId)).size;
      insertRun.run(firstChunk.processingRunId, firstChunk.resourceVersionId, "indexed", "evaluation-fixture", "1", "evaluation-fixture", "1", json({}), sha256(contentBytes), "local", "evaluation-fixture", "1", sha256(contentBytes), contentBytes.length || 1, 0, parentCount, versionChunks.length, now, now);
      insertAssociation.run(resourceId, corpus.knowledgeBaseId, now);
      sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(firstChunk.processingRunId, firstChunk.resourceVersionId);
      sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(firstChunk.resourceVersionId, resourceId);
    }

    const parents = new Map();
    for (const chunk of corpus.chunks) if (chunk.parentChunkId) parents.set(chunk.parentChunkId, chunk);
    const insertChunk = sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,forced_split,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)");
    for (const [parentId, child] of parents) {
      insertChunk.run(parentId, child.resourceVersionId, child.processingRunId, null, "parent_text", 0, child.parentContent, null, 0, child.parentContent.length, json({ parentChunkId: parentId, resourceVersionId: child.resourceVersionId }), "evaluation-fixture", 0, now);
    }
    const sequenceByRun = new Map();
    for (const chunk of corpus.chunks) {
      const sequence = (sequenceByRun.get(chunk.processingRunId) || 0) + 1;
      sequenceByRun.set(chunk.processingRunId, sequence);
      insertChunk.run(chunk.chunkId, chunk.resourceVersionId, chunk.processingRunId, chunk.parentChunkId, "text", sequence, chunk.content, chunk.contextHeader, 0, chunk.content.length, json(chunk.locator), "evaluation-fixture", 0, now);
    }

    const insertEmbedding = sqlite.prepare("INSERT INTO retrieval_embeddings (id,owner_type,owner_id,version_key,page_version_id,resource_version_id,processing_run_id,provider,model,dimensions,input_sha256,vector_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const vectors = new Map(snapshot.vectors.map((vector) => [vector.chunkId, vector]));
    for (const chunk of corpus.chunks) {
      const vector = vectors.get(chunk.chunkId);
      insertEmbedding.run(`evaluation:${chunk.chunkId}`, "raw_chunk", chunk.chunkId, chunk.resourceVersionId, null, chunk.resourceVersionId, chunk.processingRunId, snapshot.manifest.provider, snapshot.manifest.model, snapshot.manifest.dimensions, vector.inputSha256, JSON.stringify(vector.vector), "ready", now, now);
    }
  })();
  rebuildRetrievalIndexes(sqlite);
};

export const createRawHybridEvalFixture = ({ data, config = {}, databaseUrl = ":memory:" } = {}) => {
  if (!data?.corpus || !data?.snapshot) throw Object.assign(new Error("an evaluation corpus and prepared embedding snapshot are required to build the fixture"), { code: "EVAL_SNAPSHOT_MISSING" });
  const snapshot = validateEmbeddingSnapshot(data.snapshot, data.corpus, {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    endpoint: config.embeddingApiBaseUrl
  });
  const database = createDatabase(databaseUrl);
  try {
    migrate(database.sqlite);
    seedFixture(database.sqlite, { corpus: data.corpus, snapshot });
    return {
      ...database,
      knowledgeBaseId: data.corpus.knowledgeBaseId,
      snapshot,
      close: () => database.sqlite.close()
    };
  } catch (caught) {
    database.sqlite.close();
    throw caught;
  }
};

export const fixtureCounts = (sqlite) => Object.fromEntries([
  ["knowledgeBases", "knowledge_bases"],
  ["resources", "resources"],
  ["resourceVersions", "resource_versions"],
  ["processingRuns", "processing_runs"],
  ["chunks", "chunks"],
  ["rawFts", "resource_fts"],
  ["embeddings", "retrieval_embeddings"]
].map(([key, table]) => [key, sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
