import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = 3223;
const databaseFile = path.resolve(`data/agent-tree-check-${process.pid}.db`);
const storageDir = path.resolve(`data/agent-tree-check-resources-${process.pid}`);
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
const flatten = (nodes, result = []) => {
  for (const node of nodes || []) {
    result.push(node);
    flatten(node.children, result);
  }
  return result;
};
const postTreeRun = async (kbId, versionId, key, mountPageId = null) => {
  const created = await request("/api/agent/runs", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ kind: "organize", organizationMode: "tree", knowledgeBaseId: kbId, resourceVersionIds: [versionId], ...(mountPageId ? { mountPageId } : {}), prompt: "Build a reviewable hierarchy from the selected evidence." }) });
  assert.equal(created.response.status, 202);
  return waitFor(async () => {
    const current = await request(`/api/agent/runs/${created.body.data.agentRun.id}`);
    return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
  }, "tree organize run did not finish");
};

try {
  await waitForHealth();
  const kb = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `Tree KB ${process.pid}` }) });
  assert.equal(kb.response.status, 201);
  const kbId = kb.body.data.id;
  const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "tree-import-1" }, body: JSON.stringify({ name: "tree-source.md", content: "The selected source contains the canonical fact used by every generated page.", knowledgeBaseId: kbId }) });
  assert.equal(imported.response.status, 201);
  const versionId = imported.body.data.version.id;
  await waitFor(async () => (await request(`/api/resources/${imported.body.data.resource.id}`)).body.data.currentVersion?.id === versionId, "resource did not index");

  const mount = await request(`/api/knowledge-bases/${kbId}/wiki/pages`, { method: "POST", body: JSON.stringify({ title: "Existing knowledge hub", pageType: "concept" }) });
  assert.equal(mount.response.status, 201);
  const before = await request(`/api/knowledge-bases/${kbId}/wiki`);
  assert.equal(before.body.data.pageCount, 1);
  const indexPage = flatten(before.body.data.pages).find((item) => item.pageType === "index");
  const invalidMount = await request("/api/agent/runs", { method: "POST", body: JSON.stringify({ kind: "organize", organizationMode: "tree", knowledgeBaseId: kbId, resourceVersionIds: [versionId], mountPageId: indexPage.id, prompt: "This must be rejected." }) });
  assert.equal(invalidMount.response.status, 400);
  assert.equal(invalidMount.body.error.code, "AGENT_SCOPE_INVALID");

  const run = await postTreeRun(kbId, versionId, "tree-run-1", mount.body.data.id);
  assert.equal(run.status, "succeeded");
  const plan = await request(`/api/agent/runs/${run.id}/plan`);
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.data.organizationMode, "tree");
  assert.equal(plan.body.data.planStatus, "ready");
  assert.equal(plan.body.data.tree.length, 1);
  assert.equal(plan.body.data.tree[0].nodeRole, "root");
  assert.equal(plan.body.data.tree[0].children[0].children[0].nodeRole, "source");
  assert.equal(plan.body.data.items.length, 3);
  assert.ok(plan.body.data.items.every((item) => item.evidenceStatus === "used"));

  const root = plan.body.data.items.find((item) => !item.parentNodeId);
  const approved = await request(`/api/agent/plan-items/${root.id}/branch-decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.items.length, 3);
  assert.ok(approved.body.data.items.every((item) => item.applicationStatus === "applied"));
  const appliedByNode = new Map(approved.body.data.items.map((item) => [item.nodeId, item]));
  const rootPage = await request(`/api/wiki/pages/${appliedByNode.get("root").targetPageId}`);
  const topicPage = await request(`/api/wiki/pages/${appliedByNode.get("topic").targetPageId}`);
  const sourcePage = await request(`/api/wiki/pages/${appliedByNode.get("source").targetPageId}`);
  assert.equal(rootPage.body.data.parentPageId, mount.body.data.id);
  assert.equal(topicPage.body.data.parentPageId, rootPage.body.data.id);
  assert.equal(sourcePage.body.data.parentPageId, topicPage.body.data.id);
  assert.equal(rootPage.body.data.pageType, "synthesis");
  assert.equal(topicPage.body.data.pageType, "concept");
  assert.equal(sourcePage.body.data.pageType, "source-summary");
  assert.equal(sourcePage.body.data.currentVersion.citations.length, 1);
  const after = await request(`/api/knowledge-bases/${kbId}/wiki`);
  assert.equal(after.body.data.pageCount, before.body.data.pageCount + 3);

  const rejectedRun = await postTreeRun(kbId, versionId, "tree-run-2");
  const rejectedPlan = await request(`/api/agent/runs/${rejectedRun.id}/plan`);
  const rejectedRoot = rejectedPlan.body.data.items.find((item) => !item.parentNodeId);
  const rejected = await request(`/api/agent/plan-items/${rejectedRoot.id}/branch-decision`, { method: "POST", body: JSON.stringify({ decision: "reject", reason: "Human review chose a different taxonomy." }) });
  assert.equal(rejected.response.status, 200);
  assert.ok(rejected.body.data.items.every((item) => item.reviewStatus === "rejected" && item.applicationStatus === "not_applicable"));
  const afterReject = await request(`/api/knowledge-bases/${kbId}/wiki`);
  assert.equal(afterReject.body.data.pageCount, after.body.data.pageCount);

  const editedRun = await postTreeRun(kbId, versionId, "tree-run-3");
  const editedPlan = await request(`/api/agent/runs/${editedRun.id}/plan`);
  const editable = editedPlan.body.data.items.find((item) => item.nodeId === "topic");
  const edited = await request(`/api/agent/plan-items/${editable.id}`, { method: "PATCH", body: JSON.stringify({ proposed: { title: "Edited core topic", contentMarkdown: editable.proposed.contentMarkdown } }) });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.data.proposed.title, "Edited core topic");
  assert.equal(edited.body.data.nodeId, "topic");

  console.log(JSON.stringify({ status: "passed", mode: "tree", generatedPages: 3, mountedUnder: mount.body.data.id, approvedBranch: approved.body.data.planStatus, rejectedBranch: rejected.body.data.planStatus, editableNode: edited.body.data.nodeId }));
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
