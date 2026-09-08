import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  CORPUS_SCHEMA_VERSION,
  QRELS_SCHEMA_VERSION,
  QUERIES_SCHEMA_VERSION,
  SCIFACT_ARCHIVE_SHA256 as CONTRACT_SCIFACT_ARCHIVE_SHA256,
  SCIFACT_ARCHIVE_MD5 as CONTRACT_SCIFACT_ARCHIVE_MD5,
  SCIFACT_ARCHIVE_BYTES as CONTRACT_SCIFACT_ARCHIVE_BYTES,
  validateCorpus,
  validateEvaluationManifest,
  validateQrels,
  validateQueries
} from "../evals/raw-hybrid-retrieval/src/contracts.js";

export const SCIFACT_ARCHIVE_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip";
export const SCIFACT_ARCHIVE_SHA256 = CONTRACT_SCIFACT_ARCHIVE_SHA256;
export const SCIFACT_ARCHIVE_MD5 = CONTRACT_SCIFACT_ARCHIVE_MD5;
export const SCIFACT_ARCHIVE_BYTES = CONTRACT_SCIFACT_ARCHIVE_BYTES;
export const SCIFACT_MANIFEST_SCHEMA_VERSION = "raw-hybrid-eval-scifact-manifest-v1";
export const SCIFACT_CONVERSION_VERSION = "scifact-beir-test-v1";
export const SCIFACT_EXPECTED_COUNTS = Object.freeze({ corpus: 5183, queries: 300, qrels: 339 });
export const SCIFACT_SOURCE_QUERY_COUNT = 1109;
export const SCIFACT_KNOWLEDGE_BASE_ID = "8a8c5f5d-2b21-4f5f-8f2e-2f5f0a4d7b6c";

const fail = (message, code = "SCIFACT_IMPORT_FAILED", cause) => Object.assign(new Error(message, { cause }), { code });
const sourceFiles = Object.freeze({
  corpus: "scifact/corpus.jsonl",
  queries: "scifact/queries.jsonl",
  testQrels: "scifact/qrels/test.tsv"
});

const hashFile = (filePath) => {
  const bytes = fs.readFileSync(filePath);
  return {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    md5: crypto.createHash("md5").update(bytes).digest("hex")
  };
};

const hashBytes = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalizeText = (value, label) => {
  if (typeof value !== "string") throw fail(`${label} must be a string`, "SCIFACT_SOURCE_INVALID");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw fail(`${label} must not be empty`, "SCIFACT_SOURCE_INVALID");
  return { value: normalized, changed: normalized !== value };
};
const numericCompare = (left, right) => {
  const a = Number(left);
  const b = Number(right);
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? a - b : String(left).localeCompare(String(right));
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const readJsonl = (filePath, label) => {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); }
  catch (caught) { throw fail(`${label} could not be read: ${caught.message}`, "SCIFACT_SOURCE_MISSING", caught); }
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (caught) { throw fail(`${label} line ${index + 1} is invalid JSON`, "SCIFACT_SOURCE_INVALID", caught); }
  }
  if (!rows.length) throw fail(`${label} is empty`, "SCIFACT_SOURCE_INVALID");
  return rows;
};

const readQrels = (filePath) => {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); }
  catch (caught) { throw fail(`test qrels could not be read: ${caught.message}`, "SCIFACT_SOURCE_MISSING", caught); }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  if (!lines.length || lines[0] !== "query-id\tcorpus-id\tscore") throw fail("test qrels must start with query-id, corpus-id, score header", "SCIFACT_SOURCE_INVALID");
  const rows = [];
  const seen = new Set();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields.some((field) => !field.trim())) throw fail(`test qrels line ${index + 2} must contain three tab-separated fields`, "SCIFACT_SOURCE_INVALID");
    const [queryId, corpusId, rawScore] = fields.map((field) => field.trim());
    const score = Number(rawScore);
    if (!Number.isInteger(score) || ![0, 1, 2].includes(score)) throw fail(`test qrels line ${index + 2} has invalid score '${rawScore}'`, "SCIFACT_SOURCE_INVALID");
    const key = `${queryId}\u0000${corpusId}`;
    if (seen.has(key)) throw fail(`test qrels contains duplicate judgment '${queryId}/${corpusId}'`, "SCIFACT_SOURCE_INVALID");
    seen.add(key);
    rows.push({ queryId, corpusId, score });
  }
  if (!rows.length) throw fail("test qrels contains no judgments", "SCIFACT_SOURCE_INVALID");
  return rows;
};

