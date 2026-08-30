import crypto from "node:crypto";
import { readBytes, sha256 } from "./resources.js";
import { cosineSimilarity, createEmbeddingProvider } from "./embeddings.js";
import { estimateTokens, tokenizeText } from "./text-tokenizer.js";

export const RETRIEVAL_SCHEMA_VERSION = "sprint4-rag-retrieval-v1";
export const RETRIEVAL_DEFAULTS = Object.freeze({ wikiTopK: 5, rawTopK: 10, contextBudgetTokens: 8000, wikiBudgetRatio: 0.6, rawBudgetRatio: 0.4, maxTopK: 20, maxContextBudgetTokens: 50000 });
export const WIKI_SEED_GATE = Object.freeze({ minScore: 0.70, minMargin: 0.10 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with", "what", "which", "who", "how", "why"]);
const SYSTEM_PAGE_TYPES = new Set(["index", "log"]);
const fail = (message, code = "VALIDATION_ERROR") => Object.assign(new Error(message), { code });
const unique = (values) => [...new Set(values)];
const normalizeValue = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const jsonParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const safeJson = (value, fallback = {}) => { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } };
const tableExists = (sqlite, name) => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name));
const assertRetrievalIndexes = (sqlite) => {
  const required = ["resource_fts", "wiki_fts", "wiki_link_edges", "retrieval_embeddings", "retrieval_runs"];
  if (required.some((name) => !tableExists(sqlite, name))) throw fail("retrieval indexes are unavailable", "RETRIEVAL_INDEX_UNAVAILABLE");
};

export { tokenizeText } from "./text-tokenizer.js";

export const tokenizeQuery = (query) => {
  const normalized = normalizeValue(query);
  const parsed = tokenizeText(normalized);
  const englishTokens = parsed.words.filter((word) => !STOPWORDS.has(word));
  const stopwords = parsed.words.filter((word) => STOPWORDS.has(word));
  return { normalized, englishTokens: unique(englishTokens), cjkBigrams: parsed.cjkBigrams, stopwords: unique(stopwords), terms: unique([...englishTokens, ...parsed.cjkBigrams]) };
};

export const searchableText = (value) => {
  const source = String(value || "");
  const parsed = tokenizeText(source);
  return [source, parsed.words.join(" "), parsed.cjkBigrams.join(" ")].filter(Boolean).join("\n");
};

const quoteFts = (value) => `"${String(value).replaceAll("\"", "\"\"")}"`;
export const ftsQueryFor = (queryOrTokens) => {
  const tokens = typeof queryOrTokens === "string" ? tokenizeQuery(queryOrTokens) : queryOrTokens;
  return tokens.terms.length ? tokens.terms.map(quoteFts).join(" OR ") : null;
};

export { estimateTokens } from "./text-tokenizer.js";

const countBudgetTokens = (value, tokenizer = null) => tokenizer ? tokenizer.countTokens(value) : estimateTokens(value);

const truncateToTokens = (value, budget, tokenizer = null) => {
  const characters = Array.from(String(value || ""));
  if (budget <= 0) return "";
  if (countBudgetTokens(value, tokenizer) <= budget) return String(value || "");
  if (tokenizer) {
    let low = 0;
    let high = characters.length;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = characters.slice(0, middle).join("");
      if (countBudgetTokens(candidate, tokenizer) <= budget) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return characters.slice(0, best).join("");
  }
  const maxCharacters = Math.max(1, budget * 4);
  let result = characters.slice(0, maxCharacters).join("");
  while (result && countBudgetTokens(result, tokenizer) > budget) result = Array.from(result).slice(0, -1).join("");
  return result;
};

const scoreDocument = ({ title, content, tokens }) => {
  const titleParts = tokenizeText(title);
  const contentParts = tokenizeText(content);
  const titleTerms = new Set([...titleParts.words, ...titleParts.cjkBigrams]);
  const contentTerms = new Set([...contentParts.words, ...contentParts.cjkBigrams]);
  const matchedTerms = tokens.terms.filter((term) => contentTerms.has(term));
  const matchedTitleTerms = tokens.terms.filter((term) => titleTerms.has(term));
  const titleValue = normalizeValue(title);
  const contentValue = normalizeValue(content);
  const phraseHit = Boolean(tokens.normalized && (titleValue.includes(tokens.normalized) || contentValue.includes(tokens.normalized)));
  const titlePhraseHit = Boolean(tokens.normalized && titleValue.includes(tokens.normalized));
  const fullTextHit = tokens.terms.length > 0 && matchedTerms.length === tokens.terms.length;
  const coverage = tokens.terms.length ? matchedTerms.length / tokens.terms.length : 0;
  const titleCoverage = tokens.terms.length ? matchedTitleTerms.length / tokens.terms.length : 0;
  const normalizedScore = Math.min(1, 0.40 * coverage + 0.20 * titleCoverage + 0.25 * (phraseHit ? 1 : 0) + 0.15 * (fullTextHit ? 1 : 0));
  return {
    normalizedScore,
    matchedFeatures: {
      query: tokens.normalized,
      terms: tokens.terms,
      matchedTerms,
      missingTerms: tokens.terms.filter((term) => !matchedTerms.includes(term)),
      titleTerms: matchedTitleTerms,
      phrase: phraseHit,
      titlePhrase: titlePhraseHit,
      fullText: fullTextHit,
      coverage,
      titleCoverage,
      normalizedScore
    }
  };
};

const snippetFor = (content, tokens, size = 360) => {
  const source = String(content || "");
  if (Array.from(source).length <= size) return source;
  const normalized = normalizeValue(source);
  const term = tokens.terms.find((candidate) => normalized.indexOf(candidate) >= 0);
  const position = term ? normalized.indexOf(term) : 0;
  const start = Math.max(0, position - Math.floor(size / 3));
  const excerpt = Array.from(source).slice(start, start + size).join("");
  return `${start > 0 ? "…" : ""}${excerpt}${start + size < Array.from(source).length ? "…" : ""}`;
};

const blocksFor = (sqlite, pageVersionId) => sqlite.prepare("SELECT block_key,ordinal,heading_path,content_markdown FROM wiki_page_blocks WHERE page_version_id=? ORDER BY ordinal,id").all(pageVersionId);
const matchedBlockKeys = (sqlite, pageVersionId, tokens) => blocksFor(sqlite, pageVersionId).filter((block) => scoreDocument({ title: "", content: block.content_markdown, tokens }).matchedFeatures.matchedTerms.length).map((block) => block.block_key);

