import { codePointLength, estimateTokens, normalizeTokenCounter, utf8ByteLength } from "./text-tokenizer.js";

export { codePointLength, utf8ByteLength };

const STRATEGIES = new Set(["auto", "parser", "heading", "heuristic", "legacy", "recursive"]);
export const CHUNK_SIZE_UNIT = "code_point";
export const STRUCTURE_PATH_SCHEMA = "structure-path-v1";

export const DEFAULT_CHUNKING_CONFIG = Object.freeze({
  strategy: "auto",
  sizeUnit: CHUNK_SIZE_UNIT,
  parentChunkSize: 4096,
  childChunkSize: 384,
  childOverlap: 76,
  maxProtectedSize: 7500,
  parentTokenTarget: null,
  childTokenTarget: null
});

const asPositiveInt = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw Object.assign(new Error(`${name} must be a positive integer`), { code: "VALIDATION_ERROR" });
  return parsed;
};
const asNonNegativeInt = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw Object.assign(new Error(`${name} must be a non-negative integer`), { code: "VALIDATION_ERROR" });
  return parsed;
};
const asOptionalPositiveInt = (value, fallback, name) => {
  if (value === undefined || value === null || value === "") return fallback;
  return asPositiveInt(value, fallback, name);
};

export const normalizeChunkingConfig = (value = {}) => {
  if (value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("chunking config must be an object"), { code: "VALIDATION_ERROR" });
  const input = value;
  const strategy = String(input.strategy ?? "auto").toLowerCase();
  if (!STRATEGIES.has(strategy)) throw Object.assign(new Error("strategy must be auto, parser, heading, heuristic, legacy, or recursive"), { code: "VALIDATION_ERROR" });
  const sizeUnit = String(input.sizeUnit ?? input.size_unit ?? CHUNK_SIZE_UNIT).toLowerCase();
  if (sizeUnit !== CHUNK_SIZE_UNIT) throw Object.assign(new Error(`sizeUnit must be ${CHUNK_SIZE_UNIT}`), { code: "VALIDATION_ERROR" });
  const parentChunkSize = asPositiveInt(input.parentChunkSize ?? input.parent_chunk_size, DEFAULT_CHUNKING_CONFIG.parentChunkSize, "parentChunkSize");
  const childChunkSize = asPositiveInt(input.childChunkSize ?? input.child_chunk_size, DEFAULT_CHUNKING_CONFIG.childChunkSize, "childChunkSize");
  if (parentChunkSize <= childChunkSize) throw Object.assign(new Error("parentChunkSize must be greater than childChunkSize"), { code: "VALIDATION_ERROR" });
  const requestedOverlap = asNonNegativeInt(input.childOverlap ?? input.child_overlap, DEFAULT_CHUNKING_CONFIG.childOverlap, "childOverlap");
  const childOverlap = Math.min(requestedOverlap, Math.floor(childChunkSize / 2));
  const maxProtectedSize = asPositiveInt(input.maxProtectedSize ?? input.max_protected_size, DEFAULT_CHUNKING_CONFIG.maxProtectedSize, "maxProtectedSize");
  const parentTokenTarget = asOptionalPositiveInt(input.parentTokenTarget ?? input.parent_token_target, DEFAULT_CHUNKING_CONFIG.parentTokenTarget, "parentTokenTarget");
  const childTokenTarget = asOptionalPositiveInt(input.childTokenTarget ?? input.child_token_target, DEFAULT_CHUNKING_CONFIG.childTokenTarget, "childTokenTarget");
  return { strategy, sizeUnit, parentChunkSize, childChunkSize, childOverlap, maxProtectedSize, parentTokenTarget, childTokenTarget };
};

export const normalizeCanonicalText = (value) => {
  if (typeof value !== "string") throw Object.assign(new Error("canonical text must be a string"), { code: "PARSE_FAILED" });
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
};

const lineRecords = (text) => {
  const points = Array.from(text);
  const lines = [];
  let start = 0;
  for (let index = 0; index <= points.length; index += 1) {
    if (index !== points.length && points[index] !== "\n") continue;
    lines.push({ start, end: index, fullEnd: index < points.length ? index + 1 : index, text: points.slice(start, index).join("") });
    start = index + 1;
  }
  return { points, lines };
};

const structureNode = (type, fields = {}) => ({ type, ...fields });
const structurePathKey = (path) => JSON.stringify(path || []);
const mergeStructurePaths = (...paths) => {
  const merged = [];
  const seen = new Set();
  for (const path of paths) {
    for (const node of Array.isArray(path) ? path : []) {
      if (!node || typeof node !== "object" || !node.type) continue;
      const key = structurePathKey([node]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...node });
    }
  }
  return merged;
};

const structurePathHeader = (path) => (Array.isArray(path) ? path : []).map((node) => {
  if (node.type === "page") return `Page ${node.pageNumber}`;
  if (node.type === "heading") return `${"#".repeat(Math.max(1, Math.min(6, Number(node.level) || 1)))} ${node.title}`.trim();
  if (node.type === "section") return String(node.title || "").trim();
  if (node.type === "block") return `${String(node.blockType || "text").replace(/[-_]+/gu, " ")} block`;
  if (node.type === "continuation") return String(node.label || "").trim();
  return String(node.label || node.type || "").trim();
}).filter(Boolean).join("\n");

const normalizeHeadingPath = (value) => (Array.isArray(value) ? value : []).map((item, index) => {
  if (typeof item === "string" && item.trim()) return structureNode("heading", { level: index + 1, title: item.trim() });
  if (!item || typeof item !== "object" || !String(item.title || item.text || "").trim()) return null;
  return structureNode("heading", { level: Number(item.level) || index + 1, title: String(item.title || item.text).trim() });
}).filter(Boolean);

const parserKindFor = (block) => {
  const kind = String(block?.kind || block?.type || "text").trim().toLowerCase();
  if (["code", "code_block", "fenced_code"].includes(kind)) return "code";
  if (["table", "table_block"].includes(kind)) return "table";
  if (["formula", "math", "equation"].includes(kind)) return "formula";
  if (["heading", "header", "title"].includes(kind)) return "heading";
  return "paragraph";
};

const parserBlockPath = (block, pageNumber = null) => {
  const page = Number(block?.pageNumber ?? block?.page_number ?? pageNumber);
  const path = Number.isInteger(page) && page > 0 ? [structureNode("page", { pageNumber: page })] : [];
  path.push(...normalizeHeadingPath(block?.headingPath ?? block?.heading_path));
  path.push(structureNode("block", { blockType: parserKindFor(block) }));
  return path;
};

