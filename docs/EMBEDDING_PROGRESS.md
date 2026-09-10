# Embedding progress and operational logs

## User-facing model

File processing is shown at the `processing_run` level. The normal workspace displays one row per resource run with:

- `ready / total` as the success progress;
- separate queued, running, retrying, failed, cancelled, and missing counts;
- provider, model, and dimensions;
- grouped failure codes;
- cancellation for all pending embedding chunks in the run;
- one-click retry for failed, cancelled, or missing chunks only.

The UI does not invent an overall weighted percentage or ETA. Parse/chunk/FTS completion and vector completion remain separate: keyword search can be usable while embedding is still running. A run becomes `completed` only when every text chunk has a usable embedding; partial terminal failures become `degraded`.

## API contract

`GET /api/knowledge-bases/:knowledgeBaseId/processing-runs?page=1&limit=50` returns scoped, paginated run summaries. Resource and version responses also include `embeddingProgress` for the latest/current run.

`GET /api/resources/:resourceId/processing-runs` returns the existing run history with `embeddingProgress` added.

`GET /api/resources/:resourceId/processing-runs/:runId/embedding-tasks?page=1&limit=50&status=failed&errorCode=...` returns on-demand, paginated item details. Details contain sequence, locator, retry state, error code/summary, provider/model, dimensions, and input hash. They do not contain source content, vectors, or task payloads.

`POST /api/resources/:resourceId/processing-runs/:runId/cancel` requests cancellation of all queued, retrying, and running embedding tasks in that processing run. Queued/retrying tasks become cancelled immediately; a running provider request is aborted by the worker when it observes the durable cancellation flag. The response reports how many tasks were requested, completed immediately, or are still stopping.

`POST /api/resources/:resourceId/processing-runs/:runId/retry` creates new embedding tasks only for failed, cancelled, or missing chunks. Successful chunks are not re-embedded, and old task attempts remain retained for auditability. The operation is safe to repeat while a retry is already queued.

`GET /api/knowledge-bases/:knowledgeBaseId/audit-events?page=1&limit=50&eventType=...&resourceVersionId=...&processingRunId=...` returns scoped high-level audit events. Per-embedding task lifecycle events and historical `embedding_ready`/`embedding_failed` rows are filtered from this view, but remain stored for auditability.

## Storage and recovery

Embedding tasks carry `tasks.processing_run_id`, with a migration backfill from the existing task payload. Live counts are derived from text chunks, embedding tasks, and retrieval embeddings. Once a run is terminal, the summary is stored in `processing_runs.metrics.embedding`; worker startup reconciles indexed runs so a restart does not reset progress.

When a new generation supersedes an old one, old run summaries remain queryable. Queued/retrying old embedding tasks are marked non-actionable, and runs are never merged. A cancelled run is shown as cancelled when no chunk has succeeded, or degraded when some chunks remain usable; it can be resumed through the run-level retry action.

Original files, resource versions, processing runs, tasks, task attempts, and audit records are retained. This change does not add task cleanup or compaction.

## Verification

The repository test suite covers fresh startup, migration/backfill, aggregation, snapshot persistence, scoped API contracts, paginated detail responses, run-level cancellation/retry, and worker cancellation polling. End-to-end browser tests are intentionally deferred for this change; a manual smoke check should import a synthetic file producing 1,000+ text chunks, cancel the run, confirm the counts settle, click one-click retry, and confirm only failed/cancelled/missing counts re-enter the queue on the next five-second poll.