const archiveEntries = (archivePath) => {
  let listing;
  try { listing = execFileSync("tar", ["-tf", archivePath], { encoding: "utf8" }); }
  catch (caught) { throw fail(`could not list SciFact archive: ${caught.message}`, "SCIFACT_ARCHIVE_INVALID", caught); }
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  for (const entry of entries) {
    const portable = entry.replaceAll("\\", "/");
    if (portable.includes("\0") || portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable)) throw fail(`archive entry escapes extraction root: ${entry}`, "SCIFACT_ARCHIVE_UNSAFE");
    const normalized = path.posix.normalize(portable);
    if (normalized === ".." || normalized.startsWith("../")) throw fail(`archive entry escapes extraction root: ${entry}`, "SCIFACT_ARCHIVE_UNSAFE");
  }
  let verboseListing;
  try { verboseListing = execFileSync("tar", ["-tvf", archivePath], { encoding: "utf8" }); }
  catch (caught) { throw fail(`could not inspect SciFact archive entries: ${caught.message}`, "SCIFACT_ARCHIVE_INVALID", caught); }
  for (const line of verboseListing.split(/\r?\n/u).filter(Boolean)) {
    if (/^[lLhH]/u.test(line)) throw fail(`archive contains a link entry: ${line}`, "SCIFACT_ARCHIVE_UNSAFE");
  }
  const expected = new Set(Object.values(sourceFiles));
  for (const required of expected) if (!entries.includes(required)) throw fail(`archive is missing required entry '${required}'`, "SCIFACT_ARCHIVE_INVALID");
  return entries;
};

export const extractSciFactArchive = ({ archivePath, destination }) => {
  if (!archivePath || typeof archivePath !== "string" || !fs.existsSync(archivePath)) throw fail(`archive does not exist: ${archivePath}`, "SCIFACT_ARCHIVE_MISSING");
  if (!destination || typeof destination !== "string") throw fail("archive extraction destination is required", "SCIFACT_ARCHIVE_INVALID");
  archiveEntries(archivePath);
  fs.mkdirSync(destination, { recursive: true });
  try { execFileSync("tar", ["-xf", archivePath, "-C", destination], { stdio: "pipe" }); }
  catch (caught) { throw fail(`could not extract SciFact archive: ${caught.message}`, "SCIFACT_ARCHIVE_INVALID", caught); }
  return path.join(destination, "scifact");
};

const safeSourceUrl = (value) => {
  let sourceUrl;
  try { sourceUrl = new URL(value); } catch { throw fail("SciFact source URL is invalid", "SCIFACT_DOWNLOAD_INVALID"); }
  if (!["http:", "https:"].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) throw fail("SciFact source URL must be a credential-free HTTP(S) URL", "SCIFACT_DOWNLOAD_INVALID");
  return sourceUrl.toString();
};

export const downloadSciFactArchive = async ({ url = SCIFACT_ARCHIVE_URL, targetPath } = {}) => {
  if (!targetPath || typeof targetPath !== "string") throw fail("targetPath is required", "SCIFACT_ARCHIVE_INVALID");
  const sourceUrl = safeSourceUrl(url);
  let response;
  try { response = await fetch(sourceUrl); }
  catch (caught) { throw fail(`SciFact download failed: ${caught.message}`, "SCIFACT_DOWNLOAD_FAILED", caught); }
  if (!response.ok || !response.body) throw fail(`SciFact download returned HTTP ${response.status}`, "SCIFACT_DOWNLOAD_FAILED");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: "wx" }));
    fs.renameSync(temporary, targetPath);
  } catch (caught) {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {}
    throw fail(`SciFact download could not be saved: ${caught.message}`, "SCIFACT_DOWNLOAD_FAILED", caught);
  }
  return targetPath;
};

