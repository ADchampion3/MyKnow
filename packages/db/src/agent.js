import crypto from "node:crypto";
import { normalizeCanonicalText } from "./chunker.js";
import { executeRetrieval, getRetrievalRun, isUuid, queueEmbeddingTask, updateWikiSearchProjection } from "./retrieval.js";
import { now, readBytes, sha256 } from "./resources.js";
import {
  citationSourceBounds,
  defaultTemplateDefinition,
  diffMarkdown,
  normalizeCitationLocator,
  normalizePageType,
  normalizeSlug,
  parseMarkdownBlocks,
  slugFromTitle,
  wikiLinksFromMarkdown
} from "./wiki.js";

export const AGENT_SCOPE_VERSION = "scope-snapshot-v1";
export const AGENT_PROMPT_VERSION = "sprint5-agent-prompt-v2";
export const ANSWER_CONTRACT_VERSION = "agent-answer-v1";
export const PLAN_CONTRACT_VERSION = "agent-change-plan-tree-v1";
export const AGENT_ORGANIZATION_MODES = Object.freeze(["legacy", "tree"]);
export const AGENT_TREE_LIMITS = Object.freeze({ maxDepth: 4, maxPages: 50, maxChildren: 8 });
export const AGENT_READ_TOOL_NAMES = Object.freeze([
  "search_knowledge",
  "read_resource_version",
  "read_raw_chunk",
  "read_wiki_page",
  "read_retrieval_run",
  "list_wiki_citations"
]);
export const AGENT_TERMINAL_TOOL_NAMES = Object.freeze(["submit_answer", "submit_change_plan"]);
export const AGENT_PLAN_TYPES = Object.freeze(["page_create", "page_update", "tag_add", "duplicate_finding", "conflict_finding"]);

const MAX_PROMPT = 4000;
const MAX_MARKDOWN = 2 * 1024 * 1024;
const MAX_PLAN_ITEMS = 100;
const MAX_CITATIONS = 100;
const SYSTEM_PAGE_TYPES = new Set(["index", "log"]);
const fail = (message, code = "VALIDATION_ERROR") => Object.assign(new Error(message), { code });
const jsonParse = (value, fallback) => {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const text = (value, label, maximum) => {
  if (typeof value !== "string") throw fail(`${label} must be a string`, "AGENT_OUTPUT_INVALID");
  const result = value.trim();
  if (!result || result.length > maximum) throw fail(`${label} must be 1-${maximum} characters`, "AGENT_OUTPUT_INVALID");
  return result;
};
const optionalText = (value, label, maximum) => value === undefined || value === null ? null : text(value, label, maximum);
const idList = (value, label) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw fail(`${label} must contain at most 100 IDs`, "AGENT_SCOPE_INVALID");
  const result = [...new Set(value.map((item) => {
    if (!isUuid(item)) throw fail(`${label} contains an invalid UUID`, "AGENT_SCOPE_INVALID");
    return item.toLowerCase();
  }))];
  return result;
};
const first = (object, ...keys) => keys.map((key) => object?.[key]).find((value) => value !== undefined);
const bodyValue = (object, camel, snake) => first(object, camel, snake);
const normalizeOrganizationMode = (value) => {
  const mode = value === undefined || value === null || value === "" ? "legacy" : String(value).trim().toLowerCase();
  if (!AGENT_ORGANIZATION_MODES.includes(mode)) throw fail("organizationMode must be legacy or tree", "AGENT_SCOPE_INVALID");
  return mode;
};

export const normalizePrompt = (value) => {
  if (typeof value !== "string") throw fail("prompt must be a string", "VALIDATION_ERROR");
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT) throw fail(`prompt must be 1-${MAX_PROMPT} characters`, "VALIDATION_ERROR");
  return prompt;
};

const knowledgeBaseFor = (sqlite, id) => id && sqlite.prepare("SELECT * FROM knowledge_bases WHERE id=? AND status='active'").get(id);
const spaceFor = (sqlite, kbId, id) => !id ? null : sqlite.prepare("SELECT * FROM spaces WHERE id=? AND knowledge_base_id=? AND status='active'").get(id, kbId);
const resourceVersionFor = (sqlite, kbId, id) => sqlite.prepare("SELECT rv.*,r.name AS resource_name,r.current_version_id,r.id AS resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id WHERE rv.id=? AND rkb.knowledge_base_id=? AND r.status<>'archived'").get(id, kbId);
const pageFor = (sqlite, kbId, id) => sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND knowledge_base_id=? AND status='active'").get(id, kbId);
const pageVersionFor = (sqlite, pageId, id) => sqlite.prepare("SELECT * FROM wiki_page_versions WHERE id=? AND page_id=?").get(id, pageId);

const addResourceVersion = (sqlite, kbId, versions, id) => {
  if (versions.some((version) => version.id === id)) return;
  const row = resourceVersionFor(sqlite, kbId, id);
  if (!row) throw fail("resource version is not in the knowledge base", "AGENT_SCOPE_INVALID");
  versions.push({ id: row.id, resourceId: row.resource_id, name: row.resource_name, title: row.title, mimeType: row.mime_type, byteSize: row.byte_size, contentSha256: row.content_sha256 });
};

const addWikiPage = (sqlite, kbId, pages, id, pageVersionId = null) => {
  if (pages.some((page) => page.id === id)) return;
  const row = pageFor(sqlite, kbId, id);
  if (!row || !row.current_version_id) throw fail("wiki page is not active or has no version", "AGENT_SCOPE_INVALID");
  const selectedVersionId = pageVersionId || row.current_version_id;
  if (!pageVersionFor(sqlite, row.id, selectedVersionId)) throw fail("wiki page version is invalid", "AGENT_SCOPE_INVALID");
  pages.push({ id: row.id, pageVersionId: selectedVersionId, spaceId: row.space_id, title: row.title, pageType: row.page_type, slug: row.slug });
};

const traceResourceIds = (trace) => [...(trace?.raw?.results || []), ...(trace?.context?.items || [])]
  .map((item) => item.resourceVersionId || item.locator?.resourceVersionId)
  .filter(Boolean);
const tracePageIds = (trace) => [...(trace?.wiki?.seeds || []), ...(trace?.wiki?.graphExpanded || []), ...(trace?.context?.items || [])]
  .map((item) => ({ id: item.pageId || item.page?.id || item.locator?.pageId, versionId: item.pageVersionId || item.locator?.pageVersionId }))
  .filter((item) => item.id);

export const createScopeSnapshot = (sqlite, input = {}, { allowEmpty = false, requireExplicit = false } = {}) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("scope must be an object", "AGENT_SCOPE_INVALID");
  const knowledgeBaseId = bodyValue(input, "knowledgeBaseId", "knowledge_base_id") || null;
  const spaceId = bodyValue(input, "spaceId", "space_id") || null;
  const resourceIds = idList(bodyValue(input, "resourceVersionIds", "resource_version_ids"), "resourceVersionIds");
  const pageIds = idList(bodyValue(input, "wikiPageIds", "wiki_page_ids"), "wikiPageIds");
  const retrievalRunId = bodyValue(input, "retrievalRunId", "retrieval_run_id") || null;
  const organizationMode = normalizeOrganizationMode(bodyValue(input, "organizationMode", "organization_mode"));
  const mountPageId = bodyValue(input, "mountPageId", "mount_page_id") || null;
  if (retrievalRunId && !isUuid(retrievalRunId)) throw fail("retrievalRunId must be a UUID", "AGENT_SCOPE_INVALID");
  if (mountPageId && !isUuid(mountPageId)) throw fail("mountPageId must be a UUID", "AGENT_SCOPE_INVALID");
  const explicit = resourceIds.length + pageIds.length + (retrievalRunId ? 1 : 0) > 0;
  if (!knowledgeBaseId) {
    if (spaceId || explicit || mountPageId || organizationMode !== "legacy") throw fail("a knowledge base is required for a scoped run", "AGENT_SCOPE_INVALID");
    if (!allowEmpty) throw fail("an explicit knowledge-base scope is required", "AGENT_SCOPE_INVALID");
    return { version: AGENT_SCOPE_VERSION, knowledgeBaseId: null, spaceId: null, organizationMode, mountPageId: null, resourceVersions: [], wikiPages: [], retrievalRunIds: [], createdAt: now() };
  }
  if (!isUuid(knowledgeBaseId) || !knowledgeBaseFor(sqlite, knowledgeBaseId)) throw fail("knowledge base was not found", "AGENT_SCOPE_INVALID");
  if (spaceId && (!isUuid(spaceId) || !spaceFor(sqlite, knowledgeBaseId, spaceId))) throw fail("space was not found in the knowledge base", "AGENT_SCOPE_INVALID");
  if (mountPageId) {
    const mount = pageFor(sqlite, knowledgeBaseId, mountPageId);
    if (!mount || SYSTEM_PAGE_TYPES.has(mount.page_type)) throw fail("mountPageId must reference an active non-system Wiki page", "AGENT_SCOPE_INVALID");
  }
  if (requireExplicit && !explicit) throw fail("a run must name resource versions, wiki pages, or a retrieval run", "AGENT_SCOPE_INVALID");
  const resourceVersions = [];
  const wikiPages = [];
  for (const id of resourceIds) addResourceVersion(sqlite, knowledgeBaseId, resourceVersions, id);
  for (const id of pageIds) addWikiPage(sqlite, knowledgeBaseId, wikiPages, id);
  const retrievalRunIds = [];
  if (retrievalRunId) {
    const retrieval = sqlite.prepare("SELECT * FROM retrieval_runs WHERE id=? AND knowledge_base_id=?").get(retrievalRunId, knowledgeBaseId);
    if (!retrieval) throw fail("retrieval run was not found in the knowledge base", "AGENT_SCOPE_INVALID");
    if (spaceId && retrieval.space_id && retrieval.space_id !== spaceId) throw fail("retrieval run is outside the selected space", "AGENT_SCOPE_INVALID");
    retrievalRunIds.push(retrievalRunId);
    const trace = getRetrievalRun(sqlite, retrievalRunId);
    for (const id of traceResourceIds(trace)) addResourceVersion(sqlite, knowledgeBaseId, resourceVersions, id);
    for (const page of tracePageIds(trace)) {
      try { addWikiPage(sqlite, knowledgeBaseId, wikiPages, page.id, page.versionId); } catch {}
    }
  }
  if (requireExplicit && !resourceVersions.length && !wikiPages.length && !retrievalRunIds.length) throw fail("the selected scope contains no readable snapshot", "AGENT_SCOPE_INVALID");
  return { version: AGENT_SCOPE_VERSION, knowledgeBaseId, spaceId: spaceId || null, organizationMode, mountPageId, resourceVersions, wikiPages, retrievalRunIds, createdAt: now() };
};

