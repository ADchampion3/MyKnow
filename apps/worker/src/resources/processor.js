import crypto from "node:crypto";
import { chunkDocument, normalizeChunkingConfig, now, persistBytes, refreshResourceStatus, sha256 } from "@myknow/db";

const archivedError = () => Object.assign(new Error("resource is archived"), { code: "RESOURCE_ARCHIVED" });

export const createResourceProcessor = ({ config, sqlite, materialReader, audit }) => {
  const createProcessingRun = (version, chunkingConfig) => {
    const resource = sqlite.prepare("SELECT * FROM resources WHERE id=?").get(version.resource_id);
    if (!resource || resource.status === "archived") throw archivedError();
    const runId = crypto.randomUUID();
    const timestamp = now();
    sqlite.transaction(() => {
      sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,chunker_name,chunker_version,chunking_config,input_sha256,created_at,updated_at) VALUES (?,?, 'processing', 'weknora-adaptive', '1', ?, ?, ?, ?)").run(runId, version.id, JSON.stringify(chunkingConfig), version.content_sha256, timestamp, timestamp);
      sqlite.prepare("UPDATE resource_versions SET status='processing',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, version.id);
      refreshResourceStatus(sqlite, version.resource_id, timestamp);
    })();
    return { runId, previousRunId: version.active_processing_run_id || null };
  };

  const attemptHooks = (runId) => ({
    start: async (candidate) => {
      const id = crypto.randomUUID();
      sqlite.prepare("INSERT INTO processing_run_attempts (id,processing_run_id,reader_name,reader_version,status,started_at) VALUES (?,?,?,?,'running',?)").run(id, runId, candidate.name, candidate.version, now());
      return id;
    },
    success: async (attemptId, result) => sqlite.prepare("UPDATE processing_run_attempts SET status='succeeded',metadata=?,finished_at=? WHERE id=?").run(JSON.stringify(result.quality || {}), now(), attemptId),
    failure: async (attemptId, caught) => sqlite.prepare("UPDATE processing_run_attempts SET status='failed',error_code=?,error_summary=?,metadata=?,finished_at=? WHERE id=?").run(caught?.code || "PARSE_FAILED", caught?.message || "reader failed", JSON.stringify(caught?.metadata || {}), now(), attemptId)
  });

  const writeCanonicalArtifact = (version, runId, parsed, document) => {
    const artifact = {
      schemaVersion: 1,
      resourceVersionId: version.id,
      processingRunId: runId,
      canonicalText: document.canonicalText,
      blocks: document.blocks,
      assets: parsed.assets || [],
      metadata: { ...(parsed.metadata || {}), quality: parsed.quality || {}, strategy: document.strategy, strategyChain: document.strategyChain, validation: document.validation, profile: document.profile }
    };
    const bytes = Buffer.from(JSON.stringify(artifact));
    const storageKey = `canonical/${version.id}/${runId}.json`;
    persistBytes(config.resourceStorageDir, storageKey, bytes);
    return { storageKey, bytes, sha256: sha256(bytes) };
  };

  const outputDigest = (document) => sha256(JSON.stringify(document.output.map((chunk) => ({ sequence: chunk.sequence, type: chunk.chunkType, parentIndex: chunk.parentIndex, start: chunk.start, end: chunk.end, content: chunk.content, contextHeader: chunk.contextHeader || "", forcedSplit: Boolean(chunk.forcedSplit) }))));

  const persistProcessedDocument = (version, runId, previousRunId, parsed, document, artifact, started) => sqlite.transaction(() => {
    const fresh = sqlite.prepare("SELECT rv.*,r.status AS resource_status,r.current_version_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.id=?").get(version.id);
    if (!fresh || fresh.resource_status === "archived") throw archivedError();
    if (fresh.active_processing_run_id !== previousRunId) throw Object.assign(new Error("active processing run changed"), { code: "WORKER_INTERRUPTED" });
    const previousRun = previousRunId;
    const parentIds = new Map();
    const insertChunk = sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,forced_split,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,'active',?)");
    const insertFts = sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)");
    for (const chunk of document.output) {
      const id = crypto.randomUUID();
      if (chunk.chunkType === "parent_text") parentIds.set(chunk.parentIndex, id);
      const parentId = chunk.chunkType === "text" && chunk.parentIndex !== null ? parentIds.get(chunk.parentIndex) || null : null;
      const locator = JSON.stringify({ startOffset: chunk.start, endOffset: chunk.end, resourceVersionId: version.id, processingRunId: runId, parentIndex: chunk.parentIndex, childIndex: chunk.childIndex ?? null, blockTypes: chunk.blockTypes || [], forcedSplit: Boolean(chunk.forcedSplit) });
      insertChunk.run(id, version.id, runId, parentId, chunk.chunkType, chunk.sequence, chunk.content, chunk.contextHeader || null, chunk.start, chunk.end, locator, document.strategy, chunk.forcedSplit ? 1 : 0, now());
      if (chunk.chunkType === "text") insertFts.run(id, [chunk.contextHeader, chunk.content].filter(Boolean).join("\n\n"), parsed.title || fresh.title || "");
    }
    const outputSha256 = outputDigest(document);
    const timestamp = now();
    sqlite.prepare("UPDATE processing_runs SET status='indexed',parser_name=?,parser_version=?,canonical_storage_key=?,canonical_sha256=?,canonical_byte_size=?,block_count=?,parent_count=?,child_count=?,output_sha256=?,warning_count=?,error_code=NULL,error_summary=NULL,updated_at=? WHERE id=? AND status='processing'").run(parsed.parserName, parsed.parserVersion, artifact.storageKey, artifact.sha256, artifact.bytes.length, document.blocks.length, document.parents.length, document.children.length, outputSha256, 0, timestamp, runId);
    sqlite.prepare("UPDATE resource_versions SET title=COALESCE(?,title),parser_name=?,parser_version=?,parse_duration_ms=?,active_processing_run_id=?,status='indexed',error_summary=NULL,updated_at=? WHERE id=?").run(parsed.title, parsed.parserName, parsed.parserVersion, Date.now() - started, runId, timestamp, version.id);
    const latest = sqlite.prepare("SELECT id FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(version.resource_id);
    if (latest?.id === version.id) {
      sqlite.prepare("UPDATE resources SET current_version_id=?,status='indexed',updated_at=? WHERE id=? AND status <> 'archived'").run(version.id, timestamp, version.resource_id);
    } else {
      refreshResourceStatus(sqlite, version.resource_id, timestamp);
    }
    if (previousRun) {
      sqlite.prepare("DELETE FROM resource_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE processing_run_id=? AND chunk_type='text')").run(previousRun);
      sqlite.prepare("UPDATE chunks SET status='superseded' WHERE processing_run_id=? AND status='active'").run(previousRun);
      sqlite.prepare("UPDATE processing_runs SET status='superseded',updated_at=? WHERE id=? AND status='indexed'").run(timestamp, previousRun);
    }
  })();

  const processResource = async (task) => {
    const resourceVersionId = task.resource_version_id || JSON.parse(task.payload || "{}").resourceVersionId;
    const version = resourceVersionId && sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
    if (!version) throw Object.assign(new Error("resource version not found"), { code: "NOT_FOUND" });
    const resource = sqlite.prepare("SELECT status FROM resources WHERE id=?").get(version.resource_id);
    if (resource?.status === "archived") throw archivedError();
    const started = Date.now();
    let runId = null;
    let previousRunId = null;
    try {
      let chunkingConfig = {};
      try { chunkingConfig = normalizeChunkingConfig(version.chunking_config ? JSON.parse(version.chunking_config) : {}); }
      catch (caught) { throw Object.assign(new Error(`invalid chunking config: ${caught.message}`), { code: "VALIDATION_ERROR" }); }
      const processingRun = createProcessingRun(version, chunkingConfig);
      runId = processingRun.runId;
      previousRunId = processingRun.previousRunId;
      const parsed = await materialReader.read(version, attemptHooks(runId));
      const document = chunkDocument(parsed.canonicalText, chunkingConfig);
      if (!document.children.length) throw Object.assign(new Error("parsed content produced no child chunks"), { code: "PARSE_FAILED" });
      const artifact = writeCanonicalArtifact(version, runId, parsed, document);
      persistProcessedDocument(version, runId, previousRunId, parsed, document, artifact, started);
      audit("indexed", "processing_run", runId, { resourceVersionId: version.id, parents: document.parents.length, children: document.children.length, strategy: document.strategy });
    } catch (caught) {
      if (runId) {
        const timestamp = now();
        sqlite.transaction(() => {
          sqlite.prepare("UPDATE processing_runs SET status='failed',error_code=?,error_summary=?,updated_at=? WHERE id=? AND status='processing'").run(caught?.code || "PARSE_FAILED", caught?.message || "processing failed", timestamp, runId);
          const fresh = sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(version.id);
          if (fresh?.active_processing_run_id) sqlite.prepare("UPDATE resource_versions SET status='indexed',updated_at=? WHERE id=?").run(timestamp, version.id);
          refreshResourceStatus(sqlite, version.resource_id, timestamp);
        })();
        audit("failed", "processing_run", runId, { resourceVersionId: version.id, errorCode: caught?.code || "PARSE_FAILED", error: caught?.message || "processing failed" });
      }
      throw caught;
    }
  };

  return { processResource };
};
