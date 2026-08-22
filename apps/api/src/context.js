import crypto from "node:crypto";
import { now } from "@myknow/db";

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
  const taskForVersion = (versionId) => sqlite.prepare("SELECT * FROM tasks WHERE type='resource:process' AND json_extract(payload,'$.resourceVersionId')=? ORDER BY created_at DESC LIMIT 1").get(versionId);
  const queueVersion = (resourceVersionId, requestId) => {
    const timestamp = now();
    const value = { id: crypto.randomUUID(), type: "resource:process", payload: JSON.stringify({ resourceVersionId }), status: "queued", progress: 0, retryLimit: 3, retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
    sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (@id,@type,@payload,@status,@progress,@retryLimit,@retryCount,@createdAt,@updatedAt)").run(value);
    audit("queued", "task", value.id, requestId, { resourceVersionId });
    return value;
  };

  return { config, sqlite, db, ...http, now, audit, inputName, collection, resource, version, validKb, taskForVersion, queueVersion };
};