const parserInputError = (message, metadata = {}) => Object.assign(new Error(message), { code: "PARSER_INPUT_INVALID", metadata });
const parserObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw parserInputError(`${label} must be an object`, { field: label });
  return value;
};
const numericParserField = (value, names, label, required = false) => {
  const raw = names.map((name) => value?.[name]).find((item) => item !== undefined && item !== null && !(typeof item === "string" && !item.trim()));
  if (raw === undefined) {
    if (required) throw parserInputError(`${label} is required`, { field: label });
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw parserInputError(`${label} must be an integer`, { field: label, value: raw });
  return parsed;
};

const normalizeParserInput = (value, totalCodePoints) => {
  if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) throw parserInputError("parser input must be an object");
  const source = value || {};
  if (source.pages !== undefined && !Array.isArray(source.pages)) throw parserInputError("parser pages must be an array", { field: "pages" });
  if (source.blocks !== undefined && !Array.isArray(source.blocks)) throw parserInputError("parser blocks must be an array", { field: "blocks" });
  const pages = (Array.isArray(source.pages) ? source.pages : []).map((value, index) => {
    const page = parserObject(value, `pages[${index}]`);
    const pageNumber = numericParserField(page, ["pageNumber", "page_number"], `pages[${index}].pageNumber`) ?? index + 1;
    const start = numericParserField(page, ["canonicalStart", "start"], `pages[${index}].start`);
    const end = numericParserField(page, ["canonicalEnd", "end"], `pages[${index}].end`);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw parserInputError(`pages[${index}].pageNumber must be a positive integer`, { field: `pages[${index}].pageNumber` });
    if ((start === null) !== (end === null)) throw parserInputError(`pages[${index}] must provide both start and end`, { field: `pages[${index}]` });
    if (start !== null && (start < 0 || end <= start || end > totalCodePoints)) throw parserInputError(`pages[${index}] range is outside canonical text`, { field: `pages[${index}]`, start, end, totalCodePoints });
    return { pageNumber, start, end };
  });
  const pageNumbers = new Set();
  for (const page of pages) {
    if (pageNumbers.has(page.pageNumber)) throw parserInputError(`duplicate page number ${page.pageNumber}`, { pageNumber: page.pageNumber });
    pageNumbers.add(page.pageNumber);
  }
  let pageCursor = 0;
  for (const page of [...pages].filter((item) => item.start !== null).sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (page.start < pageCursor) throw parserInputError(`parser page ranges overlap at page ${page.pageNumber}`, { pageNumber: page.pageNumber });
    pageCursor = page.end;
  }
  const blocks = (Array.isArray(source.blocks) ? source.blocks : []).map((value, index) => {
    const block = parserObject(value, `blocks[${index}]`);
    const start = numericParserField(block, ["start", "canonicalStart"], `blocks[${index}].start`, true);
    const end = numericParserField(block, ["end", "canonicalEnd"], `blocks[${index}].end`, true);
    const pageNumber = numericParserField(block, ["pageNumber", "page_number"], `blocks[${index}].pageNumber`);
    if (start < 0 || end <= start || end > totalCodePoints) throw parserInputError(`blocks[${index}] range is outside canonical text`, { field: `blocks[${index}]`, start, end, totalCodePoints });
    if (pageNumber !== null && pageNumber < 1) throw parserInputError(`blocks[${index}].pageNumber must be a positive integer`, { field: `blocks[${index}].pageNumber` });
    return { ...block, start, end, pageNumber, order: numericParserField(block, ["order"], `blocks[${index}].order`) ?? index, kind: parserKindFor(block) };
  }).sort((left, right) => left.start - right.start || left.end - right.end || left.order - right.order).map((block) => {
    const pageNumber = block.pageNumber || pages.find((page) => page.start !== null && page.end !== null && page.start <= block.start && block.start < page.end)?.pageNumber || null;
    return { ...block, pageNumber, structurePath: parserBlockPath(block, pageNumber) };
  });
  const usableBlocks = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.start < cursor) throw parserInputError(`parser blocks overlap at ${block.start}`, { start: block.start, end: block.end });
    usableBlocks.push(block);
    cursor = block.end;
  }
  return { pages, blocks: usableBlocks };
};

const pagePathAt = (pages, position) => {
  const page = pages.find((item) => item.start !== null && item.end !== null && item.start <= position && position < item.end);
  return page ? [structureNode("page", { pageNumber: page.pageNumber })] : [];
};

const pageSegments = (pages, start, end) => {
  const segments = [];
  let cursor = start;
  for (const page of [...pages].filter((item) => item.start !== null && item.end !== null && item.end > start && item.start < end).sort((left, right) => left.start - right.start)) {
    if (cursor >= end) break;
    if (page.start > cursor) segments.push({ start: cursor, end: Math.min(end, page.start), pageNumber: null });
    const segmentStart = Math.max(cursor, page.start);
    const segmentEnd = Math.min(end, page.end);
    if (segmentEnd > segmentStart) segments.push({ start: segmentStart, end: segmentEnd, pageNumber: page.pageNumber });
    cursor = Math.max(cursor, segmentEnd);
  }
  if (cursor < end) segments.push({ start: cursor, end, pageNumber: null });
  return segments.length ? segments : [{ start, end, pageNumber: null }];
};

const parserPathForRange = (block, pages, position, fallbackPageNumber = null) => {
  const pagePath = pagePathAt(pages, position);
  const explicitPagePath = (block.structurePath || []).filter((node) => node.type === "page");
  const rest = (block.structurePath || []).filter((node) => node.type !== "page");
  return [...(pagePath.length ? pagePath : explicitPagePath.length ? explicitPagePath : fallbackPageNumber ? [structureNode("page", { pageNumber: fallbackPageNumber })] : []), ...rest];
};

