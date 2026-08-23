import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const defaultSource = "D:\\深入理解分布式系统 (唐伟志) (Z-Library) (1).pdf";
const sourcePath = path.resolve(process.argv[2] || defaultSource);
const runKey = `${process.pid}-${Date.now()}`;
const port = Number(process.env.PDF_E2E_PORT || 3041);
const databasePath = path.resolve("apps", "api", "data", `pdf-e2e-${runKey}.db`);
const storageDir = path.resolve("artifacts", "sprint2", `pdf-e2e-storage-${runKey}`);
const logDir = path.resolve("artifacts", "sprint2", `pdf-e2e-logs-${runKey}`);
const evidencePath = path.resolve("artifacts", "sprint2", `pdf-e2e-${runKey}.md`);
const venvScripts = path.resolve(".venv-pdf", "Scripts");
const venvPython = path.join(venvScripts, "python.exe");
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const sourceBytes = fs.readFileSync(sourcePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.closeSync(fs.openSync(databasePath, "wx"));

const inheritedPath = process.env.Path || process.env.PATH || "";
const childEnv = {
  ...process.env,
  API_PORT: String(port),
  DATABASE_URL: `file:./${path.relative(process.cwd(), databasePath).replaceAll("\\", "/")}`,
  RESOURCE_STORAGE_DIR: storageDir,
  RESOURCE_MAX_BYTES: "150000000",
  RESOURCE_PARSER_TIMEOUT_MS: "180000",
  WORKER_POLL_INTERVAL_MS: "100",
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8"
};
childEnv.Path = `${venvScripts};${inheritedPath}`;
childEnv.PATH = childEnv.Path;

const children = [];
const start = (name, args) => {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(fs.createWriteStream(path.join(logDir, `${name}.stdout.log`)));
  child.stderr.pipe(fs.createWriteStream(path.join(logDir, `${name}.stderr.log`)));
  children.push(child);
  return child;
};

const request = async (route, options) => {
  const response = await fetch(base + route, options);
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  }
  return { response, body };
};

const waitForHealth = async (api) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`API exited before health check (${api.exitCode})`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("API did not become healthy within 120 seconds");
};

const waitForTask = async (taskId, transitions) => {
  const deadline = Date.now() + 240_000;
  let lastStatus = null;
  let current = null;
  while (Date.now() < deadline) {
    const result = await request(`/api/tasks/${taskId}`);
    current = result.body.data;
    if (current?.status !== lastStatus) {
      lastStatus = current?.status || null;
      transitions.push({ at: new Date().toISOString(), status: lastStatus, progress: current?.progress ?? null, retryCount: current?.retry_count ?? current?.retryCount ?? null });
      console.log(`task ${taskId}: ${lastStatus} (${current?.progress ?? 0}%)`);
    }
    if (["succeeded", "failed"].includes(current?.status)) return current;
    await sleep(1_000);
  }
  throw new Error(`task ${taskId} did not finish within 240 seconds`);
};

const pickSearchQuery = (text) => {
  const candidates = [...new Set([
    ...(text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []).map((word) => word.toLowerCase()),
    ...(text.match(/[\u4e00-\u9fff]{2,}/gu) || [])
  ])];
  return candidates.slice(0, 80);
};

const terminate = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), sleep(2_000)]);
};

const result = {
  outcome: "failed",
  source: { path: sourcePath, bytes: sourceBytes.length, sha256: sha256(sourceBytes) },
  environment: {
    python: spawnSync(venvPython, ["--version"], { encoding: "utf8" }).stdout.trim(),
    port,
    databasePath,
    storageDir,
    logDir
  },
  transitions: [],
  search: null,
  database: null,
  error: null
};

