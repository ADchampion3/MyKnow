import assert from "node:assert/strict";
import { deriveCanonicalArtifact, normalizeOcrProcessingRequest } from "@myknow/db";

assert.deepEqual(normalizeOcrProcessingRequest({ ocrMode: "force", ocrProvider: "local" }, { isPdf: true }), {
  mode: "force",
  provider: "local",
  capabilities: { text: true, table: true, formula: true }
});
assert.throws(() => normalizeOcrProcessingRequest({ ocrMode: "auto" }, { isPdf: true }), (caught) => caught.code === "OCR_PROVIDER_REQUIRED");
assert.equal(normalizeOcrProcessingRequest({ ocrMode: "force", ocrProvider: "paddleocr" }, { isPdf: true }).provider, "paddleocr");
assert.throws(() => normalizeOcrProcessingRequest({ ocrMode: "force", ocrProvider: "unknown" }, { isPdf: true }), (caught) => caught.code === "OCR_PROVIDER_INVALID");

const artifact = deriveCanonicalArtifact({
  pages: [
    { pageNumber: 1, status: "succeeded", blocks: [{ kind: "text", order: 0, text: "中文 English" }] },
    { pageNumber: 2, status: "succeeded", blocks: [
      { kind: "table", order: 0, text: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
      { kind: "formula", order: 1, text: "\\sum_{i=1}^{n} i" }
    ] }
  ],
  capabilities: { text: true, table: true, formula: true }
});
assert.match(artifact.canonicalText, /<!-- page:1 -->/);
assert.match(artifact.canonicalText, /<!-- page:2 -->/);
assert.equal(artifact.pages[1].blocks[0].kind, "table");
assert.equal(artifact.pages[1].blocks[1].kind, "formula");
assert.equal(artifact.pages[1].blocks[1].pageNumber, 2);
assert.ok(artifact.blocks.every((block) => Number.isInteger(block.pageNumber)));

console.log("OCR contract self-check passed");
