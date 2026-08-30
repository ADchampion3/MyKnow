import crypto from "node:crypto";
import { normalizeCanonicalText } from "./chunker.js";

export const OCR_MODES = Object.freeze(["auto", "off", "force"]);
export const OCR_PROVIDERS = Object.freeze(["local", "cloud", "paddleocr"]);
export const OCR_BLOCK_KINDS = Object.freeze(["text", "table", "formula"]);
export const OCR_CAPABILITIES = Object.freeze(["text", "table", "formula"]);

export const ocrCacheKey = ({ sourceSha256, provider, modelVersion, capabilities }) => crypto.createHash("sha256").update(JSON.stringify({ sourceSha256: String(sourceSha256 || "").toLowerCase(), provider: String(provider || ""), modelVersion: String(modelVersion || ""), capabilities: Object.fromEntries(OCR_CAPABILITIES.map((kind) => [kind, Boolean(capabilities?.[kind])])) })).digest("hex");

const error = (message, code, metadata = {}) => Object.assign(new Error(message), { code, metadata });
const asString = (value) => typeof value === "string" ? value.trim() : "";
const parseJson = (value, code, message) => {
  try { return JSON.parse(value); }
  catch { throw error(message, code); }
};

const normalizeCapabilities = (value, mode) => {
  if (value === undefined || value === null) return {
    text: true,
    table: mode === "off" ? false : true,
    formula: mode === "off" ? false : true
  };
  if (Array.isArray(value)) {
    const selected = new Set(value.map((item) => asString(item).toLowerCase()));
    if (!selected.size || [...selected].some((item) => !OCR_CAPABILITIES.includes(item))) throw error("capabilities must contain text, table, or formula", "OCR_CAPABILITIES_INVALID");
    return Object.fromEntries(OCR_CAPABILITIES.map((item) => [item, selected.has(item)]));
  }
  if (typeof value !== "object") throw error("capabilities must be an object or array", "OCR_CAPABILITIES_INVALID");
  if (OCR_CAPABILITIES.some((item) => value[item] !== undefined && typeof value[item] !== "boolean")) throw error("OCR capability values must be booleans", "OCR_CAPABILITIES_INVALID");
  const result = Object.fromEntries(OCR_CAPABILITIES.map((item) => [item, value[item] === undefined ? item === "text" : value[item] === true]));
  if (!Object.values(result).some(Boolean)) throw error("at least one OCR capability is required", "OCR_CAPABILITIES_INVALID");
  return result;
};

export const normalizeOcrProcessingRequest = (input = {}, { isPdf = true, requireProvider = isPdf } = {}) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw error("OCR processing request must be an object", "OCR_REQUEST_INVALID");
  const rawMode = input.ocrMode ?? input.ocr_mode ?? input.mode;
  const mode = rawMode === undefined || rawMode === null || rawMode === "" ? (isPdf ? "auto" : "off") : asString(rawMode).toLowerCase();
  if (!OCR_MODES.includes(mode)) throw error("ocrMode must be auto, off, or force", "OCR_MODE_INVALID");
  if (!isPdf && mode !== "off") throw error("OCR is supported only for PDF resources", "OCR_UNSUPPORTED_MEDIA");
  const rawProvider = input.ocrProvider ?? input.ocr_provider ?? input.provider;
  const provider = rawProvider === undefined || rawProvider === null || rawProvider === "" ? null : asString(rawProvider).toLowerCase();
  if (provider !== null && !OCR_PROVIDERS.includes(provider)) throw error("ocrProvider must be local, cloud, or paddleocr", "OCR_PROVIDER_INVALID");
  if (requireProvider && !provider) throw error("ocrProvider is required for PDF processing", "OCR_PROVIDER_REQUIRED");
  return { mode, provider, capabilities: normalizeCapabilities(input.ocrCapabilities ?? input.ocr_capabilities ?? input.capabilities, mode) };
};

export const processingRequestFromVersion = (version, { isPdf = version?.mime_type === "application/pdf" } = {}) => normalizeOcrProcessingRequest({
  ...(version?.processing_request && typeof version.processing_request === "string" ? parseJson(version.processing_request, "OCR_REQUEST_INVALID", "stored OCR processing request is invalid") : version?.processingRequest || {}),
  ocrMode: version?.ocr_mode ?? version?.ocrMode ?? version?.processingRequest?.mode,
  ocrProvider: version?.ocr_provider ?? version?.ocrProvider ?? version?.processingRequest?.provider,
  ocrCapabilities: typeof version?.ocr_capabilities === "string" ? parseJson(version.ocr_capabilities, "OCR_CAPABILITIES_INVALID", "stored OCR capabilities are invalid") : version?.ocr_capabilities ?? version?.ocrCapabilities ?? version?.processingRequest?.capabilities
}, { isPdf, requireProvider: false });

const normalizeWarnings = (value) => Array.isArray(value) ? value.map((warning) => String(warning)).filter(Boolean) : [];

