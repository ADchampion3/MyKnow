import crypto from "node:crypto";
import { chunkDocument, createEmbeddingTaskCache, normalizeChunkingConfig, now, persistBytes, processingRequestFromVersion, queueEmbeddingTask, refreshResourceStatus, searchableText, sha256 } from "@myknow/db";

const archivedError = () => Object.assign(new Error("resource is archived"), { code: "RESOURCE_ARCHIVED" });

export const createResourceProcessor = ({ config, sqlite, materialReader, audit }) => {
  const queueImpactScan = (resourceVersionId) => {
    const active = sqlite.prepare("SELECT id FROM tasks WHERE type='wiki:impact-scan' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(resourceVersionId);
    if (active) return active.id;
    const taskId = crypto.randomUUID();
    const timestamp = now();
    sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,?,'queued',0,3,0,?,?)").run(taskId, "wiki:impact-scan", resourceVersionId, JSON.stringify({ resourceVersionId, reason: "resource-indexed" }), timestamp, timestamp);
    audit("queued", "task", taskId, { type: "wiki:impact-scan", resourceVersionId, reason: "resource-indexed" });
    return taskId;
  };
  const createProcessingRun = (version, chunkingConfig, processingRequest) => {
    const resource = sqlite.prepare("SELECT * FROM resources WHERE id=?").get(version.resource_id);
    if (!resource || resource.status === "archived") throw archivedError();
    const runId = crypto.randomUUID();
    const timestamp = now();
    sqlite.transaction(() => {
      sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,chunker_name,chunker_version,chunking_config,input_sha256,requested_ocr_mode,requested_ocr_provider,capabilities,created_at,updated_at) VALUES (?,?, 'processing', 'weknora-adaptive', '1', ?, ?, ?, ?, ?, ?, ?)").run(runId, version.id, JSON.stringify(chunkingConfig), version.content_sha256, processingRequest.mode, processingRequest.provider, JSON.stringify(processingRequest.capabilities), timestamp, timestamp);
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
    success: async (attemptId, result) => sqlite.prepare("UPDATE processing_run_attempts SET status='succeeded',metadata=?,finished_at=? WHERE id=?").run(JSON.stringify({ quality: result.quality || {}, ocr: result.ocr || null, metadata: result.metadata || {} }), now(), attemptId),
    failure: async (attemptId, caught) => sqlite.prepare("UPDATE processing_run_attempts SET status='failed',error_code=?,error_summary=?,metadata=?,finished_at=? WHERE id=?").run(caught?.code || "PARSE_FAILED", caught?.message || "reader failed", JSON.stringify(caught?.metadata || {}), now(), attemptId)
  });

  const writeCanonicalArtifact = (version, runId, parsed, document) => {
    const artifact = {
      schemaVersion: 2,
      resourceVersionId: version.id,
      processingRunId: runId,
      canonicalText: document.canonicalText,
      assets: parsed.assets || [],
      pages: parsed.pages || [],
      blocks: parsed.blocks?.length ? parsed.blocks : document.blocks,
      metadata: { ...(parsed.metadata || {}), quality: parsed.quality || {}, ocr: parsed.ocr || null, strategy: document.strategy, strategyChain: document.strategyChain, validation: document.validation, profile: document.profile }
    };
    const bytes = Buffer.from(JSON.stringify(artifact));
    const storageKey = `canonical/${version.id}/${runId}.json`;
    persistBytes(config.resourceStorageDir, storageKey, bytes);
    return { storageKey, bytes, sha256: sha256(bytes) };
  };

  const outputDigest = (document) => sha256(JSON.stringify(document.output.map((chunk) => ({ sequence: chunk.sequence, type: chunk.chunkType, parentIndex: chunk.parentIndex, start: chunk.start, end: chunk.end, content: chunk.content, contextHeader: chunk.contextHeader || "", forcedSplit: Boolean(chunk.forcedSplit) }))));

  const pageMetadata = (parsed, chunk) => {
    const pages = (parsed.pages || []).filter((page) => {
      if (page.canonicalStart === undefined || page.canonicalEnd === undefined) return true;
      return page.canonicalStart < chunk.end && page.canonicalEnd > chunk.start;
    }).map((page) => page.pageNumber);
    const blockKinds = (parsed.blocks || []).filter((block) => {
      if (block.start === undefined || block.end === undefined) return true;
      return block.start < chunk.end && block.end > chunk.start;
    }).map((block) => block.kind || block.type).filter(Boolean);
    return { pages: [...new Set(pages)].sort((left, right) => left - right), blockKinds: [...new Set(blockKinds)] };
  };

  const persistProcessedDocument = (version, runId, previousRunId, parsed, document, artifact, started, processingRequest) => sqlite.transaction(() => {
    const fresh = sqlite.prepare("SELECT rv.*,r.status AS resource_status,r.current_version_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.id=?").get(version.id);
    if (!fresh || fresh.resource_status === "archived") throw archivedError();
    if (fresh.active_processing_run_id !== previousRunId) throw Object.assign(new Error("active processing run changed"), { code: "WORKER_INTERRUPTED" });
    const previousRun = previousRunId;
    const parentIds = new Map();
    const insertChunk = sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,forced_split,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,'active',?)");
    const insertFts = sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)");
    const activeTaskCache = config.retrievalVectorEnabled !== false ? createEmbeddingTaskCache(sqlite) : null;
    for (const chunk of document.output) {
      const id = crypto.randomUUID();
      if (chunk.chunkType === "parent_text") parentIds.set(chunk.parentIndex, id);
      const parentId = chunk.chunkType === "text" && chunk.parentIndex !== null ? parentIds.get(chunk.parentIndex) || null : null;
      const page = pageMetadata(parsed, chunk);
      const locator = JSON.stringify({ startOffset: chunk.start, endOffset: chunk.end, resourceVersionId: version.id, processingRunId: runId, parentIndex: chunk.parentIndex, childIndex: chunk.childIndex ?? null, blockTypes: [...new Set([...(chunk.blockTypes || []), ...page.blockKinds])], pageStart: page.pages[0] || null, pageEnd: page.pages.at(-1) || null, pages: page.pages, forcedSplit: Boolean(chunk.forcedSplit) });
      insertChunk.run(id, version.id, runId, parentId, chunk.chunkType, chunk.sequence, chunk.content, chunk.contextHeader || null, chunk.start, chunk.end, locator, document.strategy, chunk.forcedSplit ? 1 : 0, now());
      if (chunk.chunkType === "text") {
        insertFts.run(id, searchableText([chunk.contextHeader, chunk.content].filter(Boolean).join("\n\n")), parsed.title || fresh.title || "");
        if (config.retrievalVectorEnabled !== false) {
          const embeddingTask = queueEmbeddingTask(sqlite, { ownerType: "raw_chunk", ownerId: id, resourceVersionId: version.id, processingRunId: runId, reason: "resource-indexed", activeTaskCache });
          audit("queued", "task", embeddingTask.id, { type: "retrieval:embed", ownerType: "raw_chunk", ownerId: id, resourceVersionId: version.id });
        }
      }
    }
    const outputSha256 = outputDigest(document);
    const timestamp = now();
    const ocr = parsed.ocr || {};
    const adapter = ocr.adapter || {};
    sqlite.prepare("UPDATE processing_runs SET status='indexed',parser_name=?,parser_version=?,actual_provider=?,adapter_name=?,adapter_version=?,model_name=?,model_version=?,provider_request_id=?,duration_ms=?,page_count=?,capabilities=?,metrics=?,canonical_storage_key=?,canonical_sha256=?,canonical_byte_size=?,block_count=?,parent_count=?,child_count=?,output_sha256=?,warning_count=?,error_code=NULL,error_summary=NULL,updated_at=? WHERE id=? AND status='processing'").run(parsed.parserName, parsed.parserVersion, parsed.provider || null, adapter.adapterName || null, adapter.adapterVersion || null, adapter.modelName || null, adapter.modelVersion || null, adapter.requestId || null, Date.now() - started, ocr.pageCount || parsed.pages?.length || null, JSON.stringify(ocr.capabilities || processingRequest.capabilities || {}), JSON.stringify({ quality: parsed.quality || {}, warnings: ocr.warnings || [] }), artifact.storageKey, artifact.sha256, artifact.bytes.length, parsed.blocks?.length || document.blocks.length, document.parents.length, document.children.length, outputSha256, ocr.warnings?.length || parsed.quality?.warningCount || 0, timestamp, runId);
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
    queueImpactScan(version.id);
    audit("indexed", "processing_run", runId, { resourceVersionId: version.id, parents: document.parents.length, children: document.children.length, strategy: document.strategy });
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
    const controller = new AbortController();
    const abortFromTask = () => controller.abort();
    task.signal?.addEventListener("abort", abortFromTask, { once: true });
    const cancelPoll = setInterval(() => {
      const current = sqlite.prepare("SELECT cancel_requested FROM tasks WHERE id=?").get(task.id);
      if (current?.cancel_requested) controller.abort();
    }, 100);
    const timeoutMs = Number.isFinite(config.resourceParserTimeoutMs) && config.resourceParserTimeoutMs > 0 ? config.resourceParserTimeoutMs : 120000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const updateProgress = ({ progress }) => {
      if (!Number.isFinite(progress)) return;
      sqlite.prepare("UPDATE tasks SET progress=?,updated_at=? WHERE id=? AND status='running'").run(Math.max(0, Math.min(99, Math.round(progress))), now(), task.id);
    };
    try {
      let chunkingConfig = {};
      try { chunkingConfig = normalizeChunkingConfig(version.chunking_config ? JSON.parse(version.chunking_config) : {}); }
      catch (caught) { throw Object.assign(new Error(`invalid chunking config: ${caught.message}`), { code: "VALIDATION_ERROR" }); }
      const processingRequest = processingRequestFromVersion(version, { isPdf: version.mime_type === "application/pdf" });
      const processingRun = createProcessingRun(version, chunkingConfig, processingRequest);
      runId = processingRun.runId;
      previousRunId = processingRun.previousRunId;
      const parsed = await materialReader.read(version, { ...attemptHooks(runId), signal: controller.signal, progress: updateProgress });
      if (parsed.pages?.length > config.ocrMaxPages) throw Object.assign(new Error("OCR page limit exceeded"), { code: "OCR_LIMIT_EXCEEDED", metadata: { maxPages: config.ocrMaxPages, pageCount: parsed.pages.length } });
      if (parsed.pages?.length) updateProgress({ progress: 99 });
      const document = chunkDocument(parsed.canonicalText, chunkingConfig);
      if (!document.children.length) throw Object.assign(new Error("parsed content produced no child chunks"), { code: "PARSE_FAILED" });
      const artifact = writeCanonicalArtifact(version, runId, parsed, document);
      persistProcessedDocument(version, runId, previousRunId, parsed, document, artifact, started, processingRequest);
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
      if (controller.signal.aborted && caught?.code !== "SOURCE_INTEGRITY_FAILED") {
        const cancelled = sqlite.prepare("SELECT cancel_requested FROM tasks WHERE id=?").get(task.id)?.cancel_requested || task.signal?.aborted;
        throw Object.assign(new Error(cancelled ? "resource processing was cancelled" : "resource processing timed out"), { code: cancelled ? "TASK_CANCELLED" : "PROCESSING_TIMEOUT", cause: caught });
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      task.signal?.removeEventListener("abort", abortFromTask);
    }
  };

  return { processResource };
};
