import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@myknow/config";
import { createApiContext } from "../apps/api/src/context.js";
import { createHttpTools } from "../apps/api/src/http.js";
import { handleKnowledgeBaseRoutes } from "../apps/api/src/routes/knowledge-bases.js";
import { handleResourceRoutes } from "../apps/api/src/routes/resources.js";
import { handleTaskRoutes } from "../apps/api/src/routes/tasks.js";
import { handleWikiRoutes } from "../apps/api/src/routes/wiki.js";
import { createTaskRunner } from "../apps/worker/src/tasks/runner.js";
import {
  EMBEDDING_PROGRESS_SCHEMA_VERSION,
  createDatabase,
  embeddingProgressForRun,
  embeddingTasksForRun,
  migrate,
  reconcileEmbeddingProgress,
  queueEmbeddingTask,
  SCHEMA_VERSION
} from "@myknow/db";

const id = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const sha = "a".repeat(64);
const response = () => ({ req: { headers: {} }, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } });

const fixture = () => {
  const database = createDatabase(":memory:");
  migrate(database.sqlite);
  const now = timestamp();
  const knowledgeBaseId = id();
  const resourceId = id();
  const versionId = id();
  const runId = id();
  database.sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?, 'active',?,?)").run(knowledgeBaseId, "Embedding fixture", now, now);
  database.sqlite.prepare("INSERT INTO resources (id,name,source_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(resourceId, "Source", "text", "indexed", null, now, now);
  database.sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(versionId, resourceId, sha, `blobs/${sha}`, "text/plain", 1, "indexed", now, now);
  database.sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(resourceId, knowledgeBaseId, now);
  database.sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,child_count,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(runId, versionId, "indexed", 3, now, now);
  database.sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(runId, versionId);
  database.sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(versionId, resourceId);
  for (let sequence = 0; sequence < 3; sequence += 1) database.sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,chunk_type,sequence,content,start_offset,end_offset,locator,strategy,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(`chunk-${sequence}`, versionId, runId, "text", sequence, "content", 0, 7, JSON.stringify({ startOffset: 0, endOffset: 7 }), "test", now);
  return { database, knowledgeBaseId, resourceId, versionId, runId, now };
};

