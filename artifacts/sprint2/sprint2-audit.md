# Sprint 2 completion audit

Date: 2026-08-23  
Review mode: root agent only; no sub-agent review

## Completion result

Sprint 2 raw-source scope is complete for the local, single-user boundary:

- JSON text and native multipart `.md`, `.txt`, and `.pdf` imports.
- Immutable source versions with content SHA-256, byte-size verification, atomic content-addressed storage, and controlled downloads.
- Database-polled task lifecycle with claim/attempt records, transient retry, interrupted-task recovery, manual retry, and archive/restore behavior.
- MarkItDown-first PDF reader with bounded fallback, canonical artifacts, adaptive parent/child chunks, child-only FTS5, current/history search isolation, and build-then-swap processing.
- Public DTO redaction for storage paths, payloads, idempotency fingerprints, and canonical storage coordinates.
- Clean empty-database startup and explicit `DATABASE_RECREATE_REQUIRED` handling for the intentionally breaking schema.

The supplied PDF full-chain run also passed mechanically. Its embedded text map produces Chinese mojibake despite a visually readable page; OCR/VLM remains explicitly outside Sprint 2 and is recorded as a fidelity limitation, not hidden as a successful semantic parse.

## Bugs fixed during this audit

1. Reprocessing a historical version could move `resources.current_version_id` back to that old version. Promotion now occurs only when the processed version is the resource's latest version.
2. Terminal and retrying tasks retained `worker_id`, making a completed task appear leased. Worker ownership is cleared on success and failure.
3. Generic task retry for a resource version did not refresh the parent resource status. It now refreshes the derived status before queuing the replacement task.
4. `POST /api/resources/:id/retry` accepted an explicitly supplied non-failed version. It now rejects that invalid state transition.
5. The multipart parser split on boundary bytes found inside binary content. It now parses boundary lines from `Buffer` slices and preserves arbitrary file bytes.
6. Removed `url`/`contentBase64` fields were silently ignored when valid `content` was also present. Mixed requests now fail validation.
7. Array/scalar chunking configurations silently became defaults. Only objects are accepted; omitted or `null` configuration still uses defaults.

## Evidence

- `npm run check:all` — PASS
- `npm run check:storage` — PASS (report-only orphan scan)
- `npm test` — PASS
- `npm --workspace apps/web exec next build` — PASS
- `git diff --check` — PASS
- PDF full chain — PASS; see the timestamped `pdf-e2e-*.md` report in this directory

Focused regression coverage is in `scripts/api-contract.js`, `scripts/worker-check.js`, and `packages/db/src/chunker-check.js`.