export const parseScopeSnapshot = (value) => {
  const snapshot = typeof value === "string" ? jsonParse(value, null) : value;
  if (!snapshot || snapshot.version !== AGENT_SCOPE_VERSION || !Array.isArray(snapshot.resourceVersions) || !Array.isArray(snapshot.wikiPages)) throw fail("scope snapshot is invalid", "AGENT_SCOPE_INVALID");
  return snapshot;
};

export const scopeView = (snapshot) => {
  const value = parseScopeSnapshot(snapshot);
  return {
    version: value.version,
    knowledgeBaseId: value.knowledgeBaseId,
    spaceId: value.spaceId,
    organizationMode: value.organizationMode || "legacy",
    mountPageId: value.mountPageId || null,
    resourceVersionIds: value.resourceVersions.map((item) => item.id),
    wikiPageIds: value.wikiPages.map((item) => item.id),
    wikiPageVersionIds: value.wikiPages.map((item) => item.pageVersionId),
    retrievalRunIds: [...(value.retrievalRunIds || [])],
    createdAt: value.createdAt
  };
};

const scopedResource = (snapshot, id) => parseScopeSnapshot(snapshot).resourceVersions.find((version) => version.id === id);
const scopedPage = (snapshot, id) => parseScopeSnapshot(snapshot).wikiPages.find((page) => page.id === id);
const scopedPageVersion = (snapshot, id) => parseScopeSnapshot(snapshot).wikiPages.find((page) => page.pageVersionId === id);
const scopedRun = (snapshot, id) => parseScopeSnapshot(snapshot).retrievalRunIds?.includes(id);
const sourceRow = (sqlite, snapshot, id) => {
  const scope = scopedResource(snapshot, id);
  if (!scope) throw fail("resource version is outside the run scope", "AGENT_SCOPE_INVALID");
  const row = sqlite.prepare("SELECT rv.*,r.name AS resource_name,r.id AS resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.id=?").get(id);
  if (!row) throw fail("resource version was not found", "NOT_FOUND");
  return row;
};

const safeSource = (sqlite, config, snapshot, id) => {
  const row = sourceRow(sqlite, snapshot, id);
  let bytes;
  try { bytes = readBytes(config.resourceStorageDir, row.storage_key); } catch { throw fail("resource source storage is unavailable", "SOURCE_INTEGRITY_FAILED"); }
  if (bytes.length !== row.byte_size || sha256(bytes) !== row.content_sha256) throw fail("resource source integrity check failed", "SOURCE_INTEGRITY_FAILED");
  return { row, bytes };
};

export const readResourceVersion = ({ sqlite, config, snapshot, resourceVersionId, startOffset, endOffset }) => {
  const { row, bytes } = safeSource(sqlite, config, snapshot, resourceVersionId);
  const result = { resourceVersionId: row.id, resourceId: row.resource_id, title: row.title || row.resource_name, mimeType: row.mime_type, byteSize: row.byte_size, contentSha256: row.content_sha256, integrity: "valid" };
  if (row.mime_type.startsWith("text/")) {
    const content = normalizeCanonicalText(bytes.toString("utf8"));
    const chars = Array.from(content);
    const start = startOffset === undefined ? 0 : Number(startOffset);
    const end = endOffset === undefined ? Math.min(chars.length, start + 64_000) : Number(endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > chars.length) throw fail("resource read offsets are invalid", "AGENT_SCOPE_INVALID");
    result.content = chars.slice(start, end).join("");
    result.locator = { startOffset: start, endOffset: end };
    result.truncated = end < chars.length;
  } else result.content = null;
  return result;
};

export const readRawChunk = ({ sqlite, snapshot, chunkId }) => {
  if (!isUuid(chunkId)) throw fail("chunkId must be a UUID", "AGENT_SCOPE_INVALID");
  const chunk = sqlite.prepare("SELECT c.*,rv.title,rv.resource_id,r.name AS resource_name FROM chunks c JOIN resource_versions rv ON rv.id=c.resource_version_id JOIN resources r ON r.id=rv.resource_id WHERE c.id=?").get(chunkId);
  if (!chunk) throw fail("raw chunk was not found", "NOT_FOUND");
  if (!scopedResource(snapshot, chunk.resource_version_id)) throw fail("raw chunk is outside the run scope", "AGENT_SCOPE_INVALID");
  return { chunkId: chunk.id, resourceVersionId: chunk.resource_version_id, resourceId: chunk.resource_id, title: chunk.title || chunk.resource_name, content: chunk.content, contextHeader: chunk.context_header, locator: jsonParse(chunk.locator, { chunkId: chunk.id, resourceVersionId: chunk.resource_version_id }), startOffset: chunk.start_offset, endOffset: chunk.end_offset };
};

export const readWikiPage = ({ sqlite, snapshot, wikiPageId }) => {
  if (!isUuid(wikiPageId)) throw fail("wikiPageId must be a UUID", "AGENT_SCOPE_INVALID");
  const selected = scopedPage(snapshot, wikiPageId);
  if (!selected) throw fail("wiki page is outside the run scope", "AGENT_SCOPE_INVALID");
  const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND status='active'").get(wikiPageId);
  const version = page && pageVersionFor(sqlite, page.id, selected.pageVersionId);
  if (!page || !version) throw fail("wiki page snapshot is unavailable", "NOT_FOUND");
  return { wikiPageId: page.id, wikiPageVersionId: version.id, title: page.title, slug: page.slug, pageType: page.page_type, spaceId: page.space_id, contentMarkdown: version.content_markdown, contentSha256: version.content_sha256, blocks: sqlite.prepare("SELECT block_key AS blockKey,block_type AS blockType,ordinal,heading_path AS headingPath,content_markdown AS contentMarkdown FROM wiki_page_blocks WHERE page_version_id=? ORDER BY ordinal,id").all(version.id).map((block) => ({ ...block, headingPath: jsonParse(block.headingPath, []) })), citations: listWikiCitations({ sqlite, snapshot, wikiPageId }), locator: { type: "wiki_page", pageId: page.id, pageVersionId: version.id } };
};

export const readRetrievalRun = ({ sqlite, snapshot, retrievalRunId }) => {
  if (!isUuid(retrievalRunId) || !scopedRun(snapshot, retrievalRunId)) throw fail("retrieval run is outside the run scope", "AGENT_SCOPE_INVALID");
  const run = getRetrievalRun(sqlite, retrievalRunId);
  if (!run) throw fail("retrieval run was not found", "NOT_FOUND");
  return { traceId: run.traceId, query: run.query, status: run.status, scope: run.scope, wiki: run.wiki, raw: run.raw, context: run.context, provenance: run.provenance, metrics: run.metrics, vector: run.vector, error: run.error };
};

export const listWikiCitations = ({ sqlite, snapshot, wikiPageId }) => {
  const selected = scopedPage(snapshot, wikiPageId);
  if (!selected) throw fail("wiki page is outside the run scope", "AGENT_SCOPE_INVALID");
  const resourceRows = sqlite.prepare("SELECT * FROM wiki_citations WHERE page_version_id=? ORDER BY created_at,id").all(selected.pageVersionId).map((row) => ({ citationId: row.id, sourceType: "resource", wikiPageId, wikiPageVersionId: row.page_version_id, blockKey: row.block_key, resourceVersionId: row.resource_version_id, locator: jsonParse(row.locator_json, {}), status: row.status, staleReason: row.stale_reason }));
  const pageRows = sqlite.prepare("SELECT * FROM wiki_page_citations WHERE page_version_id=? ORDER BY created_at,id").all(selected.pageVersionId).map((row) => ({ citationId: row.id, sourceType: "wiki_page", wikiPageId, wikiPageVersionId: row.page_version_id, blockKey: row.block_key, sourcePageVersionId: row.source_page_version_id, sourceBlockKey: row.source_block_key, status: row.status, staleReason: row.stale_reason }));
  return [...resourceRows, ...pageRows];
};

const filteredRetrievalResults = (trace, snapshot) => {
  const resources = new Set(parseScopeSnapshot(snapshot).resourceVersions.map((item) => item.id));
  const pages = new Set(parseScopeSnapshot(snapshot).wikiPages.map((item) => item.id));
  const wiki = (trace.wiki?.seeds || []).filter((item) => pages.has(item.pageId || item.id));
  const raw = (trace.raw?.results || []).filter((item) => resources.has(item.resourceVersionId));
  const context = (trace.context?.items || []).filter((item) => resources.has(item.resourceVersionId) || pages.has(item.pageId));
  return { wiki, raw, context };
};

