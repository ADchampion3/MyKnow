import report from "../../../../../evals/raw-hybrid-retrieval/reports/scifact-raw-hybrid-report.json";
import EvalDashboard from "./dashboard-client";

const METRIC_NAMES = ["Recall", "Hit Rate", "MRR", "NDCG", "Judged"];

// ponytail: static local report ceiling; upgrade to a report API and virtualized table when report count or size grows.

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const textOr = (value, fallback = "") => typeof value === "string" ? value : fallback;

const numberOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeQrels = (qrels) => (Array.isArray(qrels) ? qrels : []).map((qrel) => ({
  chunkId: textOr(qrel?.chunkId, "unknown-chunk"),
  grade: numberOrNull(qrel?.grade)
}));

const normalizeRetrieved = (retrieved, qrels) => {
  const gradeByChunkId = new Map(qrels.map((qrel) => [qrel.chunkId, qrel.grade]));
  return (Array.isArray(retrieved) ? retrieved : []).map((item, index) => {
    const chunkId = textOr(item?.chunkId || item?.id, `unknown-chunk-${index + 1}`);
    return {
      chunkId,
      rank: numberOrNull(item?.rank),
      keywordRank: numberOrNull(item?.keywordRank),
      vectorRank: numberOrNull(item?.vectorRank),
      rrfScore: numberOrNull(item?.rrfScore),
      bm25Score: numberOrNull(item?.bm25Score),
      keywordScore: numberOrNull(item?.keywordScore),
      vectorScore: numberOrNull(item?.vectorScore),
      normalizedScore: numberOrNull(item?.normalizedScore),
      qrelGrade: gradeByChunkId.has(chunkId) ? gradeByChunkId.get(chunkId) : null
    };
  });
};

const normalizeMetrics = (metrics) => Object.fromEntries(
  Object.entries(isRecord(metrics) ? metrics : {}).map(([key, value]) => [key, {
    score: numberOrNull(value?.score),
    reason: textOr(value?.reason)
  }])
);

const normalizeReport = (input) => {
  if (!isRecord(input) || !Array.isArray(input.queries) || !isRecord(input.macroAverage)) {
    throw new Error("报告格式不符合 raw-hybrid-eval-report-v1");
  }

  const queries = input.queries.map((query, index) => {
    const qrels = normalizeQrels(query?.qrels);
    return {
      queryId: textOr(query?.queryId, `query-${index + 1}`),
      query: textOr(query?.query),
      tags: Array.isArray(query?.tags) ? query.tags.filter((tag) => typeof tag === "string") : [],
      qrels,
      retrieved: normalizeRetrieved(query?.retrieved, qrels),
      vectorStatus: textOr(query?.vector?.status, "unknown"),
      metrics: normalizeMetrics(query?.metrics)
    };
  });

  const metricKValues = Array.isArray(input.metricKValues)
    ? input.metricKValues.filter((value) => Number.isInteger(value) && value > 0)
    : [];

  const macroAverage = Object.fromEntries(
    Object.entries(input.macroAverage).map(([key, value]) => [key, numberOrNull(value)])
  );

  return {
    schemaVersion: textOr(input.schemaVersion),
    generatedAt: textOr(input.generatedAt),
    durationMs: numberOrNull(input.durationMs),
    queryCount: numberOrNull(input.queryCount) ?? queries.length,
    metricKValues,
    macroAverage,
    metricNames: METRIC_NAMES,
    corpus: {
      chunkCount: numberOrNull(input.corpus?.chunkCount),
      knowledgeBaseId: textOr(input.corpus?.knowledgeBaseId),
      corpusSha256: textOr(input.corpus?.corpusSha256)
    },
    qrels: {
      queryCount: numberOrNull(input.qrels?.queryCount),
      judgmentCount: numberOrNull(input.qrels?.judgmentCount)
    },
    embedding: {
      provider: textOr(input.embedding?.provider),
      model: textOr(input.embedding?.model),
      dimensions: numberOrNull(input.embedding?.dimensions)
    },
    provenance: {
      dataset: textOr(input.provenance?.source?.dataset),
      split: textOr(input.provenance?.source?.split),
      commit: textOr(input.provenance?.code?.commit),
      rawTopK: numberOrNull(input.provenance?.configuration?.rawTopK),
      contextBudgetTokens: numberOrNull(input.provenance?.configuration?.contextBudgetTokens)
    },
    metricDefinition: {
      gain: textOr(input.metricDefinition?.gain),
      relevantWhen: textOr(input.metricDefinition?.relevantWhen),
      judgedDefinition: textOr(input.metricDefinition?.judgedDefinition),
      threshold: numberOrNull(input.metricDefinition?.threshold)
    },
    queries
  };
};

export default function RawHybridEvalPage() {
  try {
    return <EvalDashboard report={normalizeReport(report)} />;
  } catch (error) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1>无法加载评估报告</h1>
        <p>{error instanceof Error ? error.message : "报告格式无效"}</p>
      </main>
    );
  }
}
