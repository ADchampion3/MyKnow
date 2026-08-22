import crypto from "node:crypto";
import { chunkDocument, normalizeChunkingConfig, now, persistBytes, sha256 } from "@myknow/db";

export const createResourceProcessor = ({ config, sqlite, materialReader, audit }) => {
  const createProcessingRun = (version, chunkingConfig) => {
    const runId = crypto.randomUUID();
    const timestamp = now();
    sqlite.transaction(() => {
      sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,chunker_name,chunker_version,chunking_config,input_sha256,created_at,updated_at) VALUES (?,?, 'processing', 'weknora-adaptive', '1', ?, ?, ?, ?)").run(runId, version.id, JSON.stringify(chunkingConfig), version.content_sha256, timestamp, timestamp);
      sqlite.prepare("UPDATE resource_versions SET status='processing',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, version.id);
      sqlite.prepare("UPDATE resources SET status='processing',updated_at=? WHERE id=? AND current_version_id=?").run(timestamp, version.resource_id, version.id);
    })();
    return runId;
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

  const persistProcessedDocument = (version, runId, parsed, document, artifact, started) => sqlite.transaction(() => {
    const previousRun = version.active_processing_run_id;
    if (previousRun) {
      sqlite.prepare("DELETE FROM resource_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE processing_run_id=? AND chunk_type='text')").run(previousRun);
      sqlite.prepare("UPDATE chunks SET status='superseded' WHERE processing_run_id=?").run(previousRun);
      sqlite.prepare("UPDATE processing_runs SET status='superseded',updated_at=? WHERE id=? AND status='indexed'").run(now(), previousRun);
    }
    const parentIds = new Map();
    const insertChunk = sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,forced_split,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,'active',?)");
    const insertFts = sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)");
    for (const chunk of document.output) {
      const id = crypto.randomUUID();
      if (chunk.chunkType === "parent_text") parentIds.set(chunk.parentIndex, id);
      const parentId = chunk.chunkType === "text" && chunk.parentIndex !== null ? parentIds.get(chunk.parentIndex) || null : null;
      const locator = JSON.stringify({
        startOffset: chunk.start,
        endOffset: chunk.end,
        sourceUrl: version.source_url || null,
        parentIndex: chunk.parentIndex,
        childIndex: chunk.childIndex ?? null,
        blockTypes: chunk.blockTypes || [],
        forcedSplit: Boolean(chunk.forcedSplit)
      });
      insertChunk.run(id, version.id, runId, parentId, chunk.chunkType, chunk.sequence, chunk.content, chunk.contextHeader || null, chunk.start, chunk.end, locator, document.strategy, chunk.forcedSplit ? 1 : 0, now());
      if (chunk.chunkType === "text") insertFts.run(id, [chunk.contextHeader, chunk.content].filter(Boolean).join("\n\n"), parsed.title || version.title || "");
    }
    const outputSha256 = outputDigest(document);
    const timestamp = now();
    sqlite.prepare("UPDATE processing_runs SET status='indexed',parser_name=?,parser_version=?,canonical_storage_key=?,canonical_sha256=?,canonical_byte_size=?,block_count=?,parent_count=?,child_count=?,output_sha256=?,warning_count=?,error_summary=NULL,updated_at=? WHERE id=?").run(parsed.parserName, parsed.parserVersion, artifact.storageKey, artifact.sha256, artifact.bytes.length, document.blocks.length, document.parents.length, document.children.length, outputSha256, 0, timestamp, runId);
    sqlite.prepare("UPDATE resource_versions SET content_sha256=COALESCE(?,content_sha256),storage_key=COALESCE(?,storage_key),mime_type=COALESCE(?,mime_type),byte_size=COALESCE(?,byte_size),title=COALESCE(?,title),fetched_at=COALESCE(?,fetched_at),parser_name=?,parser_version=?,parse_duration_ms=?,active_processing_run_id=?,status='indexed',error_summary=NULL,updated_at=? WHERE id=?").run(parsed.contentSha256 || null, parsed.storageKey || null, parsed.mimeType || null, parsed.byteSize || null, parsed.title, parsed.fetchedAt || null, parsed.parserName, parsed.parserVersion, Date.now() - started, runId, timestamp, version.id);
    sqlite.prepare("UPDATE resources SET status='indexed',updated_at=? WHERE id=? AND current_version_id=?").run(timestamp, version.resource_id, version.id);
  })();

  const processResource = async (task) => {
    const payload = JSON.parse(task.payload || "{}");
    const version = sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(payload.resourceVersionId);
    if (!version) throw Object.assign(new Error("resource version not found"), { code: "NOT_FOUND" });
    const started = Date.now();
    let runId = null;
    try {
      let chunkingConfig = {};
      try { chunkingConfig = normalizeChunkingConfig(version.chunking_config ? JSON.parse(version.chunking_config) : {}); }
      catch (caught) { throw Object.assign(new Error(`invalid chunking config: ${caught.message}`), { code: "VALIDATION_ERROR" }); }
      runId = createProcessingRun(version, chunkingConfig);
      const parsed = await materialReader.read(version, attemptHooks(runId));
      const document = chunkDocument(parsed.canonicalText, chunkingConfig);
      if (!document.children.length) throw Object.assign(new Error("parsed content produced no child chunks"), { code: "PARSE_FAILED" });
      const artifact = writeCanonicalArtifact(version, runId, parsed, document);
      persistProcessedDocument(version, runId, parsed, document, artifact, started);
      audit("indexed", "processing_run", runId, { resourceVersionId: version.id, parents: document.parents.length, children: document.children.length, strategy: document.strategy });
    } catch (caught) {
      if (runId) {
        sqlite.prepare("UPDATE processing_runs SET status='failed',error_summary=?,updated_at=? WHERE id=? AND status='processing'").run(caught?.message || "processing failed", now(), runId);
        audit("failed", "processing_run", runId, { resourceVersionId: version.id, error: caught?.message || "processing failed" });
      }
      throw caught;
    }
  };

  return { processResource };
};
