const positiveInt = (name, value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export function loadConfig(env = process.env) {
  const provider = env.MODEL_PROVIDER || "mock";
  if (!provider) throw new Error("MODEL_PROVIDER is required");
  const rawDatabaseUrl = env.DATABASE_URL || "file:./data/myknow.db";
  const databaseUrl = rawDatabaseUrl.startsWith("file:./") ? `file:${path.resolve(repoRoot, rawDatabaseUrl.slice(5))}` : rawDatabaseUrl;
  return {
    databaseUrl,
    apiPort: positiveInt("API_PORT", env.API_PORT, 3001),
    webPort: positiveInt("WEB_PORT", env.WEB_PORT, 3000),
    workerPollIntervalMs: positiveInt("WORKER_POLL_INTERVAL_MS", env.WORKER_POLL_INTERVAL_MS, 1000),
    resourceStorageDir: path.resolve(repoRoot, env.RESOURCE_STORAGE_DIR || "data/resources"),
    resourceMaxBytes: positiveInt("RESOURCE_MAX_BYTES", env.RESOURCE_MAX_BYTES, 2_000_000),
    resourceParserTimeoutMs: positiveInt("RESOURCE_PARSER_TIMEOUT_MS", env.RESOURCE_PARSER_TIMEOUT_MS, 120_000),
    modelProvider: provider,
    modelApiBaseUrl: env.MODEL_API_BASE_URL || "",
    hasModelApiKey: Boolean(env.MODEL_API_KEY)
  };
}
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
