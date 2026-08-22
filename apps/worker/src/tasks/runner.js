import crypto from "node:crypto";
import { now } from "@myknow/db";

export const createTaskRunner = ({ sqlite, workerId, audit, processResource }) => {
  const resourceVersionFromTask = (task) => {
    try { return JSON.parse(task.payload || "{}").resourceVersionId || null; }
    catch { return null; }
  };

  const claim = sqlite.transaction(() => {
    const task = sqlite.prepare("SELECT * FROM tasks WHERE status IN ('queued','retrying') ORDER BY created_at LIMIT 1").get();
    if (!task) return null;
    const timestamp = now();
    if (!sqlite.prepare("UPDATE tasks SET status='running',worker_id=?,started_at=?,updated_at=? WHERE id=? AND status IN ('queued','retrying')").run(workerId, timestamp, timestamp, task.id).changes) return null;
    const attempt = sqlite.prepare("SELECT COALESCE(MAX(attempt_number),0)+1 AS n FROM task_attempts WHERE task_id=?").get(task.id).n;
    sqlite.prepare("INSERT INTO task_attempts (id,task_id,attempt_number,status,worker_id,started_at) VALUES (?,? ,?,'running',?,?)").run(crypto.randomUUID(), task.id, attempt, workerId, timestamp);
    audit("running", "task", task.id, { workerId, attempt });
    return { ...task, attempt };
  });

  const finish = sqlite.transaction((task, status, errorSummary = null) => {
    const timestamp = now();
    sqlite.prepare("UPDATE tasks SET status=?,progress=?,error_summary=?,finished_at=?,updated_at=? WHERE id=?").run(status, status === "succeeded" ? 100 : 0, errorSummary, timestamp, timestamp, task.id);
    sqlite.prepare("UPDATE task_attempts SET status=?,finished_at=?,error_summary=? WHERE task_id=? AND attempt_number=?").run(status, timestamp, errorSummary, task.id, task.attempt);
    audit(status, "task", task.id, { workerId, attempt: task.attempt, errorSummary });
  });

  const failTask = sqlite.transaction((task, errorSummary, errorCode = null) => {
    const retryCount = task.retry_count + 1;
    const retrying = retryCount <= task.retry_limit;
    const status = retrying ? "retrying" : "failed";
    const timestamp = now();
    sqlite.prepare("UPDATE tasks SET status=?,progress=0,retry_count=?,error_summary=?,finished_at=?,updated_at=? WHERE id=?").run(status, retryCount, errorSummary, retrying ? null : timestamp, timestamp, task.id);
    sqlite.prepare("UPDATE task_attempts SET status='failed',finished_at=?,error_summary=? WHERE task_id=? AND attempt_number=?").run(timestamp, errorSummary, task.id, task.attempt);
    if (task.type === "resource:process") {
      const resourceVersionId = resourceVersionFromTask(task);
      const version = resourceVersionId && sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
      if (version) {
        sqlite.prepare("UPDATE resource_versions SET status=?,error_summary=?,updated_at=? WHERE id=?").run(retrying ? "pending" : "failed", errorSummary, timestamp, version.id);
        sqlite.prepare("UPDATE resources SET status=?,updated_at=? WHERE id=? AND current_version_id=?").run(retrying ? "pending" : "failed", timestamp, version.resource_id, version.id);
        audit(retrying ? "retrying" : "failed", "resource_version", version.id, { error: errorSummary, errorCode, retryCount });
      }
    }
    audit(status, "task", task.id, { workerId, attempt: task.attempt, errorSummary, errorCode, retryCount });
    return status;
  });

  // ponytail: Sprint 2 is single-user/single-worker; recover all open attempts at startup. A leased worker table is the upgrade path for multi-worker execution.
  const recoverInterruptedTasks = sqlite.transaction(() => {
    const timestamp = now();
    for (const task of sqlite.prepare("SELECT * FROM tasks WHERE status='running'").all()) {
      const retryCount = task.retry_count + 1;
      const retrying = retryCount <= task.retry_limit;
      const status = retrying ? "retrying" : "failed";
      sqlite.prepare("UPDATE tasks SET status=?,progress=0,retry_count=?,error_summary=?,finished_at=?,worker_id=NULL,updated_at=? WHERE id=? AND status='running'").run(status, retryCount, "Worker interrupted", retrying ? null : timestamp, timestamp, task.id);
      sqlite.prepare("UPDATE task_attempts SET status='failed',finished_at=?,error_summary=? WHERE task_id=? AND status='running'").run(timestamp, "Worker interrupted", task.id);
      if (task.type === "resource:process") {
        const resourceVersionId = resourceVersionFromTask(task);
        const version = resourceVersionId && sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
        if (version) {
          sqlite.prepare("UPDATE processing_runs SET status='failed',error_summary=?,updated_at=? WHERE resource_version_id=? AND status='processing'").run("Worker interrupted", timestamp, version.id);
          sqlite.prepare("UPDATE resource_versions SET status=?,error_summary=?,updated_at=? WHERE id=?").run(retrying ? "pending" : "failed", "Worker interrupted", timestamp, version.id);
          sqlite.prepare("UPDATE resources SET status=?,updated_at=? WHERE id=? AND current_version_id=?").run(retrying ? "pending" : "failed", timestamp, version.resource_id, version.id);
        }
      }
      audit("interrupted", "task", task.id, { workerId, retryCount, status });
    }
  });

  const runOne = async () => {
    const task = claim();
    if (!task) return;
    try {
      if (task.type === "resource:process") await processResource(task);
      else if (task.type === "demo_failure") throw new Error("Deterministic demo failure");
      else if (task.type !== "demo_success") throw new Error("Unsupported task type");
      finish(task, "succeeded");
    } catch (caught) {
      const baseMessage = caught instanceof Error ? caught.message : "processing failed";
      const errorCode = typeof caught?.code === "string" ? caught.code : null;
      const message = errorCode ? `${errorCode}: ${baseMessage}` : baseMessage;
      const status = failTask(task, message, errorCode);
      console.error(`Task ${task.id} failed: ${message}`);
      if (status === "retrying") console.log(`Task ${task.id} queued for retry ${task.retry_count + 1}/${task.retry_limit}`);
    }
  };

  return { recoverInterruptedTasks, runOne };
};