const pageResult = (sqlite, row, tokens, vectorScore = null) => {
  const score = scoreDocument({ title: row.page_title, content: row.content_markdown, tokens });
  const blockKeys = matchedBlockKeys(sqlite, row.page_version_id, tokens);
  return {
    id: row.page_id,
    pageId: row.page_id,
    pageVersionId: row.page_version_id,
    page: { id: row.page_id, title: row.page_title, slug: row.slug, pageType: row.page_type, spaceId: row.space_id, status: row.page_status, versionId: row.page_version_id },
    title: row.page_title,
    snippet: snippetFor(row.content_markdown, tokens),
    locator: { type: "wiki_page", pageId: row.page_id, pageVersionId: row.page_version_id, slug: row.slug, blockKeys },
    normalizedScore: score.normalizedScore,
    matchedFeatures: score.matchedFeatures,
    keywordScore: score.normalizedScore,
    vectorScore,
    _contentMarkdown: row.content_markdown,
    _source: "wiki"
  };
};

const rawResult = (sqlite, row, tokens, vectorScore = null) => {
  const content = [row.context_header, row.chunk_content].filter(Boolean).join("\n\n");
  const score = scoreDocument({ title: row.resource_title || row.resource_name, content, tokens });
  return {
    id: row.chunk_id,
    chunkId: row.chunk_id,
    resourceId: row.resource_id,
    resourceVersionId: row.resource_version_id,
    processingRunId: row.processing_run_id,
    resource: { id: row.resource_id, name: row.resource_name, versionId: row.resource_version_id, title: row.resource_title },
    content: row.chunk_content,
    parentContext: row.parent_content || null,
    contextHeader: row.context_header || null,
    locator: jsonParse(row.locator, { chunkId: row.chunk_id, resourceVersionId: row.resource_version_id }),
    snippet: snippetFor(row.chunk_content, tokens),
    normalizedScore: score.normalizedScore,
    matchedFeatures: score.matchedFeatures,
    keywordScore: score.normalizedScore,
    vectorScore,
    _source: "raw"
  };
};

const sortByScore = (left, right) => right.normalizedScore - left.normalizedScore || String(left.id).localeCompare(String(right.id));

const wikiKeywordRows = (sqlite, knowledgeBaseId, spaceId, ftsQuery) => {
  const clauses = ["f.content MATCH ?", "p.knowledge_base_id=?", "p.status='active'", "p.page_type NOT IN ('index','log')", "p.current_version_id=v.id", "f.page_id=p.id", "f.page_version_id=v.id"];
  const args = [ftsQuery, knowledgeBaseId];
  if (spaceId) { clauses.push("p.space_id=?"); args.push(spaceId); }
  return sqlite.prepare(`SELECT f.page_id,f.page_version_id,p.slug,p.space_id,p.page_type,p.status AS page_status,p.title AS page_title,v.content_markdown FROM wiki_fts f JOIN wiki_pages p ON p.id=f.page_id JOIN wiki_page_versions v ON v.id=f.page_version_id WHERE ${clauses.join(" AND ")} ORDER BY f.rowid LIMIT 200`).all(...args);
};

const rawKeywordRows = (sqlite, knowledgeBaseId, ftsQuery) => sqlite.prepare(`
  SELECT f.chunk_id,c.content AS chunk_content,c.context_header,c.locator,c.processing_run_id,
    p.content AS parent_content,r.id AS resource_id,r.name AS resource_name,rv.id AS resource_version_id,rv.title AS resource_title
  FROM resource_fts f
  JOIN chunks c ON c.id=f.chunk_id
  LEFT JOIN chunks p ON p.id=c.parent_chunk_id AND p.status='active'
  JOIN resource_versions rv ON rv.id=c.resource_version_id
  JOIN resources r ON r.id=rv.resource_id
  JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id
  JOIN processing_runs pr ON pr.id=c.processing_run_id
  WHERE f.content MATCH ? AND rkb.knowledge_base_id=? AND r.status<>'archived'
    AND r.current_version_id=rv.id AND rv.status='indexed' AND rv.active_processing_run_id=c.processing_run_id
    AND pr.status='indexed' AND c.chunk_type='text' AND c.status='active'
  ORDER BY f.rowid LIMIT 400
`).all(ftsQuery, knowledgeBaseId);

const wikiKeywordSearch = (sqlite, knowledgeBaseId, spaceId, tokens) => {
  const ftsQuery = ftsQueryFor(tokens);
  if (!ftsQuery) return [];
  return wikiKeywordRows(sqlite, knowledgeBaseId, spaceId, ftsQuery).map((row) => pageResult(sqlite, row, tokens)).sort(sortByScore);
};

const rawKeywordSearch = (sqlite, knowledgeBaseId, tokens) => {
  const ftsQuery = ftsQueryFor(tokens);
  if (!ftsQuery) return [];
  return rawKeywordRows(sqlite, knowledgeBaseId, ftsQuery).map((row) => rawResult(sqlite, row, tokens)).sort(sortByScore);
};

const vectorRowsForWiki = (sqlite, knowledgeBaseId, spaceId, provider) => {
  const clauses = ["e.owner_type='wiki_page'", "e.status='ready'", "e.provider=?", "e.model=?", "e.dimensions=?", "p.knowledge_base_id=?", "p.status='active'", "p.page_type NOT IN ('index','log')", "p.current_version_id=v.id", "e.page_version_id=v.id"];
  const args = [provider.provider, provider.model, provider.dimensions, knowledgeBaseId];
  if (spaceId) { clauses.push("p.space_id=?"); args.push(spaceId); }
  return sqlite.prepare(`SELECT e.vector_json,e.page_version_id,p.id AS page_id,p.slug,p.space_id,p.page_type,p.status AS page_status,p.title AS page_title,v.content_markdown FROM retrieval_embeddings e JOIN wiki_pages p ON p.id=e.owner_id JOIN wiki_page_versions v ON v.id=e.page_version_id WHERE ${clauses.join(" AND ")}`).all(...args);
};

const vectorRowsForRaw = (sqlite, knowledgeBaseId, provider) => sqlite.prepare(`
  SELECT e.vector_json,e.owner_id AS chunk_id,c.content AS chunk_content,c.context_header,c.locator,c.processing_run_id,
    p.content AS parent_content,r.id AS resource_id,r.name AS resource_name,rv.id AS resource_version_id,rv.title AS resource_title
  FROM retrieval_embeddings e
  JOIN chunks c ON c.id=e.owner_id
  LEFT JOIN chunks p ON p.id=c.parent_chunk_id AND p.status='active'
  JOIN resource_versions rv ON rv.id=e.resource_version_id AND rv.id=c.resource_version_id
  JOIN resources r ON r.id=rv.resource_id
  JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id
  JOIN processing_runs pr ON pr.id=c.processing_run_id
  WHERE e.owner_type='raw_chunk' AND e.status='ready' AND e.provider=? AND e.model=?
    AND rkb.knowledge_base_id=? AND e.dimensions=? AND r.status<>'archived' AND r.current_version_id=rv.id
    AND rv.status='indexed' AND rv.active_processing_run_id=c.processing_run_id AND pr.status='indexed'
    AND c.chunk_type='text' AND c.status='active'
`).all(provider.provider, provider.model, knowledgeBaseId, provider.dimensions);

