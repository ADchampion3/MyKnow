import crypto from "node:crypto";
import path from "node:path";
import { chunkDocument, contentStorageKey, externalWikiMode, mimeForExtension, normalizeChunkingConfig, normalizeOcrProcessingRequest, normalizeWikiMode, persistBytes, processingRequestFromVersion, readBytes, refreshResourceStatus, sha256, supportedMime } from "@myknow/db";

const textMimes = new Set(["text/plain", "text/markdown"]);
const resourceStatuses = new Set(["pending", "processing", "indexed", "degraded", "failed", "archived"]);

const fail = (message, code = "VALIDATION_ERROR") => Object.assign(new Error(message), { code });
const safeFilename = (value) => path.posix.basename(String(value || "").replaceAll("\\", "/")).slice(0, 255);
const requestField = (body, ...names) => names.map((name) => body?.[name]).find((value) => value !== undefined);
const parseOcrCapabilities = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { throw fail("ocrCapabilities must be valid JSON", "OCR_CAPABILITIES_INVALID"); }
  }
  return value;
};
const ocrRequestFor = (body, isPdf, stored = null) => {
  const hasOverrides = ["ocrMode", "ocr_mode", "mode", "ocrProvider", "ocr_provider", "provider", "ocrCapabilities", "ocr_capabilities", "capabilities"].some((name) => body?.[name] !== undefined);
  if (!hasOverrides && stored) return processingRequestFromVersion(stored, { isPdf });
  return normalizeOcrProcessingRequest({
    ocrMode: requestField(body, "ocrMode", "ocr_mode", "mode"),
    ocrProvider: requestField(body, "ocrProvider", "ocr_provider", "provider"),
    ocrCapabilities: parseOcrCapabilities(requestField(body, "ocrCapabilities", "ocr_capabilities", "capabilities"))
  }, { isPdf });
};
const readVerified = (root, key, expectedSize, expectedSha, label) => {
  let bytes;
  try { bytes = readBytes(root, key); } catch { throw fail(`${label} is missing`, "SOURCE_INTEGRITY_FAILED"); }
  if (bytes.length !== expectedSize || sha256(bytes) !== expectedSha) throw fail(`${label} integrity check failed`, "SOURCE_INTEGRITY_FAILED");
  return bytes;
};

const parseImportInput = (body, displayName) => {
  if (body?.url !== undefined || body?.contentBase64 !== undefined) throw fail("URL and Base64 imports are not supported");
  const hasText = typeof body?.content === "string";
  const file = body?.file && Buffer.isBuffer(body.file.bytes) ? body.file : null;
  if (hasText === Boolean(file)) throw fail("provide exactly one of content or file");
  if (file) {
    const originalFilename = safeFilename(file.filename);
    const declaredMimeType = typeof file.mimeType === "string" ? file.mimeType.split(";", 1)[0].trim().toLowerCase() : "";
    const mimeType = declaredMimeType && declaredMimeType !== "application/octet-stream" ? declaredMimeType : mimeForExtension(originalFilename) || declaredMimeType;
    if (!originalFilename || !supportedMime(originalFilename, mimeType)) throw fail("file extension and MIME type must match .md, .txt, or .pdf", "UNSUPPORTED_MEDIA_TYPE");
    return { bytes: file.bytes, sourceType: "file", mimeType, originalFilename, displayName };
  }
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType.trim().toLowerCase() : mimeForExtension(displayName) || "text/plain";
  if (!textMimes.has(mimeType) || (mimeForExtension(displayName) && !supportedMime(displayName, mimeType))) throw fail("text imports must use .md/.txt and text/plain or text/markdown", "UNSUPPORTED_MEDIA_TYPE");
  const bytes = Buffer.from(body.content, "utf8");
  return { bytes, sourceType: "text", mimeType, originalFilename: null, displayName };
};

const chunkingFor = (sqlite, resourceId, kbId) => {
  const row = kbId
    ? sqlite.prepare("SELECT chunking_config FROM knowledge_bases WHERE id=?").get(kbId)
    : sqlite.prepare("SELECT rv.chunking_config FROM resource_versions rv WHERE rv.resource_id=? ORDER BY rv.created_at DESC,rv.id DESC LIMIT 1").get(resourceId);
  try { return normalizeChunkingConfig(row?.chunking_config ? JSON.parse(row.chunking_config) : {}); }
  catch (caught) { throw fail(`invalid knowledge-base chunking config: ${caught.message}`); }
};