export const searchKnowledge = async ({ sqlite, config, snapshot, query, onAudit = () => {} }) => {
  const value = normalizePrompt(query).slice(0, 200);
  const scope = parseScopeSnapshot(snapshot);
  if (!scope.knowledgeBaseId || (!scope.resourceVersions.length && !scope.wikiPages.length && !scope.retrievalRunIds?.length)) throw fail("search requires an explicit scope", "AGENT_SCOPE_INVALID");
  try {
    const trace = await executeRetrieval({ sqlite, config, input: { query: value, knowledgeBaseId: scope.knowledgeBaseId, spaceId: scope.spaceId, wikiTopK: 20, rawTopK: 20, contextBudgetTokens: 8000 }, onAudit });
    const filtered = filteredRetrievalResults(trace, snapshot);
    const count = filtered.wiki.length + filtered.raw.length + filtered.context.length;
    return { retrievalRunId: trace.traceId, evidenceStatus: count ? "used" : "no_match", items: { wiki: filtered.wiki, raw: filtered.raw, context: filtered.context }, vector: trace.vector, scope: scopeView(snapshot) };
  } catch (caught) {
    if (caught.code === "RETRIEVAL_INDEX_UNAVAILABLE") return { retrievalRunId: caught.traceId || null, evidenceStatus: "index_unavailable", items: { wiki: [], raw: [], context: [] }, error: { code: caught.code, message: caught.message }, scope: scopeView(snapshot) };
    throw caught;
  }
};

const citationFor = (sqlite, config, snapshot, input, contentMarkdown = "") => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("citation must be an object", "AGENT_OUTPUT_INVALID");
  const resourceVersionId = bodyValue(input, "resourceVersionId", "resource_version_id") || null;
  const requestedPageVersionId = bodyValue(input, "wikiPageVersionId", "wiki_page_version_id") || null;
  const requestedPageId = bodyValue(input, "wikiPageId", "wiki_page_id") || null;
  if ((resourceVersionId && (requestedPageVersionId || requestedPageId)) || (!resourceVersionId && !requestedPageVersionId && !requestedPageId)) throw fail("citation must name exactly one resource version or Wiki page version", "AGENT_OUTPUT_INVALID");
  const blockKey = bodyValue(input, "blockKey", "block_key") ?? null;
  if (blockKey !== null) {
    const keys = new Set(parseMarkdownBlocks(contentMarkdown).map((block) => block.blockKey));
    if (!keys.has(blockKey)) throw fail("citation blockKey does not exist in the proposed page", "AGENT_OUTPUT_INVALID");
  }
  if (resourceVersionId) {
    if (!scopedResource(snapshot, resourceVersionId)) throw fail("citation resource version is outside the run scope", "AGENT_OUTPUT_INVALID");
    const { row } = safeSource(sqlite, config, snapshot, resourceVersionId);
    const bounds = citationSourceBounds({ sqlite, resourceVersion: row, resourceStorageDir: config.resourceStorageDir });
    if (bounds.sourceIntegrity === "invalid") throw fail("citation source integrity check failed", "AGENT_OUTPUT_INVALID");
    let locator;
    try {
      const rawLocator = bodyValue(input, "locator", "locator_json") ?? input.locatorJson;
      const parsedLocator = typeof rawLocator === "string" ? jsonParse(rawLocator, rawLocator) : rawLocator;
      const recognized = new Set(["chunkId", "startOffset", "endOffset", "page", "pageStart", "pageEnd", "pages", "lineStart", "lineEnd", "blockId", "selector"]);
      const locatorInput = parsedLocator && typeof parsedLocator === "object" && !Array.isArray(parsedLocator) ? Object.fromEntries(Object.entries(parsedLocator).filter(([key]) => recognized.has(key))) : parsedLocator;
      locator = normalizeCitationLocator(locatorInput, bounds);
    }
    catch (caught) { throw fail(caught.message, "AGENT_OUTPUT_INVALID"); }
    if (locator.chunkId) {
      const chunk = sqlite.prepare("SELECT id,resource_version_id FROM chunks WHERE id=?").get(locator.chunkId);
      if (!chunk || chunk.resource_version_id !== resourceVersionId) throw fail("citation chunk is not in the cited resource version", "AGENT_OUTPUT_INVALID");
    }
    return { resourceVersionId, wikiPageVersionId: null, sourceBlockKey: null, locator, blockKey };
  }
  const selected = requestedPageVersionId ? scopedPageVersion(snapshot, requestedPageVersionId) : scopedPage(snapshot, requestedPageId);
  if (!selected) throw fail("citation Wiki page version is outside the run scope", "AGENT_OUTPUT_INVALID");
  const wikiPageVersionId = requestedPageVersionId || selected.pageVersionId;
  const sourceVersion = pageVersionFor(sqlite, selected.id, wikiPageVersionId);
  if (!sourceVersion) throw fail("citation Wiki page version is unavailable", "AGENT_OUTPUT_INVALID");
  const sourceBlockKey = bodyValue(input, "sourceBlockKey", "source_block_key") ?? null;
  if (sourceBlockKey !== null && !sqlite.prepare("SELECT id FROM wiki_page_blocks WHERE page_version_id=? AND block_key=?").get(wikiPageVersionId, sourceBlockKey)) throw fail("citation sourceBlockKey does not exist in the cited Wiki page version", "AGENT_OUTPUT_INVALID");
  return { resourceVersionId: null, wikiPageVersionId, sourceBlockKey, locator: null, blockKey };
};

export const validateAnswerOutput = (sqlite, config, snapshot, output) => {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw fail("submit_answer payload must be an object", "AGENT_OUTPUT_INVALID");
  const answerMarkdown = text(output.answerMarkdown, "answerMarkdown", 100_000);
  const evidence = output.evidence === undefined ? [] : output.evidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_CITATIONS) throw fail("evidence must contain at most 100 citations", "AGENT_OUTPUT_INVALID");
  const normalizedEvidence = evidence.map((item) => {
    const citation = citationFor(sqlite, config, snapshot, item);
    return { ...(citation.resourceVersionId ? { resourceVersionId: citation.resourceVersionId, locator: citation.locator } : { wikiPageVersionId: citation.wikiPageVersionId, sourceBlockKey: citation.sourceBlockKey }), role: "supporting" };
  });
  const modelSupplement = output.modelSupplement === undefined ? "" : output.modelSupplement === "" ? "" : optionalText(output.modelSupplement, "modelSupplement", 100_000) || "";
  const openQuestions = output.openQuestions === undefined ? [] : output.openQuestions;
  if (!Array.isArray(openQuestions) || openQuestions.length > 20 || openQuestions.some((item) => typeof item !== "string" || item.trim().length > 500)) throw fail("openQuestions is invalid", "AGENT_OUTPUT_INVALID");
  const scope = parseScopeSnapshot(snapshot);
  let evidenceStatus = output.evidenceStatus || (normalizedEvidence.length ? "used" : scope.knowledgeBaseId ? "no_match" : "none");
  if (![
    "used", "no_match", "index_unavailable", "none"
  ].includes(evidenceStatus)) throw fail("evidenceStatus is invalid", "AGENT_OUTPUT_INVALID");
  if (!scope.knowledgeBaseId && (normalizedEvidence.length || evidenceStatus !== "none")) throw fail("open chat cannot cite MyKnow evidence", "AGENT_OUTPUT_INVALID");
  if (scope.knowledgeBaseId && evidenceStatus === "none") throw fail("scoped chat must report used, no_match, or index_unavailable", "AGENT_OUTPUT_INVALID");
  if (evidenceStatus === "used" && !normalizedEvidence.length) throw fail("used evidenceStatus requires evidence", "AGENT_OUTPUT_INVALID");
  if (normalizedEvidence.length && evidenceStatus !== "used") throw fail("cited evidence must use evidenceStatus=used", "AGENT_OUTPUT_INVALID");
  return { answerMarkdown, evidence: normalizedEvidence, modelSupplement, openQuestions: openQuestions.map((item) => item.trim()).filter(Boolean), evidenceStatus };
};

const validatePageMetadata = (sqlite, kbId, proposed, { pageId = null, allowPageType = true } = {}) => {
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) throw fail("proposed page must be an object", "AGENT_OUTPUT_INVALID");
  const title = text(proposed.title, "proposed.title", 200);
  let pageType;
  try { pageType = normalizePageType(proposed.pageType); } catch (caught) { throw fail(caught.message, "AGENT_OUTPUT_INVALID"); }
  if (!allowPageType && pageType === undefined) throw fail("pageType is required", "AGENT_OUTPUT_INVALID");
  if (SYSTEM_PAGE_TYPES.has(pageType)) throw fail("system pages cannot be changed by an agent", "AGENT_OUTPUT_INVALID");
  const contentMarkdown = text(proposed.contentMarkdown, "proposed.contentMarkdown", MAX_MARKDOWN);
  const spaceId = proposed.spaceId ?? proposed.space_id ?? null;
  if (spaceId && (!isUuid(spaceId) || !spaceFor(sqlite, kbId, spaceId))) throw fail("proposed space is invalid", "AGENT_OUTPUT_INVALID");
  const parentPageId = proposed.parentPageId ?? proposed.parent_page_id ?? null;
  if (parentPageId && (!isUuid(parentPageId) || !pageFor(sqlite, kbId, parentPageId) || parentPageId === pageId)) throw fail("proposed parent page is invalid", "AGENT_OUTPUT_INVALID");
  return { title, pageType, contentMarkdown, ...(spaceId ? { spaceId } : {}), ...(parentPageId ? { parentPageId } : {}) };
};

