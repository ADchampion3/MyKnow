import { spawn } from "node:child_process";
import { deriveCanonicalArtifact, normalizeCanonicalText, processingRequestFromVersion, readBytes, safeStoragePath, sha256 } from "@myknow/db";
import { DefaultOcrProviderRegistry, OcrProviderAdapter } from "./ocr/adapter.js";

const parseFailure = (message, metadata = {}, code = "PARSE_FAILED") => Object.assign(new Error(message), { code, metadata });
const isCancelled = (caught, signal) => signal?.aborted || caught?.code === "TASK_CANCELLED";

const decodeUtf8 = (bytes) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw parseFailure("source is not valid UTF-8"); }
};

const quality = (text, sourceKind, { ocr = false } = {}) => {
  const points = Array.from(text);
  const trimmed = text.trim();
  if (!trimmed) throw parseFailure("parsed content is empty");
  const replacementCount = points.filter((point) => point === "\uFFFD").length;
  const controlCount = points.filter((point) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(point)).length;
  const replacementRatio = replacementCount / Math.max(1, points.length);
  const printableRatio = (points.length - controlCount) / Math.max(1, points.length);
  if (replacementRatio > 0.01 || printableRatio < 0.85) throw parseFailure("parsed content failed quality gate", { replacementRatio, printableRatio });
  if (sourceKind === "pdf" && !ocr && Array.from(trimmed).length < 32) throw parseFailure("parsed content is too short", { minimumCodePoints: 32 });
  return { replacementRatio, printableRatio, codePointCount: points.length };
};

const assetsFromMarkdown = (text) => [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => ({ type: "image", alt: match[1], originalRef: match[2], stableRef: null }));

const parsePdfWithMarkItDown = (filePath, maxBytes, timeoutMs = 120_000, signal, python = "python") => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error("PDF parsing was cancelled"), { code: "TASK_CANCELLED" }));
  const child = spawn(python, ["-m", "markitdown", filePath], { shell: false });
  const chunks = [];
  let size = 0;
  let settled = false;
  const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); callback(value); };
  const onAbort = () => { child.kill(); finish(reject, Object.assign(new Error("PDF parsing was cancelled"), { code: "TASK_CANCELLED" })); };
  const timer = setTimeout(() => { child.kill(); finish(reject, parseFailure("PDF parser timed out", { timeoutMs }, "PARSER_TIMEOUT")); }, timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > maxBytes) { child.kill(); finish(reject, parseFailure("PDF parser output is too large")); return; }
    chunks.push(chunk);
  });
  child.stderr.resume();
  child.on("error", () => finish(reject, parseFailure("PDF parser unavailable", {}, "PARSER_UNAVAILABLE")));
  child.on("close", (code) => {
    if (settled) return;
    const output = Buffer.concat(chunks).toString("utf8");
    if (code !== 0 || !output.trim()) return finish(reject, parseFailure("PDF parsing failed"));
    finish(resolve, output);
  });
});

const decodePdfLiteral = (value) => value.replace(/\\([\\()nrt])/g, (_, escaped) => ({ n: "\n", r: "\r", t: "\t" }[escaped] || escaped));
const extractPdfLiterals = (bytes) => {
  const source = bytes.toString("latin1");
  const literals = [...source.matchAll(/\(([^()]*)\)\s*T[Jj]/g)].map((match) => decodePdfLiteral(match[1])).filter(Boolean);
  return literals.join(" ");
};

const readStoredBytes = (version, config) => {
  const bytes = readBytes(config.resourceStorageDir, version.storage_key);
  if (sha256(bytes) !== version.content_sha256 || bytes.length !== version.byte_size) throw parseFailure("stored source integrity check failed", {}, "SOURCE_INTEGRITY_FAILED");
  return bytes;
};

const nativeParsed = (canonicalText, parserName, parserVersion, sourceKind) => {
  const normalized = normalizeCanonicalText(canonicalText);
  return {
    canonicalText: normalized,
    pages: [{ pageNumber: 1, status: "succeeded", blocks: [{ kind: "text", type: "text", order: 0, text: normalized, confidence: null, warnings: [] }] }],
    blocks: [{ kind: "text", type: "text", order: 0, text: normalized, pageNumber: 1, start: 0, end: Array.from(normalized).length, confidence: null, warnings: [] }],
    title: null,
    assets: assetsFromMarkdown(normalized),
    parserName,
    parserVersion,
    provider: null,
    metadata: { processing: "native" },
    quality: quality(normalized, sourceKind)
  };
};

const safeOcrMetadata = (metadata) => {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  const allowed = ["provider", "adapterName", "adapterVersion", "modelName", "modelVersion", "requestId", "durationMs", "cost", "warnings"];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]).filter(([, value]) => typeof value !== "string" || !/api[_-]?key|secret|token/i.test(value)));
};

