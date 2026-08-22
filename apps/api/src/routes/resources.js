import crypto from "node:crypto";
import path from "node:path";
import { chunkDocument, decodeBase64, ensurePendingResourceTasks, normalizeChunkingConfig, persistBytes, readBytes, sha256, supportedMime, validatePublicUrlResolved } from "@myknow/db";

const createImport = async (ctx, body, requestId) => {
  const { config, sqlite } = ctx;
  const name = ctx.inputName(body);
  const kbId = typeof body?.knowledgeBaseId === "string" ? body.knowledgeBaseId : null;
  if (!name || !kbId) throw Object.assign(new Error("valid name and knowledgeBaseId are required"), { code: "VALIDATION_ERROR" });
  if (!ctx.validKb(kbId)) throw Object.assign(new Error("Knowledge base not found"), { code: "NOT_FOUND" });
  const kb = sqlite.prepare("SELECT chunking_config FROM knowledge_bases WHERE id=?").get(kbId);
  let chunkingConfig;
  try { chunkingConfig = normalizeChunkingConfig(kb?.chunking_config ? JSON.parse(kb.chunking_config) : {}); }
  catch (caught) { throw Object.assign(new Error(`invalid knowledge-base chunking config: ${caught.message}`), { code: "VALIDATION_ERROR" }); }

  const hasResourceId = body?.resourceId !== undefined && body?.resourceId !== null;
  if (hasResourceId && typeof body.resourceId !== "string") throw Object.assign(new Error("resourceId must be a string"), { code: "VALIDATION_ERROR" });
  const updating = hasResourceId ? ctx.resource(body.resourceId) : null;
  if (hasResourceId && !updating) throw Object.assign(new Error("resource not found"), { code: "NOT_FOUND" });

  let bytes;
  let mimeType;
  let sourceType;
  let sourceUrl = null;
  let storageKey;
  const hasUrl = typeof body?.url === "string";
  const hasContent = typeof body?.contentBase64 === "string";
  if (hasUrl && !hasContent) {
    sourceUrl = await validatePublicUrlResolved(body.url);
    bytes = Buffer.from(sourceUrl);
    mimeType = "text/html";
    sourceType = "url";
    storageKey = path.posix.join("urls", sha256(sourceUrl) + ".url");
  } else if (hasContent && !hasUrl) {
    mimeType = body.mimeType;
    sourceType = "file";
    bytes = decodeBase64(body.contentBase64);
    if (!supportedMime(name, mimeType)) throw Object.assign(new Error("only .md, .txt, and .pdf are supported"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    if (!bytes.length || bytes.length > config.resourceMaxBytes) throw Object.assign(new Error("file size is invalid"), { code: "VALIDATION_ERROR" });
    storageKey = path.posix.join("files", sha256(bytes) + path.extname(name).toLowerCase());
  } else {
    throw Object.assign(new Error("provide exactly one of url or contentBase64"), { code: "VALIDATION_ERROR" });
  }

  const fingerprint = sha256(bytes);
  const duplicate = sqlite.prepare("SELECT rv.*, r.id AS resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.content_sha256=? LIMIT 1").get(fingerprint);
  if (duplicate && !updating) {
    sqlite.prepare("INSERT OR IGNORE INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(duplicate.resource_id, kbId, ctx.now());
    return { resource: ctx.resource(duplicate.resource_id), version: duplicate, task: ctx.taskForVersion(duplicate.id), duplicate: true };
  }
  if (updating && sqlite.prepare("SELECT id FROM resource_versions WHERE resource_id=? AND content_sha256=?").get(updating.id, fingerprint)) throw Object.assign(new Error("resource already has this content"), { code: "RESOURCE_DUPLICATE" });

  persistBytes(config.resourceStorageDir, storageKey, bytes);
  const timestamp = ctx.now();
  const resourceId = updating?.id || crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const tx = sqlite.transaction(() => {
    if (!updating) sqlite.prepare("INSERT INTO resources (id,name,source_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,'pending',?,?,?)").run(resourceId, name, sourceType, versionId, timestamp, timestamp);
    else sqlite.prepare("UPDATE resources SET name=?,source_type=?,status='pending',current_version_id=?,updated_at=? WHERE id=?").run(name, sourceType, versionId, timestamp, resourceId);
    sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,source_url,chunking_config,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)").run(versionId, resourceId, fingerprint, storageKey, mimeType, bytes.length, sourceUrl, JSON.stringify(chunkingConfig), timestamp, timestamp);
    sqlite.prepare("INSERT OR IGNORE INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(resourceId, kbId, timestamp);
    const task = ctx.queueVersion(versionId, requestId);
    ctx.audit("imported", "resource", resourceId, requestId, { resourceVersionId: versionId, sourceType });
    return task;
  });
  const task = tx();
  return { resource: ctx.resource(resourceId), version: ctx.version(versionId), task, duplicate: false };
};

export const handleResourceRoutes = async ({ ctx, request }) => {
  const { pathname, method, parsed, body, requestId, res } = request;
  const { sqlite, config } = ctx;

  if (pathname === "/api/resources" && method === "POST") {
    ctx.json(res, 201, await createImport(ctx, body, requestId), null, requestId);
    return true;
  }
  if (pathname === "/api/resources/rebuild" && method === "POST") {
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM resource_fts").run();
      sqlite.prepare("UPDATE chunks SET status='superseded'").run();
      sqlite.prepare("UPDATE processing_runs SET status='superseded',updated_at=? WHERE status='indexed'").run(timestamp);
      sqlite.prepare("UPDATE resource_versions SET status='pending',active_processing_run_id=NULL,error_summary=NULL,updated_at=?").run(timestamp);
      sqlite.prepare("UPDATE resources SET status=CASE WHEN status='archived' THEN status ELSE 'pending' END,updated_at=?").run(timestamp);
    })();
    const queued = ensurePendingResourceTasks(sqlite, "explicit-full-rebuild");
    ctx.audit("rebuild_queued", "resources", "all", requestId, { queued });
    ctx.json(res, 202, { queued, mode: "full-rebuild" }, null, requestId);
    return true;
  }
  if (pathname === "/api/resources" && method === "GET") {
    const kb = parsed.searchParams.get("knowledgeBaseId");
    const status = parsed.searchParams.get("status");
    const page = Number(parsed.searchParams.get("page") || 1);
    const limit = Number(parsed.searchParams.get("limit") || 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (status && !["pending", "processing", "indexed", "failed", "archived"].includes(status))) {
      ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "page/limit/status is invalid"), requestId);
      return true;
    }
    const clauses = [];
    const args = [];
    let sql = "SELECT r.* FROM resources r";
    if (kb) { sql += " JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id"; clauses.push("rkb.knowledge_base_id=?"); args.push(kb); }
    if (status) { clauses.push("r.status=?"); args.push(status); }
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY r.updated_at DESC LIMIT ? OFFSET ?";
    args.push(limit, (page - 1) * limit);
    ctx.json(res, 200, sqlite.prepare(sql).all(...args), null, requestId);
    return true;
  }

  const resourceMatch = pathname.match(/^\/api\/resources\/([^/]+)$/);
  if (resourceMatch && method === "GET") {
    const found = ctx.resource(resourceMatch[1]);
    if (!found) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    ctx.json(res, 200, { ...found, versions: sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC").all(found.id), task: found.current_version_id ? ctx.taskForVersion(found.current_version_id) : null }, null, requestId);
    return true;
  }

  const processingRunsMatch = pathname.match(/^\/api\/resources\/([^/]+)\/processing-runs$/);
  if (processingRunsMatch && method === "GET") {
    if (!ctx.resource(processingRunsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    const runs = sqlite.prepare("SELECT pr.*,rv.resource_id,rv.content_sha256 AS source_sha256 FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id WHERE rv.resource_id=? ORDER BY pr.created_at DESC").all(processingRunsMatch[1]);
    ctx.json(res, 200, runs.map((run) => ({ ...run, attempts: sqlite.prepare("SELECT * FROM processing_run_attempts WHERE processing_run_id=? ORDER BY started_at").all(run.id) })), null, requestId);
    return true;
  }

  const artifactMatch = pathname.match(/^\/api\/resources\/([^/]+)\/processing-runs\/([^/]+)\/canonical$/);
  if (artifactMatch && method === "GET") {
    if (!ctx.resource(artifactMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    const run = sqlite.prepare("SELECT pr.* FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id WHERE pr.id=? AND rv.resource_id=?").get(artifactMatch[2], artifactMatch[1]);
    if (!run?.canonical_storage_key) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Canonical artifact not found"), requestId); return true; }
    try { ctx.json(res, 200, JSON.parse(readBytes(config.resourceStorageDir, run.canonical_storage_key).toString("utf8")), null, requestId); }
    catch { ctx.json(res, 500, null, ctx.error("INTERNAL_ERROR", "Canonical artifact is unreadable"), requestId); }
    return true;
  }

  const previewMatch = pathname.match(/^\/api\/resources\/([^/]+)\/chunk-preview$/);
  if (previewMatch && method === "POST") {
    if (!ctx.resource(previewMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 64 * 1024) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "text must be 1-65536 characters"), requestId); return true; }
    try {
      const document = chunkDocument(body.text, normalizeChunkingConfig(body?.chunkingConfig || {}));
      if (document.totalChunks > 500) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "preview produces too many chunks"), requestId); return true; }
      ctx.json(res, 200, { strategy: document.strategy, profile: document.profile, config: document.config, blocks: document.blocks, parents: document.parents, children: document.children, diagnostics: { totalChunks: document.totalChunks, parentCount: document.parents.length, childCount: document.children.length } }, null, requestId);
    } catch (caught) { ctx.respondCaught(res, caught, requestId); }
    return true;
  }

  const reprocessMatch = pathname.match(/^\/api\/resources\/([^/]+)\/reprocess$/);
  if (reprocessMatch && method === "POST") {
    const found = ctx.resource(reprocessMatch[1]);
    const target = found && (body?.versionId ? ctx.version(body.versionId) : ctx.version(found.current_version_id));
    if (!found || !target || target.resource_id !== found.id) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource version not found"), requestId); return true; }
    const activeTask = sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND json_extract(payload,'$.resourceVersionId')=? AND status IN ('queued','running','retrying') ORDER BY created_at DESC LIMIT 1").get(target.id);
    if (activeTask) { ctx.json(res, 202, activeTask, null, requestId); return true; }
    let chunkingConfig = null;
    if (body?.chunkingConfig !== undefined) {
      try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body.chunkingConfig)); }
      catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE resource_versions SET status='pending',chunking_config=COALESCE(?,chunking_config),error_summary=NULL,updated_at=? WHERE id=?").run(chunkingConfig, timestamp, target.id);
      sqlite.prepare("UPDATE resources SET status='pending',updated_at=? WHERE id=? AND current_version_id=?").run(timestamp, found.id, target.id);
    })();
    const task = ctx.queueVersion(target.id, requestId);
    ctx.audit("reprocess_requested", "resource_version", target.id, requestId, { taskId: task.id });
    ctx.json(res, 202, task, null, requestId);
    return true;
  }

  const versionsMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions$/);
  if (versionsMatch && method === "GET") {
    if (!ctx.resource(versionsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource not found"), requestId); return true; }
    ctx.json(res, 200, sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC").all(versionsMatch[1]), null, requestId);
    return true;
  }

  const versionContentMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions\/([^/]+)\/(?:content|download)$/);
  if (versionContentMatch && method === "GET") {
    const found = ctx.version(versionContentMatch[2]);
    if (!found || found.resource_id !== versionContentMatch[1]) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Version not found"), requestId); return true; }
    const bytes = readBytes(config.resourceStorageDir, found.storage_key);
    res.writeHead(200, { "content-type": found.mime_type, "content-length": bytes.length, "cache-control": "no-store", "x-request-id": requestId, "access-control-allow-origin": ctx.allowedOrigin(res.req?.headers?.origin) });
    res.end(bytes);
    return true;
  }

  const versionMatch = pathname.match(/^\/api\/resources\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch && method === "GET") {
    const found = ctx.version(versionMatch[2]);
    if (!found || found.resource_id !== versionMatch[1]) ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Version not found"), requestId);
    else ctx.json(res, 200, found, null, requestId);
    return true;
  }

  const retryResourceMatch = pathname.match(/^\/api\/resources\/([^/]+)\/retry$/);
  if (retryResourceMatch && method === "POST") {
    const found = ctx.resource(retryResourceMatch[1]);
    const current = found && ctx.version(found.current_version_id);
    const task = current && ctx.taskForVersion(current.id);
    if (!current || !task) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource task not found"), requestId); return true; }
    if (current.status !== "failed" || task.status !== "failed") { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "Only failed resources can be retried"), requestId); return true; }
    if (task.retry_count >= task.retry_limit) { ctx.json(res, 409, null, ctx.error("TASK_RETRY_LIMIT", "Task retry limit reached"), requestId); return true; }
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      const changed = sqlite.prepare("UPDATE tasks SET status='retrying',worker_id=NULL,finished_at=NULL,error_summary=NULL,updated_at=? WHERE id=? AND status='failed' AND retry_count < retry_limit").run(timestamp, task.id).changes;
      if (!changed) throw Object.assign(new Error("Task is no longer retryable"), { code: "INVALID_STATE_TRANSITION" });
      sqlite.prepare("UPDATE resources SET status='pending',updated_at=? WHERE id=? AND current_version_id=?").run(timestamp, found.id, current.id);
      sqlite.prepare("UPDATE resource_versions SET status='pending',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, current.id);
      ctx.audit("retrying", "task", task.id, requestId, { resourceVersionId: current.id });
    })();
    ctx.json(res, 202, sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(task.id), null, requestId);
    return true;
  }

  const association = pathname.match(/^\/api\/resources\/([^/]+)\/knowledge-bases\/([^/]+)$/);
  if (association && method === "POST") {
    if (!ctx.resource(association[1]) || !ctx.validKb(association[2])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Resource or knowledge base not found"), requestId); return true; }
    sqlite.prepare("INSERT OR IGNORE INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(association[1], association[2], ctx.now());
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