const normalizeBlock = (block, pageNumber, fallbackOrder) => {
  if (!block || typeof block !== "object") throw error(`page ${pageNumber} contains an invalid block`, "OCR_RESULT_INVALID");
  const kind = asString(block.kind ?? block.type).toLowerCase();
  if (!OCR_BLOCK_KINDS.includes(kind)) throw error(`page ${pageNumber} contains an unsupported block kind`, "OCR_RESULT_INVALID", { pageNumber, kind });
  if (typeof block.text !== "string" || !block.text.trim()) throw error(`page ${pageNumber} contains an empty block`, "OCR_RESULT_INVALID", { pageNumber, kind });
  const order = block.order === undefined ? fallbackOrder : Number(block.order);
  if (!Number.isInteger(order) || order < 0) throw error(`page ${pageNumber} block order is invalid`, "OCR_RESULT_INVALID", { pageNumber, kind });
  const confidence = block.confidence === undefined || block.confidence === null ? null : Number(block.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw error(`page ${pageNumber} block confidence is invalid`, "OCR_RESULT_INVALID", { pageNumber, kind });
  return { kind, type: kind, order, text: normalizeCanonicalText(block.text), confidence, warnings: normalizeWarnings(block.warnings) };
};

const normalizePage = (page, fallbackPageNumber) => {
  if (!page || typeof page !== "object") throw error("OCR result contains an invalid page", "OCR_RESULT_INVALID");
  const pageNumber = Number(page.pageNumber ?? page.page_number ?? fallbackPageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw error("OCR page number is invalid", "OCR_RESULT_INVALID");
  const status = asString(page.status || "succeeded").toLowerCase();
  if (!["succeeded", "failed", "skipped"].includes(status)) throw error(`page ${pageNumber} has an invalid status`, "OCR_RESULT_INVALID");
  const blocks = Array.isArray(page.blocks) ? page.blocks.map((block, index) => normalizeBlock(block, pageNumber, index)).sort((left, right) => left.order - right.order) : [];
  return { pageNumber, status, blocks, warnings: normalizeWarnings(page.warnings), error: page.error ? String(page.error) : null };
};

export const validateOcrPages = (value, requestedCapabilities = { text: true, table: true, formula: true }) => {
  if (!value || !Array.isArray(value.pages) || !value.pages.length) throw error("OCR result must contain pages", "OCR_RESULT_INVALID");
  const pages = value.pages.map((page, index) => normalizePage(page, index + 1));
  pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) throw error("OCR pages must be numbered consecutively from 1", "OCR_PAGE_NUMBER_INVALID");
    if (page.status !== "succeeded") throw error(`OCR page ${page.pageNumber} did not complete successfully`, "OCR_PAGE_INCOMPLETE", { pageNumber: page.pageNumber, status: page.status, error: page.error });
    if (page.error) throw error(`OCR page ${page.pageNumber} returned an unresolved error`, "OCR_PAGE_ERROR", { pageNumber: page.pageNumber, error: page.error });
  });
  if (!pages.some((page) => page.blocks.length)) throw error("OCR result contains no blocks", "OCR_RESULT_EMPTY");
  const capabilities = {
    text: Boolean(value.capabilities?.text ?? pages.some((page) => page.blocks.some((block) => block.kind === "text"))),
    table: Boolean(value.capabilities?.table ?? pages.some((page) => page.blocks.some((block) => block.kind === "table"))),
    formula: Boolean(value.capabilities?.formula ?? pages.some((page) => page.blocks.some((block) => block.kind === "formula")))
  };
  const hasWarnings = normalizeWarnings(value.warnings).length || pages.some((page) => page.warnings.length || page.blocks.some((block) => block.warnings.length));
  for (const kind of OCR_CAPABILITIES) {
    if (requestedCapabilities[kind] && value.capabilities && value.capabilities[kind] === false && !hasWarnings) {
      throw error(`requested OCR capability is unavailable: ${kind}`, "OCR_CAPABILITY_UNAVAILABLE", { capability: kind });
    }
  }
  return { pages, capabilities, warnings: normalizeWarnings(value.warnings), metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : {} };
};

export const deriveCanonicalArtifact = (value) => {
  const checked = validateOcrPages(value, value.requestedCapabilities || { text: true, table: true, formula: true });
  let canonicalText = "";
  let canonicalOffset = 0;
  const blocks = [];
  const warnings = [...checked.warnings, ...checked.pages.flatMap((page) => [...page.warnings, ...page.blocks.flatMap((block) => block.warnings)])];
  const pages = checked.pages.map((page) => {
    const marker = `<!-- page:${page.pageNumber} -->`;
    const markerPrefix = `${canonicalText ? "\n\n" : ""}${marker}`;
    canonicalText += markerPrefix;
    canonicalOffset += Array.from(markerPrefix).length;
    const pageStart = canonicalOffset;
    const enrichedBlocks = [];
    for (const block of page.blocks) {
      const start = canonicalOffset + 2;
      canonicalText += `\n\n${block.text}`;
      canonicalOffset = start + Array.from(block.text).length;
      const end = canonicalOffset;
      const enriched = { ...block, pageNumber: page.pageNumber, start, end };
      blocks.push(enriched);
      enrichedBlocks.push(enriched);
    }
    const pageEnd = Array.from(canonicalText).length;
    return { ...page, blocks: enrichedBlocks, canonicalStart: pageStart, canonicalEnd: pageEnd };
  });
  return {
    pages,
    blocks,
    capabilities: checked.capabilities,
    warnings: [...new Set(warnings)],
    metadata: checked.metadata,
    canonicalText: normalizeCanonicalText(canonicalText)
  };
};

export const nativePages = (text, pageNumber = 1) => deriveCanonicalArtifact({
  pages: [{ pageNumber, status: "succeeded", blocks: [{ kind: "text", order: 0, text }] }],
  capabilities: { text: true, table: false, formula: false },
  requestedCapabilities: { text: true, table: false, formula: false }
});