const vectorSearch = (rows, builder, queryVector) => rows.map((row) => {
  const vector = jsonParse(row.vector_json, null);
  const similarity = cosineSimilarity(queryVector, vector);
  return similarity === null ? null : builder(row, similarity);
}).filter(Boolean).sort((left, right) => right.vectorScore - left.vectorScore || String(left.id).localeCompare(String(right.id))).slice(0, 200);

const mergeResults = (keywordResults, vectorResults, topK) => {
  const merged = new Map();
  keywordResults.forEach((result, index) => {
    merged.set(result.id, { ...result, keywordRank: index + 1, keywordScore: result.keywordScore ?? result.normalizedScore });
  });
  vectorResults.forEach((result, index) => {
    const current = merged.get(result.id);
    merged.set(result.id, current ? { ...current, vectorRank: index + 1, vectorScore: result.vectorScore } : { ...result, vectorRank: index + 1, keywordRank: null, keywordScore: null });
  });
  return [...merged.values()].map((result) => {
    const keywordPart = result.keywordRank ? 1 / (60 + result.keywordRank) : 0;
    const vectorPart = result.vectorRank ? 1 / (60 + result.vectorRank) : 0;
    return { ...result, keywordRank: result.keywordRank ?? null, vectorRank: result.vectorRank ?? null, rrfScore: keywordPart + vectorPart, normalizedScore: result.keywordScore ?? Math.max(0, Math.min(1, ((result.vectorScore ?? 0) + 1) / 2)) };
  }).sort((left, right) => right.rrfScore - left.rrfScore || right.normalizedScore - left.normalizedScore || String(left.id).localeCompare(String(right.id))).slice(0, topK).map((result, index) => ({ ...result, rank: index + 1 }));
};

const pageFromId = (sqlite, pageId) => sqlite.prepare("SELECT p.id,p.knowledge_base_id,p.space_id,p.slug,p.title,p.page_type,p.status,p.current_version_id,v.content_markdown FROM wiki_pages p LEFT JOIN wiki_page_versions v ON v.id=p.current_version_id WHERE p.id=?").get(pageId);

const graphExpansion = (sqlite, knowledgeBaseId, spaceId, seeds) => {
  const seedIds = new Set(seeds.map((seed) => seed.pageId));
  const seen = new Set(seeds.filter((seed) => seed.seedGate?.passed).map((seed) => seed.pageId));
  let frontier = seeds.filter((seed) => seed.seedGate?.passed).map((seed) => ({ pageId: seed.pageId, seedPageId: seed.pageId, seedScore: seed.normalizedScore, graphPath: [seed.pageId], path: [] }));
  const expanded = [];
  for (let hop = 1; hop <= 2 && frontier.length; hop += 1) {
    const decay = hop === 1 ? 0.5 : 0.25;
    const candidates = [];
    for (const node of frontier) {
      const rows = sqlite.prepare(`
        SELECT e.source_page_id,e.source_page_version_id,e.target_page_id,e.link_text,
          source.slug AS source_slug,source.title AS source_title,source.space_id AS source_space_id,
          source.page_type AS source_page_type,source.current_version_id AS source_version_id,
          target.slug AS target_slug,target.title AS target_title,target.space_id AS target_space_id,
          target.page_type AS target_page_type,target.status AS target_status,target.current_version_id AS target_version_id,
          target_version.content_markdown AS target_content
        FROM wiki_link_edges e
        JOIN wiki_pages source ON source.id=e.source_page_id
        JOIN wiki_pages target ON target.id=e.target_page_id
        LEFT JOIN wiki_page_versions target_version ON target_version.id=target.current_version_id
        WHERE source.knowledge_base_id=? AND target.knowledge_base_id=? AND source.status<>'archived' AND target.status<>'archived'
          AND source.page_type NOT IN ('index','log') AND target.page_type NOT IN ('index','log')
          AND e.source_page_version_id=source.current_version_id
          AND (e.source_page_id=? OR e.target_page_id=?) AND target.current_version_id IS NOT NULL
      `).all(knowledgeBaseId, knowledgeBaseId, node.pageId, node.pageId);
      for (const row of rows) {
        const outbound = row.source_page_id === node.pageId;
        const targetPageId = outbound ? row.target_page_id : row.source_page_id;
        const targetSpaceId = outbound ? row.target_space_id : row.source_space_id;
        const targetSlug = outbound ? row.target_slug : row.source_slug;
        const targetTitle = outbound ? row.target_title : row.source_title;
        const targetPageType = outbound ? row.target_page_type : row.source_page_type;
        const targetVersionId = outbound ? row.target_version_id : row.source_page_version_id;
        const targetContent = outbound ? row.target_content : null;
        if (seen.has(targetPageId) || (spaceId && targetSpaceId !== spaceId) || targetPageType === "log" || !targetVersionId) continue;
        const page = outbound ? { id: targetPageId, title: targetTitle, slug: targetSlug, pageType: targetPageType, spaceId: targetSpaceId, status: row.target_status, versionId: targetVersionId, contentMarkdown: targetContent } : pageFromId(sqlite, targetPageId);
        if (!page?.current_version_id && !page?.versionId) continue;
        candidates.push({ pageId: targetPageId, seedPageId: node.seedPageId, seedScore: node.seedScore, score: node.seedScore * decay, hop, decay, page, path: [...node.path, { sourcePageId: row.source_page_id, targetPageId: row.target_page_id, linkText: row.link_text, direction: outbound ? "outbound" : "inbound" }], graphPath: [...node.graphPath, targetPageId] });
      }
    }
    const bestByPage = new Map();
    for (const candidate of candidates) {
      const current = bestByPage.get(candidate.pageId);
      if (!current || candidate.score > current.score || (candidate.score === current.score && JSON.stringify(candidate.path) < JSON.stringify(current.path))) bestByPage.set(candidate.pageId, candidate);
    }
    const selected = [...bestByPage.values()].sort((left, right) => right.score - left.score || String(left.pageId).localeCompare(String(right.pageId))).slice(0, 10);
    for (const candidate of selected) {
      seen.add(candidate.pageId);
      const versionId = candidate.page.versionId || candidate.page.current_version_id;
      const content = candidate.page.contentMarkdown || candidate.page.content_markdown || "";
      if (!seedIds.has(candidate.pageId)) expanded.push({ id: candidate.pageId, pageId: candidate.pageId, pageVersionId: versionId, page: { id: candidate.pageId, title: candidate.page.title, slug: candidate.page.slug, pageType: candidate.page.pageType || candidate.page.page_type, spaceId: candidate.page.spaceId ?? candidate.page.space_id ?? null, status: candidate.page.status }, title: candidate.page.title, snippet: snippetFor(content, tokenizeQuery(candidate.page.title)), locator: { type: "wiki_page", pageId: candidate.pageId, pageVersionId: versionId, slug: candidate.page.slug }, score: candidate.score, normalizedScore: candidate.score, hop: candidate.hop, decay: candidate.decay, seedPageId: candidate.seedPageId, path: candidate.path, graphPath: candidate.graphPath, _contentMarkdown: content, _source: "wiki-graph" });
    }
    frontier = selected;
  }
  return expanded.map((result, index) => ({ ...result, rank: index + 1, seedPage: result.seedPageId }));
};

