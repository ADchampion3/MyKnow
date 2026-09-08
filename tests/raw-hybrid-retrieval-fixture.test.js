import "deepeval/vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORPUS_SCHEMA_VERSION,
  QRELS_SCHEMA_VERSION,
  QUERIES_SCHEMA_VERSION,
  evaluationDataPaths
} from "../evals/raw-hybrid-retrieval/src/contracts.js";
import { prepareRawHybridEmbeddingSnapshot } from "../evals/raw-hybrid-retrieval/src/embedding-snapshot.js";
import { buildRawHybridReport, collectRawHybridEvaluation } from "../evals/raw-hybrid-retrieval/src/evaluate.js";
import { createRawHybridMetrics } from "../evals/raw-hybrid-retrieval/src/metrics.js";
import { fixtureCounts } from "../evals/raw-hybrid-retrieval/src/fixture.js";

const tempDirectories = [];
const servers = [];

const writeJson = (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const makeCorpus = () => ({
  schemaVersion: CORPUS_SCHEMA_VERSION,
  knowledgeBaseId: "00000000-0000-4000-8000-000000000002",
  chunks: [
    {
      chunkId: "chunk-alpha-primary",
      resourceId: "resource-alpha",
      resourceVersionId: "version-alpha",
      processingRunId: "run-alpha",
      resourceName: "Alpha source",
      title: "Alpha source",
      contextHeader: "Alpha section",
      content: "Alpha retrieval evidence is the primary result.",
      parentChunkId: "parent-alpha",
      parentContent: "Alpha source parent context.",
      locator: { page: 1, block: "a" }
    },
    {
      chunkId: "chunk-alpha-secondary",
      resourceId: "resource-alpha",
      resourceVersionId: "version-alpha",
      processingRunId: "run-alpha",
      resourceName: "Alpha source",
      title: "Alpha source",
      contextHeader: "Alpha details",
      content: "Additional alpha retrieval evidence.",
      parentChunkId: "parent-alpha",
      parentContent: "Alpha source parent context.",
      locator: { page: 1, block: "b" }
    },
    {
      chunkId: "chunk-beta",
      resourceId: "resource-beta",
      resourceVersionId: "version-beta",
      processingRunId: "run-beta",
      resourceName: "Beta source",
      title: "Beta source",
      contextHeader: "Beta section",
      content: "Beta retrieval evidence is a distractor.",
      locator: { page: 2, block: "a" }
    }
  ]
});

const makeQueries = () => ({
  schemaVersion: QUERIES_SCHEMA_VERSION,
  queries: [{ id: "query-alpha", query: "alpha retrieval", tags: ["smoke", "raw"] }]
});

const makeQrels = () => ({
  schemaVersion: QRELS_SCHEMA_VERSION,
  judgments: [{
    queryId: "query-alpha",
    relevant: [
      { chunkId: "chunk-alpha-primary", grade: 2 },
      { chunkId: "chunk-alpha-secondary", grade: 1 }
    ]
  }]
});

const createDataset = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-raw-hybrid-eval-"));
  tempDirectories.push(dataDir);
  writeJson(path.join(dataDir, "corpus.json"), makeCorpus());
  writeJson(path.join(dataDir, "queries.json"), makeQueries());
  writeJson(path.join(dataDir, "qrels.json"), makeQrels());
  return dataDir;
};

const createEmbeddingServer = async () => {
  const requests = [];
  let fail = false;
  const server = http.createServer(async (request, response) => {
    const body = await new Promise((resolve, reject) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (part) => { text += part; });
      request.on("end", () => resolve(text ? JSON.parse(text) : {}));
      request.on("error", reject);
    });
    requests.push({ method: request.method, url: request.url, body });
    if (fail) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "deliberate test outage" }));
      return;
    }
    const vector = Array.from({ length: 4096 }, () => 0);
    const text = String(body.input || "").toLowerCase();
    vector[text.includes("alpha") ? 0 : 1] = 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: vector, index: 0 }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return {
    server,
    requests,
    setFail: (value) => { fail = value; },
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  };
};

const configFor = (baseUrl) => ({
  aiEgressMode: "local_only",
  embeddingProvider: "openai-compatible",
  embeddingModel: "eval-http-model",
  embeddingDimensions: 4096,
  retrievalVectorEnabled: true,
  embeddingApiBaseUrl: baseUrl,
  embeddingApiKey: ""
});

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  while (tempDirectories.length) fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
});

