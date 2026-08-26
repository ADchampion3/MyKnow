import crypto from "node:crypto";
import { readBytes, sha256 } from "./resources.js";
import { normalizeCanonicalText } from "./chunker.js";

export const WIKI_PAGE_TYPES = ["concept", "entity", "source-summary", "synthesis"];
export const WIKI_SYSTEM_PAGE_TYPES = ["index", "log"];
export const WIKI_CITATION_STATUSES = ["active", "needs_review", "broken"];

const defaultDefinitions = {
  concept: {
    sections: [
      { title: "Definition", required: true, description: "What this concept means." },
      { title: "Context", required: false, description: "Useful context and boundaries." },
      { title: "Evidence", required: false, description: "Claims and supporting citations." }
    ]
  },
  entity: {
    sections: [
      { title: "Overview", required: true, description: "A concise description of the entity." },
      { title: "Attributes", required: false, description: "Important properties or relationships." },
      { title: "Evidence", required: false, description: "Claims and supporting citations." }
    ]
  },
  "source-summary": {
    sections: [
      { title: "Summary", required: true, description: "A faithful summary of the source." },
      { title: "Key points", required: false, description: "The most useful points from the source." },
      { title: "Limitations", required: false, description: "Known gaps, caveats, or uncertainty." }
    ]
  },
  synthesis: {
    sections: [
      { title: "Question", required: true, description: "The question or problem this page addresses." },
      { title: "Answer", required: true, description: "The synthesized answer." },
      { title: "Evidence", required: true, description: "Supporting sources and reasoning." },
      { title: "Alternatives", required: false, description: "Competing explanations or approaches." },
      { title: "Open questions", required: false, description: "What remains unresolved." },
      { title: "Next steps", required: false, description: "Useful follow-up actions." }
    ]
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const defaultTemplateDefinition = (pageType) => {
  if (!WIKI_PAGE_TYPES.includes(pageType)) throw new Error("invalid wiki page type");
  return clone(defaultDefinitions[pageType]);
};

export const normalizeWikiMode = (value, { nullable = false } = {}) => {
  if (value === undefined || value === null || value === "") return nullable ? null : "enabled";
  if (value === "enabled" || value === "wiki-enabled" || value === "wiki_enabled") return "enabled";
  if (value === "retrieval-only" || value === "retrieval_only" || value === "retrievalOnly") return "retrieval_only";
  throw new Error("wiki mode must be enabled or retrieval-only");
};

export const externalWikiMode = (value) => value === "retrieval_only" ? "retrieval-only" : "enabled";

export const normalizePageType = (value) => {
  if (typeof value !== "string" || !WIKI_PAGE_TYPES.includes(value)) throw new Error("pageType must be concept, entity, source-summary, or synthesis");
  return value;
};

export const normalizeSlug = (value) => {
  if (typeof value !== "string") throw new Error("slug must be a string");
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/.test(slug)) throw new Error("slug must use lowercase letters, numbers, and hyphens");
  return slug;
};

export const slugFromTitle = (title, suffix = "") => {
  const base = String(title || "page").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "page";
  return normalizeSlug(`${base}${suffix ? `-${suffix}` : ""}`.slice(0, 160).replace(/-+$/, ""));
};

export const normalizeTemplateDefinition = (value, pageType) => {
  normalizePageType(pageType);
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.sections)) throw new Error("template definition must contain a sections array");
  if (value.sections.length > 32) throw new Error("template may contain at most 32 sections");
  const seen = new Set();
  const sections = value.sections.map((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error("template sections must be objects");
    const title = typeof section.title === "string" ? section.title.trim() : "";
    if (!title || title.length > 160) throw new Error("template section title must be 1-160 characters");
    const key = title.toLowerCase();
    if (seen.has(key)) throw new Error("template section titles must be unique");
    seen.add(key);
    if (section.required !== undefined && typeof section.required !== "boolean") throw new Error("template section required must be boolean");
    const description = section.description === undefined ? "" : String(section.description).trim();
    if (description.length > 500) throw new Error("template section description is too long");
    return { title, required: section.required === true, description };
  });
  return { sections };
};

export const templateMarkdown = (title, definition) => [
  `# ${title}`,
  ...definition.sections.flatMap((section) => ["", `## ${section.title}`, "", section.required ? `<!-- Required: ${section.description || section.title} -->` : `<!-- Optional: ${section.description || section.title} -->`, ""])
].join("\n").trimEnd() + "\n";

const blockKeyFor = (blockType, headingPath, ordinal) => digest(JSON.stringify({ blockType, headingPath, ordinal })).slice(0, 32);

