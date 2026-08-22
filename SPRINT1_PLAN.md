# Sprint 1 Plan

## Goal

In 10 working days, deliver a local-first, single-user foundation that can start from an empty database and demonstrate:

`create knowledge base -> create space -> create tag -> create task -> worker runs -> observe success/failure/retry`

The product is a real data-backed shell. Real resource import, retrieval, RAG, Agent planning, and Wiki writes remain in later sprints.

## Fixed decisions

- Architecture: Next.js Web, NestJS API, and an independent Worker.
- Storage: Drizzle ORM over SQLite; migrations are repeatable and safe to rerun.
- Worker: database task table plus polling; no Redis or external queue in Sprint 1.
- Providers: interfaces plus deterministic mock providers only.
- IDs: UUID strings. Times: UTC ISO 8601.
- UI: three columns at 1280px; collapsible left rail at 1024px; no mobile-native promise.
- API: REST JSON with `{ data, error, requestId }` and stable error codes.
- Deletion: no physical deletion of domain or audit records.

## Data model

Usable in Sprint 1:

- `knowledge_bases`: name, description, status, timestamps.
- `spaces`: knowledge-base owner, name, status, timestamps.
- `tags`: knowledge-base owner, name, timestamps.
- `tasks`: type, status, progress, retry limit/count, worker ID, timestamps, error summary.
- `task_attempts`: task ID, attempt number, status, worker ID, start/end times, redacted error.
- `audit_logs`: event type, entity type/ID, request ID, timestamp, redacted metadata.

Boundary tables may be created for later work: `resources`, `resource_versions`, `chunks`, `citations`, `wiki_pages`, `wiki_page_versions`, and `review_plans`. They have no Sprint 1 user flow.

## API contract

- `GET/POST /api/knowledge-bases`
- `GET/POST /api/knowledge-bases/:id/spaces`
- `GET/POST /api/knowledge-bases/:id/tags`
- `GET/POST /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/retry`
- `GET /health`
- `GET /ready`

Required error codes: `VALIDATION_ERROR`, `NOT_FOUND`, `DUPLICATE_NAME`, `INVALID_STATE_TRANSITION`, `TASK_RETRY_LIMIT`, `CONFIGURATION_ERROR`, and `INTERNAL_ERROR`.

## Worker contract

Support deterministic demo types `demo_success` and `demo_failure`. Claim queued work transactionally by changing it to `running`; append one `task_attempts` row per run. A failure may move through `retrying` to `running` until the retry limit, then remains `failed`. Every transition is auditable and idempotent.

## Ten-day schedule

1. Days 1-2: repository setup, configuration validation, process start commands, health/readiness endpoints.
2. Days 3-4: schema, migrations, seed, repositories, empty-database bootstrap.
3. Day 5: knowledge-base, space, and tag API plus validation and duplicate constraints.
4. Day 6: task API, state machine, and polling Worker.
5. Day 7: failure/retry flow, attempts, audit events, and error redaction.
6. Days 8-9: three-column workspace with real API data, loading/empty/error states, and task polling.
7. Day 10: contract/integration/smoke tests, screenshot capture, secret scan, README, acceptance report, and fixes.

## Acceptance evidence

Store evidence in `artifacts/sprint1/`:

- empty-database startup and migration logs;
- API contract and repository/state-machine test output;
- successful task log;
- failed task and retry log;
- three-column desktop screenshot and 1024px layout check;
- secret-scan result;
- final report listing each criterion as pass, fail, or explicitly deferred.

## Priority if time is cut

1. Three processes start and health checks work.
2. Migrations and persistence work from an empty database.
3. Worker state machine and retry work.
4. Knowledge-base, space, and tag CRUD work.
5. Three-column UI works.
6. Non-essential visual polish is deferred.