const isFenceLine = (line) => /^\s*(?:```|~~~)/.test(line);
const isMarkdownHeading = (line) => {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
};
const isNumberedHeading = (line) => /^\s*(?:(?:\d+(?:\.\d+){0,5})[.)]?|第\s*[一二三四五六七八九十百千万\d]+\s*[章节]|(?:chapter|section|kapitel)\s+\d+)\s+\S+/i.test(line);
const isVisualRule = (line) => /^\s*(?:[-*_])(?:\s*[-*_]){2,}\s*$/.test(line);
const isAllCapsHeading = (line) => {
  const trimmed = line.trim();
  return trimmed.length >= 4 && trimmed.length <= 100 && /[A-Z]/.test(trimmed) && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed.replace(/[^A-Z]/g, ""));
};
const isTableLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const hasOuterPipe = trimmed.startsWith("|") || trimmed.endsWith("|");
  const hasSpacedPipe = /\s\|\s/.test(trimmed);
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const separatorLike = cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  return cells.length >= 2 && (hasOuterPipe || hasSpacedPipe || cells.length >= 3 || separatorLike);
};
const isTableSeparatorLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};
const isPipeTableRow = (line) => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").length >= 2;
};
const isTableStart = (lines, index) => isTableLine(lines[index].text) || (isPipeTableRow(lines[index].text) && isTableSeparatorLine(lines[index + 1]?.text || ""));
const isFormulaStartLine = (line) => /^\s*(?:\$\$|\\\[|\\begin\{[^}]+\})/.test(line);
const isFormulaEndLine = (line) => /(?:\$\$|\\\]|\\end\{[^}]+\})\s*$/.test(line);
const isFormulaCompleteLine = (line) => {
  const trimmed = line.trim();
  if (trimmed === "$$" || trimmed === "\\[") return false;
  if (trimmed.startsWith("$$")) return trimmed.slice(2).includes("$$");
  if (trimmed.startsWith("\\[")) return trimmed.endsWith("\\]");
  if (trimmed.startsWith("\\begin{")) return /\\end\{[^}]+\}\s*$/.test(trimmed);
  return false;
};

const inlineProtectedRanges = (text) => {
  const ranges = [];
  const patterns = [
    /!?\[[^\]]*\]\([^)]+\)/g,
    /\$\$[\s\S]*?\$\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g,
    /\$[^$\n]+\$/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = Array.from(text.slice(0, match.index)).length;
      ranges.push({ start, end: start + Array.from(match[0]).length, type: "protected-inline" });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
};

const profileDocument = (text, parserInput = {}) => {
  const { lines } = lineRecords(text);
  let fence = false;
  let headingCount = 0;
  let heuristicMarkers = 0;
  let pageBreaks = 0;
  let codeLines = 0;
  let tableLines = 0;
  for (const line of lines) {
    if (isFenceLine(line.text)) { fence = !fence; codeLines += 1; continue; }
    if (fence) { codeLines += 1; continue; }
    if (isMarkdownHeading(line.text)) headingCount += 1;
    if (line.text.includes("\f")) pageBreaks += 1;
    if (isNumberedHeading(line.text) || isVisualRule(line.text) || isAllCapsHeading(line.text)) heuristicMarkers += 1;
    if (isTableLine(line.text)) tableLines += 1;
  }
  const codePoints = Array.from(text).length;
  const density = codePoints ? headingCount / codePoints : 0;
  const parserBlocks = Array.isArray(parserInput.blocks) ? parserInput.blocks : [];
  const parserStrongBlockCount = parserBlocks.filter((block) => ["code", "table", "formula"].includes(block.kind)).length;
  const parserPages = new Set(parserBlocks.map((block) => block.pageNumber).filter((page) => Number.isInteger(page) && page > 0));
  return { headingCount, headingDensity: density, heuristicMarkers, pageBreaks, codeLines, tableLines, parserBlockCount: parserBlocks.length, parserStrongBlockCount, parserPageCount: Math.max(parserPages.size, parserInput.pages?.length || 0) };
};

const chooseStrategy = (text, configured, parserInput = {}) => {
  if (configured !== "auto") return configured === "recursive" ? "legacy" : configured;
  const profile = profileDocument(text, parserInput);
  if (profile.parserStrongBlockCount > 0 || profile.parserBlockCount > 1 || profile.parserPageCount > 1) return "parser";
  if (profile.headingCount >= 3 && profile.headingDensity > 0.005) return "heading";
  if (profile.heuristicMarkers >= 5 || profile.pageBreaks > 0) return "heuristic";
  return "legacy";
};

const buildUnits = (text) => {
  const { points, lines } = lineRecords(text);
  const units = [];
  let index = 0;
  let inFence = false;
  while (index < lines.length) {
    const line = lines[index];
    const lineHeading = isMarkdownHeading(line.text);
    if (isFenceLine(line.text)) {
      const start = line.start;
      let end = line.fullEnd;
      inFence = !inFence;
      index += 1;
      while (index < lines.length) {
        end = lines[index].fullEnd;
        if (isFenceLine(lines[index].text)) { inFence = !inFence; index += 1; break; }
        index += 1;
      }
      units.push({ start, end, type: "code", protected: true, protectedType: "code" });
      continue;
    }
    if (inFence) {
      units.push({ start: line.start, end: line.fullEnd, type: "code", protected: true, protectedType: "code" });
      index += 1;
      continue;
    }
    if (isFormulaStartLine(line.text)) {
      const start = line.start;
      let end = line.fullEnd;
      index += 1;
      if (!isFormulaCompleteLine(line.text)) {
        while (index < lines.length) {
          end = lines[index].fullEnd;
          if (isFormulaEndLine(lines[index].text)) { index += 1; break; }
          index += 1;
        }
      }
      units.push({ start, end, type: "formula", protected: true, protectedType: "formula" });
      continue;
    }
    if (isTableStart(lines, index)) {
      const start = line.start;
      let end = line.fullEnd;
      index += 1;
      while (index < lines.length && (isPipeTableRow(lines[index].text) || !lines[index].text.trim())) { end = lines[index].fullEnd; index += 1; }
      units.push({ start, end, type: "table", protected: true, protectedType: "table" });
      continue;
    }
    const start = line.start;
    let end = line.fullEnd;
    const type = lineHeading ? "heading" : line.text.trim() ? "paragraph" : "blank";
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (isFenceLine(next.text) || isFormulaStartLine(next.text) || isTableStart(lines, index) || isMarkdownHeading(next.text)) break;
      if (!next.text.trim()) {
        end = next.fullEnd;
        index += 1;
        while (index < lines.length && !lines[index].text.trim()) { end = lines[index].fullEnd; index += 1; }
        break;
      }
      end = next.fullEnd;
      index += 1;
    }
    units.push({ start, end, type, protected: false });
  }
  if (!units.length && points.length) units.push({ start: 0, end: points.length, type: "paragraph", protected: false });
  return units;
};

const parserUnits = (points, rangeStart, rangeEnd, parserInput) => {
  const units = [];
  let cursor = rangeStart;
  const addFallback = (start, end, inheritedPath = []) => {
    if (end <= start) return;
    const fallback = buildUnits(points.slice(start, end).join("")).map((unit) => ({
      ...unit,
      start: unit.start + start,
      end: unit.end + start,
      structurePath: mergeStructurePaths(inheritedPath, unit.structurePath)
    }));
    units.push(...fallback);
  };
  if (!parserInput.blocks.length && parserInput.pages.some((page) => page.start !== null && page.end !== null)) {
    for (const page of [...parserInput.pages].filter((item) => item.start !== null && item.end !== null).sort((left, right) => left.start - right.start || left.pageNumber - right.pageNumber)) {
      const start = Math.max(rangeStart, page.start, cursor);
      const end = Math.min(rangeEnd, page.end);
      if (end <= start) continue;
      if (start > cursor) addFallback(cursor, start, pagePathAt(parserInput.pages, cursor));
      addFallback(start, end, [structureNode("page", { pageNumber: page.pageNumber })]);
      cursor = end;
    }
    if (cursor < rangeEnd) addFallback(cursor, rangeEnd, pagePathAt(parserInput.pages, cursor));
    return units.length ? units : buildUnits(points.slice(rangeStart, rangeEnd).join("")).map((unit) => ({ ...unit, start: unit.start + rangeStart, end: unit.end + rangeStart }));
  }
  for (const block of parserInput.blocks) {
    if (block.end <= rangeStart || block.start >= rangeEnd) continue;
    const start = Math.max(rangeStart, block.start, cursor);
    const end = Math.min(rangeEnd, block.end);
    if (end <= start) continue;
    if (start > cursor) addFallback(cursor, start, pagePathAt(parserInput.pages, cursor));
    const protectedType = ["code", "table", "formula"].includes(block.kind) ? block.kind : null;
    for (const segment of pageSegments(parserInput.pages, start, end)) {
      const structurePath = parserPathForRange(block, parserInput.pages, segment.start, segment.pageNumber);
      if (!protectedType) {
        const nested = buildUnits(points.slice(segment.start, segment.end).join("")).map((unit) => ({
          ...unit,
          start: unit.start + segment.start,
          end: unit.end + segment.start,
          structurePath: mergeStructurePaths(structurePath, unit.structurePath)
        }));
        units.push(...nested);
      } else {
        units.push({ start: segment.start, end: segment.end, type: protectedType, protected: true, protectedType, protectedGroup: `${protectedType}:${block.start}:${block.end}`, structurePath });
      }
    }
    cursor = end;
  }
  if (cursor < rangeEnd) addFallback(cursor, rangeEnd, pagePathAt(parserInput.pages, cursor));
  return units.length ? units : buildUnits(points.slice(rangeStart, rangeEnd).join("")).map((unit) => ({ ...unit, start: unit.start + rangeStart, end: unit.end + rangeStart }));
};

const headingSections = (text) => {
  const { lines } = lineRecords(text);
  const sections = [];
  const stack = [];
  let inFence = false;
  for (const line of lines) {
    if (isFenceLine(line.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = isMarkdownHeading(line.text);
    if (!heading) continue;
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push({ level: heading.level, title: heading.title });
    sections.push({ start: line.start, structurePath: stack.map((item) => structureNode("heading", item)) });
  }
  if (!sections.length) return [{ start: 0, end: Array.from(text).length, structurePath: [] }];
  const result = [];
  if (sections[0].start > 0) result.push({ start: 0, end: sections[0].start, structurePath: [] });
  for (let index = 0; index < sections.length; index += 1) result.push({ start: sections[index].start, end: sections[index + 1]?.start ?? Array.from(text).length, structurePath: sections[index].structurePath });
  return result;
};

const heuristicSections = (text) => {
  const { lines } = lineRecords(text);
  const boundaries = [{ start: 0, structurePath: [] }];
  let inFence = false;
  for (const line of lines) {
    if (isFenceLine(line.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const marker = isNumberedHeading(line.text) || isVisualRule(line.text) || isAllCapsHeading(line.text) || line.text.includes("\f");
    if (marker && line.start > 0) boundaries.push({ start: line.start, structurePath: [structureNode("section", { title: line.text.replace(/\f/g, " ").trim() })] });
  }
  const total = Array.from(text).length;
  return boundaries.filter((item, index) => index === 0 || item.start > boundaries[index - 1].start).map((item, index) => ({ ...item, end: boundaries[index + 1]?.start ?? total }));
};

const safeCut = (points, start, desiredEnd, hardEnd, protectedRanges = [], maxProtectedSize = 7500) => {
  if (desiredEnd >= hardEnd) return hardEnd;
  const containing = protectedRanges.find((range) => desiredEnd > range.start && desiredEnd < range.end);
  if (containing) {
    if (containing.end <= hardEnd && containing.end - start <= maxProtectedSize) return containing.end;
    desiredEnd = containing.start > start ? containing.start : Math.min(hardEnd, start + Math.max(1, desiredEnd - start));
  }
  const floor = start + Math.floor((desiredEnd - start) * 0.55);
  const separators = [
    (index) => index >= start + 2 && points[index - 2] === "\n" && points[index - 1] === "\n",
    (index) => points[index - 1] === "\n",
    (index) => /[。！？；，.!?,;:：]/.test(points[index - 1] || ""),
    (index) => /\s/.test(points[index - 1] || "")
  ];
  for (const separator of separators) {
    for (let index = desiredEnd; index > floor; index -= 1) if (separator(index)) return index;
  }
  return desiredEnd;
};

const linesForUnit = (points, unit) => {
  const local = lineRecords(points.slice(unit.start, unit.end).join("")).lines;
  return local.map((line) => ({ ...line, start: line.start + unit.start, end: line.end + unit.start, fullEnd: line.fullEnd + unit.start }));
};

const splitRangeByLength = (points, start, end, target, maxProtectedSize, protectedType, splitReason, structurePath = []) => {
  const result = [];
  let cursor = start;
  while (cursor < end) {
    const desired = Math.min(end, cursor + target);
    const cut = safeCut(points, cursor, desired, end, [], maxProtectedSize);
    const next = cut > cursor ? cut : desired;
    result.push({ start: cursor, end: next, type: protectedType, protected: true, protectedType, forcedSplit: true, splitReason, structurePath });
    cursor = next;
  }
  return result;
};

const protectedGroupFor = (unit) => unit.protectedGroup || (unit.protectedType ? `${unit.protectedType}:${unit.start}:${unit.end}` : null);

const codeFenceLanguage = (points, unit) => {
  const first = linesForUnit(points, unit).find((line) => line.text.trim());
  const match = first?.text.match(/^\s*(?:```|~~~)\s*(.*?)\s*$/);
  return match?.[1] || "";
};

