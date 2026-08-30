import crypto from "node:crypto";
import { assertEgressAllowed, redactAuditMetadata, runtimeView } from "@myknow/config";
import { externalWikiMode, now, processingRequestFromVersion } from "@myknow/db";

const omit = (row, fields) => {
  if (!row) return row;
  const result = { ...row };
  for (const field of fields) delete result[field];
  return result;
};

export const createApiContext = ({ config, sqlite, db, http }) => {
  const audit = (eventType, entityType, entityId, requestId, metadata = {}) => sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), eventType, entityType, entityId, requestId, JSON.stringify(redactAuditMetadata(metadata)), now());
  const inputName = (body) => typeof body?.name === "string" && body.name.trim().length > 0 && body.name.trim().length <= 120 ? body.name.trim() : null;
  const collection = (body, extra = {}) => {
    const name = inputName(body);
    return name ? { value: { id: crypto.randomUUID(), name, ...extra, createdAt: now(), updatedAt: now() } } : { error: http.error("VALIDATION_ERROR", "name must be 1-120 characters") };
  };
  const resource = (id) => sqlite.prepare("SELECT * FROM resources WHERE id=?").get(id);
  const version = (id) => sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(id);
  const validKb = (id) => sqlite.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(id);
  const taskForVersion = (versionId) => sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND resource_version_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(versionId);
  const queueVersion = (resourceVersionId, requestId, reason = "requested", extra = null) => {
    const timestamp = now();
    const storedVersion = version(resourceVersionId);
    const processingRequest = storedVersion ? processingRequestFromVersion(storedVersion, { isPdf: storedVersion.mime_type === "application/pdf" }) : null;
    const value = { id: crypto.randomUUID(), type: "resource:process", resourceVersionId, payload: JSON.stringify({ reason, resourceVersionId, processingRequest, ...(extra || {}) }), status: "queued", progress: 0, retryLimit: 3, retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
    sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (@id,@type,@resourceVersionId,@payload,@status,@progress,@retryLimit,@retryCount,@createdAt,@updatedAt)").run(value);
    audit("queued", "task", value.id, requestId, { resourceVersionId, reason });
    return value;
  };
  const resourceView = (row) => {
    if (!row) return row;
    const result = omit(row, []);
    if (Object.hasOwn(row, "wiki_mode")) result.wikiMode = row.wiki_mode ? externalWikiMode(row.wiki_mode) : null;
    return result;
  };
  const versionView = (row) => {
    const result = omit(row, ["storage_key", "source_url", "fetched_at", "idempotency_key", "request_fingerprint"]);
    if (row?.ocr_mode) {
      let capabilities = null;
      try { capabilities = row.ocr_capabilities ? JSON.parse(row.ocr_capabilities) : null; } catch {}
      result.processingRequest = { mode: row.ocr_mode, provider: row.ocr_provider || null, capabilities };
    }
    return result;
  };
  const runView = (row) => omit(row, ["canonical_storage_key"]);
  const taskView = (row) => {
    if (!row) return row;
    const result = omit(row, ["payload"]);
    try {
      const payload = JSON.parse(row.payload || "{}");
      if (payload.processingRequest) result.processingRequest = payload.processingRequest;
    } catch {}
    return result;
  };

  const assertModelEgress = () => {
    if (String(config.modelProvider || "mock").toLowerCase() === "mock") return;
    const defaultUrl = ["deepseek", "ds"].includes(String(config.modelProvider || "").toLowerCase()) ? "https://api.deepseek.com" : config.modelApiBaseUrl;
    assertEgressAllowed(config, config.modelApiBaseUrl || defaultUrl, "MODEL_EGRESS_BLOCKED", "model");
  };
  const assertEmbeddingEgress = () => {
    if (["openai", "openai-compatible"].includes(String(config.embeddingProvider || "").toLowerCase())) assertEgressAllowed(config, config.embeddingApiBaseUrl, "EMBEDDING_EGRESS_BLOCKED", "embedding");
  };
  const assertOcrEgress = (processingRequest) => {
    if (config.aiEgressMode === "local_only" && ["cloud", "paddleocr"].includes(processingRequest?.provider)) {
      throw Object.assign(new Error("OCR egress is blocked in local_only mode"), { code: "OCR_EGRESS_BLOCKED" });
    }
  };
  return { config, sqlite, db, ...http, now, audit, inputName, collection, resource, version, validKb, taskForVersion, queueVersion, resourceView, versionView, runView, taskView, runtimeView: () => runtimeView(config), assertModelEgress, assertEmbeddingEgress, assertOcrEgress };
};
