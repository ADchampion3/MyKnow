import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@myknow/config";
import { AGENT_READ_TOOL_NAMES, AGENT_TERMINAL_TOOL_NAMES, createDatabase, createScopeSnapshot, migrate, persistBytes, searchKnowledge, sha256, validateAnswerOutput, validatePlanOutput } from "@myknow/db";

const { sqlite } = createDatabase(":memory:");
migrate(sqlite);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-agent-contract-"));
const timestamp = new Date().toISOString();
const kbId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
const versionId = crypto.randomUUID();
const bytes = Buffer.from("evidence");
const storageKey = `blobs/${sha256(bytes).slice(0, 2)}/${sha256(bytes)}`;
try {
  sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(kbId, "Agent contract", "active", timestamp, timestamp);
  sqlite.prepare("INSERT INTO resources (id,name,source_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,'pending',NULL,?,?)").run(resourceId, "contract.txt", "text", timestamp, timestamp);
  persistBytes(root, storageKey, bytes);
  sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'indexed',?,?)").run(versionId, resourceId, sha256(bytes), storageKey, "text/plain", bytes.length, timestamp, timestamp);
  sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(resourceId, kbId, timestamp);
  sqlite.prepare("UPDATE resources SET current_version_id=?,status='indexed' WHERE id=?").run(versionId, resourceId);

  assert.deepEqual(AGENT_READ_TOOL_NAMES, ["search_knowledge", "read_resource_version", "read_raw_chunk", "read_wiki_page", "read_retrieval_run", "list_wiki_citations"]);
  assert.deepEqual(AGENT_TERMINAL_TOOL_NAMES, ["submit_answer", "submit_change_plan"]);
  assert.ok(![...AGENT_READ_TOOL_NAMES, ...AGENT_TERMINAL_TOOL_NAMES].some((name) => /bash|shell|filesystem|web|sql|mcp/i.test(name)));
  assert.throws(() => createScopeSnapshot(sqlite, { knowledgeBaseId: kbId }, { requireExplicit: true }), (caught) => caught.code === "AGENT_SCOPE_INVALID");
  const scope = createScopeSnapshot(sqlite, { knowledgeBaseId: kbId, resourceVersionIds: [versionId] }, { requireExplicit: true });
  const config = { resourceStorageDir: root };
  const answer = validateAnswerOutput(sqlite, config, scope, { answerMarkdown: "supported", evidence: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }], modelSupplement: "", openQuestions: [], evidenceStatus: "used" });
  assert.equal(answer.evidenceStatus, "used");
  const plan = validatePlanOutput(sqlite, config, scope, { items: [{ itemType: "page_create", proposed: { title: "Evidence page", pageType: "source-summary", contentMarkdown: "# Evidence page\n\nSupported." }, citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }] }] });
  assert.equal(plan.items[0].risk, "medium");
  assert.equal(plan.items[0].evidenceStatus, "used");
  const treeScope = createScopeSnapshot(sqlite, { knowledgeBaseId: kbId, organizationMode: "tree", resourceVersionIds: [versionId] }, { requireExplicit: true });
  const treePlan = validatePlanOutput(sqlite, config, treeScope, { items: [
    { itemType: "page_create", nodeId: "root", nodeRole: "root", proposed: { title: "Root", pageType: "synthesis", contentMarkdown: "# Root" }, citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }] },
    { itemType: "page_create", nodeId: "child", parentNodeId: "root", nodeRole: "category", proposed: { title: "Child", pageType: "concept", contentMarkdown: "# Child" }, citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }] }
  ] });
  assert.equal(treePlan.items.length, 2);
  assert.equal(treePlan.items[1].parentNodeId, "root");
  assert.throws(() => validatePlanOutput(sqlite, config, treeScope, { items: [
    { itemType: "page_create", nodeId: "a", parentNodeId: "b", proposed: { title: "A", pageType: "synthesis", contentMarkdown: "# A" }, citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }] },
    { itemType: "page_create", nodeId: "b", parentNodeId: "a", proposed: { title: "B", pageType: "concept", contentMarkdown: "# B" }, citations: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 8 } }] }
  ] }), (caught) => caught.code === "AGENT_OUTPUT_INVALID");
  const open = createScopeSnapshot(sqlite, {}, { allowEmpty: true });
  assert.equal(validateAnswerOutput(sqlite, config, open, { answerMarkdown: "general", evidence: [], modelSupplement: "", openQuestions: [], evidenceStatus: "none" }).evidenceStatus, "none");
  assert.throws(() => validateAnswerOutput(sqlite, config, open, { answerMarkdown: "bad", evidence: [{ resourceVersionId: versionId, locator: { startOffset: 0, endOffset: 1 } }], evidenceStatus: "used" }), (caught) => caught.code === "AGENT_OUTPUT_INVALID");
  sqlite.prepare("DROP TABLE resource_fts").run();
  const unavailable = await searchKnowledge({ sqlite, config: { resourceStorageDir: root, retrievalVectorEnabled: false }, snapshot: scope, query: "index unavailable" });
  assert.equal(unavailable.evidenceStatus, "index_unavailable");
  assert.equal(loadConfig({ MODEL_PROVIDER: "mock", AI_EGRESS_MODE: "local_only" }).aiEgressMode, "local_only");
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "mock", AI_EGRESS_MODE: "somewhere" }));
  console.log(JSON.stringify({ schema: "sprint5-agent-tree-v1", readTools: AGENT_READ_TOOL_NAMES.length, terminalTools: AGENT_TERMINAL_TOOL_NAMES.length, scopedEvidence: answer.evidence.length, planItems: plan.items.length, treeItems: treePlan.items.length, indexUnavailable: unavailable.evidenceStatus }));
} finally {
  sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
}