const splitCodeUnit = (points, unit, target, maxProtectedSize, preserveAtomic = true) => {
  const length = unit.end - unit.start;
  const protectedTarget = Math.min(target, maxProtectedSize);
  const protectedGroup = protectedGroupFor({ ...unit, protectedType: "code" });
  if (length <= protectedTarget) return [{ ...unit, protectedType: "code", protectedGroup, splitReason: null }];
  if (preserveAtomic && length <= maxProtectedSize) return [{ ...unit, protectedType: "code", protectedGroup, splitReason: "protected-atomic" }];
  const lines = linesForUnit(points, unit);
  const pieces = [];
  const splitReason = length > maxProtectedSize ? "code-block-size-limit" : "code-line-group";
  let currentStart = null;
  let currentEnd = null;
  const flush = () => {
    if (currentStart !== null && currentEnd !== null && currentEnd > currentStart) pieces.push({ start: currentStart, end: currentEnd, type: "code", protected: true, protectedType: "code", forcedSplit: false, splitReason });
    currentStart = null;
    currentEnd = null;
  };
  for (const line of lines) {
    if (line.fullEnd <= line.start) continue;
    if (line.fullEnd - line.start > protectedTarget) {
      flush();
      pieces.push(...splitRangeByLength(points, line.start, line.fullEnd, protectedTarget, maxProtectedSize, "code", "code-line-too-large", unit.structurePath));
      continue;
    }
    if (currentStart !== null && line.fullEnd - currentStart > protectedTarget) flush();
    if (currentStart === null) currentStart = line.start;
    currentEnd = line.fullEnd;
  }
  flush();
  if (!pieces.length) pieces.push(...splitRangeByLength(points, unit.start, unit.end, protectedTarget, maxProtectedSize, "code", "code-hard-split", unit.structurePath));
  const language = codeFenceLanguage(points, unit);
  const label = `Code block${language ? ` (${language})` : ""}`;
  return pieces.map((piece, index) => ({ ...piece, protectedGroup, partIndex: index, partCount: pieces.length, structuralContext: `${label} continuation (part ${index + 1}/${pieces.length})`, structurePath: mergeStructurePaths(unit.structurePath, [structureNode("continuation", { label: `${label} continuation (part ${index + 1}/${pieces.length})` })]) }));
};