const provenanceFor = (sqlite, config, knowledgeBaseId, pages) => {
  const result = [];
  const seenPages = new Set();
  for (const page of pages) {
    if (seenPages.has(page.pageId)) continue;
    seenPages.add(page.pageId);
    const pageRow = pageFromId(sqlite, page.pageId);
    if (!pageRow?.current_version_id) continue;
    const citations = sqlite.prepare(`
      SELECT c.*,rv.id AS resource_version_id,r.id AS resource_id,r.name AS resource_name,r.current_version_id AS resource_current_version_id,rv.title AS resource_title,rv.mime_type,rv.byte_size,rv.content_sha256,rv.storage_key
      FROM wiki_citations c
      JOIN resource_versions rv ON rv.id=c.resource_version_id
      JOIN resources r ON r.id=rv.resource_id
      JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id
      WHERE c.page_version_id=? AND rkb.knowledge_base_id=? ORDER BY c.created_at,c.id
    `).all(pageRow.current_version_id, knowledgeBaseId);
    for (const citation of citations) {
      let integrity = "unavailable";
      try {
        const bytes = readBytes(config.resourceStorageDir, citation.storage_key);
        integrity = bytes.length === citation.byte_size && sha256(bytes) === citation.content_sha256 ? "valid" : "invalid";
      } catch {}
      result.push({ citationId: citation.id, pageId: pageRow.id, pageVersionId: pageRow.current_version_id, blockKey: citation.block_key, locator: jsonParse(citation.locator_json, {}), status: citation.status, staleReason: citation.stale_reason, source: { resourceId: citation.resource_id, resourceName: citation.resource_name, resourceVersionId: citation.resource_version_id, title: citation.resource_title, mimeType: citation.mime_type, byteSize: citation.byte_size, currentVersionId: citation.resource_current_version_id }, integrity, completeness: citation.status === "active" && integrity !== "invalid" ? "complete" : citation.status === "active" ? "unavailable" : citation.status, via: "provenance" });
    }
  }
  return result;
};

const pageContextItem = (sqlite, result, budget, tokens, type = "wiki_page", tokenizer = null) => {
  const page = result.page || {};
  const content = result._contentMarkdown ?? pageFromId(sqlite, result.pageId)?.content_markdown ?? "";
  const heading = `### Wiki · ${page.title || result.title || result.pageId}`;
  const full = `${heading}\n${content}`.trim();
  if (countBudgetTokens(full, tokenizer) <= budget) return { id: result.pageId, type, channel: "wiki", pageId: result.pageId, pageVersionId: result.pageVersionId, title: page.title || result.title, locator: result.locator, graphPath: result.graphPath || null, text: full, estimatedTokens: countBudgetTokens(full, tokenizer), truncated: false };
  const pageRow = pageFromId(sqlite, result.pageId);
  const blocks = pageRow?.current_version_id ? blocksFor(sqlite, pageRow.current_version_id) : [];
  const matching = blocks.filter((block) => scoreDocument({ title: "", content: block.content_markdown, tokens }).matchedFeatures.matchedTerms.length).map((block) => block.ordinal);
  const indexes = new Set();
  for (const ordinal of (matching.length ? matching : [0])) for (const index of [ordinal - 1, ordinal, ordinal + 1]) if (index >= 0 && index < blocks.length) indexes.add(index);
  const excerpt = [...indexes].sort((left, right) => left - right).map((index) => blocks[index].content_markdown).join("\n\n") || content;
  const fitted = truncateToTokens(`${heading}\n${excerpt}`, budget, tokenizer);
  return { id: result.pageId, type, channel: "wiki", pageId: result.pageId, pageVersionId: result.pageVersionId, title: page.title || result.title, locator: result.locator, graphPath: result.graphPath || null, text: fitted, estimatedTokens: countBudgetTokens(fitted, tokenizer), truncated: true };
};

const rawContextItem = (result, budget, tokenizer = null) => {
  const heading = `### Raw · ${result.resource?.name || result.resourceId}`;
  const contextHeader = result.contextHeader || "";
  const child = result.content || "";
  const parent = result.parentContext || "";
  const full = `${heading}\n${contextHeader ? `Context header:\n${contextHeader}\n\n` : ""}${parent ? `Parent context:\n${parent}\n\n` : ""}Child chunk:\n${child}`.trim();
  if (countBudgetTokens(full, tokenizer) <= budget) return { id: result.chunkId, type: "raw_chunk", channel: "raw", chunkId: result.chunkId, resourceId: result.resourceId, resourceVersionId: result.resourceVersionId, title: result.resource?.name, locator: result.locator, text: full, estimatedTokens: countBudgetTokens(full, tokenizer), truncated: false };
  const headingTokens = countBudgetTokens(`${heading}\n${contextHeader ? `Context header:\n${contextHeader}\n` : ""}Child chunk:\n`, tokenizer);
  const childFitted = truncateToTokens(child, Math.max(1, budget - headingTokens), tokenizer);
  let text = `${heading}\n${contextHeader ? `Context header:\n${contextHeader}\n` : ""}Child chunk:\n${childFitted}`;
  const remaining = budget - countBudgetTokens(text, tokenizer) - countBudgetTokens("\n\nParent context:\n", tokenizer);
  if (parent && remaining > 0) text += `\n\nParent context:\n${truncateToTokens(parent, remaining, tokenizer)}`;
  text = truncateToTokens(text, budget, tokenizer);
  return { id: result.chunkId, type: "raw_chunk", channel: "raw", chunkId: result.chunkId, resourceId: result.resourceId, resourceVersionId: result.resourceVersionId, title: result.resource?.name, locator: result.locator, text, estimatedTokens: countBudgetTokens(text, tokenizer), truncated: true };
};

