import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const port = 3021;
const database = `file:./apps/api/data/contract-check-${process.pid}.db`;
const databaseFile = database.slice(5).replaceAll('/', '\\');
fs.mkdirSync("apps/api/data", { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "a"));
const child = spawn(process.execPath, ["apps/api/src/nest.js"], { env: { ...process.env, API_PORT: String(port), DATABASE_URL: database }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const request = async (path, options) => { const response = await fetch(base + path, options); const body = await response.json(); return { response, body }; };
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  const health = await request("/health"); assert.equal(health.response.status, 200);
  const cors = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3003" } }); assert.equal(cors.headers.get("access-control-allow-origin"), "http://localhost:3003");
  const invalid = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) }); assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  const created = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Contract KB" }) }); assert.equal(created.response.status, 201);
  const configured = await request(`/api/knowledge-bases/${created.body.data.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ chunkingConfig: { parentChunkSize: 2048, childChunkSize: 256, childOverlap: 40 } }) }); assert.equal(configured.response.status, 200); assert.equal(JSON.parse(configured.body.data.chunkingConfig).childChunkSize, 256);
  const duplicate = await request("/api/knowledge-bases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Contract KB" }) }); assert.equal(duplicate.body.error.code, "DUPLICATE_NAME");
  const imported = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "notes.md", mimeType: "text/markdown", contentBase64: Buffer.from("# Contract\nSearchable content").toString("base64"), knowledgeBaseId: created.body.data.id }) }); assert.equal(imported.response.status, 201); assert.equal(imported.body.data.resource.status, "pending");
  const preview = await request(`/api/resources/${imported.body.data.resource.id}/chunk-preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# Preview\n\nOne deterministic paragraph." }) }); assert.equal(preview.response.status, 200); assert.ok(preview.body.data.children.length >= 1); assert.ok(preview.body.data.config.parentChunkSize > preview.body.data.config.childChunkSize);
  const downloaded = await fetch(`${base}/api/resources/${imported.body.data.resource.id}/versions/${imported.body.data.version.id}/download`); assert.equal(downloaded.status, 200); assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), "# Contract\nSearchable content");
  const importedAgain = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "copy.md", mimeType: "text/markdown", contentBase64: Buffer.from("# Contract\nSearchable content").toString("base64"), knowledgeBaseId: created.body.data.id }) }); assert.equal(importedAgain.body.data.duplicate, true);
  const page = await request(`/api/resources?knowledgeBaseId=${created.body.data.id}&page=1&limit=1&status=pending`); assert.equal(page.response.status, 200); assert.equal(page.body.data.length, 1);
  const badPage = await request(`/api/resources?knowledgeBaseId=${created.body.data.id}&limit=101`); assert.equal(badPage.body.error.code, "VALIDATION_ERROR");
  const invalidBase64 = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "invalid.md", mimeType: "text/markdown", contentBase64: "not base64", knowledgeBaseId: created.body.data.id }) }); assert.equal(invalidBase64.body.error.code, "VALIDATION_ERROR");
  const bothInputs = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "both.md", mimeType: "text/markdown", contentBase64: Buffer.from("x").toString("base64"), url: "https://example.com", knowledgeBaseId: created.body.data.id }) }); assert.equal(bothInputs.body.error.code, "VALIDATION_ERROR");
  const missingUpdate = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceId: crypto.randomUUID(), name: "missing.md", mimeType: "text/markdown", contentBase64: Buffer.from("x").toString("base64"), knowledgeBaseId: created.body.data.id }) }); assert.equal(missingUpdate.response.status, 404); assert.equal(missingUpdate.body.error.code, "NOT_FOUND");
  const missingKb = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "missing-kb.md", mimeType: "text/markdown", contentBase64: Buffer.from("x").toString("base64"), knowledgeBaseId: crypto.randomUUID() }) }); assert.equal(missingKb.response.status, 404); assert.equal(missingKb.body.error.code, "NOT_FOUND");
  const blockedUrl = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "blocked", url: "http://127.0.0.1/private", knowledgeBaseId: created.body.data.id }) }); assert.equal(blockedUrl.body.error.code, "SSRF_BLOCKED");
  const blockedIpv6 = await request("/api/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "blocked-ipv6", url: "http://[::1]/private", knowledgeBaseId: created.body.data.id }) }); assert.equal(blockedIpv6.body.error.code, "SSRF_BLOCKED");
  const escapedSearch = await request(`/api/search?q=${encodeURIComponent('"')}&knowledgeBaseId=${created.body.data.id}`); assert.equal(escapedSearch.response.status, 200); assert.deepEqual(escapedSearch.body.data, []);
  const task = await request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "bad" }) }); assert.equal(task.body.error.code, "VALIDATION_ERROR");
  console.log("api contract self-check passed");
} finally { child.kill(); }
