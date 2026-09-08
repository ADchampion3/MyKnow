# 02 — Deterministic DeepEval TypeScript IR metrics

**What to build:** Add DeepEval TypeScript custom metrics that score a returned raw child chunk ranking against qrels without invoking an LLM judge or making network requests.

**Blocked by:** None — can start immediately.

**Status:** resolved

**Label:** ready-for-agent

- [x] Implement Recall@K, Hit Rate@K, MRR@K, and NDCG@K as deterministic DeepEval metrics.
- [x] Provide metric instances for K values `1`, `3`, `5`, and `10` with names that identify the metric family and K.
- [x] Treat qrels with a grade greater than zero as relevant for Recall, Hit Rate, and MRR; use graded gains for NDCG.
- [x] Keep every score in the `0..1` range and expose a useful reason containing the relevant and retrieved ranking facts.
- [x] Cover no-hit, first-hit, late-hit, multiple relevant chunks, graded relevance, and results truncated at K.
- [x] Verify that metric calculation does not initialize a judge model, require model credentials, or call an external service.

## Comments

Implemented as DeepEval `BaseMetric` subclasses with deterministic scoring and
Vitest matcher coverage; no judge model or metric-time network call is used.
