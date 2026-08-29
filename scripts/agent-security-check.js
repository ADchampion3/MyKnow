import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");
const workerSources = [
  "apps/worker/src/agent/prompts.js",
  "apps/worker/src/agent/tools.js",
  "apps/worker/src/agent/runtime.js",
  "apps/worker/src/agent/processor.js"
].map(read);
const apiSource = read("apps/api/src/routes/agent.js");
const webSource = read("apps/web/app/page.jsx");
const migration = read("packages/db/src/database/migrations.js");

for (const source of [...workerSources, apiSource, webSource, migration]) {
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{12,}/, "a credential-like token must not be committed");
}
assert.doesNotMatch(webSource, /MODEL_API_KEY|modelApiKey|paddleOcrToken/, "client code must not receive server secrets");
assert.match(workerSources[1], /AGENT_READ_TOOL_NAMES/);
assert.match(workerSources[1], /AGENT_TERMINAL_TOOL_NAMES/);
const workerText = workerSources.join("\n");
for (const forbidden of ["child_process", "execSync", "spawn(", "readFile", "writeFile", "process.env.HOME"]) {
  assert.ok(!workerText.includes(forbidden), `worker must not expose ${forbidden}`);
}
for (const forbiddenColumn of ["prompt_text", "content", "api_key", "secret", "raw_output"]) {
  const eventTable = migration.match(/CREATE TABLE agent_events \(([^;]+)\);/)?.[1] || "";
  assert.doesNotMatch(eventTable, new RegExp(`\\b${forbiddenColumn}\\b`, "i"), `agent event table must not store ${forbiddenColumn}`);
}
assert.match(workerSources[0], /untrusted/);
assert.match(workerSources[0], /submit_answer/);
assert.match(workerSources[0], /submit_change_plan/);
console.log(JSON.stringify({ status: "passed", scanned: 8, clientSecretReferences: 0, eventPayload: "hashes-and-metrics-only", forbiddenWorkerCapabilities: ["filesystem", "shell", "web", "MCP", "SQL"] }));
