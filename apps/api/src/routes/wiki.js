import crypto from "node:crypto";
import {
  WIKI_PAGE_TYPES,
  citationSourceBounds,
  defaultTemplateDefinition,
  diffMarkdown,
  externalWikiMode,
  normalizeCitationLocator,
  normalizeCanonicalText,
  normalizePageType,
  normalizeSlug,
  normalizeTemplateDefinition,
  parseJsonObject,
  parseMarkdownBlocks,
  queueEmbeddingTask,
  readBytes,
  updateWikiSearchProjection,
  utf8ByteLength,
  sha256,
  slugFromTitle,
  templateMarkdown,
  wikiLinksFromMarkdown
} from "@myknow/db";

const SYSTEM_TYPES = new Set(["index", "log"]);
const MAX_MARKDOWN = 2 * 1024 * 1024;
const fail = (message, code = "VALIDATION_ERROR") => Object.assign(new Error(message), { code });
const parseStored = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const isoNow = (ctx) => ctx.now();

const queuePageEmbedding = (ctx, pageId, pageVersionId, requestId, reason) => {
  if (ctx.config.retrievalVectorEnabled === false) return null;
  const task = queueEmbeddingTask(ctx.sqlite, { ownerType: "wiki_page", ownerId: pageId, pageVersionId, reason });
  if (task?.id) ctx.audit("queued", "task", task.id, requestId, { type: "retrieval:embed", ownerType: "wiki_page", ownerId: pageId, pageVersionId });
  return task;
};

