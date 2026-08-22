import crypto from "node:crypto";
import { tasks } from "@myknow/db";
import { desc, eq } from "drizzle-orm";

export const handleTaskRoutes = ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  const { db, sqlite } = ctx;

  if (pathname === "/api/tasks" && method === "GET") {
    ctx.json(res, 200, db.select().from(tasks).orderBy(desc(tasks.createdAt)).all(), null, requestId);
    return true;
  }
  if (pathname === "/api/tasks" && method === "POST") {
    if (!["demo_success", "demo_failure"].includes(body?.type)) {
      ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "type must be demo_success or demo_failure"), requestId);
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
    if (task.retryCount >= task.retryLimit) { ctx.json(res, 409, null, ctx.error("TASK_RETRY_LIMIT", "Task retry limit reached"), requestId); return true; }
    const timestamp = ctx.now();
    sqlite.transaction(() => {
      const changed = sqlite.prepare("UPDATE tasks SET status='retrying',worker_id=NULL,finished_at=NULL,error_summary=NULL,updated_at=? WHERE id=? AND status='failed' AND retry_count < retry_limit").run(timestamp, task.id).changes;
      if (!changed) throw Object.assign(new Error("Task is no longer retryable"), { code: "INVALID_STATE_TRANSITION" });
      ctx.audit("retrying", "task", task.id, requestId, { retryCount: task.retryCount });
    })();
    ctx.json(res, 202, sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(task.id), null, requestId);
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === "GET") {
    const task = db.select().from(tasks).where(eq(tasks.id, taskMatch[1])).get();
    ctx.json(res, task ? 200 : 404, task || null, task ? null : ctx.error("NOT_FOUND", "Task not found"), requestId);
    return true;
  }
  return false;
};
