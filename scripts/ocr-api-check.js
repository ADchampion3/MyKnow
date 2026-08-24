import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";

const port = 3033;
const database = `file:./apps/api/data/ocr-contract-${process.pid}.db`;
const databaseFile = database.slice(5).replaceAll("/", "\\");
fs.mkdirSync("apps/api/data", { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const child = spawn(process.execPath, ["apps/api/src/nest.js"], { env: { ...process.env, API_PORT: String(port), DATABASE_URL: database, MODEL_API_KEY: "server-secret-not-for-dto" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const request = async (route, options) => { const response = await fetch(base + route, options); return { response, body: response.status === 204 ? {} : await response.json() }; };
const json = (value) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
try {
  for (let attempt = 0; attempt < 200; attempt += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); }
  const kb = await request("/api/knowledge-bases", json({ name: "OCR API KB" }));
  const form = (mode, provider) => { const value = new FormData(); value.set("name", "scan.pdf"); value.set("knowledgeBaseId", kb.body.data.id); value.set("file", new Blob(["%PDF fixture"], { type: "application/pdf" }), "scan.pdf"); if (mode) value.set("ocrMode", mode); if (provider) value.set("ocrProvider", provider); return value; };
  const missingProvider = await request("/api/resources", { method: "POST", body: form("off") });
  assert.equal(missingProvider.response.status, 400);
  assert.equal(missingProvider.body.error.code, "OCR_PROVIDER_REQUIRED");
  const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "ocr-api-1" }, body: form("off", "local") });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.data.version.ocr_mode, "off");
  assert.equal(imported.body.data.version.ocr_provider, "local");
  assert.deepEqual(imported.body.data.task.processingRequest, { mode: "off", provider: "local", capabilities: { text: true, table: false, formula: false } });
  assert.equal("payload" in imported.body.data.task, false);
  assert.equal(JSON.stringify(imported.body).includes("server-secret"), false);
  const cancelled = await request(`/api/tasks/${imported.body.data.task.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.response.status, 202);
  assert.equal(cancelled.body.data.error_code, "TASK_CANCELLED");
  const conflict = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "ocr-api-1" }, body: form("force", "local") });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const reprocess = await request(`/api/resources/${imported.body.data.resource.id}/reprocess`, { ...json({ versionId: imported.body.data.version.id, ocrMode: "force", ocrProvider: "paddleocr" }), headers: { "content-type": "application/json", "idempotency-key": "ocr-reprocess-1" } });
  assert.equal(reprocess.response.status, 202, JSON.stringify(reprocess.body));
  assert.equal(reprocess.body.data.processingRequest.provider, "paddleocr");
  const reprocessConflict = await request(`/api/resources/${imported.body.data.resource.id}/reprocess`, { ...json({ versionId: imported.body.data.version.id, ocrMode: "force", ocrProvider: "local" }), headers: { "content-type": "application/json", "idempotency-key": "ocr-reprocess-1" } });
  assert.equal(reprocessConflict.response.status, 409);
  assert.equal(reprocessConflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const version = await request(`/api/resources/${imported.body.data.resource.id}/versions/${imported.body.data.version.id}`);
  assert.equal(version.body.data.ocr_mode, "force");
  assert.equal(version.body.data.ocr_provider, "paddleocr");
  console.log("OCR API contract self-check passed");
} finally {
  child.kill();
}