export const verifySciFactArchive = (archivePath, expected = {}) => {
  if (!archivePath || typeof archivePath !== "string" || !fs.existsSync(archivePath)) throw fail(`archive does not exist: ${archivePath}`, "SCIFACT_ARCHIVE_MISSING");
  let actual;
  try { actual = hashFile(archivePath); }
  catch (caught) { throw fail(`could not read SciFact archive: ${caught.message}`, "SCIFACT_ARCHIVE_INVALID", caught); }
  const expectedBytes = expected.bytes ?? SCIFACT_ARCHIVE_BYTES;
  const expectedSha256 = String(expected.sha256 ?? SCIFACT_ARCHIVE_SHA256).toLowerCase();
  const expectedMd5 = String(expected.md5 ?? SCIFACT_ARCHIVE_MD5).toLowerCase();
  if (actual.bytes !== expectedBytes || actual.sha256 !== expectedSha256 || actual.md5 !== expectedMd5) {
    throw fail(`SciFact archive integrity check failed (bytes=${actual.bytes}, sha256=${actual.sha256}, md5=${actual.md5})`, "SCIFACT_ARCHIVE_INTEGRITY");
  }
  return actual;
};

const sourcePath = (root, relative) => path.join(root, relative.replaceAll("/", path.sep).replace(/^scifact[\\/]/u, ""));

