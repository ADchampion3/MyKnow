import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@myknow/config";
import { createApiContext } from "../apps/api/src/context.js";
import { createHttpTools } from "../apps/api/src/http.js";
import { handleAgentRoutes } from "../apps/api/src/routes/agent.js";
import {
  ANSWER_CONTRACT_VERSION,
  AGENT_PROMPT_VERSION,
  PLAN_CONTRACT_VERSION,
  approveAgentPlanItem,
  agentPlanStatus,
  createDatabase,
  createScopeSnapshot,
  insertAgentPlanItems,
  migrate,
  validateAnswerOutput,
  validatePlanOutput
} from "@myknow/db";

const id = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const response = () => ({ respond(fetchResponse, body) { this.status = fetchResponse.status; this.body = body; } });

const fixture = () => {
  const database = createDatabase(":memory:");
  migrate(database.sqlite);
  const now = timestamp();
  const knowledgeBaseId = id();
  const pageId = id();
  const pageVersionId = id();
  database.sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?, 'active',?,?)").run(knowledgeBaseId, `Citation fixture ${knowledgeBaseId.slice(0, 8)}`, now, now);
  database.sqlite.prepare("INSERT INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)").run(pageId, knowledgeBaseId, null, null, `seed-${pageId.slice(0, 8)}`, "Seed page", "concept", now, now);
  database.sqlite.prepare("INSERT INTO wiki_page_versions (id,page_id,parent_version_id,template_version_id,content_markdown,content_sha256,change_summary,restore_of_version_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(pageVersionId, pageId, null, null, "# Seed\n\nSource material", sha("# Seed\n\nSource material"), "Fixture", null, now);
  database.sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(pageVersionId, pageId);
  const snapshot = createScopeSnapshot(database.sqlite, { knowledgeBaseId, wikiPageIds: [pageId] }, { requireExplicit: true });
  return { database, knowledgeBaseId, pageId, pageVersionId, snapshot, config: { resourceStorageDir: ".", retrievalVectorEnabled: false } };
};

const plan = (pageVersionId, citations = []) => ({
  items: [{
    itemType: "page_create",
    proposed: { title: "Generated page", pageType: "concept", contentMarkdown: "# Generated\n\nContent" },
    citations
  }]
});

const insertRun = ({ sqlite, knowledgeBaseId, snapshot, citationPolicy }) => {
  const now = timestamp();
  const taskId = id();
  const runId = id();
  sqlite.prepare("INSERT INTO tasks (id,type,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?, 'queued',0,3,0,?,?)").run(taskId, "agent:organize", now, now);
  sqlite.prepare("INSERT INTO agent_runs (id,task_id,run_kind,knowledge_base_id,space_id,scope_snapshot,prompt_text,prompt_hash,prompt_version,contract_version,provider,model,egress_mode,citation_policy,status,metrics,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'succeeded','{}',?,?)").run(runId, taskId, "organize", knowledgeBaseId, null, JSON.stringify(snapshot), "organize", "0".repeat(64), AGENT_PROMPT_VERSION, PLAN_CONTRACT_VERSION, "mock", "mock", "local_only", citationPolicy, now, now);
  return runId;
};