let failure = null;
let api;
try {
  assert.ok(fs.existsSync(sourcePath), `source does not exist: ${sourcePath}`);
  assert.ok(fs.existsSync(venvPython), `uv Python does not exist: ${venvPython}`);

  api = start("api", ["apps/api/src/nest.js"]);
  await waitForHealth(api);
  const health = await request("/health");
  assert.equal(health.response.status, 200);

  const worker = start("worker", ["apps/worker/src/index.js"]);
  const kb = await request("/api/knowledge-bases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `PDF E2E ${runKey}` })
  });
  assert.equal(kb.response.status, 201, JSON.stringify(kb.body));
  const knowledgeBaseId = kb.body.data.id;

  const form = new FormData();
  form.set("name", path.basename(sourcePath));
  form.set("knowledgeBaseId", knowledgeBaseId);
  form.set("file", new Blob([sourceBytes], { type: "application/pdf" }), path.basename(sourcePath));
  const imported = await request("/api/resources", { method: "POST", body: form });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  const resourceId = imported.body.data.resource.id;
  const versionId = imported.body.data.version.id;
  const taskId = imported.body.data.task.id;
  result.import = { knowledgeBaseId, resourceId, versionId, taskId, responseStatus: imported.response.status, initialStatus: imported.body.data.resource.status };

  const task = await waitForTask(taskId, result.transitions);
  result.task = { id: taskId, status: task.status, errorCode: task.error_code || task.errorCode || null, errorSummary: task.error_summary || task.errorSummary || null };
  assert.equal(task.status, "succeeded", JSON.stringify(task));

  const resource = await request(`/api/resources/${resourceId}`);
  assert.equal(resource.response.status, 200);
  result.resource = {
    status: resource.body.data.status,
    currentVersionId: resource.body.data.currentVersion?.id || null,
    versionStatus: resource.body.data.currentVersion?.status || null
  };
  assert.equal(resource.body.data.status, "indexed", JSON.stringify(resource.body.data));
  assert.equal(resource.body.data.currentVersion?.id, versionId);

  const downloaded = await fetch(`${base}/api/resources/${resourceId}/versions/${versionId}/download`);
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(downloaded.status, 200);
  assert.equal(downloadedBytes.length, sourceBytes.length);
  assert.equal(sha256(downloadedBytes), result.source.sha256);
  result.source.downloadVerified = true;

  const runs = await request(`/api/resources/${resourceId}/processing-runs`);
  assert.equal(runs.response.status, 200);
  const indexedRun = runs.body.data.find((run) => run.resource_version_id === versionId && run.status === "indexed");
  assert.ok(indexedRun, JSON.stringify(runs.body.data));
  result.processingRun = {
    id: indexedRun.id,
    status: indexedRun.status,
    parser: `${indexedRun.parser_name}@${indexedRun.parser_version}`,
    canonicalBytes: indexedRun.canonical_byte_size,
    blockCount: indexedRun.block_count,
    parentCount: indexedRun.parent_count,
    childCount: indexedRun.child_count,
    attempts: indexedRun.attempts
  };

  const canonical = await request(`/api/resources/${resourceId}/processing-runs/${indexedRun.id}/canonical`);
  assert.equal(canonical.response.status, 200);
  const canonicalText = canonical.body.data.canonicalText;
  assert.equal(typeof canonicalText, "string");
  assert.ok(canonicalText.length > 32);
  result.canonical = {
    sha256: sha256(Buffer.from(canonicalText, "utf8")),
    chars: Array.from(canonicalText).length,
    blocks: canonical.body.data.blocks?.length || 0,
    head: canonicalText.slice(0, 600)
  };

  for (const query of pickSearchQuery(canonicalText)) {
    const search = await request(`/api/search?q=${encodeURIComponent(query)}&knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
    if (search.response.status === 200 && search.body.data.length > 0) {
      result.search = { query, resultCount: search.body.data.length, firstChunkType: search.body.data[0].chunk_type, firstResourceId: search.body.data[0].resource_id };
      break;
    }
  }
  assert.ok(result.search, "no indexed canonical-text token was searchable");

  const sqlite = new Database(databasePath);
  const sourceRow = sqlite.prepare("SELECT byte_size,content_sha256,status,active_processing_run_id FROM resource_versions WHERE id=?").get(versionId);
  const counts = {
    versions: sqlite.prepare("SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id=?").get(resourceId).count,
    processingRuns: sqlite.prepare("SELECT COUNT(*) AS count FROM processing_runs WHERE resource_version_id=?").get(versionId).count,
    activeChunks: sqlite.prepare("SELECT COUNT(*) AS count FROM chunks WHERE resource_version_id=? AND status='active'").get(versionId).count,
    activeTextChunks: sqlite.prepare("SELECT COUNT(*) AS count FROM chunks WHERE resource_version_id=? AND chunk_type='text' AND status='active'").get(versionId).count,
    ftsRows: sqlite.prepare("SELECT COUNT(*) AS count FROM resource_fts").get().count,
    processingAttempts: sqlite.prepare("SELECT COUNT(*) AS count FROM processing_run_attempts WHERE processing_run_id=?").get(indexedRun.id).count
  };
  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_check").all();
  sqlite.close();
  assert.equal(foreignKeys.length, 0, JSON.stringify(foreignKeys));
  assert.equal(sourceRow.byte_size, sourceBytes.length);
  assert.equal(sourceRow.content_sha256, result.source.sha256);
  assert.equal(sourceRow.status, "indexed");
  assert.equal(sourceRow.active_processing_run_id, indexedRun.id);
  assert.ok(counts.activeTextChunks > 0);
  assert.equal(counts.ftsRows, counts.activeTextChunks);
  result.database = { source: sourceRow, counts, foreignKeyViolations: foreignKeys.length };
  result.outcome = "passed";
  console.log(`PDF E2E passed: ${resourceId}`);
} catch (caught) {
  failure = caught;
  result.error = { name: caught?.name || "Error", message: caught?.message || String(caught), code: caught?.code || null };
  console.error(`PDF E2E failed: ${result.error.message}`);
} finally {
  for (const child of children.reverse()) await terminate(child);
  const report = [
    "# PDF import end-to-end evidence",
    "",
    `- Outcome: **${result.outcome}**`,
    `- Generated: ${new Date().toISOString()}`,
    `- Source: ${result.source.path}`,
    `- Source bytes: ${result.source.bytes}`,
    `- Source SHA-256: ${result.source.sha256}`,
    `- Python: ${result.environment.python || "unavailable"}`,
    `- Isolated database: ${result.environment.databasePath}`,
    `- Isolated storage: ${result.environment.storageDir}`,
    `- Process logs: ${result.environment.logDir}`,
    "",
    "## Import and processing",
    "",
    "```json",
    JSON.stringify({ import: result.import, task: result.task, resource: result.resource, processingRun: result.processingRun }, null, 2),
    "```",
    "",
    "## Task state transitions",
    "",
    "```json",
    JSON.stringify(result.transitions, null, 2),
    "```",
    "",
    "## Canonical text and search",
    "",
    "```json",
    JSON.stringify({ canonical: result.canonical, search: result.search }, null, 2),
    "```",
    "",
    "## Database invariants",
    "",
    "```json",
    JSON.stringify(result.database, null, 2),
    "```",
    "",
    "## Error",
    "",
    "```json",
    JSON.stringify(result.error, null, 2),
    "```",
    ""
  ].join("\n");
  fs.writeFileSync(evidencePath, report, "utf8");
  console.log(`Evidence: ${evidencePath}`);
}

if (failure) process.exitCode = 1;
