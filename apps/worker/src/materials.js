import { spawn } from "node:child_process";
import { normalizeCanonicalText, readBytes, safeStoragePath, sha256 } from "@myknow/db";

const parseFailure = (message, metadata = {}, code = "PARSE_FAILED") => Object.assign(new Error(message), { code, metadata });

const decodeUtf8 = (bytes) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw parseFailure("source is not valid UTF-8"); }
};

const quality = (text, sourceKind) => {
  const points = Array.from(text);
  const trimmed = text.trim();
  if (!trimmed) throw parseFailure("parsed content is empty");
  const replacementCount = points.filter((point) => point === "\uFFFD").length;
  const controlCount = points.filter((point) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(point)).length;
  const replacementRatio = replacementCount / Math.max(1, points.length);
  const printableRatio = (points.length - controlCount) / Math.max(1, points.length);
  if (replacementRatio > 0.01 || printableRatio < 0.85) throw parseFailure("parsed content failed quality gate", { replacementRatio, printableRatio });
  if (sourceKind === "pdf" && Array.from(trimmed).length < 32) throw parseFailure("parsed content is too short", { minimumCodePoints: 32 });
  return { replacementRatio, printableRatio, codePointCount: points.length };
};

const assetsFromMarkdown = (text) => [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => ({ type: "image", alt: match[1], originalRef: match[2], stableRef: null }));

const parsePdfWithMarkItDown = (filePath, maxBytes, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  const child = spawn("python", ["-m", "markitdown", filePath], { shell: false });
  const chunks = [];
  let size = 0;
  let settled = false;
  const timer = setTimeout(() => { child.kill(); finish(reject, parseFailure("PDF parser timed out", { timeoutMs })); }, timeoutMs);
  const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
  child.stdout.on("data", (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > maxBytes) { child.kill(); finish(reject, parseFailure("PDF parser output is too large")); return; }
    chunks.push(chunk);
  });
  child.stderr.resume();
  child.on("error", () => finish(reject, parseFailure("PDF parser unavailable")));
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

const readText = (version, config) => {
  const canonicalText = normalizeCanonicalText(decodeUtf8(readStoredBytes(version, config)));
  return { canonicalText, title: null, assets: assetsFromMarkdown(canonicalText), parserName: "utf8", parserVersion: "1", quality: quality(canonicalText, "text") };
};

const readPdf = async (version, config, parserName) => {
  const bytes = readStoredBytes(version, config);
  const filePath = safeStoragePath(config.resourceStorageDir, version.storage_key);
  const output = parserName === "markitdown" ? await parsePdfWithMarkItDown(filePath, config.resourceMaxBytes, config.resourceParserTimeoutMs) : extractPdfLiterals(bytes);
  const canonicalText = normalizeCanonicalText(output);
  return { canonicalText, title: null, assets: assetsFromMarkdown(canonicalText), parserName, parserVersion: parserName === "markitdown" ? "python-module" : "basic-literals-1", quality: quality(canonicalText, "pdf") };
};

export const createMaterialReader = (config) => ({
  async read(version, hooks = {}) {
    const candidates = version.mime_type === "application/pdf" ? [
      { name: "markitdown", version: "python-module", read: () => readPdf(version, config, "markitdown") },
      { name: "pdf-basic", version: "basic-literals-1", read: () => readPdf(version, config, "pdf-basic") }
    ] : version.mime_type === "text/markdown" || version.mime_type === "text/plain" ? [{ name: "utf8", version: "1", read: () => readText(version, config) }] : [];
    if (!candidates.length) throw parseFailure("unsupported resource MIME");
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
      }
    }
    throw lastError || parseFailure("no material reader succeeded");
  }
});
