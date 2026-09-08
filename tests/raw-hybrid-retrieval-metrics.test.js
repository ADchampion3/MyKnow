import "deepeval/vitest";
import { LLMTestCase } from "deepeval/test-case";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_K_VALUES,
  HitRateAtKMetric,
  MrrAtKMetric,
  NdcgAtKMetric,
  RecallAtKMetric,
  createRawHybridMetrics,
  parseSerializedRanking,
  scoreRanking,
  serializeRawRanking
} from "../evals/raw-hybrid-retrieval/src/metrics.js";

process.env.DEEPEVAL_TELEMETRY_OPT_OUT = "1";

const ranking = (ids) => ids.map((id, index) => ({
  id,
  rank: index + 1,
  keywordRank: index + 1,
  vectorRank: index + 1,
  rrfScore: 1 / (index + 1),
  normalizedScore: 1 / (index + 1)
}));

const testCase = (results, qrels = [{ chunkId: "a", grade: 2 }, { chunkId: "b", grade: 1 }]) => new LLMTestCase({
  input: "retrieval query",
  actualOutput: serializeRawRanking(results),
  additionalMetadata: { qrels }
});

describe("raw hybrid deterministic IR metrics", () => {
  it("computes Recall, Hit Rate, MRR, and graded NDCG without a judge model", () => {
    const results = ranking(["noise", "a", "b"]);

    expect(scoreRanking("recall", 1, results, [{ chunkId: "a", grade: 2 }, { chunkId: "b", grade: 1 }]).score).toBe(0);
    expect(scoreRanking("hit_rate", 3, results, [{ chunkId: "a", grade: 2 }, { chunkId: "b", grade: 1 }]).score).toBe(1);
    expect(scoreRanking("mrr", 3, results, [{ chunkId: "a", grade: 2 }, { chunkId: "b", grade: 1 }]).score).toBe(0.5);

    const ndcg = scoreRanking("ndcg", 3, results, [{ chunkId: "a", grade: 2 }, { chunkId: "b", grade: 1 }]);
    expect(ndcg.score).toBeGreaterThan(0);
    expect(ndcg.score).toBeLessThan(1);
    expect(ndcg.retrievedIds).toEqual(["noise", "a", "b"]);
    expect(ndcg.hitIds).toEqual(["a", "b"]);
  });

  it("creates every required K metric and preserves the raw ranking metadata", async () => {
    const metrics = createRawHybridMetrics();
    expect(metrics).toHaveLength(EVALUATION_K_VALUES.length * 5);
    expect(new Set(metrics.map((metric) => metric.name)).size).toBe(metrics.length);
    expect(metrics.map((metric) => metric.name).slice(0, 4)).toEqual([
      "Recall@1",
      "Hit Rate@1",
      "MRR@1",
      "NDCG@1"
    ]);

    const actual = ranking(["a", "b"]);
    const roundTrip = parseSerializedRanking(serializeRawRanking(actual));
    expect(roundTrip[0]).toMatchObject({
      id: "a",
      chunkId: "a",
      rank: 1,
      keywordRank: 1,
      vectorRank: 1,
      rrfScore: 1,
      normalizedScore: 1
    });

    const metric = new RecallAtKMetric({ k: 1, threshold: 0 });
    await metric.measure(testCase(actual));
    expect(metric.score).toBe(0.5);
    expect(metric.success).toBe(true);
    expect(metric.scoreBreakdown).toMatchObject({ relevantCount: 2, hitCount: 1 });
  });

  it("runs through DeepEval's Vitest matcher while keeping metric math local", async () => {
    const metric = new HitRateAtKMetric({ k: 1, threshold: 0 });
    await expect(testCase(ranking(["a", "noise"]))).toPass([metric]);
    expect(metric.score).toBe(1);
    expect(metric.evaluationModel).toBeUndefined();
  });

  it("reports a late relevant hit and validates malformed raw output", async () => {
    const metric = new MrrAtKMetric({ k: 3, threshold: 0 });
    await metric.measure(testCase(ranking(["noise", "noise-2", "a"])));
    expect(metric.score).toBeCloseTo(1 / 3, 10);
    expect(metric.reason).toContain("firstRelevantRank=3");

    expect(() => parseSerializedRanking(serializeRawRanking(ranking(["a", "a"])))).toThrow(/duplicate raw child chunk/u);
    await expect(new NdcgAtKMetric({ k: 1 }).measure(testCase(ranking(["a"]), [{ chunkId: "a", grade: 0 }]))).rejects.toThrow(/greater than zero/u);
  });

  it("uses linear graded gain and distinguishes explicit zero from unjudged", () => {
    const graded = scoreRanking("ndcg", 3, ranking(["b", "a", "noise"]), [
      { chunkId: "a", grade: 2 },
      { chunkId: "b", grade: 1 }
    ]);
    const linearDcg = 1 / Math.log2(2) + 2 / Math.log2(3);
    const idealDcg = 2 / Math.log2(2) + 1 / Math.log2(3);
    expect(graded.score).toBeCloseTo(linearDcg / idealDcg, 10);
    expect(scoreRanking("judged", 3, ranking(["zero", "a", "unjudged"]), [
      { chunkId: "zero", grade: 0 },
      { chunkId: "a", grade: 1 }
    ])).toMatchObject({ score: 2 / 3, judgedCount: 2, returnedCount: 3 });
    expect(scoreRanking("judged", 3, [], [{ chunkId: "a", grade: 1 }]).score).toBe(0);
  });
});