const splitFormulaUnit = (points, unit, target, maxProtectedSize, preserveAtomic = true) => {
  const length = unit.end - unit.start;
  const protectedTarget = Math.min(target, maxProtectedSize);
  const protectedGroup = protectedGroupFor({ ...unit, protectedType: "formula" });
  if (length <= protectedTarget) return [{ ...unit, protectedType: "formula", protectedGroup, splitReason: null }];
  if (preserveAtomic && length <= maxProtectedSize) return [{ ...unit, protectedType: "formula", protectedGroup, splitReason: "protected-atomic" }];
  const lines = linesForUnit(points, unit);
  const pieces = [];
  const splitReason = length > maxProtectedSize ? "formula-size-limit" : "formula-line-group";
  let currentStart = null;
  let currentEnd = null;
  const flush = () => {
    if (currentStart !== null && currentEnd !== null && currentEnd > currentStart) pieces.push({ start: currentStart, end: currentEnd, type: "formula", protected: true, protectedType: "formula", forcedSplit: false, splitReason });
    currentStart = null;
    currentEnd = null;
  };
  for (const line of lines) {
    if (line.fullEnd <= line.start) continue;
    if (line.fullEnd - line.start > protectedTarget) {
      flush();
      pieces.push(...splitRangeByLength(points, line.start, line.fullEnd, protectedTarget, maxProtectedSize, "formula", "formula-line-too-large", unit.structurePath));
      continue;
    }
    if (currentStart !== null && line.fullEnd - currentStart > protectedTarget) flush();
    if (currentStart === null) currentStart = line.start;
    currentEnd = line.fullEnd;
  }
  flush();
  if (!pieces.length) pieces.push(...splitRangeByLength(points, unit.start, unit.end, protectedTarget, maxProtectedSize, "formula", "formula-hard-split", unit.structurePath));
  return pieces.map((piece, index) => ({ ...piece, protectedGroup, partIndex: index, partCount: pieces.length, structuralContext: `Formula continuation (part ${index + 1}/${pieces.length})`, structurePath: mergeStructurePaths(unit.structurePath, [structureNode("continuation", { label: `Formula continuation (part ${index + 1}/${pieces.length})` })]) }));
};

const tableHeaderInfo = (points, unit) => {
  const lines = linesForUnit(points, unit);
  const firstIndex = lines.findIndex((line) => isPipeTableRow(line.text));
  if (firstIndex < 0) return null;
  const secondIndex = lines.findIndex((line, index) => index > firstIndex && isPipeTableRow(line.text));
  const hasSeparator = secondIndex >= 0 && isTableSeparatorLine(lines[secondIndex].text);
  const headerEnd = (hasSeparator ? lines[secondIndex] : lines[firstIndex]).fullEnd;
  const headerText = points.slice(unit.start, headerEnd).join("").trim();
  return { lines, headerEnd, headerText };
};

const tableRowsAfterHeader = ({ lines, headerEnd }) => {
  const rows = [];
  let pendingStart = null;
  let current = null;
  for (const line of lines) {
    if (line.fullEnd <= headerEnd) continue;
    if (isPipeTableRow(line.text)) {
      if (current) rows.push(current);
      current = { start: pendingStart ?? line.start, end: line.fullEnd };
      pendingStart = null;
    } else if (current) current.end = line.fullEnd;
    else if (line.fullEnd > line.start && pendingStart === null) pendingStart = line.start;
  }
  if (current) rows.push(current);
  return rows;
};

const lengthOf = (unit) => unit.end - unit.start;

const splitTableUnit = (points, unit, target, maxProtectedSize, inheritedHeader = null) => {
  const protectedTarget = Math.min(target, maxProtectedSize);
  const protectedGroup = protectedGroupFor({ ...unit, protectedType: "table" });
  const detected = tableHeaderInfo(points, unit);
  const info = inheritedHeader
    ? { lines: linesForUnit(points, unit), headerEnd: unit.start, headerText: inheritedHeader }
    : detected;
  if (!info) {
    if (lengthOf(unit) <= protectedTarget) return [{ ...unit, protectedType: "table", protectedGroup, structurePath: unit.structurePath || [] }];
    return splitRangeByLength(points, unit.start, unit.end, protectedTarget, maxProtectedSize, "table", "table-hard-split", unit.structurePath).map((piece) => ({ ...piece, protectedGroup, structurePath: unit.structurePath }));
  }
  const rows = tableRowsAfterHeader(info);
  if (!rows.length) {
    if (lengthOf(unit) <= protectedTarget) return [{ ...unit, protectedType: "table", protectedGroup, splitReason: null, structurePath: unit.structurePath || [] }];
    if (lengthOf(unit) <= maxProtectedSize) return [{ ...unit, protectedType: "table", protectedGroup, splitReason: "protected-atomic", structurePath: unit.structurePath || [] }];
    const headerPieces = splitRangeByLength(points, unit.start, unit.end, protectedTarget, maxProtectedSize, "table", "table-header-too-large", unit.structurePath);
    return headerPieces.map((piece, index) => ({ ...piece, protectedGroup, partIndex: index, partCount: headerPieces.length, tableHeader: info.headerText, structurePath: unit.structurePath }));
  }
  const tableContext = `Table header:\n${info.headerText}`;
  const pieces = [];
  const headerLength = inheritedHeader ? 0 : info.headerEnd - unit.start;
  let headerPieceCount = 0;
  let segmentStart = null;
  let segmentEnd = null;
  if (inheritedHeader) {
    headerPieceCount = 0;
  } else if (headerLength <= maxProtectedSize) {
    headerPieceCount = 1;
    segmentStart = unit.start;
    segmentEnd = info.headerEnd;
  } else {
    const headerPieces = splitRangeByLength(points, unit.start, info.headerEnd, protectedTarget, maxProtectedSize, "table", "table-header-too-large", unit.structurePath);
    pieces.push(...headerPieces);
    headerPieceCount = headerPieces.length;
  }
  let rowCount = 0;
  const flush = () => {
    if (segmentStart !== null && segmentEnd > segmentStart) pieces.push({ start: segmentStart, end: segmentEnd, type: "table", protected: true, protectedType: "table", forcedSplit: false, splitReason: pieces.length ? "table-row-split" : segmentEnd - segmentStart > protectedTarget ? "protected-atomic" : null, structurePath: unit.structurePath || [] });
    segmentStart = null;
    segmentEnd = null;
    rowCount = 0;
  };
  for (const row of rows) {
    if (row.end - row.start > protectedTarget) {
      flush();
      pieces.push(...splitRangeByLength(points, row.start, row.end, protectedTarget, maxProtectedSize, "table", "table-row-too-large", unit.structurePath));
      continue;
    }
    if (segmentStart === null) {
      segmentStart = row.start;
      segmentEnd = row.end;
      rowCount = 1;
      continue;
    }
    if (rowCount > 0 && row.end - segmentStart > protectedTarget) {
      flush();
      segmentStart = row.start;
      segmentEnd = row.end;
      rowCount = 1;
      continue;
    }
    segmentEnd = row.end;
    rowCount += 1;
  }
  flush();
  if (!pieces.length) pieces.push({ start: unit.start, end: unit.end, type: "table", protected: true, protectedType: "table", structurePath: unit.structurePath || [] });
  return pieces.map((piece, index) => ({
    ...piece,
    protectedGroup,
    partIndex: index,
    partCount: pieces.length,
    structuralContext: inheritedHeader || index < headerPieceCount ? null : tableContext,
    tableHeader: info.headerText,
    forcedSplit: Boolean(piece.forcedSplit),
    structurePath: mergeStructurePaths(piece.structurePath, index < headerPieceCount || (inheritedHeader && !piece.structuralContext) ? [] : [structureNode("continuation", { label: "Table header continuation" })])
  }));
};

const splitOversized = (points, unit, target, maxProtectedSize, protectedRanges = []) => {
  const result = [];
  let start = unit.start;
  const end = unit.end;
  while (start < end) {
    const desired = Math.min(end, start + target);
    const cut = unit.protected && end - start <= maxProtectedSize ? desired : safeCut(points, start, desired, end, protectedRanges, maxProtectedSize);
    result.push({ start, end: cut, type: unit.type, protected: unit.protected, protectedType: unit.protectedType || null, forcedSplit: true, splitReason: unit.protected ? `${unit.type}-hard-split` : "length-split", structurePath: unit.structurePath || [] });
    if (cut <= start) break;
    start = cut;
  }
  return result;
};