export const convertSciFactSources = ({ sourceRoot, archive, sourceUrl = SCIFACT_ARCHIVE_URL, verifyOfficialCounts = true }) => {
  if (!sourceRoot || typeof sourceRoot !== "string") throw fail("sourceRoot is required", "SCIFACT_SOURCE_INVALID");
  sourceUrl = safeSourceUrl(sourceUrl);
  if (!archive || archive.sha256 !== SCIFACT_ARCHIVE_SHA256 || archive.md5 !== SCIFACT_ARCHIVE_MD5 || archive.bytes !== SCIFACT_ARCHIVE_BYTES) throw fail("conversion requires the verified pinned SciFact archive metadata", "SCIFACT_ARCHIVE_INTEGRITY");
  const corpusRows = readJsonl(sourcePath(sourceRoot, sourceFiles.corpus), "corpus.jsonl");
  const queryRows = readJsonl(sourcePath(sourceRoot, sourceFiles.queries), "queries.jsonl");
  const qrelRows = readQrels(sourcePath(sourceRoot, sourceFiles.testQrels));
  const corpusById = new Map();
  let normalizedCorpusTextCount = 0;
  let normalizedCorpusTitleCount = 0;
  for (const row of corpusRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw fail("corpus.jsonl rows must be objects", "SCIFACT_SOURCE_INVALID");
    const sourceId = String(row._id ?? "").trim();
    if (!sourceId || corpusById.has(sourceId)) throw fail(`corpus.jsonl contains duplicate or empty _id '${sourceId}'`, "SCIFACT_SOURCE_INVALID");
    const title = normalizeText(row.title, `corpus '${sourceId}' title`);
    const content = normalizeText(row.text, `corpus '${sourceId}' text`);
    if (title.changed) normalizedCorpusTitleCount += 1;
    if (content.changed) normalizedCorpusTextCount += 1;
    corpusById.set(sourceId, { sourceId, title: title.value, content: content.value });
  }
  const queriesById = new Map();
  let normalizedQueryCount = 0;
  for (const row of queryRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw fail("queries.jsonl rows must be objects", "SCIFACT_SOURCE_INVALID");
    const sourceId = String(row._id ?? "").trim();
    if (!sourceId || queriesById.has(sourceId)) throw fail(`queries.jsonl contains duplicate or empty _id '${sourceId}'`, "SCIFACT_SOURCE_INVALID");
    const query = normalizeText(row.text, `query '${sourceId}'`);
    if (query.changed) normalizedQueryCount += 1;
    queriesById.set(sourceId, { sourceId, query: query.value });
  }
  const qrelsByQuery = new Map();
  for (const row of qrelRows) {
    if (!corpusById.has(row.corpusId)) throw fail(`test qrels references unknown corpus document '${row.corpusId}'`, "SCIFACT_SOURCE_INVALID");
    if (!queriesById.has(row.queryId)) throw fail(`test qrels references unknown query '${row.queryId}'`, "SCIFACT_SOURCE_INVALID");
    const values = qrelsByQuery.get(row.queryId) || [];
    values.push(row);
    qrelsByQuery.set(row.queryId, values);
  }
  for (const [queryId, rows] of qrelsByQuery) if (!rows.some((row) => row.score > 0)) throw fail(`test qrels query '${queryId}' has no positive judgment`, "SCIFACT_SOURCE_INVALID");
  if (verifyOfficialCounts) {
    if (corpusRows.length !== SCIFACT_EXPECTED_COUNTS.corpus || queryRows.length !== SCIFACT_SOURCE_QUERY_COUNT || qrelRows.length !== SCIFACT_EXPECTED_COUNTS.qrels || qrelsByQuery.size !== SCIFACT_EXPECTED_COUNTS.queries) {
      throw fail(`unexpected SciFact counts (corpus=${corpusRows.length}, queries=${queryRows.length}, testQueries=${qrelsByQuery.size}, qrels=${qrelRows.length})`, "SCIFACT_SOURCE_COUNTS");
    }
  }

  const corpus = validateCorpus({
    schemaVersion: CORPUS_SCHEMA_VERSION,
    knowledgeBaseId: SCIFACT_KNOWLEDGE_BASE_ID,
    chunks: [...corpusById.values()].sort((left, right) => numericCompare(left.sourceId, right.sourceId)).map((row) => ({
      chunkId: `scifact:chunk:${row.sourceId}`,
      resourceId: `scifact:resource:${row.sourceId}`,
      resourceVersionId: `scifact:version:${row.sourceId}`,
      processingRunId: `scifact:run:${row.sourceId}`,
      resourceName: `SciFact ${row.sourceId}`,
      title: row.title,
      contextHeader: row.title,
      content: row.content,
      parentChunkId: null,
      parentContent: null,
      locator: { dataset: "beir", name: "scifact", split: "corpus", sourceId: row.sourceId }
    }))
  });
  const queries = validateQueries({
    schemaVersion: QUERIES_SCHEMA_VERSION,
    queries: [...qrelsByQuery.keys()].sort(numericCompare).map((sourceId) => ({ id: `scifact:query:${sourceId}`, query: queriesById.get(sourceId).query, tags: ["beir", "scifact", "test", "en"], locator: { dataset: "beir", name: "scifact", split: "test", sourceId } }))
  });
  const qrels = validateQrels({
    schemaVersion: QRELS_SCHEMA_VERSION,
    judgments: [...qrelsByQuery.entries()].sort(([left], [right]) => numericCompare(left, right)).map(([sourceId, rows]) => ({
      queryId: `scifact:query:${sourceId}`,
      relevant: rows.sort((left, right) => numericCompare(left.corpusId, right.corpusId)).map((row) => ({ chunkId: `scifact:chunk:${row.corpusId}`, grade: row.score }))
    }))
  }, { corpus, queries });

  const sourceHashes = Object.fromEntries(Object.entries(sourceFiles).map(([name, relative]) => [name, { path: relative, ...hashFile(sourcePath(sourceRoot, relative)) }]));
  const manifest = {
    schemaVersion: SCIFACT_MANIFEST_SCHEMA_VERSION,
    dataset: "BEIR SciFact",
    source: { url: sourceUrl, archiveSha256: archive.sha256, archiveMd5: archive.md5, archiveBytes: archive.bytes, files: sourceHashes },
    conversion: {
      version: SCIFACT_CONVERSION_VERSION,
      split: "test",
      idRules: "scifact:<kind>:<original-id>; knowledge base UUID is deterministic for this dataset",
      textRules: "NFKC then trim corpus title/text and query text; title is contextHeader and is not concatenated into content",
      rawChildMapping: "one source corpus document to one raw child chunk; no parent chunk",
      qrelRules: "test qrels only; preserve source score as grade 0/1/2; missing qrels remain unjudged",
      resourceNameRule: "SciFact <original document id>"
    },
    counts: {
      expected: { ...SCIFACT_EXPECTED_COUNTS, sourceQueries: SCIFACT_SOURCE_QUERY_COUNT },
      actual: { corpus: corpus.chunks.length, queries: queries.queries.length, qrels: qrels.judgments.reduce((sum, judgment) => sum + judgment.relevant.length, 0), qrelQueries: qrels.judgments.length },
      source: { corpus: corpusRows.length, queries: queryRows.length, testQrelQueries: qrelsByQuery.size, testQrels: qrelRows.length }
    },
    normalization: { algorithm: "NFKC + trim", affected: { corpusText: normalizedCorpusTextCount, corpusTitle: normalizedCorpusTitleCount, queryText: normalizedQueryCount }, knownCorpusTextAffected: 63 },
    originalIds: { corpus: [...corpusById.keys()].sort(numericCompare), testQueries: [...qrelsByQuery.keys()].sort(numericCompare) }
  };
  return { corpus, queries, qrels, manifest };
};

