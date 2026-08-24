import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMaterialReader } from "../apps/worker/src/materials.js";
import { CloudOcrProviderAdapter, MockOcrProviderAdapter, OcrProviderAdapter, OcrProviderRegistry, PaddleOcrProviderAdapter } from "../apps/worker/src/ocr/adapter.js";
import { persistBytes, sha256 } from "@myknow/db";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-ocr-material-"));
const pdf = Buffer.from("%PDF-1.4\n(English 中文 OCR fixture with enough readable text) Tj\n%%EOF");
const storageKey = "blobs/sample.pdf";
persistBytes(root, storageKey, pdf);
const baseVersion = (mode, provider = "local") => ({ mime_type: "application/pdf", storage_key: storageKey, content_sha256: sha256(pdf), byte_size: pdf.length, ocr_mode: mode, ocr_provider: provider, ocr_capabilities: JSON.stringify({ text: true, table: true, formula: true }) });

try {
  const attempts = [];
  assert.throws(() => new OcrProviderAdapter({ provider: "invalid", name: "invalid", version: "1" }), TypeError);
  const localAdapter = new MockOcrProviderAdapter({ process: async () => ({ pages: [
    { pageNumber: 1, status: "succeeded", blocks: [{ kind: "text", order: 0, text: "中文 English" }] },
    { pageNumber: 2, status: "succeeded", blocks: [{ kind: "table", order: 0, text: "| A | B |\n| --- | --- |\n| 1 | 2 |" }, { kind: "formula", order: 1, text: "x^2" }] }
  ], capabilities: { text: true, table: true, formula: true } }) });
  assert.equal(new OcrProviderRegistry([localAdapter]).resolve("local"), localAdapter);
  const reader = createMaterialReader({
    resourceStorageDir: root,
    resourceMaxBytes: 2_000_000,
    resourceParserTimeoutMs: 10_000,
    ocrProviderRegistry: new OcrProviderRegistry([localAdapter])
  });
  const ocr = await reader.read(baseVersion("auto"), { start: async (candidate) => { attempts.push(candidate.name); return attempts.length - 1; } });
  assert.equal(attempts[0], "ocr-local-mock");
  assert.equal(ocr.pages.length, 2);
  assert.equal(ocr.blocks[1].kind, "table");
  assert.equal(ocr.blocks[2].kind, "formula");
  assert.match(ocr.canonicalText, /<!-- page:2 -->/);

  let fallbackCalls = 0;
  const fallbackReader = createMaterialReader({
    resourceStorageDir: root,
    resourceMaxBytes: 2_000_000,
    resourceParserTimeoutMs: 10_000,
    ocrProviderRegistry: new OcrProviderRegistry([new MockOcrProviderAdapter({ process: async () => { fallbackCalls += 1; throw Object.assign(new Error("fixture OCR failure"), { code: "OCR_FAILED" }); } })])
  });
  const fallbackAttempts = [];
  const fallback = await fallbackReader.read(baseVersion("auto"), { start: async (candidate) => { fallbackAttempts.push(candidate.name); return fallbackAttempts.length - 1; } });
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(fallbackAttempts, ["ocr-local-mock", "markitdown", "pdf-basic"]);
  assert.equal(fallback.parserName, "pdf-basic");

  const forceReader = createMaterialReader({
    resourceStorageDir: root,
    resourceMaxBytes: 2_000_000,
    resourceParserTimeoutMs: 10_000,
    ocrProviderRegistry: new OcrProviderRegistry([new MockOcrProviderAdapter({ process: async () => { throw Object.assign(new Error("fixture OCR failure"), { code: "OCR_FAILED" }); } })])
  });
  await assert.rejects(() => forceReader.read(baseVersion("force")), (caught) => caught.code === "OCR_FAILED");

  let cloudRequest;
  const imagePath = path.join(root, "page-1.png");
  fs.writeFileSync(imagePath, Buffer.from("rendered image"));
  const cloud = new CloudOcrProviderAdapter({
    renderPages: async () => ({ pages: [{ pageNumber: 1, path: imagePath }], cleanup: () => fs.rmSync(imagePath, { force: true }) }),
    recognize: async (value) => { cloudRequest = value; return { pages: [{ pageNumber: 1, status: "succeeded", blocks: [{ kind: "text", text: "cloud result" }] }], capabilities: { text: true, table: false, formula: false } }; }
  });
  await cloud.process({ sourcePath: path.join(root, "source.pdf"), provider: "cloud", capabilities: { text: true, table: false, formula: false }, limits: {} });
  assert.equal(cloudRequest.pageImages.length, 1);
  assert.equal(cloudRequest.pageImages[0].path, imagePath);
  assert.equal("sourceBytes" in cloudRequest, false);
  assert.equal(fs.existsSync(imagePath), false);

  const paddlePdf = path.join(root, "paddle.pdf");
  fs.writeFileSync(paddlePdf, Buffer.from("%PDF-1.4 paddle fixture"));
  const paddleEvents = [];
  const pollCounts = new Map();
  let paddleJobNumber = 0;
  const response = (body) => ({ ok: true, status: 200, text: async () => typeof body === "string" ? body : JSON.stringify(body) });
  const paddle = new PaddleOcrProviderAdapter({
    jobUrl: "https://paddle.test/api/v2/ocr/jobs",
    token: "fixture-token",
    maxConcurrency: 1,
    pollIntervalMs: 1,
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 0)),
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        const jobId = `job-${++paddleJobNumber}`;
        paddleEvents.push(`submitted:${jobId}`);
        return response({ data: { jobId } });
      }
      const jobMatch = url.match(/\/(job-\d+)$/u);
      if (jobMatch) {
        const jobId = jobMatch[1];
        const count = (pollCounts.get(jobId) || 0) + 1;
        pollCounts.set(jobId, count);
        if (count === 1) return response({ data: { state: "running", extractProgress: { totalPages: 1, extractedPages: 0 } } });
        return response({ data: { state: "done", resultUrl: { jsonUrl: `https://paddle.test/results/${jobId}.jsonl` } } });
      }
      const resultMatch = url.match(/\/(job-\d+)\.jsonl$/u);
      assert.ok(resultMatch);
      paddleEvents.push(`result:${resultMatch[1]}`);
      return response('{"result":{"layoutParsingResults":[{"markdown":{"text":"PaddleOCR fixture page"}}]}}\n');
    }
  });
  const paddleRequest = (sourcePath) => ({ sourcePath, source: { mimeType: "application/pdf", filename: "paddle.pdf" }, capabilities: { text: true, table: true, formula: true }, limits: { maxPages: 10, timeoutMs: 1000 } });
  const paddleResults = await Promise.all([paddle.process(paddleRequest(paddlePdf)), paddle.process(paddleRequest(paddlePdf))]);
  assert.equal(paddleResults.length, 2);
  assert.equal(paddleResults[0].pages[0].blocks[0].text, "PaddleOCR fixture page");
  assert.equal(paddleResults[0].metadata.provider, "paddleocr");
  assert.deepEqual(paddleEvents, ["submitted:job-1", "result:job-1", "submitted:job-2", "result:job-2"]);

  console.log("OCR material reader self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
