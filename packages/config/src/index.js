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
    modelApiKey: env.MODEL_API_KEY || "",
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
    embeddingApiKey: env.EMBEDDING_API_KEY || ""
  };
}
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
