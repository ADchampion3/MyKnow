import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertEgressAllowed } from "@myknow/config";
import {
  embeddingInputSha256,
  embeddingInputText,
  isUuid,
  validateEmbeddingVector
} from "@myknow/db";

export const CORPUS_SCHEMA_VERSION = "raw-hybrid-eval-corpus-v1";
export const QUERIES_SCHEMA_VERSION = "raw-hybrid-eval-queries-v1";
export const QRELS_SCHEMA_VERSION = "raw-hybrid-eval-qrels-v1";
export const SNAPSHOT_SCHEMA_VERSION = "raw-hybrid-eval-embedding-snapshot-v1";
export const RANKING_SCHEMA_VERSION = "raw-hybrid-eval-ranking-v1";
export const REPORT_SCHEMA_VERSION = "raw-hybrid-eval-report-v1";
export const MANIFEST_SCHEMA_VERSION = "raw-hybrid-eval-scifact-manifest-v1";
export const SCIFACT_ARCHIVE_SHA256 = "536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165";
export const SCIFACT_ARCHIVE_MD5 = "5f7d1de60b170fc8027bb7898e2efca1";
export const SCIFACT_ARCHIVE_BYTES = 2816079;
export const EXPECTED_EVAL_EMBEDDING_DIMENSIONS = 4096;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/u;
const REAL_EMBEDDING_PROVIDERS = new Set(["openai", "openai-compatible"]);
const MOCK_EMBEDDING_MODELS = new Set(["mock", "mock-hash", "mock-hash-v1"]);

const fail = (message, code = "EVAL_DATA_INVALID") => Object.assign(new Error(message), { code });

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value, label) => {
  if (!isRecord(value)) throw fail(`${label} must be an object`);
  return value;
};

