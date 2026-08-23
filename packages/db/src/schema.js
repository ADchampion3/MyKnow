import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
};

export const knowledgeBases = sqliteTable("knowledge_bases", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description"), chunkingConfig: text("chunking_config"), status: text("status").notNull().default("active"), ...timestamps
});
export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(), knowledgeBaseId: text("knowledge_base_id").notNull(), name: text("name").notNull(), status: text("status").notNull().default("active"), ...timestamps
});
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(), knowledgeBaseId: text("knowledge_base_id").notNull(), name: text("name").notNull(), ...timestamps
});
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), type: text("type").notNull(), resourceVersionId: text("resource_version_id"), payload: text("payload"), status: text("status").notNull().default("queued"), progress: integer("progress").notNull().default(0), retryLimit: integer("retry_limit").notNull().default(3), retryCount: integer("retry_count").notNull().default(0), nextAttemptAt: text("next_attempt_at"), workerId: text("worker_id"), errorCode: text("error_code"), errorSummary: text("error_summary"), startedAt: text("started_at"), finishedAt: text("finished_at"), ...timestamps
});
export const taskAttempts = sqliteTable("task_attempts", {
  id: text("id").primaryKey(), taskId: text("task_id").notNull(), attemptNumber: integer("attempt_number").notNull(), status: text("status").notNull(), workerId: text("worker_id"), startedAt: text("started_at").notNull(), finishedAt: text("finished_at"), errorCode: text("error_code"), errorSummary: text("error_summary")
});
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), eventType: text("event_type").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), requestId: text("request_id"), metadata: text("metadata"), createdAt: text("created_at").notNull()
});
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(), name: text("name").notNull(), sourceType: text("source_type").notNull(), status: text("status").notNull().default("pending"), currentVersionId: text("current_version_id"), archivedAt: text("archived_at"), ...timestamps
});
export const resourceVersions = sqliteTable("resource_versions", {
  id: text("id").primaryKey(), resourceId: text("resource_id").notNull(), contentSha256: text("content_sha256").notNull(), storageKey: text("storage_key").notNull(), mimeType: text("mime_type").notNull(), byteSize: integer("byte_size").notNull(), originalFilename: text("original_filename"), title: text("title"), parserName: text("parser_name"), parserVersion: text("parser_version"), parseDurationMs: integer("parse_duration_ms"), chunkingConfig: text("chunking_config"), activeProcessingRunId: text("active_processing_run_id"), status: text("status").notNull().default("pending"), errorSummary: text("error_summary"), idempotencyKey: text("idempotency_key"), requestFingerprint: text("request_fingerprint"), ...timestamps
});
export const processingRuns = sqliteTable("processing_runs", {
  id: text("id").primaryKey(), resourceVersionId: text("resource_version_id").notNull(), status: text("status").notNull().default("pending"), parserName: text("parser_name"), parserVersion: text("parser_version"), chunkerName: text("chunker_name"), chunkerVersion: text("chunker_version"), chunkingConfig: text("chunking_config"), inputSha256: text("input_sha256"), canonicalStorageKey: text("canonical_storage_key"), canonicalSha256: text("canonical_sha256"), canonicalByteSize: integer("canonical_byte_size"), blockCount: integer("block_count").notNull().default(0), parentCount: integer("parent_count").notNull().default(0), childCount: integer("child_count").notNull().default(0), outputSha256: text("output_sha256"), warningCount: integer("warning_count").notNull().default(0), errorCode: text("error_code"), errorSummary: text("error_summary"), ...timestamps
});
export const processingRunAttempts = sqliteTable("processing_run_attempts", {
  id: text("id").primaryKey(), processingRunId: text("processing_run_id").notNull(), readerName: text("reader_name").notNull(), readerVersion: text("reader_version"), status: text("status").notNull(), errorCode: text("error_code"), errorSummary: text("error_summary"), metadata: text("metadata"), startedAt: text("started_at").notNull(), finishedAt: text("finished_at")
});
export const resourceKnowledgeBases = sqliteTable("resource_knowledge_bases", {
  resourceId: text("resource_id").notNull(), knowledgeBaseId: text("knowledge_base_id").notNull(), createdAt: text("created_at").notNull()
});
export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(), resourceVersionId: text("resource_version_id").notNull(), processingRunId: text("processing_run_id").notNull(), parentChunkId: text("parent_chunk_id"), chunkType: text("chunk_type").notNull().default("text"), sequence: integer("sequence").notNull(), content: text("content").notNull(), contextHeader: text("context_header"), startOffset: integer("start_offset").notNull(), endOffset: integer("end_offset").notNull(), locator: text("locator").notNull(), strategy: text("strategy").notNull(), forcedSplit: integer("forced_split").notNull().default(0), status: text("status").notNull().default("active"), createdAt: text("created_at").notNull()
});
