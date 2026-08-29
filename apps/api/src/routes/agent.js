import crypto from "node:crypto";
import {
  AGENT_PROMPT_VERSION,
  ANSWER_CONTRACT_VERSION,
  PLAN_CONTRACT_VERSION,
  agentPlanStatus,
  agentPlanItemView,
  agentRunView,
  approveAgentPlanBatch,
  approveAgentPlanBranch,
  approveAgentPlanItem,
  createScopeSnapshot,
  getAgentEvents,
  getAgentPlan,
  getAgentPlanTree,
  getAgentRun,
  getChatMessage,
  getChatSession,
  normalizePrompt,
  parseScopeSnapshot,
  rejectAgentPlanBranch,
  rejectAgentPlanItem,
  rollbackAgentPlanItem,
  scopeView,
  updateAgentPlanItem,
  now
} from "@myknow/db";

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const scopeBody = (body) => object(body?.scope || body);
const stableScope = (snapshot) => { const { createdAt, ...rest } = scopeView(snapshot); return rest; };
const scopeFieldPresent = (value) => ["knowledgeBaseId", "knowledge_base_id", "spaceId", "space_id", "resourceVersionIds", "resource_version_ids", "wikiPageIds", "wiki_page_ids", "retrievalRunId", "retrieval_run_id", "organizationMode", "organization_mode", "mountPageId", "mount_page_id"].some((key) => Object.hasOwn(value, key));
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const limitIdempotency = (key) => {
  if (key !== null && (typeof key !== "string" || !key || key.length > 200)) throw Object.assign(new Error("Idempotency-Key must be 1-200 characters"), { code: "VALIDATION_ERROR" });
  return key;
};
const stableTaskView = (ctx, id) => ctx.taskView(ctx.sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(id));

const existingRun = (sqlite, key, fingerprint) => {
  if (!key) return null;
  const row = sqlite.prepare("SELECT * FROM agent_runs WHERE idempotency_key=?").get(key);
  if (row && row.request_fingerprint !== fingerprint) throw Object.assign(new Error("Idempotency-Key was already used for another request"), { code: "IDEMPOTENCY_KEY_REUSED" });
  return row;
};

const createRun = (ctx, request, kind, prompt, snapshot, fingerprint) => {
  const { sqlite, config } = ctx;
  const idempotencyKey = limitIdempotency(request.idempotencyKey);
  const duplicate = existingRun(sqlite, idempotencyKey, fingerprint);
  if (duplicate) return { status: 200, idempotent: true, run: agentRunView(duplicate), task: stableTaskView(ctx, duplicate.task_id) };
  const runId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const timestamp = now();
  sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'queued',0,3,0,?,?)").run(taskId, `agent:${kind}`, JSON.stringify({ agentRunId: runId }), timestamp, timestamp);
    sqlite.prepare("INSERT INTO agent_runs (id,task_id,run_kind,knowledge_base_id,space_id,scope_snapshot,prompt_text,prompt_hash,prompt_version,contract_version,provider,model,egress_mode,status,metrics,result_json,idempotency_key,request_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued','{}',NULL,?,?,?,?)").run(runId, taskId, kind, snapshot.knowledgeBaseId, snapshot.spaceId, JSON.stringify(snapshot), prompt, hash(prompt), AGENT_PROMPT_VERSION, kind === "organize" ? PLAN_CONTRACT_VERSION : ANSWER_CONTRACT_VERSION, config.modelProvider, config.modelName, config.aiEgressMode, idempotencyKey, fingerprint, timestamp, timestamp);
    ctx.audit("queued", "agent_run", runId, request.requestId, { runKind: kind, taskId, scope: scopeView(snapshot) });
  })();
  return { status: 202, idempotent: false, run: getAgentRun(sqlite, runId), task: stableTaskView(ctx, taskId) };
};

const existingMessage = (sqlite, key, fingerprint) => {
  if (!key) return null;
  const row = sqlite.prepare("SELECT * FROM chat_messages WHERE idempotency_key=?").get(key);
  if (row && row.request_fingerprint !== fingerprint) throw Object.assign(new Error("Idempotency-Key was already used for another message"), { code: "IDEMPOTENCY_KEY_REUSED" });
  return row;
};

