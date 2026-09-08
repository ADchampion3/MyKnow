import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LLMTestCase } from "deepeval/test-case";
import { executeRetrieval } from "@myknow/db";
import {
  REPORT_SCHEMA_VERSION,
  assertRealEmbeddingConfig,
  corpusSha256,
  loadEvaluationData,
  stableStringify
} from "./contracts.js";
import { createRawHybridEvalFixture } from "./fixture.js";
import {
  EVALUATION_K_VALUES,
  createRawHybridMetrics,
  metricFacts,
  publicRawRanking,
  serializeRawRanking
} from "./metrics.js";

const fail = (message, code = "EVAL_RUN_FAILED") => Object.assign(new Error(message), { code });
const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value), "utf8").digest("hex");
const resolveProgressCallback = (onProgress) => {
  if (onProgress === undefined) return () => {};
  if (typeof onProgress !== "function") throw fail("onProgress must be a function", "EVAL_PROGRESS_INVALID");
  return onProgress;
};
const codeIdentity = () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const files = [
    "evals/raw-hybrid-retrieval/src/contracts.js",
    "evals/raw-hybrid-retrieval/src/evaluate.js",
    "evals/raw-hybrid-retrieval/src/fixture.js",
    "evals/raw-hybrid-retrieval/src/metrics.js",
    "evals/raw-hybrid-retrieval/src/embedding-snapshot.js",
    "scripts/import-scifact.js",
    "scripts/prepare-raw-hybrid-eval-embeddings.js",
    "packages/db/src/retrieval.js",
    "packages/db/src/embeddings.js",
    "packages/db/src/database/migrations.js"
  ];
  let commit = null;
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() || null; } catch {}
  return { commit, files, workingTreeSha256: digest(Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), "utf8")]))) };
};

