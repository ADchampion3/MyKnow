# Sprint 2 PDF OCR

This document records the PDF OCR extension delivered in Sprint 2. It extends the raw-source import, version, task, canonical-artifact, chunk, and FTS contracts; historical baseline reports remain unchanged.

PDF processing now stores the selected `ocrMode` (`auto`, `off`, or `force`) and `ocrProvider` (`local`, `cloud`, or `paddleocr`) on every PDF version. `auto` tries the selected OCR adapter first and then the existing native readers; `off` uses native readers; `force` fails the run when OCR fails. Provider selection is never changed by fallback or retry.

The OCR adapter receives a server-side source path, immutable source metadata, capabilities, limits, and an `AbortSignal`. It returns terminal pages and ordered `text`, `table`, or `formula` blocks. Tables use GFM Markdown and formulas use LaTeX. The Worker derives a page-marked canonical text artifact, keeps page/block metadata in the artifact, adds page ranges to chunk locators, and activates it through the existing child-only FTS build-then-swap path.

The current empty-database schema is `sprint2-pdf-ocr-v2`. Older SQLite files are rejected with `DATABASE_RECREATE_REQUIRED`; recreate the exact database file while preserving the raw storage directory.

## Provider SPI

The OCR seam is a runtime interface, not a factory-function table. Because this repository is plain JavaScript, `OcrProviderAdapter` is an abstract base class that defines the SPI contract: Provider identity, adapter/model version, declared capabilities, and one `process(request)` method. The request contains the validated server-side PDF path, immutable source metadata, selected mode/Provider, capabilities, limits, `AbortSignal`, and page-progress callback.

`LocalOcrProviderAdapter`, `CloudOcrProviderAdapter`, `PaddleOcrProviderAdapter`, and `MockOcrProviderAdapter` are separate implementations. `OcrProviderRegistry` registers implementations by Provider key and resolves the selected implementation. A future vendor integration adds a class extending `OcrProviderAdapter` and registers an instance at the Worker composition root; `MaterialReader` remains unchanged and knows only the interface and registry.

## Local setup

```powershell
uv venv .venv-pdf --python 3.11
.\scripts\install-pdf-ocr.ps1
```

Image-only local OCR additionally requires a Tesseract executable and `chi_sim`/`eng` language data. If it is absent, the local adapter returns an explicit `OCR_PROVIDER_UNAVAILABLE`; `auto` may use native fallback and `force` fails.

The generic cloud adapter receives rendered PNG page paths only. `MODEL_API_KEY`, if configured, remains in the Worker environment and is never placed in task DTOs, canonical artifacts, audit metadata, or logs.

`PaddleOcrProviderAdapter` uses the PaddleOCR async job protocol: it uploads the server-side PDF as multipart form data, polls the returned job until `done`/`failed`, downloads the JSONL result, and maps each `layoutParsingResults` item to an ordered page text block. The Paddle token is read only from `PADDLE_OCR_TOKEN`; it is never hard-coded or serialized. `PADDLE_OCR_MAX_CONCURRENCY` bounds active Paddle jobs per Worker process (default `1`), while polling for each job remains sequential and cancellation-aware. Paddle's returned Markdown image references are retained as references; image asset persistence is outside this slice.

## Checks and evidence

```powershell
npm run check:ocr
npm run check:db
npm run check:api
npm run check:worker
node scripts/pdf-ocr-e2e.js "D:\path\fixture.pdf"
```

The focused checks use local fixtures and injected mock adapters; the full-chain command uses an isolated database and storage directory and records a timestamped report under `artifacts/sprint2/`. The report includes task transitions, selected processing settings, attempts, page/block counts, canonical/search details, source SHA-256, and rollback-relevant database invariants.

The deterministic adapter check is intentionally separate from real cloud credentials. A manual generic cloud run can use `PDF_E2E_OCR_PROVIDER=cloud` and a server-side `MODEL_API_BASE_URL`; a PaddleOCR run uses `PDF_E2E_OCR_PROVIDER=paddleocr` with `PADDLE_OCR_TOKEN` and is not part of the default automated suite.

Example PowerShell setup for a manual PaddleOCR run (use a newly issued token in the server environment):

```powershell
$env:PADDLE_OCR_TOKEN = "<server-side-token>"
$env:PADDLE_OCR_MAX_CONCURRENCY = "1"
$env:PDF_E2E_OCR_PROVIDER = "paddleocr"
$env:PDF_E2E_OCR_MODE = "force"
$env:PDF_E2E_PARSER_TIMEOUT_MS = "600000"
$env:PDF_E2E_TASK_TIMEOUT_MS = "720000"
node scripts/pdf-ocr-e2e.js "D:\path\fixture.pdf"
```
