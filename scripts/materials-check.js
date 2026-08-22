import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistBytes, sha256 } from "@myknow/db";
import { createMaterialReader } from "../apps/worker/src/materials.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-material-"));
try {
  const bytes = Buffer.from("标题 😀\r\n\r\n正文");
  const storageKey = "files/sample.md";
  persistBytes(root, storageKey, bytes);
  const attempts = [];
  const reader = createMaterialReader({ resourceStorageDir: root, resourceMaxBytes: 2_000_000 });
  const result = await reader.read({ mime_type: "text/markdown", storage_key: storageKey, content_sha256: sha256(bytes), byte_size: bytes.length }, {
    start: async (candidate) => { attempts.push({ name: candidate.name, status: "running" }); return attempts.length - 1; },
    success: async (attemptId, parsed) => { attempts[attemptId].status = "succeeded"; attempts[attemptId].quality = parsed.quality; },
    failure: async (attemptId) => { attempts[attemptId].status = "failed"; }
  });
  assert.equal(result.canonicalText, "标题 😀\n\n正文");
  assert.equal(result.parserName, "utf8");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "succeeded");
  await assert.rejects(() => reader.read({ mime_type: "text/markdown", storage_key: storageKey, content_sha256: sha256(Buffer.from("bad")), byte_size: bytes.length }), /integrity/);
  console.log("material reader self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