const taskFor = (ctx, versionId) => ctx.taskView(ctx.taskForVersion(versionId));
const versionPayload = (ctx, row) => ctx.versionView(row);
const resourcePayload = (ctx, row) => {
  if (!row) return null;
  const versions = ctx.sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC,id DESC").all(row.id).map((version) => versionPayload(ctx, version));
  const latest = versions[0];
  const result = { ...ctx.resourceView(row), currentVersion: versions.find((version) => version.id === row.current_version_id) || null, latestVersion: latest || null, versions, task: latest ? taskFor(ctx, latest.id) : null };
  result.wikiMode = row.wiki_mode ? externalWikiMode(row.wiki_mode) : null;
  result.wikiModeByKnowledgeBase = ctx.sqlite.prepare("SELECT rkb.knowledge_base_id AS knowledgeBaseId, CASE WHEN r.wiki_mode IS NULL THEN kb.wiki_default_mode ELSE r.wiki_mode END AS mode FROM resource_knowledge_bases rkb JOIN resources r ON r.id=rkb.resource_id JOIN knowledge_bases kb ON kb.id=rkb.knowledge_base_id WHERE r.id=? ORDER BY rkb.knowledge_base_id").all(row.id).map((item) => ({ ...item, mode: externalWikiMode(item.mode) }));
  return result;
};

const importResource = async (ctx, { body, requestId, idempotencyKey, resourceId = null }) => {
  const { config, sqlite } = ctx;
  const existing = resourceId ? ctx.resource(resourceId) : null;
  if (resourceId && !existing) throw fail("resource not found", "NOT_FOUND");
  if (existing?.status === "archived") throw fail("archived resources cannot receive new versions", "RESOURCE_ARCHIVED");
  if (existing && body?.name !== undefined && ctx.inputName({ name: body.name }) !== existing.name) throw fail("rename the resource with PATCH before adding a version", "INVALID_STATE_TRANSITION");
  const name = existing ? existing.name : ctx.inputName({ name: body?.name });
  if (!name) throw fail("valid name is required");
  const kbId = existing ? null : typeof body?.knowledgeBaseId === "string" ? body.knowledgeBaseId.trim() : null;
  if (!existing && !kbId) throw fail("valid knowledgeBaseId is required");
  if (kbId && !ctx.validKb(kbId)) throw fail("Knowledge base not found", "NOT_FOUND");
  if (existing && body?.knowledgeBaseId !== undefined) {
    if (typeof body.knowledgeBaseId !== "string" || !body.knowledgeBaseId.trim()) throw fail("knowledgeBaseId must be a non-empty string");
    if (!sqlite.prepare("SELECT 1 FROM resource_knowledge_bases WHERE resource_id=? AND knowledge_base_id=?").get(existing.id, body.knowledgeBaseId.trim())) throw fail("resource is not linked to this knowledge base", "NOT_FOUND");
  }
  const input = parseImportInput(body, name);
  if (!input.bytes.length || input.bytes.length > config.resourceMaxBytes) throw fail("source size is invalid");
  if (existing && existing.source_type !== input.sourceType) throw fail("a resource cannot change source type", "INVALID_STATE_TRANSITION");
  const processingRequest = ocrRequestFor(body, input.mimeType === "application/pdf");
  let initialWikiMode = null;
  if (!existing && (body?.wikiMode !== undefined || body?.wiki_mode !== undefined)) {
    try { initialWikiMode = normalizeWikiMode(body.wikiMode ?? body.wiki_mode, { nullable: true }); }
    catch (caught) { throw fail(caught.message); }
  }
  const fingerprint = sha256(input.bytes);
  const requestFingerprint = sha256(JSON.stringify({ resourceId: existing?.id || null, kbId, name, sourceType: input.sourceType, mimeType: input.mimeType, originalFilename: input.originalFilename, contentSha256: fingerprint, processingRequest }));
  if (idempotencyKey) {
    if (idempotencyKey.length > 200) throw fail("Idempotency-Key is too long");
    const prior = sqlite.prepare("SELECT * FROM resource_versions WHERE idempotency_key=?").get(idempotencyKey);
    if (prior) {
      if (prior.request_fingerprint !== requestFingerprint) throw fail("Idempotency-Key was already used for a different request", "IDEMPOTENCY_KEY_REUSED");
      return { status: 200, data: { resource: resourcePayload(ctx, ctx.resource(prior.resource_id)), version: versionPayload(ctx, prior), task: taskFor(ctx, prior.id), idempotent: true } };
    }
  }
  const storageKey = contentStorageKey(fingerprint);
  persistBytes(config.resourceStorageDir, storageKey, input.bytes);
  const timestamp = ctx.now();
  const targetResourceId = existing?.id || crypto.randomUUID();
  const versionId = crypto.randomUUID();
  let task;
  sqlite.transaction(() => {
    if (!existing) sqlite.prepare("INSERT INTO resources (id,name,source_type,wiki_mode,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'pending',NULL,?,?)").run(targetResourceId, name, input.sourceType, initialWikiMode, timestamp, timestamp);
    sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,original_filename,chunking_config,ocr_mode,ocr_provider,ocr_capabilities,status,idempotency_key,request_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)").run(versionId, targetResourceId, fingerprint, storageKey, input.mimeType, input.bytes.length, input.originalFilename, JSON.stringify(chunkingFor(sqlite, targetResourceId, kbId)), processingRequest.mode, processingRequest.provider, JSON.stringify(processingRequest.capabilities), idempotencyKey, requestFingerprint, timestamp, timestamp);
    if (!existing) sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(targetResourceId, kbId, timestamp);
    task = ctx.queueVersion(versionId, requestId, existing ? "new-version" : "import");
    ctx.audit("imported", "resource_version", versionId, requestId, { resourceId: targetResourceId, sourceType: input.sourceType });
  })();
  return { status: 201, data: { resource: resourcePayload(ctx, ctx.resource(targetResourceId)), version: versionPayload(ctx, ctx.version(versionId)), task: ctx.taskView(task), idempotent: false } };
};