const normalizeTreeNode = (input, ordinal) => {
  const proposed = input?.proposed || {};
  const rawNodeId = input?.nodeId ?? proposed.nodeId ?? proposed.node_id ?? `node-${ordinal + 1}`;
  const nodeId = text(rawNodeId, "nodeId", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(nodeId)) throw fail("nodeId contains unsupported characters", "AGENT_OUTPUT_INVALID");
  const rawParent = input?.parentNodeId ?? input?.parent_node_id ?? proposed.parentNodeId ?? proposed.parent_node_id ?? null;
  const parentNodeId = rawParent === undefined || rawParent === null || rawParent === "" ? null : text(rawParent, "parentNodeId", 80);
  if (parentNodeId === nodeId) throw fail("a tree node cannot parent itself", "AGENT_OUTPUT_INVALID");
  const rawRole = input?.nodeRole ?? input?.node_role ?? proposed.nodeRole ?? proposed.node_role ?? null;
  const nodeRole = rawRole === null || rawRole === undefined || rawRole === "" ? null : text(rawRole, "nodeRole", 20).toLowerCase();
  if (nodeRole && !["root", "category", "entity", "source"].includes(nodeRole)) throw fail("nodeRole must be root, category, entity, or source", "AGENT_OUTPUT_INVALID");
  return { nodeId, parentNodeId, ...(nodeRole ? { nodeRole } : {}) };
};

const validateTreeNodes = (items, snapshot) => {
  const nodes = items.filter((item) => ["page_create", "page_update"].includes(item.itemType));
  if (!nodes.length) throw fail("tree plans must contain at least one Wiki page", "AGENT_OUTPUT_INVALID");
  if (nodes.length > AGENT_TREE_LIMITS.maxPages) throw fail(`tree plans may contain at most ${AGENT_TREE_LIMITS.maxPages} pages`, "AGENT_OUTPUT_INVALID");
  const byId = new Map();
  for (const item of nodes) {
    if (byId.has(item.nodeId)) throw fail("tree nodeId values must be unique", "AGENT_OUTPUT_INVALID");
    byId.set(item.nodeId, item);
  }
  const roots = nodes.filter((item) => !item.parentNodeId);
  if (roots.length !== 1) throw fail("tree plans must contain exactly one root page", "AGENT_OUTPUT_INVALID");
  const root = roots[0];
  if (root.nodeRole && root.nodeRole !== "root") throw fail("the tree root must have nodeRole=root", "AGENT_OUTPUT_INVALID");
  root.nodeRole = "root";
  if (root.proposed.pageType !== "synthesis") throw fail("the tree root must use pageType=synthesis", "AGENT_OUTPUT_INVALID");
  const children = new Map();
  for (const item of nodes) {
    if (item.parentNodeId) {
      if (!byId.has(item.parentNodeId)) throw fail("tree parentNodeId must reference another page item", "AGENT_OUTPUT_INVALID");
      const list = children.get(item.parentNodeId) || [];
      list.push(item);
      children.set(item.parentNodeId, list);
    }
  }
  for (const [parentNodeId, list] of children) if (list.length > AGENT_TREE_LIMITS.maxChildren) throw fail(`tree node ${parentNodeId} has too many children`, "AGENT_OUTPUT_INVALID");
  const siblingTitles = new Map();
  for (const item of nodes) {
    const key = item.parentNodeId || "__root__";
    const title = item.proposed.title.toLocaleLowerCase();
    const titles = siblingTitles.get(key) || new Set();
    if (titles.has(title)) throw fail("sibling Wiki pages must have unique normalized titles", "AGENT_OUTPUT_INVALID");
    titles.add(title);
    siblingTitles.set(key, titles);
  }
  const visited = new Set();
  const visit = (item, ancestors = new Set()) => {
    if (ancestors.has(item.nodeId)) throw fail("tree contains a parent cycle", "AGENT_OUTPUT_INVALID");
    const next = new Set(ancestors).add(item.nodeId);
    item.depth = ancestors.size;
    visited.add(item.nodeId);
    if (item.depth >= AGENT_TREE_LIMITS.maxDepth) throw fail(`tree depth must not exceed ${AGENT_TREE_LIMITS.maxDepth}`, "AGENT_OUTPUT_INVALID");
    for (const child of children.get(item.nodeId) || []) visit(child, next);
  };
  visit(root);
  if (nodes.some((item) => !visited.has(item.nodeId))) throw fail("tree contains an unreachable page item", "AGENT_OUTPUT_INVALID");
  for (const item of nodes) {
    const expectedRole = item.depth === 0 ? "root" : item.proposed.pageType === "concept" ? "category" : item.proposed.pageType === "entity" ? "entity" : item.proposed.pageType === "source-summary" ? "source" : null;
    if (item.nodeRole && item.nodeRole !== expectedRole) throw fail(`nodeRole does not match pageType for ${item.nodeId}`, "AGENT_OUTPUT_INVALID");
    item.nodeRole = expectedRole || item.nodeRole;
    if (!item.nodeRole) throw fail(`nodeRole is required for ${item.nodeId}`, "AGENT_OUTPUT_INVALID");
  }
  if (snapshot.mountPageId && roots[0].proposed.parentPageId) throw fail("tree roots use mountPageId, not proposed.parentPageId", "AGENT_OUTPUT_INVALID");
  return items;
};

const tagFor = (sqlite, kbId, proposed) => {
  const tagId = proposed?.tagId ?? proposed?.tag_id ?? null;
  const tagName = proposed?.tagName ?? proposed?.tag_name ?? null;
  if (tagId && (!isUuid(tagId) || !sqlite.prepare("SELECT id FROM tags WHERE id=? AND knowledge_base_id=?").get(tagId, kbId))) throw fail("tag is invalid", "AGENT_OUTPUT_INVALID");
  if (!tagId && (typeof tagName !== "string" || !tagName.trim() || tagName.trim().length > 120)) throw fail("tagId or tagName is required", "AGENT_OUTPUT_INVALID");
  if (tagName && tagName.trim().length > 120) throw fail("tagName is too long", "AGENT_OUTPUT_INVALID");
  const existing = tagId ? sqlite.prepare("SELECT id,name FROM tags WHERE id=?").get(tagId) : sqlite.prepare("SELECT id,name FROM tags WHERE knowledge_base_id=? AND name=?").get(kbId, tagName.trim());
  if (!existing) throw fail("tag must already exist before an agent can add it", "AGENT_OUTPUT_INVALID");
  return { tagId: existing.id, tagName: existing.name };
};

export const validatePlanOutput = (sqlite, config, snapshot, output) => {
  if (!output || typeof output !== "object" || Array.isArray(output) || !Array.isArray(output.items)) throw fail("submit_change_plan payload must contain items", "AGENT_OUTPUT_INVALID");
  if (output.items.length > MAX_PLAN_ITEMS) throw fail(`a change plan may contain at most ${MAX_PLAN_ITEMS} items`, "AGENT_OUTPUT_INVALID");
  const scope = parseScopeSnapshot(snapshot);
  if (!scope.knowledgeBaseId) throw fail("change plans require a knowledge base", "AGENT_OUTPUT_INVALID");
  const items = output.items.map((input, ordinal) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || !AGENT_PLAN_TYPES.includes(input.itemType)) throw fail("plan item type is invalid", "AGENT_OUTPUT_INVALID");
    const itemType = input.itemType;
    const targetPageId = input.targetPageId || null;
    if (["page_update", "tag_add"].includes(itemType) && (!targetPageId || !scopedPage(snapshot, targetPageId))) throw fail("plan target page is outside the run scope", "AGENT_OUTPUT_INVALID");
    let proposed;
    if (itemType === "page_create" || itemType === "page_update") {
      proposed = validatePageMetadata(sqlite, scope.knowledgeBaseId, input.proposed, { pageId: targetPageId });
      if (scope.organizationMode === "tree") {
        if (itemType === "page_create" && targetPageId) throw fail("page_create tree nodes cannot target an existing page", "AGENT_OUTPUT_INVALID");
        if (itemType === "page_update" && !targetPageId) throw fail("page_update tree nodes must target an existing page", "AGENT_OUTPUT_INVALID");
        const node = normalizeTreeNode(input, ordinal);
        if (Object.hasOwn(proposed, "parentPageId")) throw fail("tree plans must use parentNodeId for generated hierarchy", "AGENT_OUTPUT_INVALID");
        proposed = { ...proposed, ...node };
      }
    }
    else if (itemType === "tag_add") proposed = tagFor(sqlite, scope.knowledgeBaseId, input.proposed);
    else {
      const relatedPageId = input.proposed?.relatedPageId ?? input.proposed?.related_page_id ?? input.relatedPageId ?? null;
      if (relatedPageId && (!isUuid(relatedPageId) || !scopedPage(snapshot, relatedPageId))) throw fail("finding page is outside the run scope", "AGENT_OUTPUT_INVALID");
      proposed = { summary: text(input.proposed?.summary || input.summary, "proposed.summary", 2_000), relatedPageId };
    }
    let basePageVersionId = input.basePageVersionId || input.base_page_version_id || null;
    if (itemType === "page_update") {
      const page = scopedPage(snapshot, targetPageId);
      if (basePageVersionId !== page.pageVersionId) throw fail("page_update basePageVersionId must match the scope snapshot", "AGENT_OUTPUT_INVALID");
    } else basePageVersionId = null;
    const rawCitations = input.citations === undefined ? [] : input.citations;
    if (!Array.isArray(rawCitations) || rawCitations.length > MAX_CITATIONS) throw fail("plan citations are invalid", "AGENT_OUTPUT_INVALID");
    const citations = rawCitations.map((citation) => citationFor(sqlite, config, snapshot, citation, proposed.contentMarkdown || ""));
    const evidenceStatus = citations.length ? "used" : ["tag_add"].includes(itemType) ? "not_applicable" : "needs_evidence";
    const risk = itemType === "tag_add" ? "low" : itemType === "page_create" ? "medium" : "high";
    const diff = itemType === "page_update" ? (() => {
      const base = sqlite.prepare("SELECT content_markdown FROM wiki_page_versions WHERE id=? AND page_id=?").get(basePageVersionId, targetPageId);
      if (!base) throw fail("base page version is unavailable", "AGENT_OUTPUT_INVALID");
      return diffMarkdown(base.content_markdown, proposed.contentMarkdown);
    })() : null;
    return {
      ordinal,
      itemType,
      targetPageId,
      basePageVersionId,
      proposed,
      citations,
      diff,
      risk,
      evidenceStatus,
      ...(scope.organizationMode === "tree" && ["page_create", "page_update"].includes(itemType) ? { nodeId: proposed.nodeId, parentNodeId: proposed.parentNodeId, nodeRole: proposed.nodeRole } : {})
    };
  });
  if (scope.organizationMode === "tree") validateTreeNodes(items, scope);
  return { items };
};

