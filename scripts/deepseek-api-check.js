import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

try {
  process.loadEnvFile?.(path.resolve(".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY must be supplied in the process environment; it is never read from a repository file");
const port = Number(process.env.DEEPSEEK_CHECK_PORT || 3223);
const databaseFile = path.resolve(`data/deepseek-api-check-${process.pid}.db`);
const storageDir = path.resolve(`data/deepseek-api-check-resources-${process.pid}`);
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
fs.closeSync(fs.openSync(databaseFile, "w"));
const env = {
  ...process.env,
  API_PORT: String(port),
  DATABASE_URL: `file:${databaseFile}`,
  RESOURCE_STORAGE_DIR: storageDir,
  MODEL_PROVIDER: "deepseek",
  MODEL_NAME: process.env.MODEL_NAME || "deepseek-chat",
  MODEL_API_BASE_URL: process.env.MODEL_API_BASE_URL || "https://api.deepseek.com",
  AI_EGRESS_MODE: "allow_cloud",
  WORKER_POLL_INTERVAL_MS: "100",
  AGENT_TIMEOUT_MS: "120000"
};
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
const worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const safe = (value) => String(value || "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
const request = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  return { response, body };
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not start");
};
const waitFor = async (callback) => {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DeepSeek chat did not finish within the check timeout");
};

try {
  await waitForHealth();
  const session = await request("/api/chat/sessions", { method: "POST", body: JSON.stringify({}) });
  assert.equal(session.response.status, 201);
  const message = await request(`/api/chat/sessions/${session.body.data.id}/messages`, {
    method: "POST",
    headers: { "idempotency-key": `deepseek-chat-${process.pid}` },
    body: JSON.stringify({ content: "用一句话回答：2 + 2 等于多少？" })
  });
  assert.equal(message.response.status, 202);
  const done = await waitFor(async () => {
    const current = await request(`/api/chat/messages/${message.body.data.assistantMessage.id}`);
    return ["succeeded", "failed"].includes(current.body.data?.status) ? current.body.data : null;
  });
  if (done.status !== "succeeded") throw new Error(safe(`${done.error?.code || "PROVIDER_FAILED"}: ${done.error?.message || "DeepSeek request failed"}`));
  assert.equal(done.answer?.evidenceStatus, "none");
  assert.deepEqual(done.answer?.evidence, []);
  const summary = { status: "passed", provider: "deepseek", model: env.MODEL_NAME, egressMode: env.AI_EGRESS_MODE, answerStatus: done.status, evidenceStatus: done.answer.evidenceStatus, keyRecorded: false };
  fs.mkdirSync(path.resolve("artifacts/sprint5"), { recursive: true });
  fs.writeFileSync(path.resolve("artifacts/sprint5/deepseek-provider.json"), `${JSON.stringify(summary)}\n`, "utf8");
  console.log(JSON.stringify(summary));
} catch (caught) {
  console.error(safe(caught.stack || caught.message));
  process.exitCode = 1;
} finally {
  api.kill();
  worker.kill();
  try { fs.rmSync(databaseFile, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-wal`, { force: true }); } catch {}
  try { fs.rmSync(`${databaseFile}-shm`, { force: true }); } catch {}
  try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch {}
}