const queueVersionIfNeeded = (ctx, versionId, requestId, reason) => {
  const active = ctx.sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(versionId);
  return active ? ctx.taskView(active) : ctx.taskView(ctx.queueVersion(versionId, requestId, reason));
};

export const handleResourceRoutes = async ({ ctx, request }) => {
  const { pathname, method, parsed, body, requestId, idempotencyKey, res } = request;
  const { sqlite, config } = ctx;

  if (pathname === "/api/resources" && method === "POST") {
    const result = await importResource(ctx, { body, requestId, idempotencyKey });
    ctx.json(res, result.status, result.data, null, requestId);
    return true;
  }

  const versionCreateMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions$/);
  if (versionCreateMatch && method === "POST") {
    const result = await importResource(ctx, { body, requestId, idempotencyKey, resourceId: versionCreateMatch[1] });
    ctx.json(res, result.status, result.data, null, requestId);
    return true;
  }

  if (pathname === "/api/resources/rebuild" && method === "POST") {
    const timestamp = ctx.now();
    let queued = 0;
    sqlite.transaction(() => {
      for (const version of sqlite.prepare("SELECT rv.* FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE r.status <> 'archived' ORDER BY rv.created_at,rv.id").all()) {
        const active = sqlite.prepare("SELECT id FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(version.id);
        sqlite.prepare("UPDATE resource_versions SET status=CASE WHEN active_processing_run_id IS NULL THEN 'pending' ELSE 'indexed' END,error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, version.id);
        if (!active) { ctx.queueVersion(version.id, requestId, "explicit-full-rebuild"); queued += 1; }
        refreshResourceStatus(sqlite, version.resource_id, timestamp);
      }
    })();
    ctx.audit("rebuild_queued", "resources", "all", requestId, { queued });
    ctx.json(res, 202, { queued, mode: "build-then-swap", versions: "all-active" }, null, requestId);
    return true;
  }

  if (pathname === "/api/resources" && method === "GET") {
    const kb = parsed.searchParams.get("knowledgeBaseId");
    const status = parsed.searchParams.get("status");
    const includeArchived = parsed.searchParams.get("includeArchived") === "true";
    const page = Number(parsed.searchParams.get("page") || 1);
    const limit = Number(parsed.searchParams.get("limit") || 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (status && !resourceStatuses.has(status))) {
      ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "page/limit/status is invalid"), requestId);
      return true;
    }
    const clauses = [];
    const args = [];
    let sql = "SELECT DISTINCT r.* FROM resources r";
    if (kb) { sql += " JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id"; clauses.push("rkb.knowledge_base_id=?"); args.push(kb); }
    if (!includeArchived) clauses.push("r.status <> 'archived'");
    if (status) clauses.push("r.status=?");
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?";
    args.push(limit, (page - 1) * limit);
    ctx.json(res, 200, sqlite.prepare(sql).all(...args).map((row) => resourcePayload(ctx, row)), null, requestId);
    return true;
  }

  const archiveMatch = pathname.match(/^\/api\/resources\/([^/]+)\/(archive|restore)$/);
  if (archiveMatch && method === "POST") {
    const resource = ctx.resource(archiveMatch[1]);
    if (!resource) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    const timestamp = ctx.now();
    if (archiveMatch[2] === "archive") {
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE resources SET status='archived',archived_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, resource.id);
        sqlite.prepare("UPDATE tasks SET cancel_requested=1,status=CASE WHEN status IN ('queued','retrying') THEN 'failed' ELSE status END,error_code=CASE WHEN status IN ('queued','retrying') THEN 'RESOURCE_ARCHIVED' ELSE error_code END,error_summary=CASE WHEN status IN ('queued','retrying') THEN 'Resource archived' ELSE error_summary END,finished_at=CASE WHEN status IN ('queued','retrying') THEN ? ELSE finished_at END,updated_at=? WHERE resource_version_id IN (SELECT id FROM resource_versions WHERE resource_id=?) AND status IN ('queued','running','retrying')").run(timestamp, timestamp, resource.id);
        ctx.audit("archived", "resource", resource.id, requestId);
      })();
      ctx.json(res, 200, resourcePayload(ctx, ctx.resource(resource.id)), null, requestId);
      return true;
    }
    let queued = 0;
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE resources SET archived_at=NULL,status='pending',updated_at=? WHERE id=? AND status='archived'").run(timestamp, resource.id);
      for (const version of sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? AND active_processing_run_id IS NULL AND status IN ('pending','failed')").all(resource.id)) {
        sqlite.prepare("UPDATE resource_versions SET status='pending',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, version.id);
        if (!sqlite.prepare("SELECT id FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(version.id)) { ctx.queueVersion(version.id, requestId, "restore"); queued += 1; }
      }
      refreshResourceStatus(sqlite, resource.id, timestamp);
      ctx.audit("restored", "resource", resource.id, requestId, { queued });
    })();
    ctx.json(res, 200, resourcePayload(ctx, ctx.resource(resource.id)), null, requestId);
    return true;
  }

  const resourceMatch = pathname.match(/^\/api\/resources\/([^/]+)$/);
  if (resourceMatch && method === "PATCH") {
    const resource = ctx.resource(resourceMatch[1]);
    if (!resource) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    const writable = new Set(["name", "wikiMode", "wiki_mode"]);
    const unsupported = Object.keys(body || {}).filter((key) => !writable.has(key));
    if (unsupported.length) { ctx.json(res, 409, null, ctx.error("RESOURCE_READ_ONLY", "Only display name and wiki mode can be changed; source content is immutable"), requestId); return true; }
    const name = body?.name === undefined ? resource.name : ctx.inputName(body);
    if (!name) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "name must be 1-120 characters"), requestId); return true; }
    let wikiMode = resource.wiki_mode;
    if (body?.wikiMode !== undefined || body?.wiki_mode !== undefined) {
      try { wikiMode = normalizeWikiMode(body.wikiMode ?? body.wiki_mode, { nullable: true }); }
      catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    sqlite.prepare("UPDATE resources SET name=?,wiki_mode=?,updated_at=? WHERE id=?").run(name, wikiMode, ctx.now(), resource.id);
    ctx.audit("updated", "resource", resource.id, requestId, { nameChanged: name !== resource.name, wikiMode: wikiMode ? externalWikiMode(wikiMode) : null });
    ctx.json(res, 200, resourcePayload(ctx, ctx.resource(resource.id)), null, requestId);
    return true;
  }
  if (resourceMatch && method === "DELETE") {
    const resource = ctx.resource(resourceMatch[1]);
    if (!resource) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    ctx.json(res, 409, null, ctx.error("RESOURCE_READ_ONLY", "Original resources cannot be deleted; archive them instead"), requestId);
    return true;
  }
  if (resourceMatch && method === "GET") {
    const found = ctx.resource(resourceMatch[1]);
    if (!found) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    ctx.json(res, 200, resourcePayload(ctx, found), null, requestId);
    return true;
  }

  const processingRunsMatch = pathname.match(/^\/api\/resources\/([^/]+)\/processing-runs$/);
  if (processingRunsMatch && method === "GET") {
    if (!ctx.resource(processingRunsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    const runs = sqlite.prepare("SELECT pr.*,rv.resource_id,rv.content_sha256 AS source_sha256 FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id WHERE rv.resource_id=? ORDER BY pr.created_at DESC,pr.id DESC").all(processingRunsMatch[1]);
    ctx.json(res, 200, runs.map((run) => ({ ...ctx.runView(run), attempts: sqlite.prepare("SELECT id,processing_run_id,reader_name,reader_version,status,error_code,error_summary,metadata,started_at,finished_at FROM processing_run_attempts WHERE processing_run_id=? ORDER BY started_at,id").all(run.id) })), null, requestId);
    return true;
  }

  const artifactMatch = pathname.match(/^\/api\/resources\/([^/]+)\/processing-runs\/([^/]+)\/canonical$/);
  if (artifactMatch && method === "GET") {
    const resource = ctx.resource(artifactMatch[1]);
    const run = resource && sqlite.prepare("SELECT pr.* FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id WHERE pr.id=? AND rv.resource_id=?").get(artifactMatch[2], artifactMatch[1]);
    if (!run?.canonical_storage_key) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Canonical artifact not found"), requestId); return true; }
    try {
      const bytes = readVerified(config.resourceStorageDir, run.canonical_storage_key, run.canonical_byte_size, run.canonical_sha256, "canonical artifact");
      ctx.json(res, 200, JSON.parse(bytes.toString("utf8")), null, requestId);
    } catch (caught) { ctx.respondCaught(res, caught, requestId); }
    return true;
  }

  const previewMatch = pathname.match(/^\/api\/resources\/([^/]+)\/chunk-preview$/);
  if (previewMatch && method === "POST") {
    if (!ctx.resource(previewMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 64 * 1024) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "text must be 1-65536 characters"), requestId); return true; }
    try {
      const document = chunkDocument(body.text, normalizeChunkingConfig(body?.chunkingConfig ?? {}));
      if (document.totalChunks > 500) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "preview produces too many chunks"), requestId); return true; }
      ctx.json(res, 200, { strategy: document.strategy, profile: document.profile, config: document.config, blocks: document.blocks, parents: document.parents, children: document.children, diagnostics: { totalChunks: document.totalChunks, parentCount: document.parents.length, childCount: document.children.length } }, null, requestId);
    } catch (caught) { ctx.respondCaught(res, caught, requestId); }
    return true;
  }

  const reprocessMatch = pathname.match(/^\/api\/resources\/([^/]+)\/reprocess$/);
  if (reprocessMatch && method === "POST") {
    const found = ctx.resource(reprocessMatch[1]);
    if (!found) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    if (found.status === "archived") { ctx.json(res, 409, null, ctx.error("RESOURCE_ARCHIVED", "Archived resources cannot be processed"), requestId); return true; }
    const target = body?.versionId ? ctx.version(body.versionId) : ctx.version(found.current_version_id);
    if (!target || target.resource_id !== found.id) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource version not found"), requestId); return true; }
    let processingRequest;
    try { processingRequest = ocrRequestFor(body, target.mime_type === "application/pdf", target); }
    catch (caught) { ctx.json(res, 400, null, ctx.error(caught.code || "VALIDATION_ERROR", caught.message), requestId); return true; }
    if (idempotencyKey && idempotencyKey.length > 200) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "Idempotency-Key is too long"), requestId); return true; }
    const processingFingerprint = sha256(JSON.stringify({ versionId: target.id, processingRequest, chunkingConfig: body?.chunkingConfig ?? null }));
    if (idempotencyKey) {
      const priorTasks = sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND resource_version_id=? ORDER BY created_at DESC,id DESC").all(target.id);
      for (const prior of priorTasks) {
        try {
          const payload = JSON.parse(prior.payload || "{}");
          if (payload.idempotencyKey === idempotencyKey) {
            if (payload.requestFingerprint !== processingFingerprint) { ctx.json(res, 409, null, ctx.error("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for different OCR settings"), requestId); return true; }
            ctx.json(res, 202, ctx.taskView(prior), null, requestId);
            return true;
          }
        } catch {}
      }
    }
    const activeTask = sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') ORDER BY created_at DESC,id DESC LIMIT 1").get(target.id);
    if (activeTask) { ctx.json(res, 202, ctx.taskView(activeTask), null, requestId); return true; }
    let chunkingConfig = null;
    if (body?.chunkingConfig !== undefined) {
      try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body.chunkingConfig)); }
      catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    const timestamp = ctx.now();
    let task;
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE resource_versions SET status=CASE WHEN active_processing_run_id IS NULL THEN 'pending' ELSE 'indexed' END,chunking_config=COALESCE(?,chunking_config),ocr_mode=?,ocr_provider=?,ocr_capabilities=?,error_summary=NULL,updated_at=? WHERE id=?").run(chunkingConfig, processingRequest.mode, processingRequest.provider, JSON.stringify(processingRequest.capabilities), timestamp, target.id);
      refreshResourceStatus(sqlite, found.id, timestamp);
      task = ctx.queueVersion(target.id, requestId, "reprocess", idempotencyKey ? { idempotencyKey, requestFingerprint: processingFingerprint } : null);
      ctx.audit("reprocess_requested", "resource_version", target.id, requestId, { taskId: task.id });
    })();
    ctx.json(res, 202, ctx.taskView(task), null, requestId);
    return true;
  }

  const versionsMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions$/);
  if (versionsMatch && method === "GET") {
    if (!ctx.resource(versionsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    ctx.json(res, 200, sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC,id DESC").all(versionsMatch[1]).map((version) => versionPayload(ctx, version)), null, requestId);
    return true;
  }

  const versionContentMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions\/([^/]+)\/(?:content|download)$/);
  if (versionContentMatch && method === "GET") {
    const found = ctx.version(versionContentMatch[2]);
    if (!found || found.resource_id !== versionContentMatch[1]) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Version not found"), requestId); return true; }
    try {
      const bytes = readVerified(config.resourceStorageDir, found.storage_key, found.byte_size, found.content_sha256, "source");
      res.writeHead(200, { "content-type": found.mime_type, "content-length": bytes.length, "cache-control": "no-store", "x-request-id": requestId, "access-control-allow-origin": ctx.allowedOrigin(res.req?.headers?.origin) });
      res.end(bytes);
    } catch (caught) { ctx.respondCaught(res, caught, requestId); }
    return true;
  }

  const versionMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch && method === "GET") {
    const found = ctx.version(versionMatch[2]);
    if (!found || found.resource_id !== versionMatch[1]) ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Version not found"), requestId);
    else ctx.json(res, 200, versionPayload(ctx, found), null, requestId);
    return true;
  }

  const retryResourceMatch = pathname.match(/^\/api\/resources\/([^/]+)\/retry$/);
  if (retryResourceMatch && method === "POST") {
    const found = ctx.resource(retryResourceMatch[1]);
    if (!found) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    if (found.status === "archived") { ctx.json(res, 409, null, ctx.error("RESOURCE_ARCHIVED", "Archived resources cannot be retried"), requestId); return true; }
    const target = body?.versionId ? ctx.version(body.versionId) : sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 1").get(found.id);
    if (!target || target.resource_id !== found.id) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Failed resource version not found"), requestId); return true; }
    if (target.status !== "failed") { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "Only failed resource versions can be retried"), requestId); return true; }
    if (sqlite.prepare("SELECT id FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(target.id)) { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "Resource version is already being processed"), requestId); return true; }
    let task;
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE resource_versions SET status='pending',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, target.id);
      task = ctx.queueVersion(target.id, requestId, "manual-retry");
      refreshResourceStatus(sqlite, found.id, timestamp);
      ctx.audit("retry_requested", "resource_version", target.id, requestId, { taskId: task.id });
    })();
    ctx.json(res, 202, ctx.taskView(task), null, requestId);
    return true;
  }

  const association = pathname.match(/^\/api\/resources\/([^/]+)\/knowledge-bases\/([^/]+)$/);
  if (association && method === "POST") {
    if (!ctx.resource(association[1]) || !ctx.validKb(association[2])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource or knowledge base not found"), requestId); return true; }
    sqlite.prepare("INSERT OR IGNORE INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(association[1], association[2], ctx.now());
    ctx.audit("linked", "resource", association[1], requestId, { knowledgeBaseId: association[2] });
    ctx.json(res, 204, null, null, requestId);
    return true;
  }
  if (association && method === "DELETE") {
    sqlite.prepare("DELETE FROM resource_knowledge_bases WHERE resource_id=? AND knowledge_base_id=?").run(association[1], association[2]);
    ctx.audit("unlinked", "resource", association[1], requestId, { knowledgeBaseId: association[2] });
    ctx.json(res, 204, null, null, requestId);
    return true;
  }
  return false;
};
