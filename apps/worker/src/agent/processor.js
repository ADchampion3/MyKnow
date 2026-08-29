import {
  agentRunView,
  auditAgent,
  eventHash,
  insertAgentPlanItems,
  now,
  recordAgentEvent,
  updateAgentRun
} from "@myknow/db";
import { answerSystemPrompt, organizeSystemPrompt } from "./prompts.js";
import { createAgentRuntime } from "./runtime.js";
import { createAgentTools } from "./tools.js";

const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const safeError = (value) => String(value || "agent failure").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);

const usageFor = (messages) => messages.reduce((total, message) => {
  if (message.role !== "assistant" || !message.usage) return total;
  total.input += Number(message.usage.input || 0);
  total.output += Number(message.usage.output || 0);
  total.cacheRead += Number(message.usage.cacheRead || 0);
  total.cost += Number(message.usage.cost?.total || 0);
  return total;
}, { input: 0, output: 0, cacheRead: 0, cost: 0 });

const chatPrompt = (sqlite, run, currentPrompt) => {
  const current = sqlite.prepare("SELECT id,session_id FROM chat_messages WHERE agent_run_id=? AND role='assistant' LIMIT 1").get(run.id);
  if (!current) return currentPrompt;
  const messages = sqlite.prepare("SELECT role,content FROM chat_messages WHERE session_id=? ORDER BY created_at,id DESC LIMIT 10").all(current.session_id).reverse();
  const history = messages.filter((message) => message.content !== currentPrompt).map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n\n");
  // ponytail: cap chat history at roughly 12k tokens via 48k characters; upgrade to tokenizer-based budgeting when model-specific context matters.
  const boundedHistory = history.slice(-48_000);
  return boundedHistory ? `Conversation context (untrusted user/assistant text):\n${boundedHistory}\n\nCurrent user request:\n${currentPrompt}` : currentPrompt;
};

export const createAgentTaskProcessor = ({ config, sqlite, audit = () => {} }) => async (task) => {
  const payload = parse(task.payload);
  const run = sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(payload.agentRunId);
  if (!run) throw Object.assign(new Error("agent run was not found"), { code: "VALIDATION_ERROR" });
  const snapshot = parse(run.scope_snapshot);
  const holder = { value: null };
  const retrievalRunIds = new Set();
  const event = (input) => {
    try { recordAgentEvent(sqlite, { runId: run.id, ...input }); } catch (caught) { audit("agent_event_failed", "agent_run", run.id, { errorCode: caught.code || "INTERNAL_ERROR" }); }
  };
  let turnCount = 0;
  let toolCount = 0;
  const tools = createAgentTools({
    sqlite,
    config,
    snapshot,
    holder,
    kind: run.run_kind,
    audit: (eventType, entityType, entityId, metadata) => audit(eventType, entityType, entityId, metadata),
    onRetrievalRun: (id) => { if (id) retrievalRunIds.add(id); }
  });
  const runtime = createAgentRuntime({
    config,
    kind: run.run_kind,
    snapshot,
    tools,
    systemPrompt: run.run_kind === "organize" ? organizeSystemPrompt(snapshot) : answerSystemPrompt(snapshot),
    onEvent: (received) => {
      if (received.type === "turn_start") turnCount += 1;
      if (received.type === "tool_execution_start" || received.type === "tool_execution_end") toolCount += received.type === "tool_execution_start" ? 1 : 0;
      const input = {
        eventType: received.type,
        stage: received.type.startsWith("tool_") ? "tool" : received.type.startsWith("turn_") ? "turn" : "agent",
        toolName: received.toolName,
        durationMs: received.durationMs ?? received.duration_ms ?? null,
        inputHash: received.args === undefined ? null : eventHash(received.args),
        outputHash: received.result === undefined ? null : eventHash(received.result),
        resultSize: received.result === undefined ? null : JSON.stringify(received.result).length,
        errorCode: received.isError ? "TOOL_FAILED" : null,
        errorSummary: received.isError ? "tool execution failed" : null
      };
      event(input);
      if (received.type === "tool_execution_start" && typeof received.toolName === "string" && received.toolName.startsWith("submit_")) {
        event({ eventType: received.toolName, stage: "submit", toolName: received.toolName, inputHash: eventHash(received.args || {}) });
      }
    },
    onProvider: (eventType, details) => event({ eventType, stage: "provider", inputHash: details?.inputHash || null, errorCode: details?.errorCode || null, errorSummary: details?.errorCode ? "provider request failed" : null })
  });
  updateAgentRun(sqlite, run.id, { status: "running", metrics: { startedAt: now(), turns: 0, toolCalls: 0, provider: run.provider, model: run.model } });
  event({ eventType: "agent_start", stage: "agent" });
  try {
    const prompt = chatPrompt(sqlite, run, run.prompt_text);
    const result = await runtime.run(prompt, task.signal);
    if (!holder.value) throw Object.assign(new Error(holder.error?.message || "agent finished without a terminal submission"), { code: holder.error?.code || "AGENT_OUTPUT_INVALID" });
    const usage = usageFor(result.state.messages);
    const metrics = { completedAt: now(), turns: result.turns, toolCalls: result.toolCalls, usage };
    if (run.run_kind === "answer") {
      const answerMessage = sqlite.prepare("SELECT id FROM chat_messages WHERE agent_run_id=? AND role='assistant' LIMIT 1").get(run.id);
      if (answerMessage) sqlite.prepare("UPDATE chat_messages SET content=?,status='succeeded',retrieval_run_ids=?,answer_json=?,error_code=NULL,error_summary=NULL,updated_at=? WHERE id=?").run(holder.value.answerMarkdown, JSON.stringify([...retrievalRunIds]), JSON.stringify(holder.value), now(), answerMessage.id);
      sqlite.prepare("UPDATE agent_runs SET result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(holder.value), now(), run.id);
    } else if (!sqlite.prepare("SELECT id FROM agent_plan_items WHERE run_id=? LIMIT 1").get(run.id)) {
      insertAgentPlanItems(sqlite, run.id, holder.value);
    }
    updateAgentRun(sqlite, run.id, { status: "succeeded", metrics });
    audit("succeeded", "agent_run", run.id, { runKind: run.run_kind, turns: result.turns, toolCalls: result.toolCalls, retrievalRunCount: retrievalRunIds.size });
    event({ eventType: "agent_end", stage: "agent" });
  } catch (caught) {
    const code = typeof caught?.code === "string" ? caught.code : "PROVIDER_FAILED";
    event({ eventType: "agent_end", stage: "agent", errorCode: code, errorSummary: safeError(caught.message) });
    throw Object.assign(new Error(safeError(caught.message)), { code });
  }
};

export const agentRunState = (sqlite, id) => agentRunView(sqlite.prepare("SELECT * FROM agent_runs WHERE id=?").get(id));