const ensureTemplates = (sqlite, knowledgeBaseId) => sqlite.transaction(() => {
  const timestamp = new Date().toISOString();
  for (const pageType of WIKI_PAGE_TYPES) {
    let template = sqlite.prepare("SELECT * FROM wiki_templates WHERE knowledge_base_id=? AND page_type=?").get(knowledgeBaseId, pageType);
    if (template) continue;
    const templateId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const definition = defaultTemplateDefinition(pageType);
    sqlite.prepare("INSERT INTO wiki_templates (id,knowledge_base_id,page_type,current_version_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run(templateId, knowledgeBaseId, pageType, timestamp, timestamp);
    sqlite.prepare("INSERT INTO wiki_template_versions (id,template_id,definition_json,created_at) VALUES (?,?,?,?)").run(versionId, templateId, JSON.stringify(definition), timestamp);
    sqlite.prepare("UPDATE wiki_templates SET current_version_id=? WHERE id=?").run(versionId, templateId);
  }
})();

const ensureSystemPages = (sqlite, knowledgeBaseId) => sqlite.transaction(() => {
  const timestamp = new Date().toISOString();
  const pages = [
    ["index", "Wiki overview", "index"],
    ["log", "System log", "log"]
  ];
  for (const [slug, title, pageType] of pages) {
    sqlite.prepare("INSERT OR IGNORE INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'system',NULL,?,?)").run(crypto.randomUUID(), knowledgeBaseId, null, null, slug, title, pageType, timestamp, timestamp);
  }
})();

const ensureWiki = (sqlite, knowledgeBaseId) => {
  ensureTemplates(sqlite, knowledgeBaseId);
  ensureSystemPages(sqlite, knowledgeBaseId);
};

const templateView = (sqlite, row) => {
  const current = row.current_version_id ? sqlite.prepare("SELECT * FROM wiki_template_versions WHERE id=?").get(row.current_version_id) : null;
  const versions = sqlite.prepare("SELECT * FROM wiki_template_versions WHERE template_id=? ORDER BY created_at DESC,id DESC").all(row.id);
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    pageType: row.page_type,
    currentVersionId: row.current_version_id,
    definition: parseStored(current?.definition_json, { sections: [] }),
    versions: versions.map((version) => ({ id: version.id, createdAt: version.created_at, definition: parseStored(version.definition_json, { sections: [] }) })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const citationView = (sqlite, row) => {
  const locator = parseStored(row.locator_json, {});
  const resource = sqlite.prepare("SELECT r.id,r.name,r.current_version_id,rv.id AS version_id,rv.content_sha256,rv.mime_type,rv.byte_size,rv.title FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.id=?").get(row.resource_version_id);
  return {
    id: row.id,
    pageVersionId: row.page_version_id,
    blockKey: row.block_key,
    resourceVersionId: row.resource_version_id,
    locator,
    status: row.status,
    staleReason: row.stale_reason,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    source: resource ? {
      resourceId: resource.id,
      resourceName: resource.name,
      resourceVersionId: resource.version_id,
      title: resource.title,
      mimeType: resource.mime_type,
      byteSize: resource.byte_size,
      contentSha256: resource.content_sha256,
      currentVersionId: resource.current_version_id,
      downloadPath: `/api/resources/${resource.id}/versions/${resource.version_id}/download`,
      previewPath: `/api/wiki/citations/${row.id}/preview`
    } : null
  };
};

const pageCitationView = (sqlite, row) => {
  const source = sqlite.prepare("SELECT p.id AS page_id,p.title,p.slug,p.page_type,v.id AS version_id,v.content_sha256,v.created_at FROM wiki_page_versions v JOIN wiki_pages p ON p.id=v.page_id WHERE v.id=?").get(row.source_page_version_id);
  return {
    id: row.id,
    sourceType: "wiki_page",
    pageVersionId: row.page_version_id,
    blockKey: row.block_key,
    sourcePageVersionId: row.source_page_version_id,
    sourceBlockKey: row.source_block_key,
    status: row.status,
    staleReason: row.stale_reason,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    source: source ? { pageId: source.page_id, title: source.title, slug: source.slug, pageType: source.page_type, pageVersionId: source.version_id, contentSha256: source.content_sha256 } : null
  };
};

const pageSummary = (sqlite, row) => {
  const version = row.current_version_id && sqlite.prepare("SELECT id,content_sha256,template_version_id,change_summary,created_at FROM wiki_page_versions WHERE id=?").get(row.current_version_id);
  const citationCount = version ? sqlite.prepare("SELECT (SELECT count(*) FROM wiki_citations WHERE page_version_id=?) + (SELECT count(*) FROM wiki_page_citations WHERE page_version_id=?) AS count").get(version.id, version.id).count : 0;
  const pendingCitationCount = version ? sqlite.prepare("SELECT (SELECT count(*) FROM wiki_citations WHERE page_version_id=? AND status IN ('needs_review','broken')) + (SELECT count(*) FROM wiki_page_citations WHERE page_version_id=? AND status IN ('needs_review','broken')) AS count").get(version.id, version.id).count : 0;
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    spaceId: row.space_id,
    parentPageId: row.parent_page_id,
    slug: row.slug,
    title: row.title,
    pageType: row.page_type,
    status: row.status,
    system: SYSTEM_TYPES.has(row.page_type),
    currentVersionId: row.current_version_id,
    currentVersion: version ? { id: version.id, contentSha256: version.content_sha256, templateVersionId: version.template_version_id, changeSummary: version.change_summary, createdAt: version.created_at } : null,
    citationCount,
    pendingCitationCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const versionView = (sqlite, row, { includeContent = true, compareVersion = null } = {}) => {
  const blocks = sqlite.prepare("SELECT * FROM wiki_page_blocks WHERE page_version_id=? ORDER BY ordinal,id").all(row.id);
  const citations = sqlite.prepare("SELECT * FROM wiki_citations WHERE page_version_id=? ORDER BY created_at,id").all(row.id);
  const pageCitations = sqlite.prepare("SELECT * FROM wiki_page_citations WHERE page_version_id=? ORDER BY created_at,id").all(row.id);
  const result = {
    id: row.id,
    pageId: row.page_id,
    parentVersionId: row.parent_version_id,
    templateVersionId: row.template_version_id,
    contentSha256: row.content_sha256,
    changeSummary: row.change_summary,
    restoreOfVersionId: row.restore_of_version_id,
    createdAt: row.created_at,
    links: wikiLinksFromMarkdown(row.content_markdown),
    blocks: blocks.map((block) => ({ id: block.id, blockKey: block.block_key, blockType: block.block_type, ordinal: block.ordinal, headingPath: parseStored(block.heading_path, []), contentMarkdown: block.content_markdown, contentSha256: block.content_sha256 })),
    citations: [...citations.map((citation) => citationView(sqlite, citation)), ...pageCitations.map((citation) => pageCitationView(sqlite, citation))]
  };
  if (includeContent) result.contentMarkdown = row.content_markdown;
  if (compareVersion) result.diff = diffMarkdown(compareVersion.content_markdown, row.content_markdown);
  return result;
};

const pageDetail = (sqlite, row, { compareVersion = null } = {}) => ({
  ...pageSummary(sqlite, row),
  currentVersion: row.current_version_id ? versionView(sqlite, sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=?").get(row.current_version_id), { compareVersion }) : null
});

const kb = (ctx, id) => ctx.sqlite.prepare("SELECT * FROM knowledge_bases WHERE id=? AND status='active'").get(id);
const spaceFor = (sqlite, knowledgeBaseId, spaceId) => !spaceId || sqlite.prepare("SELECT id FROM spaces WHERE id=? AND knowledge_base_id=? AND status='active'").get(spaceId, knowledgeBaseId);
const pageFor = (sqlite, id) => sqlite.prepare("SELECT * FROM wiki_pages WHERE id=?").get(id);

const assertParent = (sqlite, knowledgeBaseId, pageId, parentPageId) => {
  if (!parentPageId) return null;
  const parent = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND knowledge_base_id=? AND status <> 'archived'").get(parentPageId, knowledgeBaseId);
  if (!parent) throw fail("parent page not found", "NOT_FOUND");
  const seen = new Set([pageId].filter(Boolean));
  let cursor = parent;
  while (cursor) {
    if (seen.has(cursor.id)) throw fail("page parent would create a cycle", "WIKI_PAGE_CYCLE");
    seen.add(cursor.id);
    cursor = cursor.parent_page_id ? sqlite.prepare("SELECT id,parent_page_id FROM wiki_pages WHERE id=?").get(cursor.parent_page_id) : null;
  }
  return parent.id;
};

const assertSlugAvailable = (sqlite, knowledgeBaseId, slug, pageId = null) => {
  const found = sqlite.prepare("SELECT id FROM wiki_pages WHERE knowledge_base_id=? AND slug=? AND id<>?").get(knowledgeBaseId, slug, pageId || "");
  if (found) throw fail("slug is already used in this knowledge base", "DUPLICATE_NAME");
};

const resourceVersionForCitation = (sqlite, knowledgeBaseId, resourceVersionId) => sqlite.prepare("SELECT rv.*,r.name AS resource_name,r.current_version_id,r.id AS resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id WHERE rv.id=? AND rkb.knowledge_base_id=?").get(resourceVersionId, knowledgeBaseId);

const citationInput = (sqlite, knowledgeBaseId, pageVersionId, input, blockKeys, resourceStorageDir) => {
  if (!input || typeof input !== "object") throw fail("citations must be objects");
  const resourceVersionId = input.resourceVersionId || input.resource_version_id;
  if (typeof resourceVersionId !== "string" || !resourceVersionId) throw fail("citation resourceVersionId is required", "WIKI_CITATION_INVALID");
  const resourceVersion = resourceVersionForCitation(sqlite, knowledgeBaseId, resourceVersionId);
  if (!resourceVersion) throw fail("citation resource version was not found in this knowledge base", "WIKI_CITATION_INVALID");
  const blockKey = input.blockKey ?? input.block_key ?? null;
  if (blockKey !== null && (typeof blockKey !== "string" || !blockKeys.has(blockKey))) throw fail("citation blockKey does not exist in this page version", "WIKI_CITATION_INVALID");
  const bounds = citationSourceBounds({ sqlite, resourceVersion, resourceStorageDir });
  if (bounds.sourceIntegrity === "invalid") throw fail("citation source integrity check failed", "WIKI_CITATION_INVALID");
  let locator;
  try { locator = normalizeCitationLocator(input.locator ?? input.locatorJson ?? input.locator_json, bounds); }
  catch (caught) { throw fail(caught.message, "WIKI_CITATION_INVALID"); }
  return { resourceVersion, blockKey, locator };
};

const insertCitation = (sqlite, citation, pageVersionId, timestamp) => {
  const id = crypto.randomUUID();
  sqlite.prepare("INSERT INTO wiki_citations (id,page_version_id,block_key,resource_version_id,locator_json,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,'active',NULL,?,?)").run(id, pageVersionId, citation.blockKey, citation.resourceVersion.id, JSON.stringify(citation.locator), timestamp, timestamp);
  return id;
};

const insertCitations = (sqlite, knowledgeBaseId, pageVersionId, citations, blocks, timestamp, resourceStorageDir) => {
  const blockKeys = new Set(blocks.map((block) => block.blockKey));
  for (const input of citations) {
    insertCitation(sqlite, citationInput(sqlite, knowledgeBaseId, pageVersionId, input, blockKeys, resourceStorageDir), pageVersionId, timestamp);
  }
};

const copyCitations = (sqlite, fromVersionId, toVersionId, timestamp) => {
  if (!fromVersionId) return;
  for (const citation of sqlite.prepare("SELECT * FROM wiki_citations WHERE page_version_id=? ORDER BY created_at,id").all(fromVersionId)) {
    sqlite.prepare("INSERT INTO wiki_citations (id,page_version_id,block_key,resource_version_id,locator_json,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), toVersionId, citation.block_key, citation.resource_version_id, citation.locator_json, citation.status, citation.stale_reason, citation.checked_at || timestamp, timestamp);
  }
  for (const citation of sqlite.prepare("SELECT * FROM wiki_page_citations WHERE page_version_id=? ORDER BY created_at,id").all(fromVersionId)) {
    sqlite.prepare("INSERT INTO wiki_page_citations (id,page_version_id,block_key,source_page_version_id,source_block_key,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), toVersionId, citation.block_key, citation.source_page_version_id, citation.source_block_key, citation.status, citation.stale_reason, citation.checked_at || timestamp, timestamp);
  }
};

const insertPageVersion = (ctx, page, { contentMarkdown, baseVersionId, changeSummary = null, restoreOfVersionId = null, citations = undefined, requestId }) => {
  if (typeof contentMarkdown !== "string" || utf8ByteLength(contentMarkdown) > MAX_MARKDOWN) throw fail("contentMarkdown must be a UTF-8 string up to 2 MiB");
  if (citations !== undefined && !Array.isArray(citations)) throw fail("citations must be an array", "WIKI_CITATION_INVALID");
  if (typeof baseVersionId !== "string" || !baseVersionId) throw fail("baseVersionId is required");
  const current = page.current_version_id ? ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=?").get(page.current_version_id) : null;
  if (baseVersionId !== page.current_version_id) throw fail("page has changed since it was loaded", "WIKI_VERSION_CONFLICT");
  const timestamp = isoNow(ctx);
  const blocks = parseMarkdownBlocks(contentMarkdown);
  const versionId = crypto.randomUUID();
  let result;
  ctx.sqlite.transaction(() => {
    sqliteInsertVersion(ctx.sqlite, versionId, page.id, current?.id || null, current?.template_version_id || null, contentMarkdown, changeSummary, restoreOfVersionId, timestamp);
    for (const block of blocks) ctx.sqlite.prepare("INSERT INTO wiki_page_blocks (id,page_version_id,block_key,block_type,ordinal,heading_path,content_markdown,content_sha256) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), versionId, block.blockKey, block.blockType, block.ordinal, JSON.stringify(block.headingPath), block.contentMarkdown, block.contentSha256);
    if (citations === undefined) copyCitations(ctx.sqlite, current?.id, versionId, timestamp);
    else insertCitations(ctx.sqlite, page.knowledge_base_id, versionId, citations, blocks, timestamp, ctx.config.resourceStorageDir);
    ctx.sqlite.prepare("UPDATE wiki_pages SET current_version_id=?,updated_at=? WHERE id=?").run(versionId, timestamp, page.id);
    updateWikiSearchProjection(ctx.sqlite, page.id);
    queuePageEmbedding(ctx, page.id, versionId, requestId, restoreOfVersionId ? "wiki-page-restored" : "wiki-page-version-created");
    ctx.audit(restoreOfVersionId ? "restored" : "version_created", "wiki_page_version", versionId, requestId, { pageId: page.id, restoreOfVersionId, blockCount: blocks.length });
    result = ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=?").get(versionId);
  })();
  return result;
};

const sqliteInsertVersion = (sqlite, versionId, pageId, parentVersionId, templateVersionId, contentMarkdown, changeSummary, restoreOfVersionId, timestamp) => sqlite.prepare("INSERT INTO wiki_page_versions (id,page_id,parent_version_id,template_version_id,content_markdown,content_sha256,change_summary,restore_of_version_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(versionId, pageId, parentVersionId, templateVersionId, contentMarkdown, sha256(contentMarkdown), changeSummary, restoreOfVersionId, timestamp);

const pageTree = (sqlite, rows) => {
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parent_page_id || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(pageSummary(sqlite, row));
  }
  const build = (parentId, ancestors = new Set()) => (byParent.get(parentId) || []).map((node) => {
    if (ancestors.has(node.id)) return { ...node, children: [] };
    const next = new Set(ancestors).add(node.id);
    return { ...node, children: build(node.id, next) };
  });
  return build(null);
};

const overview = (ctx, knowledgeBaseId) => {
  ensureWiki(ctx.sqlite, knowledgeBaseId);
  const base = kb(ctx, knowledgeBaseId);
  const rows = ctx.sqlite.prepare("SELECT * FROM wiki_pages WHERE knowledge_base_id=? AND status <> 'archived' ORDER BY CASE page_type WHEN 'index' THEN 0 WHEN 'log' THEN 1 ELSE 2 END, title, id").all(knowledgeBaseId);
  const normalPages = rows.filter((row) => !SYSTEM_TYPES.has(row.page_type));
  const pending = ctx.sqlite.prepare("SELECT (SELECT count(*) FROM wiki_citations c JOIN wiki_page_versions v ON v.id=c.page_version_id JOIN wiki_pages p ON p.id=v.page_id WHERE p.knowledge_base_id=? AND c.status IN ('needs_review','broken')) + (SELECT count(*) FROM wiki_page_citations c JOIN wiki_page_versions v ON v.id=c.page_version_id JOIN wiki_pages p ON p.id=v.page_id WHERE p.knowledge_base_id=? AND c.status IN ('needs_review','broken')) AS count").get(knowledgeBaseId, knowledgeBaseId).count;
  const candidates = ctx.sqlite.prepare("SELECT DISTINCT r.id,r.name,r.status,r.current_version_id,r.wiki_mode,CASE WHEN r.wiki_mode IS NULL THEN kb.wiki_default_mode ELSE r.wiki_mode END AS effective_mode FROM resources r JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id JOIN knowledge_bases kb ON kb.id=rkb.knowledge_base_id WHERE rkb.knowledge_base_id=? AND r.status <> 'archived' AND COALESCE(r.wiki_mode,kb.wiki_default_mode)='enabled' ORDER BY r.updated_at DESC,r.id DESC").all(knowledgeBaseId).map((row) => ({ ...row, wikiMode: externalWikiMode(row.effective_mode) }));
  const events = ctx.sqlite.prepare(`
    WITH scope(id) AS (VALUES (?)),
    kb_spaces AS (SELECT id FROM spaces WHERE knowledge_base_id=(SELECT id FROM scope)),
    kb_tags AS (SELECT id FROM tags WHERE knowledge_base_id=(SELECT id FROM scope)),
    kb_resources AS (SELECT r.id FROM resources r JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id WHERE rkb.knowledge_base_id=(SELECT id FROM scope)),
    kb_versions AS (SELECT rv.id FROM resource_versions rv WHERE rv.resource_id IN (SELECT id FROM kb_resources)),
    kb_runs AS (SELECT pr.id FROM processing_runs pr WHERE pr.resource_version_id IN (SELECT id FROM kb_versions)),
    kb_tasks AS (SELECT t.id FROM tasks t WHERE t.resource_version_id IN (SELECT id FROM kb_versions)),
    kb_pages AS (SELECT id FROM wiki_pages WHERE knowledge_base_id=(SELECT id FROM scope)),
    kb_page_versions AS (SELECT id FROM wiki_page_versions WHERE page_id IN (SELECT id FROM kb_pages)),
    kb_citations AS (SELECT id FROM wiki_citations WHERE page_version_id IN (SELECT id FROM kb_page_versions)),
    kb_templates AS (SELECT id FROM wiki_templates WHERE knowledge_base_id=(SELECT id FROM scope))
    SELECT id,event_type,entity_type,entity_id,metadata,created_at
    FROM audit_logs
    WHERE (entity_type='knowledge_base' AND entity_id=(SELECT id FROM scope))
      OR (entity_type='space' AND entity_id IN (SELECT id FROM kb_spaces))
      OR (entity_type='tag' AND entity_id IN (SELECT id FROM kb_tags))
      OR (entity_type='resource' AND entity_id IN (SELECT id FROM kb_resources))
      OR (entity_type='resource_version' AND entity_id IN (SELECT id FROM kb_versions))
      OR (entity_type='processing_run' AND entity_id IN (SELECT id FROM kb_runs))
      OR (entity_type='task' AND entity_id IN (SELECT id FROM kb_tasks))
      OR (entity_type='wiki_page' AND entity_id IN (SELECT id FROM kb_pages))
      OR (entity_type='wiki_page_version' AND entity_id IN (SELECT id FROM kb_page_versions))
      OR (entity_type='wiki_citation' AND entity_id IN (SELECT id FROM kb_citations))
      OR (entity_type='wiki_template' AND entity_id IN (SELECT id FROM kb_templates))
    ORDER BY created_at DESC,id DESC LIMIT 100
  `).all(knowledgeBaseId).map((event) => ({ ...event, metadata: parseStored(event.metadata, {}) }));
  return {
    knowledgeBaseId,
    defaultPath: "index/overview",
    entry: { pageType: "index", slug: "index", path: "index/overview", title: "Wiki overview" },
    log: { pageType: "log", slug: "log", path: "log", title: "System log", events },
    pages: pageTree(ctx.sqlite, rows),
    pageCount: normalPages.length,
    pendingCitationCount: pending,
    empty: normalPages.length === 0,
    candidates,
    knowledgeBase: { id: base.id, name: base.name, wikiDefaultMode: externalWikiMode(base.wiki_default_mode) }
  };
};

const impactRows = (ctx, knowledgeBaseId) => ctx.sqlite.prepare("SELECT c.*,p.id AS page_id,p.slug,p.title,p.page_type,v.created_at AS page_version_created_at,r.id AS resource_id,r.name AS resource_name FROM wiki_citations c JOIN wiki_page_versions v ON v.id=c.page_version_id JOIN wiki_pages p ON p.id=v.page_id JOIN resource_versions rv ON rv.id=c.resource_version_id JOIN resources r ON r.id=rv.resource_id WHERE p.knowledge_base_id=? AND c.status IN ('needs_review','broken') ORDER BY CASE c.status WHEN 'broken' THEN 0 ELSE 1 END,c.checked_at DESC,c.id").all(knowledgeBaseId).map((row) => ({
  citationId: row.id,
  page: { id: row.page_id, slug: row.slug, title: row.title, pageType: row.page_type, versionId: row.page_version_id },
  resource: { id: row.resource_id, name: row.resource_name, versionId: row.resource_version_id },
  status: row.status,
  staleReason: row.stale_reason,
  checkedAt: row.checked_at
}));

export const handleWikiRoutes = async ({ ctx, request }) => {
  const { pathname, method, parsed, body, requestId, res } = request;

  const wikiMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/wiki$/);
  if (wikiMatch && method === "GET") {
    if (!kb(ctx, wikiMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    ctx.json(res, 200, overview(ctx, wikiMatch[1]), null, requestId);
    return true;
  }

  const pagesMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/wiki\/pages$/);
  if (pagesMatch && method === "GET") {
    const knowledgeBaseId = pagesMatch[1];
    if (!kb(ctx, knowledgeBaseId)) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    ensureWiki(ctx.sqlite, knowledgeBaseId);
    const page = Number(parsed.searchParams.get("page") || 1);
    const limit = Number(parsed.searchParams.get("limit") || 50);
    const spaceId = parsed.searchParams.get("spaceId");
    const pageType = parsed.searchParams.get("pageType");
    const status = parsed.searchParams.get("status") || "active";
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (pageType && ![...WIKI_PAGE_TYPES, ...SYSTEM_TYPES].includes(pageType)) || !["active", "archived", "system", "all"].includes(status)) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "page/limit/pageType/status is invalid"), requestId); return true; }
    const clauses = ["knowledge_base_id=?"];
    const args = [knowledgeBaseId];
    if (spaceId) { clauses.push("space_id=?"); args.push(spaceId); }
    if (pageType) { clauses.push("page_type=?"); args.push(pageType); }
    if (status !== "all") { clauses.push("status=?"); args.push(status); }
    const total = ctx.sqlite.prepare(`SELECT count(*) AS count FROM wiki_pages WHERE ${clauses.join(" AND ")}`).get(...args).count;
    const rows = ctx.sqlite.prepare(`SELECT * FROM wiki_pages WHERE ${clauses.join(" AND ")} ORDER BY CASE page_type WHEN 'index' THEN 0 WHEN 'log' THEN 1 ELSE 2 END,title,id LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
    ctx.json(res, 200, { items: rows.map((row) => pageSummary(ctx.sqlite, row)), page, limit, total }, null, requestId);
    return true;
  }

  if (pagesMatch && method === "POST") {
    const knowledgeBaseId = pagesMatch[1];
    if (!kb(ctx, knowledgeBaseId)) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    let pageType;
    try { pageType = normalizePageType(body?.pageType || body?.page_type); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "title must be 1-200 characters"), requestId); return true; }
    const id = crypto.randomUUID();
    let slug;
    try { slug = body?.slug === undefined ? slugFromTitle(title, id.slice(0, 8)) : normalizeSlug(body.slug); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    const spaceId = body?.spaceId ?? body?.space_id ?? null;
    if (!spaceFor(ctx.sqlite, knowledgeBaseId, spaceId)) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Space not found"), requestId); return true; }
    let parentPageId;
    try { parentPageId = assertParent(ctx.sqlite, knowledgeBaseId, id, body?.parentPageId ?? body?.parent_page_id ?? null); }
    catch (caught) { ctx.json(res, caught.code === "WIKI_PAGE_CYCLE" ? 409 : 404, null, ctx.error(caught.code, caught.message), requestId); return true; }
    try { assertSlugAvailable(ctx.sqlite, knowledgeBaseId, slug); }
    catch (caught) { ctx.json(res, 409, null, ctx.error(caught.code, caught.message), requestId); return true; }
    ensureWiki(ctx.sqlite, knowledgeBaseId);
    const template = ctx.sqlite.prepare("SELECT t.*,tv.definition_json FROM wiki_templates t JOIN wiki_template_versions tv ON tv.id=t.current_version_id WHERE t.knowledge_base_id=? AND t.page_type=?").get(knowledgeBaseId, pageType);
    if (!template) { ctx.json(res, 500, null, ctx.error("INTERNAL_ERROR", "default wiki template is missing"), requestId); return true; }
    const definition = parseStored(template.definition_json, defaultTemplateDefinition(pageType));
    const contentMarkdown = body?.contentMarkdown ?? body?.content_markdown ?? templateMarkdown(title, definition);
    if (typeof contentMarkdown !== "string" || utf8ByteLength(contentMarkdown) > MAX_MARKDOWN) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "contentMarkdown must be a UTF-8 string up to 2 MiB"), requestId); return true; }
    const timestamp = isoNow(ctx);
    const versionId = crypto.randomUUID();
    const blocks = parseMarkdownBlocks(contentMarkdown);
    if (Object.hasOwn(body || {}, "citations") && !Array.isArray(body.citations)) { ctx.json(res, 400, null, ctx.error("WIKI_CITATION_INVALID", "citations must be an array"), requestId); return true; }
    try {
      ctx.sqlite.transaction(() => {
        ctx.sqlite.prepare("INSERT INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)").run(id, knowledgeBaseId, spaceId, parentPageId, slug, title, pageType, timestamp, timestamp);
        sqliteInsertVersion(ctx.sqlite, versionId, id, null, template.current_version_id, contentMarkdown, "Initial page", null, timestamp);
        for (const block of blocks) ctx.sqlite.prepare("INSERT INTO wiki_page_blocks (id,page_version_id,block_key,block_type,ordinal,heading_path,content_markdown,content_sha256) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), versionId, block.blockKey, block.blockType, block.ordinal, JSON.stringify(block.headingPath), block.contentMarkdown, block.contentSha256);
        const page = { id, knowledge_base_id: knowledgeBaseId };
        if (Array.isArray(body?.citations)) insertCitations(ctx.sqlite, knowledgeBaseId, versionId, body.citations, blocks, timestamp, ctx.config.resourceStorageDir);
        ctx.sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(versionId, id);
        updateWikiSearchProjection(ctx.sqlite, id);
        queuePageEmbedding(ctx, id, versionId, requestId, "wiki-page-created");
        ctx.audit("created", "wiki_page", id, requestId, { pageType, templateVersionId: template.current_version_id });
        page.current_version_id = versionId;
      })();
    } catch (caught) {
      if (caught.code === "WIKI_CITATION_INVALID") { ctx.json(res, 400, null, ctx.error(caught.code, caught.message), requestId); return true; }
      throw caught;
    }
    ctx.json(res, 201, pageDetail(ctx.sqlite, ctx.sqlite.prepare("SELECT * FROM wiki_pages WHERE id=?").get(id)), null, requestId);
    return true;
  }

  const impactsMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/wiki\/impacts$/);
  if (impactsMatch && method === "GET") {
    if (!kb(ctx, impactsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const items = impactRows(ctx, impactsMatch[1]);
    ctx.json(res, 200, { items, count: items.length }, null, requestId);
    return true;
  }

  const templatesMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/wiki\/templates$/);
  if (templatesMatch && (method === "GET" || method === "POST")) {
    const knowledgeBaseId = templatesMatch[1];
    if (!kb(ctx, knowledgeBaseId)) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    ensureWiki(ctx.sqlite, knowledgeBaseId);
    if (method === "GET") {
      ctx.json(res, 200, ctx.sqlite.prepare("SELECT * FROM wiki_templates WHERE knowledge_base_id=? ORDER BY page_type").all(knowledgeBaseId).map((row) => templateView(ctx.sqlite, row)), null, requestId);
      return true;
    }
    let pageType;
    try { pageType = normalizePageType(body?.pageType || body?.page_type); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    let definition;
    try { definition = normalizeTemplateDefinition(body?.definition, pageType); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    const template = ctx.sqlite.prepare("SELECT * FROM wiki_templates WHERE knowledge_base_id=? AND page_type=?").get(knowledgeBaseId, pageType);
    const timestamp = isoNow(ctx);
    const versionId = crypto.randomUUID();
    ctx.sqlite.transaction(() => {
      ctx.sqlite.prepare("INSERT INTO wiki_template_versions (id,template_id,definition_json,created_at) VALUES (?,?,?,?)").run(versionId, template.id, JSON.stringify(definition), timestamp);
      ctx.sqlite.prepare("UPDATE wiki_templates SET current_version_id=?,updated_at=? WHERE id=?").run(versionId, timestamp, template.id);
      ctx.audit("updated", "wiki_template", template.id, requestId, { pageType, templateVersionId: versionId });
    })();
    ctx.json(res, 201, templateView(ctx.sqlite, ctx.sqlite.prepare("SELECT * FROM wiki_templates WHERE id=?").get(template.id)), null, requestId);
    return true;
  }

  const pageMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)$/);
  if (pageMatch && (method === "GET" || method === "PATCH")) {
    const page = pageFor(ctx.sqlite, pageMatch[1]);
    if (!page) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki page not found"), requestId); return true; }
    if (method === "GET") {
      const compareId = parsed.searchParams.get("compareVersionId");
      const compare = compareId ? ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(compareId, page.id) : null;
      if (compareId && !compare) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Comparison version not found"), requestId); return true; }
      ctx.json(res, 200, pageDetail(ctx.sqlite, page, { compareVersion: compare }), null, requestId);
      return true;
    }
    if (SYSTEM_TYPES.has(page.page_type)) { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "System pages are read-only"), requestId); return true; }
    if (Object.hasOwn(body || {}, "contentMarkdown") || Object.hasOwn(body || {}, "content_markdown")) { ctx.json(res, 409, null, ctx.error("WIKI_PAGE_METADATA_ONLY", "Use the versions endpoint to edit page content"), requestId); return true; }
    const allowed = new Set(["title", "slug", "spaceId", "space_id", "parentPageId", "parent_page_id"]);
    if (Object.keys(body || {}).some((key) => !allowed.has(key))) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "only page metadata can be changed"), requestId); return true; }
    const title = body?.title === undefined ? page.title : typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "title must be 1-200 characters"), requestId); return true; }
    let slug;
    try { slug = body?.slug === undefined ? page.slug : normalizeSlug(body.slug); assertSlugAvailable(ctx.sqlite, page.knowledge_base_id, slug, page.id); }
    catch (caught) { ctx.json(res, caught.code === "DUPLICATE_NAME" ? 409 : 400, null, ctx.error(caught.code, caught.message), requestId); return true; }
    const spaceId = body?.spaceId ?? body?.space_id ?? page.space_id;
    if (!spaceFor(ctx.sqlite, page.knowledge_base_id, spaceId)) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Space not found"), requestId); return true; }
    let parentPageId;
    try { parentPageId = assertParent(ctx.sqlite, page.knowledge_base_id, page.id, body?.parentPageId === undefined && body?.parent_page_id === undefined ? page.parent_page_id : body.parentPageId ?? body.parent_page_id); }
    catch (caught) { ctx.json(res, caught.code === "WIKI_PAGE_CYCLE" ? 409 : 404, null, ctx.error(caught.code, caught.message), requestId); return true; }
    ctx.sqlite.transaction(() => {
      ctx.sqlite.prepare("UPDATE wiki_pages SET title=?,slug=?,space_id=?,parent_page_id=?,updated_at=? WHERE id=?").run(title, slug, spaceId, parentPageId, isoNow(ctx), page.id);
      updateWikiSearchProjection(ctx.sqlite, page.id);
      queuePageEmbedding(ctx, page.id, page.current_version_id, requestId, "wiki-page-metadata-updated");
      ctx.audit("updated", "wiki_page", page.id, requestId, { metadataOnly: true });
    })();
    ctx.json(res, 200, pageDetail(ctx.sqlite, pageFor(ctx.sqlite, page.id)), null, requestId);
    return true;
  }

  const versionsMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/versions$/);
  if (versionsMatch && (method === "GET" || method === "POST")) {
    const page = pageFor(ctx.sqlite, versionsMatch[1]);
    if (!page) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki page not found"), requestId); return true; }
    if (SYSTEM_TYPES.has(page.page_type)) { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "System pages are read-only"), requestId); return true; }
    if (method === "GET") {
      ctx.json(res, 200, ctx.sqlite.prepare("SELECT id,page_id,parent_version_id,template_version_id,content_sha256,change_summary,restore_of_version_id,created_at FROM wiki_page_versions WHERE page_id=? ORDER BY created_at DESC,id DESC").all(page.id).map((version) => ({ ...version, pageId: version.page_id, parentVersionId: version.parent_version_id, templateVersionId: version.template_version_id, contentSha256: version.content_sha256, changeSummary: version.change_summary, restoreOfVersionId: version.restore_of_version_id, createdAt: version.created_at })), null, requestId);
      return true;
    }
    const baseVersionId = body?.baseVersionId ?? body?.base_version_id;
    try {
      const version = insertPageVersion(ctx, page, { contentMarkdown: body?.contentMarkdown ?? body?.content_markdown, baseVersionId, changeSummary: body?.changeSummary ?? body?.change_summary ?? null, citations: body?.citations, requestId });
      ctx.json(res, 201, versionView(ctx.sqlite, version), null, requestId);
    } catch (caught) {
      if (["WIKI_VERSION_CONFLICT", "WIKI_CITATION_INVALID"].includes(caught.code)) { ctx.json(res, caught.code === "WIKI_VERSION_CONFLICT" ? 409 : 400, null, ctx.error(caught.code, caught.message), requestId); return true; }
      throw caught;
    }
    return true;
  }

  const versionMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch && method === "GET") {
    const page = pageFor(ctx.sqlite, versionMatch[1]);
    const version = page && ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(versionMatch[2], page.id);
    if (!version) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki version not found"), requestId); return true; }
    const compareId = parsed.searchParams.get("compareVersionId");
    const compare = compareId ? ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(compareId, page.id) : null;
    if (compareId && !compare) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Comparison version not found"), requestId); return true; }
    ctx.json(res, 200, versionView(ctx.sqlite, version, { compareVersion: compare }), null, requestId);
    return true;
  }

  const restoreMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") {
    const page = pageFor(ctx.sqlite, restoreMatch[1]);
    if (!page) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki page not found"), requestId); return true; }
    const sourceId = body?.versionId ?? body?.version_id;
    const source = ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(sourceId, page.id);
    if (!source) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Version to restore not found"), requestId); return true; }
    try {
      const version = insertPageVersion(ctx, page, { contentMarkdown: source.content_markdown, baseVersionId: body?.baseVersionId ?? body?.base_version_id, changeSummary: body?.changeSummary ?? `Restore version ${source.id}`, restoreOfVersionId: source.id, requestId });
      ctx.json(res, 201, versionView(ctx.sqlite, version), null, requestId);
    } catch (caught) {
      if (caught.code === "WIKI_VERSION_CONFLICT") { ctx.json(res, 409, null, ctx.error(caught.code, caught.message), requestId); return true; }
      throw caught;
    }
    return true;
  }

  const citationsMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/citations$/);
  if (citationsMatch && (method === "GET" || method === "POST")) {
    const page = pageFor(ctx.sqlite, citationsMatch[1]);
    if (!page?.current_version_id) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki page version not found"), requestId); return true; }
    if (method === "GET") {
      const versionId = parsed.searchParams.get("versionId") || page.current_version_id;
      const version = ctx.sqlite.prepare("SELECT id FROM wiki_page_versions WHERE id=? AND page_id=?").get(versionId, page.id);
      if (!version) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Wiki page version not found"), requestId); return true; }
      const resourceCitations = ctx.sqlite.prepare("SELECT * FROM wiki_citations WHERE page_version_id=? ORDER BY created_at,id").all(version.id).map((row) => citationView(ctx.sqlite, row));
      const pageCitations = ctx.sqlite.prepare("SELECT * FROM wiki_page_citations WHERE page_version_id=? ORDER BY created_at,id").all(version.id).map((row) => pageCitationView(ctx.sqlite, row));
      ctx.json(res, 200, [...resourceCitations, ...pageCitations], null, requestId);
      return true;
    }
    try {
      const version = ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(page.current_version_id, page.id);
      const blocks = ctx.sqlite.prepare("SELECT block_key AS blockKey FROM wiki_page_blocks WHERE page_version_id=?").all(version.id);
      const input = citationInput(ctx.sqlite, page.knowledge_base_id, version.id, body, new Set(blocks.map((block) => block.blockKey)), ctx.config.resourceStorageDir);
      const timestamp = isoNow(ctx);
      let id;
      ctx.sqlite.transaction(() => {
        id = insertCitation(ctx.sqlite, input, version.id, timestamp);
        ctx.audit("created", "wiki_citation", id, requestId, { pageVersionId: version.id, resourceVersionId: input.resourceVersion.id });
      })();
      ctx.json(res, 201, citationView(ctx.sqlite, ctx.sqlite.prepare("SELECT * FROM wiki_citations WHERE id=?").get(id)), null, requestId);
    } catch (caught) {
      if (caught.code === "WIKI_CITATION_INVALID") { ctx.json(res, 400, null, ctx.error(caught.code, caught.message), requestId); return true; }
      throw caught;
    }
    return true;
  }

  const diffMatch = pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/diff$/);
  if (diffMatch && method === "GET") {
    const page = pageFor(ctx.sqlite, diffMatch[1]);
    const fromId = parsed.searchParams.get("fromVersionId");
    const toId = parsed.searchParams.get("toVersionId") || page?.current_version_id;
    const from = page && ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(fromId, page.id);
    const to = page && ctx.sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(toId, page.id);
    if (!from || !to) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Diff version not found"), requestId); return true; }
    ctx.json(res, 200, { pageId: page.id, fromVersionId: from.id, toVersionId: to.id, diff: diffMarkdown(from.content_markdown, to.content_markdown) }, null, requestId);
    return true;
  }

  const citationMatch = pathname.match(/^\/api\/wiki\/citations\/([^/]+)$/);
  const citationPreviewMatch = pathname.match(/^\/api\/wiki\/citations\/([^/]+)\/preview$/);
  if (citationPreviewMatch && method === "GET") {
    const citation = ctx.sqlite.prepare("SELECT c.*,p.knowledge_base_id FROM wiki_citations c JOIN wiki_page_versions v ON v.id=c.page_version_id JOIN wiki_pages p ON p.id=v.page_id WHERE c.id=?").get(citationPreviewMatch[1]);
    if (!citation) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Citation not found"), requestId); return true; }
    const source = resourceVersionForCitation(ctx.sqlite, citation.knowledge_base_id, citation.resource_version_id);
    if (!source) { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", "Citation source is unavailable"), requestId); return true; }
    let bytes;
    try { bytes = readBytes(ctx.config.resourceStorageDir, source.storage_key); }
    catch { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", "Citation source is unavailable"), requestId); return true; }
    if (bytes.length !== source.byte_size || sha256(bytes) !== source.content_sha256) { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", "Citation source integrity check failed"), requestId); return true; }
    const sourceText = source.mime_type.startsWith("text/") ? normalizeCanonicalText(bytes.toString("utf8")) : null;
    const bounds = citationSourceBounds({ sqlite: ctx.sqlite, resourceVersion: source, resourceStorageDir: ctx.config.resourceStorageDir });
    let locator;
    try { locator = normalizeCitationLocator(citation.locator_json, bounds); }
    catch (caught) { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", caught.message), requestId); return true; }
    if (source.mime_type === "application/pdf" && (locator.startOffset !== undefined || locator.endOffset !== undefined) && bounds.canonicalIntegrity !== "valid") { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", "Citation canonical source is unavailable"), requestId); return true; }
    if (source.mime_type === "application/pdf" && [locator.page, locator.pageStart, locator.pageEnd, ...(locator.pages || [])].some((page) => page !== undefined) && bounds.pageCount === null) { ctx.json(res, 409, null, ctx.error("WIKI_CITATION_INVALID", "Citation source page count is unavailable"), requestId); return true; }
    let range = null;
    let snippet = null;
    if (sourceText !== null && locator.startOffset !== undefined) {
      const characters = Array.from(sourceText);
      const contextStart = Math.max(0, locator.startOffset - 160);
      const contextEnd = Math.min(characters.length, locator.endOffset + 160);
      range = { startOffset: locator.startOffset, endOffset: locator.endOffset, contextStart, contextEnd };
      snippet = characters.slice(contextStart, contextEnd).join("");
    }
    ctx.json(res, 200, { citationId: citation.id, resourceVersionId: source.id, locator, range, snippet, source: citationView(ctx.sqlite, citation).source }, null, requestId);
    return true;
  }
  if (citationMatch && method === "GET") {
    const citation = ctx.sqlite.prepare("SELECT * FROM wiki_citations WHERE id=?").get(citationMatch[1]);
    if (citation) { ctx.json(res, 200, citationView(ctx.sqlite, citation), null, requestId); return true; }
    const pageCitation = ctx.sqlite.prepare("SELECT * FROM wiki_page_citations WHERE id=?").get(citationMatch[1]);
    if (!pageCitation) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Citation not found"), requestId); return true; }
    ctx.json(res, 200, pageCitationView(ctx.sqlite, pageCitation), null, requestId);
    return true;
  }
  return false;
};
