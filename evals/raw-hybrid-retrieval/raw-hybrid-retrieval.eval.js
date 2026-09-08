import "deepeval/vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadConfig } from "@myknow/config";
import { createRawHybridMetrics } from "./src/metrics.js";
import { buildRawHybridReport, collectRawHybridEvaluation, formatRawHybridReport, persistRawHybridReport } from "./src/evaluate.js";

process.env.DEEPEVAL_TELEMETRY_OPT_OUT = "1";

const progressLog = (startedAt, message) => {
  const elapsed = String(Date.now() - startedAt).padStart(6, " ");
  console.error(`[raw-hybrid-eval +${elapsed}ms] ${message}`);
};

const createProgressLogger = (startedAt) => (event) => {
  if (event.type === "evaluation_started") {
    progressLog(startedAt, `initializing (rawTopK=${event.rawTopK}, queryTimeout=${event.timeoutMs}ms)`);
  } else if (event.type === "provider_validated") {
    progressLog(startedAt, `embedding config validated: ${event.provider}/${event.model} (${event.dimensions} dimensions)`);
  } else if (event.type === "data_loaded") {
    progressLog(startedAt, `loaded ${event.queryCount} queries, ${event.corpusChunkCount} raw chunks, and ${event.snapshotVectorCount} snapshot vectors`);
  } else if (event.type === "fixture_ready") {
    progressLog(startedAt, `isolated SQLite fixture ready (${event.corpusChunkCount} raw chunks)`);
  } else if (event.type === "query_started") {
    progressLog(startedAt, `[${event.index}/${event.total}] retrieving ${event.queryId}`);
  } else if (event.type === "query_completed") {
    progressLog(startedAt, `[${event.index}/${event.total}] retrieved ${event.queryId}: ${event.resultCount} results in ${event.durationMs}ms`);
  } else if (event.type === "query_failed") {
    progressLog(startedAt, `[${event.index}/${event.total}] failed ${event.queryId}: ${event.code} after ${event.durationMs}ms`);
  } else if (event.type === "retrieval_completed") {
    progressLog(startedAt, `retrieval complete: ${event.queryCount} queries in ${event.durationMs}ms`);
  }
};

it("evaluates the raw hybrid retrieval channel with the real embedding provider", async () => {
  const dataDir = process.env.RAW_HYBRID_EVAL_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
  const reportPath = process.env.RAW_HYBRID_EVAL_REPORT_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "reports/scifact-raw-hybrid-report.json");
  const startedAt = Date.now();
  progressLog(startedAt, `starting (data=${path.resolve(dataDir)}, report=${path.resolve(reportPath)})`);
  let evaluation;
  try {
    const config = loadConfig();
    evaluation = await collectRawHybridEvaluation({ dataDir, config, env: process.env, onProgress: createProgressLogger(startedAt) });
    const metricResults = [];
    const scoringStartedAt = Date.now();
    progressLog(startedAt, `scoring ${evaluation.cases.length} queries with deterministic IR metrics`);
    for (const [index, item] of evaluation.cases.entries()) {
      progressLog(startedAt, `[${index + 1}/${evaluation.cases.length}] scoring ${item.query.id}`);
      const metrics = createRawHybridMetrics({ threshold: 0 });
      await expect(item.testCase).toPass(metrics);
      metricResults.push(Object.fromEntries(metrics.map((metric) => [metric.name, metric])));
      progressLog(startedAt, `[${index + 1}/${evaluation.cases.length}] scored ${item.query.id}`);
    }
    progressLog(startedAt, `scoring complete in ${Date.now() - scoringStartedAt}ms`);
    const report = buildRawHybridReport({ evaluation, metricResults });
    progressLog(startedAt, "writing report atomically");
    const persistedReportPath = persistRawHybridReport(reportPath, report);
    progressLog(startedAt, `report saved to ${persistedReportPath}`);
    console.log(`\nRaw hybrid retrieval evaluation report\n${formatRawHybridReport(report)}`);
    for (const metric of Object.values(report.macroAverage)) expect(metric).toBeGreaterThanOrEqual(0);
    for (const metric of Object.values(report.macroAverage)) expect(metric).toBeLessThanOrEqual(1);
    progressLog(startedAt, `completed successfully in ${Date.now() - startedAt}ms`);
  } catch (caught) {
    progressLog(startedAt, `failed [${caught.code || "EVAL_RUN_FAILED"}]: ${caught.message}`);
    throw caught;
  } finally {
    evaluation?.close();
  }
});
