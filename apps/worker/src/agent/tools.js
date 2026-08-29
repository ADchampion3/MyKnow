import { Type } from "@earendil-works/pi-ai";
import {
  AGENT_READ_TOOL_NAMES,
  AGENT_TERMINAL_TOOL_NAMES,
  listWikiCitations,
  readRawChunk,
  readResourceVersion,
  readRetrievalRun,
  readWikiPage,
  searchKnowledge,
  validateAnswerOutput,
  validatePlanOutput
} from "@myknow/db";

const jsonText = (value) => JSON.stringify(value);
const result = (value, details = {}) => ({ content: [{ type: "text", text: jsonText(value) }], details });
const locator = Type.Record(Type.String(), Type.Any());
const citation = Type.Object({ resourceVersionId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), wikiPageVersionId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), wikiPageId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), locator: Type.Optional(locator), sourceBlockKey: Type.Optional(Type.String({ maxLength: 100 })), role: Type.Optional(Type.String({ maxLength: 40 })), blockKey: Type.Optional(Type.String({ maxLength: 100 })) });

const readResourceSchema = Type.Object({
  resourceVersionId: Type.String({ minLength: 1, maxLength: 80 }),
  startOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  endOffset: Type.Optional(Type.Integer({ minimum: 1 }))
});

export const createAgentTools = ({ sqlite, config, snapshot, holder, kind, audit, onRetrievalRun = () => {} }) => {
  const executeRead = async (toolName, callback, toolCallId, params, signal) => {
    if (signal?.aborted) throw Object.assign(new Error("Agent task was cancelled"), { code: "TASK_CANCELLED" });
    const value = await callback(params);
    return result(value, { toolName, toolCallId });
  };
  const tools = [
    {
      name: "search_knowledge",
      label: "Search MyKnow",
      description: "Search only the explicitly captured MyKnow snapshot and return scoped evidence.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }) }),
      execute: (toolCallId, params, signal) => executeRead("search_knowledge", async () => {
        const value = await searchKnowledge({ sqlite, config, snapshot, query: params.query, onAudit: (eventType, trace) => audit(eventType, "retrieval_run", trace.traceId, { status: trace.status, evidenceStatus: trace.raw?.results?.length || trace.wiki?.seeds?.length ? "used" : "no_match" }) });
        onRetrievalRun(value.retrievalRunId);
        return value;
      }, toolCallId, params, signal)
    },
    {
      name: "read_resource_version",
      label: "Read resource version",
      description: "Read text from one resource version in the immutable run scope.",
      parameters: readResourceSchema,
      execute: (toolCallId, params, signal) => executeRead("read_resource_version", () => readResourceVersion({ sqlite, config, snapshot, ...params }), toolCallId, params, signal)
    },
    {
      name: "read_raw_chunk",
      label: "Read raw chunk",
      description: "Read one indexed raw chunk in the immutable run scope.",
      parameters: Type.Object({ chunkId: Type.String({ minLength: 1, maxLength: 80 }) }),
      execute: (toolCallId, params, signal) => executeRead("read_raw_chunk", () => readRawChunk({ sqlite, snapshot, ...params }), toolCallId, params, signal)
    },
    {
      name: "read_wiki_page",
      label: "Read Wiki page",
      description: "Read the exact captured Wiki page version in the run scope.",
      parameters: Type.Object({ wikiPageId: Type.String({ minLength: 1, maxLength: 80 }) }),
      execute: (toolCallId, params, signal) => executeRead("read_wiki_page", () => readWikiPage({ sqlite, snapshot, ...params }), toolCallId, params, signal)
    },
    {
      name: "read_retrieval_run",
      label: "Read retrieval trace",
      description: "Read one previously captured retrieval trace in the run scope.",
      parameters: Type.Object({ retrievalRunId: Type.String({ minLength: 1, maxLength: 80 }) }),
      execute: (toolCallId, params, signal) => executeRead("read_retrieval_run", () => readRetrievalRun({ sqlite, snapshot, ...params }), toolCallId, params, signal)
    },
    {
      name: "list_wiki_citations",
      label: "List Wiki citations",
      description: "List citations attached to the exact captured Wiki page version.",
      parameters: Type.Object({ wikiPageId: Type.String({ minLength: 1, maxLength: 80 }) }),
      execute: (toolCallId, params, signal) => executeRead("list_wiki_citations", () => listWikiCitations({ sqlite, snapshot, ...params }), toolCallId, params, signal)
    }
  ];
  if (kind === "answer") {
    tools.push({
      name: "submit_answer",
      label: "Submit answer",
      description: "Finish the run with the validated answer contract. This is the only terminal answer tool.",
      parameters: Type.Object({
        answerMarkdown: Type.String({ minLength: 1, maxLength: 100000 }),
        evidence: Type.Optional(Type.Array(citation, { maxItems: 100 })),
        modelSupplement: Type.Optional(Type.String({ maxLength: 100000 })),
        openQuestions: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
        evidenceStatus: Type.Optional(Type.String({ maxLength: 32 }))
      }),
      execute: async (toolCallId, params, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Agent task was cancelled"), { code: "TASK_CANCELLED" });
        let answer;
        try { answer = validateAnswerOutput(sqlite, config, snapshot, params); }
        catch (caught) { holder.error = { code: caught.code || "AGENT_OUTPUT_INVALID", message: caught.message }; throw caught; }
        holder.value = answer;
        return { ...result({ accepted: true, evidenceCount: answer.evidence.length, evidenceStatus: answer.evidenceStatus }, { toolName: "submit_answer", toolCallId, evidenceCount: answer.evidence.length }), terminate: true };
      }
    });
  } else {
    tools.push({
      name: "submit_change_plan",
      label: "Submit change plan",
      description: "Finish the run with reviewable Wiki/tag recommendations. The server validates and applies nothing here.",
      parameters: Type.Object({
        items: Type.Array(Type.Object({
          itemType: Type.String({ minLength: 1, maxLength: 32 }),
          targetPageId: Type.Optional(Type.String({ maxLength: 80 })),
          basePageVersionId: Type.Optional(Type.String({ maxLength: 80 })),
          nodeId: Type.Optional(Type.String({ maxLength: 80 })),
          parentNodeId: Type.Optional(Type.String({ maxLength: 80 })),
          nodeRole: Type.Optional(Type.String({ maxLength: 20 })),
          proposed: Type.Optional(Type.Record(Type.String(), Type.Any())),
          citations: Type.Optional(Type.Array(citation, { maxItems: 100 }))
        }), { maxItems: 100 })
      }),
      execute: async (toolCallId, params, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Agent task was cancelled"), { code: "TASK_CANCELLED" });
        let plan;
        try { plan = validatePlanOutput(sqlite, config, snapshot, params); }
        catch (caught) { holder.error = { code: caught.code || "AGENT_OUTPUT_INVALID", message: caught.message }; throw caught; }
        holder.value = plan;
        return { ...result({ accepted: true, itemCount: plan.items.length, evidenceStatuses: plan.items.map((item) => item.evidenceStatus) }, { toolName: "submit_change_plan", toolCallId, itemCount: plan.items.length }), terminate: true };
      }
    });
  }
  return tools;
};

export const agentToolNamesFor = (kind) => [...AGENT_READ_TOOL_NAMES, ...(kind === "answer" ? [AGENT_TERMINAL_TOOL_NAMES[0]] : [AGENT_TERMINAL_TOOL_NAMES[1]])];
