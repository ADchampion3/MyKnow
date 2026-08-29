import crypto from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createProvider, envApiKeyAuth, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { agentToolNamesFor } from "./tools.js";

const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const normalizedProvider = (value) => ["ds", "deepseek"].includes(String(value).toLowerCase()) ? "deepseek" : String(value || "mock").trim().toLowerCase();
const defaultBaseUrl = (provider) => provider === "deepseek" ? "https://api.deepseek.com" : "http://localhost:11434/v1";
const isLocalUrl = (value) => {
  try { return localHosts.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
};
const jsonParse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const lastUserPrompt = (context) => [...(context.messages || [])].reverse().find((message) => message.role === "user")?.content?.map?.((part) => part.type === "text" ? part.text : "").join(" ") || "整理当前范围";
const toolResults = (context) => (context.messages || []).filter((message) => message.role === "toolResult").map((message) => ({ name: message.toolName, value: jsonParse(message.content?.find?.((part) => part.type === "text")?.text || "{}", {}) }));

const mockFactory = ({ kind, snapshot }) => async (context) => {
  const scope = snapshot;
  const results = toolResults(context);
  const has = (name) => results.some((item) => item.name === name);
  const last = (name) => [...results].reverse().find((item) => item.name === name)?.value;
  if (kind === "answer") {
    if (scope.knowledgeBaseId && !has("search_knowledge")) return fauxAssistantMessage(fauxToolCall("search_knowledge", { query: lastUserPrompt(context) }), { stopReason: "toolUse" });
    const search = last("search_knowledge");
    const raw = search?.items?.raw?.[0];
    const evidence = raw?.resourceVersionId ? [{ resourceVersionId: raw.resourceVersionId, locator: raw.locator || { chunkId: raw.chunkId }, role: "supporting" }] : [];
    const status = search?.evidenceStatus || (scope.knowledgeBaseId ? "no_match" : "none");
    const answer = raw?.snippet ? `根据选定的 MyKnow 证据：\n\n${raw.snippet}` : scope.knowledgeBaseId ? "在选定的 MyKnow 范围内没有匹配证据。" : `这是本地 mock 对“${lastUserPrompt(context)}”的回答。`;
    return fauxAssistantMessage(fauxToolCall("submit_answer", { answerMarkdown: answer, evidence, modelSupplement: scope.knowledgeBaseId ? "" : "这是 mock 模型补充，未使用 MyKnow 引用。", openQuestions: [], evidenceStatus: status }), { stopReason: "toolUse" });
  }
  if (scope.wikiPages?.length && !has("read_wiki_page") && !has("search_knowledge")) return fauxAssistantMessage(fauxToolCall("read_wiki_page", { wikiPageId: scope.wikiPages[0].id }), { stopReason: "toolUse" });
  if (scope.knowledgeBaseId && !has("search_knowledge")) return fauxAssistantMessage(fauxToolCall("search_knowledge", { query: lastUserPrompt(context) }), { stopReason: "toolUse" });
  const search = last("search_knowledge");
  const raw = search?.items?.raw?.[0];
  const page = last("read_wiki_page");
  const userPrompt = lastUserPrompt(context);
  const citation = raw?.resourceVersionId ? [{ resourceVersionId: raw.resourceVersionId, locator: raw.locator || { chunkId: raw.chunkId }, role: "supporting" }] : [];
  if (/\bconflict-plan\b/.test(userPrompt)) {
    const conflictCitations = (search?.items?.raw || []).slice(0, 2).map((item) => ({ resourceVersionId: item.resourceVersionId, locator: item.locator || { chunkId: item.chunkId }, role: "supporting" }));
    return fauxAssistantMessage(fauxToolCall("submit_change_plan", { items: [{ itemType: "conflict_finding", proposed: { summary: "Two source versions contain a fact that requires human conflict review." }, citations: conflictCitations }] }), { stopReason: "toolUse" });
  }
  if (/\btag-plan\b/.test(userPrompt) && scope.wikiPages?.length) {
    const tagNames = /\btag-batch\b/.test(userPrompt) ? ["reviewed", "approved"] : ["reviewed"];
    return fauxAssistantMessage(fauxToolCall("submit_change_plan", { items: tagNames.map((tagName) => ({ itemType: "tag_add", targetPageId: scope.wikiPages[0].id, proposed: { tagName }, citations: [] })) }), { stopReason: "toolUse" });
  }
  if (scope.wikiPages?.length && scope.organizationMode !== "tree") {
    const selected = scope.wikiPages[0];
    return fauxAssistantMessage(fauxToolCall("submit_change_plan", { items: [{ itemType: "page_update", targetPageId: selected.id, basePageVersionId: selected.pageVersionId, proposed: { title: page?.title || selected.title, pageType: page?.pageType || selected.pageType, contentMarkdown: `${page?.contentMarkdown || "# Agent note"}\n\n## Agent note\n\n${raw?.snippet || "待补充证据。"}` }, citations: citation }] }), { stopReason: "toolUse" });
  }
  if (scope.organizationMode === "tree") {
    const snippet = raw?.snippet || "待补充证据。";
    const items = [
      { itemType: "page_create", nodeId: "root", parentNodeId: null, nodeRole: "root", proposed: { title: "Knowledge map", pageType: "synthesis", contentMarkdown: `# Knowledge map\n\n## Answer\n\n${snippet}` }, citations: citation },
      { itemType: "page_create", nodeId: "topic", parentNodeId: "root", nodeRole: "category", proposed: { title: "Core topic", pageType: "concept", contentMarkdown: `# Core topic\n\n## Definition\n\n${snippet}` }, citations: citation },
      { itemType: "page_create", nodeId: "source", parentNodeId: "topic", nodeRole: "source", proposed: { title: "Source summary", pageType: "source-summary", contentMarkdown: `# Source summary\n\n## Summary\n\n${snippet}` }, citations: citation }
    ];
    return fauxAssistantMessage(fauxToolCall("submit_change_plan", { items }), { stopReason: "toolUse" });
  }
  const requestedPlanItems = Math.max(1, Math.min(20, Number(lastUserPrompt(context).match(/\bscale-plan-(\d+)\b/)?.[1] || 1)));
  const items = Array.from({ length: requestedPlanItems }, (_, index) => ({ itemType: "page_create", proposed: { title: `Agent source summary ${index + 1}`, pageType: "source-summary", spaceId: scope.spaceId || undefined, contentMarkdown: `# Agent source summary ${index + 1}\n\n${raw?.snippet || "待补充证据。"}` }, citations: citation }));
  return fauxAssistantMessage(fauxToolCall("submit_change_plan", { items }), { stopReason: "toolUse" });
};

const createMockRuntime = ({ kind, snapshot, tools }) => {
  const faux = fauxProvider({ provider: "myknow-mock", models: [{ id: "myknow-mock", name: "MyKnow Mock", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }] });
  faux.setResponses(Array.from({ length: 8 }, () => mockFactory({ kind, snapshot })));
  return { provider: faux.provider, model: faux.getModel(), streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options), tools };
};