export const insertAgentPlanItems = (sqlite, runId, plan) => {
  const timestamp = now();
  const insert = sqlite.prepare("INSERT INTO agent_plan_items (id,run_id,ordinal,item_type,target_page_id,base_page_version_id,proposed_json,citations_json,diff_json,risk,evidence_status,review_status,application_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'proposed','pending',?,?)");
  return plan.items.map((item) => {
    const id = crypto.randomUUID();
    insert.run(id, runId, item.ordinal, item.itemType, item.targetPageId, item.basePageVersionId, JSON.stringify(item.proposed), JSON.stringify(item.citations), item.diff ? JSON.stringify(item.diff) : null, item.risk, item.evidenceStatus, timestamp, timestamp);
    return id;
  });
};

const runView = (row) => row ? (() => {
  const scope = scopeView(row.scope_snapshot);
  return { id: row.id, taskId: row.task_id, runKind: row.run_kind, knowledgeBaseId: row.knowledge_base_id, spaceId: row.space_id, organizationMode: scope.organizationMode, mountPageId: scope.mountPageId, scope, promptVersion: row.prompt_version, contractVersion: row.contract_version, provider: row.provider, model: row.model, egressMode: row.egress_mode, status: row.status, result: jsonParse(row.result_json, null), metrics: jsonParse(row.metrics, {}), error: row.error_code ? { code: row.error_code, message: row.error_summary } : null, createdAt: row.created_at, updatedAt: row.updated_at };
})() : null;
export const agentRunView = runView;

export const getAgentRun = (sqlite, id) => runView(sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(id));
export const getAgentPlan = (sqlite, runId) => sqlite.prepare("SELECT * FROM agent_plan_items WHERE run_id=? ORDER BY ordinal,id").all(runId).map(agentPlanItemView);
export const getAgentEvents = (sqlite, runId) => sqlite.prepare("SELECT id,run_id AS runId,sequence,event_type AS eventType,stage,tool_name AS toolName,duration_ms AS durationMs,input_hash AS inputHash,output_hash AS outputHash,result_size AS resultSize,input_tokens AS inputTokens,output_tokens AS outputTokens,cache_read_tokens AS cacheReadTokens,cost_total AS costTotal,error_code AS errorCode,error_summary AS errorSummary,created_at AS createdAt FROM agent_events WHERE run_id=? ORDER BY sequence").all(runId);

export const agentPlanItemView = (row) => {
  if (!row) return null;
  const proposed = jsonParse(row.proposed_json, {});
  return { id: row.id, runId: row.run_id, ordinal: row.ordinal, itemType: row.item_type, targetPageId: row.target_page_id, basePageVersionId: row.base_page_version_id, nodeId: proposed.nodeId || null, parentNodeId: proposed.parentNodeId || null, nodeRole: proposed.nodeRole || null, operation: proposed.operation || (row.item_type === "page_create" ? "create" : row.item_type === "page_update" ? "update" : null), proposed, citations: jsonParse(row.citations_json, []), diff: jsonParse(row.diff_json, null), risk: row.risk, evidenceStatus: row.evidence_status, reviewStatus: row.review_status, applicationStatus: row.application_status, appliedPageVersionId: row.applied_page_version_id, rollbackPageVersionId: row.rollback_page_version_id, decisionReason: row.decision_reason, decidedBy: row.decided_by, decidedAt: row.decided_at, appliedAt: row.applied_at, error: row.error_code ? { code: row.error_code, message: row.error_summary } : null, createdAt: row.created_at, updatedAt: row.updated_at };
};

const blockedByRejectedParent = (sqlite, row) => {
  const node = planNode(row);
  if (!node.parentNodeId) return false;
  const rows = sqlite.prepare("SELECT * FROM agent_plan_items WHERE run_id=?").all(row.run_id);
  let parentNodeId = node.parentNodeId;
  const seen = new Set();
  while (parentNodeId) {
    if (seen.has(parentNodeId)) return true;
    seen.add(parentNodeId);
    const parent = rows.find((candidate) => planNode(candidate).nodeId === parentNodeId);
    if (!parent) return true;
    if (parent.review_status === "rejected" || parent.application_status === "stale" || parent.application_status === "apply_failed") return true;
    parentNodeId = planNode(parent).parentNodeId;
  }
  return false;
};

export const agentPlanStatus = (sqlite, runId) => {
  const rows = sqlite.prepare("SELECT * FROM agent_plan_items WHERE run_id=? ORDER BY ordinal,id").all(runId);
  if (!rows.length) return "draft";
  if (rows.some((row) => blockedByRejectedParent(sqlite, row))) return "partially_applied";
  if (rows.some((row) => row.application_status === "stale" || row.application_status === "apply_failed")) return "failed";
  if (rows.every((row) => ["applied", "not_applicable", "rolled_back"].includes(row.application_status))) return "applied";
  if (rows.some((row) => ["applied", "not_applicable", "rolled_back"].includes(row.application_status))) return "partially_applied";
  return rows.some((row) => row.evidence_status === "needs_evidence") ? "draft" : "ready";
};

