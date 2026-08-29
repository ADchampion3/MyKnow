import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = 3222;
const databaseFile = path.resolve(`data/agent-review-check-${process.pid}.db`);
const storageDir = path.resolve(`data/agent-review-check-resources-${process.pid}`);
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const env = { ...process.env, API_PORT: String(port), DATABASE_URL: `file:${databaseFile}`, RESOURCE_STORAGE_DIR: storageDir, MODEL_PROVIDER: "mock", AI_EGRESS_MODE: "local_only", WORKER_POLL_INTERVAL_MS: "50" };
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
const worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const request = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  return { response, body };
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("API did not start");
};
const waitFor = async (callback, message) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

try {
  await waitForHealth();
  const kb = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `Review KB ${process.pid}` }) });
  assert.equal(kb.response.status, 201);
  const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "review-import-1" }, body: JSON.stringify({ name: "review.md", content: "Evidence that belongs in a source summary page.", knowledgeBaseId: kb.body.data.id }) });
  assert.equal(imported.response.status, 201);
  const versionId = imported.body.data.version.id;
  await waitFor(async () => (await request(`/api/resources/${imported.body.data.resource.id}`)).body.data.currentVersion?.id === versionId, "resource did not index");

  const created = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "review-run-1" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [versionId], prompt: "整理这份资料并提出一个可审核的 Wiki 页面。" }) });
  assert.equal(created.response.status, 202);
  const run = await waitFor(async () => {
    const current = await request(`/api/agent/runs/${created.body.data.agentRun.id}`);
    return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
  }, "organize run did not finish");
  assert.equal(run.status, "succeeded");
  const plan = await request(`/api/agent/runs/${run.id}/plan`);
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.data.items.length, 1);
  const item = plan.body.data.items[0];
  assert.equal(item.itemType, "page_create");
  assert.equal(item.reviewStatus, "proposed");
  assert.equal(item.applicationStatus, "pending");
  assert.equal(item.evidenceStatus, "used");
  const before = await request(`/api/knowledge-bases/${kb.body.data.id}/wiki`);
  assert.equal(before.body.data.pageCount, 0);

  const approved = await request(`/api/agent/plan-items/${item.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.applicationStatus, "applied");
  assert.ok(approved.body.data.targetPageId);
  const after = await request(`/api/wiki/pages/${approved.body.data.targetPageId}`);
  assert.equal(after.response.status, 200);
  assert.equal(after.body.data.status, "active");
  assert.ok(after.body.data.currentVersion.contentMarkdown.includes("Agent source summary"));
  const duplicateApproval = await request(`/api/agent/plan-items/${item.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(duplicateApproval.response.status, 409);
  assert.equal(duplicateApproval.body.error.code, "AGENT_REVIEW_CONFLICT");

  const rolledBack = await request(`/api/agent/plan-items/${item.id}/rollback`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(rolledBack.response.status, 200);
  assert.equal(rolledBack.body.data.applicationStatus, "rolled_back");
  const archived = await request(`/api/wiki/pages/${approved.body.data.targetPageId}`);
  assert.equal(archived.body.data.status, "archived");
  const idempotent = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "review-run-1" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [versionId], prompt: "整理这份资料并提出一个可审核的 Wiki 页面。" }) });
  assert.equal(idempotent.response.status, 200);
  assert.equal(idempotent.body.data.idempotent, true);
  console.log(JSON.stringify({ runId: run.id, itemType: item.itemType, evidenceStatus: item.evidenceStatus, applied: approved.body.data.applicationStatus, rollback: rolledBack.body.data.applicationStatus }));
} finally {
  api.kill();
  worker.kill();
  if (!process.env.KEEP_CHECK_ARTIFACTS) {
    try { fs.rmSync(databaseFile, { force: true }); } catch {}
    try { fs.rmSync(`${databaseFile}-wal`, { force: true }); } catch {}
    try { fs.rmSync(`${databaseFile}-shm`, { force: true }); } catch {}
    try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch {}
  }
}
