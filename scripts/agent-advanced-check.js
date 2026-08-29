import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "@myknow/db";

const port = Number(process.env.AGENT_ADVANCED_CHECK_PORT || 3225);
const databaseFile = path.resolve(`data/agent-advanced-check-${process.pid}.db`);
const storageDir = path.resolve(`data/agent-advanced-check-resources-${process.pid}`);
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
const finishRun = (runId) => waitFor(async () => {
  const current = await request(`/api/agent/runs/${runId}`);
  return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
}, "agent run did not finish");

try {
  await waitForHealth();
  const kb = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `Agent advanced ${process.pid}` }) });
  assert.equal(kb.response.status, 201);
  const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "advanced-import-1" }, body: JSON.stringify({ name: "advanced.md", content: "Advanced page update evidence source.", knowledgeBaseId: kb.body.data.id }) });
  assert.equal(imported.response.status, 201);
  const resourceVersionId = imported.body.data.version.id;
  await waitFor(async () => (await request(`/api/resources/${imported.body.data.resource.id}`)).body.data.status === "indexed", "advanced resource did not index");
  const conflictImported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "advanced-conflict-import" }, body: JSON.stringify({ name: "conflict.md", content: "Shared conflict evidence source.", knowledgeBaseId: kb.body.data.id }) });
  assert.equal(conflictImported.response.status, 201);
  const conflictResourceVersionId = conflictImported.body.data.version.id;
  await waitFor(async () => (await request(`/api/resources/${conflictImported.body.data.resource.id}`)).body.data.status === "indexed", "conflict resource did not index");
  const pageCreated = await request(`/api/knowledge-bases/${kb.body.data.id}/wiki/pages`, { method: "POST", body: JSON.stringify({ title: "Advanced target", pageType: "concept", contentMarkdown: "# Advanced target\n\nOriginal page." }) });
  assert.equal(pageCreated.response.status, 201);
  const pageId = pageCreated.body.data.id;
  const originalVersionId = pageCreated.body.data.currentVersion.id;
  const tagNames = ["reviewed", "approved"];
  for (const name of tagNames) {
    const tag = await request(`/api/knowledge-bases/${kb.body.data.id}/tags`, { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(tag.response.status, 201);
  }

  const updateCreated = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "advanced-update-1" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [resourceVersionId], wikiPageIds: [pageId], prompt: "Use advanced page update evidence source to update the selected page." }) });
  assert.equal(updateCreated.response.status, 202);
  const updateRun = await finishRun(updateCreated.body.data.agentRun.id);
  assert.equal(updateRun.status, "succeeded");
  const updatePlan = await request(`/api/agent/runs/${updateRun.id}/plan`);
  assert.equal(updatePlan.body.data.items.length, 1);
  const updateItem = updatePlan.body.data.items[0];
  assert.equal(updateItem.itemType, "page_update");
  assert.equal(updateItem.risk, "high");
  assert.equal(updateItem.basePageVersionId, originalVersionId);
  assert.equal(updateItem.evidenceStatus, "used");
  assert.ok(updateItem.diff?.lines?.length);
  const appliedUpdate = await request(`/api/agent/plan-items/${updateItem.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(appliedUpdate.response.status, 200);
  assert.equal(appliedUpdate.body.data.applicationStatus, "applied");
  const updatedPage = await request(`/api/wiki/pages/${pageId}`);
  assert.ok(updatedPage.body.data.currentVersion.contentMarkdown.includes("Advanced page update evidence source."));
  const rolledBackUpdate = await request(`/api/agent/plan-items/${updateItem.id}/rollback`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(rolledBackUpdate.response.status, 200);
  assert.equal(rolledBackUpdate.body.data.applicationStatus, "rolled_back");
  const restoredPage = await request(`/api/wiki/pages/${pageId}`);
  assert.equal(restoredPage.body.data.currentVersion.contentMarkdown, "# Advanced target\n\nOriginal page.");

  const driftCreated = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "advanced-update-2" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [resourceVersionId], wikiPageIds: [pageId], prompt: "Use advanced page update evidence source to update the selected page again." }) });
  assert.equal(driftCreated.response.status, 202);
  const driftRun = await finishRun(driftCreated.body.data.agentRun.id);
  const driftPlan = await request(`/api/agent/runs/${driftRun.id}/plan`);
  const driftItem = driftPlan.body.data.items[0];
  const appliedDrift = await request(`/api/agent/plan-items/${driftItem.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(appliedDrift.body.data.applicationStatus, "applied");
  const driftedPage = await request(`/api/wiki/pages/${pageId}`);
  const manualVersion = await request(`/api/wiki/pages/${pageId}/versions`, { method: "POST", body: JSON.stringify({ baseVersionId: driftedPage.body.data.currentVersion.id, contentMarkdown: "# Manual drift\n\nA human changed this page." }) });
  assert.equal(manualVersion.response.status, 201);
  const staleRollback = await request(`/api/agent/plan-items/${driftItem.id}/rollback`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(staleRollback.response.status, 409);
  assert.equal(staleRollback.body.error.code, "AGENT_ROLLBACK_CONFLICT");

  const conflictRunCreated = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "advanced-conflict-1" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [resourceVersionId, conflictResourceVersionId], prompt: "conflict-plan shared evidence" }) });
  assert.equal(conflictRunCreated.response.status, 202);
  const conflictRun = await finishRun(conflictRunCreated.body.data.agentRun.id);
  const conflictPlan = await request(`/api/agent/runs/${conflictRun.id}/plan`);
  assert.equal(conflictPlan.body.data.items.length, 1);
  assert.equal(conflictPlan.body.data.items[0].itemType, "conflict_finding");
  assert.equal(conflictPlan.body.data.items[0].citations.length, 2);
  const conflictApproved = await request(`/api/agent/plan-items/${conflictPlan.body.data.items[0].id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(conflictApproved.response.status, 200);
  assert.equal(conflictApproved.body.data.applicationStatus, "not_applicable");

  const tagRunCreated = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": "advanced-tags-1" }, body: JSON.stringify({ kind: "organize", knowledgeBaseId: kb.body.data.id, resourceVersionIds: [resourceVersionId], wikiPageIds: [pageId], prompt: "tag-plan tag-batch add reviewed and approved" }) });
  assert.equal(tagRunCreated.response.status, 202);
  const tagRun = await finishRun(tagRunCreated.body.data.agentRun.id);
  const tagPlan = await request(`/api/agent/runs/${tagRun.id}/plan`);
  assert.equal(tagPlan.body.data.items.length, 2);
  assert.ok(tagPlan.body.data.items.every((item) => item.itemType === "tag_add" && item.evidenceStatus === "not_applicable"));
  const tagIds = tagPlan.body.data.items.map((item) => item.id);
  const batch = await request("/api/agent/plan-items/batch-decision", { method: "POST", body: JSON.stringify({ itemIds: tagIds }) });
  assert.equal(batch.response.status, 200);
  assert.ok(batch.body.data.items.every((item) => item.applicationStatus === "applied"));
  const inspection = createDatabase(env.DATABASE_URL);
  assert.equal(inspection.sqlite.prepare("SELECT count(*) AS count FROM wiki_page_tags WHERE page_id=?").get(pageId).count, 2);
  inspection.sqlite.close();
  const rolledBackTag = await request(`/api/agent/plan-items/${tagIds[0]}/rollback`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(rolledBackTag.response.status, 200);
  const afterTagRollback = createDatabase(env.DATABASE_URL);
  assert.equal(afterTagRollback.sqlite.prepare("SELECT count(*) AS count FROM wiki_page_tags WHERE page_id=?").get(pageId).count, 1);
  const audits = afterTagRollback.sqlite.prepare("SELECT event_type,request_id FROM audit_logs WHERE entity_type='agent_plan_item'").all();
  assert.ok(audits.some((row) => row.event_type === "rollback"));
  assert.ok(audits.every((row) => row.request_id));
  afterTagRollback.sqlite.close();
  console.log(JSON.stringify({ status: "passed", pageUpdate: { applied: "applied", rollback: "rolled_back", drift: "rejected" }, conflict: { citations: 2, application: "not_applicable" }, tagBatch: { items: 2, applied: 2, remainingAfterRollback: 1 }, auditedDecisions: audits.length }));
} finally {
  api.kill();
  worker.kill();
  try { fs.rmSync(databaseFile, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-wal`, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-shm`, { force: true }); } catch {}
  try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch {}
}
