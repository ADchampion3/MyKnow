# Sprint 2 raw-source acceptance report

Date: 2026-08-23
Environment: Windows, Node v24.16.0, npm 12.0.2, SQLite via better-sqlite3

## Scope

This report supersedes the earlier Sprint 2 acceptance notes for the raw-source path. The implementation now uses a breaking, clean-schema contract for a local single-user knowledge base:

- JSON text and native multipart local `.md`, `.txt`, and `.pdf` imports.
- Immutable resource versions with content-addressed raw blobs.
- `current_version_id` points to the last successfully indexed version; historical versions are explicit search targets.
- Build-then-swap indexing keeps the previous active index until a replacement succeeds.
- Three total task attempts, transient-only automatic retry, and explicit replacement tasks for manual retry.
- Archive/restore semantics without deleting source bytes or processing/audit rows.
- URL and Base64 public inputs are intentionally removed from this contract.

## Verified checks

| Check | Result |
| --- | --- |
| `npm run check:all` | PASS |
| `npm run check:storage` | PASS (report-only orphan scan) |
| `npm test` | PASS |
| `npm --workspace apps/web exec next build` | PASS |
| `node --check` for touched JS modules | PASS |
| `node scripts/pdf-e2e.js "D:\\深入理解分布式系统 (唐伟志) (Z-Library) (1).pdf"` | PASS mechanical import/index/search; PDF text layer has visible Chinese mojibake (OCR is out of Sprint 2 scope) |

`check:all` covers fresh/repeatable migration and old-schema detection, chunking, material readers and integrity gates, API contracts, worker state transitions, indexing, reprocessing, rebuild, and retry behavior.

## Database and storage evidence

The experimental SQLite database was intentionally replaced according to the selected Q21-C policy:

```text
npm run db:recreate -- --confirm D:\MyKnow\data\myknow.db
{"database":"D:\\MyKnow\\data\\myknow.db","schemaVersion":"sprint2-raw-v4","rawStoragePreserved":true}
```

The raw storage directory was preserved. `npm run check:storage` found 35 unreferenced files and did not delete them; they are report-only candidates for a later, explicit cleanup. A fresh empty database starts with the current schema and no derived rows.

## Deliberate boundaries

- No public URL fetching, SSRF surface, Base64 upload path, enterprise audit UI, or multi-user collaboration is included in this personal-knowledge-base scope.
- PDF parsing is best-effort through the existing MarkItDown adapter with a bounded literal fallback; unsupported or low-quality output fails without replacing an active index. MarkItDown PDF parsing has a configurable 120-second default timeout for large files.
- Orphan raw blobs are observable but not automatically removed.

The detailed request/response contract and resource/version/task state transitions are documented in [`docs/SPRINT2_RAW_SOURCE_CONTRACT.md`](../../docs/SPRINT2_RAW_SOURCE_CONTRACT.md).
The root-agent completion audit and focused bug fixes are recorded in [`sprint2-audit.md`](sprint2-audit.md).