export const collectRawHybridEvaluation = async ({ dataDir, config, env = process.env, rawTopK = 10, contextBudgetTokens = 8000, timeoutMs = Number(env.RAW_HYBRID_EVAL_TIMEOUT_MS || 1_800_000), onProgress } = {}) => {
  const progress = resolveProgressCallback(onProgress);
  const startedAt = Date.now();
  progress({ type: "evaluation_started", dataDir, rawTopK, contextBudgetTokens, timeoutMs });
  const providerConfig = assertRealEmbeddingConfig(config, env);
  progress({
    type: "provider_validated",
    provider: providerConfig.provider,
    model: providerConfig.model,
    dimensions: providerConfig.dimensions
  });
  const data = loadEvaluationData({ dataDir, requireSnapshot: true, expectedEmbedding: providerConfig });
  const totalQueries = data.queries.queries.length;
  progress({
    type: "data_loaded",
    queryCount: totalQueries,
    corpusChunkCount: data.corpus.chunks.length,
    snapshotVectorCount: data.snapshot.vectors.length
  });
  if (rawTopK < 10 || rawTopK > 20 || !Number.isInteger(rawTopK)) throw fail("raw hybrid evaluation rawTopK must be an integer between 10 and 20", "EVAL_RUN_CONFIG_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw fail("raw hybrid evaluation timeoutMs must be a positive integer", "EVAL_RUN_CONFIG_INVALID");
  const fixture = createRawHybridEvalFixture({ data, config });
  progress({ type: "fixture_ready", queryCount: totalQueries, corpusChunkCount: data.corpus.chunks.length });
  const cases = [];
  try {
    for (const [index, query] of data.queries.queries.entries()) {
      const position = index + 1;
      const queryStartedAt = Date.now();
      progress({ type: "query_started", queryId: query.id, index: position, total: totalQueries });
      try {
        const qrels = data.qrelsByQueryId.get(query.id);
        if (!qrels) throw fail(`qrels for query '${query.id}' are missing`, "EVAL_DATA_INVALID");
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        let trace;
        try {
          trace = await executeRetrieval({
            sqlite: fixture.sqlite,
            config: { ...config, ...providerConfig, retrievalVectorEnabled: true },
            input: {
              knowledgeBaseId: data.corpus.knowledgeBaseId,
              query: query.query,
              rawTopK,
              wikiTopK: 1,
              contextBudgetTokens
            },
            onAudit: () => {},
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (timedOut) throw fail(`retrieval timed out for query '${query.id}' after ${timeoutMs} ms`, "EVAL_RUN_TIMEOUT");
        if (trace.status !== "succeeded") throw fail(`retrieval failed for query '${query.id}': ${trace.error?.message || "unknown error"}`, "EVAL_RETRIEVAL_FAILED");
        if (trace.vector?.status !== "used" || trace.vector?.keywordFallback) {
          const vectorError = trace.vector?.error?.message ? `: ${trace.vector.error.message}` : "";
          throw fail(`real vector retrieval was not used for query '${query.id}'${vectorError}`, "EVAL_VECTOR_NOT_USED");
        }
        const ranking = publicRawRanking(trace.raw?.results || []);
        const testCase = new LLMTestCase({
          input: query.query,
          actualOutput: serializeRawRanking(ranking),
          additionalMetadata: {
            queryId: query.id,
            tags: query.tags,
            qrels: qrels.relevant
          },
          name: query.id
        });
        cases.push({ query, qrels, trace, ranking, testCase });
        progress({
          type: "query_completed",
          queryId: query.id,
          index: position,
          total: totalQueries,
          resultCount: ranking.length,
          vectorStatus: trace.vector.status,
          durationMs: Date.now() - queryStartedAt
        });
      } catch (caught) {
        progress({
          type: "query_failed",
          queryId: query.id,
          index: position,
          total: totalQueries,
          code: caught.code || "EVAL_RUN_FAILED",
          durationMs: Date.now() - queryStartedAt
        });
        throw caught;
      }
    }
  } catch (caught) {
    fixture.close();
    throw caught;
  }
  progress({ type: "retrieval_completed", queryCount: cases.length, durationMs: Date.now() - startedAt });
  return {
    data,
    providerConfig,
    startedAt,
    durationMs: Date.now() - startedAt,
    rawTopK,
    contextBudgetTokens,
    timeoutMs,
    fixture,
    cases,
    close: () => fixture.close()
  };
};

export const buildRawHybridReport = ({ evaluation, metricResults } = {}) => {
  if (!evaluation?.cases || !Array.isArray(metricResults) || metricResults.length !== evaluation.cases.length) throw fail("raw hybrid report requires one metric result set per query", "EVAL_REPORT_INVALID");
  const queries = evaluation.cases.map((item, index) => {
    const metrics = metricResults[index];
    const metricObject = Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, metricFacts(value)]));
    return {
      queryId: item.query.id,
      query: item.query.query,
      tags: item.query.tags,
      locator: item.query.locator || null,
      qrels: item.qrels.relevant,
      retrieved: item.ranking,
      vector: {
        provider: item.trace.vector.provider,
        model: item.trace.vector.model,
        dimensions: item.trace.vector.dimensions,
        status: item.trace.vector.status
      },
      metrics: metricObject
    };
  });
  const metricNames = queries.length ? Object.keys(queries[0].metrics) : [];
  const macroAverage = Object.fromEntries(metricNames.map((name) => {
    const scores = queries.map((query) => query.metrics[name].score);
    const score = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    return [name, Math.max(0, Math.min(1, score))];
  }));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    corpus: {
      schemaVersion: evaluation.data.corpus.schemaVersion,
      knowledgeBaseId: evaluation.data.corpus.knowledgeBaseId,
      chunkCount: evaluation.data.corpus.chunks.length,
      corpusSha256: evaluation.data.snapshot.manifest.corpusSha256
    },
    qrels: {
      schemaVersion: evaluation.data.qrels.schemaVersion,
      queryCount: evaluation.data.qrels.judgments.length,
      judgmentCount: evaluation.data.qrels.judgments.reduce((sum, judgment) => sum + judgment.relevant.length, 0)
    },
    embedding: {
      provider: evaluation.data.snapshot.manifest.provider,
      model: evaluation.data.snapshot.manifest.model,
      dimensions: evaluation.data.snapshot.manifest.dimensions,
      generatedAt: evaluation.data.snapshot.manifest.generatedAt,
      inputHashCount: Object.keys(evaluation.data.snapshot.manifest.inputHashes).length
    },
    provenance: {
      source: evaluation.data.manifest ? {
        dataset: evaluation.data.manifest.dataset,
        url: evaluation.data.manifest.source.url,
        archiveSha256: evaluation.data.manifest.source.archiveSha256,
        split: evaluation.data.manifest.conversion.split
      } : null,
      data: {
        corpusSha256: corpusSha256(evaluation.data.corpus),
        queriesSha256: digest(evaluation.data.queries),
        qrelsSha256: digest(evaluation.data.qrels),
        manifestSchemaVersion: evaluation.data.manifest?.schemaVersion || null,
        snapshotSha256: evaluation.data.snapshotSha256 || digest(evaluation.data.snapshot)
      },
      code: codeIdentity(),
      configuration: {
        embeddingProvider: evaluation.providerConfig.provider,
        embeddingModel: evaluation.providerConfig.model,
        embeddingDimensions: evaluation.providerConfig.dimensions,
        embeddingEndpoint: evaluation.providerConfig.endpoint,
        retrievalVectorEnabled: true,
        rawTopK: evaluation.rawTopK,
        contextBudgetTokens: evaluation.contextBudgetTokens,
        timeoutMs: evaluation.timeoutMs
      }
    },
    metricDefinition: {
      gain: "linear",
      relevantWhen: "grade > 0",
      judgedDefinition: "explicit qrel grade 0/1/2 counts as judged; missing qrel is unjudged",
      threshold: 0,
      kValues: [...EVALUATION_K_VALUES]
    },
    durationMs: evaluation.durationMs,
    metricKValues: [...EVALUATION_K_VALUES],
    queryCount: queries.length,
    queries,
    macroAverage
  };
};

