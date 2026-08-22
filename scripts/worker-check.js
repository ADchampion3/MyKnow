import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import fs from "node:fs";

const port = 3022;
const databasePath = `apps/api/data/worker-contract-${process.pid}.db`;
fs.mkdirSync("apps/api/data", { recursive: true });
fs.closeSync(fs.openSync(databasePath, "a"));
const env = { ...process.env, API_PORT: String(port), DATABASE_URL: "file:./" + databasePath, WORKER_POLL_INTERVAL_MS: "50" };
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
let worker;
const base = `http://127.0.0.1:${port}`;
const postTask = async (type) => (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) })).json();
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  const interrupted = await postTask("demo_success");
  const setup = new Database(databasePath); const interruptedAt = new Date().toISOString();
  setup.prepare("UPDATE tasks SET status='running',worker_id='dead-worker',started_at=?,updated_at=? WHERE id=?").run(interruptedAt, interruptedAt, interrupted.data.id);
  setup.prepare("INSERT INTO task_attempts (id,task_id,attempt_number,status,worker_id,started_at) VALUES (?,?,1,'running','dead-worker',?)").run(crypto.randomUUID(), interrupted.data.id, interruptedAt);
  setup.close();
  worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
  const success = await postTask("demo_success");
  const failure = await postTask("demo_failure");
  const kb = await (await fetch(`${base}/api/knowledge-bases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Worker KB" }) })).json();
  const sourceText = "# Worker\n\nraretermxyz appears once " + "context ".repeat(1800);
  const imported = await (await fetch(`${base}/api/resources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "worker.md", mimeType: "text/markdown", contentBase64: Buffer.from(sourceText).toString("base64"), knowledgeBaseId: kb.data.id }) })).json();
  const read = async (id) => (await (await fetch(`${base}/api/tasks/${id}`)).json()).data;
  for (let i = 0; i < 100; i += 1) { const states = [await read(interrupted.data.id), await read(success.data.id), await read(failure.data.id)]; if (states.every((task) => ["succeeded", "failed"].includes(task.status))) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal((await read(interrupted.data.id)).status, "succeeded");
  assert.equal((await read(success.data.id)).status, "succeeded");
  const failedTask = await read(failure.data.id);
  assert.equal(failedTask.status, "failed");
  assert.equal(failedTask.retryCount, failedTask.retryLimit + 1);
  const resource = async () => (await (await fetch(`${base}/api/resources/${imported.data.resource.id}`)).json()).data;
  for (let i = 0; i < 100; i += 1) { if ((await resource()).status === "indexed") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal((await resource()).status, "indexed");
  const search = await (await fetch(`${base}/api/search?q=raretermxyz&knowledgeBaseId=${kb.data.id}`)).json();
  assert.equal(search.data.length, 1);
  assert.equal(search.data[0].chunk_type, "text");
  assert.ok(search.data[0].parent_content);
  const runs = await (await fetch(`${base}/api/resources/${imported.data.resource.id}/processing-runs`)).json();
  assert.equal(runs.data.length, 1);
  assert.equal(runs.data[0].status, "indexed");
  const artifact = await (await fetch(`${base}/api/resources/${imported.data.resource.id}/processing-runs/${runs.data[0].id}/canonical`)).json();
  assert.equal(artifact.data.resourceVersionId, imported.data.version.id);
  assert.ok(artifact.data.blocks.length >= 1);
  const reindexTaskId = crypto.randomUUID(); const reindexDb = new Database(databasePath); const reindexAt = new Date().toISOString();
  reindexDb.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'queued',0,3,0,?,?)").run(reindexTaskId, "resource:process", JSON.stringify({ resourceVersionId: imported.data.version.id }), reindexAt, reindexAt); reindexDb.close();
  for (let i = 0; i < 100; i += 1) { if ((await read(reindexTaskId)).status === "succeeded") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal((await read(reindexTaskId)).status, "succeeded");
  const rebuild = await (await fetch(`${base}/api/resources/rebuild`, { method: "POST" })).json();
  assert.equal(rebuild.data.mode, "full-rebuild");
  assert.ok(rebuild.data.queued >= 1);
  for (let i = 0; i < 100; i += 1) { if ((await resource()).status === "indexed") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal((await resource()).status, "indexed");
  const retryLimit = await (await fetch(`${base}/api/tasks/${failure.data.id}/retry`, { method: "POST" })).json();
  assert.equal(retryLimit.error.code, "TASK_RETRY_LIMIT");
  const sqlite = new Database(databasePath);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM task_attempts").get().n >= 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?").get(interrupted.data.id).n, 2);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=? AND status='failed'").get(failure.data.id).n >= 2);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type='task'").get().n >= 4);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE resource_version_id=? AND chunk_type='parent_text' AND status='active'").get(imported.data.version.id).n >= 1);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE resource_version_id=? AND chunk_type='text' AND parent_chunk_id IS NOT NULL AND status='active'").get(imported.data.version.id).n >= 1);
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE resource_version_id=? AND status='superseded'").get(imported.data.version.id).n >= 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM resource_fts").get().n, sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE resource_version_id=? AND chunk_type='text' AND status='active'").get(imported.data.version.id).n);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM processing_runs WHERE resource_version_id=?").get(imported.data.version.id).n, 3);
  sqlite.close();
  console.log("worker contract self-check passed");
} finally { api.kill(); worker?.kill(); }
