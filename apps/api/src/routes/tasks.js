import crypto from "node:crypto";
import { refreshResourceStatus, tasks } from "@myknow/db";
import { desc, eq } from "drizzle-orm";

export const handleTaskRoutes = ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  const { db, sqlite } = ctx;

  if (pathname === "/api/tasks" && method === "GET") {
    ctx.json(res, 200, db.select().from(tasks).orderBy(desc(tasks.createdAt)).all().map((task) => ctx.taskView(task)), null, requestId);
    return true;
  }
  if (pathname === "/api/tasks" && method === "POST") {
    if (!["demo_success", "demo_failure", "demo_retryable"].includes(body?.type)) {
      ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "type must be demo_success, demo_failure, or demo_retryable"), requestId);
      return true;
    }
    const timestamp = ctx.now();
    const value = { id: crypto.randomUUID(), type: body.type, status: "queued", progress: 0, retryLimit: 3, retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
    db.insert(tasks).values(value).run();
    ctx.audit("created", "task", value.id, requestId, { type: value.type });
    ctx.json(res, 201, value, null, requestId);
    return true;
  }

  const cancelTaskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancelTaskMatch && method === "POST") {
    const task = db.select().from(tasks).where(eq(tasks.id, cancelTaskMatch[1])).get();
    if (!task) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Task not found"), requestId); return true; }
    if (["succeeded", "failed"].includes(task.status)) { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "Only queued or running tasks can be cancelled"), requestId); return true; }
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE tasks SET cancel_requested=1,status=CASE WHEN status IN ('queued','retrying') THEN 'failed' ELSE status END,error_code=CASE WHEN status IN ('queued','retrying') THEN 'TASK_CANCELLED' ELSE error_code END,error_summary=CASE WHEN status IN ('queued','retrying') THEN 'Task cancellation requested' ELSE error_summary END,finished_at=CASE WHEN status IN ('queued','retrying') THEN ? ELSE finished_at END,updated_at=? WHERE id=?").run(timestamp, timestamp, task.id);
      if (task.type === "resource:process" && ["queued", "retrying"].includes(task.status)) {
        const resourceVersionId = task.resource_version_id || (() => { try { return JSON.parse(task.payload || "{}").resourceVersionId; } catch { return null; } })();
        const version = resourceVersionId && ctx.version(resourceVersionId);
        if (version) {
          sqlite.prepare("UPDATE resource_versions SET status=CASE WHEN active_processing_run_id IS NULL THEN 'failed' ELSE 'indexed' END,error_summary='Task cancellation requested',updated_at=? WHERE id=?").run(timestamp, version.id);
          refreshResourceStatus(sqlite, version.resource_id, timestamp);
        }
      }
      ctx.audit("cancel_requested", "task", task.id, requestId, { status: task.status });
    })();
    ctx.json(res, 202, ctx.taskView(sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(task.id)), null, requestId);
    return true;
  }

  const retryTaskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
  if (retryTaskMatch && method === "POST") {
    const task = db.select().from(tasks).where(eq(tasks.id, retryTaskMatch[1])).get();
    if (!task) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Task not found"), requestId); return true; }
    if (task.status !== "failed") { ctx.json(res, 409, null, ctx.error("INVALID_STATE_TRANSITION", "Only failed tasks can be retried"), requestId); return true; }
    if (task.retryCount >= task.retryLimit && task.type !== "resource:process") { ctx.json(res, 409, null, ctx.error("TASK_RETRY_LIMIT", "Task retry limit reached"), requestId); return true; }
    const timestamp = ctx.now();
    const resourceVersionId = task.resourceVersionId ?? task.resource_version_id ?? null;
    const retryLimit = task.retryLimit ?? task.retry_limit ?? 3;
    let replacement;
    sqlite.transaction(() => {
      if (task.type === "resource:process") {
        const version = ctx.version(resourceVersionId);
        if (!version) throw Object.assign(new Error("resource version not found"), { code: "NOT_FOUND" });
        const resource = ctx.resource(version.resource_id);
        if (resource?.status === "archived") throw Object.assign(new Error("archived resources cannot be retried"), { code: "RESOURCE_ARCHIVED" });
        sqlite.prepare("UPDATE resource_versions SET status='pending',error_summary=NULL,updated_at=? WHERE id=?").run(timestamp, version.id);
        refreshResourceStatus(sqlite, version.resource_id, timestamp);
        replacement = ctx.queueVersion(version.id, requestId, "task-manual-retry");
      } else {
        replacement = { id: crypto.randomUUID(), type: task.type, payload: task.payload, status: "queued", progress: 0, retryLimit, retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
        sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'queued',0,?,0,?,?)").run(replacement.id, replacement.type, replacement.payload, retryLimit, timestamp, timestamp);
      }
      ctx.audit("retry_requested", "task", task.id, requestId, { replacementTaskId: replacement.id });
    })();
    ctx.json(res, 202, ctx.taskView(replacement), null, requestId);
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === "GET") {
    const task = db.select().from(tasks).where(eq(tasks.id, taskMatch[1])).get();
    ctx.json(res, task ? 200 : 404, task ? ctx.taskView(task) : null, task ? null : ctx.error("NOT_FOUND", "Task not found"), requestId);
    return true;
  }
  return false;
};