const structuralBoundaryKey = (path) => JSON.stringify((Array.isArray(path) ? path : []).filter((node) => ["page", "heading", "section"].includes(node.type)));

const packRange = (points, rangeStart, rangeEnd, target, maxProtectedSize, baseStructurePath = [], parserInput = null) => {
  const text = points.slice(rangeStart, rangeEnd).join("");
  const protectedRanges = inlineProtectedRanges(text).map((range) => ({ ...range, start: range.start + rangeStart, end: range.end + rangeStart }));
  const localUnits = parserInput
    ? parserUnits(points, rangeStart, rangeEnd, parserInput)
    : buildUnits(text).map((unit) => ({ ...unit, start: unit.start + rangeStart, end: unit.end + rangeStart }));
  const units = [];
  for (const unit of localUnits) {
    if (unit.type === "code" && (unit.end - unit.start > target || unit.end - unit.start > maxProtectedSize)) units.push(...splitCodeUnit(points, unit, target, maxProtectedSize));
    else if (unit.type === "formula" && (unit.end - unit.start > target || unit.end - unit.start > maxProtectedSize)) units.push(...splitFormulaUnit(points, unit, target, maxProtectedSize));
    else if (unit.type === "table" && (unit.end - unit.start > target || unit.end - unit.start > maxProtectedSize)) units.push(...splitTableUnit(points, unit, target, maxProtectedSize));
    else if (unit.end - unit.start > target) units.push(...splitOversized(points, unit, target, maxProtectedSize, protectedRanges));
    else units.push(unit);
  }
  const chunks = [];
  let current = [];
  let currentStart = null;
  let currentEnd = null;
  const flush = () => {
    if (currentStart === null || currentEnd === null || currentEnd <= currentStart) return;
    const structurePath = mergeStructurePaths(baseStructurePath, current[0]?.structurePath || []);
    const structuralHeaders = [...new Set(current.map((unit) => unit.structuralContext).filter(Boolean))];
    const protectedTypes = [...new Set(current.map((unit) => unit.protectedType).filter(Boolean))];
    const protectedGroups = [...new Set(current.map((unit) => unit.protectedGroup).filter(Boolean))];
    const splitReasons = [...new Set(current.map((unit) => unit.splitReason).filter(Boolean))];
    chunks.push({
      start: currentStart,
      end: currentEnd,
      content: points.slice(currentStart, currentEnd).join(""),
      structurePath,
      contextHeader: [structurePathHeader(structurePath), ...structuralHeaders].filter(Boolean).join("\n"),
      forcedSplit: current.some((unit) => unit.forcedSplit),
      blockTypes: [...new Set(current.map((unit) => unit.type))],
      protectedType: protectedTypes.length ? protectedTypes.join(",") : null,
      protectedGroup: protectedGroups[0] || (protectedTypes.length ? `${protectedTypes[0]}:${currentStart}:${currentEnd}` : null),
      tableHeader: current.length === 1 ? current[0].tableHeader ?? null : null,
      splitReason: splitReasons.length ? splitReasons.join(",") : null,
      partIndex: current.length === 1 ? current[0].partIndex ?? null : null,
      partCount: current.length === 1 ? current[0].partCount ?? null : null
    });
    current = [];
    currentStart = null;
    currentEnd = null;
  };
  for (const unit of units) {
    const currentPath = mergeStructurePaths(baseStructurePath, current[0]?.structurePath || []);
    const nextPath = mergeStructurePaths(baseStructurePath, unit.structurePath || []);
    if (current.length && structuralBoundaryKey(currentPath) !== structuralBoundaryKey(nextPath)) flush();
    if (unit.protected && current.length) flush();
    if (currentStart !== null && currentEnd + (unit.end - unit.start) > target) flush();
    if (currentStart === null) currentStart = unit.start;
    currentEnd = unit.end;
    current.push(unit);
    if (unit.protected) flush();
  }
  flush();
  return chunks;
};

const overlapBoundary = (points, desiredStart, chunkStart, protectedRanges = []) => {
  let wordBoundary = null;
  for (let index = chunkStart - 1; index >= desiredStart; index -= 1) {
    if (protectedRanges.some((range) => index > range.start && index < range.end)) continue;
    const previous = points[index - 1] || "";
    const paragraphBoundary = previous === "\n" && points[index - 2] === "\n";
    const sentenceBoundary = /[。！？.!?；;]/.test(previous);
    if (paragraphBoundary || previous === "\n" || sentenceBoundary) return index;
    if (wordBoundary === null && /\s/u.test(previous)) wordBoundary = index;
  }
  return wordBoundary ?? chunkStart;
};

const applyOverlap = (points, chunks, overlap, protectedRanges = []) => {
  if (!overlap || chunks.length < 2) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    if (chunk.protectedType || chunks[index - 1].protectedType) return chunk;
    if (structuralBoundaryKey(chunk.structurePath) !== structuralBoundaryKey(chunks[index - 1].structurePath)) return chunk;
    const desiredStart = Math.max(chunks[index - 1].start, chunk.start - overlap);
    let start = overlapBoundary(points, desiredStart, chunk.start, protectedRanges);
    const containing = protectedRanges.find((range) => start > range.start && start < range.end);
    if (containing) start = containing.start >= desiredStart ? containing.start : chunk.start;
    if (start >= chunk.start) return chunk;
    return { ...chunk, start, content: points.slice(start, chunk.end).join(""), overlap: chunk.start - start, overlapMode: "boundary" };
  });
};

const splitWithStrategy = (text, target, strategy, maxProtectedSize, overlap = 0, parserInput = null) => {
  // ponytail: code-point arrays keep offsets deterministic and auditable for the local MVP; a streaming segmenter is the upgrade path for very large documents.
  const points = Array.from(text);
  const sections = strategy === "heading" ? headingSections(text) : strategy === "heuristic" ? heuristicSections(text) : [{ start: 0, end: points.length, structurePath: [] }];
  const usableParser = strategy === "parser" && (parserInput?.blocks?.length || parserInput?.pages?.length) ? parserInput : null;
  const chunks = sections.flatMap((section) => packRange(points, section.start, section.end, target, maxProtectedSize, section.structurePath, usableParser));
  return applyOverlap(points, chunks, overlap, inlineProtectedRanges(text));
};

export const extractDocumentBlocks = (text, parser = null) => {
  const canonicalText = normalizeCanonicalText(text);
  const input = normalizeParserInput(parser, Array.from(canonicalText).length);
  const units = input.blocks.length || input.pages.length ? parserUnits(Array.from(canonicalText), 0, Array.from(canonicalText).length, input) : buildUnits(canonicalText);
  return units.map((unit) => ({ type: unit.type, protectedType: unit.protectedType || null, protectedGroup: unit.protectedType ? (unit.protectedGroup || `${unit.protectedType}:${unit.start}:${unit.end}`) : null, structurePath: unit.structurePath || [], start: unit.start, end: unit.end, protected: Boolean(unit.protected) }));
};

export const profileAndSelectStrategy = (text, configured = "auto", parser = null) => {
  const canonicalText = normalizeCanonicalText(text);
  const input = normalizeParserInput(parser, Array.from(canonicalText).length);
  const selected = chooseStrategy(canonicalText, configured, input);
  return { selected, profile: profileDocument(canonicalText, input), parser: input };
};

