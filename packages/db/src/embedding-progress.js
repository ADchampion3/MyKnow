import { createEmbeddingTaskCache, queueEmbeddingTask } from "./retrieval.js";
import { now } from "./resources.js";

export const EMBEDDING_PROGRESS_SCHEMA_VERSION = "embedding-progress-v1";

const jsonParse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

const embeddingConfig = (config = null) => ({
  enabled: config?.retrievalVectorEnabled !== false,
  provider: config?.embeddingProvider || "mock",
  model: config?.embeddingModel || "mock-hash-v1",
  dimensions: Number(config?.embeddingDimensions || 32)
});

const runFor = (sqlite, processingRunId) => sqlite.prepare(`
  SELECT pr.*,rv.resource_id,r.name AS resource_name,rv.active_processing_run_id
  FROM processing_runs pr
  JOIN resource_versions rv ON rv.id=pr.resource_version_id
  JOIN resources r ON r.id=rv.resource_id
  WHERE pr.id=?
`).get(processingRunId);

// ponytail: recompute one run from retained task/chunk/embedding rows; add a materialized progress table only after measured run volume makes this scan a bottleneck.
const tasksFor = (sqlite, run) => sqlite.prepare(`
  SELECT * FROM tasks
  WHERE type='retrieval:embed'
    AND (processing_run_id=? OR (processing_run_id IS NULL AND resource_version_id=?))
  ORDER BY created_at DESC,id DESC
`).all(run.id, run.resource_version_id).filter((task) => {
  if (task.processing_run_id) return task.processing_run_id === run.id;
  return jsonParse(task.payload, {}).processingRunId === run.id;
});

const chunksFor = (sqlite, run) => sqlite.prepare(`
  SELECT id,sequence,locator
  FROM chunks
  WHERE resource_version_id=? AND processing_run_id=? AND chunk_type='text'
  ORDER BY sequence,id
`).all(run.resource_version_id, run.id);

const embeddingsFor = (sqlite, run, config) => sqlite.prepare(`
  SELECT * FROM retrieval_embeddings
  WHERE owner_type='raw_chunk' AND resource_version_id=? AND processing_run_id=?
  ORDER BY updated_at DESC,id DESC
`).all(run.resource_version_id, run.id).filter((row) => row.provider === config.provider && row.model === config.model);

const latestBy = (rows, key) => {
  const result = new Map();
  for (const row of rows) {
    const value = row[key];
    if (value && !result.has(value)) result.set(value, row);
  }
  return result;
};

const taskPayload = (task) => jsonParse(task?.payload, {});
const activeTaskStatuses = new Set(["queued", "running", "retrying"]);
const errorCodeFrom = (summary) => typeof summary === "string" ? summary.match(/^([A-Z][A-Z0-9_]{2,80}):\s/)?.[1] || null : null;
const itemError = (task, embedding) => ({
  errorCode: task?.error_code || errorCodeFrom(embedding?.error_summary) || null,
  errorSummary: task?.error_summary || embedding?.error_summary || null
});
const fallbackErrorCode = (status, errorCode) => errorCode || (status === "missing" ? "EMBEDDING_MISSING" : status === "cancelled" ? "TASK_CANCELLED" : status === "failed" ? "EMBEDDING_FAILED" : null);

const itemStatus = (task, embedding, config) => {
  if (activeTaskStatuses.has(task?.status)) return task.status;
  if (embedding?.status === "ready" && Number(embedding.dimensions) === config.dimensions) return "ready";
  if (task?.status === "failed" || embedding?.status === "failed") return task?.error_code === "TASK_CANCELLED" ? "cancelled" : "failed";
  if (task?.status === "succeeded") return "missing";
  return "missing";
};

