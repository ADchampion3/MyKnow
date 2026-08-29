import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidenceDir = path.join(root, "artifacts", "sprint5");
fs.mkdirSync(evidenceDir, { recursive: true });
const redact = (value) => String(value || "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
const windowsShell = process.env.ComSpec || "cmd.exe";
const quoteCmdArg = (value) => {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
};
const run = (name, command, args, env = {}) => {
  const useWindowsNpm = command === "npm" && process.platform === "win32";
  const executable = useWindowsNpm ? windowsShell : command;
  const spawnArgs = useWindowsNpm ? ["/d", "/s", "/c", ["npm.cmd", ...args].map(quoteCmdArg).join(" ")] : args;
  const result = spawnSync(executable, spawnArgs, {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, MODEL_PROVIDER: "mock", MODEL_API_KEY: "", AI_EGRESS_MODE: "local_only", ...env }
  });
  const output = redact(`${result.stdout || ""}${result.stderr || ""}`).trim();
  if (result.error) throw Object.assign(new Error(`${name}: ${result.error.message}\n${output}`), { cause: result.error });
  if (result.status !== 0) throw new Error(`${name} exited ${result.status}\n${output}`);
  const jsonLine = output.split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
  let summary = null;
  if (jsonLine) {
    try { summary = JSON.parse(jsonLine); } catch {}
  }
  return { name, command: `${command} ${args.join(" ")}`, output, summary };
};
const nodeVersion = process.version;
const npmExecutable = process.platform === "win32" ? windowsShell : "npm";
const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd --version"] : ["--version"];
const npmVersion = redact(execFileSync(npmExecutable, npmArgs, { cwd: root, encoding: "utf8" }).trim());
const commit = redact(execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
const realProviderFile = path.join(evidenceDir, "deepseek-provider.json");
const realProvider = fs.existsSync(realProviderFile) ? JSON.parse(fs.readFileSync(realProviderFile, "utf8")) : null;
const checks = [];
try {
  checks.push(run("agent-contract", process.execPath, ["scripts/agent-contract.js"]));
  checks.push(run("agent-provider", process.execPath, ["scripts/agent-provider-check.js"]));
  checks.push(run("agent-tree", process.execPath, ["scripts/agent-tree-check.js"]));
  checks.push(run("agent-review", process.execPath, ["scripts/agent-review-check.js"]));
  checks.push(run("agent-scale", process.execPath, ["scripts/agent-scale-check.js"]));
  checks.push(run("agent-advanced", process.execPath, ["scripts/agent-advanced-check.js"]));
  checks.push(run("open-chat", process.execPath, ["scripts/chat-open-check.js"]));
  checks.push(run("agent-rebuild", process.execPath, ["scripts/agent-rebuild-check.js"]));
  checks.push(run("agent-security", process.execPath, ["scripts/agent-security-check.js"]));
  checks.push(run("sprint5-layout", process.execPath, ["scripts/sprint5-layout-check.js"]));
  checks.push(run("web-build", "npm", ["run", "build", "--workspace", "apps/web"]));

  const byName = new Map(checks.map((check) => [check.name, check]));
  fs.writeFileSync(path.join(evidenceDir, "agent-plan-review.jsonl"), `${JSON.stringify(byName.get("agent-review").summary)}\n${JSON.stringify(byName.get("agent-scale").summary)}\n${JSON.stringify(byName.get("agent-advanced").summary)}\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "agent-tree.jsonl"), `${JSON.stringify(byName.get("agent-tree").summary)}\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "open-chat.jsonl"), `${JSON.stringify(byName.get("open-chat").summary)}\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "agent-events.jsonl"), `${JSON.stringify({ source: "open-chat", eventCount: byName.get("open-chat").summary?.eventCount, hashesOnly: true })}\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "provider-evidence.log"), `${byName.get("agent-provider").output}\n\nDeepSeek real-provider check: ${realProvider ? JSON.stringify(realProvider) : "not run; use scripts/deepseek-api-check.js with a process-only MODEL_API_KEY"}. No key is stored here.\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "migration-rebuild.log"), `${byName.get("agent-rebuild").output}\n`, "utf8");
  fs.writeFileSync(path.join(evidenceDir, "security-scan.log"), `${byName.get("agent-security").output}\n`, "utf8");
  const lines = [
    "# Sprint 5 acceptance report",
    "",
    `- Status: passed (local mock/provider contract gate)`,
    `- Date: ${new Date().toISOString()} (UTC; local timezone Asia/Shanghai)`,
    `- Node: ${nodeVersion}`,
    `- npm: ${npmVersion}`,
    `- Commit under test: ${commit}`,
    "- Database: each focused check uses an isolated temporary SQLite database.",
    "- Resource storage: each focused check uses an isolated temporary storage directory.",
    "- API key: not recorded; local checks force MODEL_API_KEY to an empty value.",
    "",
    "## Passed checks",
    "",
    ...checks.map((check) => `- ${check.name}: passed`),
    "",
    "## Provider boundary",
    "",
    "- Mock Agent and a local OpenAI-compatible SSE provider are covered by the focused gate.",
    `- Real DeepSeek check: ${realProvider ? `${realProvider.status} (${realProvider.model}, evidenceStatus=${realProvider.evidenceStatus})` : "not run by this local gate"}.`,
    "- Tree mode is covered by explicit source selection, bounded node validation, transactional branch review, and archive-safe rollback."
  ];
  fs.writeFileSync(path.join(evidenceDir, "acceptance-report.md"), `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ status: "passed", checks: checks.map((check) => check.name), evidenceDir: "artifacts/sprint5", realProvider: realProvider?.status || "not-run-by-local-gate" }));
} catch (caught) {
  const message = redact(caught.stack || caught.message);
  fs.writeFileSync(path.join(evidenceDir, "acceptance-report.md"), `# Sprint 5 acceptance report\n\n- Status: failed\n- Date: ${new Date().toISOString()}\n- Error: ${message}\n`, "utf8");
  console.error(message);
  process.exitCode = 1;
}
