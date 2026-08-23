import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";

const port = 3021;
const database = `file:./apps/api/data/contract-check-${process.pid}.db`;
const databaseFile = database.slice(5).replaceAll('/', '\\');
fs.mkdirSync("apps/api/data", { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const child = spawn(process.execPath, ["apps/api/src/nest.js"], { env: { ...process.env, API_PORT: String(port), DATABASE_URL: database }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const request = async (path, options) => { const response = await fetch(base + path, options); const body = response.status === 204 ? {} : await response.json(); return { response, body }; };
const waitForHealth = async () => { for (let i = 0; i < 200; i += 1) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("API did not start"); };
const noStorageKeys = (value) => !/storage_key|canonical_storage_key|source_url/.test(JSON.stringify(value));

try {
  await waitForHealth();
  const health = await request("/health"); assert.equal(health.response.status, 200);
  const cors = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3003" } }); assert.equal(cors.headers.get("access-control-allow-origin"), "http://localhost:3003");
  const invalid = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) }); assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  const invalidChunkingConfig = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Invalid config", chunkingConfig: [] }) }); assert.equal(invalidChunkingConfig.body.error.code, "VALIDATION_ERROR");
  const created = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Contract KB" }) }); assert.equal(created.response.status, 201);
  const imported = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "contract-import-1" }, body: JSON.stringify({ name: "notes.md", content: "# Contract\nSearchable content", knowledgeBaseId: created.body.data.id }) });
  assert.equal(imported.response.status, 201); assert.equal(imported.body.data.resource.status, "pending"); assert.equal(imported.body.data.version.source_type, undefined); assert.equal(noStorageKeys(imported.body.data), true);
  const idempotent = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "contract-import-1" }, body: JSON.stringify({ name: "notes.md", content: "# Contract\nSearchable content", knowledgeBaseId: created.body.data.id }) });
  assert.equal(idempotent.response.status, 200); assert.equal(idempotent.body.data.idempotent, true); assert.equal(idempotent.body.data.version.id, imported.body.data.version.id);
  const conflict = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "contract-import-1" }, body: JSON.stringify({ name: "different.md", content: "other", knowledgeBaseId: created.body.data.id }) }); assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const repeated = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "copy.md", content: "# Contract\nSearchable content", knowledgeBaseId: created.body.data.id }) }); assert.equal(repeated.response.status, 201); assert.notEqual(repeated.body.data.version.id, imported.body.data.version.id); assert.notEqual(repeated.body.data.resource.id, imported.body.data.resource.id);
  const form = new FormData(); form.set("name", "upload.txt"); form.set("knowledgeBaseId", created.body.data.id); form.set("file", new Blob(["multipart text"], { type: "text/plain" }), "upload.txt");
  const multipart = await request("/api/resources", { method: "POST", body: form }); assert.equal(multipart.response.status, 201); assert.equal(multipart.body.data.version.mime_type, "text/plain");
  const boundary = "MyKnowBoundary";
  const boundaryBytes = Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(`binary\r\n--${boundary}NOT-A-DELIMITER\r\n`), Buffer.from([2, 3, 4])]);
  const boundaryBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nboundary.txt\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="knowledgeBaseId"\r\n\r\n${created.body.data.id}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boundary.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    boundaryBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const boundaryUpload = await request("/api/resources", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: boundaryBody });
  assert.equal(boundaryUpload.response.status, 201); assert.equal(boundaryUpload.body.data.version.byte_size, boundaryBytes.length);
  const boundaryDownload = await fetch(`${base}/api/resources/${boundaryUpload.body.data.resource.id}/versions/${boundaryUpload.body.data.version.id}/download`); assert.deepEqual(Buffer.from(await boundaryDownload.arrayBuffer()), boundaryBytes);
  const newVersion = await request(`/api/resources/${imported.body.data.resource.id}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new version" }) }); assert.equal(newVersion.response.status, 201); assert.equal(newVersion.body.data.version.resource_id, imported.body.data.resource.id);
  const invalidKnowledgeBase = await request(`/api/resources/${imported.body.data.resource.id}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "bad version", knowledgeBaseId: {} }) }); assert.equal(invalidKnowledgeBase.body.error.code, "VALIDATION_ERROR");
  const invalidRetry = await request(`/api/resources/${imported.body.data.resource.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: imported.body.data.version.id }) }); assert.equal(invalidRetry.body.error.code, "INVALID_STATE_TRANSITION");
  const punctuationSearch = await request(`/api/search?q=${encodeURIComponent('"')}&knowledgeBaseId=${created.body.data.id}`); assert.equal(punctuationSearch.response.status, 200);
  const preview = await request(`/api/resources/${imported.body.data.resource.id}/chunk-preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# Preview\n\nOne deterministic paragraph." }) }); assert.equal(preview.response.status, 200); assert.ok(preview.body.data.children.length >= 1);
  const downloaded = await fetch(`${base}/api/resources/${imported.body.data.resource.id}/versions/${imported.body.data.version.id}/download`); assert.equal(downloaded.status, 200); assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), "# Contract\nSearchable content");
  const detail = await request(`/api/resources/${imported.body.data.resource.id}`); assert.equal(noStorageKeys(detail.body.data), true); assert.equal(detail.body.data.versions.length, 2);
  const renamed = await request(`/api/resources/${imported.body.data.resource.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "renamed" }) }); assert.equal(renamed.response.status, 200); assert.equal(renamed.body.data.name, "renamed");
  const oldContract = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "old.md", contentBase64: Buffer.from("old").toString("base64"), knowledgeBaseId: created.body.data.id }) }); assert.equal(oldContract.body.error.code, "VALIDATION_ERROR");
  const mixedBase64 = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mixed.md", content: "accepted text must not mask removed fields", contentBase64: Buffer.from("old").toString("base64"), knowledgeBaseId: created.body.data.id }) }); assert.equal(mixedBase64.body.error.code, "VALIDATION_ERROR");
  const url = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "url", url: "https://example.com", knowledgeBaseId: created.body.data.id }) }); assert.equal(url.body.error.code, "VALIDATION_ERROR");
  const mixedUrl = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mixed-url.md", content: "accepted text must not mask removed fields", url: "https://example.com", knowledgeBaseId: created.body.data.id }) }); assert.equal(mixedUrl.body.error.code, "VALIDATION_ERROR");
  const archived = await request(`/api/resources/${imported.body.data.resource.id}/archive`, { method: "POST" }); assert.equal(archived.response.status, 200); assert.equal(archived.body.data.status, "archived");
  const hidden = await request(`/api/resources?knowledgeBaseId=${created.body.data.id}`); assert.ok(!hidden.body.data.some((row) => row.id === imported.body.data.resource.id));
  const restored = await request(`/api/resources/${imported.body.data.resource.id}/restore`, { method: "POST" }); assert.equal(restored.response.status, 200); assert.notEqual(restored.body.data.status, "archived");
  const badPage = await request(`/api/resources?knowledgeBaseId=${created.body.data.id}&limit=101`); assert.equal(badPage.body.error.code, "VALIDATION_ERROR");
  const task = await request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "bad" }) }); assert.equal(task.body.error.code, "VALIDATION_ERROR");
  const demo = await request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "demo_success" }) }); const taskView = await request(`/api/tasks/${demo.body.data.id}`); assert.equal(taskView.body.data.payload, undefined);
  console.log("api contract self-check passed");
} finally { child.kill(); }