describe("raw hybrid isolated fixture", () => {
  it("prepares real embeddings, exercises executeRetrieval, and keeps derived rows isolated", async () => {
    const dataDir = createDataset();
    const embeddingServer = await createEmbeddingServer();
    const config = configFor(embeddingServer.baseUrl);
    const prepared = await prepareRawHybridEmbeddingSnapshot({ dataDir, config, env: {} });
    expect(prepared.snapshot.vectors).toHaveLength(3);
    expect(embeddingServer.requests).toHaveLength(3);
    expect(embeddingServer.requests.every(({ url, body }) => url === "/v1/embeddings" && body.model === "eval-http-model" && body.dimensions === 4096)).toBe(true);
    const evaluationFiles = fs.readdirSync(dataDir).sort();
    const snapshotBeforeEvaluation = fs.readFileSync(evaluationDataPaths(dataDir).snapshot, "utf8");

    const progressEvents = [];
    const evaluation = await collectRawHybridEvaluation({
      dataDir,
      config,
      env: {},
      onProgress: (event) => progressEvents.push(event)
    });
    try {
      expect(progressEvents.map(({ type }) => type)).toEqual([
        "evaluation_started",
        "provider_validated",
        "data_loaded",
        "fixture_ready",
        "query_started",
        "query_completed",
        "retrieval_completed"
      ]);
      expect(progressEvents[4]).toMatchObject({ type: "query_started", queryId: "query-alpha", index: 1, total: 1 });
      expect(progressEvents[5]).toMatchObject({ type: "query_completed", queryId: "query-alpha", index: 1, total: 1, resultCount: expect.any(Number), durationMs: expect.any(Number) });
      expect(evaluation.data.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixtureCounts(evaluation.fixture.sqlite)).toEqual({
        knowledgeBases: 1,
        resources: 2,
        resourceVersions: 2,
        processingRuns: 2,
        chunks: 4,
        rawFts: 3,
        embeddings: 3
      });

      const [{ trace, testCase }] = evaluation.cases;
      expect(trace.status).toBe("succeeded");
      expect(trace.vector).toMatchObject({ provider: "openai-compatible", model: "eval-http-model", dimensions: 4096, status: "used", keywordFallback: false });
      expect(trace.raw.results.length).toBeGreaterThan(0);
      expect(trace.raw.results.map((result) => result.id)).toEqual(expect.arrayContaining(["chunk-alpha-primary", "chunk-alpha-secondary"]));
      expect(trace.raw.results.every((result) => ["chunk-alpha-primary", "chunk-alpha-secondary", "chunk-beta"].includes(result.id))).toBe(true);
      expect(trace.raw.results[0]).toEqual(expect.objectContaining({ id: expect.any(String), chunkId: expect.any(String), rank: 1, keywordRank: expect.any(Number), vectorRank: expect.any(Number), rrfScore: expect.any(Number) }));
      expect(evaluation.fixture.sqlite.prepare("SELECT count(*) AS count FROM retrieval_runs").get().count).toBe(1);
      expect(embeddingServer.requests).toHaveLength(4);

      const metrics = createRawHybridMetrics({ threshold: 0 });
      await expect(testCase).toPass(metrics);
      const report = buildRawHybridReport({
        evaluation,
        metricResults: [Object.fromEntries(metrics.map((metric) => [metric.name, metric]))]
      });
      expect(report.queryCount).toBe(1);
      expect(report.qrels).toMatchObject({ queryCount: 1, judgmentCount: 2 });
      expect(report.metricKValues).toEqual([1, 3, 5, 10]);
      expect(Object.keys(report.macroAverage)).toHaveLength(20);
      expect(report.queries[0].retrieved[0]).toEqual(expect.objectContaining({ id: expect.any(String), keywordRank: expect.any(Number), vectorRank: expect.any(Number), rrfScore: expect.any(Number) }));
      expect(report.queries[0].metrics["Recall@1"].details).toMatchObject({ relevantCount: 2, hitCount: expect.any(Number) });
      expect(Object.values(report.macroAverage).every((score) => score >= 0 && score <= 1)).toBe(true);
      expect(fs.readdirSync(dataDir).sort()).toEqual(evaluationFiles);
      expect(fs.readFileSync(evaluationDataPaths(dataDir).snapshot, "utf8")).toBe(snapshotBeforeEvaluation);
    } finally {
      evaluation.close();
    }
  });

  it("does not replace an existing snapshot after provider failure", async () => {
    const dataDir = createDataset();
    const embeddingServer = await createEmbeddingServer();
    const config = configFor(embeddingServer.baseUrl);
    await prepareRawHybridEmbeddingSnapshot({ dataDir, config, env: {} });
    const snapshotPath = evaluationDataPaths(dataDir).snapshot;
    const before = fs.readFileSync(snapshotPath, "utf8");
    embeddingServer.setFail(true);

    await expect(prepareRawHybridEmbeddingSnapshot({ dataDir, config, env: {} })).rejects.toThrow(/HTTP 503/u);
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(before);
  });
});