export const assembleContext = (sqlite, { wikiResults, graphResults, rawResults, contextBudgetTokens, query, provenance = [], tokenizer = null }) => {
  const wikiBudgetTokens = Math.floor(contextBudgetTokens * RETRIEVAL_DEFAULTS.wikiBudgetRatio);
  const rawBudgetTokens = contextBudgetTokens - wikiBudgetTokens;
  const wikiItems = [];
  const rawItems = [];
  const truncatedItems = [];
  let wikiRemaining = wikiBudgetTokens;
  for (const result of [...wikiResults, ...graphResults]) {
    if (wikiItems.some((item) => item.pageId === result.pageId)) continue;
    const separatorTokens = wikiItems.length || rawItems.length ? countBudgetTokens("\n\n", tokenizer) : 0;
    if (wikiRemaining <= separatorTokens) { truncatedItems.push({ channel: "wiki", id: result.pageId, reason: "budget_exhausted" }); continue; }
    const item = { ...pageContextItem(sqlite, result, wikiRemaining - separatorTokens, tokenizeQuery(query), result._source === "wiki-graph" ? "wiki_graph_page" : "wiki_page", tokenizer), provenance: provenance.filter((entry) => entry.pageId === result.pageId) };
    if (!item.text) { truncatedItems.push({ channel: "wiki", id: result.pageId, reason: "budget_exhausted" }); continue; }
    wikiItems.push(item);
    wikiRemaining -= separatorTokens + item.estimatedTokens;
    if (item.truncated) truncatedItems.push({ channel: "wiki", id: item.id, reason: "page_truncated" });
  }
  let rawRemaining = rawBudgetTokens;
  for (const result of rawResults) {
    const separatorTokens = wikiItems.length || rawItems.length ? countBudgetTokens("\n\n", tokenizer) : 0;
    if (rawRemaining <= separatorTokens) { truncatedItems.push({ channel: "raw", id: result.chunkId, reason: "budget_exhausted" }); continue; }
    const item = { ...rawContextItem(result, rawRemaining - separatorTokens, tokenizer), provenance: [{ via: "raw", resourceId: result.resourceId, resourceVersionId: result.resourceVersionId, processingRunId: result.processingRunId, locator: result.locator }] };
    if (!item.text) { truncatedItems.push({ channel: "raw", id: result.chunkId, reason: "budget_exhausted" }); continue; }
    rawItems.push(item);
    rawRemaining -= separatorTokens + item.estimatedTokens;
    if (item.truncated) truncatedItems.push({ channel: "raw", id: item.id, reason: "chunk_truncated" });
  }
  const items = [...wikiItems, ...rawItems];
  const markdown = items.map((item) => item.text).join("\n\n");
  return { items, markdown, estimatedTokens: countBudgetTokens(markdown, tokenizer), tokenizer: tokenizer?.name || null, wikiBudgetTokens, rawBudgetTokens, wikiEstimatedTokens: wikiBudgetTokens - wikiRemaining, rawEstimatedTokens: rawBudgetTokens - rawRemaining, truncated: truncatedItems.length > 0, truncatedItems, query };
};

const applySeedGates = (results) => results.map((result, index) => {
  const score = result.keywordScore ?? result.normalizedScore ?? 0;
  const nextResult = results[index + 1];
  const nextScore = nextResult ? (nextResult.keywordScore ?? nextResult.normalizedScore ?? 0) : 0;
  const margin = score - nextScore;
  const passed = Boolean(result.keywordRank && score >= WIKI_SEED_GATE.minScore && margin >= WIKI_SEED_GATE.minMargin);
  const reason = passed ? "high_confidence" : score < WIKI_SEED_GATE.minScore ? "score_below_min" : "margin_below_min";
  return { ...result, seedGate: { passed, minScore: WIKI_SEED_GATE.minScore, minMargin: WIKI_SEED_GATE.minMargin, normalizedScore: score, neighborScore: nextScore, margin, reason } };
});

const publicPageResult = (result) => {
  const { _contentMarkdown, _source, ...publicResult } = result;
  return publicResult;
};
const publicWikiResult = publicPageResult;
const publicGraphResult = publicPageResult;
const publicRawResult = (result) => {
  const { _source, ...publicResult } = result;
  return publicResult;
};
const persistedRawResult = (result) => {
  const { content, parentContext, contextHeader, snippet, ...metadata } = result;
  return metadata;
};

export const normalizeRetrievalRequest = (body = {}) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("request body must be an object");
  const knowledgeBaseId = typeof (body.knowledgeBaseId ?? body.knowledge_base_id) === "string" ? String(body.knowledgeBaseId ?? body.knowledge_base_id).trim() : "";
  const spaceValue = body.spaceId ?? body.space_id;
  const spaceId = spaceValue === undefined || spaceValue === null || spaceValue === "" ? null : typeof spaceValue === "string" ? spaceValue.trim() : "";
  const query = typeof body.query === "string" ? body.query.normalize("NFKC").trim() : "";
  const number = (value, fallback, name, max) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw fail(`${name} must be an integer between 1 and ${max}`);
    return parsed;
  };
  if (!isUuid(knowledgeBaseId)) throw fail("knowledgeBaseId must be a UUID");
  if (spaceValue !== undefined && spaceId === "") throw fail("spaceId must be a non-empty string");
  if (spaceId !== null && !isUuid(spaceId)) throw fail("spaceId must be a UUID");
  if (!query || Array.from(query).length > 200) throw fail("query must be 1-200 characters");
  return { knowledgeBaseId, spaceId, query, wikiTopK: number(body.wikiTopK ?? body.wiki_top_k, RETRIEVAL_DEFAULTS.wikiTopK, "wikiTopK", RETRIEVAL_DEFAULTS.maxTopK), rawTopK: number(body.rawTopK ?? body.raw_top_k, RETRIEVAL_DEFAULTS.rawTopK, "rawTopK", RETRIEVAL_DEFAULTS.maxTopK), contextBudgetTokens: number(body.contextBudgetTokens ?? body.context_budget_tokens, RETRIEVAL_DEFAULTS.contextBudgetTokens, "contextBudgetTokens", RETRIEVAL_DEFAULTS.maxContextBudgetTokens) };
};

