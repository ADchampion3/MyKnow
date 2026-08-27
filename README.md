# MyKnow

## Sprint 1 bootstrap

Requirements: Node.js 20+. The Web process is Next.js and the API process is NestJS; the Worker remains an independent Node process.

```powershell
npm run dev:api
npm run dev:web
npm run dev:worker
```

Copy `.env.example` to `.env` when custom configuration is needed. The API exposes `GET /health` and `GET /ready`; the web app serves the three-column workspace. The API and Worker share the SQLite database, and the Worker executes deterministic demo tasks (`demo_success` and `demo_failure`) with retry support.

## Sprint 2 resource flow

Import text through `POST /api/resources` with JSON `{ name, knowledgeBaseId, content }`, or upload a local `.md`, `.txt`, or `.pdf` through `multipart/form-data` using fields `name`, `knowledgeBaseId`, and `file`. PDF imports must also choose `ocrMode` (`auto`, `off`, or `force`) and `ocrProvider` (`local`, `cloud`, or `paddleocr`). Add a new immutable version through `POST /api/resources/:id/versions`; use `Idempotency-Key` only when a transport retry must return the original result. URL fetching and Base64 imports are intentionally not part of the contract. The Worker stores immutable source bytes, records a processing run and canonical artifact, applies the adaptive heading/heuristic/recursive chunker, creates parent/child chunks, and indexes only child chunks in SQLite FTS5. OCR artifacts contain page/block metadata; table blocks use GFM Markdown and formula blocks use LaTeX. Search uses `GET /api/search?q=...&knowledgeBaseId=...`; default results are limited to each resource's last successful current version, while an explicit `resourceVersionId` searches history. Resource files and canonical artifacts are stored under `RESOURCE_STORAGE_DIR`; keep that directory server-side.

Processing controls are available through `POST /api/resources/:id/reprocess`, `POST /api/resources/rebuild`, `GET /api/resources/:id/processing-runs`, `POST /api/resources/:id/chunk-preview`, `POST /api/resources/:id/archive`, and `POST /api/resources/:id/restore`. Rebuild uses build-then-swap, so an old successful index remains searchable while a replacement run is built. Resource states are `pending`, `processing`, `indexed`, `degraded`, `failed`, and `archived`; PDF parsing remains best-effort.

The database schema is a deliberate Sprint 2 break. A fresh empty database is required; an older database reports `DATABASE_RECREATE_REQUIRED`. Recreate only the exact SQLite file with `node scripts/recreate-db.js --confirm <path-to-db>`; the raw storage directory is not deleted and unreferenced blobs are reported for manual review.

The complete chunking contract is documented in [`docs/CHUNKING_MECHANISM.md`](docs/CHUNKING_MECHANISM.md).
The raw-source contract and state machine are documented in [`docs/SPRINT2_RAW_SOURCE_CONTRACT.md`](docs/SPRINT2_RAW_SOURCE_CONTRACT.md).
The Sprint 2 PDF OCR contract, local setup, focused checks, and full-chain evidence flow are documented in [`docs/SPRINT2_PDF_OCR.md`](docs/SPRINT2_PDF_OCR.md), with focused evidence in [`artifacts/sprint2/pdf-ocr-evidence.md`](artifacts/sprint2/pdf-ocr-evidence.md).

For large PDFs, `RESOURCE_PARSER_TIMEOUT_MS` controls the MarkItDown subprocess timeout (default 120 seconds).

## Sprint 3 LLM Wiki

The Wiki is the default knowledge-base projection while immutable resources, resource versions, chunks, FTS rows, and audit records remain the retrieval and provenance projection. A knowledge base uses `wiki-enabled` by default; an individual resource can be set to `retrieval-only` without removing it from search. Wiki page content is immutable by version, citations bind to a specific resource version and locator, and a restore creates a new page version.

The Wiki API covers the overview/tree, page metadata, Markdown versions, deterministic blocks and diff, restore, templates, citations, locator previews, and impact items. The Worker queues `wiki:impact-scan` after a successfully indexed resource version; deterministic scans mark old-version citations `needs_review` and unreadable targets `broken`. The Web workspace exposes page slug/space/parent metadata, source locator previews, and resource task status/error traces.

The current schema marker is `sprint4-rag-retrieval-v1`. An empty database starts with the normal API/Worker commands. An existing Sprint 3 database must be rebuilt explicitly, preserving source storage and retained records:

```powershell
node scripts/recreate-db.js --confirm <path-to-existing-db>
```

