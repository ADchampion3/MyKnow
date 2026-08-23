const STRATEGIES = new Set(["auto", "heading", "heuristic", "legacy", "recursive"]);

export const DEFAULT_CHUNKING_CONFIG = Object.freeze({
  strategy: "auto",
  parentChunkSize: 4096,
  childChunkSize: 384,
  childOverlap: 76,
  maxProtectedSize: 7500
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

export const normalizeChunkingConfig = (value = {}) => {
  if (value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("chunking config must be an object"), { code: "VALIDATION_ERROR" });
  const input = value;
  const strategy = String(input.strategy ?? "auto").toLowerCase();
  if (!STRATEGIES.has(strategy)) throw Object.assign(new Error("strategy must be auto, heading, heuristic, or legacy"), { code: "VALIDATION_ERROR" });
  const parentChunkSize = asPositiveInt(input.parentChunkSize ?? input.parent_chunk_size, DEFAULT_CHUNKING_CONFIG.parentChunkSize, "parentChunkSize");
  const childChunkSize = asPositiveInt(input.childChunkSize ?? input.child_chunk_size, DEFAULT_CHUNKING_CONFIG.childChunkSize, "childChunkSize");
  if (parentChunkSize <= childChunkSize) throw Object.assign(new Error("parentChunkSize must be greater than childChunkSize"), { code: "VALIDATION_ERROR" });
  const requestedOverlap = asNonNegativeInt(input.childOverlap ?? input.child_overlap, DEFAULT_CHUNKING_CONFIG.childOverlap, "childOverlap");
  const childOverlap = Math.min(requestedOverlap, Math.floor(childChunkSize / 2));
  const maxProtectedSize = asPositiveInt(input.maxProtectedSize ?? input.max_protected_size, DEFAULT_CHUNKING_CONFIG.maxProtectedSize, "maxProtectedSize");
  return { strategy, parentChunkSize, childChunkSize, childOverlap, maxProtectedSize };
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
  return trimmed.includes("|") && trimmed.split("|").length >= 3;
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

const profileDocument = (text) => {
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
  const density = text.length ? headingCount / Math.max(1, Array.from(text).length) : 0;
  return { headingCount, headingDensity: density, heuristicMarkers, pageBreaks, codeLines, tableLines };
};

const chooseStrategy = (text, configured) => {
  if (configured !== "auto") return configured === "recursive" ? "legacy" : configured;
  const profile = profileDocument(text);
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
      units.push({ start, end, type: "code", protected: true });
      continue;
    }
    if (inFence) {
      units.push({ start: line.start, end: line.fullEnd, type: "code", protected: true });
      index += 1;
      continue;
    }
    if (isTableLine(line.text)) {
      const start = line.start;
      let end = line.fullEnd;
      index += 1;
      while (index < lines.length && (isTableLine(lines[index].text) || !lines[index].text.trim())) { end = lines[index].fullEnd; index += 1; }
      units.push({ start, end, type: "table", protected: true });
      continue;
    }
    const start = line.start;
    let end = line.fullEnd;
    const type = lineHeading ? "heading" : line.text.trim() ? "paragraph" : "blank";
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (isFenceLine(next.text) || isTableLine(next.text) || isMarkdownHeading(next.text)) break;
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
    sections.push({ start: line.start, contextHeader: stack.map((item) => `#${item.level} ${item.title}`).join("\n") });
  }
  if (!sections.length) return [{ start: 0, end: Array.from(text).length, contextHeader: "" }];
  const result = [];
  if (sections[0].start > 0) result.push({ start: 0, end: sections[0].start, contextHeader: "" });
  for (let index = 0; index < sections.length; index += 1) result.push({ start: sections[index].start, end: sections[index + 1]?.start ?? Array.from(text).length, contextHeader: sections[index].contextHeader });
  return result;
};

const heuristicSections = (text) => {
  const { lines } = lineRecords(text);
  const boundaries = [{ start: 0, contextHeader: "" }];
  let inFence = false;
  for (const line of lines) {
    if (isFenceLine(line.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const marker = isNumberedHeading(line.text) || isVisualRule(line.text) || isAllCapsHeading(line.text) || line.text.includes("\f");
    if (marker && line.start > 0) boundaries.push({ start: line.start, contextHeader: line.text.replace(/\f/g, " ").trim() });
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
  for (let index = desiredEnd; index > start + Math.floor((desiredEnd - start) * 0.55); index -= 1) {
    if (/\s|[。！？；，.!?,;:：]/.test(points[index - 1] || "")) return index;
  }
  return desiredEnd;
};

const splitOversized = (points, unit, target, maxProtectedSize, protectedRanges = []) => {
  const result = [];
  let start = unit.start;
  const end = unit.end;
  while (start < end) {
    const desired = Math.min(end, start + target);
    const cut = unit.protected && end - start <= maxProtectedSize ? desired : safeCut(points, start, desired, end, protectedRanges, maxProtectedSize);
    result.push({ start, end: cut, type: unit.type, protected: unit.protected, forcedSplit: true });
    if (cut <= start) break;
    start = cut;
  }
  return result;
};

const packRange = (points, rangeStart, rangeEnd, target, maxProtectedSize, contextHeader) => {
  const text = points.slice(rangeStart, rangeEnd).join("");
  const protectedRanges = inlineProtectedRanges(text).map((range) => ({ ...range, start: range.start + rangeStart, end: range.end + rangeStart }));
  const localUnits = buildUnits(text).map((unit) => ({ ...unit, start: unit.start + rangeStart, end: unit.end + rangeStart }));
  const units = [];
  for (const unit of localUnits) {
    if (unit.end - unit.start > target) units.push(...splitOversized(points, unit, target, maxProtectedSize, protectedRanges));
    else units.push(unit);
  }
  const chunks = [];
  let current = [];
  let currentStart = null;
  let currentEnd = null;
  const flush = () => {
    if (currentStart === null || currentEnd === null || currentEnd <= currentStart) return;
    chunks.push({ start: currentStart, end: currentEnd, content: points.slice(currentStart, currentEnd).join(""), contextHeader, forcedSplit: current.some((unit) => unit.forcedSplit), blockTypes: [...new Set(current.map((unit) => unit.type))] });
    current = [];
    currentStart = null;
    currentEnd = null;
  };
  for (const unit of units) {
    if (currentStart !== null && currentEnd + (unit.end - unit.start) > target) flush();
    if (currentStart === null) currentStart = unit.start;
    currentEnd = unit.end;
    current.push(unit);
  }
  flush();
  return chunks;
};

const applyOverlap = (points, chunks, overlap) => {
  if (!overlap || chunks.length < 2) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const desiredStart = Math.max(chunks[index - 1].start, chunk.start - overlap);
    let start = desiredStart;
    while (start < chunk.start && start < points.length && !/\s|[。！？；，.!?,;:：]/.test(points[start])) start += 1;
    if (start >= chunk.start) start = desiredStart;
    return { ...chunk, start, content: points.slice(start, chunk.end).join(""), overlap: chunk.start - start };
  });
};

const splitWithStrategy = (text, target, strategy, maxProtectedSize, overlap = 0) => {
  // ponytail: code-point arrays keep offsets deterministic and auditable for the local MVP; a streaming segmenter is the upgrade path for very large documents.
  const points = Array.from(text);
  const sections = strategy === "heading" ? headingSections(text) : strategy === "heuristic" ? heuristicSections(text) : [{ start: 0, end: points.length, contextHeader: "" }];
  const chunks = sections.flatMap((section) => packRange(points, section.start, section.end, target, maxProtectedSize, section.contextHeader));
  return applyOverlap(points, chunks, overlap);
};

export const extractDocumentBlocks = (text) => buildUnits(text).map((unit) => ({ type: unit.type, start: unit.start, end: unit.end, protected: Boolean(unit.protected) }));

export const profileAndSelectStrategy = (text, configured = "auto") => {
  const canonicalText = normalizeCanonicalText(text);
  const selected = chooseStrategy(canonicalText, configured);
  return { selected, profile: profileDocument(canonicalText) };
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
    if (chunk.end - chunk.start > targetSize * 2 && !chunk.forcedSplit) reasons.push("oversized-chunk");
    cursor = chunk.end;
  }
  if (totalCodePoints > targetSize * 2 && chunks.length === 1) reasons.push("large-document-single-chunk");
  return { ok: reasons.length === 0, reasons };
};

export const chunkDocument = (text, rawConfig = {}) => {
  const canonicalText = normalizeCanonicalText(text);
  const config = normalizeChunkingConfig(rawConfig);
  const { selected: firstStrategy, profile } = profileAndSelectStrategy(canonicalText, config.strategy);
  const points = Array.from(canonicalText);
  const strategyChain = config.strategy === "auto" ? [...new Set([firstStrategy, "heading", "heuristic", "legacy"])] : firstStrategy === "legacy" ? ["legacy"] : [firstStrategy, "legacy"];
  let selected = strategyChain.at(-1);
  let parentChunks = [];
  let validation = { ok: false, reasons: ["not-run"] };
  for (const candidate of strategyChain) {
    const candidateChunks = splitWithStrategy(canonicalText, config.parentChunkSize, candidate, config.maxProtectedSize, 0);
    const candidateValidation = validateChunks(candidateChunks, points.length, config.parentChunkSize);
    parentChunks = candidateChunks;
    validation = candidateValidation;
    selected = candidate;
    if (candidateValidation.ok) break;
  }
  const parents = [];
  const children = [];
  let sequence = 0;
  parentChunks.forEach((parent, parentIndex) => {
    const localChildren = splitWithStrategy(parent.content, config.childChunkSize, "legacy", config.maxProtectedSize, config.childOverlap).map((child) => ({
      ...child,
      start: child.start + parent.start,
      end: child.end + parent.start,
      content: points.slice(child.start + parent.start, child.end + parent.start).join(""),
      contextHeader: [parent.contextHeader, child.contextHeader].filter(Boolean).join("\n")
    }));
    const singleChild = localChildren.length === 1 && localChildren[0].content === parent.content && localChildren[0].start === parent.start && localChildren[0].end === parent.end;
    let parentId = null;
    if (!singleChild) {
      parentId = `parent:${parentIndex}`;
      parents.push({ ...parent, sequence: sequence++, parentIndex, id: parentId, chunkType: "parent_text" });
    }
    localChildren.forEach((child, childIndex) => children.push({ ...child, sequence: sequence++, parentIndex: parentId ? parentIndex : null, childIndex, chunkType: "text" }));
  });
  return {
    config,
    strategy: selected,
    strategyChain,
    validation,
    profile,
    canonicalText,
    blocks: extractDocumentBlocks(canonicalText),
    parents,
    children,
    totalChunks: parents.length + children.length,
    output: [...parents, ...children].sort((left, right) => left.sequence - right.sequence)
  };
};

export const chunkText = (content, size = 800) => {
  const canonicalText = normalizeCanonicalText(content);
  const chunks = splitWithStrategy(canonicalText, asPositiveInt(size, 800, "size"), "legacy", DEFAULT_CHUNKING_CONFIG.maxProtectedSize, 0);
  return chunks.map((chunk, sequence) => ({ sequence, content: chunk.content, startOffset: chunk.start, endOffset: chunk.end, forcedSplit: Boolean(chunk.forcedSplit) }));
};
