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

Import through `POST /api/resources` using JSON with `name`, `mimeType`, `contentBase64`, and `knowledgeBaseId` for `.md`/`.txt`/`.pdf` files, or `url` for an HTTP/HTTPS web-page snapshot. The Worker stores immutable source bytes, records a processing run and canonical artifact, applies the adaptive heading/heuristic/recursive chunker, creates parent/child chunks, and indexes only child chunks in SQLite FTS5. Search uses `GET /api/search?q=...&knowledgeBaseId=...`; results include the matching child and optional `parent_content`. Resource files and canonical artifacts are stored under `RESOURCE_STORAGE_DIR`; keep that directory server-side.

Processing controls are available through `POST /api/resources/:id/reprocess`, `POST /api/resources/rebuild`, `GET /api/resources/:id/processing-runs`, and `POST /api/resources/:id/chunk-preview`. The project is still in early development, so derived chunks and FTS rows are intentionally rebuildable when the schema or chunking contract changes.

The complete chunking contract is documented in [`docs/CHUNKING_MECHANISM.md`](docs/CHUNKING_MECHANISM.md).

## Source layout

The runtime entry points stay stable, while implementation is grouped by responsibility:

```text
apps/api/src/
  index.js                 # process bootstrap and database readiness
  app.js                   # HTTP lifecycle and route dispatch
  http.js                  # JSON response, body parsing, error mapping
  context.js               # shared API capabilities and audit/task helpers
  routes/                  # knowledge bases, resources, search, tasks
apps/worker/src/
  index.js                 # worker bootstrap and polling loop
  tasks/runner.js          # claim, attempts, retry, recovery, task states
  resources/processor.js   # reader -> canonical artifact -> chunks/FTS
  materials.js             # MaterialReader adapters
packages/db/src/
  index.js                 # stable package exports
  database/                # connection and migrations
  schema.js                # Drizzle table definitions
  resources.js             # source storage and URL safety primitives
  chunker.js               # canonical text and parent/child chunking
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
node --check apps/api/src/index.js
node --check apps/web/src/index.js
node --check apps/worker/src/index.js
```

The Sprint 1 acceptance plan and evidence requirements are in `SPRINT1_PLAN.md`. RAG and Agent/Wiki changes remain deferred; Office, OCR/VLM, ASR, and file-URL adapters remain outside this optimization pass.
