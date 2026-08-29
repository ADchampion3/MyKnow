import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = 3221;
const databaseFile = path.resolve(`data/chat-open-check-${process.pid}.db`);
const storageDir = path.resolve(`data/chat-open-check-resources-${process.pid}`);
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
  const openSession = await request("/api/chat/sessions", { method: "POST", body: JSON.stringify({}) });
  assert.equal(openSession.response.status, 201);
  const openResults = [];
  for (let index = 0; index < 20; index += 1) {
    const openMessage = await request(`/api/chat/sessions/${openSession.body.data.id}/messages`, { method: "POST", headers: { "idempotency-key": `open-chat-${index + 1}` }, body: JSON.stringify({ content: `用一句话回答：${index + 2} + 2 等于多少？` }) });
    assert.equal(openMessage.response.status, 202);
    const openDone = await waitFor(async () => {
      const current = await request(`/api/chat/messages/${openMessage.body.data.assistantMessage.id}`);
      return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
    }, `open chat ${index + 1} did not finish`);
    assert.equal(openDone.status, "succeeded");
    assert.equal(openDone.answer.evidenceStatus, "none");
    assert.deepEqual(openDone.answer.evidence, []);
    openResults.push({ status: openDone.status, evidenceStatus: openDone.answer.evidenceStatus });
  }

  const kb = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `Chat scoped ${process.pid}` }) });
  assert.equal(kb.response.status, 201);
  const imported = await request("/api/resources", { method: "POST", headers: { "idempotency-key": "scoped-import-1" }, body: JSON.stringify({ name: "scoped.md", content: "MyKnow scoped evidence for agent chat.", knowledgeBaseId: kb.body.data.id }) });
  assert.equal(imported.response.status, 201);
  const versionId = imported.body.data.version.id;
  await waitFor(async () => {
    const current = await request(`/api/resources/${imported.body.data.resource.id}`);
    return current.body.data.currentVersion?.id === versionId && current.body.data.status === "indexed";
  }, "resource did not index");
  const scopedSession = await request("/api/chat/sessions", { method: "POST", body: JSON.stringify({ knowledgeBaseId: kb.body.data.id, resourceVersionIds: [versionId] }) });
  assert.equal(scopedSession.response.status, 201);
  const scopedMessage = await request(`/api/chat/sessions/${scopedSession.body.data.id}/messages`, { method: "POST", headers: { "idempotency-key": "scoped-chat-1" }, body: JSON.stringify({ content: "查找 scoped evidence。" }) });
  assert.equal(scopedMessage.response.status, 202);
  const scopedDone = await waitFor(async () => {
    const current = await request(`/api/chat/messages/${scopedMessage.body.data.assistantMessage.id}`);
    return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
  }, "scoped chat did not finish");
  assert.equal(scopedDone.status, "succeeded");
  assert.equal(scopedDone.answer.evidenceStatus, "used");
  assert.ok(scopedDone.answer.evidence.every((item) => item.resourceVersionId === versionId));
  const noMatchMessage = await request(`/api/chat/sessions/${scopedSession.body.data.id}/messages`, { method: "POST", headers: { "idempotency-key": "scoped-chat-no-match" }, body: JSON.stringify({ content: "find an intentionally absent term: zxqv-no-match-239" }) });
  assert.equal(noMatchMessage.response.status, 202);
  const noMatchDone = await waitFor(async () => {
    const current = await request(`/api/chat/messages/${noMatchMessage.body.data.assistantMessage.id}`);
    return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
  }, "scoped no-match chat did not finish");
  assert.equal(noMatchDone.status, "succeeded");
  assert.equal(noMatchDone.answer.evidenceStatus, "no_match");
  assert.deepEqual(noMatchDone.answer.evidence, []);
  const trace = await request(`/api/agent/runs/${scopedMessage.body.data.agentRun.id}/events`);
  assert.equal(trace.response.status, 200);
  assert.ok(trace.body.data.items.some((item) => item.toolName === "search_knowledge"));
  assert.ok(trace.body.data.items.every((item) => !/MODEL_API_KEY|sk-/.test(JSON.stringify(item))));
  console.log(JSON.stringify({ open: { count: openResults.length, statuses: openResults }, scoped: { status: scopedDone.status, evidenceStatus: scopedDone.answer.evidenceStatus, citationCount: scopedDone.answer.evidence.length }, noMatch: noMatchDone.answer.evidenceStatus, eventCount: trace.body.data.items.length }));
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
