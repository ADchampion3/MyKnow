import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createDatabase } from "@myknow/db";

const port = 3032;
const databaseFile = `apps/api/data/wiki-impact-${process.pid}.db`;
const storage = `data/wiki-impact-storage-${process.pid}`;
fs.mkdirSync("apps/api/data", { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const env = { ...process.env, API_PORT: String(port), DATABASE_URL: `file:./${databaseFile}`, RESOURCE_STORAGE_DIR: storage, WORKER_POLL_INTERVAL_MS: "100" };
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
const worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json" };
const request = async (path, options) => { const response = await fetch(base + path, options); const body = response.status === 204 ? {} : await response.json(); return { response, body }; };
const json = (value) => JSON.stringify(value);
const waitForHealth = async () => { for (let i = 0; i < 200; i += 1) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("API did not start"); };
const waitFor = async (check, label) => { for (let i = 0; i < 300; i += 1) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`timed out waiting for ${label}`); };

try {
  await waitForHealth();
  const kb = await request("/api/knowledge-bases", { method: "POST", headers, body: json({ name: "Impact KB" }) });
  assert.equal(kb.response.status, 201);
  const kbId = kb.body.data.id;
  const resource = await request("/api/resources", { method: "POST", headers, body: json({ name: "impact.md", content: "Stable source version", knowledgeBaseId: kbId }) });
  assert.equal(resource.response.status, 201);
  const versionId = resource.body.data.version.id;
  const page = await request(`/api/knowledge-bases/${kbId}/wiki/pages`, { method: "POST", headers, body: json({ title: "Valid citation", pageType: "concept", contentMarkdown: "# Valid\n\nSource", citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 6 } }] }) });
  assert.equal(page.response.status, 201);
  const brokenPage = await request(`/api/knowledge-bases/${kbId}/wiki/pages`, { method: "POST", headers, body: json({ title: "Broken citation", pageType: "concept", contentMarkdown: "# Broken\n\nSource", citations: [{ resourceVersionId: versionId, locator: { chunkId: "00000000-0000-0000-0000-000000000000" } }] }) });
  assert.equal(brokenPage.response.status, 201);
  await waitFor(async () => (await request(`/api/resources/${resource.body.data.resource.id}`)).body.data.currentVersion?.id === versionId, "initial resource index");
  const before = await waitFor(async () => { const result = await request(`/api/knowledge-bases/${kbId}/wiki/impacts`); return result.body.data.items.length === 1 ? result : null; }, "initial impact scan");
  assert.equal(before.body.data.items[0].status, "broken");
  const next = await request(`/api/resources/${resource.body.data.resource.id}/versions`, { method: "POST", headers, body: json({ content: "New source version" }) });
  assert.equal(next.response.status, 201);
  const nextVersionId = next.body.data.version.id;
  await waitFor(async () => (await request(`/api/resources/${resource.body.data.resource.id}`)).body.data.currentVersion?.id === nextVersionId, "new resource index");
  const impacts = await waitFor(async () => { const result = await request(`/api/knowledge-bases/${kbId}/wiki/impacts`); return result.body.data.items.length === 2 ? result.body.data : null; }, "impact scan");
  assert.deepEqual(new Set(impacts.items.map((item) => item.status)), new Set(["needs_review", "broken"]));
  const database = createDatabase(`file:${databaseFile}`);
  const scanTasks = database.sqlite.prepare("SELECT status FROM tasks WHERE type='wiki:impact-scan' ORDER BY created_at,id").all();
  assert.ok(scanTasks.length >= 2);
  assert.ok(scanTasks.every((task) => task.status === "succeeded"));
  const scanAudits = database.sqlite.prepare("SELECT count(*) AS count FROM audit_logs WHERE event_type='impact_scanned'").get().count;
  assert.ok(scanAudits >= 2);
  database.sqlite.close();
  console.log(JSON.stringify({ status: "passed", impacts: impacts.items.map((item) => item.status), scanTasks: scanTasks.length, scanAudits }));
} finally {
  api.kill();
  worker.kill();
}