describe("embedding progress aggregation", () => {
  it("creates the task run index on an empty database", () => {
    const database = createDatabase(":memory:");
    try {
      expect(migrate(database.sqlite)).toMatchObject({ fresh: true, schemaVersion: SCHEMA_VERSION });
      expect(database.sqlite.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name)).toContain("processing_run_id");
      expect(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_processing_run_idx'").get()).toBeTruthy();
      expect(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='retrieval_embeddings_run_idx'").get()).toBeTruthy();
    } finally { database.sqlite.close(); }
  });

  it("backfills processing run ids in embedding task payloads during migration", () => {
    const { database, runId, versionId } = fixture();
    try {
      const now = timestamp();
      const taskId = id();
      database.sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,?,'queued',0,3,0,?,?)").run(taskId, "retrieval:embed", versionId, JSON.stringify({ processingRunId: runId, ownerType: "raw_chunk", ownerId: id() }), now, now);
      database.sqlite.prepare("UPDATE schema_meta SET value=? WHERE key='schema_version'").run("retrieval-query-256-agent-citation-policy-v1");
      expect(migrate(database.sqlite)).toMatchObject({ fresh: false, migratedFrom: "retrieval-query-256-agent-citation-policy-v1", schemaVersion: SCHEMA_VERSION });
      expect(database.sqlite.prepare("SELECT processing_run_id FROM tasks WHERE id=?").get(taskId).processing_run_id).toBe(runId);
    } finally { database.sqlite.close(); }
  });

  it("returns compact counts, grouped errors, paged details, and a durable final snapshot", () => {
    const { database, runId, versionId } = fixture();
    try {
      const config = { retrievalVectorEnabled: true, embeddingProvider: "mock", embeddingModel: "mock-hash-v1", embeddingDimensions: 32 };
      const insertTask = database.sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,processing_run_id,payload,status,progress,retry_limit,retry_count,error_code,error_summary,created_at,updated_at) VALUES (?,?,?,?,? ,?,0,3,0,?,?,?,?)");
      insertTask.run(id(), "retrieval:embed", versionId, runId, JSON.stringify({ ownerId: "chunk-0", processingRunId: runId }), "succeeded", null, null, "2026-01-01", "2026-01-01");
      insertTask.run(id(), "retrieval:embed", versionId, runId, JSON.stringify({ ownerId: "chunk-1", processingRunId: runId }), "queued", null, null, "2026-01-01", "2026-01-01");
      insertTask.run(id(), "retrieval:embed", versionId, runId, JSON.stringify({ ownerId: "chunk-2", processingRunId: runId }), "failed", "EMBEDDING_TIMEOUT", "EMBEDDING_TIMEOUT: provider timed out", "2026-01-01", "2026-01-01");
      database.sqlite.prepare("INSERT INTO retrieval_embeddings (id,owner_type,owner_id,version_key,resource_version_id,processing_run_id,provider,model,dimensions,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id(), "raw_chunk", "chunk-0", versionId, versionId, runId, "mock", "mock-hash-v1", 32, "ready", "2026-01-01", "2026-01-01");
      const progress = embeddingProgressForRun(database.sqlite, runId, config);
      expect(progress).toMatchObject({ schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION, total: 3, ready: 1, queued: 1, failed: 1, progressPercent: 33, status: "running" });
      expect(progress.errorGroups).toEqual([{ errorCode: "EMBEDDING_TIMEOUT", provider: "mock", model: "mock-hash-v1", count: 1 }]);
      const details = embeddingTasksForRun(database.sqlite, { processingRunId: runId, page: 1, limit: 1, status: "failed", config });
      expect(details).toMatchObject({ total: 1, pageCount: 1 });
      expect(details.items[0]).toMatchObject({ sequence: 2, status: "failed", errorCode: "EMBEDDING_TIMEOUT" });
      expect(details.items[0].content).toBeUndefined();

      database.sqlite.prepare("DELETE FROM tasks WHERE processing_run_id=? AND json_extract(payload,'$.ownerId')='chunk-1'").run(runId);
      const missingDetails = embeddingTasksForRun(database.sqlite, { processingRunId: runId, page: 1, limit: 10, status: "missing", errorCode: "EMBEDDING_MISSING", config });
      expect(missingDetails).toMatchObject({ total: 1, pageCount: 1 });
      expect(missingDetails.items[0]).toMatchObject({ sequence: 1, status: "missing", errorCode: "EMBEDDING_MISSING" });

      database.sqlite.prepare("UPDATE tasks SET status='failed',error_code='EMBEDDING_TIMEOUT',error_summary='EMBEDDING_TIMEOUT: provider timed out',finished_at=?,updated_at=? WHERE processing_run_id=? AND json_extract(payload,'$.ownerId')='chunk-1'").run("2026-01-02", "2026-01-02", runId);
      const events = [];
      const finalized = reconcileEmbeddingProgress(database.sqlite, { processingRunId: runId, config, audit: (...args) => events.push(args) });
      expect(finalized.status).toBe("degraded");
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe("embedding_degraded");
      expect(JSON.parse(database.sqlite.prepare("SELECT metrics FROM processing_runs WHERE id=?").get(runId).metrics).embedding.status).toBe("degraded");
      expect(embeddingProgressForRun(database.sqlite, runId, config).ready).toBe(1);
      reconcileEmbeddingProgress(database.sqlite, { processingRunId: runId, config, audit: (...args) => events.push(args) });
      expect(events).toHaveLength(1);
    } finally { database.sqlite.close(); }
  });

  it("serves scoped run summaries and run detail contracts", async () => {
    const { database, knowledgeBaseId, resourceId, versionId, runId } = fixture();
    const config = { ...loadConfig({ RESOURCE_STORAGE_DIR: "." }), retrievalVectorEnabled: true, embeddingProvider: "mock", embeddingModel: "mock-hash-v1", embeddingDimensions: 32 };
    const ctx = createApiContext({ config, sqlite: database.sqlite, db: database.db, http: createHttpTools({ config }) });
    try {
      const task = queueEmbeddingTask(database.sqlite, { ownerType: "raw_chunk", ownerId: "chunk-0", resourceVersionId: versionId, processingRunId: runId });
      database.sqlite.prepare("UPDATE tasks SET status='failed',error_code='EMBEDDING_TIMEOUT',error_summary='EMBEDDING_TIMEOUT: timed out',finished_at=?,updated_at=? WHERE id=?").run(timestamp(), timestamp(), task.id);
      database.sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(id(), "embedding_degraded", "processing_run", runId, null, JSON.stringify({ processingRunId: runId, failed: 1 }), timestamp());
      database.sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(id(), "embedding_ready", "retrieval_embedding", `raw_chunk:chunk-0`, null, JSON.stringify({ processingRunId: runId }), timestamp());
      const runResponse = response();
      await handleKnowledgeBaseRoutes({ ctx, request: { pathname: `/api/knowledge-bases/${knowledgeBaseId}/processing-runs`, method: "GET", parsed: new URL(`http://localhost/api/knowledge-bases/${knowledgeBaseId}/processing-runs`), body: {}, requestId: id(), res: runResponse } });
      expect(runResponse.status).toBe(200);
      expect(runResponse.body.data.items[0]).toMatchObject({ id: runId, resourceId, resourceVersionId: versionId });
      expect(runResponse.body.data.items[0].embeddingProgress).toMatchObject({ total: 3, failed: 1, status: "failed" });

      const resourceResponse = response();
      await handleResourceRoutes({ ctx, request: { pathname: `/api/resources/${resourceId}`, method: "GET", parsed: new URL(`http://localhost/api/resources/${resourceId}`), body: {}, requestId: id(), res: resourceResponse } });
      expect(resourceResponse.status).toBe(200);
      expect(resourceResponse.body.data.embeddingProgress).toMatchObject({ processingRunId: runId, total: 3, status: "failed" });
      expect(resourceResponse.body.data.currentVersion.embeddingProgress).toMatchObject({ processingRunId: runId, total: 3 });

      const detailResponse = response();
      await handleResourceRoutes({ ctx, request: { pathname: `/api/resources/${resourceId}/processing-runs/${runId}/embedding-tasks`, method: "GET", parsed: new URL(`http://localhost/api/resources/${resourceId}/processing-runs/${runId}/embedding-tasks?status=failed`), body: {}, requestId: id(), res: detailResponse } });
      expect(detailResponse.status).toBe(200);
      expect(detailResponse.body.data).toMatchObject({ processingRunId: runId, total: 1, progress: { status: "failed" } });
      expect(detailResponse.body.data.items[0]).toMatchObject({ sequence: 0, status: "failed", errorCode: "EMBEDDING_TIMEOUT" });

      const auditResponse = response();
      await handleKnowledgeBaseRoutes({ ctx, request: { pathname: `/api/knowledge-bases/${knowledgeBaseId}/audit-events`, method: "GET", parsed: new URL(`http://localhost/api/knowledge-bases/${knowledgeBaseId}/audit-events`), body: {}, requestId: id(), res: auditResponse } });
      expect(auditResponse.status).toBe(200);
      expect(auditResponse.body.data.items).toHaveLength(1);
      expect(auditResponse.body.data.items[0].eventType).toBe("embedding_degraded");

      const wikiResponse = response();
      await handleWikiRoutes({ ctx, request: { pathname: `/api/knowledge-bases/${knowledgeBaseId}/wiki`, method: "GET", parsed: new URL(`http://localhost/api/knowledge-bases/${knowledgeBaseId}/wiki`), body: {}, requestId: id(), res: wikiResponse } });
      expect(wikiResponse.status).toBe(200);
      expect(wikiResponse.body.data.log.events.some((event) => event.event_type === "embedding_ready")).toBe(false);

      database.sqlite.prepare("UPDATE processing_runs SET status='superseded',updated_at=? WHERE id=?").run(timestamp(), runId);
      const retryResponse = response();
      await handleTaskRoutes({ ctx, request: { pathname: `/api/tasks/${task.id}/retry`, method: "POST", parsed: new URL(`http://localhost/api/tasks/${task.id}/retry`), body: {}, requestId: id(), res: retryResponse } });
      expect(retryResponse.status).toBe(409);
      expect(retryResponse.body.error.code).toBe("PROCESSING_RUN_SUPERSEDED");
    } finally { database.sqlite.close(); }
  });

  it("cancels and retries only the incomplete chunks in one embedding run", async () => {
    const { database, resourceId, versionId, runId } = fixture();
    const config = { ...loadConfig({ RESOURCE_STORAGE_DIR: "." }), retrievalVectorEnabled: true, embeddingProvider: "mock", embeddingModel: "mock-hash-v1", embeddingDimensions: 32 };
    const ctx = createApiContext({ config, sqlite: database.sqlite, db: database.db, http: createHttpTools({ config }) });
    try {
      const failedTask = queueEmbeddingTask(database.sqlite, { ownerType: "raw_chunk", ownerId: "chunk-0", resourceVersionId: versionId, processingRunId: runId });
      const cancelledTask = queueEmbeddingTask(database.sqlite, { ownerType: "raw_chunk", ownerId: "chunk-1", resourceVersionId: versionId, processingRunId: runId });
      database.sqlite.prepare("UPDATE tasks SET status='failed',error_code=?,error_summary=?,finished_at=?,updated_at=? WHERE id=?").run("EMBEDDING_TIMEOUT", "EMBEDDING_TIMEOUT: timed out", timestamp(), timestamp(), failedTask.id);
      database.sqlite.prepare("UPDATE tasks SET status='failed',error_code=?,error_summary=?,finished_at=?,updated_at=? WHERE id=?").run("TASK_CANCELLED", "TASK_CANCELLED: cancelled", timestamp(), timestamp(), cancelledTask.id);
      database.sqlite.prepare("INSERT INTO retrieval_embeddings (id,owner_type,owner_id,version_key,resource_version_id,processing_run_id,provider,model,dimensions,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id(), "raw_chunk", "chunk-2", versionId, versionId, runId, "mock", "mock-hash-v1", 32, "ready", timestamp(), timestamp());

      const retryResponse = response();
      await handleResourceRoutes({ ctx, request: { pathname: `/api/resources/${resourceId}/processing-runs/${runId}/retry`, method: "POST", parsed: new URL(`http://localhost/api/resources/${resourceId}/processing-runs/${runId}/retry`), body: {}, requestId: id(), res: retryResponse } });
      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body.data).toMatchObject({ queued: 2, byStatus: { failed: 1, cancelled: 1, missing: 0 }, progress: { ready: 1, pending: 2, failed: 0, cancelled: 0 } });
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM tasks WHERE type='retrieval:embed' AND processing_run_id=?").get(runId).count).toBe(4);

      const cancelResponse = response();
      await handleResourceRoutes({ ctx, request: { pathname: `/api/resources/${resourceId}/processing-runs/${runId}/cancel`, method: "POST", parsed: new URL(`http://localhost/api/resources/${resourceId}/processing-runs/${runId}/cancel`), body: {}, requestId: id(), res: cancelResponse } });
      expect(cancelResponse.status).toBe(202);
      expect(cancelResponse.body.data).toMatchObject({ requested: 2, immediate: 2, running: 0, progress: { ready: 1, pending: 0, cancelled: 2, status: "degraded" } });
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM tasks WHERE processing_run_id=? AND status='failed' AND error_code='TASK_CANCELLED'").get(runId).count).toBe(3);

      const retryAgainResponse = response();
      await handleResourceRoutes({ ctx, request: { pathname: `/api/resources/${resourceId}/processing-runs/${runId}/retry`, method: "POST", parsed: new URL(`http://localhost/api/resources/${resourceId}/processing-runs/${runId}/retry`), body: {}, requestId: id(), res: retryAgainResponse } });
      expect(retryAgainResponse.status).toBe(202);
      expect(retryAgainResponse.body.data).toMatchObject({ queued: 2, byStatus: { failed: 0, cancelled: 2, missing: 0 }, progress: { ready: 1, pending: 2 } });
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM retrieval_embeddings WHERE owner_id='chunk-2' AND status='ready'").get().count).toBe(1);
    } finally { database.sqlite.close(); }
  });

  it("stops a running embedding task after the durable cancellation flag is set", async () => {
    const { database, versionId, runId } = fixture();
    try {
      const task = queueEmbeddingTask(database.sqlite, { ownerType: "raw_chunk", ownerId: "chunk-0", resourceVersionId: versionId, processingRunId: runId });
      const runner = createTaskRunner({
        sqlite: database.sqlite,
        workerId: "test-worker",
        audit: () => {},
        embedRetrieval: ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("embedding cancelled"), { code: "TASK_CANCELLED" })), { once: true });
        })
      });
      const running = runner.runOne();
      expect(database.sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status).toBe("running");
      database.sqlite.prepare("UPDATE tasks SET cancel_requested=1,updated_at=? WHERE id=?").run(timestamp(), task.id);
      let completed = await Promise.race([running.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))]);
      if (!completed) { runner.cancel(task.id); await running; }
      expect(completed).toBe(true);
      expect(database.sqlite.prepare("SELECT status,error_code,error_summary FROM tasks WHERE id=?").get(task.id)).toMatchObject({ status: "failed", error_code: "TASK_CANCELLED" });
      expect(database.sqlite.prepare("SELECT status,error_code FROM task_attempts WHERE task_id=?").get(task.id)).toMatchObject({ status: "failed", error_code: "TASK_CANCELLED" });
    } finally { database.sqlite.close(); }
  });
});
