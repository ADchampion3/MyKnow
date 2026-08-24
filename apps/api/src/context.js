import crypto from "node:crypto";
import { now, processingRequestFromVersion } from "@myknow/db";

const omit = (row, fields) => {
  if (!row) return row;
  const result = { ...row };
  for (const field of fields) delete result[field];
  return result;
};

export const createApiContext = ({ config, sqlite, db, http }) => {
  const audit = (eventType, entityType, entityId, requestId, metadata = {}) => sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), eventType, entityType, entityId, requestId, JSON.stringify(metadata), now());
  const inputName = (body) => typeof body?.name === "string" && body.name.trim().length > 0 && body.name.trim().length <= 120 ? body.name.trim() : null;
  const collection = (body, extra = {}) => {
    const name = inputName(body);
    return name ? { value: { id: crypto.randomUUID(), name, ...extra, createdAt: now(), updatedAt: now() } } : { error: http.error("VALIDATION_ERROR", "name must be 1-120 characters") };
  };
  const resource = (id) => sqlite.prepare("SELECT * FROM resources WHERE id=?").get(id);
  const version = (id) => sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(id);
  const validKb = (id) => sqlite.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(id);
  const taskForVersion = (versionId) => sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND resource_version_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(versionId);
  const queueVersion = (resourceVersionId, requestId, reason = "requested", idempotency = null) => {
    const timestamp = now();
    const storedVersion = version(resourceVersionId);
    const processingRequest = storedVersion ? processingRequestFromVersion(storedVersion, { isPdf: storedVersion.mime_type === "application/pdf" }) : null;
    const value = { id: crypto.randomUUID(), type: "resource:process", resourceVersionId, payload: JSON.stringify({ reason, resourceVersionId, processingRequest, ...(idempotency || {}) }), status: "queued", progress: 0, retryLimit: 3, retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
    sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (@id,@type,@resourceVersionId,@payload,@status,@progress,@retryLimit,@retryCount,@createdAt,@updatedAt)").run(value);
    audit("queued", "task", value.id, requestId, { resourceVersionId, reason });
    return value;
  };
  const resourceView = (row) => row ? omit(row, []) : row;
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

  return { config, sqlite, db, ...http, now, audit, inputName, collection, resource, version, validKb, taskForVersion, queueVersion, resourceView, versionView, runView, taskView };
};
