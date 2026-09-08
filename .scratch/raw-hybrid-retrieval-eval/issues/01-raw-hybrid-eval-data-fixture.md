# 01 — Raw hybrid evaluation data contract and isolated fixture

**What to build:** Establish the inspectable evaluation-data contract and an isolated migrated SQLite fixture so a developer can load raw child chunks, searchable projections, active processing generations, and vector data without touching the runtime knowledge base.

**Blocked by:** None — can start immediately.

**Status:** resolved

**Label:** ready-for-agent

- [x] Define separate contracts for corpus records, queries, qrels, embedding snapshots, and provider manifests.
- [x] Support stable raw child chunk identifiers and relevance grades `0`, `1`, and `2`; reject duplicate identifiers, malformed queries, invalid grades, and queries with no relevant qrels.
- [x] Validate embedding provider, model, dimensions, input hashes, finite vector values, and snapshot-to-corpus consistency.
- [x] Build a clean migrated SQLite fixture with an active resource version, indexed processing run, raw child chunks, resource knowledge-base association, searchable projection, and retrieval embedding projection.
- [x] Load the fixture through the same active-generation and status constraints used by raw retrieval.
- [x] Verify that the public raw retrieval seam can run against the fixture and that the runtime database is unchanged.

## Comments

Implemented in `evals/raw-hybrid-retrieval/` with normal migrations, isolated
fixtures, and contract/integration coverage.