The rebuild validates every referenced source blob before swapping only the exact database file, keeps a `.pre-sprint4-<timestamp>.bak` copy, and leaves the original database in place if validation or the build fails. Focused checks are `npm run check:wiki` (contract, layout, impact scan, and rebuild); `npm run check:all` includes them. Sprint 3 acceptance evidence is under [`artifacts/sprint3/`](artifacts/sprint3/), including the workspace screenshot and the source-read-only, version/diff, citation, layout, impact, and rebuild checks.

Real LLM/Agent Wiki writes, RAG answer generation, multi-page review plans, and collaboration remain explicitly deferred to later Sprints.

## Sprint 4 page-centric RAG retrieval

The complete current retrieval flow, data lifecycle, trace rules, and verification entry points are documented in [`docs/RETRIEVAL_MECHANISM.md`](docs/RETRIEVAL_MECHANISM.md).

`POST /api/retrieval/query` runs two independent retrieval channels: Wiki pages and current indexed raw child chunks. Wiki scope can be narrowed with `spaceId`; raw scope is intentionally the whole knowledge base until resource-space membership exists. Defaults are Wiki Top-5, raw Top-10, and an 8,000-token context budget, with server-side limits of 20 results per channel and 50,000 context tokens.

The keyword path uses SQLite FTS5 plus deterministic English token/stopword handling, CJK bigrams, OR recall, title/phrase scoring, and explainable match features. Optional local mock or OpenAI-compatible embeddings are generated by the Worker and stored as derived rows. Set `RETRIEVAL_VECTOR_ENABLED=false` to disable them; an unavailable, timed-out, or failed provider degrades to the keyword path and records the reason in the trace. API keys are never returned in traces or logs. `npm run check:retrieval-real` exercises the local `qwen3-embedding-8b` endpoint at `http://localhost:9000/v1/embeddings`, requesting 1024 dimensions and reporting the actual returned dimension.

Only high-confidence Wiki results can seed explicit `wiki://UUID` links. Graph expansion is same-knowledge-base, bidirectional, capped at two hops and ten pages per layer; raw chunks never become graph seeds. Wiki results perform provenance lookup only, retaining source resource/version/locator and integrity status without turning citations into graph edges.

Every run is persisted for replay through `GET /api/retrieval/runs/:id`. The response includes independent candidates, seed gates, graph paths, provenance, context items, 60/40 Wiki/raw budgets, truncation markers, provider status, and timing; replay strips raw result text and keeps only the generated context snapshot. Retrieval checker links open the exact Wiki page version or `GET /api/resources/:resourceId/versions/:versionId/preview?startOffset=...&endOffset=...` for a read-only raw version locator preview. The Web three-column workspace includes a retrieval checker and right-rail trace view; it does not generate answers.

Sprint 4 focused checks are `npm run check:retrieval` (API contract/replay, graph boundaries, context budget, vector fallback, and a 100-document/5,000-child-chunk performance check). `npm run check:all` includes these checks. Acceptance evidence is under [`artifacts/sprint4/`](artifacts/sprint4/).

## Source layout

The runtime entry points stay stable, while implementation is grouped by responsibility:

```text
apps/api/src/
  index.js                 # process bootstrap and database readiness
  app.js                   # HTTP lifecycle and route dispatch
  http.js                  # JSON/multipart response, body parsing, error mapping
  context.js               # shared API capabilities and audit/task helpers
  routes/                  # knowledge bases, resources, search, retrieval, tasks, Wiki
apps/worker/src/
  index.js                 # worker bootstrap and polling loop
  tasks/runner.js          # claim, attempts, retry, recovery, task states
  resources/processor.js   # reader -> canonical artifact -> chunks/FTS
  retrieval/embeddings.js  # optional embedding task processor
  materials.js             # MaterialReader adapters
packages/db/src/
  index.js                 # stable package exports
  database/                # connection and migrations
  schema.js                # Drizzle table definitions
  resources.js             # source storage, integrity, and resource status primitives
  chunker.js               # canonical text and parent/child chunking
  text-tokenizer.js        # shared word/CJK token scanning
  retrieval.js              # dual-channel retrieval, graph, provenance, context, trace
  embeddings.js             # provider seam and deterministic mock embeddings
```

The intended dependency direction is `entrypoint -> runtime module -> domain adapter -> @myknow/db`; route modules do not own process startup, and database modules do not depend on API or Worker code.

## Checks

```powershell
npm run check:db
 npm run check:api
 npm run check:worker
 npm run check:chunker
 npm run check:materials
 npm run check:all
 npm run check:retrieval
node --check apps/api/src/index.js
node --check apps/web/src/index.js
node --check apps/worker/src/index.js
```

The Sprint 1 acceptance plan and evidence requirements are in `SPRINT1_PLAN.md`. RAG answer generation and Agent/Wiki changes remain deferred; Office, ASR, and file-URL adapters remain outside this optimization pass.