export const runRawHybridEvaluation = async (options = {}) => {
  const evaluation = await collectRawHybridEvaluation(options);
  try {
    const metricResults = [];
    for (const item of evaluation.cases) {
      const metrics = createRawHybridMetrics({ threshold: 0 });
      for (const metric of metrics) await metric.measure(item.testCase);
      metricResults.push(Object.fromEntries(metrics.map((metric) => [metric.name, metric])));
    }
    const report = buildRawHybridReport({ evaluation, metricResults });
    if (options.reportPath) persistRawHybridReport(options.reportPath, report);
    return report;
  } finally {
    evaluation.close();
  }
};

export const formatRawHybridReport = (report) => JSON.stringify(report, null, 2);

export const persistRawHybridReport = (reportPath, report) => {
  if (!reportPath || typeof reportPath !== "string") throw fail("reportPath is required", "EVAL_REPORT_PATH_INVALID");
  const target = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backup = `${target}.${process.pid}.${crypto.randomUUID()}.bak`;
  let movedExisting = false;
  try {
    fs.writeFileSync(temporary, `${formatRawHybridReport(report)}\n`, { encoding: "utf8", flag: "wx" });
    if (fs.existsSync(target)) { fs.renameSync(target, backup); movedExisting = true; }
    fs.renameSync(temporary, target);
    if (movedExisting) fs.rmSync(backup, { force: true });
  } catch (caught) {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {}
    if (movedExisting && !fs.existsSync(target) && fs.existsSync(backup)) { try { fs.renameSync(backup, target); } catch {} }
    throw fail(`could not persist raw hybrid report: ${caught.message}`, "EVAL_REPORT_WRITE_FAILED", caught);
  }
  return target;
};
