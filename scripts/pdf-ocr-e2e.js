process.env.PDF_E2E_EVIDENCE_ROOT = process.env.PDF_E2E_EVIDENCE_ROOT || "artifacts/sprint2";
process.env.PDF_E2E_OCR_MODE = process.env.PDF_E2E_OCR_MODE || "auto";
process.env.PDF_E2E_OCR_PROVIDER = process.env.PDF_E2E_OCR_PROVIDER || "local";
await import("./pdf-e2e.js");
