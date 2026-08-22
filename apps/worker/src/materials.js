import { spawn } from "node:child_process";
import path from "node:path";
import { normalizeCanonicalText, persistBytes, readBytes, safeStoragePath, sha256, validatePublicUrlResolved } from "@myknow/db";

const parseFailure = (message, metadata = {}) => Object.assign(new Error(message), { code: "PARSE_FAILED", metadata });

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
  if ((sourceKind === "pdf" || sourceKind === "url") && Array.from(trimmed).length < 32) throw parseFailure("parsed content is too short", { minimumCodePoints: 32 });
  return { replacementRatio, printableRatio, codePointCount: points.length };
};

const numericEntity = (value, radix) => {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : "";
};
const decodeHtmlEntities = (value) => value
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")
  .replace(/&#(\d+);/g, (_, code) => numericEntity(code, 10))
  .replace(/&#x([\da-f]+);/gi, (_, code) => numericEntity(code, 16));

// ponytail: this deliberately small HTML reader handles Sprint 2 documents; a DOM/reader adapter is the upgrade path for malformed layout-heavy pages.
const htmlToCanonicalText = (html) => decodeHtmlEntities(html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
  .replace(/<li\b[^>]*>/gi, "\n- ")
  .replace(/<\/?(?:p|div|section|article|header|footer|main|aside|li|tr|br|h[1-6])\b[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/[ \t]+/g, " ")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim());

const titleFromHtml = (html) => decodeHtmlEntities((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || null;
const assetsFromMarkdown = (text) => [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => ({ type: "image", alt: match[1], originalRef: match[2], stableRef: null }));

const parsePdfWithMarkItDown = (filePath, maxBytes) => new Promise((resolve, reject) => {
  const child = spawn("python", ["-m", "markitdown", filePath], { shell: false });
  const chunks = [];
  let size = 0;
  let settled = false;
  const timer = setTimeout(() => { child.kill(); finish(reject, parseFailure("PDF parser timed out")); }, 20_000);
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
  if (sha256(bytes) !== version.content_sha256 || bytes.length !== version.byte_size) throw parseFailure("stored source integrity check failed");
  return bytes;
};

const readText = (version, config) => {
  const canonicalText = normalizeCanonicalText(decodeUtf8(readStoredBytes(version, config)));
  return { canonicalText, title: null, assets: assetsFromMarkdown(canonicalText), parserName: "utf8", parserVersion: "1", quality: quality(canonicalText, "text") };
};

const readPdf = async (version, config, parserName) => {
  const bytes = readStoredBytes(version, config);
  const filePath = safeStoragePath(config.resourceStorageDir, version.storage_key);
  const output = parserName === "markitdown" ? await parsePdfWithMarkItDown(filePath, config.resourceMaxBytes) : extractPdfLiterals(bytes);
  const canonicalText = normalizeCanonicalText(output);
  return { canonicalText, title: null, assets: assetsFromMarkdown(canonicalText), parserName, parserVersion: parserName === "markitdown" ? "python-module" : "basic-literals-1", quality: quality(canonicalText, "pdf") };
};

const readWebPage = async (version, config) => {
  const sourceUrl = await validatePublicUrlResolved(version.source_url);
  const response = await fetch(sourceUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || response.status >= 300) throw parseFailure("URL fetch failed", { status: response.status });
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw parseFailure("URL is not an HTML page", { contentType });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > config.resourceMaxBytes) throw parseFailure("URL response is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > config.resourceMaxBytes) throw parseFailure("URL response is too large or empty");
  const html = decodeUtf8(bytes);
  const canonicalText = htmlToCanonicalText(html);
  const snapshotKey = path.posix.join("snapshots", sha256(bytes) + ".html");
  persistBytes(config.resourceStorageDir, snapshotKey, bytes);
  return { canonicalText, title: titleFromHtml(html), assets: assetsFromMarkdown(canonicalText), parserName: "html-basic", parserVersion: "2", storageKey: snapshotKey, byteSize: bytes.length, mimeType: "text/html", contentSha256: sha256(bytes), fetchedAt: new Date().toISOString(), sourceUrl, quality: quality(canonicalText, "url") };
};

export const createMaterialReader = (config) => ({
  async read(version, hooks = {}) {
    const candidates = version.source_url ? [{ name: "html-basic", version: "2", read: () => readWebPage(version, config) }] : version.mime_type === "application/pdf" ? [
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