const persistRun = (sqlite, trace) => {
  const now = trace.metrics?.completedAt || new Date().toISOString();
  const replayTrace = { ...trace, raw: { ...trace.raw, results: (trace.raw?.results || []).map(persistedRawResult) } };
  sqlite.prepare(`INSERT INTO retrieval_runs (id,query,knowledge_base_id,space_id,wiki_top_k,raw_top_k,context_budget_tokens,wiki_budget_tokens,raw_budget_tokens,vector_enabled,vector_provider,vector_model,status,wiki_seeds,raw_seeds,graph_expansion,provenance_lookups,context_items,context_markdown,metrics,vector_status,trace_json,error_code,error_summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(trace.traceId, trace.query, trace.scope.knowledgeBaseId, trace.scope.spaceId, trace.limits.wikiTopK, trace.limits.rawTopK, trace.limits.contextBudgetTokens, trace.context.wikiBudgetTokens, trace.context.rawBudgetTokens, trace.vector.enabled ? 1 : 0, trace.vector.provider || null, trace.vector.model || null, trace.status || "succeeded", safeJson(trace.wiki.seeds, []), safeJson(replayTrace.raw.results, []), safeJson(trace.wiki.graphExpanded, []), safeJson(trace.provenance, []), safeJson(trace.context.items, []), trace.context.markdown || "", safeJson(trace.metrics, {}), safeJson(trace.vector, {}), safeJson(replayTrace), trace.error?.code || null, trace.error?.message || null, trace.metrics?.startedAt || now, now);
};

export const retrievalRunView = (row) => {
  if (!row) return null;
  const trace = jsonParse(row.trace_json, null);
  if (trace) {
    const replayTrace = { ...trace, raw: { ...trace.raw, results: (trace.raw?.results || []).map(persistedRawResult) } };
    return { ...replayTrace, traceId: trace.traceId || row.id, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, error: row.error_code ? { code: row.error_code, message: row.error_summary } : trace.error || null };
  }
  return { traceId: row.id, query: row.query, scope: { knowledgeBaseId: row.knowledge_base_id, spaceId: row.space_id, rawScope: "knowledge_base" }, status: row.status, wiki: { seeds: jsonParse(row.wiki_seeds, []), graphExpanded: jsonParse(row.graph_expansion, []) }, raw: { results: jsonParse(row.raw_seeds, []).map(persistedRawResult) }, provenance: jsonParse(row.provenance_lookups, []), context: { items: jsonParse(row.context_items, []), markdown: row.context_markdown, estimatedTokens: 0, truncated: false }, metrics: jsonParse(row.metrics, {}), vector: jsonParse(row.vector_status, {}), createdAt: row.created_at, updatedAt: row.updated_at };
};

export const getRetrievalRun = (sqlite, id) => retrievalRunView(sqlite.prepare("SELECT * FROM retrieval_runs WHERE id=?").get(id));

export const executeRetrieval = async ({ sqlite, config, input, onAudit = () => {} }) => {
  const request = normalizeRetrievalRequest(input);
  const knowledgeBase = sqlite.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(request.knowledgeBaseId);
  if (!knowledgeBase) throw fail("Knowledge base not found", "NOT_FOUND");
  if (request.spaceId && !sqlite.prepare("SELECT id FROM spaces WHERE id=? AND knowledge_base_id=? AND status='active'").get(request.spaceId, request.knowledgeBaseId)) throw fail("Space not found", "NOT_FOUND");
  const traceId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let embeddingProvider = null;
  const trace = { traceId, query: request.query, scope: { knowledgeBaseId: request.knowledgeBaseId, spaceId: request.spaceId, rawScope: "knowledge_base" }, limits: { wikiTopK: request.wikiTopK, rawTopK: request.rawTopK, contextBudgetTokens: request.contextBudgetTokens }, vector: { enabled: config.retrievalVectorEnabled !== false, provider: String(config.embeddingProvider || "mock"), model: String(config.embeddingModel || "mock-hash-v1"), status: config.retrievalVectorEnabled === false ? "disabled" : "pending", keywordFallback: true, durationMs: 0, error: null, tokenizer: null }, wiki: { seeds: [], graphExpanded: [] }, raw: { results: [] }, provenance: [], context: { items: [], markdown: "", estimatedTokens: 0, truncated: false, tokenizer: null, wikiBudgetTokens: Math.floor(request.contextBudgetTokens * 0.6), rawBudgetTokens: request.contextBudgetTokens - Math.floor(request.contextBudgetTokens * 0.6), wikiEstimatedTokens: 0, rawEstimatedTokens: 0, truncatedItems: [] }, metrics: { startedAt }, status: "succeeded", error: null };
  try {
    assertRetrievalIndexes(sqlite);
    const tokens = tokenizeQuery(request.query);
    trace.keyword = { normalizedQuery: tokens.normalized, englishTokens: tokens.englishTokens, cjkBigrams: tokens.cjkBigrams, stopwords: tokens.stopwords, operator: "OR", wiki: {}, raw: {} };
    let stage = Date.now();
    const wikiKeyword = wikiKeywordSearch(sqlite, request.knowledgeBaseId, request.spaceId, tokens);
    trace.metrics.keywordWikiMs = Date.now() - stage;
    trace.keyword.wiki = { candidateCount: wikiKeyword.length, terms: tokens.terms };
    stage = Date.now();
    const rawKeyword = rawKeywordSearch(sqlite, request.knowledgeBaseId, tokens);
    trace.metrics.keywordRawMs = Date.now() - stage;
    trace.keyword.raw = { candidateCount: rawKeyword.length, terms: tokens.terms };
    let wikiVector = [];
    let rawVector = [];
    if (trace.vector.enabled) {
      const providerStart = Date.now();
      try {
        embeddingProvider = createEmbeddingProvider(config);
        trace.vector.provider = embeddingProvider.provider;
        trace.vector.model = embeddingProvider.model;
        trace.vector.dimensions = embeddingProvider.dimensions;
        trace.vector.tokenizer = embeddingProvider.tokenizer?.name || null;
        const queryEmbedding = await embeddingProvider.embedText(request.query);
        trace.vector.requestedDimensions = queryEmbedding.requestedDimensions ?? embeddingProvider.dimensions;
        const vectorProvider = { ...embeddingProvider, dimensions: queryEmbedding.dimensions };
        trace.vector.dimensions = queryEmbedding.dimensions;
        wikiVector = vectorSearch(vectorRowsForWiki(sqlite, request.knowledgeBaseId, request.spaceId, vectorProvider), (row, score) => pageResult(sqlite, row, tokens, score), queryEmbedding.vector);
        rawVector = vectorSearch(vectorRowsForRaw(sqlite, request.knowledgeBaseId, vectorProvider), (row, score) => rawResult(sqlite, row, tokens, score), queryEmbedding.vector);
        trace.vector.status = wikiVector.length || rawVector.length ? "used" : "no_embeddings";
        trace.vector.keywordFallback = false;
      } catch (caught) {
        if (caught?.code === "EMBEDDING_EGRESS_BLOCKED") throw caught;
        trace.vector.status = caught.code === "EMBEDDING_DISABLED" ? "disabled" : "degraded";
        trace.vector.error = { code: caught.code || "EMBEDDING_FAILED", message: caught.message || "embedding provider failed" };
      }
      trace.vector.durationMs = Date.now() - providerStart;
      trace.metrics.vectorMs = trace.vector.durationMs;
    } else trace.metrics.vectorMs = 0;
    const mergedWiki = mergeResults(wikiKeyword, wikiVector, request.wikiTopK);
    const mergedRaw = mergeResults(rawKeyword, rawVector, request.rawTopK);
    const gatedSeeds = applySeedGates(mergedWiki);
    trace.wiki.seeds = gatedSeeds.map(publicWikiResult);
    trace.raw.results = mergedRaw.map(publicRawResult);
    stage = Date.now();
    const graph = graphExpansion(sqlite, request.knowledgeBaseId, request.spaceId, gatedSeeds);
    trace.wiki.graphExpanded = graph.map(publicGraphResult);
    trace.metrics.graphMs = Date.now() - stage;
    stage = Date.now();
    trace.provenance = provenanceFor(sqlite, config, request.knowledgeBaseId, [...gatedSeeds, ...graph]);
    trace.metrics.provenanceMs = Date.now() - stage;
    stage = Date.now();
    trace.context = assembleContext(sqlite, { wikiResults: gatedSeeds, graphResults: graph, rawResults: mergedRaw, contextBudgetTokens: request.contextBudgetTokens, query: request.query, provenance: trace.provenance, tokenizer: embeddingProvider?.tokenizer || null });
    trace.metrics.contextMs = Date.now() - stage;
    trace.metrics.completedAt = new Date().toISOString();
    trace.metrics.durationMs = Date.now() - Date.parse(startedAt);
    persistRun(sqlite, trace);
  } catch (caught) {
    trace.status = "failed";
    trace.error = { code: caught.code || "INTERNAL_ERROR", message: caught.message || "retrieval failed" };
    trace.metrics.completedAt = new Date().toISOString();
    trace.metrics.durationMs = Date.now() - Date.parse(startedAt);
    let persistenceError = null;
    try { persistRun(sqlite, trace); } catch (persistCaught) { persistenceError = persistCaught; }
    let auditError = null;
    try { onAudit("retrieval_failed", trace, null); } catch (auditCaught) { auditError = auditCaught; }
    if (persistenceError || auditError) {
      const message = persistenceError ? "retrieval trace could not be persisted" : "retrieval failure audit could not be recorded";
      throw Object.assign(fail(message, "INTERNAL_ERROR"), { traceId, cause: caught, persistenceError, auditError });
    }
    throw Object.assign(caught, { traceId });
  }
  try { onAudit("retrieval_completed", trace, null); }
  catch (auditError) { throw Object.assign(fail("retrieval audit could not be recorded", "INTERNAL_ERROR"), { traceId, cause: auditError }); }
  return trace;
};

const linkTargets = (markdown) => {
  const source = String(markdown || "");
  const links = [];
  const covered = [];
  const markdownLink = /\[([^\]]*)\]\(\s*wiki:\/\/([0-9a-f-]{36})(?:#[^)]*)?\s*\)/gi;
  for (const match of source.matchAll(markdownLink)) {
    links.push({ targetPageId: match[2].toLowerCase(), linkText: match[1].trim() || `wiki://${match[2]}` });
    covered.push([match.index, match.index + match[0].length]);
  }
  const bareLink = /wiki:\/\/([0-9a-f-]{36})/gi;
  for (const match of source.matchAll(bareLink)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    links.push({ targetPageId: match[1].toLowerCase(), linkText: match[0] });
  }
  return links;
};

