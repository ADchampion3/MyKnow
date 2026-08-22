# Material reader evidence — 2026-08-21

The Worker now exposes one reader seam and records every attempt in `processing_run_attempts`.

- UTF-8 Markdown/TXT: canonical text preserves line structure after CRLF normalization; source bytes remain immutable.
- PDF: MarkItDown is attempted first, then a deterministic basic-literal fallback; both outcomes pass the same quality gate before activation.
- Web URL: API and Worker perform SSRF validation; Worker accepts HTML semantics only, stores the response snapshot, extracts title/body text, and records parser identity.
- The local Worker contract verifies the UTF-8 path, processing run, canonical artifact, child-only FTS and parent context. Live URL/PDF fixtures remain explicitly unverified in the acceptance report.
