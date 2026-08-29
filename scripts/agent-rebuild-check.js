import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrate, getAgentEvents, getAgentRun, getChatSession } from "@myknow/db";
import { rebuildDatabase } from "./recreate-db.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-sprint5-rebuild-"));
const databaseFile = path.join(root, "knowledge.db");
const storage = path.join(root, "resources");
const timestamp = new Date().toISOString();
const ids = {
  kb: crypto.randomUUID(),
  task: crypto.randomUUID(),
  run: crypto.randomUUID(),
  session: crypto.randomUUID(),
  userMessage: crypto.randomUUID(),
  assistantMessage: crypto.randomUUID(),
  event: crypto.randomUUID(),
  audit: crypto.randomUUID()
};
const scope = JSON.stringify({ version: "scope-snapshot-v1", knowledgeBaseId: null, spaceId: null, resourceVersions: [], wikiPages: [], retrievalRunIds: [], createdAt: timestamp });

try {
  fs.mkdirSync(storage, { recursive: true });
  const database = createDatabase(`file:${databaseFile}`);
  migrate(database.sqlite);
  database.sqlite.transaction(() => {
    database.sqlite.prepare("INSERT INTO knowledge_bases (id,name,chunking_config,wiki_default_mode,status,created_at,updated_at) VALUES (?,?,?,'enabled','active',?,?)").run(ids.kb, "Sprint 5 rebuild KB", "{}", timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'succeeded',100,3,0,?,?)").run(ids.task, "agent:answer", JSON.stringify({ agentRunId: ids.run }), timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO agent_runs (id,task_id,run_kind,knowledge_base_id,space_id,scope_snapshot,prompt_text,prompt_hash,prompt_version,contract_version,provider,model,egress_mode,status,metrics,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'succeeded','{}',NULL,?,?)").run(ids.run, ids.task, "answer", null, null, scope, "rebuild probe", "a".repeat(64), "sprint5-agent-prompt-v1", "agent-answer-v1", "mock", "myknow-mock", "local_only", timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO chat_sessions (id,knowledge_base_id,scope_snapshot,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(ids.session, null, scope, timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO chat_messages (id,session_id,role,content,status,agent_run_id,task_id,retrieval_run_ids,answer_json,created_at,updated_at) VALUES (?,?, 'user',?,'succeeded',NULL,NULL,'[]',NULL,?,?)").run(ids.userMessage, ids.session, "rebuild probe", timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO chat_messages (id,session_id,role,content,status,agent_run_id,task_id,retrieval_run_ids,answer_json,created_at,updated_at) VALUES (?,?, 'assistant',?,'succeeded',?,?, '[]',NULL,?,?)").run(ids.assistantMessage, ids.session, "rebuild answer", ids.run, ids.task, timestamp, timestamp);
    database.sqlite.prepare("INSERT INTO agent_events (id,run_id,sequence,event_type,stage,input_hash,output_hash,created_at) VALUES (?,?,0,'agent_start','agent',?,?,?)").run(ids.event, ids.run, "b".repeat(64), "c".repeat(64), timestamp);
    database.sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,metadata,created_at) VALUES (?,?,?,?,?,?)").run(ids.audit, "rebuild_probe", "agent_run", ids.run, JSON.stringify({ preserved: true }), timestamp);
  })();
  database.sqlite.close();

  const rebuilt = rebuildDatabase({ target: databaseFile, resourceStorageDir: storage });
  assert.equal(rebuilt.schemaVersion, "sprint5-agent-tree-v1");
  assert.equal(rebuilt.rawStoragePreserved, true);
  assert.equal(rebuilt.before.auditLogs, rebuilt.after.auditLogs);

  const restored = createDatabase(`file:${databaseFile}`);
  assert.equal(getAgentRun(restored.sqlite, ids.run).id, ids.run);
  assert.equal(getAgentEvents(restored.sqlite, ids.run).length, 1);
  assert.equal(getChatSession(restored.sqlite, ids.session, { includeMessages: true }).messages.length, 2);
  assert.equal(restored.sqlite.prepare("SELECT metadata FROM audit_logs WHERE id=?").get(ids.audit).metadata, JSON.stringify({ preserved: true }));
  assert.equal(restored.sqlite.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, "sprint5-agent-tree-v1");
  assert.equal(restored.sqlite.prepare("SELECT value FROM schema_meta WHERE key='derived_schema'").get().value, "sprint5-agent-tree-derived-ready");
  assert.equal(restored.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_page_citations'").get().name, "wiki_page_citations");
  restored.sqlite.close();
  console.log(JSON.stringify({ status: "passed", schema: rebuilt.schemaVersion, preserved: ["agent_runs", "agent_events", "chat_sessions", "chat_messages", "audit_logs"], derived: "rebuilt" }));
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (caught) {
    if (caught.code !== "EPERM") throw caught;
    const cleanup = "const fs=require('node:fs'); const target=process.argv[1]; setTimeout(() => { try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }, 250);";
    spawn(process.execPath, ["-e", cleanup, root], { detached: true, stdio: "ignore" }).unref();
  }
}