export const getAgentPlanTree = (sqlite, runId) => {
  const items = getAgentPlan(sqlite, runId);
  const byNode = new Map(items.filter((item) => item.nodeId).map((item) => [item.nodeId, { ...item, children: [] }]));
  const roots = [];
  for (const node of byNode.values()) {
    const parent = node.parentNodeId && byNode.get(node.parentNodeId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

export const chatMessageView = (row) => row ? ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, status: row.status, agentRunId: row.agent_run_id, taskId: row.task_id, retrievalRunIds: jsonParse(row.retrieval_run_ids, []), answer: jsonParse(row.answer_json, null), error: row.error_code ? { code: row.error_code, message: row.error_summary } : null, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
export const chatSessionView = (sqlite, row, { includeMessages = false } = {}) => {
  if (!row) return null;
  const result = { id: row.id, knowledgeBaseId: row.knowledge_base_id, scope: scopeView(row.scope_snapshot), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  if (includeMessages) result.messages = sqlite.prepare("SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 10").all(row.id).reverse().map(chatMessageView);
  return result;
};
export const getChatSession = (sqlite, id, options) => chatSessionView(sqlite, sqlite.prepare("SELECT * FROM chat_sessions WHERE id=?").get(id), options);
export const getChatMessage = (sqlite, id) => chatMessageView(sqlite.prepare("SELECT * FROM chat_messages WHERE id=?").get(id));

export const recordAgentEvent = (sqlite, input) => {
  const sequence = sqlite.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS value FROM agent_events WHERE run_id=?").get(input.runId).value;
  const timestamp = input.createdAt || now();
  const id = crypto.randomUUID();
  sqlite.prepare("INSERT INTO agent_events (id,run_id,sequence,event_type,stage,tool_name,duration_ms,input_hash,output_hash,result_size,input_tokens,output_tokens,cache_read_tokens,cost_total,error_code,error_summary,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.runId, sequence, input.eventType, input.stage || null, input.toolName || null, input.durationMs ?? null, input.inputHash || null, input.outputHash || null, input.resultSize ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.cacheReadTokens ?? null, input.costTotal ?? null, input.errorCode || null, input.errorSummary ? String(input.errorSummary).slice(0, 500) : null, timestamp);
  return id;
};

export const updateAgentRun = (sqlite, runId, { status, metrics, errorCode = null, errorSummary = null }) => {
  const timestamp = now();
  sqlite.prepare("UPDATE agent_runs SET status=?,metrics=COALESCE(?,metrics),error_code=?,error_summary=?,updated_at=? WHERE id=?").run(status, metrics === undefined ? null : JSON.stringify(metrics), errorCode, errorSummary ? String(errorSummary).slice(0, 500) : null, timestamp, runId);
  return getAgentRun(sqlite, runId);
};

const ensureTemplates = (sqlite, knowledgeBaseId) => {
  const timestamp = now();
  for (const pageType of ["concept", "entity", "source-summary", "synthesis"]) {
    let template = sqlite.prepare("SELECT * FROM wiki_templates WHERE knowledge_base_id=? AND page_type=?").get(knowledgeBaseId, pageType);
    if (template) continue;
    const templateId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    sqlite.prepare("INSERT INTO wiki_templates (id,knowledge_base_id,page_type,current_version_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run(templateId, knowledgeBaseId, pageType, timestamp, timestamp);
    sqlite.prepare("INSERT INTO wiki_template_versions (id,template_id,definition_json,created_at) VALUES (?,?,?,?)").run(versionId, templateId, JSON.stringify(defaultTemplateDefinition(pageType)), timestamp);
    sqlite.prepare("UPDATE wiki_templates SET current_version_id=? WHERE id=?").run(versionId, templateId);
  }
};
const assertParent = (sqlite, kbId, pageId, parentId) => {
  if (!parentId) return null;
  const parent = pageFor(sqlite, kbId, parentId);
  if (!parent || parent.id === pageId) throw fail("parent page is invalid", "AGENT_APPLY_FAILED");
  const seen = new Set([pageId]);
  let cursor = parent;
  while (cursor) {
    if (seen.has(cursor.id)) throw fail("page parent would create a cycle", "AGENT_APPLY_FAILED");
    seen.add(cursor.id);
    cursor = cursor.parent_page_id ? sqlite.prepare("SELECT id,parent_page_id FROM wiki_pages WHERE id=?").get(cursor.parent_page_id) : null;
  }
  return parent.id;
};
const assertSlugAvailable = (sqlite, kbId, slug, pageId = null) => {
  if (sqlite.prepare("SELECT id FROM wiki_pages WHERE knowledge_base_id=? AND slug=? AND id<>?").get(kbId, slug, pageId || "")) throw fail("generated page slug is already used", "AGENT_APPLY_FAILED");
};
const insertVersion = (sqlite, { pageId, parentVersionId, templateVersionId, contentMarkdown, changeSummary, restoreOfVersionId = null, timestamp }) => {
  const versionId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO wiki_page_versions (id,page_id,parent_version_id,template_version_id,content_markdown,content_sha256,change_summary,restore_of_version_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(versionId, pageId, parentVersionId, templateVersionId, contentMarkdown, sha256(contentMarkdown), changeSummary, restoreOfVersionId, timestamp);
  for (const block of parseMarkdownBlocks(contentMarkdown)) sqlite.prepare("INSERT INTO wiki_page_blocks (id,page_version_id,block_key,block_type,ordinal,heading_path,content_markdown,content_sha256) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), versionId, block.blockKey, block.blockType, block.ordinal, JSON.stringify(block.headingPath), block.contentMarkdown, block.contentSha256);
  return versionId;
};
const copyCitations = (sqlite, fromVersionId, toVersionId, timestamp) => {
  if (!fromVersionId) return;
  for (const citation of sqlite.prepare("SELECT * FROM wiki_citations WHERE page_version_id=? ORDER BY created_at,id").all(fromVersionId)) sqlite.prepare("INSERT INTO wiki_citations (id,page_version_id,block_key,resource_version_id,locator_json,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), toVersionId, citation.block_key, citation.resource_version_id, citation.locator_json, citation.status, citation.stale_reason, citation.checked_at || timestamp, timestamp);
  for (const citation of sqlite.prepare("SELECT * FROM wiki_page_citations WHERE page_version_id=? ORDER BY created_at,id").all(fromVersionId)) sqlite.prepare("INSERT INTO wiki_page_citations (id,page_version_id,block_key,source_page_version_id,source_block_key,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), toVersionId, citation.block_key, citation.source_page_version_id, citation.source_block_key, citation.status, citation.stale_reason, citation.checked_at || timestamp, timestamp);
};
const insertCitations = (sqlite, config, snapshot, pageVersionId, citations, contentMarkdown) => {
  const timestamp = now();
  for (const citation of citations) {
    const normalized = citationFor(sqlite, config, snapshot, citation, contentMarkdown);
    if (normalized.resourceVersionId) sqlite.prepare("INSERT INTO wiki_citations (id,page_version_id,block_key,resource_version_id,locator_json,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,'active',NULL,?,?)").run(crypto.randomUUID(), pageVersionId, normalized.blockKey, normalized.resourceVersionId, JSON.stringify(normalized.locator), timestamp, timestamp);
    else sqlite.prepare("INSERT INTO wiki_page_citations (id,page_version_id,block_key,source_page_version_id,source_block_key,status,stale_reason,checked_at,created_at) VALUES (?,?,?,?,?,'active',NULL,?,?)").run(crypto.randomUUID(), pageVersionId, normalized.blockKey, normalized.wikiPageVersionId, normalized.sourceBlockKey, timestamp, timestamp);
  }
};
const queuePageEmbedding = (sqlite, config, pageId, pageVersionId) => {
  if (config.retrievalVectorEnabled === false) return;
  queueEmbeddingTask(sqlite, { ownerType: "wiki_page", ownerId: pageId, pageVersionId, reason: "agent-plan-applied" });
};

const planNode = (row) => {
  const proposed = jsonParse(row.proposed_json, {});
  return { nodeId: proposed.nodeId || null, parentNodeId: proposed.parentNodeId || null, nodeRole: proposed.nodeRole || null };
};

const pageIdForAppliedNode = (sqlite, runId, nodeId, nodePageIds = new Map()) => {
  if (!nodeId) return null;
  if (nodePageIds.has(nodeId)) return nodePageIds.get(nodeId);
  const rows = sqlite.prepare("SELECT target_page_id,proposed_json,application_status FROM agent_plan_items WHERE run_id=? AND application_status IN ('applied','not_applicable')").all(runId);
  const found = rows.find((candidate) => jsonParse(candidate.proposed_json, {}).nodeId === nodeId && candidate.target_page_id);
  return found?.target_page_id || null;
};

const resolveTreeParent = (sqlite, run, snapshot, row, proposed, nodePageIds) => {
  const parentPageId = proposed.parentNodeId ? pageIdForAppliedNode(sqlite, run.id, proposed.parentNodeId, nodePageIds) : snapshot.mountPageId || null;
  if (proposed.parentNodeId && !parentPageId) throw fail("parent tree node must be applied first", "AGENT_PLAN_BLOCKED");
  return assertParent(sqlite, run.knowledge_base_id, row.target_page_id || crypto.randomUUID(), parentPageId);
};

const applyItemInTransaction = (sqlite, config, row, requestId = null, { nodePageIds = new Map() } = {}) => {
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(row.run_id);
  const snapshot = parseScopeSnapshot(run.scope_snapshot);
  const proposed = jsonParse(row.proposed_json, {});
  const citations = jsonParse(row.citations_json, []);
  const timestamp = now();
  if (row.evidence_status === "needs_evidence") throw fail("plan item needs evidence before it can be applied", "AGENT_PLAN_INVALID");
  if (row.item_type === "tag_add") {
    const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND knowledge_base_id=? AND status='active'").get(row.target_page_id, run.knowledge_base_id);
    if (!page) throw fail("target page is unavailable", "AGENT_APPLY_FAILED");
    if (!sqlite.prepare("SELECT id FROM tags WHERE id=? AND knowledge_base_id=?").get(proposed.tagId, run.knowledge_base_id)) throw fail("target tag is unavailable", "AGENT_APPLY_FAILED");
    if (sqlite.prepare("SELECT page_id FROM wiki_page_tags WHERE page_id=? AND tag_id=?").get(page.id, proposed.tagId)) {
      sqlite.prepare("UPDATE agent_plan_items SET application_status='not_applicable',applied_at=?,updated_at=?,error_code=NULL,error_summary=NULL WHERE id=?").run(timestamp, timestamp, row.id);
      auditAgent(sqlite, "approve", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "not_applicable", targetPageId: page.id, reason: "tag already attached" });
      return;
    }
    sqlite.prepare("INSERT OR IGNORE INTO wiki_page_tags (page_id,tag_id,created_at) VALUES (?,?,?)").run(page.id, proposed.tagId, timestamp);
    sqlite.prepare("UPDATE agent_plan_items SET application_status='applied',applied_at=?,updated_at=?,error_code=NULL,error_summary=NULL WHERE id=?").run(timestamp, timestamp, row.id);
    auditAgent(sqlite, "approve", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "applied", targetPageId: page.id });
    return;
  }
  if (["duplicate_finding", "conflict_finding"].includes(row.item_type)) {
    sqlite.prepare("UPDATE agent_plan_items SET application_status='not_applicable',applied_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, row.id);
    auditAgent(sqlite, "approve", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "not_applicable" });
    return;
  }
  if (row.item_type === "page_update") {
    const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND knowledge_base_id=? AND status='active'").get(row.target_page_id, run.knowledge_base_id);
    if (!page || page.current_version_id !== row.base_page_version_id) throw fail("page changed after the plan was created", "AGENT_REVIEW_CONFLICT");
    const current = pageVersionFor(sqlite, page.id, page.current_version_id);
    const rollbackMetadata = { title: page.title, pageType: page.page_type, spaceId: page.space_id, parentPageId: page.parent_page_id };
    const versionId = insertVersion(sqlite, { pageId: page.id, parentVersionId: current.id, templateVersionId: current.template_version_id, contentMarkdown: proposed.contentMarkdown, changeSummary: `Agent plan ${row.id}`, timestamp });
    insertCitations(sqlite, config, snapshot, versionId, citations, proposed.contentMarkdown);
    const parentPageId = snapshot.organizationMode === "tree" ? resolveTreeParent(sqlite, run, snapshot, row, proposed, nodePageIds) : assertParent(sqlite, run.knowledge_base_id, page.id, proposed.parentPageId ?? page.parent_page_id);
    sqlite.prepare("UPDATE wiki_pages SET title=?,page_type=?,space_id=?,parent_page_id=?,current_version_id=?,updated_at=? WHERE id=?").run(proposed.title, proposed.pageType, proposed.spaceId ?? page.space_id, parentPageId, versionId, timestamp, page.id);
    updateWikiSearchProjection(sqlite, page.id);
    queuePageEmbedding(sqlite, config, page.id, versionId);
    sqlite.prepare("UPDATE agent_plan_items SET proposed_json=?,application_status='applied',applied_page_version_id=?,applied_at=?,updated_at=?,error_code=NULL,error_summary=NULL WHERE id=?").run(JSON.stringify({ ...proposed, rollbackMetadata }), versionId, timestamp, timestamp, row.id);
    if (proposed.nodeId) nodePageIds.set(proposed.nodeId, page.id);
    auditAgent(sqlite, "approve", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "applied", targetPageId: page.id, appliedPageVersionId: versionId });
    return;
  }
  if (row.item_type === "page_create") {
    ensureTemplates(sqlite, run.knowledge_base_id);
    const pageId = crypto.randomUUID();
    const slug = slugFromTitle(proposed.title, pageId.slice(0, 8));
    assertSlugAvailable(sqlite, run.knowledge_base_id, slug);
    const spaceId = proposed.spaceId || run.space_id || null;
    const parentPageId = snapshot.organizationMode === "tree" ? resolveTreeParent(sqlite, run, snapshot, { ...row, target_page_id: pageId }, proposed, nodePageIds) : assertParent(sqlite, run.knowledge_base_id, pageId, proposed.parentPageId || null);
    const template = sqlite.prepare("SELECT * FROM wiki_templates WHERE knowledge_base_id=? AND page_type=?").get(run.knowledge_base_id, proposed.pageType);
    sqlite.prepare("INSERT INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)").run(pageId, run.knowledge_base_id, spaceId, parentPageId, slug, proposed.title, proposed.pageType, timestamp, timestamp);
    const pageVersionId = insertVersion(sqlite, { pageId, parentVersionId: null, templateVersionId: template?.current_version_id || null, contentMarkdown: proposed.contentMarkdown, changeSummary: `Agent plan ${row.id}`, timestamp });
    sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(pageVersionId, pageId);
    insertCitations(sqlite, config, snapshot, pageVersionId, citations, proposed.contentMarkdown);
    updateWikiSearchProjection(sqlite, pageId);
    queuePageEmbedding(sqlite, config, pageId, pageVersionId);
    sqlite.prepare("UPDATE agent_plan_items SET target_page_id=?,application_status='applied',applied_page_version_id=?,applied_at=?,updated_at=?,error_code=NULL,error_summary=NULL WHERE id=?").run(pageId, pageVersionId, timestamp, timestamp, row.id);
    if (proposed.nodeId) nodePageIds.set(proposed.nodeId, pageId);
    auditAgent(sqlite, "approve", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "applied", targetPageId: pageId, appliedPageVersionId: pageVersionId });
    return;
  }
  throw fail("unsupported plan item", "AGENT_PLAN_INVALID");
};

const branchRows = (sqlite, rootRow) => {
  const all = sqlite.prepare("SELECT * FROM agent_plan_items WHERE run_id=? ORDER BY ordinal,id").all(rootRow.run_id);
  const rootNodeId = planNode(rootRow).nodeId;
  if (!rootNodeId) return [rootRow];
  const result = [];
  const queue = [rootNodeId];
  const seen = new Set();
  while (queue.length) {
    const nodeId = queue.shift();
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const row = all.find((candidate) => planNode(candidate).nodeId === nodeId);
    if (!row) continue;
    result.push(row);
    for (const child of all) if (planNode(child).parentNodeId === nodeId) queue.push(planNode(child).nodeId);
  }
  return result.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
};

const pageBranchRows = (rows) => rows.filter((row) => ["page_create", "page_update"].includes(row.item_type));
const treeApplyOrder = (rows) => {
  const byNode = new Map(rows.map((row) => [planNode(row).nodeId, row]));
  const ordered = [];
  const remaining = new Set(rows);
  while (remaining.size) {
    let progressed = false;
    for (const row of [...remaining].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
      const parentNodeId = planNode(row).parentNodeId;
      if (parentNodeId && byNode.has(parentNodeId) && !ordered.some((candidate) => planNode(candidate).nodeId === parentNodeId)) continue;
      ordered.push(row);
      remaining.delete(row);
      progressed = true;
    }
    if (!progressed) throw fail("tree branch cannot be ordered because of a parent cycle", "AGENT_PLAN_INVALID");
  }
  return ordered;
};

export const approveAgentPlanBranch = (sqlite, config, itemId, { actor = "local-user", requestId = null } = {}) => {
  const root = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!root) throw fail("plan item was not found", "NOT_FOUND");
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(root.run_id);
  const snapshot = parseScopeSnapshot(run.scope_snapshot);
  const rows = treeApplyOrder(pageBranchRows(branchRows(sqlite, root)));
  if (!rows.length) return [approveAgentPlanItem(sqlite, config, itemId, { actor, requestId })];
  if (rows.some((row) => row.review_status !== "proposed" || row.application_status !== "pending")) throw fail("branch contains a reviewed or applied item", "AGENT_REVIEW_CONFLICT");
  if (rows.some((row) => row.evidence_status === "needs_evidence")) throw fail("branch contains a page that needs evidence", "AGENT_PLAN_INVALID");
  const nodePageIds = new Map();
  try {
    sqlite.transaction(() => {
      const timestamp = now();
      for (const row of rows) {
        sqlite.prepare("UPDATE agent_plan_items SET review_status='approved',decision_reason=NULL,decided_by=?,decided_at=?,updated_at=? WHERE id=? AND review_status='proposed' AND application_status='pending'").run(actor, timestamp, timestamp, row.id);
        applyItemInTransaction(sqlite, config, sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(row.id), requestId, { nodePageIds });
      }
      auditAgent(sqlite, "branch_approve", "agent_plan_item", root.id, requestId, { itemCount: rows.length, nodeId: planNode(root).nodeId || null });
    })();
  } catch (caught) {
    const status = caught.code === "AGENT_REVIEW_CONFLICT" || caught.code === "AGENT_PLAN_BLOCKED" ? "stale" : "apply_failed";
    try {
      sqlite.transaction(() => {
        const timestamp = now();
        for (const row of rows) {
          sqlite.prepare("UPDATE agent_plan_items SET review_status='approved',application_status=?,error_code=?,error_summary=?,decided_by=?,decided_at=?,updated_at=? WHERE id=? AND application_status='pending'").run(status, caught.code || "AGENT_APPLY_FAILED", String(caught.message || "branch application failed").slice(0, 500), actor, timestamp, timestamp, row.id);
          auditAgent(sqlite, status === "stale" ? "branch_stale" : "branch_apply_failed", "agent_plan_item", row.id, requestId, { applicationStatus: status, errorCode: caught.code || "AGENT_APPLY_FAILED" });
        }
      })();
    } catch {}
    throw caught;
  }
  return getAgentPlan(sqlite, root.run_id);
};

export const rejectAgentPlanBranch = (sqlite, itemId, { actor = "local-user", reason = "Rejected", requestId = null } = {}) => {
  const root = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!root) throw fail("plan item was not found", "NOT_FOUND");
  const rows = treeApplyOrder(pageBranchRows(branchRows(sqlite, root)));
  if (!rows.length) return [rejectAgentPlanItem(sqlite, itemId, { actor, reason, requestId })];
  if (rows.some((row) => row.review_status !== "proposed" || row.application_status !== "pending")) throw fail("branch contains a reviewed or applied item", "AGENT_REVIEW_CONFLICT");
  const decisionReason = String(reason || "Rejected").slice(0, 500);
  const timestamp = now();
  sqlite.transaction(() => {
    for (const row of rows) {
      sqlite.prepare("UPDATE agent_plan_items SET review_status='rejected',application_status='not_applicable',decision_reason=?,decided_by=?,decided_at=?,updated_at=? WHERE id=?").run(decisionReason, actor, timestamp, timestamp, row.id);
      auditAgent(sqlite, "branch_reject", "agent_plan_item", row.id, requestId, { applicationStatus: "not_applicable", reason: decisionReason });
    }
  })();
  return getAgentPlan(sqlite, root.run_id);
};

export const approveAgentPlanItem = (sqlite, config, itemId, { actor = "local-user", requestId = null } = {}) => {
  const row = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!row) throw fail("plan item was not found", "NOT_FOUND");
  if (row.review_status !== "proposed" || row.application_status !== "pending") throw fail("plan item has already been reviewed or applied", "AGENT_REVIEW_CONFLICT");
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(row.run_id);
  const snapshot = parseScopeSnapshot(run.scope_snapshot);
  if (snapshot.organizationMode === "tree" && ["page_create", "page_update"].includes(row.item_type)) {
    if (blockedByRejectedParent(sqlite, row)) throw fail("this page is blocked by a rejected or failed parent branch", "AGENT_PLAN_BLOCKED");
    const parentNodeId = planNode(row).parentNodeId;
    if (parentNodeId && !pageIdForAppliedNode(sqlite, row.run_id, parentNodeId)) throw fail("approve the parent branch before approving this page", "AGENT_PLAN_BLOCKED");
  }
  try {
    sqlite.transaction(() => {
      const timestamp = now();
      if (!sqlite.prepare("UPDATE agent_plan_items SET review_status='approved',decision_reason=NULL,decided_by=?,decided_at=?,updated_at=? WHERE id=? AND review_status='proposed' AND application_status='pending'").run(actor, timestamp, timestamp, itemId).changes) throw fail("plan item has already been reviewed or applied", "AGENT_REVIEW_CONFLICT");
      applyItemInTransaction(sqlite, config, sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId), requestId);
    })();
  } catch (caught) {
    const applicationStatus = caught.code === "AGENT_REVIEW_CONFLICT" ? "stale" : "apply_failed";
    try {
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE agent_plan_items SET review_status='approved',application_status=?,error_code=?,error_summary=?,updated_at=? WHERE id=? AND application_status='pending'").run(applicationStatus, caught.code || "AGENT_APPLY_FAILED", String(caught.message || "plan application failed").slice(0, 500), now(), itemId);
        auditAgent(sqlite, applicationStatus === "stale" ? "stale" : "apply_failed", "agent_plan_item", itemId, requestId, { applicationStatus, errorCode: caught.code || "AGENT_APPLY_FAILED" });
      })();
    } catch {}
    throw caught;
  }
  return agentPlanItemView(sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId));
};