const ocrParsed = (result, adapter, request, started) => {
  const artifact = deriveCanonicalArtifact({ ...result, requestedCapabilities: request.capabilities });
  const parsedQuality = quality(artifact.canonicalText, "pdf", { ocr: true });
  const metadata = safeOcrMetadata({ ...adapter, ...(result.metadata || {}), durationMs: Date.now() - started });
  return {
    canonicalText: artifact.canonicalText,
    pages: artifact.pages,
    blocks: artifact.blocks,
    title: null,
    assets: assetsFromMarkdown(artifact.canonicalText),
    parserName: metadata.adapterName || adapter.adapterName || adapter.name,
    parserVersion: metadata.adapterVersion || adapter.adapterVersion || adapter.version,
    provider: request.provider,
    metadata: { ocr: { ...metadata, provider: request.provider, capabilities: artifact.capabilities, warnings: artifact.warnings } },
    ocr: { capabilities: artifact.capabilities, warnings: artifact.warnings, pageCount: artifact.pages.length, adapter: metadata },
    quality: { ...parsedQuality, pageCount: artifact.pages.length, warningCount: artifact.warnings.length }
  };
};

const readText = (version, config) => nativeParsed(decodeUtf8(readStoredBytes(version, config)), "utf8", "1", "text");

const readPdf = async (version, config, parserName, signal) => {
  const bytes = readStoredBytes(version, config);
  const filePath = safeStoragePath(config.resourceStorageDir, version.storage_key);
  const output = parserName === "markitdown" ? await parsePdfWithMarkItDown(filePath, config.resourceMaxBytes, config.resourceParserTimeoutMs, signal, config.pdfPythonPath || "python") : extractPdfLiterals(bytes);
  return nativeParsed(output, parserName, parserName === "markitdown" ? "python-module" : "basic-literals-1", "pdf");
};

export const createMaterialReader = (config) => {
  const providerRegistry = config.ocrProviderRegistry || new DefaultOcrProviderRegistry(config);
  return {
    async read(version, hooks = {}) {
      const isPdf = version.mime_type === "application/pdf";
      const processingRequest = processingRequestFromVersion(version, { isPdf });
      const candidates = [];
      if (isPdf && processingRequest.mode !== "off") {
        const adapter = providerRegistry.resolve(processingRequest.provider);
        if (!adapter) throw parseFailure(`OCR provider is unavailable: ${processingRequest.provider}`, {}, "OCR_PROVIDER_UNAVAILABLE");
        if (!(adapter instanceof OcrProviderAdapter)) throw parseFailure(`OCR adapter is invalid: ${processingRequest.provider}`, {}, "OCR_PROVIDER_UNAVAILABLE");
        candidates.push({ name: adapter.name, version: adapter.version, kind: "ocr", read: async () => {
          const started = Date.now();
          const result = await adapter.process({
            sourcePath: safeStoragePath(config.resourceStorageDir, version.storage_key),
            source: { mimeType: version.mime_type, filename: version.original_filename, byteSize: version.byte_size, sha256: version.content_sha256 },
            mode: processingRequest.mode,
            provider: processingRequest.provider,
            capabilities: processingRequest.capabilities,
            limits: { maxBytes: config.resourceMaxBytes, maxPages: config.ocrMaxPages, timeoutMs: config.resourceParserTimeoutMs },
            signal: hooks.signal,
            onPageProgress: (page, total) => hooks.progress?.({ page, total, progress: Math.min(99, Math.round((page / Math.max(1, total)) * 100)) })
          });
          return ocrParsed(result, adapter.descriptor(), processingRequest, started);
        } });
      }
      if (!isPdf || processingRequest.mode !== "force") {
        if (isPdf) {
          candidates.push({ name: "markitdown", version: "python-module", kind: "native", read: () => readPdf(version, config, "markitdown", hooks.signal) });
          candidates.push({ name: "pdf-basic", version: "basic-literals-1", kind: "native", read: () => readPdf(version, config, "pdf-basic", hooks.signal) });
        } else if (version.mime_type === "text/markdown" || version.mime_type === "text/plain") {
          candidates.push({ name: "utf8", version: "1", kind: "native", read: () => readText(version, config) });
        }
      }
      if (!candidates.length) throw parseFailure("unsupported resource MIME", {}, "UNSUPPORTED_MEDIA_TYPE");
      let lastError = null;
      for (const candidate of candidates) {
        const attempt = hooks.start ? await hooks.start(candidate) : null;
        try {
          const result = await candidate.read();
          if (hooks.success) await hooks.success(attempt, result);
          return result;
        } catch (caught) {
          lastError = caught;
          if (hooks.failure) await hooks.failure(attempt, caught);
          if (isCancelled(caught, hooks.signal)) throw caught;
        }
      }
      throw lastError || parseFailure("no material reader succeeded");
    }
  };
};

export { CloudOcrProviderAdapter, DefaultOcrProviderRegistry, LocalOcrProviderAdapter, MockOcrProviderAdapter, OcrProviderAdapter, OcrProviderRegistry, PaddleOcrProviderAdapter, renderPdfPages } from "./ocr/adapter.js";
