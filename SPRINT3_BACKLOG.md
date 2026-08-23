# Sprint 3 backlog from the current Sprint 2 boundary

These are intentionally outside the local single-user raw-source optimization and are not hidden acceptance debt:

- Run live HTTP/PDF/MarkItDown fixture suites only if a future product decision explicitly reintroduces remote or richer document inputs.
- Add the required 100 mixed-fixture stress run if performance evidence becomes a Sprint 3 goal.
- Add a documented FTS5 capability probe and `ponytail:` `LIKE` fallback if SQLite portability requires it.
- Replace single-worker startup recovery with a leased worker table before enabling multi-worker execution.
- Consider orphan-blob garbage collection only with an explicit retention/deletion policy; the current scan is report-only.