const createChatMessage = (ctx, request, session, content, snapshot, fingerprint) => {
  const { sqlite, config } = ctx;
  const idempotencyKey = limitIdempotency(request.idempotencyKey);
  const duplicate = existingMessage(sqlite, idempotencyKey, fingerprint);
  if (duplicate) {
    const assistant = sqlite.prepare("SELECT * FROM chat_messages WHERE agent_run_id=? AND role='assistant'").get(duplicate.agent_run_id);
    return { status: 200, idempotent: true, userMessage: getChatMessage(sqlite, duplicate.id), assistantMessage: getChatMessage(sqlite, assistant?.id), task: assistant?.task_id ? stableTaskView(ctx, assistant.task_id) : null, run: assistant?.agent_run_id ? getAgentRun(sqlite, assistant.agent_run_id) : null };
  }
  const runId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const timestamp = now();
  sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'queued',0,3,0,?,?)").run(taskId, "agent:answer", JSON.stringify({ agentRunId: runId }), timestamp, timestamp);
    sqlite.prepare("INSERT INTO agent_runs (id,task_id,run_kind,knowledge_base_id,space_id,scope_snapshot,prompt_text,prompt_hash,prompt_version,contract_version,provider,model,egress_mode,status,metrics,result_json,request_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued','{}',NULL,?,?,?)").run(runId, taskId, "answer", snapshot.knowledgeBaseId, snapshot.spaceId, JSON.stringify(snapshot), content, hash(content), AGENT_PROMPT_VERSION, ANSWER_CONTRACT_VERSION, config.modelProvider, config.modelName, config.aiEgressMode, fingerprint, timestamp, timestamp);
    sqlite.prepare("INSERT INTO chat_messages (id,session_id,role,content,status,agent_run_id,task_id,retrieval_run_ids,answer_json,idempotency_key,request_fingerprint,created_at,updated_at) VALUES (?,?, 'user',?,'succeeded',NULL,NULL,'[]',NULL,?,?,?,?)").run(userMessageId, session.id, content, request.idempotencyKey, fingerprint, timestamp, timestamp);
    sqlite.prepare("INSERT INTO chat_messages (id,session_id,role,content,status,agent_run_id,task_id,retrieval_run_ids,answer_json,created_at,updated_at) VALUES (?,?, 'assistant','', 'pending',?,?, '[]',NULL,?,?)").run(assistantMessageId, session.id, runId, taskId, timestamp, timestamp);
    sqlite.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(timestamp, session.id);
    ctx.audit("queued", "chat_message", assistantMessageId, request.requestId, { sessionId: session.id, agentRunId: runId, taskId, scope: scopeView(snapshot) });
  })();
  return { status: 202, idempotent: false, userMessage: getChatMessage(sqlite, userMessageId), assistantMessage: getChatMessage(sqlite, assistantMessageId), task: stableTaskView(ctx, taskId), run: getAgentRun(sqlite, runId) };
};

