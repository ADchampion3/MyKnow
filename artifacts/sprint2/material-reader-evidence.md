# Material reader evidence — current Sprint 2 scope

Date: 2026-08-22

- UTF-8 Markdown/TXT: canonical text preserves line structure after CRLF normalization; source bytes remain immutable.
- PDF: MarkItDown is attempted first, then a deterministic basic-literal fallback; both outcomes pass the same quality gate before activation.
- PDF text-layer quality is best-effort: a visually readable PDF with broken/missing Unicode maps can still produce printable mojibake. OCR/VLM is intentionally outside Sprint 2; the full-chain PDF evidence records this limitation instead of claiming semantic fidelity.
- Every reader attempt is recorded in `processing_run_attempts`; parser identity and quality metadata are retained on the processing run.
- The local Worker contract verifies source-integrity checks, canonical artifacts, child-only FTS and parent context.

Remote URL fetching and HTML extraction were removed from the public contract rather than deferred; see [`docs/SPRINT2_RAW_SOURCE_CONTRACT.md`](../../docs/SPRINT2_RAW_SOURCE_CONTRACT.md).
