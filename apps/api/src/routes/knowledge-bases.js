import { redactAuditMetadata, redactSecrets } from "@myknow/config";
import { embeddingProgressForRun, externalWikiMode, knowledgeBases, normalizeChunkingConfig, normalizeWikiMode, spaces, tags } from "@myknow/db";
import { desc, eq } from "drizzle-orm";

export const handleKnowledgeBaseRoutes = ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  const { db, sqlite } = ctx;
  const kbView = (row) => row ? { ...row, wikiDefaultMode: externalWikiMode(row.wikiDefaultMode || row.wiki_default_mode || "enabled") } : row;

  if (pathname === "/api/knowledge-bases" && method === "GET") {
    ctx.ok(res, 200, db.select().from(knowledgeBases).orderBy(desc(knowledgeBases.updatedAt)).all().map(kbView), requestId);
    return true;
  }
  if (pathname === "/api/knowledge-bases" && method === "POST") {
    let chunkingConfig;
    let wikiDefaultMode;
    try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body?.chunkingConfig ?? {})); }
    catch (caught) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    try { wikiDefaultMode = normalizeWikiMode(body?.wikiDefaultMode ?? body?.wikiMode); }
    catch (caught) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    const result = ctx.collection(body, { description: body?.description || null, chunkingConfig, wikiDefaultMode, status: "active" });
    if (result.error) { ctx.fail(res, 400, result.error, requestId); return true; }
    db.insert(knowledgeBases).values(result.value).run();
    ctx.audit("created", "knowledge_base", result.value.id, requestId, { chunkingConfig: JSON.parse(chunkingConfig) });
    ctx.ok(res, 201, kbView(result.value), requestId);
    return true;
  }

  const knowledgeBaseMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)$/);
  if (knowledgeBaseMatch && method === "PATCH") {
    const found = sqlite.prepare("SELECT * FROM knowledge_bases WHERE id=? AND status='active'").get(knowledgeBaseMatch[1]);
    if (!found) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const nextName = body?.name === undefined ? found.name : ctx.inputName(body);
    if (!nextName) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", "name must be 1-120 characters"), requestId); return true; }
    let chunkingConfig = found.chunking_config;
    let wikiDefaultMode = found.wiki_default_mode;
    if (body?.chunkingConfig !== undefined) {
      try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body.chunkingConfig)); }
      catch (caught) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    if (body?.wikiDefaultMode !== undefined || body?.wikiMode !== undefined) {
      try { wikiDefaultMode = normalizeWikiMode(body.wikiDefaultMode ?? body.wikiMode); }
      catch (caught) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    sqlite.prepare("UPDATE knowledge_bases SET name=?,description=?,chunking_config=?,wiki_default_mode=?,updated_at=? WHERE id=?").run(nextName, body?.description === undefined ? found.description : body.description, chunkingConfig, wikiDefaultMode, ctx.now(), found.id);
    ctx.audit("updated", "knowledge_base", found.id, requestId, { chunkingConfigChanged: body?.chunkingConfig !== undefined, wikiDefaultModeChanged: body?.wikiDefaultMode !== undefined || body?.wikiMode !== undefined });
    ctx.ok(res, 200, kbView(db.select().from(knowledgeBases).where(eq(knowledgeBases.id, found.id)).get()), requestId);
    return true;
  }

  const processingRunsMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/processing-runs$/);
  if (processingRunsMatch && method === "GET") {
    const knowledgeBaseId = processingRunsMatch[1];
    if (!ctx.validKb(knowledgeBaseId)) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const page = Number(request.parsed.searchParams.get("page") || 1);
    const limit = Number(request.parsed.searchParams.get("limit") || 50);
    const status = request.parsed.searchParams.get("status") || null;
    const allowedStatuses = new Set(["pending", "processing", "indexed", "failed", "superseded"]);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (status && !allowedStatuses.has(status))) {
      ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", "page/limit/status is invalid"), requestId);
      return true;
    }
    const filters = ["rkb.knowledge_base_id=?"];
    const args = [knowledgeBaseId];
    if (status) { filters.push("pr.status=?"); args.push(status); }
    const where = filters.join(" AND ");
    const total = sqlite.prepare(`SELECT count(*) AS total FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id JOIN resource_knowledge_bases rkb ON rkb.resource_id=rv.resource_id WHERE ${where}`).get(...args).total;
    const rows = sqlite.prepare(`SELECT pr.*,rv.resource_id,r.name AS resource_name,rv.content_sha256 AS source_sha256 FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id JOIN resources r ON r.id=rv.resource_id JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id WHERE ${where} ORDER BY pr.created_at DESC,pr.id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
    const items = rows.map((run) => ({
      id: run.id,
      resourceId: run.resource_id,
      resourceName: run.resource_name,
      resourceVersionId: run.resource_version_id,
      status: run.status,
      parserName: run.parser_name,
      parserVersion: run.parser_version,
      childCount: run.child_count,
      durationMs: run.duration_ms,
      warningCount: run.warning_count,
      errorCode: run.error_code,
      errorSummary: run.error_summary ? redactSecrets(run.error_summary) : null,
      sourceSha256: run.source_sha256,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      embeddingProgress: redactSecrets(embeddingProgressForRun(sqlite, run.id, ctx.config))
    }));
    ctx.ok(res, 200, { items, page, limit, total, pageCount: Math.ceil(total / limit) }, requestId);
    return true;
  }

  const auditEventsMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/audit-events$/);
  if (auditEventsMatch && method === "GET") {
    const knowledgeBaseId = auditEventsMatch[1];
    if (!ctx.validKb(knowledgeBaseId)) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const page = Number(request.parsed.searchParams.get("page") || 1);
    const limit = Number(request.parsed.searchParams.get("limit") || 50);
    const eventType = request.parsed.searchParams.get("eventType") || null;
    const resourceVersionId = request.parsed.searchParams.get("resourceVersionId") || null;
    const processingRunId = request.parsed.searchParams.get("processingRunId") || null;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (eventType && eventType.length > 80) || (resourceVersionId && resourceVersionId.length > 200) || (processingRunId && processingRunId.length > 200)) {
      ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", "page/limit/filter is invalid"), requestId);
      return true;
    }
    if (resourceVersionId && !sqlite.prepare("SELECT rv.id FROM resource_versions rv JOIN resource_knowledge_bases rkb ON rkb.resource_id=rv.resource_id WHERE rv.id=? AND rkb.knowledge_base_id=?").get(resourceVersionId, knowledgeBaseId)) {
      ctx.fail(res, 404, ctx.error("NOT_FOUND", "Resource version not found in this knowledge base"), requestId);
      return true;
    }
    if (processingRunId && !sqlite.prepare("SELECT pr.id FROM processing_runs pr JOIN resource_versions rv ON rv.id=pr.resource_version_id JOIN resource_knowledge_bases rkb ON rkb.resource_id=rv.resource_id WHERE pr.id=? AND rkb.knowledge_base_id=?").get(processingRunId, knowledgeBaseId)) {
      ctx.fail(res, 404, ctx.error("NOT_FOUND", "Processing run not found in this knowledge base"), requestId);
      return true;
    }
    const scope = `
      WITH scope(id) AS (VALUES (?)),
      kb_spaces AS (SELECT id FROM spaces WHERE knowledge_base_id=(SELECT id FROM scope)),
      kb_tags AS (SELECT id FROM tags WHERE knowledge_base_id=(SELECT id FROM scope)),
      kb_resources AS (SELECT r.id FROM resources r JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id WHERE rkb.knowledge_base_id=(SELECT id FROM scope)),
      kb_versions AS (SELECT rv.id FROM resource_versions rv WHERE rv.resource_id IN (SELECT id FROM kb_resources)),
      kb_runs AS (SELECT pr.id FROM processing_runs pr WHERE pr.resource_version_id IN (SELECT id FROM kb_versions)),
      kb_tasks AS (SELECT t.id,t.type FROM tasks t WHERE t.resource_version_id IN (SELECT id FROM kb_versions) OR t.processing_run_id IN (SELECT id FROM kb_runs)),
      kb_pages AS (SELECT id FROM wiki_pages WHERE knowledge_base_id=(SELECT id FROM scope)),
      kb_page_versions AS (SELECT id FROM wiki_page_versions WHERE page_id IN (SELECT id FROM kb_pages)),
      kb_citations AS (SELECT id FROM wiki_citations WHERE page_version_id IN (SELECT id FROM kb_page_versions)),
      kb_templates AS (SELECT id FROM wiki_templates WHERE knowledge_base_id=(SELECT id FROM scope))
    `;
    const filters = [`(
      (al.entity_type='knowledge_base' AND al.entity_id=(SELECT id FROM scope))
      OR (al.entity_type='space' AND al.entity_id IN (SELECT id FROM kb_spaces))
      OR (al.entity_type='tag' AND al.entity_id IN (SELECT id FROM kb_tags))
      OR (al.entity_type='resource' AND al.entity_id IN (SELECT id FROM kb_resources))
      OR (al.entity_type='resource_version' AND al.entity_id IN (SELECT id FROM kb_versions))
      OR (al.entity_type='processing_run' AND al.entity_id IN (SELECT id FROM kb_runs))
      OR (al.entity_type='task' AND al.entity_id IN (SELECT id FROM kb_tasks))
      OR (al.entity_type='wiki_page' AND al.entity_id IN (SELECT id FROM kb_pages))
      OR (al.entity_type='wiki_page_version' AND al.entity_id IN (SELECT id FROM kb_page_versions))
      OR (al.entity_type='wiki_citation' AND al.entity_id IN (SELECT id FROM kb_citations))
      OR (al.entity_type='wiki_template' AND al.entity_id IN (SELECT id FROM kb_templates))
    )`,
    "NOT (al.entity_type='task' AND al.entity_id IN (SELECT id FROM kb_tasks WHERE type='retrieval:embed'))",
    "al.event_type NOT IN ('embedding_ready','embedding_failed')"
    ];
    const args = [knowledgeBaseId];
    if (eventType) { filters.push("al.event_type=?"); args.push(eventType); }
    if (resourceVersionId) { filters.push("(al.entity_id=? OR json_extract(al.metadata,'$.resourceVersionId')=?)"); args.push(resourceVersionId, resourceVersionId); }
    if (processingRunId) { filters.push("(al.entity_id=? OR json_extract(al.metadata,'$.processingRunId')=?)"); args.push(processingRunId, processingRunId); }
    const where = filters.join(" AND ");
    const total = sqlite.prepare(`${scope} SELECT count(*) AS total FROM audit_logs al WHERE ${where}`).get(...args).total;
    const rows = sqlite.prepare(`${scope} SELECT al.id,al.event_type,al.entity_type,al.entity_id,al.request_id,al.metadata,al.created_at FROM audit_logs al WHERE ${where} ORDER BY al.created_at DESC,al.id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
    const parseMetadata = (value) => { try { return redactAuditMetadata(JSON.parse(value || "{}")); } catch { return {}; } };
    ctx.ok(res, 200, { items: rows.map((event) => ({ id: event.id, eventType: event.event_type, entityType: event.entity_type, entityId: event.entity_id, requestId: event.request_id, metadata: parseMetadata(event.metadata), createdAt: event.created_at })), page, limit, total, pageCount: Math.ceil(total / limit) }, requestId);
    return true;
  }

  const spaceMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/spaces$/);
  if (spaceMatch && method === "GET") {
    ctx.ok(res, 200, db.select().from(spaces).where(eq(spaces.knowledgeBaseId, spaceMatch[1])).all(), requestId);
    return true;
  }
  if (spaceMatch && method === "POST") {
    if (!ctx.validKb(spaceMatch[1])) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const result = ctx.collection(body, { knowledgeBaseId: spaceMatch[1], status: "active" });
    if (result.error) { ctx.fail(res, 400, result.error, requestId); return true; }
    db.insert(spaces).values(result.value).run();
    ctx.ok(res, 201, result.value, requestId);
    return true;
  }

  const tagMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/tags$/);
  if (tagMatch && method === "GET") {
    ctx.ok(res, 200, db.select().from(tags).where(eq(tags.knowledgeBaseId, tagMatch[1])).all(), requestId);
    return true;
  }
  if (tagMatch && method === "POST") {
    if (!ctx.validKb(tagMatch[1])) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const result = ctx.collection(body, { knowledgeBaseId: tagMatch[1] });
    if (result.error) { ctx.fail(res, 400, result.error, requestId); return true; }
    db.insert(tags).values(result.value).run();
    ctx.ok(res, 201, result.value, requestId);
    return true;
  }
  return false;
};