const errorGroupsFor = (items, config) => {
  const groups = new Map();
  for (const item of items.filter((candidate) => ["failed", "cancelled", "missing"].includes(candidate.status))) {
    const errorCode = fallbackErrorCode(item.status, item.errorCode);
    const provider = item.provider || config.provider;
    const model = item.model || config.model;
    const key = `${errorCode}\u0000${provider}\u0000${model}`;
    const group = groups.get(key) || { errorCode, provider, model, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.errorCode.localeCompare(right.errorCode));
};

const statusFor = ({ run, total, ready, pending, failed, cancelled, missing, enabled }) => {
  if (run.status === "superseded") return "superseded";
  if (run.status === "failed") return "failed";
  if (!enabled) return "disabled";
  if (run.status === "pending") return "pending";
  if (run.status === "processing") return "processing";
  if (pending > 0) return "running";
  if (total > 0 && ready === total) return "completed";
  if (failed + missing > 0) return ready > 0 ? "degraded" : "failed";
  if (cancelled > 0) return ready > 0 ? "degraded" : "cancelled";
  return "integrity_warning";
};

const buildProgress = ({ run, chunks, tasks, embeddings, config }) => {
  const taskByOwner = latestBy(tasks.map((task) => ({ ...task, owner_id: taskPayload(task).ownerId })), "owner_id");
  const embeddingByOwner = latestBy(embeddings, "owner_id");
  const items = chunks.map((chunk) => {
    const task = taskByOwner.get(chunk.id) || null;
    const embedding = embeddingByOwner.get(chunk.id) || null;
    const status = itemStatus(task, embedding, config);
    const error = itemError(task, embedding);
    return { chunkId: chunk.id, sequence: chunk.sequence, status, task, embedding, ...error };
  });
  const counts = {
    total: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    queued: items.filter((item) => item.status === "queued").length,
    running: items.filter((item) => item.status === "running").length,
    retrying: items.filter((item) => item.status === "retrying").length,
    failed: items.filter((item) => item.status === "failed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
    missing: items.filter((item) => item.status === "missing").length
  };
  const pending = counts.queued + counts.running + counts.retrying;
  const terminal = counts.ready + counts.failed + counts.cancelled + counts.missing;
  const status = statusFor({ run, ...counts, pending, enabled: config.enabled });
  return {
    schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION,
    processingRunId: run.id,
    resourceVersionId: run.resource_version_id,
    resourceId: run.resource_id,
    resourceName: run.resource_name,
    stage: run.status === "processing" || (run.status === "failed" && counts.total === 0) ? "processing" : "embedding",
    enabled: config.enabled,
    status,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    total: counts.total,
    ready: counts.ready,
    queued: counts.queued,
    running: counts.running,
    retrying: counts.retrying,
    pending,
    failed: counts.failed,
    cancelled: counts.cancelled,
    missing: counts.missing,
    terminal,
    progressPercent: counts.total ? Math.floor((counts.ready / counts.total) * 100) : 0,
    errorCode: run.error_code || null,
    errorSummary: run.error_summary || null,
    errorGroups: errorGroupsFor(items, config),
    updatedAt: run.updated_at
  };
};

const snapshotProgress = (run, snapshot, config) => ({
  schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION,
  processingRunId: run.id,
  resourceVersionId: run.resource_version_id,
  resourceId: run.resource_id,
  resourceName: run.resource_name,
  stage: "embedding",
  enabled: config.enabled,
  ...snapshot,
  status: run.status === "superseded" ? "superseded" : run.status === "failed" ? "failed" : config.enabled ? snapshot.status : "disabled",
  provider: snapshot.provider || config.provider,
  model: snapshot.model || config.model,
  dimensions: snapshot.dimensions || config.dimensions,
  updatedAt: run.updated_at
});

export const embeddingProgressForRun = (sqlite, processingRunId, config = null, { preferSnapshot = true } = {}) => {
  const run = runFor(sqlite, processingRunId);
  if (!run) return null;
  const resolvedConfig = embeddingConfig(config);
  const tasks = tasksFor(sqlite, run);
  const metrics = jsonParse(run.metrics, {});
  const snapshot = metrics.embedding;
  if (preferSnapshot && snapshot?.schemaVersion === EMBEDDING_PROGRESS_SCHEMA_VERSION && snapshot.finalizedAt && !tasks.some((task) => activeTaskStatuses.has(task.status))) {
    return snapshotProgress(run, snapshot, resolvedConfig);
  }
  return buildProgress({ run, chunks: chunksFor(sqlite, run), tasks, embeddings: embeddingsFor(sqlite, run, resolvedConfig), config: resolvedConfig });
};

export const embeddingProgressForVersion = (sqlite, resourceVersionId, config = null) => {
  const version = sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resourceVersionId);
  if (!version) return null;
  const run = sqlite.prepare(`
    SELECT id FROM processing_runs
    WHERE resource_version_id=?
    ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,created_at DESC,id DESC
    LIMIT 1
  `).get(resourceVersionId, version.active_processing_run_id || "");
  if (run) return embeddingProgressForRun(sqlite, run.id, config);
  const resolvedConfig = embeddingConfig(config);
  return {
    schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION,
    processingRunId: null,
    resourceVersionId,
    resourceId: version.resource_id,
    stage: "processing",
    enabled: resolvedConfig.enabled,
    status: resolvedConfig.enabled ? version.status === "failed" ? "failed" : "pending" : "disabled",
    provider: resolvedConfig.provider,
    model: resolvedConfig.model,
    dimensions: resolvedConfig.dimensions,
    total: 0,
    ready: 0,
    queued: 0,
    running: 0,
    retrying: 0,
    pending: 0,
    failed: 0,
    cancelled: 0,
    missing: 0,
    terminal: 0,
    progressPercent: 0,
    errorCode: null,
    errorSummary: version.error_summary || null,
    errorGroups: [],
    updatedAt: version.updated_at
  };
};

const embeddingItemsForRun = (sqlite, run, config) => {
  const tasks = latestBy(tasksFor(sqlite, run).map((task) => ({ ...task, owner_id: taskPayload(task).ownerId })), "owner_id");
  const embeddings = latestBy(embeddingsFor(sqlite, run, config), "owner_id");
  return chunksFor(sqlite, run).map((chunk) => {
    const task = tasks.get(chunk.id) || null;
    const embedding = embeddings.get(chunk.id) || null;
    const itemStatusValue = itemStatus(task, embedding, config);
    const error = itemError(task, embedding);
    return {
      chunkId: chunk.id,
      sequence: chunk.sequence,
      locator: jsonParse(chunk.locator, null),
      status: itemStatusValue,
      taskId: task?.id || null,
      taskStatus: task?.status || null,
      retryCount: task?.retry_count || 0,
      retryLimit: task?.retry_limit || 3,
      errorCode: fallbackErrorCode(itemStatusValue, error.errorCode),
      errorSummary: error.errorSummary,
      provider: embedding?.provider || config.provider,
      model: embedding?.model || config.model,
      dimensions: embedding?.dimensions || config.dimensions,
      inputSha256: embedding?.input_sha256 || null,
      updatedAt: embedding?.updated_at || task?.updated_at || run.updated_at
    };
  });
};

export const embeddingTasksForRun = (sqlite, { processingRunId, page = 1, limit = 50, status = null, errorCode = null, config = null }) => {
  const run = runFor(sqlite, processingRunId);
  if (!run) return null;
  const resolvedConfig = embeddingConfig(config);
  const items = embeddingItemsForRun(sqlite, run, resolvedConfig).filter((item) => (!status || item.status === status) && (!errorCode || item.errorCode === errorCode));
  const offset = (page - 1) * limit;
  return {
    schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION,
    processingRunId: run.id,
    resourceVersionId: run.resource_version_id,
    page,
    limit,
    total: items.length,
    pageCount: Math.ceil(items.length / limit),
    items: items.slice(offset, offset + limit)
  };
};

const retryableEmbeddingStatuses = new Set(["failed", "cancelled", "missing"]);

export const retryEmbeddingTasksForRun = (sqlite, { processingRunId, config = null } = {}) => {
  const run = runFor(sqlite, processingRunId);
  if (!run) return null;
  const resolvedConfig = embeddingConfig(config);
  if (!resolvedConfig.enabled) throw Object.assign(new Error("embedding is disabled"), { code: "EMBEDDING_DISABLED" });
  const result = sqlite.transaction(() => {
    const candidates = embeddingItemsForRun(sqlite, run, resolvedConfig).filter((item) => retryableEmbeddingStatuses.has(item.status));
    const activeTaskCache = createEmbeddingTaskCache(sqlite);
    const byStatus = { failed: 0, cancelled: 0, missing: 0 };
    let queued = 0;
    for (const item of candidates) {
      byStatus[item.status] += 1;
      const before = activeTaskCache.size;
      queueEmbeddingTask(sqlite, { ownerType: "raw_chunk", ownerId: item.chunkId, resourceVersionId: run.resource_version_id, processingRunId: run.id, reason: "manual-retry", activeTaskCache });
      if (activeTaskCache.size > before) queued += 1;
    }
    return { processingRunId: run.id, resourceVersionId: run.resource_version_id, retryable: candidates.length, queued, byStatus, progress: embeddingProgressForRun(sqlite, run.id, resolvedConfig, { preferSnapshot: false }) };
  })();
  return result;
};

export const cancelEmbeddingTasksForRun = (sqlite, { processingRunId, config = null } = {}) => {
  const run = runFor(sqlite, processingRunId);
  if (!run) return null;
  const resolvedConfig = embeddingConfig(config);
  return sqlite.transaction(() => {
    const active = tasksFor(sqlite, run).filter((task) => activeTaskStatuses.has(task.status));
    const timestamp = now();
    const cancel = sqlite.prepare("UPDATE tasks SET cancel_requested=1,status=CASE WHEN status IN ('queued','retrying') THEN 'failed' ELSE status END,progress=CASE WHEN status IN ('queued','retrying') THEN 0 ELSE progress END,error_code=CASE WHEN status IN ('queued','retrying') THEN 'TASK_CANCELLED' ELSE error_code END,error_summary=CASE WHEN status IN ('queued','retrying') THEN 'Task cancellation requested' ELSE error_summary END,next_attempt_at=CASE WHEN status IN ('queued','retrying') THEN NULL ELSE next_attempt_at END,finished_at=CASE WHEN status IN ('queued','retrying') THEN ? ELSE finished_at END,updated_at=? WHERE id=? AND status IN ('queued','running','retrying')");
    let requested = 0;
    let immediate = 0;
    let running = 0;
    for (const task of active) {
      const changes = cancel.run(timestamp, timestamp, task.id).changes;
      if (!changes) continue;
      requested += 1;
      if (["queued", "retrying"].includes(task.status)) immediate += 1;
      else running += 1;
    }
    return { processingRunId: run.id, requested, immediate, running, progress: embeddingProgressForRun(sqlite, run.id, resolvedConfig, { preferSnapshot: false }) };
  })();
};

const snapshotFrom = (progress, finalizedAt) => ({
  schemaVersion: EMBEDDING_PROGRESS_SCHEMA_VERSION,
  status: progress.status,
  provider: progress.provider,
  model: progress.model,
  dimensions: progress.dimensions,
  total: progress.total,
  ready: progress.ready,
  queued: progress.queued,
  running: progress.running,
  retrying: progress.retrying,
  pending: progress.pending,
  failed: progress.failed,
  cancelled: progress.cancelled,
  missing: progress.missing,
  terminal: progress.terminal,
  progressPercent: progress.progressPercent,
  errorGroups: progress.errorGroups,
  finalizedAt
});

export const reconcileEmbeddingProgress = (sqlite, { processingRunId, config = null, audit = null } = {}) => {
  const run = runFor(sqlite, processingRunId);
  if (!run || run.status !== "indexed") return embeddingProgressForRun(sqlite, processingRunId, config, { preferSnapshot: false });
  const progress = embeddingProgressForRun(sqlite, processingRunId, config, { preferSnapshot: false });
  if (!progress || progress.pending > 0 || !progress.enabled) return progress;
  const metrics = jsonParse(run.metrics, {});
  const finalizedAt = now();
  const snapshot = snapshotFrom(progress, finalizedAt);
  const previous = metrics.embedding;
  const comparable = (value) => JSON.stringify({ ...value, finalizedAt: undefined });
  if (previous?.schemaVersion === EMBEDDING_PROGRESS_SCHEMA_VERSION && comparable(previous) === comparable(snapshot)) return { ...progress, finalizedAt: previous.finalizedAt };
  sqlite.prepare("UPDATE processing_runs SET metrics=?,updated_at=? WHERE id=?").run(JSON.stringify({ ...metrics, embedding: snapshot }), finalizedAt, run.id);
  if (run.active_processing_run_id === run.id) {
    const resourceStatus = progress.status === "completed" ? "indexed" : "degraded";
    sqlite.prepare("UPDATE resources SET status=?,updated_at=? WHERE id=? AND current_version_id=? AND status <> 'archived'").run(resourceStatus, finalizedAt, run.resource_id, run.resource_version_id);
  }
  if (audit) {
    const eventType = progress.status === "completed" ? "embedding_completed" : progress.status === "cancelled" ? "embedding_cancelled" : progress.status === "degraded" ? "embedding_degraded" : "embedding_failed";
    audit(eventType, "processing_run", run.id, { processingRunId: run.id, resourceVersionId: run.resource_version_id, provider: progress.provider, model: progress.model, dimensions: progress.dimensions, total: progress.total, ready: progress.ready, failed: progress.failed, cancelled: progress.cancelled, missing: progress.missing, errorGroups: progress.errorGroups });
  }
  return { ...progress, finalizedAt };
};

export const reconcileEmbeddingRuns = (sqlite, { config = null, audit = null } = {}) => {
  let reconciled = 0;
  for (const row of sqlite.prepare("SELECT id FROM processing_runs WHERE status='indexed' ORDER BY updated_at,id").all()) {
    if (reconcileEmbeddingProgress(sqlite, { processingRunId: row.id, config, audit })) reconciled += 1;
  }
  return reconciled;
};