export const parseMarkdownBlocks = (markdown) => {
  const source = String(markdown);
  const lines = source.split("\n");
  const blocks = [];
  let offset = 0;
  let current = null;
  const headingStack = [];
  const close = (endOffset) => {
    if (!current) return;
    const content = source.slice(current.startOffset, endOffset);
    const block = {
      blockType: current.blockType,
      ordinal: blocks.length,
      headingPath: current.headingPath,
      contentMarkdown: content,
      contentSha256: digest(content)
    };
    block.blockKey = blockKeyFor(block.blockType, block.headingPath, block.ordinal);
    blocks.push(block);
    current = null;
  };
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length + (offset + line.length < source.length ? 1 : 0);
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      close(lineStart);
      const depth = heading[1].length;
      headingStack.length = depth - 1;
      headingStack[depth - 1] = heading[2].trim();
      headingStack.length = depth;
      current = { startOffset: lineStart, blockType: "heading", headingPath: [...headingStack] };
    } else if (!current && line.trim()) {
      current = { startOffset: lineStart, blockType: "markdown", headingPath: [...headingStack] };
    }
    offset = lineEnd;
  }
  close(source.length);
  if (!blocks.length) {
    const content = source;
    blocks.push({ blockKey: blockKeyFor("markdown", [], 0), blockType: "markdown", ordinal: 0, headingPath: [], contentMarkdown: content, contentSha256: digest(content) });
  }
  return blocks;
};

export const parseJsonObject = (value, label) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} must be an object`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${label} must be valid JSON object`);
  }
};

export const normalizeCitationLocator = (value, { sourceLength = null, pageCount = null } = {}) => {
  const locator = parseJsonObject(value, "locator");
  const recognized = ["chunkId", "startOffset", "endOffset", "page", "pageStart", "pageEnd", "pages", "lineStart", "lineEnd", "blockId", "selector"];
  if (!recognized.some((key) => Object.hasOwn(locator, key))) throw new Error("locator must include a source position");
  if (Object.keys(locator).some((key) => !recognized.includes(key))) throw new Error("locator contains an unsupported field");
  for (const key of ["startOffset", "endOffset", "page", "pageStart", "pageEnd", "lineStart", "lineEnd"]) {
    if (locator[key] !== undefined && (!Number.isInteger(locator[key]) || locator[key] < 0)) throw new Error(`locator.${key} must be a non-negative integer`);
  }
  for (const key of ["page", "pageStart", "pageEnd"]) {
    if (locator[key] !== undefined && locator[key] < 1) throw new Error(`locator.${key} must be a positive integer`);
  }
  if (locator.startOffset !== undefined || locator.endOffset !== undefined) {
    if (!Number.isInteger(locator.startOffset) || !Number.isInteger(locator.endOffset) || locator.endOffset <= locator.startOffset) throw new Error("locator offsets must be an increasing range");
    if (sourceLength !== null && locator.endOffset > sourceLength) throw new Error("locator offsets exceed the source length");
  }
  if (locator.pageStart !== undefined && locator.pageEnd !== undefined && locator.pageEnd < locator.pageStart) throw new Error("locator page range is invalid");
  if (locator.pages !== undefined && (!Array.isArray(locator.pages) || locator.pages.some((page) => !Number.isInteger(page) || page < 1))) throw new Error("locator.pages must contain positive integers");
  if (pageCount !== null && [locator.page, locator.pageStart, locator.pageEnd, ...(locator.pages || [])].filter((page) => page !== undefined).some((page) => page > pageCount)) throw new Error("locator page exceeds the source page count");
  if (locator.chunkId !== undefined && (typeof locator.chunkId !== "string" || !locator.chunkId.trim())) throw new Error("locator.chunkId must be a string");
  if (locator.blockId !== undefined && (typeof locator.blockId !== "string" || !locator.blockId.trim())) throw new Error("locator.blockId must be a string");
  if (locator.selector !== undefined && (typeof locator.selector !== "string" || !locator.selector.trim() || locator.selector.length > 1000)) throw new Error("locator.selector must be a non-empty string up to 1000 characters");
  return locator;
};

export const citationSourceBounds = ({ sqlite, resourceVersion, resourceStorageDir }) => {
  const isText = resourceVersion.mime_type.startsWith("text/");
  let sourceLength = null;
  let pageCount = null;
  let sourceIntegrity = "unavailable";
  let canonicalIntegrity = "unavailable";
  try {
    const bytes = readBytes(resourceStorageDir, resourceVersion.storage_key);
    sourceIntegrity = bytes.length === resourceVersion.byte_size && sha256(bytes) === resourceVersion.content_sha256 ? "valid" : "invalid";
    if (sourceIntegrity === "valid" && isText) sourceLength = Array.from(normalizeCanonicalText(bytes.toString("utf8"))).length;
  } catch {}
  const run = resourceVersion.active_processing_run_id ? sqlite.prepare("SELECT canonical_storage_key,canonical_sha256,canonical_byte_size,page_count FROM processing_runs WHERE id=? AND resource_version_id=? AND status='indexed'").get(resourceVersion.active_processing_run_id, resourceVersion.id) : null;
  if (run?.page_count > 0) pageCount = run.page_count;
  if (run?.canonical_storage_key) {
    canonicalIntegrity = "invalid";
    try {
      const bytes = readBytes(resourceStorageDir, run.canonical_storage_key);
      if (bytes.length === run.canonical_byte_size && sha256(bytes) === run.canonical_sha256) {
        const artifact = JSON.parse(bytes.toString("utf8"));
        canonicalIntegrity = "valid";
        if (!isText && typeof artifact.canonicalText === "string") sourceLength = Array.from(artifact.canonicalText).length;
        if (Array.isArray(artifact.pages) && artifact.pages.length) pageCount = artifact.pages.length;
      }
    } catch {}
  }
  if (pageCount === null && isText && sourceLength !== null) pageCount = 1;
  return { sourceLength, pageCount, sourceIntegrity, canonicalIntegrity };
};