const createModelRuntime = (config, tools) => {
  const providerId = normalizedProvider(config.modelProvider);
  const baseUrl = config.modelApiBaseUrl || defaultBaseUrl(providerId);
  if (config.aiEgressMode === "local_only" && !isLocalUrl(baseUrl)) throw Object.assign(new Error("cloud model egress is disabled by AI_EGRESS_MODE=local_only"), { code: "MODEL_EGRESS_BLOCKED" });
  if (!config.modelApiKey && !isLocalUrl(baseUrl)) throw Object.assign(new Error("MODEL_API_KEY is not configured"), { code: "PROVIDER_AUTH_MISSING" });
  const model = { id: config.modelName, name: config.modelName, api: "openai-completions", provider: providerId, baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const provider = createProvider({ id: providerId, name: providerId, baseUrl, auth: { apiKey: envApiKeyAuth("MyKnow model API key", ["MODEL_API_KEY"]) }, models: [model], api: openAICompletionsApi() });
  return { provider, model, streamFn: (requestModel, context, options = {}) => provider.streamSimple(requestModel, context, { ...options, apiKey: config.modelApiKey || undefined, maxRetries: 0, timeoutMs: config.agentTimeoutMs }) , tools };
};

export const createAgentRuntime = ({ config, kind, snapshot, tools, systemPrompt = "", onEvent = () => {}, onProvider = () => {} }) => {
  const runtime = normalizedProvider(config.modelProvider) === "mock" ? createMockRuntime({ kind, snapshot, tools }) : createModelRuntime(config, tools);
  let turns = 0;
  let toolCalls = 0;
  const allowed = new Set(agentToolNamesFor(kind));
  const agent = new Agent({
    initialState: { systemPrompt, model: runtime.model, thinkingLevel: "off", tools },
    streamFn: runtime.streamFn,
    toolExecution: "sequential",
    onPayload: async (payload) => { onProvider("provider_started", { inputHash: cryptoHash(payload) }); },
    onResponse: async (response) => { onProvider("provider_finished", { status: response?.status || 0 }); },
    beforeToolCall: async ({ toolCall }) => {
      if (!allowed.has(toolCall.name)) return { block: true, terminate: true, reason: "Tool is not allowlisted for this run" };
      toolCalls += 1;
      if (toolCalls > config.agentMaxToolCalls) return { block: true, terminate: true, reason: "Tool call limit reached" };
      return undefined;
    },
    shouldStopAfterTurn: async () => turns >= config.agentMaxTurns
  });
  agent.subscribe(async (event) => {
    if (event.type === "turn_start") turns += 1;
    onEvent(event);
  });
  const run = async (prompt, signal) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; agent.abort(); }, config.agentTimeoutMs);
    const abort = () => agent.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await agent.prompt(prompt);
      if (timedOut) throw Object.assign(new Error("Agent task timed out"), { code: "PROCESSING_TIMEOUT" });
      if (signal?.aborted) throw Object.assign(new Error("Agent task was cancelled"), { code: "TASK_CANCELLED" });
      if (agent.state.errorMessage) {
        const message = agent.state.errorMessage;
        const transient = /\b(429|5\d\d|timeout|timed out|temporar|network|fetch failed)\b/i.test(message);
        throw Object.assign(new Error(message), { code: transient ? "TRANSIENT_ERROR" : "PROVIDER_FAILED" });
      }
    } catch (caught) {
      onProvider("provider_failed", { errorCode: caught?.code || "PROVIDER_FAILED" });
      throw caught;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    return { turns, toolCalls, state: agent.state };
  };
  return { agent, run, model: runtime.model, provider: runtime.provider, stats: () => ({ turns, toolCalls }) };
};

const cryptoHash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
