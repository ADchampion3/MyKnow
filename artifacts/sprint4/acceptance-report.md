# Sprint 4 acceptance report

Date: 2026-08-26

## Result

Sprint 4 page-centric RAG retrieval is implemented and passes the empty-database API/Worker contract, graph-boundary checks, strict context-budget checks, vector fallback checks, migration rebuild check, and the local performance target.

| Acceptance item | Evidence | Result |
| --- | --- | --- |
| Independent Wiki/raw channels and scope isolation | `retrieval-api-contract.log` | Pass: Wiki Top-K and raw Top-K are independent; Wiki accepts an optional space; raw is explicitly whole-KB; foreign-KB results are excluded |
| Keyword baseline | `retrieval-api-contract.log` | Pass: English token/stopword handling, CJK bigrams, OR query, title/phrase scoring, and explainable match features |
| Wiki seed gate and graph expansion | `graph-expansion.log` | Pass: score/margin gate, same-KB bidirectional graph, two hops, per-layer cap, decay, low-confidence and raw-only no-graph cases |
| Optional vector retrieval and degrade path | `retrieval-vector.log` | Pass: mock provider, persisted Wiki/raw embeddings, RRF merge, disabled path, timeout degrade, failed embedding audit path, no secret leakage |
| Real embedding provider follow-up | `retrieval-real-embedding.log` | Pass: OpenAI-compatible request, real Worker Wiki/raw vectors, real query vector, and vector retrieval with `qwen3-embedding-8b`; service returned 4096 dimensions while 1024 was requested and the actual dimension was recorded |
| Provenance and context assembly | `context-budget.log` | Pass: 60/40 independent budgets, Wiki block/adjacent selection, raw parent context, strict estimate, truncation marker, locator/provenance metadata |
| Trace replay | `retrieval-api-contract.log`, `retrieval-trace.jsonl` | Pass: `POST /api/retrieval/query` persists and `GET /api/retrieval/runs/:id` replays the same trace without raw result text; generated context snapshot remains available |
| Three-column Web checker | `retrieval-layout.png` | Pass: Sprint 4 retrieval checker renders independent Wiki/raw/graph cards and right-rail trace status |
| Schema and derived-index rebuild | `migration-rebuild.log` | Pass: marker `sprint4-rag-retrieval-v1`; source bytes, resource/version pointers, and audit rows survive rebuild; derived projections are rebuilt |
| Local retrieval performance | `retrieval-vector.log`, performance command output | Pass: 100 documents, 5,001 child chunks, 106 Wiki pages, 20/20 Recall@10, p95 12.93ms |

## Review follow-up

The parallel Standards and Spec review used Sprint 3 commit `94c2c49` as the fixed point and included the uncommitted Sprint 4 work tree. The review findings were fixed as follows:

- retrieval run persistence strips raw result text from replay/audit data while retaining the requested context snapshot;
- JSON `null`, knowledge-base/space/run IDs, and retrieval limits fail at the API boundary with `VALIDATION_ERROR`;
- startup and resource-index embedding queues use a batch cache, with a documented local-MVP ceiling for the single-item fallback;
- Wiki links target the exact page version, and raw links target a read-only source-version locator preview;
- shared token scanning and page-result projection logic now have one implementation.

## Commands

```text
npm run check:all
npm --workspace apps/web run build
npm run check:retrieval
npm run check:embedding-provider
npm run check:retrieval-real
npm run check:wiki-rebuild
node --check packages/db/src/retrieval.js
node --check packages/db/src/embeddings.js
node --check apps/api/src/routes/retrieval.js
node --check apps/worker/src/retrieval/embeddings.js
```

All commands passed. The existing OCR check's expected fixture-failure line is informational; the check completed successfully.

## Data and migration policy

`wiki_fts`, `wiki_link_edges`, `retrieval_embeddings`, and the retrieval projections are derived and rebuildable. Original resource storage, immutable resource versions, Wiki versions/citations, audit records, and retrieval run records are retained. Existing Sprint 3 databases use `node scripts/recreate-db.js --confirm <database-file>` and receive a `.pre-sprint4-<timestamp>.bak` backup.

## Deferred by design

Answer generation, completion/chat models, Agent runtime, automatic Wiki writes/link enrichment, resource-space filtering for raw retrieval, and ANN storage remain deferred to the next Sprint backlog. The vector seam provides a deterministic local mock, an OpenAI-compatible HTTP provider, and explicit provider-degrade states.