const filesFor = (outputDir, values) => ({
  corpus: path.join(outputDir, "corpus.json"),
  queries: path.join(outputDir, "queries.json"),
  qrels: path.join(outputDir, "qrels.json"),
  manifest: path.join(outputDir, "manifest.json"),
  values
});

const publish = (outputDir, files) => {
  const parent = path.dirname(outputDir);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(outputDir)) {
    const existing = filesFor(outputDir, null);
    const targets = [existing.corpus, existing.queries, existing.qrels, existing.manifest];
    if (targets.every((filePath) => fs.existsSync(filePath))) {
      const dataSame = [[existing.corpus, files.corpus], [existing.queries, files.queries], [existing.qrels, files.qrels]].every(([left, right]) => fs.readFileSync(left, "utf8") === fs.readFileSync(right, "utf8"));
      const manifestSame = fs.readFileSync(existing.manifest, "utf8") === fs.readFileSync(files.manifest, "utf8");
      if (dataSame && manifestSame) return;
      if (!dataSame) throw fail(`output directory already exists and differs: ${outputDir}`, "SCIFACT_OUTPUT_EXISTS");
      const backup = `${existing.manifest}.${process.pid}.${crypto.randomUUID()}.bak`;
      try { fs.renameSync(existing.manifest, backup); fs.renameSync(files.manifest, existing.manifest); fs.rmSync(backup, { force: true }); }
      catch (caught) {
        if (!fs.existsSync(existing.manifest) && fs.existsSync(backup)) { try { fs.renameSync(backup, existing.manifest); } catch {} }
        throw fail(`could not update converted dataset manifest: ${caught.message}`, "SCIFACT_OUTPUT_FAILED", caught);
      }
      return;
    }
    const present = targets.filter((filePath) => fs.existsSync(filePath));
    // A clean checkout may contain only the versioned manifest because the
    // bulky inputs are ignored. It is safe to replace that marker once the
    // newly converted files have passed validation.
    const manifestOnly = present.length === 1 && present[0] === existing.manifest;
    if (present.length && !manifestOnly) throw fail(`output directory contains an incomplete generated dataset: ${outputDir}`, "SCIFACT_OUTPUT_EXISTS");
    const generated = [files.corpus, files.queries, files.qrels, files.manifest];
    const moved = [];
    const backup = manifestOnly ? `${existing.manifest}.${process.pid}.${crypto.randomUUID()}.bak` : null;
    try {
      if (backup) fs.renameSync(existing.manifest, backup);
      for (const filePath of generated) {
        const target = path.join(outputDir, path.basename(filePath));
        fs.renameSync(filePath, target);
        moved.push(target);
      }
      if (backup) fs.rmSync(backup, { force: true });
    } catch (caught) {
      for (const target of moved) { try { fs.rmSync(target, { force: true }); } catch {} }
      if (backup && fs.existsSync(backup) && !fs.existsSync(existing.manifest)) { try { fs.renameSync(backup, existing.manifest); } catch {} }
      throw fail(`could not publish converted dataset: ${caught.message}`, "SCIFACT_OUTPUT_FAILED", caught);
    }
    return;
  }
  fs.renameSync(files.tempDir, outputDir);
};

