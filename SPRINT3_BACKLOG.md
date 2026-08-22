# Sprint 3 backlog from Sprint 2 review

- Add a direct `multipart/form-data` file upload contract while retaining JSON imports for automation.
- Run live HTTP/HTTPS, text-PDF/MarkItDown, malformed-PDF, and oversized-response fixtures.
- Add the required 100 mixed import/retry run and commit `artifacts/sprint2/chunk-trace.jsonl` with at least 20 trace rows.
- Add an FTS5 capability probe with the documented `ponytail:` `LIKE` fallback when SQLite lacks FTS5.
- Replace single-worker startup recovery with a leased worker table before multi-worker execution.
