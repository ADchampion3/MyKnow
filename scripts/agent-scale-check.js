import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "@myknow/db";

const port = Number(process.env.AGENT_SCALE_CHECK_PORT || 3224);
const databaseFile = path.resolve(`data/agent-scale-check-${process.pid}.db`);
const storageDir = path.resolve(`data/agent-scale-check-resources-${process.pid}`);
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const env = { ...process.env, API_PORT: String(port), DATABASE_URL: `file:${databaseFile}`, RESOURCE_STORAGE_DIR: storageDir, MODEL_PROVIDER: "mock", AI_EGRESS_MODE: "local_only", RETRIEVAL_VECTOR_ENABLED: "false", WORKER_POLL_INTERVAL_MS: "25" };
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
const worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const request = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  return { response, body };
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("API did not start");
};
const waitFor = async (callback, message) => {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

try {
  await waitForHealth();
  const kb = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `Agent scale ${process.pid}` }) });
  assert.equal(kb.response.status, 201);
  const resources = [];
  for (let index = 0; index < 10; index += 1) {
    const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": `scale-import-${index}` }, body: JSON.stringify({ name: `scale-${index}.md`, content: `Scale evidence ${index} is retained in the source version.`, knowledgeBaseId: kb.body.data.id }) });
    assert.equal(imported.response.status, 201);
    const versionId = imported.body.data.version.id;
    await waitFor(async () => {
      const current = await request(`/api/resources/${imported.body.data.resource.id}`);
      return current.body.data.currentVersion?.id === versionId && current.body.data.status === "indexed";
    }, `scale resource ${index + 1} did not index`);
    resources.push(versionId);
  }

  const createdRuns = [];
  for (let index = 0; index < resources.length; index += 1) {
    const created = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": `scale-run-${index}` }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [resources[index]], prompt: `scale-plan-2 organize material ${index}` }) });
    assert.equal(created.response.status, 202);
    createdRuns.push(created.body.data.agentRun.id);
  }
  const planItems = [];
  for (const runId of createdRuns) {
    const run = await waitFor(async () => {
      const current = await request(`/api/agent/runs/${runId}`);
      return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
    }, "scale organize run did not finish");
    assert.equal(run.status, "succeeded");
    const plan = await request(`/api/agent/runs/${runId}/plan`);
    assert.equal(plan.response.status, 200);
    assert.equal(plan.body.data.items.length, 2);
    planItems.push(...plan.body.data.items);
  }
  assert.equal(planItems.length, 20);
  assert.ok(planItems.every((item) => item.itemType === "page_create" && item.evidenceStatus === "used" && item.applicationStatus === "pending"));
  const before = await request(`/api/knowledge-bases/${kb.body.data.id}/wiki`);
  assert.equal(before.body.data.pageCount, 0);

  for (const item of planItems.slice(0, 14)) {
    const approved = await request(`/api/agent/plan-items/${item.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.data.applicationStatus, "applied");
  }
  for (const item of planItems.slice(14)) {
    const rejected = await request(`/api/agent/plan-items/${item.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "reject", reason: "scale sample rejection" }) });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.data.applicationStatus, "not_applicable");
  }
  const after = await request(`/api/knowledge-bases/${kb.body.data.id}/wiki`);
  assert.equal(after.body.data.pageCount, 14);
  const inspection = createDatabase(env.DATABASE_URL);
  const auditRows = inspection.sqlite.prepare("SELECT request_id FROM audit_logs WHERE entity_type='agent_plan_item' ORDER BY created_at,id").all();
  assert.ok(auditRows.length >= 20);
  assert.ok(auditRows.every((row) => row.request_id));
  inspection.sqlite.close();
  console.log(JSON.stringify({ status: "passed", materials: 10, recommendations: planItems.length, accepted: 14, rejected: 6, acceptanceRate: 0.7, wikiPagesBeforeReview: before.body.data.pageCount, wikiPagesAfterReview: after.body.data.pageCount, auditedDecisions: auditRows.length }));
} finally {
  api.kill();
  worker.kill();
  try { fs.rmSync(databaseFile, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-wal`, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-shm`, { force: true }); } catch {}
  try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch {}
}