export const validateChunks = (chunks, totalCodePoints, targetSize) => {
  const reasons = [];
  if (!chunks.length && totalCodePoints > 0) reasons.push("empty-output");
  if (chunks.length && (chunks[0].start !== 0 || chunks.at(-1).end !== totalCodePoints)) reasons.push("coverage-boundary");
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.start < cursor) reasons.push("unexpected-parent-overlap");
    if (chunk.start > cursor) reasons.push("coverage-gap");
    if (chunk.end <= chunk.start) reasons.push("empty-chunk");
    if (chunk.end - chunk.start > targetSize * 2 && !chunk.forcedSplit && chunk.splitReason !== "protected-atomic") reasons.push("oversized-chunk");
    cursor = chunk.end;
  }
  if (totalCodePoints > targetSize * 2 && chunks.length === 1 && chunks[0]?.splitReason !== "protected-atomic") reasons.push("large-document-single-chunk");
  return { ok: reasons.length === 0, reasons };
};

const tokenCountForRange = (points, start, end, prefix, tokenizer) => tokenizer.countTokens([prefix, points.slice(start, end).join("")].filter(Boolean).join("\n\n"));

const splitChunkByTokenTarget = (points, chunk, target, tokenizer, prefix = "") => {
  if (!tokenizer || !target || chunk.end <= chunk.start || chunk.protectedType) return [chunk];
  if (tokenizer.countTokens(prefix) >= target) return [{ ...chunk, tokenTargetExceeded: true }];
  if (tokenCountForRange(points, chunk.start, chunk.end, prefix, tokenizer) <= target) return [chunk];
  const protectedRanges = inlineProtectedRanges(points.slice(chunk.start, chunk.end).join("")).map((range) => ({ ...range, start: range.start + chunk.start, end: range.end + chunk.start }));
  const result = [];
  let start = chunk.start;
  while (start < chunk.end) {
    if (tokenCountForRange(points, start, chunk.end, prefix, tokenizer) <= target) {
      result.push({ ...chunk, start, end: chunk.end, content: points.slice(start, chunk.end).join(""), forcedSplit: true, splitReason: [...new Set([chunk.splitReason, "token-target"].filter(Boolean))].join(",") });
      break;
    }
    let low = start + 1;
    let high = chunk.end;
    let best = start + 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (tokenCountForRange(points, start, middle, prefix, tokenizer) <= target) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const cut = safeCut(points, start, best, chunk.end, protectedRanges, Number.MAX_SAFE_INTEGER);
    const next = cut > start ? cut : Math.min(chunk.end, start + 1);
    result.push({ ...chunk, start, end: next, content: points.slice(start, next).join(""), forcedSplit: true, splitReason: [...new Set([chunk.splitReason, "token-target"].filter(Boolean))].join(",") });
    start = next;
  }
  return result;
};

const sizeMetricsFor = (content, contextHeader = "", tokenizer = null) => {
  const source = String(content || "");
  const embeddingInput = [contextHeader, source].filter(Boolean).join("\n\n");
  return {
    unit: CHUNK_SIZE_UNIT,
    contentCodePoints: codePointLength(source),
    contentBytes: utf8ByteLength(source),
    estimatedContentTokens: estimateTokens(source),
    embeddingInputCodePoints: codePointLength(embeddingInput),
    embeddingInputBytes: utf8ByteLength(embeddingInput),
    estimatedEmbeddingTokens: estimateTokens(embeddingInput),
    providerTokenizer: tokenizer?.name || null,
    providerContentTokens: tokenizer ? tokenizer.countTokens(source) : null,
    providerEmbeddingTokens: tokenizer ? tokenizer.countTokens(embeddingInput) : null
  };
};

const decorateSizeMetrics = (chunk, tokenizer = null) => ({ ...chunk, sizeMetrics: { ...sizeMetricsFor(chunk.content, chunk.contextHeader, tokenizer), tokenTargetExceeded: Boolean(chunk.tokenTargetExceeded) } });
export const CANONICAL_METADATA_SCHEMA = "canonical-chunk-v1";
const decorateCanonicalMetadata = (chunk, role = chunk.chunkType === "parent_text" ? "parent" : "child") => ({
  ...chunk,
  canonicalMetadata: {
    schemaVersion: CANONICAL_METADATA_SCHEMA,
    role,
    locator: { startOffset: chunk.start, endOffset: chunk.end, unit: chunk.sizeMetrics.unit },
    structure: {
      blockTypes: chunk.blockTypes || [],
      structurePath: chunk.structurePath || [],
      protectedType: chunk.protectedType || null,
      protectedGroup: chunk.protectedGroup || null,
      tableHeader: chunk.tableHeader || null,
      splitReason: chunk.splitReason || null,
      forcedSplit: Boolean(chunk.forcedSplit),
      partIndex: chunk.partIndex ?? null,
      partCount: chunk.partCount ?? null
    },
    context: { header: chunk.contextHeader || null },
    relation: { parentIndex: chunk.parentIndex ?? null, childIndex: chunk.childIndex ?? null },
    overlap: { mode: chunk.overlapMode || "none", codePoints: chunk.overlap || 0 },
    size: chunk.sizeMetrics
  }
});
const decorateChunk = (chunk, tokenizer = null) => decorateCanonicalMetadata(decorateSizeMetrics(chunk, tokenizer));
const roundedAverage = (values) => values.length ? Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100 : 0;
const countBy = (values) => values.reduce((counts, value) => {
  if (value) counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});
const chunkingDiagnostics = ({ blocks, parentWindows, parents, children, config, tokenizer = null }) => {
  const allChunks = [...parents, ...children];
  const reasons = allChunks.flatMap((chunk) => String(chunk.splitReason || "").split(",").map((reason) => reason.trim()).filter(Boolean));
  const childCodePoints = children.map((chunk) => chunk.sizeMetrics.contentCodePoints);
  const childTokens = children.map((chunk) => chunk.sizeMetrics.estimatedEmbeddingTokens);
  const providerChildTokens = children.map((chunk) => chunk.sizeMetrics.providerEmbeddingTokens).filter((value) => Number.isInteger(value));
  const providerParentTokens = parents.map((chunk) => chunk.sizeMetrics.providerContentTokens).filter((value) => Number.isInteger(value));
  const maximum = (values) => values.reduce((current, value) => Math.max(current, value), 0);
  const childTokenTargetExceeded = config.childTokenTarget ? children.filter((chunk) => Number.isInteger(chunk.sizeMetrics.providerEmbeddingTokens) && chunk.sizeMetrics.providerEmbeddingTokens > config.childTokenTarget).length : 0;
  const parentTokenTargetExceeded = config.parentTokenTarget ? parents.filter((chunk) => Number.isInteger(chunk.sizeMetrics.providerContentTokens) && chunk.sizeMetrics.providerContentTokens > config.parentTokenTarget).length : 0;
  return {
    schemaVersion: "chunking-diagnostics-v1",
    sizeUnit: config.sizeUnit,
    providerTokenizer: tokenizer?.name || null,
    tokenTargets: { parent: config.parentTokenTarget, child: config.childTokenTarget },
    tokenTargetExceeded: { parent: parentTokenTargetExceeded, child: childTokenTargetExceeded },
    parentWindowCount: parentWindows.length,
    storedParentCount: parents.length,
    childCount: children.length,
    blockTypeCounts: countBy(blocks.map((block) => block.type)),
    protectedBlockCounts: countBy(blocks.map((block) => block.protectedType)),
    protectedChildCounts: countBy(children.map((chunk) => chunk.protectedType)),
    forcedSplitChunkCount: allChunks.filter((chunk) => chunk.forcedSplit).length,
    boundaryOverlapChildCount: children.filter((chunk) => chunk.overlapMode === "boundary").length,
    splitReasonCounts: countBy(reasons),
    childSize: {
      averageCodePoints: roundedAverage(childCodePoints),
      maxCodePoints: maximum(childCodePoints),
      averageEstimatedEmbeddingTokens: roundedAverage(childTokens),
      maxEstimatedEmbeddingTokens: maximum(childTokens),
      averageProviderEmbeddingTokens: roundedAverage(providerChildTokens),
      maxProviderEmbeddingTokens: maximum(providerChildTokens),
      maxProviderParentTokens: maximum(providerParentTokens)
    }
  };
};

