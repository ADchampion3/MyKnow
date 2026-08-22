# Sprint 2 acceptance report

Date: 2026-08-21
Environment: Windows, Node v24.16.0, npm 12.0.2, SQLite via better-sqlite3

## Verified after review/fix

- `npm run check:db`: PASS. Fresh in-memory migration is repeatable; FTS5 and database-side name/storage-path guards are exercised.
- `npm run check:api`: PASS. JSON import contract, controlled version download, pagination/status filtering, duplicate/version handling, stable NOT_FOUND/validation errors, FTS query escaping, and IPv4/IPv6 SSRF rejection are exercised.
- `npm run check:worker`: PASS. Success/failure state machine, retry limit, task attempts/audit rows, interrupted-task recovery, resource indexing, re-index without deleting chunks, FTS results, and retry-limit API response are exercised.
- `npm --workspace apps/web exec next build`: PASS. Three-column Web build compiles with selected knowledge-base resource isolation, loading/empty/error states, import, search, and retry actions.
- `npm test`: PASS (workspace packages have no additional test suites).
- `node --check` passed for API, Worker, Web entry point, DB/config modules, and contract checks.

## Fixed in this review

- Added transactional task retrying/retry counts, attempt/audit updates, startup recovery of open attempts, and `POST /api/tasks/:id/retry`.
- Added resolved-host SSRF checks, IPv6/private-range rejection, URL response size limits, URL snapshot byte hashing, and PDF safe-path validation.
- Preserved chunk rows during re-index (`superseded` status); only derived FTS rows are rebuilt.
- Added strict Base64/exact-one input validation, database name/status constraints, stable error mapping, pagination/status filters, and controlled version download.
- Fixed Web resource refresh when changing knowledge bases and bounded browser Base64 conversion.

## Deferred / not a Sprint 2 pass

- Native `multipart/form-data` upload is not implemented; current contract remains JSON + Base64.
- No live public URL or MarkItDown fixture was run in this local evidence set.
- The original Sprint 2 baseline did not include the required 100-mixed-fixture run or 20-row `chunk-trace.jsonl`; the production Web workspace screenshot is recorded at `artifacts/sprint2/workspace-import-search.png`. The optimization pass below adds and verifies the deterministic 20-row trace.
- FTS5 fallback to `LIKE` and a durable multi-worker lease are not implemented; current SQLite/single-worker MVP path is covered.

The core local resource/import/index/retry path is verified, but the full `SPRINT2_PLAN.md` acceptance gate remains open until the deferred evidence and multipart contract are completed. Deferred work is recorded in `SPRINT3_BACKLOG.md`.

## Sprint 2 optimization pass — 2026-08-21

This pass intentionally uses the early-development breaking-change policy recorded in `AGENTS.md`. Existing derived fixed-800 chunks and FTS rows are rebuildable; original source bytes and audit rows remain preserved.

Verified:

- `npm run check:db`: PASS. Repeatable migration, old-schema detection, derived-data reset, pending full-rebuild task creation, name/storage guards and FTS availability.
- `npm run check:chunker`: PASS. Unicode code-point offsets, heading strategy, protected code/table/link content, parent/child output, overlap and forced splits.
- `npm run check:materials`: PASS. UTF-8 normalization, source integrity rejection, reader attempt hooks and quality metadata.
- `npm run check:api`: PASS. KB chunking configuration PATCH, chunk preview, import validation and stable error contracts.
- `npm run check:worker`: PASS. Reader attempts, canonical artifact retrieval, parent/child FTS behavior, processing runs, reprocessing and explicit full rebuild.
- `npm test`: PASS.
- `npm --workspace apps/web exec next build`: PASS.
- `node --check` for API, Worker, material reader, DB, chunker and contract scripts: PASS.
- `npm run trace:chunks`: PASS. Twenty deterministic trace rows are recorded in `artifacts/sprint2/chunk-trace.jsonl`.

Not exercised in this local pass:

- Live public HTML URL fetch and real MarkItDown/PDF fixture execution.
- Office/OCR/VLM/ASR/file-URL adapters, which remain deferred by the current scope.
