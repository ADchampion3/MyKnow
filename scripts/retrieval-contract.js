import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ftsQueryFor, tokenizeQuery } from "@myknow/db";

const port = 3044;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-retrieval-contract-"));
const databaseFile = path.join(root, "knowledge.db");
const storageDir = path.join(root, "resources");
const env = { ...process.env, API_PORT: String(port), DATABASE_URL: `file:${databaseFile}`, RESOURCE_STORAGE_DIR: storageDir, WORKER_POLL_INTERVAL_MS: "25", RETRIEVAL_VECTOR_ENABLED: "false" };
const api = spawn(process.execPath, ["apps/api/src/nest.js"], { env, stdio: "ignore" });
const worker = spawn(process.execPath, ["apps/worker/src/index.js"], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json" };
const json = (value) => JSON.stringify(value);
const request = async (pathname, options = {}) => {
  const response = await fetch(`${base}${pathname}`, options);
  const body = response.status === 204 ? {} : await response.json();
  return { response, body };
};
const waitForHealth = async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not start");
};
const waitFor = async (check, label) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  await waitForHealth();
  const first = await request("/api/knowledge-bases", { method: "POST", headers, body: json({ name: "Retrieval API KB" }) });
  assert.equal(first.response.status, 201);
  const knowledgeBaseId = first.body.data.id;
  const second = await request("/api/knowledge-bases", { method: "POST", headers, body: json({ name: "Retrieval Other KB" }) });
  assert.equal(second.response.status, 201);

  const space = await request(`/api/knowledge-bases/${knowledgeBaseId}/spaces`, { method: "POST", headers, body: json({ name: "Core" }) });
  assert.equal(space.response.status, 201);
  const spaceId = space.body.data.id;
  const target = await request(`/api/knowledge-bases/${knowledgeBaseId}/wiki/pages`, { method: "POST", headers, body: json({ title: "Operations Checklist", pageType: "concept", spaceId, contentMarkdown: "# Operations Checklist\n\nExecution checklist." }) });
  assert.equal(target.response.status, 201);
  const seed = await request(`/api/knowledge-bases/${knowledgeBaseId}/wiki/pages`, { method: "POST", headers, body: json({ title: "Deployment Runbook", pageType: "concept", spaceId, contentMarkdown: `# Deployment Runbook\n\nThe release deployment runbook records the release procedure. [Checklist](wiki://${target.body.data.id})` }) });
  assert.equal(seed.response.status, 201);
  const cjk = await request(`/api/knowledge-bases/${knowledgeBaseId}/wiki/pages`, { method: "POST", headers, body: json({ title: "发布流程", pageType: "concept", spaceId, contentMarkdown: "# 发布流程\n\n发布流程说明。" }) });
  assert.equal(cjk.response.status, 201);
  const foreign = await request(`/api/knowledge-bases/${second.body.data.id}/wiki/pages`, { method: "POST", headers, body: json({ title: "Deployment Runbook Elsewhere", pageType: "concept", contentMarkdown: "# Deployment Runbook\n\nrelease deployment runbook" }) });
  assert.equal(foreign.response.status, 201);

  const source = await request("/api/resources", { method: "POST", headers, body: json({ name: "release.md", content: "Raw release deployment runbook evidence.", knowledgeBaseId }) });
  assert.equal(source.response.status, 201);
  await waitFor(async () => (await request(`/api/resources/${source.body.data.resource.id}`)).body.data.status === "indexed", "raw resource index");
  const foreignSource = await request("/api/resources", { method: "POST", headers, body: json({ name: "foreign-release.md", content: "Raw release deployment runbook evidence.", knowledgeBaseId: second.body.data.id }) });
  assert.equal(foreignSource.response.status, 201);
  await waitFor(async () => (await request(`/api/resources/${foreignSource.body.data.resource.id}`)).body.data.status === "indexed", "foreign raw resource index");

  const query = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId, spaceId, query: "release deployment runbook", wikiTopK: 1, rawTopK: 1, contextBudgetTokens: 120 }) });
  assert.equal(query.response.status, 200);
  const trace = query.body.data;
  assert.match(trace.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(trace.scope.knowledgeBaseId, knowledgeBaseId);
  assert.equal(trace.scope.spaceId, spaceId);
  assert.equal(trace.scope.rawScope, "knowledge_base");
  assert.ok(trace.wiki.seeds.length <= 1);
  assert.ok(trace.raw.results.length <= 1);
  assert.equal(trace.vector.status, "disabled");
  assert.equal(trace.vector.keywordFallback, true);
  assert.ok(trace.wiki.seeds.every((item) => item.pageId !== foreign.body.data.id));
  assert.ok(trace.raw.results.every((item) => item.resourceId === source.body.data.resource.id));
  assert.ok(trace.context.wikiEstimatedTokens <= trace.context.wikiBudgetTokens);
  assert.ok(trace.context.rawEstimatedTokens <= trace.context.rawBudgetTokens);

  const cjkQuery = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId, spaceId, query: "发布流程", wikiTopK: 5, rawTopK: 1, contextBudgetTokens: 120 }) });
  assert.equal(cjkQuery.response.status, 200);
  assert.equal(cjkQuery.body.data.wiki.seeds[0].pageId, cjk.body.data.id);
  assert.ok(cjkQuery.body.data.keyword.wiki.terms.includes("发布"));
  assert.ok(cjkQuery.body.data.wiki.seeds[0].matchedFeatures.phrase);
  const tokenized = tokenizeQuery("the release 发布流程");
  assert.deepEqual(tokenized.englishTokens, ["release"]);
  assert.deepEqual(tokenized.cjkBigrams, ["发布", "布流", "流程"]);
  assert.match(ftsQueryFor(tokenized), / OR /);

  const replay = await request(`/api/retrieval/runs/${trace.traceId}`);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.traceId, trace.traceId);
  assert.deepEqual(replay.body.data.scope, trace.scope);
  assert.equal(replay.body.data.wiki.seeds.length, trace.wiki.seeds.length);
  assert.equal(replay.body.data.raw.results.length, trace.raw.results.length);
  assert.equal(replay.body.data.raw.results[0].content, undefined);
  assert.equal(replay.body.data.raw.results[0].parentContext, undefined);
  assert.equal(replay.body.data.raw.results[0].snippet, undefined);

  const rawLocator = trace.raw.results[0].locator;
  const preview = await request(`/api/resources/${trace.raw.results[0].resourceId}/versions/${trace.raw.results[0].resourceVersionId}/preview?startOffset=${rawLocator.startOffset}&endOffset=${rawLocator.endOffset}`);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.data.resourceVersionId, trace.raw.results[0].resourceVersionId);
  assert.deepEqual(preview.body.data.locator, { startOffset: rawLocator.startOffset, endOffset: rawLocator.endOffset });
  assert.match(preview.body.data.snippet, /Raw release deployment/);

  const invalid = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId, query: "x", wikiTopK: 21 }) });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  const missing = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId }) });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, "VALIDATION_ERROR");
  const invalidId = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId: "not-a-uuid", query: "x" }) });
  assert.equal(invalidId.response.status, 400);
  assert.equal(invalidId.body.error.code, "VALIDATION_ERROR");
  const invalidSpace = await request("/api/retrieval/query", { method: "POST", headers, body: json({ knowledgeBaseId, spaceId: "not-a-uuid", query: "x" }) });
  assert.equal(invalidSpace.response.status, 400);
  assert.equal(invalidSpace.body.error.code, "VALIDATION_ERROR");
  const nullBody = await request("/api/retrieval/query", { method: "POST", headers, body: "null" });
  assert.equal(nullBody.response.status, 400);
  assert.equal(nullBody.body.error.code, "VALIDATION_ERROR");
  const invalidRunId = await request("/api/retrieval/runs/not-a-uuid");
  assert.equal(invalidRunId.response.status, 400);
  assert.equal(invalidRunId.body.error.code, "VALIDATION_ERROR");

  console.log(JSON.stringify({ status: "passed", traceId: trace.traceId, wikiCount: trace.wiki.seeds.length, rawCount: trace.raw.results.length, graphCount: trace.wiki.graphExpanded.length, rawScope: trace.scope.rawScope, vectorStatus: trace.vector.status, replayed: true, trace }));
} finally {
  api.kill();
  worker.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(root, { recursive: true, force: true });
}