export const chunkDocument = (text, rawConfig = {}, runtime = {}) => {
  const canonicalText = normalizeCanonicalText(text);
  const config = normalizeChunkingConfig(rawConfig);
  const points = Array.from(canonicalText);
  const tokenizer = normalizeTokenCounter(runtime?.tokenizer || runtime?.tokenizerAdapter);
  if ((config.parentTokenTarget || config.childTokenTarget) && !tokenizer) throw Object.assign(new Error("a provider tokenizer is required when a token target is configured"), { code: "TOKENIZER_REQUIRED" });
  const parserInput = normalizeParserInput(runtime, points.length);
  const { selected: firstStrategy, profile } = profileAndSelectStrategy(canonicalText, config.strategy, parserInput);
  const strategyChain = config.strategy === "auto" ? [...new Set([firstStrategy, "heading", "heuristic", "legacy"])] : firstStrategy === "legacy" ? ["legacy"] : [firstStrategy, "legacy"];
  let selected = strategyChain.at(-1);
  let parentChunks = [];
  let validation = { ok: false, reasons: ["not-run"] };
  for (const candidate of strategyChain) {
    const candidateChunks = splitWithStrategy(canonicalText, config.parentChunkSize, candidate, config.maxProtectedSize, 0, parserInput.blocks.length || parserInput.pages.length ? parserInput : null);
    const tokenLimitedChunks = config.parentTokenTarget ? candidateChunks.flatMap((chunk) => splitChunkByTokenTarget(points, chunk, config.parentTokenTarget, tokenizer)) : candidateChunks;
    const candidateValidation = validateChunks(tokenLimitedChunks, points.length, config.parentChunkSize);
    parentChunks = tokenLimitedChunks;
    validation = candidateValidation;
    selected = candidate;
    if (candidateValidation.ok) break;
  }
  const parents = [];
  const children = [];
  let sequence = 0;
  parentChunks.forEach((parent, parentIndex) => {
    const localPoints = Array.from(parent.content);
    const parentUnit = { start: 0, end: localPoints.length, type: parent.protectedType || "paragraph", protected: Boolean(parent.protectedType), protectedType: parent.protectedType || null, structurePath: parent.structurePath || [] };
    let localChildren;
    if (parent.protectedType === "code") {
      const parentIsOversizedCodePart = parent.partCount > 1 || parent.splitReason?.includes("code-");
      localChildren = splitCodeUnit(localPoints, parentUnit, config.childChunkSize, config.maxProtectedSize, !parentIsOversizedCodePart);
    }
    else if (parent.protectedType === "formula") {
      const parentIsOversizedFormulaPart = parent.partCount > 1 || parent.splitReason?.includes("formula-");
      localChildren = splitFormulaUnit(localPoints, parentUnit, config.childChunkSize, config.maxProtectedSize, !parentIsOversizedFormulaPart);
    }
    else if (parent.protectedType === "table") {
      const inheritedHeader = parent.partIndex > 0 ? parent.tableHeader || null : null;
      localChildren = splitTableUnit(localPoints, parentUnit, config.childChunkSize, config.maxProtectedSize, inheritedHeader);
    } else localChildren = splitWithStrategy(parent.content, config.childChunkSize, "legacy", config.maxProtectedSize, config.childOverlap);
    localChildren = localChildren.map((child) => ({
      ...child,
      start: child.start + parent.start,
      end: child.end + parent.start,
      content: points.slice(child.start + parent.start, child.end + parent.start).join(""),
      contextHeader: [parent.contextHeader, child.contextHeader || child.structuralContext].filter(Boolean).join("\n"),
      structurePath: mergeStructurePaths(parent.structurePath, child.structurePath),
      protectedGroup: parent.protectedGroup || child.protectedGroup || null,
      forcedSplit: Boolean(child.forcedSplit || (parent.protectedType && parent.forcedSplit)),
      splitReason: [...new Set([parent.protectedType ? parent.splitReason : null, child.splitReason].filter(Boolean))].join(",") || null
    }));
    if (config.childTokenTarget) localChildren = localChildren.flatMap((child) => splitChunkByTokenTarget(points, child, config.childTokenTarget, tokenizer, child.contextHeader || ""));
    const singleChild = localChildren.length === 1 && localChildren[0].content === parent.content && localChildren[0].start === parent.start && localChildren[0].end === parent.end;
    const retainProtectedParent = Boolean(parent.protectedType && (codePointLength(parent.content) > config.childChunkSize || parent.partCount > 1));
    let parentId = null;
    if (!singleChild || retainProtectedParent) {
      parentId = `parent:${parentIndex}`;
      parents.push({ ...parent, sequence: sequence++, parentIndex, id: parentId, chunkType: "parent_text" });
    }
    localChildren.forEach((child, childIndex) => children.push({ ...child, sequence: sequence++, parentIndex: parentId ? parentIndex : null, childIndex, chunkType: "text" }));
  });
  const decoratedParents = parents.map((chunk) => decorateChunk(chunk, tokenizer));
  const decoratedChildren = children.map((chunk) => decorateChunk(chunk, tokenizer));
  const blocks = extractDocumentBlocks(canonicalText, parserInput);
  return {
    config,
    strategy: selected,
    strategyChain,
    validation,
    profile,
    canonicalText,
    blocks,
    parents: decoratedParents,
    children: decoratedChildren,
    diagnostics: chunkingDiagnostics({ blocks, parentWindows: parentChunks, parents: decoratedParents, children: decoratedChildren, config, tokenizer }),
    totalChunks: decoratedParents.length + decoratedChildren.length,
    output: [...decoratedParents, ...decoratedChildren].sort((left, right) => left.sequence - right.sequence)
  };
};

export const chunkText = (content, size = 800) => {
  const canonicalText = normalizeCanonicalText(content);
  const chunks = splitWithStrategy(canonicalText, asPositiveInt(size, 800, "size"), "legacy", DEFAULT_CHUNKING_CONFIG.maxProtectedSize, 0);
  return chunks.map((chunk, sequence) => decorateCanonicalMetadata({ sequence, content: chunk.content, start: chunk.start, end: chunk.end, startOffset: chunk.start, endOffset: chunk.end, forcedSplit: Boolean(chunk.forcedSplit), sizeUnit: CHUNK_SIZE_UNIT, structurePath: chunk.structurePath || [], sizeMetrics: sizeMetricsFor(chunk.content) }, "fragment"));
};
