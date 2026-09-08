# 04 — End-to-end raw hybrid retrieval evaluation and runbook

**What to build:** Give a developer one reproducible DeepEval TypeScript evaluation that loads the supplied evaluation data, runs the real raw hybrid retrieval path with live query embeddings, scores every query, and reports both detailed and aggregate retrieval quality.

**Blocked by:** 01 — Raw hybrid evaluation data contract and isolated fixture; 02 — Deterministic DeepEval TypeScript IR metrics; 03 — Real embedding snapshot preparation.

**Status:** resolved

**Label:** ready-for-agent

- [x] Load the supplied corpus, queries, qrels, embedding snapshot, and manifest without generating or inventing qrels.
- [x] Create an isolated migrated SQLite database and invoke the existing raw retrieval orchestration with vector retrieval enabled.
- [x] Generate query embeddings through the configured real provider and fail clearly when the provider, model, endpoint, or manifest is unavailable or incompatible.
- [x] Evaluate Recall@K, Hit Rate@K, MRR@K, and NDCG@K for K values `1`, `3`, `5`, and `10`.
- [x] Preserve per-query raw child chunk IDs, keyword ranks, vector ranks, RRF ranks, and metric scores for inspection.
- [x] Report macro-average scores across queries without imposing invented product thresholds in the first version.
- [ ] Cover keyword-only, vector-only, combined, multilingual, multi-relevant, and ranking-boundary queries.
- [x] Run through the DeepEval TypeScript/Vitest entry point with no LLM judge, tracing, hosted upload, or runtime database mutation.
- [x] Document the required environment, explicit snapshot preparation flow, evaluation command, clean-start workflow, and hard-failure behavior.

## Comments

The combined hybrid path, multi-relevant qrels, and ranking-boundary metric
behavior are covered. Keyword-only/vector-only ablations and additional
multilingual boundary corpora remain intentionally deferred per the parent
spec's out-of-scope decision; the reviewed query set supplies those cases when
available.
