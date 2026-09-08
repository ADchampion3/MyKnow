import { BaseMetric, checkSingleTurnParams } from "deepeval/metrics";
import { SingleTurnParams } from "deepeval/test-case";
import { RANKING_SCHEMA_VERSION } from "./contracts.js";
import { installDeepEvalTelemetryCompatibility } from "./deepeval-compat.js";

installDeepEvalTelemetryCompatibility();

export const EVALUATION_K_VALUES = Object.freeze([1, 3, 5, 10]);
const METRIC_KINDS = new Set(["recall", "hit_rate", "mrr", "ndcg", "judged"]);
const fail = (message, code = "EVAL_RANKING_INVALID") => Object.assign(new Error(message), { code });
const resolveThreshold = (threshold, fallback) => threshold === null ? null : (threshold === undefined ? fallback : threshold);

const validateK = (value) => {
  const k = Number(value);
  if (!Number.isInteger(k) || k < 1 || k > 1000) throw fail("metric K must be an integer between 1 and 1000", "EVAL_METRIC_K_INVALID");
  return k;
};

const clampScore = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const normalizedId = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw fail(`${label} must be a non-empty string`);
  return value.trim();
};

const normalizeRank = (value, index, label) => {
  if (value === undefined || value === null) return index + 1;
  if (!Number.isInteger(value) || value < 1 || value !== index + 1) throw fail(`${label} must be the contiguous public rank ${index + 1}`);
  return value;
};

const optionalPositiveRank = (value, label) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) throw fail(`${label} must be null or a positive integer`);
  return value;
};

const optionalFinite = (value, label) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail(`${label} must be null or finite`);
  return value;
};

export const validateRanking = (input) => {
  if (!Array.isArray(input)) throw fail("retrieval ranking must be an array");
  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail(`retrieval ranking result ${index} must be an object`);
    const id = normalizedId(raw.id ?? raw.chunkId, `retrieval ranking result ${index}.id`);
    if (raw.id !== undefined && raw.chunkId !== undefined && raw.id !== raw.chunkId) throw fail(`retrieval ranking result ${index} id and chunkId must match`);
    if (seen.has(id)) throw fail(`retrieval ranking contains duplicate raw child chunk '${id}'`);
    seen.add(id);
    return {
      id,
      chunkId: id,
      rank: normalizeRank(raw.rank, index, `retrieval ranking result ${index}.rank`),
      keywordRank: optionalPositiveRank(raw.keywordRank, `retrieval ranking result ${index}.keywordRank`),
      vectorRank: optionalPositiveRank(raw.vectorRank, `retrieval ranking result ${index}.vectorRank`),
      rrfScore: optionalFinite(raw.rrfScore, `retrieval ranking result ${index}.rrfScore`),
      keywordScore: optionalFinite(raw.keywordScore, `retrieval ranking result ${index}.keywordScore`),
      vectorScore: optionalFinite(raw.vectorScore, `retrieval ranking result ${index}.vectorScore`),
      normalizedScore: optionalFinite(raw.normalizedScore, `retrieval ranking result ${index}.normalizedScore`)
    };
  });
};

export const publicRawRanking = (results) => {
  if (!Array.isArray(results)) throw fail("retrieval ranking results must be an array");
  return validateRanking(results.map((result) => ({
    id: result.id ?? result.chunkId,
    chunkId: result.chunkId ?? result.id,
    rank: result.rank,
    keywordRank: result.keywordRank ?? null,
    vectorRank: result.vectorRank ?? null,
    rrfScore: result.rrfScore ?? null,
    keywordScore: result.keywordScore ?? null,
    vectorScore: result.vectorScore ?? null,
    normalizedScore: result.normalizedScore ?? null
  })));
};

export const serializeRawRanking = (results) => JSON.stringify({
  schemaVersion: RANKING_SCHEMA_VERSION,
  results: publicRawRanking(results)
});

export const parseSerializedRanking = (value) => {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw fail("actual retrieval ranking is not valid JSON"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail("actual retrieval ranking must be a JSON object");
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== RANKING_SCHEMA_VERSION) throw fail(`actual retrieval ranking schemaVersion must be '${RANKING_SCHEMA_VERSION}'`);
  return validateRanking(parsed.results);
};

export const validateMetricQrels = (input) => {
  const values = Array.isArray(input) ? input : input?.relevant;
  if (!Array.isArray(values) || values.length === 0) throw fail("metric qrels must contain at least one judgment");
  const seen = new Set();
  const judgments = values.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail(`metric qrels judgment ${index} must be an object`);
    const chunkId = normalizedId(raw.chunkId, `metric qrels judgment ${index}.chunkId`);
    if (seen.has(chunkId)) throw fail(`metric qrels contains duplicate raw child chunk '${chunkId}'`);
    seen.add(chunkId);
    if (typeof raw.grade !== "number" || !Number.isInteger(raw.grade) || ![0, 1, 2].includes(raw.grade)) throw fail(`metric qrels judgment ${index}.grade must be an integer grade 0, 1, or 2`);
    return { chunkId, grade: raw.grade };
  });
  if (!judgments.some((judgment) => judgment.grade > 0)) throw fail("metric qrels must contain at least one grade greater than zero");
  return judgments;
};

const evaluationCase = (testCase) => {
  const qrels = validateMetricQrels(testCase.additionalMetadata?.qrels);
  const ranking = parseSerializedRanking(testCase.actualOutput);
  return { query: testCase.input, ranking, qrels };
};

const gains = (judgments) => new Map(judgments.filter((judgment) => judgment.grade > 0).map((judgment) => [judgment.chunkId, judgment.grade]));

const discount = (rank) => Math.log2(rank + 1);

