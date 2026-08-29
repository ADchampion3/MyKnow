import assert from "node:assert/strict";
import http from "node:http";
import { createDatabase, createScopeSnapshot, migrate } from "@myknow/db";
import { createAgentRuntime } from "../apps/worker/src/agent/runtime.js";
import { createAgentTools } from "../apps/worker/src/agent/tools.js";

const { sqlite } = createDatabase(":memory:");
migrate(sqlite);
const snapshot = createScopeSnapshot(sqlite, {}, { allowEmpty: true });
const seen = { requests: 0, authorization: false, path: "" };
const server = http.createServer((req, res) => {
  seen.requests += 1;
  seen.authorization = seen.authorization || req.headers.authorization === "Bearer test-provider-key";
  seen.path = req.url || "";
  req.resume();
  req.on("end", () => {
    const argumentsJson = JSON.stringify({ answerMarkdown: "provider contract passed", evidence: [], modelSupplement: "", openQuestions: [], evidenceStatus: "none" });
    const chunks = [
      { id: "fake-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-submit", type: "function", function: { name: "submit_answer", arguments: argumentsJson } }] }, finish_reason: "tool_calls" }] }
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const config = { modelProvider: "fake", modelName: "fake-model", modelApiBaseUrl: `http://127.0.0.1:${address.port}/v1`, modelApiKey: "test-provider-key", aiEgressMode: "local_only", agentMaxTurns: 8, agentMaxToolCalls: 32, agentTimeoutMs: 10_000, resourceStorageDir: "." };
  const holder = { value: null };
  const tools = createAgentTools({ sqlite, config, snapshot, holder, kind: "answer", audit: () => {} });
  const runtime = createAgentRuntime({ config, kind: "answer", snapshot, tools, systemPrompt: "Submit the answer." });
  const result = await runtime.run("say hello", new AbortController().signal);
  assert.equal(holder.value.answerMarkdown, "provider contract passed");
  assert.equal(seen.requests, 1);
  assert.equal(seen.authorization, true);
  assert.match(seen.path, /chat\/completions/);
  assert.throws(() => createAgentRuntime({ config: { ...config, modelApiBaseUrl: "https://api.deepseek.com", aiEgressMode: "local_only" }, kind: "answer", snapshot, tools }), (caught) => caught.code === "MODEL_EGRESS_BLOCKED");
  assert.throws(() => createAgentRuntime({ config: { ...config, modelApiBaseUrl: "https://api.deepseek.com", aiEgressMode: "allow_cloud", modelApiKey: "" }, kind: "answer", snapshot, tools }), (caught) => caught.code === "PROVIDER_AUTH_MISSING");
  console.log(JSON.stringify({ provider: "openai-compatible", requests: seen.requests, authorizationObserved: seen.authorization, pathChecked: true, egressMode: config.aiEgressMode, turns: result.turns, blockedCloudEgress: true, missingKeyRejected: true }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  sqlite.close();
}
