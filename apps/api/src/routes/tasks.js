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