export const scoreRanking = (kind, k, ranking, qrels) => {
  if (!METRIC_KINDS.has(kind)) throw fail(`unknown raw retrieval metric '${kind}'`, "EVAL_METRIC_INVALID");
  const top = validateRanking(ranking).slice(0, validateK(k));
  const relevant = gains(validateMetricQrels(qrels));
  const retrievedRelevant = top.filter((result) => relevant.has(result.id));
  const relevantIds = [...relevant.keys()];
  let score;
  let details;
  if (kind === "judged") {
    const judgedIds = new Set(validateMetricQrels(qrels).map(item => item.chunkId));
    const judgedCount = top.filter(item => judgedIds.has(item.id)).length;
    score = top.length ? judgedCount / top.length : 0;
    details = { judgedCount, returnedCount: top.length };
  } else if (kind === "recall") {
    score = retrievedRelevant.length / relevant.size;
    details = { relevantCount: relevant.size, hitCount: retrievedRelevant.length };
  } else if (kind === "hit_rate") {
    score = retrievedRelevant.length ? 1 : 0;
    details = { relevantCount: relevant.size, hitCount: retrievedRelevant.length };
  } else if (kind === "mrr") {
    const first = retrievedRelevant[0];
    score = first ? 1 / first.rank : 0;
    details = { relevantCount: relevant.size, firstRelevantRank: first?.rank ?? null };
  } else {
    const dcg = retrievedRelevant.reduce((sum, result) => sum + relevant.get(result.id) / discount(result.rank), 0);
    const idealGrades = [...relevant.values()].sort((left, right) => right - left).slice(0, k);
    const idealDcg = idealGrades.reduce((sum, grade, index) => sum + grade / discount(index + 1), 0);
    score = idealDcg ? dcg / idealDcg : 0;
    details = { relevantCount: relevant.size, hitCount: retrievedRelevant.length, dcg, idealDcg };
  }
  return {
    score: clampScore(score),
    relevantIds,
    retrievedIds: top.map((result) => result.id),
    hitIds: retrievedRelevant.map((result) => result.id),
    ...details
  };
};

const reasonFor = (kind, k, result) => {
  const facts = [
    `relevant=${result.relevantIds.join(",") || "none"}`,
    `top${k}=${result.retrievedIds.join(",") || "none"}`,
    `hits=${result.hitIds.join(",") || "none"}`
  ];
  if (kind === "mrr") facts.push(`firstRelevantRank=${result.firstRelevantRank ?? "none"}`);
  if (kind === "ndcg") facts.push(`dcg=${result.dcg.toFixed(6)}`, `idealDcg=${result.idealDcg.toFixed(6)}`);
  return `${kind} at K=${k}: score=${result.score.toFixed(6)} (${facts.join("; ")})`;
};

class RawHybridIrMetric extends BaseMetric {
  constructor({ kind, k, threshold = 0, verboseMode = false } = {}) {
    super(resolveThreshold(threshold, 0), { includeReason: true, showIndicator: false, verboseMode });
    if (!METRIC_KINDS.has(kind)) throw fail(`unknown raw retrieval metric '${kind}'`, "EVAL_METRIC_INVALID");
    this.kind = kind;
    this.k = validateK(k);
    this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];
  }

  async measure(testCase) {
    this.error = undefined;
    // ponytail: skip DeepEval's per-metric spinner/telemetry hook because deepeval
    // 0.9.x ships a legacy CommonJS telemetry shim without the new hook. The
    // metric remains a normal BaseMetric and the evaluator still owns reporting.
    checkSingleTurnParams(testCase, this.requiredParams, this);
    const value = evaluationCase(testCase);
    const result = scoreRanking(this.kind, this.k, value.ranking, value.qrels);
    this.score = result.score;
    this.scoreBreakdown = result;
    this.reason = reasonFor(this.kind, this.k, result);
    this.success = this.isSuccessful();
    this.verboseLogs = `Score: ${this.score.toFixed(6)}\nReason: ${this.reason}`;
    return this.score;
  }

  get name() {
    const label = {
      recall: "Recall",
      hit_rate: "Hit Rate",
      mrr: "MRR",
      ndcg: "NDCG",
      judged: "Judged"
    }[this.kind];
    return `${label}@${this.k}`;
  }
}

export class RecallAtKMetric extends RawHybridIrMetric {
  constructor(options = {}) { super({ ...options, kind: "recall" }); }
}

export class HitRateAtKMetric extends RawHybridIrMetric {
  constructor(options = {}) { super({ ...options, kind: "hit_rate" }); }
}

export class MrrAtKMetric extends RawHybridIrMetric {
  constructor(options = {}) { super({ ...options, kind: "mrr" }); }
}

export class NdcgAtKMetric extends RawHybridIrMetric {
  constructor(options = {}) { super({ ...options, kind: "ndcg" }); }
}

export const createRawHybridMetrics = ({ threshold = 0, ks = EVALUATION_K_VALUES, verboseMode = false } = {}) => {
  if (!Array.isArray(ks) || ks.length === 0) throw fail("raw hybrid metric K values must be a non-empty array", "EVAL_METRIC_K_INVALID");
  return ks.flatMap((k) => [
    new RecallAtKMetric({ k, threshold, verboseMode }),
    new HitRateAtKMetric({ k, threshold, verboseMode }),
    new MrrAtKMetric({ k, threshold, verboseMode }),
    new NdcgAtKMetric({ k, threshold, verboseMode }),
    new RawHybridIrMetric({ kind: "judged", k, threshold, verboseMode })
  ]);
};

export const metricFacts = (metric) => ({
  score: clampScore(metric.score),
  reason: metric.reason || "",
  details: metric.scoreBreakdown || null
});