describe("Agent citation policy", () => {
  it("defaults to warn and rejects unsupported policies", () => {
    expect(loadConfig({}).agentCitationPolicy).toBe("warn");
    expect(loadConfig({ AGENT_CITATION_POLICY: "required" }).agentCitationPolicy).toBe("required");
    expect(() => loadConfig({ AGENT_CITATION_POLICY: "off" })).toThrow("AGENT_CITATION_POLICY must be required or warn");
  });

  it("migrates the previous schema while preserving pending plan items", () => {
    const { database, knowledgeBaseId, snapshot } = fixture();
    try {
      const runId = insertRun({ sqlite: database.sqlite, knowledgeBaseId, snapshot, citationPolicy: "warn" });
      const planItemId = id();
      const now = timestamp();
      database.sqlite.prepare("INSERT INTO agent_plan_items (id,run_id,ordinal,item_type,proposed_json,risk,evidence_status,review_status,application_status,created_at,updated_at) VALUES (?,?,0,'page_create',?,'medium','needs_evidence','proposed','pending',?,?)").run(planItemId, runId, "{}", now, now);
      database.sqlite.exec("ALTER TABLE agent_runs DROP COLUMN citation_policy; ALTER TABLE agent_plan_items DROP COLUMN validation_warnings; UPDATE schema_meta SET value='retrieval-query-256-v1' WHERE key='schema_version'");
      expect(migrate(database.sqlite)).toMatchObject({ fresh: false, migratedFrom: "retrieval-query-256-v1" });
      expect(database.sqlite.prepare("SELECT id FROM agent_plan_items WHERE id=?").get(planItemId).id).toBe(planItemId);
      expect(database.sqlite.prepare("SELECT citation_policy FROM agent_runs WHERE id=?").get(runId).citation_policy).toBe("required");
      expect(database.sqlite.prepare("SELECT validation_warnings FROM agent_plan_items WHERE id=?").get(planItemId).validation_warnings).toBe("[]");
    } finally { database.sqlite.close(); }
  });

  it("downgrades invalid citations to warnings while retaining valid citations", () => {
    const { database, pageVersionId, snapshot, config } = fixture();
    try {
      const result = validatePlanOutput(database.sqlite, config, snapshot, plan(pageVersionId, [
        { wikiPageVersionId: pageVersionId },
        { wikiPageVersionId: id() }
      ]), { citationPolicy: "warn" });
      expect(result.items[0].citations).toHaveLength(1);
      expect(result.items[0].evidenceStatus).toBe("unverified");
      expect(result.items[0].validationWarnings).toHaveLength(1);
      expect(result.items[0].validationWarnings[0].code).toBe("AGENT_CITATION_INVALID");
      expect(result.warningCount).toBe(1);
    } finally { database.sqlite.close(); }
  });

  it("keeps required citation validation strict and marks missing warn evidence", () => {
    const { database, pageVersionId, snapshot, config } = fixture();
    try {
      expect(() => validatePlanOutput(database.sqlite, config, snapshot, plan(pageVersionId, [{ wikiPageVersionId: id() }]), { citationPolicy: "required" })).toThrow("citation Wiki page version is outside the run scope");
      const result = validatePlanOutput(database.sqlite, config, snapshot, plan(pageVersionId), { citationPolicy: "warn" });
      expect(result.items[0].evidenceStatus).toBe("unverified");
      expect(result.items[0].validationWarnings[0].code).toBe("AGENT_CITATION_MISSING");
    } finally { database.sqlite.close(); }
  });

  it("allows a reviewed warn item to apply without writing invalid provenance", () => {
    const { database, knowledgeBaseId, snapshot, config } = fixture();
    try {
      const runId = insertRun({ sqlite: database.sqlite, knowledgeBaseId, snapshot, citationPolicy: "warn" });
      const normalized = validatePlanOutput(database.sqlite, config, snapshot, plan(id()), { citationPolicy: "warn" });
      const [itemId] = insertAgentPlanItems(database.sqlite, runId, normalized);
      expect(agentPlanStatus(database.sqlite, runId)).toBe("ready_with_warnings");
      const applied = approveAgentPlanItem(database.sqlite, config, itemId);
      expect(applied.applicationStatus).toBe("applied");
      expect(agentPlanStatus(database.sqlite, runId)).toBe("applied");
      expect(applied.evidenceStatus).toBe("unverified");
      expect(applied.validationWarnings).toHaveLength(1);
      const page = database.sqlite.prepare("SELECT * FROM wiki_pages WHERE id=?").get(applied.targetPageId);
      expect(page).toBeTruthy();
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM wiki_citations WHERE page_version_id=?").get(applied.appliedPageVersionId).count).toBe(0);
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM wiki_page_citations WHERE page_version_id=?").get(applied.appliedPageVersionId).count).toBe(0);
    } finally { database.sqlite.close(); }
  });

  it("keeps answer citations strict even when the organize policy is warn", () => {
    const { database, pageVersionId, snapshot, config } = fixture();
    try {
      expect(() => validateAnswerOutput(database.sqlite, config, snapshot, {
        answerMarkdown: "Answer",
        evidence: [{ wikiPageVersionId: id() }],
        evidenceStatus: "used"
      })).toThrow("citation Wiki page version is outside the run scope");
      expect(ANSWER_CONTRACT_VERSION).toBe("agent-answer-v1");
      expect(pageVersionId).toBeTruthy();
    } finally { database.sqlite.close(); }
  });

  it("captures the configured policy when the organize run is queued", async () => {
    const { database, knowledgeBaseId, pageId } = fixture();
    const config = loadConfig({ MODEL_PROVIDER: "mock", RESOURCE_STORAGE_DIR: ".", AGENT_CITATION_POLICY: "warn" });
    const ctx = createApiContext({ config, sqlite: database.sqlite, db: database.db, http: createHttpTools({ config }) });
    const runResponse = response();
    try {
      await handleAgentRoutes({ ctx, request: { pathname: "/api/agent/runs", method: "POST", body: { kind: "organize", knowledgeBaseId, wikiPageIds: [pageId], prompt: "organize" }, requestId: id(), idempotencyKey: null, res: runResponse } });
      expect(runResponse.status).toBe(202);
      expect(runResponse.body.data.agentRun.citationPolicy).toBe("warn");
      expect(database.sqlite.prepare("SELECT citation_policy FROM agent_runs WHERE id=?").get(runResponse.body.data.agentRun.id).citation_policy).toBe("warn");

      const sessionResponse = response();
      await handleAgentRoutes({ ctx, request: { pathname: "/api/chat/sessions", method: "POST", body: {}, requestId: id(), idempotencyKey: null, res: sessionResponse } });
      const messageResponse = response();
      await handleAgentRoutes({ ctx, request: { pathname: `/api/chat/sessions/${sessionResponse.body.data.id}/messages`, method: "POST", body: { content: "hello" }, requestId: id(), idempotencyKey: null, res: messageResponse } });
      expect(messageResponse.status).toBe(202);
      expect(messageResponse.body.data.agentRun.citationPolicy).toBe("required");
    } finally { database.sqlite.close(); }
  });
});