export const rejectAgentPlanItem = (sqlite, itemId, { actor = "local-user", reason = "Rejected", requestId = null } = {}) => {
  const row = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!row) throw fail("plan item was not found", "NOT_FOUND");
  if (row.review_status !== "proposed" || row.application_status !== "pending") throw fail("plan item has already been reviewed or applied", "AGENT_REVIEW_CONFLICT");
  const timestamp = now();
  const decisionReason = String(reason || "Rejected").slice(0, 500);
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE agent_plan_items SET review_status='rejected',application_status='not_applicable',decision_reason=?,decided_by=?,decided_at=?,updated_at=? WHERE id=?").run(decisionReason, actor, timestamp, timestamp, itemId);
    auditAgent(sqlite, "reject", "agent_plan_item", itemId, requestId, { applicationStatus: "not_applicable", reason: decisionReason });
  })();
  return agentPlanItemView(sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId));
};

export const updateAgentPlanItem = (sqlite, config, itemId, input = {}, { actor = "local-user", requestId = null } = {}) => {
  const row = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!row) throw fail("plan item was not found", "NOT_FOUND");
  if (row.review_status !== "proposed" || row.application_status !== "pending") throw fail("only pending plan items can be edited", "AGENT_REVIEW_CONFLICT");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("plan item edit must be an object", "AGENT_PLAN_INVALID");
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(row.run_id);
  const snapshot = parseScopeSnapshot(run.scope_snapshot);
  const rows = sqlite.prepare("SELECT * FROM agent_plan_items WHERE run_id=? ORDER BY ordinal,id").all(row.run_id);
  const rawItems = rows.map((candidate) => ({ itemType: candidate.item_type, targetPageId: candidate.target_page_id, basePageVersionId: candidate.base_page_version_id, proposed: jsonParse(candidate.proposed_json, {}), citations: jsonParse(candidate.citations_json, []) }));
  const proposedPatch = input.proposed && typeof input.proposed === "object" && !Array.isArray(input.proposed) ? input.proposed : input;
  const forbidden = ["nodeId", "node_id"];
  if (forbidden.some((key) => Object.hasOwn(proposedPatch, key))) throw fail("nodeId cannot be changed after plan creation", "AGENT_PLAN_INVALID");
  const allowed = new Set(["title", "pageType", "page_type", "contentMarkdown", "content_markdown", "spaceId", "space_id", "parentNodeId", "parent_node_id", "nodeRole", "node_role", "operation", "mergePageIds", "merge_page_ids"]);
  if (Object.keys(proposedPatch).some((key) => !allowed.has(key))) throw fail("only proposed page fields can be edited", "AGENT_PLAN_INVALID");
  rawItems[row.ordinal] = {
    ...rawItems[row.ordinal],
    proposed: { ...rawItems[row.ordinal].proposed, ...proposedPatch },
    citations: input.citations === undefined ? rawItems[row.ordinal].citations : input.citations
  };
  const normalized = validatePlanOutput(sqlite, config, snapshot, { items: rawItems });
  const edited = normalized.items[row.ordinal];
  const timestamp = now();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE agent_plan_items SET proposed_json=?,citations_json=?,diff_json=?,risk=?,evidence_status=?,error_code=NULL,error_summary=NULL,updated_at=? WHERE id=? AND review_status='proposed' AND application_status='pending'").run(JSON.stringify(edited.proposed), JSON.stringify(edited.citations), edited.diff ? JSON.stringify(edited.diff) : null, edited.risk, edited.evidenceStatus, timestamp, row.id);
    auditAgent(sqlite, "edit", "agent_plan_item", row.id, requestId, { actor, evidenceStatus: edited.evidenceStatus, nodeId: edited.proposed.nodeId || null });
  })();
  return agentPlanItemView(sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(row.id));
};

