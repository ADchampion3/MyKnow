const positiveInt = (name, value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};
const boundedInt = (name, value, fallback, minimum, maximum) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
};
const booleanValue = (name, value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
};

export function loadConfig(env = process.env) {
  const provider = env.MODEL_PROVIDER || "mock";
  if (!provider) throw new Error("MODEL_PROVIDER is required");
  const aiEgressMode = env.AI_EGRESS_MODE || "allow_cloud";
  if (!["local_only", "allow_cloud"].includes(aiEgressMode)) throw new Error("AI_EGRESS_MODE must be local_only or allow_cloud");
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
    modelName: env.MODEL_NAME || (provider === "mock" ? "myknow-mock" : "deepseek-chat"),
    modelApiBaseUrl: env.MODEL_API_BASE_URL || "",
    modelApiKey: env.MODEL_API_KEY || "",
    aiEgressMode,
    agentMaxTurns: boundedInt("AGENT_MAX_TURNS", env.AGENT_MAX_TURNS, 8, 1, 8),
    agentMaxToolCalls: boundedInt("AGENT_MAX_TOOL_CALLS", env.AGENT_MAX_TOOL_CALLS, 32, 1, 32),
    agentTimeoutMs: boundedInt("AGENT_TIMEOUT_MS", env.AGENT_TIMEOUT_MS, 120_000, 1_000, 120_000),
    paddleOcrJobUrl: env.PADDLE_OCR_JOB_URL || "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
    paddleOcrToken: env.PADDLE_OCR_TOKEN || "",
    paddleOcrModel: env.PADDLE_OCR_MODEL || "PaddleOCR-VL-1.6",
    paddleOcrPollIntervalMs: positiveInt("PADDLE_OCR_POLL_INTERVAL_MS", env.PADDLE_OCR_POLL_INTERVAL_MS, 5000),
    paddleOcrMaxConcurrency: positiveInt("PADDLE_OCR_MAX_CONCURRENCY", env.PADDLE_OCR_MAX_CONCURRENCY, 1),
    pdfPythonPath: env.PDF_PYTHON_PATH || "python",
    ocrMaxPages: positiveInt("OCR_MAX_PAGES", env.OCR_MAX_PAGES, 500),
    hasModelApiKey: Boolean(env.MODEL_API_KEY),
    retrievalVectorEnabled: booleanValue("RETRIEVAL_VECTOR_ENABLED", env.RETRIEVAL_VECTOR_ENABLED ?? env.VECTOR_SEARCH_ENABLED, true),
    embeddingProvider: env.EMBEDDING_PROVIDER || "mock",
    embeddingModel: env.EMBEDDING_MODEL || "mock-hash-v1",
    embeddingDimensions: boundedInt("EMBEDDING_DIMENSIONS", env.EMBEDDING_DIMENSIONS, 32, 4, 4096),
    embeddingFailureMode: env.EMBEDDING_FAILURE_MODE || "",
    embeddingApiBaseUrl: env.EMBEDDING_API_BASE_URL || "",
    embeddingApiKey: env.EMBEDDING_API_KEY || "",
    derivedDataRetentionDays: boundedInt("DERIVED_DATA_RETENTION_DAYS", env.DERIVED_DATA_RETENTION_DAYS, 30, 1, 36500)
  };
}
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const isLocalUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && LOCAL_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
};

export const assertEgressAllowed = (config, url, code = "MODEL_EGRESS_BLOCKED", label = "provider") => {
  if (config?.aiEgressMode === "local_only" && url && !isLocalUrl(url)) {
    throw Object.assign(new Error(`${label} egress is blocked in local_only mode`), { code });
  }
};

const secretKey = /(?:api[_-]?key|authorization|password|secret|token|private[_-]?key)/iu;
const secretValue = /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})/giu;

export const redactSecrets = (value) => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.replace(secretValue, "[REDACTED]") : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redactSecrets(item)]));
};

const auditPrivateKey = /^(?:prompt|promptText|prompt_text|fullPrompt|full_prompt|sourceText|source_text|rawText|raw_text|contentMarkdown|content_markdown|content)$/iu;
export const redactAuditMetadata = (value) => {
  if (Array.isArray(value)) return value.map(redactAuditMetadata);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.replace(secretValue, "[REDACTED]") : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : auditPrivateKey.test(key) ? "[OMITTED]" : redactAuditMetadata(item)]));
};

export const runtimeView = (config) => {
  const mode = config.aiEgressMode || "local_only";
  return {
    aiEgressMode: mode,
    egressWarning: mode === "allow_cloud" ? "允许云端 Provider；请求内容可能离开本机。" : "仅允许本机 Provider；云端外发会被拒绝。",
    model: { provider: config.modelProvider, model: config.modelName },
    embedding: { provider: config.embeddingProvider, model: config.embeddingModel, dimensions: config.embeddingDimensions },
    ocr: { provider: config.paddleOcrModel ? "paddleocr" : null, model: config.paddleOcrModel || null }
  };
};

try {
  process.loadEnvFile?.(path.join(repoRoot, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