const lineDiff = (before, after) => {
  const left = String(before || "").split("\n");
  const right = String(after || "").split("\n");
  // ponytail: the LCS table is capped for the local MVP; a streaming diff is the upgrade path for very large pages.
  if (left.length * right.length > 4_000_000) return { lines: [...left.map((value) => ({ type: "removed", value })), ...right.map((value) => ({ type: "added", value }))] };
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { lines.push({ type: "context", value: left[i] }); i += 1; j += 1; }
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) { lines.push({ type: "added", value: right[j] }); j += 1; }
    else { lines.push({ type: "removed", value: left[i] }); i += 1; }
  }
  return { lines };
};

export const diffMarkdown = (before, after) => {
  const diff = lineDiff(before, after);
  return {
    ...diff,
    added: diff.lines.filter((line) => line.type === "added").map((line) => line.value),
    removed: diff.lines.filter((line) => line.type === "removed").map((line) => line.value),
    markdown: diff.lines.map((line) => `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.value}`).join("\n")
  };
};

export const wikiLinksFromMarkdown = (markdown) => [...String(markdown).matchAll(/wiki:\/\/([0-9a-f-]{36})/gi)].map((match) => match[1]);

const citationSourceCheck = ({ sqlite, resourceStorageDir, citation, pageVersionId }) => {
  const version = sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(citation.resource_version_id);
  if (!version) return "target resource version is missing";
  let bytes;
  try { bytes = readBytes(resourceStorageDir, version.storage_key); }
  catch { return "target source storage is missing"; }
  if (bytes.length !== version.byte_size || sha256(bytes) !== version.content_sha256) return "target source integrity check failed";
  let locator;
  const bounds = citationSourceBounds({ sqlite, resourceVersion: version, resourceStorageDir });
  try { locator = normalizeCitationLocator(citation.locator_json, bounds); }
  catch (caught) { return caught.message; }
  if (version.mime_type === "application/pdf" && (locator.startOffset !== undefined || locator.endOffset !== undefined) && bounds.canonicalIntegrity !== "valid") return "target canonical source artifact is missing";
  if (version.mime_type === "application/pdf" && [locator.page, locator.pageStart, locator.pageEnd, ...(locator.pages || [])].some((page) => page !== undefined) && bounds.pageCount === null) return "target source page count is unavailable";
  if (locator.chunkId && !sqlite.prepare("SELECT id FROM chunks WHERE id=? AND resource_version_id=? AND status='active'").get(locator.chunkId, version.id)) return "target chunk is missing";
  if (citation.block_key && !sqlite.prepare("SELECT id FROM wiki_page_blocks WHERE page_version_id=? AND block_key=?").get(pageVersionId, citation.block_key)) return "target wiki block is missing";
  return null;
};

export const scanWikiImpacts = ({ sqlite, resourceVersionId, resourceStorageDir, audit = () => {} }) => {
  const resourceVersion = sqlite.prepare("SELECT rv.*,r.current_version_id,r.id AS resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.id=?").get(resourceVersionId);
  if (!resourceVersion) return { checked: 0, active: 0, needsReview: 0, broken: 0 };
  const counts = { checked: 0, active: 0, needsReview: 0, broken: 0 };
  const timestamp = new Date().toISOString();
  sqlite.transaction(() => {
    const citations = sqlite.prepare("SELECT c.* FROM wiki_citations c JOIN resource_versions target ON target.id=c.resource_version_id WHERE target.resource_id=? ORDER BY c.id").all(resourceVersion.resource_id);
    for (const citation of citations) {
      const failure = citationSourceCheck({ sqlite, resourceStorageDir, citation, pageVersionId: citation.page_version_id });
      const status = failure ? "broken" : resourceVersion.current_version_id !== citation.resource_version_id ? "needs_review" : "active";
      const staleReason = failure || (status === "needs_review" ? "a newer indexed resource version exists" : null);
      sqlite.prepare("UPDATE wiki_citations SET status=?,stale_reason=?,checked_at=? WHERE id=?").run(status, staleReason, timestamp, citation.id);
      counts.checked += 1;
      if (status === "active") counts.active += 1;
      else if (status === "needs_review") counts.needsReview += 1;
      else counts.broken += 1;
    }
    if (citations.length) audit("impact_scanned", "resource_version", resourceVersionId, { ...counts, currentVersionId: resourceVersion.current_version_id });
  })();
  return counts;
};