export const approveAgentPlanBatch = (sqlite, config, itemIds, { actor = "local-user", requestId = null } = {}) => {
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 50) throw fail("tag batch must contain 1-50 items", "AGENT_PLAN_INVALID");
  const rows = itemIds.map((id) => sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(id));
  if (rows.some((row) => !row) || rows.some((row) => row.item_type !== "tag_add") || new Set(rows.map((row) => row.run_id)).size !== 1) throw fail("only tag_add items from one run can be approved as a batch", "AGENT_PLAN_INVALID");
  if (rows.some((row) => row.review_status !== "proposed" || row.application_status !== "pending")) throw fail("tag batch contains an item that is not pending", "AGENT_REVIEW_CONFLICT");
  const timestamp = now();
  sqlite.transaction(() => {
    for (const row of rows) {
      sqlite.prepare("UPDATE agent_plan_items SET review_status='approved',decided_by=?,decided_at=?,updated_at=? WHERE id=?").run(actor, timestamp, timestamp, row.id);
      applyItemInTransaction(sqlite, config, sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(row.id), requestId);
    }
  })();
  return itemIds.map((id) => agentPlanItemView(sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(id)));
};

export const rollbackAgentPlanItem = (sqlite, config, itemId, { actor = "local-user", requestId = null } = {}) => {
  const row = sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId);
  if (!row) throw fail("plan item was not found", "NOT_FOUND");
  if (row.application_status !== "applied") throw fail("only applied plan items can be rolled back", "AGENT_REVIEW_CONFLICT");
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(row.run_id);
  const timestamp = now();
  try {
    sqlite.transaction(() => {
      if (row.item_type === "page_update") {
        const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=? AND status='active'").get(row.target_page_id);
        if (!page || page.current_version_id !== row.applied_page_version_id) throw fail("page changed after application; rollback is stale", "AGENT_ROLLBACK_CONFLICT");
        const source = pageVersionFor(sqlite, page.id, row.base_page_version_id);
        if (!source) throw fail("original page version is unavailable", "AGENT_ROLLBACK_CONFLICT");
        const proposed = jsonParse(row.proposed_json, {});
        const rollbackMetadata = proposed.rollbackMetadata || {};
        const parentPageId = Object.hasOwn(rollbackMetadata, "parentPageId") ? assertParent(sqlite, run.knowledge_base_id, page.id, rollbackMetadata.parentPageId) : page.parent_page_id;
        const versionId = insertVersion(sqlite, { pageId: page.id, parentVersionId: page.current_version_id, templateVersionId: source.template_version_id, contentMarkdown: source.content_markdown, changeSummary: `Rollback agent plan ${row.id}`, restoreOfVersionId: row.applied_page_version_id, timestamp });
        copyCitations(sqlite, source.id, versionId, timestamp);
        sqlite.prepare("UPDATE wiki_pages SET title=?,page_type=?,space_id=?,parent_page_id=?,current_version_id=?,updated_at=? WHERE id=?").run(rollbackMetadata.title || page.title, rollbackMetadata.pageType || page.page_type, rollbackMetadata.spaceId ?? page.space_id, parentPageId, versionId, timestamp, page.id);
        updateWikiSearchProjection(sqlite, page.id);
        queuePageEmbedding(sqlite, config, page.id, versionId);
        sqlite.prepare("UPDATE agent_plan_items SET application_status='rolled_back',rollback_page_version_id=?,updated_at=? WHERE id=?").run(versionId, timestamp, row.id);
        auditAgent(sqlite, "rollback", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "rolled_back", rollbackPageVersionId: versionId });
      } else if (row.item_type === "page_create") {
        const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=?").get(row.target_page_id);
        if (!page || page.current_version_id !== row.applied_page_version_id) throw fail("created page changed after application; rollback is stale", "AGENT_ROLLBACK_CONFLICT");
        if (sqlite.prepare("SELECT id FROM wiki_pages WHERE parent_page_id=? AND status='active' LIMIT 1").get(page.id)) throw fail("created page has active children; roll back children first", "AGENT_ROLLBACK_CONFLICT");
        sqlite.prepare("UPDATE wiki_pages SET status='archived',updated_at=? WHERE id=?").run(timestamp, page.id);
        updateWikiSearchProjection(sqlite, page.id);
        sqlite.prepare("UPDATE agent_plan_items SET application_status='rolled_back',updated_at=? WHERE id=?").run(timestamp, row.id);
        auditAgent(sqlite, "rollback", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "rolled_back", targetPageId: page.id });
      } else if (row.item_type === "tag_add") {
        const proposed = jsonParse(row.proposed_json, {});
        sqlite.prepare("DELETE FROM wiki_page_tags WHERE page_id=? AND tag_id=?").run(row.target_page_id, proposed.tagId);
        sqlite.prepare("UPDATE agent_plan_items SET application_status='rolled_back',updated_at=? WHERE id=?").run(timestamp, row.id);
        auditAgent(sqlite, "rollback", "agent_plan_item", row.id, requestId, { itemType: row.item_type, applicationStatus: "rolled_back", targetPageId: row.target_page_id });
      } else throw fail("this finding has no database mutation to roll back", "AGENT_REVIEW_CONFLICT");
    })();
  } catch (caught) {
    throw caught;
  }
  return agentPlanItemView(sqlite.prepare("SELECT * FROM agent_plan_items WHERE id=?").get(itemId));
};

export const auditAgent = (sqlite, eventType, entityType, entityId, requestId, metadata = {}) => sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), eventType, entityType, entityId, requestId || null, JSON.stringify(metadata), now());

export const eventHash = hash;