export const handleAgentRoutes = ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  const { sqlite } = ctx;

  if (pathname === "/api/agent/runs" && method === "POST") {
    const kind = body?.kind || body?.runKind || "organize";
    if (!["answer", "organize"].includes(kind)) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "kind must be answer or organize"), requestId); return true; }
    const prompt = normalizePrompt(body?.prompt);
    const rawScope = scopeBody(body);
    const snapshot = createScopeSnapshot(sqlite, { ...rawScope, organizationMode: body?.organizationMode ?? body?.organization_mode ?? body?.mode ?? (body?.tree === true ? "tree" : rawScope.organizationMode), mountPageId: body?.mountPageId ?? body?.mount_page_id ?? rawScope.mountPageId }, { allowEmpty: false, requireExplicit: true });
    const fingerprint = hash({ kind, prompt, scope: stableScope(snapshot) });
    const created = createRun(ctx, request, kind, prompt, snapshot, fingerprint);
    ctx.json(res, created.status, { agentRun: created.run, task: created.task, idempotent: created.idempotent }, null, requestId);
    return true;
  }

  const planMatch = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/plan$/);
  if (planMatch && method === "GET") {
    const run = getAgentRun(sqlite, planMatch[1]);
    if (!run) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Agent run not found"), requestId); return true; }
    ctx.json(res, 200, { items: getAgentPlan(sqlite, planMatch[1]), tree: getAgentPlanTree(sqlite, planMatch[1]), planStatus: agentPlanStatus(sqlite, planMatch[1]), organizationMode: run.organizationMode, mountPageId: run.mountPageId }, null, requestId);
    return true;
  }
  const eventsMatch = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    if (!getAgentRun(sqlite, eventsMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Agent run not found"), requestId); return true; }
    ctx.json(res, 200, { items: getAgentEvents(sqlite, eventsMatch[1]) }, null, requestId);
    return true;
  }
  const runMatch = pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = getAgentRun(sqlite, runMatch[1]);
    ctx.json(res, run ? 200 : 404, run, run ? null : ctx.error("NOT_FOUND", "Agent run not found"), requestId);
    return true;
  }

  const decisionMatch = pathname.match(/^\/api\/agent\/plan-items\/([^/]+)\/decision$/);
  if (decisionMatch && method === "POST") {
    const decision = body?.decision;
    let item;
    if (decision === "approve") item = approveAgentPlanItem(sqlite, ctx.config, decisionMatch[1], { actor: body?.actor || "local-user", requestId });
    else if (decision === "reject") item = rejectAgentPlanItem(sqlite, decisionMatch[1], { actor: body?.actor || "local-user", reason: body?.reason || "Rejected", requestId });
    else { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "decision must be approve or reject"), requestId); return true; }
    ctx.json(res, 200, item, null, requestId);
    return true;
  }
  const branchMatch = pathname.match(/^\/api\/agent\/plan-items\/([^/]+)\/branch-decision$/);
  if (branchMatch && method === "POST") {
    const decision = body?.decision;
    const options = { actor: body?.actor || "local-user", reason: body?.reason || "Rejected", requestId };
    const items = decision === "approve" ? approveAgentPlanBranch(sqlite, ctx.config, branchMatch[1], options) : decision === "reject" ? rejectAgentPlanBranch(sqlite, branchMatch[1], options) : null;
    if (!items) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "decision must be approve or reject"), requestId); return true; }
    const root = items.find((item) => item.id === branchMatch[1]) || items[0];
    ctx.json(res, 200, { root, items, planStatus: root ? agentPlanStatus(sqlite, root.runId) : null }, null, requestId);
    return true;
  }
  const editMatch = pathname.match(/^\/api\/agent\/plan-items\/([^/]+)$/);
  if (editMatch && method === "PATCH") {
    const item = updateAgentPlanItem(sqlite, ctx.config, editMatch[1], body, { actor: body?.actor || "local-user", requestId });
    ctx.json(res, 200, item, null, requestId);
    return true;
  }
  if (pathname === "/api/agent/plan-items/batch-decision" && method === "POST") {
    const itemIds = body?.itemIds || body?.planItemIds;
    const items = approveAgentPlanBatch(sqlite, ctx.config, itemIds, { actor: body?.actor || "local-user", requestId });
    ctx.json(res, 200, { items }, null, requestId);
    return true;
  }
  const rollbackMatch = pathname.match(/^\/api\/agent\/plan-items\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === "POST") {
    const item = rollbackAgentPlanItem(sqlite, ctx.config, rollbackMatch[1], { actor: body?.actor || "local-user", requestId });
    ctx.json(res, 200, item, null, requestId);
    return true;
  }

  if (pathname === "/api/chat/sessions" && method === "POST") {
    const rawScope = scopeBody(body);
    const snapshot = createScopeSnapshot(sqlite, rawScope, { allowEmpty: true, requireExplicit: Boolean(rawScope.knowledgeBaseId || rawScope.knowledge_base_id) });
    const id = crypto.randomUUID();
    const timestamp = now();
    sqlite.prepare("INSERT INTO chat_sessions (id,knowledge_base_id,scope_snapshot,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(id, snapshot.knowledgeBaseId, JSON.stringify(snapshot), timestamp, timestamp);
    ctx.audit("created", "chat_session", id, requestId, { scope: scopeView(snapshot) });
    ctx.json(res, 201, getChatSession(sqlite, id), null, requestId);
    return true;
  }
  const sessionMatch = pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    const session = getChatSession(sqlite, sessionMatch[1], { includeMessages: true });
    ctx.json(res, session ? 200 : 404, session, session ? null : ctx.error("NOT_FOUND", "Chat session not found"), requestId);
    return true;
  }
  const messageMatch = pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && method === "POST") {
    const session = sqlite.prepare("SELECT * FROM chat_sessions WHERE id=? AND status='active'").get(messageMatch[1]);
    if (!session) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Active chat session not found"), requestId); return true; }
    const content = normalizePrompt(body?.content ?? body?.prompt);
    const rawScope = scopeBody(body);
    const hasOverride = scopeFieldPresent(rawScope);
    let snapshot;
    if (hasOverride) {
      const merged = { ...rawScope };
      if (!merged.knowledgeBaseId && !merged.knowledge_base_id) merged.knowledgeBaseId = session.knowledge_base_id || undefined;
      snapshot = createScopeSnapshot(sqlite, merged, { allowEmpty: true, requireExplicit: Boolean(merged.knowledgeBaseId || merged.knowledge_base_id) });
    } else {
      snapshot = parseScopeSnapshot(session.scope_snapshot);
      if (snapshot.knowledgeBaseId && !snapshot.resourceVersions?.length && !snapshot.wikiPages?.length && !snapshot.retrievalRunIds?.length) throw Object.assign(new Error("a scoped chat message needs explicit resource, page, or retrieval-run IDs"), { code: "AGENT_SCOPE_INVALID" });
    }
    const fingerprint = hash({ sessionId: session.id, content, scope: stableScope(snapshot) });
    const created = createChatMessage(ctx, request, session, content, snapshot, fingerprint);
    ctx.json(res, created.status, { userMessage: created.userMessage, assistantMessage: created.assistantMessage, task: created.task, agentRun: created.run, idempotent: created.idempotent }, null, requestId);
    return true;
  }
  const chatMessageMatch = pathname.match(/^\/api\/chat\/messages\/([^/]+)$/);
  if (chatMessageMatch && method === "GET") {
    const message = getChatMessage(sqlite, chatMessageMatch[1]);
    ctx.json(res, message ? 200 : 404, message, message ? null : ctx.error("NOT_FOUND", "Chat message not found"), requestId);
    return true;
  }
  return false;
};
