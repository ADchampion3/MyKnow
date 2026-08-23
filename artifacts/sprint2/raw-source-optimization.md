# Sprint 2 raw-source optimization evidence

Date: 2026-08-22

## Database replacement

Command:

```powershell
npm run db:recreate -- --confirm D:\MyKnow\data\myknow.db
```

Result: PASS. The exact SQLite file was recreated with schema `sprint2-raw-v4`; `data/resources` was not deleted.

## Runnable checks

| Command | Result |
| --- | --- |
| `npm run check:db` | PASS |
| `npm run check:chunker` | PASS |
| `npm run check:materials` | PASS |
| `npm run check:api` | PASS |
| `npm run check:worker` | PASS |
| `npm run check:all` | PASS |
| `npm run check:storage` | PASS (35 report-only orphans) |
| `npm test` | PASS |
| `npm --workspace apps/web exec next build` | PASS |
| `node --check` touched JS modules | PASS |

The API contract covers JSON text, multipart local files, optional idempotency keys, independent repeated versions, version creation, DTO redaction, controlled download integrity, archive/restore, and rejection of URL/Base64 input.

The Worker contract covers interrupted-task recovery, permanent versus transient failure, three total attempts, immutable version processing, current/history search isolation, successful and failed build-then-swap reprocessing, rebuild, invalid UTF-8 failure, and manual retry as a new task.

## Storage reconciliation

Command: `npm run check:storage`

Result: PASS as a report-only check. The fresh database has zero referenced blobs; the preserved storage directory reports 35 unreferenced files from the replaced database. No file was deleted.
