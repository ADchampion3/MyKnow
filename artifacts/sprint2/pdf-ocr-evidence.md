# Sprint 2 PDF OCR focused evidence

- Date: 2026-08-24
- Environment: Node.js package workspace; `.venv-pdf` local PDF environment; Windows PowerShell
- Schema: `sprint2-pdf-ocr-v2`
- Deterministic command: `npm run check:ocr`
- Result: PASS
- Regression command: `npm run check:all`
- Regression result: PASS

This is the current Sprint 2 OCR extension evidence. It is separate from the earlier raw-source baseline reports in this directory.

The check covers OCR request validation including `paddleocr`, `auto`/`off`/`force` reader semantics, page terminal status, page numbers, text/table/formula block structure, Markdown tables, LaTeX formulas, OCR-to-native fallback, cloud rendered-image input, PaddleOCR async job polling and bounded concurrency, task/processing-run persistence, page-aware chunk locators, child-only FTS, failed-run rollback, interrupted cancellation recovery, and source SHA-256 preservation. It uses injected adapters and no network or cloud credential.

Full-chain command for a real local fixture: `node scripts/pdf-ocr-e2e.js "D:\path\fixture.pdf"`. Its generated report is the authoritative run-specific evidence for task transitions, source digest round-trip, canonical page metadata, and search.

## Real PaddleOCR run

- Fixture: `D:\深入理解分布式系统 (唐伟志) (Z-Library) (1).pdf`
- Outcome: **PASS** (`force` + `paddleocr`)
- Report: [`pdf-e2e-36136-1787557382524.md`](pdf-e2e-36136-1787557382524.md)
- Source: 101,959,457 bytes; SHA-256 `9af31a0e98926aac52fa8fa8ce0aada3446a22a76c6c1c55eba5ff9c2ab3b318`
- Paddle request ID: `85277899891662848`; OCR duration: 56,046 ms
- OCR output: 315 succeeded pages, 315 blocks, 3,869 child chunks, 3,869 FTS rows
- Search and integrity: searchable token found; source download SHA-256 matched; foreign-key violations `0`