export const wikiLinkTargetsFromMarkdown = linkTargets;

const insertWikiProjection = (sqlite, page) => {
  if (!page?.current_version_id || page.status !== "active" || SYSTEM_PAGE_TYPES.has(page.page_type)) return { indexed: false, edges: 0 };
  const version = sqlite.prepare("SELECT content_markdown FROM wiki_page_versions WHERE id=? AND page_id=?").get(page.current_version_id, page.id);
  if (!version) return { indexed: false, edges: 0 };
  sqlite.prepare("INSERT INTO wiki_fts (page_id,page_version_id,title,content) VALUES (?,?,?,?)").run(page.id, page.current_version_id, page.title, searchableText(`${page.title}\n${version.content_markdown}`));
  let edges = 0;
  for (const link of linkTargets(version.content_markdown)) {
    const target = sqlite.prepare("SELECT id FROM wiki_pages WHERE id=? AND knowledge_base_id=? AND status<>'archived' AND page_type NOT IN ('index','log')").get(link.targetPageId, page.knowledge_base_id);
    if (!target || target.id === page.id) continue;
    edges += sqlite.prepare("INSERT OR IGNORE INTO wiki_link_edges (source_page_id,source_page_version_id,target_page_id,link_text) VALUES (?,?,?,?)").run(page.id, page.current_version_id, target.id, link.linkText).changes;
  }
  return { indexed: true, edges };
};

export const updateWikiSearchProjection = (sqlite, pageId) => {
  if (!tableExists(sqlite, "wiki_fts")) throw fail("Wiki FTS index is unavailable", "RETRIEVAL_INDEX_UNAVAILABLE");
  const page = sqlite.prepare("SELECT * FROM wiki_pages WHERE id=?").get(pageId);
  sqlite.prepare("DELETE FROM wiki_fts WHERE page_id=?").run(pageId);
  sqlite.prepare("DELETE FROM wiki_link_edges WHERE source_page_id=?").run(pageId);
  return insertWikiProjection(sqlite, page);
};

export const rebuildRetrievalIndexes = (sqlite) => {
  assertRetrievalIndexes(sqlite);
  return sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM wiki_fts").run();
    sqlite.prepare("DELETE FROM wiki_link_edges").run();
    sqlite.prepare("DELETE FROM resource_fts").run();
    const rawInsert = sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)");
    const rawRows = sqlite.prepare(`SELECT c.id,c.content,c.context_header,rv.title FROM chunks c JOIN resource_versions rv ON rv.id=c.resource_version_id JOIN resources r ON r.id=rv.resource_id JOIN processing_runs pr ON pr.id=c.processing_run_id WHERE c.chunk_type='text' AND c.status='active' AND r.status<>'archived' AND r.current_version_id=rv.id AND rv.status='indexed' AND rv.active_processing_run_id=c.processing_run_id AND pr.status='indexed'`).all();
    for (const row of rawRows) rawInsert.run(row.id, searchableText([row.context_header, row.content].filter(Boolean).join("\n\n")), row.title || "");
    const pages = sqlite.prepare("SELECT * FROM wiki_pages WHERE status='active' AND page_type NOT IN ('index','log') AND current_version_id IS NOT NULL ORDER BY id").all();
    let wikiCount = 0;
    let edgeCount = 0;
    for (const page of pages) {
      const projection = insertWikiProjection(sqlite, page);
      if (projection.indexed) wikiCount += 1;
      edgeCount += projection.edges;
    }
    if (tableExists(sqlite, "schema_meta")) sqlite.prepare("INSERT INTO schema_meta (key,value,updated_at) VALUES ('derived_schema','sprint6-personal-derived-ready',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(new Date().toISOString());
    const embeddings = sqlite.prepare("SELECT count(*) AS count FROM retrieval_embeddings WHERE status='ready'").get()?.count || 0;
    return { rawRows: rawRows.length, wikiRows: wikiCount, linkEdges: edgeCount, embeddings };
  })();
};

