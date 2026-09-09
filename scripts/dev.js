import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@myknow/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig();
// ponytail: this local-only supervisor is the ceiling for development; use a real process manager for production supervision.
const services = [
  { name: "api", entry: "apps/api/src/nest.js" },
  { name: "worker", entry: "apps/worker/src/index.js" },
  { name: "web", entry: "apps/web/src/index.js" }
];

const children = [];
let stopping = false;

const forwardOutput = (name, source, target) => {
  let lineStart = true;
  source.on("data", (chunk) => {
    let output = "";
    for (const character of chunk.toString()) {
      if (lineStart) {
        output += `[${name}] `;
        lineStart = false;
      }
      output += character;
      if (character === "\n") lineStart = true;
    }
    target.write(output);
  });
};

const stop = (exitCode) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  const timer = setTimeout(() => process.exit(exitCode), 2_000);
  timer.unref();
};

console.log(`MyKnow dev stack: Web http://localhost:${config.webPort} | API http://localhost:${config.apiPort}/health`);
console.log("Press Ctrl+C to stop API, Worker and Web together.");

for (const service of services) {
  const child = spawn(process.execPath, [path.join(repoRoot, service.entry)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
  });
  children.push(child);
  forwardOutput(service.name, child.stdout, process.stdout);
  forwardOutput(service.name, child.stderr, process.stderr);
  child.on("error", (error) => {
    console.error(`[${service.name}] failed to start: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${service.name}] exited${signal ? ` with ${signal}` : ` with code ${code ?? 1}`}; stopping the dev stack.`);
    stop(code && code > 0 ? code : 1);
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
if (process.platform === "win32") process.once("SIGBREAK", () => stop(0));