const requireString = (value, label, { max = 10000, allowEmpty = false } = {}) => {
  if (typeof value !== "string") throw fail(`${label} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!allowEmpty && !normalized) throw fail(`${label} must not be empty`);
  if (Array.from(normalized).length > max) throw fail(`${label} must be at most ${max} characters`);
  return normalized;
};

const stableId = (value, label) => {
  const id = requireString(value, label, { max: 201 });
  if (!STABLE_ID_RE.test(id)) throw fail(`${label} must use a stable identifier without whitespace or path separators`);
  return id;
};

const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw fail(`${label} contains duplicate identifier '${value}'`);
    seen.add(value);
  }
  return seen;
};

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const sha256Bytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileSha256 = (filePath) => sha256Bytes(fs.readFileSync(filePath));

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
};

export const stableStringify = (value) => JSON.stringify(canonicalValue(value));

const assertSchemaVersion = (value, expected, label) => {
  if (value !== expected) throw fail(`${label}.schemaVersion must be '${expected}'`);
};

const normalizeLocator = (value, chunkId, resourceVersionId) => {
  if (value === undefined || value === null) return { chunkId, resourceVersionId };
  if (!isRecord(value)) throw fail(`corpus chunk '${chunkId}' locator must be an object`);
  try {
    JSON.stringify(value);
  } catch {
    throw fail(`corpus chunk '${chunkId}' locator must be JSON serializable`);
  }
  return value;
};

export const validateCorpus = (input) => {
  const corpus = requireRecord(input, "corpus");
  assertSchemaVersion(corpus.schemaVersion, CORPUS_SCHEMA_VERSION, "corpus");
  const knowledgeBaseId = requireString(corpus.knowledgeBaseId, "corpus.knowledgeBaseId", { max: 36 });
  if (!isUuid(knowledgeBaseId)) throw fail("corpus.knowledgeBaseId must be a UUID");
  if (!Array.isArray(corpus.chunks) || corpus.chunks.length === 0) throw fail("corpus.chunks must contain at least one raw child chunk");

  const chunkIds = [];
  const resources = new Map();
  const parents = new Map();
  const chunks = corpus.chunks.map((raw, index) => {
    const value = requireRecord(raw, `corpus.chunks[${index}]`);
    const chunkId = stableId(value.chunkId, `corpus.chunks[${index}].chunkId`);
    chunkIds.push(chunkId);
    const resourceId = stableId(value.resourceId, `corpus chunk '${chunkId}' resourceId`);
    const resourceVersionId = stableId(value.resourceVersionId, `corpus chunk '${chunkId}' resourceVersionId`);
    const processingRunId = stableId(value.processingRunId, `corpus chunk '${chunkId}' processingRunId`);
    const content = requireString(value.content, `corpus chunk '${chunkId}' content`, { max: 1_000_000 });
    const contextHeader = value.contextHeader === undefined || value.contextHeader === null
      ? null
      : requireString(value.contextHeader, `corpus chunk '${chunkId}' contextHeader`, { max: 100_000, allowEmpty: true }) || null;
    const resourceName = value.resourceName === undefined
      ? `Evaluation resource ${resourceId}`
      : requireString(value.resourceName, `corpus chunk '${chunkId}' resourceName`, { max: 120 });
    const title = value.title === undefined
      ? resourceName
      : requireString(value.title, `corpus chunk '${chunkId}' title`, { max: 512 });
    const parentChunkId = value.parentChunkId === undefined || value.parentChunkId === null || value.parentChunkId === ""
      ? null
      : stableId(value.parentChunkId, `corpus chunk '${chunkId}' parentChunkId`);
    const parentContent = value.parentContent === undefined || value.parentContent === null
      ? null
      : requireString(value.parentContent, `corpus chunk '${chunkId}' parentContent`, { max: 1_000_000 });
    if (parentChunkId && parentChunkId === chunkId) throw fail(`corpus chunk '${chunkId}' cannot be its own parent`);
    if (parentChunkId && !parentContent) throw fail(`corpus chunk '${chunkId}' parentContent is required with parentChunkId`);
    if (!parentChunkId && parentContent) throw fail(`corpus chunk '${chunkId}' cannot provide parentContent without parentChunkId`);
    if (parentChunkId && parents.has(parentChunkId) && parents.get(parentChunkId) !== parentContent) {
      throw fail(`parent chunk '${parentChunkId}' has conflicting parentContent`);
    }
    if (parentChunkId) parents.set(parentChunkId, parentContent);

    const resourceKey = resourceId;
    const resourceMetadata = { resourceVersionId, processingRunId, resourceName, title };
    const previousResource = resources.get(resourceKey);
    if (previousResource && stableStringify(previousResource) !== stableStringify(resourceMetadata)) {
      throw fail(`resource '${resourceId}' must use one active resource version and processing run in the evaluation corpus`);
    }
    resources.set(resourceKey, resourceMetadata);

    return {
      chunkId,
      resourceId,
      resourceVersionId,
      processingRunId,
      resourceName,
      title,
      content,
      contextHeader,
      parentChunkId,
      parentContent,
      locator: normalizeLocator(value.locator, chunkId, resourceVersionId)
    };
  });
  unique(chunkIds, "corpus.chunks.chunkId");
  const childIds = new Set(chunkIds);
  for (const parentId of parents.keys()) if (childIds.has(parentId)) throw fail(`parent chunk identifier '${parentId}' collides with a raw child chunk identifier`);

  return { schemaVersion: CORPUS_SCHEMA_VERSION, knowledgeBaseId, chunks, resources: [...resources.entries()].map(([id, metadata]) => ({ id, ...metadata })) };
};

export const validateQueries = (input) => {
  const queriesDocument = requireRecord(input, "queries");
  assertSchemaVersion(queriesDocument.schemaVersion, QUERIES_SCHEMA_VERSION, "queries");
  if (!Array.isArray(queriesDocument.queries) || queriesDocument.queries.length === 0) throw fail("queries.queries must contain at least one query");
  const ids = [];
  const queries = queriesDocument.queries.map((raw, index) => {
    const value = requireRecord(raw, `queries.queries[${index}]`);
    const id = stableId(value.id, `queries.queries[${index}].id`);
    ids.push(id);
    const query = requireString(value.query, `query '${id}'`, { max: 256 });
    const tags = value.tags === undefined ? [] : value.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !tag.trim())) throw fail(`query '${id}' tags must be an array of non-empty strings`);
    let locator = null;
    if (value.locator !== undefined && value.locator !== null) {
      if (!isRecord(value.locator)) throw fail(`query '${id}' locator must be an object`);
      try { JSON.stringify(value.locator); } catch { throw fail(`query '${id}' locator must be JSON serializable`); }
      locator = value.locator;
    }
    return { id, query, tags: [...new Set(tags.map((tag) => tag.normalize("NFKC").trim()))], locator };
  });
  unique(ids, "queries.queries.id");
  return { schemaVersion: QUERIES_SCHEMA_VERSION, queries };
};

const normalizeGrade = (value, label) => {
  if (typeof value !== "number" || !Number.isInteger(value) || ![0, 1, 2].includes(value)) throw fail(`${label} must be an integer grade 0, 1, or 2`);
  return value;
};

export const validateQrels = (input, { corpus, queries } = {}) => {
  const qrelsDocument = requireRecord(input, "qrels");
  assertSchemaVersion(qrelsDocument.schemaVersion, QRELS_SCHEMA_VERSION, "qrels");
  if (!Array.isArray(qrelsDocument.judgments) || qrelsDocument.judgments.length === 0) throw fail("qrels.judgments must contain at least one query judgment");
  const queryIds = new Set((queries?.queries || []).map((query) => query.id));
  const chunkIds = new Set((corpus?.chunks || []).map((chunk) => chunk.chunkId));
  const seenQueries = new Set();
  const judgments = qrelsDocument.judgments.map((raw, index) => {
    const value = requireRecord(raw, `qrels.judgments[${index}]`);
    const queryId = stableId(value.queryId, `qrels.judgments[${index}].queryId`);
    if (seenQueries.has(queryId)) throw fail(`qrels contains duplicate judgment for query '${queryId}'`);
    seenQueries.add(queryId);
    if (queryIds.size && !queryIds.has(queryId)) throw fail(`qrels references unknown query '${queryId}'`);
    if (!Array.isArray(value.relevant) || value.relevant.length === 0) throw fail(`qrels for query '${queryId}' must contain at least one relevant judgment`);
    const seenChunks = new Set();
    const relevant = value.relevant.map((rawJudgment, judgmentIndex) => {
      const judgment = requireRecord(rawJudgment, `qrels for query '${queryId}' relevant[${judgmentIndex}]`);
      const chunkId = stableId(judgment.chunkId, `qrels for query '${queryId}' relevant[${judgmentIndex}].chunkId`);
      if (seenChunks.has(chunkId)) throw fail(`qrels for query '${queryId}' contains duplicate chunk '${chunkId}'`);
      seenChunks.add(chunkId);
      if (chunkIds.size && !chunkIds.has(chunkId)) throw fail(`qrels for query '${queryId}' references unknown raw child chunk '${chunkId}'`);
      return { chunkId, grade: normalizeGrade(judgment.grade, `qrels for query '${queryId}' chunk '${chunkId}' grade`) };
    });
    if (!relevant.some((judgment) => judgment.grade > 0)) throw fail(`qrels for query '${queryId}' must contain at least one grade greater than zero`);
    return { queryId, relevant };
  });
  if (queryIds.size && seenQueries.size !== queryIds.size) {
    const missing = [...queryIds].filter((queryId) => !seenQueries.has(queryId));
    throw fail(`qrels is missing judgments for query '${missing[0]}'`);
  }
  return { schemaVersion: QRELS_SCHEMA_VERSION, judgments };
};

export const embeddingInputForChunk = (chunk) => embeddingInputText({
  ownerType: "raw_chunk",
  content: chunk.content,
  contextHeader: chunk.contextHeader
});

export const embeddingInputHashForChunk = (chunk) => embeddingInputSha256(embeddingInputForChunk(chunk));

export const corpusSha256 = (corpus) => sha256(stableStringify({
  schemaVersion: corpus.schemaVersion,
  knowledgeBaseId: corpus.knowledgeBaseId,
  chunks: [...corpus.chunks].sort((left, right) => left.chunkId.localeCompare(right.chunkId)).map((chunk) => ({
    chunkId: chunk.chunkId,
    resourceId: chunk.resourceId,
    resourceVersionId: chunk.resourceVersionId,
    processingRunId: chunk.processingRunId,
    resourceName: chunk.resourceName,
    title: chunk.title,
    content: chunk.content,
    contextHeader: chunk.contextHeader,
    parentChunkId: chunk.parentChunkId,
    parentContent: chunk.parentContent,
    locator: chunk.locator
  }))
}));

export const inputHashesForCorpus = (corpus) => Object.fromEntries(
  [...corpus.chunks].sort((left, right) => left.chunkId.localeCompare(right.chunkId)).map((chunk) => [chunk.chunkId, embeddingInputHashForChunk(chunk)])
);

const normalizedEndpoint = (value, label = "embedding endpoint") => {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw fail(`${label} must be a valid HTTP or HTTPS URL`, "EVAL_EMBEDDING_CONFIG_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol)) throw fail(`${label} must use HTTP or HTTPS`, "EVAL_EMBEDDING_CONFIG_INVALID");
  if (url.username || url.password || url.search || url.hash) throw fail(`${label} must not contain credentials, query parameters, or fragments`, "EVAL_EMBEDDING_CONFIG_INVALID");
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (!pathname.endsWith("/embeddings")) url.pathname = `${pathname}/embeddings`;
  return url.toString().replace(/\/$/u, "");
};

export const assertRealEmbeddingConfig = (config = {}, env = {}) => {
  const provider = String(config.embeddingProvider || "").trim().toLowerCase();
  if (!REAL_EMBEDDING_PROVIDERS.has(provider)) throw fail("raw hybrid evaluation requires a real EMBEDDING_PROVIDER (openai-compatible or openai); mock embeddings are not allowed", "EVAL_REAL_EMBEDDING_REQUIRED");
  const model = String(config.embeddingModel || "").trim();
  const explicitEnvModel = typeof env.EMBEDDING_MODEL === "string" && env.EMBEDDING_MODEL.trim().length > 0;
  if (!model || MOCK_EMBEDDING_MODELS.has(model.toLowerCase()) || (config.embeddingModelExplicit === false) || (!explicitEnvModel && config.embeddingModel === undefined)) {
    throw fail("raw hybrid evaluation requires an explicit non-mock EMBEDDING_MODEL", "EVAL_EMBEDDING_MODEL_REQUIRED");
  }
  const dimensions = Number(config.embeddingDimensions);
  if (dimensions !== EXPECTED_EVAL_EMBEDDING_DIMENSIONS) throw fail(`raw hybrid evaluation requires EMBEDDING_DIMENSIONS=${EXPECTED_EVAL_EMBEDDING_DIMENSIONS}`, "EVAL_EMBEDDING_DIMENSIONS_INVALID");
  if (config.retrievalVectorEnabled === false) throw fail("raw hybrid evaluation requires RETRIEVAL_VECTOR_ENABLED=true", "EVAL_VECTOR_REQUIRED");
  const endpoint = normalizedEndpoint(config.embeddingApiBaseUrl, "EMBEDDING_API_BASE_URL");
  try { assertEgressAllowed(config, endpoint, "EMBEDDING_EGRESS_BLOCKED", "embedding"); }
  catch (caught) { throw Object.assign(caught, { code: caught.code || "EMBEDDING_EGRESS_BLOCKED" }); }
  return { provider, model, dimensions, endpoint };
};

const assertManifestString = (value, label) => requireString(value, label, { max: 500 });

export const validateEmbeddingSnapshot = (input, corpus, expected = {}) => {
  const snapshot = requireRecord(input, "embedding snapshot");
  assertSchemaVersion(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION, "embedding snapshot");
  const manifest = requireRecord(snapshot.manifest, "embedding snapshot.manifest");
  const provider = assertManifestString(manifest.provider, "embedding snapshot.manifest.provider").toLowerCase();
  if (!REAL_EMBEDDING_PROVIDERS.has(provider)) throw fail("embedding snapshot must use a real embedding provider", "EVAL_REAL_EMBEDDING_REQUIRED");
  const model = assertManifestString(manifest.model, "embedding snapshot.manifest.model");
  if (MOCK_EMBEDDING_MODELS.has(model.toLowerCase())) throw fail("embedding snapshot must use a non-mock embedding model", "EVAL_REAL_EMBEDDING_REQUIRED");
  const dimensions = Number(manifest.dimensions);
  if (dimensions !== EXPECTED_EVAL_EMBEDDING_DIMENSIONS) throw fail(`embedding snapshot.manifest.dimensions must be ${EXPECTED_EVAL_EMBEDDING_DIMENSIONS}`, "EVAL_EMBEDDING_MANIFEST_INVALID");
  const expectedCorpusHash = corpusSha256(corpus);
  if (manifest.corpusSha256 !== expectedCorpusHash) throw fail("embedding snapshot corpus hash does not match corpus.json", "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  const expectedInputHashes = inputHashesForCorpus(corpus);
  if (!isRecord(manifest.inputHashes)) throw fail("embedding snapshot.manifest.inputHashes must be an object", "EVAL_EMBEDDING_MANIFEST_INVALID");
  const manifestInputIds = Object.keys(manifest.inputHashes).sort();
  const corpusInputIds = Object.keys(expectedInputHashes).sort();
  if (stableStringify(manifestInputIds) !== stableStringify(corpusInputIds)) throw fail("embedding snapshot input hashes do not cover exactly the corpus raw child chunks", "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  for (const chunkId of corpusInputIds) {
    if (!SHA256_RE.test(String(manifest.inputHashes[chunkId] || "")) || manifest.inputHashes[chunkId] !== expectedInputHashes[chunkId]) throw fail(`embedding snapshot input hash is stale for raw child chunk '${chunkId}'`, "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  }
  if (expected.provider && provider !== String(expected.provider).toLowerCase()) throw fail("embedding snapshot provider does not match the active embedding provider", "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  if (expected.model && model !== String(expected.model)) throw fail("embedding snapshot model does not match the active embedding model", "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  if (expected.dimensions && dimensions !== Number(expected.dimensions)) throw fail("embedding snapshot dimensions do not match the active embedding dimensions", "EVAL_EMBEDDING_MANIFEST_MISMATCH");
  if (expected.endpoint && (!manifest.endpoint || normalizedEndpoint(manifest.endpoint, "embedding snapshot.manifest.endpoint") !== normalizedEndpoint(expected.endpoint, "EMBEDDING_API_BASE_URL"))) throw fail("embedding snapshot endpoint does not match the active embedding endpoint", "EVAL_EMBEDDING_MANIFEST_MISMATCH");

  if (!Array.isArray(snapshot.vectors) || snapshot.vectors.length !== corpus.chunks.length) throw fail("embedding snapshot.vectors must contain one vector for every corpus raw child chunk", "EVAL_EMBEDDING_SNAPSHOT_INVALID");
  const vectorIds = [];
  const vectors = snapshot.vectors.map((raw, index) => {
    const value = requireRecord(raw, `embedding snapshot.vectors[${index}]`);
    const chunkId = stableId(value.chunkId, `embedding snapshot.vectors[${index}].chunkId`);
    vectorIds.push(chunkId);
    if (!Object.hasOwn(expectedInputHashes, chunkId)) throw fail(`embedding snapshot contains a vector for unknown raw child chunk '${chunkId}'`, "EVAL_EMBEDDING_SNAPSHOT_INVALID");
    if (value.inputSha256 !== expectedInputHashes[chunkId]) throw fail(`embedding snapshot vector input hash is stale for raw child chunk '${chunkId}'`, "EVAL_EMBEDDING_MANIFEST_MISMATCH");
    try { validateEmbeddingVector(value.vector, dimensions); }
    catch (caught) { throw Object.assign(caught, { code: caught.code || "EVAL_EMBEDDING_VECTOR_INVALID" }); }
    return { chunkId, inputSha256: value.inputSha256, vector: [...value.vector] };
  });
  unique(vectorIds, "embedding snapshot.vectors.chunkId");
  if (stableStringify(vectorIds.sort()) !== stableStringify(corpusInputIds)) throw fail("embedding snapshot vectors do not cover exactly the corpus raw child chunks", "EVAL_EMBEDDING_SNAPSHOT_INVALID");
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifest: {
      provider,
      model,
      dimensions,
      corpusSha256: expectedCorpusHash,
      inputHashes: expectedInputHashes,
      generatedAt: manifest.generatedAt || null,
      endpoint: manifest.endpoint ? normalizedEndpoint(manifest.endpoint, "embedding snapshot.manifest.endpoint") : null
    },
    vectors
  };
};

export const validateEvaluationManifest = (input, { corpus, queries, qrels, paths } = {}) => {
  const manifest = requireRecord(input, "manifest");
  assertSchemaVersion(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION, "manifest");
  const source = requireRecord(manifest.source, "manifest.source");
  const sourceUrl = requireString(source.url, "manifest.source.url", { max: 500 });
  let sourceAddress;
  try { sourceAddress = new URL(sourceUrl); }
  catch { throw fail("manifest.source.url must be a valid URL"); }
  if (!["http:", "https:"].includes(sourceAddress.protocol)) throw fail("manifest.source.url must use HTTP or HTTPS");
  if (sourceAddress.username || sourceAddress.password || sourceAddress.search || sourceAddress.hash) throw fail("manifest.source.url must not contain credentials, query parameters, or fragments");
  if (!SHA256_RE.test(String(source.archiveSha256 || ""))) throw fail("manifest.source.archiveSha256 must be a SHA-256 hash");
  if (source.archiveSha256 !== SCIFACT_ARCHIVE_SHA256) throw fail("manifest.source.archiveSha256 is not the pinned SciFact archive", "EVAL_DATA_INVALID");
  if (source.archiveMd5 !== SCIFACT_ARCHIVE_MD5 || source.archiveBytes !== SCIFACT_ARCHIVE_BYTES) throw fail("manifest source does not match the pinned SciFact archive", "EVAL_DATA_INVALID");
  if (typeof source.archiveBytes !== "number" || !Number.isSafeInteger(source.archiveBytes) || source.archiveBytes <= 0) throw fail("manifest.source.archiveBytes must be a positive integer");
  const sourceFiles = requireRecord(source.files, "manifest.source.files");
  for (const name of ["corpus", "queries", "testQrels"]) {
    const file = requireRecord(sourceFiles[name], `manifest.source.files.${name}`);
    requireString(file.path, `manifest.source.files.${name}.path`, { max: 200 });
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw fail(`manifest.source.files.${name}.bytes must be a positive integer`);
    if (!SHA256_RE.test(String(file.sha256 || "")) || !/^[0-9a-f]{32}$/u.test(String(file.md5 || ""))) throw fail(`manifest.source.files.${name} hashes are invalid`);
  }
  const conversion = requireRecord(manifest.conversion, "manifest.conversion");
  requireString(conversion.version, "manifest.conversion.version", { max: 100 });
  if (conversion.split !== "test") throw fail("manifest.conversion.split must be 'test'");
  const counts = requireRecord(manifest.counts, "manifest.counts");
  const actual = requireRecord(counts.actual, "manifest.counts.actual");
  if (corpus && actual.corpus !== corpus.chunks.length) throw fail("manifest corpus count does not match corpus.json");
  if (queries && actual.queries !== queries.queries.length) throw fail("manifest query count does not match queries.json");
  if (qrels) {
    const qrelCount = qrels.judgments.reduce((sum, judgment) => sum + judgment.relevant.length, 0);
    if (actual.qrels !== qrelCount || actual.qrelQueries !== qrels.judgments.length) throw fail("manifest qrel count does not match qrels.json");
  }
  const outputs = requireRecord(manifest.outputs, "manifest.outputs");
  const outputFiles = requireRecord(outputs.files, "manifest.outputs.files");
  for (const name of ["corpus.json", "queries.json", "qrels.json"]) if (!SHA256_RE.test(String(outputFiles[name] || ""))) throw fail(`manifest.outputs.files.${name} must be a SHA-256 hash`);
  if (paths) {
    for (const name of ["corpus", "queries", "qrels"]) {
      let bytes;
      try { bytes = fs.readFileSync(paths[name]); }
      catch (caught) { throw fail(`manifest output ${name} could not be read: ${caught.message}`, "EVAL_DATA_MISSING", caught); }
      if (sha256Bytes(bytes) !== outputFiles[`${name}.json`]) throw fail(`manifest output hash is stale for ${name}.json`, "EVAL_DATA_INVALID");
    }
  }
  return manifest;
};

const readJson = (filePath, label) => {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); }
  catch (caught) { throw Object.assign(new Error(`${label} could not be read: ${caught.message}`), { code: "EVAL_DATA_MISSING", cause: caught }); }
  try { return JSON.parse(text); }
  catch (caught) { throw Object.assign(new Error(`${label} contains invalid JSON`), { code: "EVAL_DATA_INVALID", cause: caught }); }
};

export const evaluationDataPaths = (dataDir) => {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    corpus: path.join(root, "corpus.json"),
    queries: path.join(root, "queries.json"),
    qrels: path.join(root, "qrels.json"),
    manifest: path.join(root, "manifest.json"),
    snapshot: path.join(root, "embedding-snapshot.json")
  };
};

export const loadEvaluationData = ({ dataDir, requireSnapshot = false, expectedEmbedding = null } = {}) => {
  const paths = evaluationDataPaths(dataDir);
  const corpus = validateCorpus(readJson(paths.corpus, "corpus.json"));
  const queries = validateQueries(readJson(paths.queries, "queries.json"));
  const qrels = validateQrels(readJson(paths.qrels, "qrels.json"), { corpus, queries });
  const manifest = fs.existsSync(paths.manifest)
    ? validateEvaluationManifest(readJson(paths.manifest, "manifest.json"), { corpus, queries, qrels, paths })
    : null;
  let snapshot = null;
  let snapshotSha256 = null;
  if (requireSnapshot) {
    if (!fs.existsSync(paths.snapshot)) throw fail("embedding-snapshot.json is missing; run the explicit embedding preparation command first", "EVAL_SNAPSHOT_MISSING");
    snapshot = validateEmbeddingSnapshot(readJson(paths.snapshot, "embedding-snapshot.json"), corpus, expectedEmbedding || {});
    snapshotSha256 = fileSha256(paths.snapshot);
  }
  return { ...paths, corpus, queries, qrels, manifest, snapshot, snapshotSha256, qrelsByQueryId: new Map(qrels.judgments.map((judgment) => [judgment.queryId, judgment])) };
};
