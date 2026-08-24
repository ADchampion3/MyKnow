# Sprint 2 raw-source contract

This document supersedes the earlier URL/Base64 experiment.

## Inputs

- JSON text import: `POST /api/resources` with `name`, `knowledgeBaseId`, and UTF-8 `content`.
- Multipart local file import: `name`, `knowledgeBaseId`, and `file` for `.md`, `.txt`, or PDF. PDF requests must also provide `ocrMode` (`auto`, `off`, or `force`) and `ocrProvider` (`local`, `cloud`, or `paddleocr`); the provider is required even when OCR is explicitly off so processing choice is never guessed.
- New version: `POST /api/resources/:id/versions`.
- `Idempotency-Key` is optional. Repeating a request without it creates an independent version; repeating it with the same payload returns the original result.
- URL fetching, server paths, and `contentBase64` are not public inputs.

## Immutable source model

Every submission creates an independent `resource_version`. The version's original bytes, SHA-256, size, MIME, and original filename never change. Content-addressed blobs may be physically reused by SHA-256, but logical resources and versions are never merged.

`resources.current_version_id` points only to the last successfully indexed version. Default search uses current, non-archived versions; explicit `resourceVersionId` searches history.

## Transfer fields

The API returns stable identifiers and processing facts; internal storage coordinates stay server-side.

| Field | Meaning |
| --- | --- |
| `resource.id`, `name`, `source_type` | Logical item and display label. `source_type` is `text` for JSON text and `file` for multipart input; it does not change across later versions. |
| `resource.status` | Derived visibility/index state. `indexed` means a current version is searchable; `degraded` means the current version remains searchable while a newer version failed; `archived` is excluded from default list/search. |
| `resource.current_version_id` | Pointer to the last successful version. It never advances when a pending/failed replacement has not indexed successfully. |
| `resource_version.id`, `resource_id` | Immutable logical version identity and its parent resource. |
| `content_sha256`, `byte_size`, `mime_type`, `original_filename` | Source integrity and parser selection facts. The raw bytes never change. |
| `ocr_mode`, `ocr_provider`, `ocr_capabilities` | The requested PDF processing contract. The selected provider is persisted and never changed by native fallback, retry, or restart. |
| `status`, `parser_name`, `parser_version`, `error_summary` | Version processing outcome and the last parser/error metadata. |
| `task.id`, `type`, `resource_version_id` | Work identity and the exact version being processed. `payload` is internal and omitted from DTOs. |
| `task.status`, `progress`, `retry_count`, `retry_limit`, `next_attempt_at`, `error_code` | Queue state, progress, consumed total attempts, retry ceiling, next eligible time, and machine-readable failure reason. |
| `processing_run.id`, `resource_version_id`, `status` | One concrete parse/index execution. Only an `indexed` run referenced by `active_processing_run_id` supplies the active FTS rows. OCR runs also retain requested/actual provider, adapter/model identity, page count, warnings, and metrics. |

`storage_key`, `canonical_storage_key`, idempotency fingerprints, and task payloads are deliberately omitted from public DTOs. Raw download and canonical artifact endpoints verify the stored byte count and SHA-256 before returning data.

## States

Resource states: `pending`, `processing`, `indexed`, `degraded`, `failed`, `archived`.

Version states: `pending`, `processing`, `indexed`, `failed`.

Task states: `queued`, `running`, `retrying`, `succeeded`, `failed`.

Processing uses at most three total attempts. Only transient errors retry automatically (`1s`, then `5s`); manual retry creates a new task. Rebuild is per-version build-then-swap, retaining the old successful run until the replacement succeeds.

The normal flow is `resource pending → version pending → task queued → running → version processing → indexed`; a successful version advances `current_version_id`. A transient task failure becomes `retrying` and consumes an attempt; a permanent or exhausted failure becomes `failed`. If a prior indexed run exists, a replacement failure restores the version to `indexed` and leaves the old search result active, so a failed rebuild cannot blank the knowledge base. Archiving fails queued/retrying work with `RESOURCE_ARCHIVED`; a running worker checks the archive state before committing. Restore returns the resource to pending and queues versions without an indexed run.

## Storage and database replacement

Blob writes are temporary-file then atomic-rename. Existing content-addressed targets are rechecked for size and SHA-256. Downloads and canonical artifact reads perform the same integrity check. Orphan blobs are report-only.

The schema is intentionally breaking for the early single-user project. Empty-database startup is reproducible. Unsupported older files return `DATABASE_RECREATE_REQUIRED`; use `node scripts/recreate-db.js --confirm <path-to-db>` for the exact SQLite file. The raw storage directory is not deleted by this operation.

## Evidence

Run `npm run check:db`, `npm run check:api`, `npm run check:worker`, `npm run check:chunker`, and `npm run check:materials`. Record the command, timestamp, environment, and result under `artifacts/sprint2/`.

For the Sprint 2 PDF OCR full-chain check, follow [`SPRINT2_PDF_OCR.md`](SPRINT2_PDF_OCR.md), then run `node scripts/pdf-ocr-e2e.js "D:\\path\\book.pdf"`. The script uses an isolated database/storage directory, verifies source SHA-256 round-trip, waits for `queued -> running -> succeeded`, checks the page/block canonical artifact and child-only FTS, and writes a timestamped report under `artifacts/sprint2/`. Large documents use `RESOURCE_PARSER_TIMEOUT_MS` (default `120000`).
