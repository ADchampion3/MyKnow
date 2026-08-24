import crypto from "node:crypto";
import { now, refreshResourceStatus } from "@myknow/db";

const transientCodes = new Set(["TRANSIENT_ERROR", "SQLITE_BUSY", "WORKER_INTERRUPTED", "PROCESSING_TIMEOUT"]);
const retryDelayMs = (attemptNumber) => attemptNumber <= 1 ? 1_000 : 5_000;
const taskResourceVersion = (task) => task.resource_version_id || (() => { try { return JSON.parse(task.payload || "{}").resourceVersionId || null; } catch { return null; } })();

export const createTaskRunner = ({ sqlite, workerId, audit, processResource }) => {
  const activeControllers = new Map();
  const claim = sqlite.transaction(() => {
    const timestamp = now();
    const task = sqlite.prepare("SELECT * FROM tasks WHERE cancel_requested=0 AND (status='queued' OR (status='retrying' AND (next_attempt_at IS NULL OR next_attempt_at<=?))) ORDER BY created_at,id LIMIT 1").get(timestamp);
    if (!task) return null;
    const nextAttempt = task.retry_count + 1;
    if (!sqlite.prepare("UPDATE tasks SET status='running',worker_id=?,started_at=?,finished_at=NULL,next_attempt_at=NULL,retry_count=?,updated_at=? WHERE id=? AND status IN ('queued','retrying')").run(workerId, timestamp, nextAttempt, timestamp, task.id).changes) return null;
    const attempt = nextAttempt;
    sqlite.prepare("INSERT INTO task_attempts (id,task_id,attempt_number,status,worker_id,started_at) VALUES (?,? ,?,'running',?,?)").run(crypto.randomUUID(), task.id, attempt, workerId, timestamp);
    audit("running", "task", task.id, { workerId, attempt });
    return { ...task, retry_count: nextAttempt, attempt };
  });

  const finish = sqlite.transaction((task, status, errorSummary = null, errorCode = null) => {
    const timestamp = now();
    sqlite.prepare("UPDATE tasks SET status=?,progress=?,error_code=?,error_summary=?,finished_at=?,worker_id=NULL,updated_at=? WHERE id=?").run(status, status === "succeeded" ? 100 : 0, errorCode, errorSummary, timestamp, timestamp, task.id);
    sqlite.prepare("UPDATE task_attempts SET status=?,finished_at=?,error_code=?,error_summary=? WHERE task_id=? AND attempt_number=?").run(status, timestamp, errorCode, errorSummary, task.id, task.attempt);
    audit(status, "task", task.id, { workerId, attempt: task.attempt, errorSummary, errorCode });
  });

  const updateResourceAfterFailure = (task, timestamp, status) => {
    if (task.type !== "resource:process") return;
    const resourceVersionId = taskResourceVersion(task);
    const version = resourceVersionId && sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
    if (!version) return;
    const versionStatus = version.active_processing_run_id ? "indexed" : (status === "retrying" ? "pending" : "failed");
    sqlite.prepare("UPDATE resource_versions SET status=?,error_summary=?,updated_at=? WHERE id=?").run(versionStatus, task.errorSummary || null, timestamp, version.id);
    refreshResourceStatus(sqlite, version.resource_id, timestamp);
    audit(status, "resource_version", version.id, { error: task.errorSummary, errorCode: task.errorCode, attempt: task.attempt });
  };

  const failTask = sqlite.transaction((task, errorSummary, errorCode = null) => {
    const retryable = transientCodes.has(errorCode) && task.retry_count < task.retry_limit;
    const status = retryable ? "retrying" : "failed";
    const timestamp = now();
    const nextAttemptAt = retryable ? new Date(Date.now() + retryDelayMs(task.retry_count)).toISOString() : null;
    sqlite.prepare("UPDATE tasks SET status=?,progress=0,error_code=?,error_summary=?,next_attempt_at=?,finished_at=?,worker_id=NULL,updated_at=? WHERE id=?").run(status, errorCode, errorSummary, nextAttemptAt, retryable ? null : timestamp, timestamp, task.id);
    sqlite.prepare("UPDATE task_attempts SET status='failed',finished_at=?,error_code=?,error_summary=? WHERE task_id=? AND attempt_number=?").run(timestamp, errorCode, errorSummary, task.id, task.attempt);
    updateResourceAfterFailure({ ...task, errorSummary, errorCode }, timestamp, status);
    audit(status, "task", task.id, { workerId, attempt: task.attempt, errorSummary, errorCode, retryCount: task.retry_count, nextAttemptAt });
    return status;
  });

  const recoverInterruptedTasks = sqlite.transaction(() => {
    const timestamp = now();
    for (const task of sqlite.prepare("SELECT * FROM tasks WHERE status='running'").all()) {
      const retryCount = task.retry_count + 1;
      const cancelled = Boolean(task.cancel_requested);
      const retryable = !cancelled && retryCount < task.retry_limit;
      const status = retryable ? "retrying" : "failed";
      const errorCode = cancelled ? "TASK_CANCELLED" : "WORKER_INTERRUPTED";
      const errorSummary = cancelled ? "Task cancellation requested" : "Worker interrupted";
      const nextAttemptAt = retryable ? new Date(Date.now() + retryDelayMs(retryCount)).toISOString() : null;
      sqlite.prepare("UPDATE tasks SET status=?,progress=0,retry_count=?,error_code=?,error_summary=?,next_attempt_at=?,finished_at=?,worker_id=NULL,updated_at=? WHERE id=? AND status='running'").run(status, retryCount, errorCode, errorSummary, nextAttemptAt, retryable ? null : timestamp, timestamp, task.id);
      sqlite.prepare("UPDATE task_attempts SET status='failed',finished_at=?,error_code=?,error_summary=? WHERE task_id=? AND status='running'").run(timestamp, errorCode, errorSummary, task.id);
      const resourceVersionId = taskResourceVersion(task);
      const version = resourceVersionId && sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
      if (version) {
        sqlite.prepare("UPDATE processing_runs SET status='failed',error_code=?,error_summary=?,updated_at=? WHERE resource_version_id=? AND status='processing'").run(errorCode, errorSummary, timestamp, version.id);
        sqlite.prepare("UPDATE resource_versions SET status=?,error_summary=?,updated_at=? WHERE id=?").run(version.active_processing_run_id ? "indexed" : (retryable ? "pending" : "failed"), errorSummary, timestamp, version.id);
        refreshResourceStatus(sqlite, version.resource_id, timestamp);
      }
      audit(cancelled ? "cancelled" : "interrupted", "task", task.id, { workerId, retryCount, status, errorCode });
    }
  });

  const runOne = async () => {
    const task = claim();
    if (!task) return false;
    const controller = new AbortController();
    activeControllers.set(task.id, controller);
    try {
      if (task.type === "resource:process") await processResource({ ...task, signal: controller.signal });
      else if (task.type === "demo_failure") throw Object.assign(new Error("Deterministic demo failure"), { code: "PERMANENT_ERROR" });
      else if (task.type === "demo_retryable") throw Object.assign(new Error("Deterministic transient failure"), { code: "TRANSIENT_ERROR" });
      else if (task.type !== "demo_success") throw Object.assign(new Error("Unsupported task type"), { code: "PERMANENT_ERROR" });
      finish(task, "succeeded");
    } catch (caught) {
      const baseMessage = caught instanceof Error ? caught.message : "processing failed";
      const errorCode = typeof caught?.code === "string" ? caught.code : "PERMANENT_ERROR";
      const message = `${errorCode}: ${baseMessage}`;
      const status = failTask(task, message, errorCode);
      console.error(`Task ${task.id} failed: ${message}`);
      if (status === "retrying") console.log(`Task ${task.id} scheduled for retry ${task.retry_count}/${task.retry_limit}`);
    } finally {
      activeControllers.delete(task.id);
    }
    return true;
  };

  const cancel = (taskId) => {
    const controller = activeControllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  };

  return { recoverInterruptedTasks, runOne, cancel };
};