const taskPayload = (sqlite, taskId) => sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
const embeddingTaskKey = (ownerType, ownerId, versionKey) => `${ownerType}\u0000${ownerId}\u0000${versionKey}`;
export const createEmbeddingTaskCache = (sqlite) => {
  const cache = new Map();
  const active = sqlite.prepare("SELECT id,payload FROM tasks WHERE type='retrieval:embed' AND status IN ('queued','running','retrying')").all();
  for (const task of active) {
    const payload = jsonParse(task.payload, null);
    if (payload?.ownerType && payload.ownerId && payload.versionKey) cache.set(embeddingTaskKey(payload.ownerType, payload.ownerId, payload.versionKey), task.id);
  }
  return cache;
};

export const queueEmbeddingTask = (sqlite, { ownerType, ownerId, pageVersionId = null, resourceVersionId = null, processingRunId = null, reason = "derived-index", activeTaskCache = null }) => {
  if (!new Set(["wiki_page", "raw_chunk"]).has(ownerType) || typeof ownerId !== "string" || !ownerId) throw fail("embedding owner is invalid", "VALIDATION_ERROR");
  if ((ownerType === "wiki_page" && !pageVersionId) || (ownerType === "raw_chunk" && (!resourceVersionId || !processingRunId))) throw fail("embedding version and processing run are required", "VALIDATION_ERROR");
  const versionKey = pageVersionId || resourceVersionId;
  const key = embeddingTaskKey(ownerType, ownerId, versionKey);
  const cachedTaskId = activeTaskCache?.get(key);
  if (cachedTaskId) return taskPayload(sqlite, cachedTaskId);
  if (!activeTaskCache) {
    // ponytail: single-item callers scan active task payloads; batch callers pass a cache. Add indexed task identity columns when cross-process queue volume exceeds the local-MVP ceiling.
    const active = sqlite.prepare("SELECT id,payload FROM tasks WHERE type='retrieval:embed' AND status IN ('queued','running','retrying') ORDER BY created_at DESC,id DESC").all();
    for (const task of active) {
      const payload = jsonParse(task.payload, {});
      if (payload.ownerType === ownerType && payload.ownerId === ownerId && payload.versionKey === versionKey) return taskPayload(sqlite, task.id);
    }
  }
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const payload = { reason, ownerType, ownerId, versionKey, pageVersionId, resourceVersionId, processingRunId };
  sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,?,'queued',0,3,0,?,?)").run(id, "retrieval:embed", ownerType === "raw_chunk" ? resourceVersionId : null, JSON.stringify(payload), timestamp, timestamp);
  activeTaskCache?.set(key, id);
  return taskPayload(sqlite, id);
};

export const ensurePendingEmbeddingTasks = (sqlite, reason = "startup", config = null) => {
  let queued = 0;
  const activeTaskCache = createEmbeddingTaskCache(sqlite);
  const queueIfMissing = (input) => {
    const versionKey = input.pageVersionId || input.resourceVersionId;
    const existing = config
      ? sqlite.prepare("SELECT id FROM retrieval_embeddings WHERE owner_type=? AND owner_id=? AND version_key=? AND provider=? AND model=? AND dimensions=? AND status='ready' LIMIT 1").get(input.ownerType, input.ownerId, versionKey, config.embeddingProvider || "mock", config.embeddingModel || "mock-hash-v1", Number(config.embeddingDimensions || 32))
      : sqlite.prepare("SELECT id FROM retrieval_embeddings WHERE owner_type=? AND owner_id=? AND version_key=? AND status='ready' LIMIT 1").get(input.ownerType, input.ownerId, versionKey);
    if (existing) return;
    const before = activeTaskCache.size;
    queueEmbeddingTask(sqlite, { ...input, activeTaskCache });
    if (activeTaskCache.size > before) queued += 1;
  };
  for (const row of sqlite.prepare("SELECT p.id,p.current_version_id FROM wiki_pages p WHERE p.status='active' AND p.page_type NOT IN ('index','log') AND p.current_version_id IS NOT NULL").all()) queueIfMissing({ ownerType: "wiki_page", ownerId: row.id, pageVersionId: row.current_version_id, reason });
  for (const row of sqlite.prepare("SELECT c.id,c.resource_version_id,c.processing_run_id FROM chunks c JOIN resource_versions rv ON rv.id=c.resource_version_id JOIN resources r ON r.id=rv.resource_id WHERE c.chunk_type='text' AND c.status='active' AND rv.status='indexed' AND rv.active_processing_run_id=c.processing_run_id AND r.current_version_id=rv.id AND r.status<>'archived'").all()) queueIfMissing({ ownerType: "raw_chunk", ownerId: row.id, resourceVersionId: row.resource_version_id, processingRunId: row.processing_run_id, reason });
  return queued;
};

export const persistEmbedding = (sqlite, { ownerType, ownerId, pageVersionId = null, resourceVersionId = null, processingRunId = null, provider, model, inputSha256 = null, vector = null, errorCode = null, errorSummary = null }) => {
  const versionKey = pageVersionId || resourceVersionId;
  const status = vector ? "ready" : "failed";
  const values = { id: crypto.randomUUID(), ownerType, ownerId, versionKey, pageVersionId, resourceVersionId, processingRunId, provider: provider || "unknown", model: model || "unknown", dimensions: vector?.length || 0, inputSha256, vectorJson: vector ? JSON.stringify(vector) : null, status, errorSummary: errorSummary ? `${errorCode ? `${errorCode}: ` : ""}${String(errorSummary).slice(0, 500)}` : null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  sqlite.prepare(`INSERT INTO retrieval_embeddings (id,owner_type,owner_id,version_key,page_version_id,resource_version_id,processing_run_id,provider,model,dimensions,input_sha256,vector_json,status,error_summary,created_at,updated_at) VALUES (@id,@ownerType,@ownerId,@versionKey,@pageVersionId,@resourceVersionId,@processingRunId,@provider,@model,@dimensions,@inputSha256,@vectorJson,@status,@errorSummary,@createdAt,@updatedAt) ON CONFLICT(owner_type,owner_id,version_key,provider,model) DO UPDATE SET input_sha256=CASE WHEN excluded.status='ready' THEN excluded.input_sha256 ELSE retrieval_embeddings.input_sha256 END,dimensions=CASE WHEN excluded.status='ready' THEN excluded.dimensions ELSE retrieval_embeddings.dimensions END,vector_json=CASE WHEN excluded.status='ready' THEN excluded.vector_json ELSE retrieval_embeddings.vector_json END,status=CASE WHEN excluded.status='ready' THEN excluded.status ELSE retrieval_embeddings.status END,error_summary=excluded.error_summary,updated_at=excluded.updated_at`).run(values);
  return sqlite.prepare("SELECT * FROM retrieval_embeddings WHERE owner_type=? AND owner_id=? AND version_key=? AND provider=? AND model=?").get(ownerType, ownerId, versionKey, values.provider, values.model);
};