export const importSciFact = async ({ archivePath, archiveUrl = SCIFACT_ARCHIVE_URL, outputDir, sourceDir, verifyOfficialCounts = true } = {}) => {
  if (!outputDir || typeof outputDir !== "string") throw fail("outputDir is required", "SCIFACT_IMPORT_INVALID");
  if (archivePath !== undefined && typeof archivePath !== "string") throw fail("archivePath must be a string", "SCIFACT_IMPORT_INVALID");
  if (sourceDir !== undefined && typeof sourceDir !== "string") throw fail("sourceDir must be a string", "SCIFACT_IMPORT_INVALID");
  const sourceUrl = safeSourceUrl(archiveUrl);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedSource = path.resolve(sourceDir || path.join(resolvedOutput, ".source", "scifact"));
  let archive = archivePath ? path.resolve(archivePath) : path.join(resolvedOutput, ".source", "scifact.zip");
  if (!fs.existsSync(archive)) await downloadSciFactArchive({ url: sourceUrl, targetPath: archive });
  archive = path.resolve(archive);
  const archiveInfo = verifySciFactArchive(archive);
  // Keep the staging directory beside the destination so the final rename is
  // atomic on filesystems that reject cross-volume moves.
  const tempRoot = fs.mkdtempSync(path.join(path.dirname(resolvedOutput), ".myknow-scifact-import-"));
  const extractionRoot = path.join(tempRoot, "extract");
  try {
    const extracted = extractSciFactArchive({ archivePath: archive, destination: extractionRoot });
    if (fs.existsSync(resolvedSource)) {
      const existing = Object.values(sourceFiles).map((relative) => sourcePath(resolvedSource, relative));
      if (!existing.every((filePath) => fs.existsSync(filePath))) throw fail(`source directory exists but is incomplete: ${resolvedSource}`, "SCIFACT_SOURCE_INVALID");
      for (const relative of Object.values(sourceFiles)) {
        const current = hashFile(sourcePath(resolvedSource, relative));
        const fresh = hashFile(sourcePath(extracted, relative));
        if (current.sha256 !== fresh.sha256 || current.bytes !== fresh.bytes) throw fail(`source directory does not match the verified archive: ${resolvedSource}`, "SCIFACT_SOURCE_INTEGRITY");
      }
    } else {
      fs.mkdirSync(path.dirname(resolvedSource), { recursive: true });
      fs.cpSync(extracted, resolvedSource, { recursive: true, errorOnExist: true });
    }
    const converted = convertSciFactSources({ sourceRoot: extracted, archive: archiveInfo, sourceUrl, verifyOfficialCounts });
    const tempOutput = path.join(tempRoot, "output");
    fs.mkdirSync(tempOutput);
    const corpusText = json(converted.corpus);
    const queriesText = json(converted.queries);
    const qrelsText = json(converted.qrels);
    const outputHashes = { corpus: hashBytes(Buffer.from(corpusText)), queries: hashBytes(Buffer.from(queriesText)), qrels: hashBytes(Buffer.from(qrelsText)) };
    converted.manifest.outputs = { files: { "corpus.json": outputHashes.corpus, "queries.json": outputHashes.queries, "qrels.json": outputHashes.qrels } };
    fs.writeFileSync(path.join(tempOutput, "corpus.json"), corpusText, "utf8");
    fs.writeFileSync(path.join(tempOutput, "queries.json"), queriesText, "utf8");
    fs.writeFileSync(path.join(tempOutput, "qrels.json"), qrelsText, "utf8");
    fs.writeFileSync(path.join(tempOutput, "manifest.json"), json(converted.manifest), "utf8");
    const checkedQueries = validateQueries(JSON.parse(queriesText));
    const checkedCorpus = validateCorpus(JSON.parse(corpusText));
    const checkedQrels = validateQrels(JSON.parse(qrelsText), { corpus: checkedCorpus, queries: checkedQueries });
    validateEvaluationManifest(JSON.parse(fs.readFileSync(path.join(tempOutput, "manifest.json"), "utf8")), { corpus: checkedCorpus, queries: checkedQueries, qrels: checkedQrels, paths: { corpus: path.join(tempOutput, "corpus.json"), queries: path.join(tempOutput, "queries.json"), qrels: path.join(tempOutput, "qrels.json") } });
    const files = { tempDir: tempOutput, corpus: path.join(tempOutput, "corpus.json"), queries: path.join(tempOutput, "queries.json"), qrels: path.join(tempOutput, "qrels.json"), manifest: path.join(tempOutput, "manifest.json") };
    publish(resolvedOutput, files);
    return { outputDir: resolvedOutput, sourceDir: resolvedSource, archive: archiveInfo, manifest: converted.manifest };
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
};

const option = (args, name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const defaultOutput = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evals/raw-hybrid-retrieval/data");
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const result = await importSciFact({ archivePath: option(args, "--archive"), outputDir: option(args, "--output-dir") || defaultOutput, sourceDir: option(args, "--source-dir") });
    console.log(JSON.stringify({ outputDir: result.outputDir, sourceDir: result.sourceDir, archive: result.archive, counts: result.manifest.counts.actual }, null, 2));
  } catch (caught) {
    console.error(`SciFact import failed [${caught.code || "SCIFACT_IMPORT_FAILED"}]: ${caught.message}`);
    process.exitCode = 1;
  }
}
