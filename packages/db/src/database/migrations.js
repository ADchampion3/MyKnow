const SCHEMA_VERSION = "sprint2-pdf-ocr-v2";

const migration = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE knowledge_bases (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), description TEXT, chunking_config TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(name));
CREATE TABLE spaces (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(knowledge_base_id, name));
CREATE TABLE tags (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(knowledge_base_id, name));
CREATE TABLE resources (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), source_type TEXT NOT NULL CHECK(source_type IN ('text','file')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','degraded','failed','archived')), current_version_id TEXT REFERENCES resource_versions(id) DEFERRABLE INITIALLY DEFERRED, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE resource_versions (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64), storage_key TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size > 0), original_filename TEXT, title TEXT, parser_name TEXT, parser_version TEXT, parse_duration_ms INTEGER, chunking_config TEXT, ocr_mode TEXT NOT NULL DEFAULT 'off' CHECK(ocr_mode IN ('auto','off','force')), ocr_provider TEXT CHECK(ocr_provider IS NULL OR ocr_provider IN ('local','cloud','paddleocr')), ocr_capabilities TEXT, active_processing_run_id TEXT REFERENCES processing_runs(id) DEFERRABLE INITIALLY DEFERRED, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','failed')), error_summary TEXT, idempotency_key TEXT UNIQUE, request_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(mime_type <> 'application/pdf' OR ocr_provider IS NOT NULL));
CREATE TABLE resource_knowledge_bases (resource_id TEXT NOT NULL REFERENCES resources(id), knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), created_at TEXT NOT NULL, PRIMARY KEY(resource_id, knowledge_base_id));
CREATE TABLE tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL, resource_version_id TEXT REFERENCES resource_versions(id), payload TEXT, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','retrying')), progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), retry_limit INTEGER NOT NULL DEFAULT 3 CHECK(retry_limit > 0), retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0), next_attempt_at TEXT, worker_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)), error_code TEXT, error_summary TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), worker_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT, error_summary TEXT, UNIQUE(task_id, attempt_number));
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, request_id TEXT, metadata TEXT, created_at TEXT NOT NULL);
CREATE TABLE processing_runs (id TEXT PRIMARY KEY, resource_version_id TEXT NOT NULL REFERENCES resource_versions(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','failed','superseded')), parser_name TEXT, parser_version TEXT, chunker_name TEXT, chunker_version TEXT, chunking_config TEXT, input_sha256 TEXT CHECK(input_sha256 IS NULL OR length(input_sha256)=64), requested_ocr_mode TEXT CHECK(requested_ocr_mode IS NULL OR requested_ocr_mode IN ('auto','off','force')), requested_ocr_provider TEXT CHECK(requested_ocr_provider IS NULL OR requested_ocr_provider IN ('local','cloud','paddleocr')), actual_provider TEXT CHECK(actual_provider IS NULL OR actual_provider IN ('local','cloud','paddleocr')), adapter_name TEXT, adapter_version TEXT, model_name TEXT, model_version TEXT, provider_request_id TEXT, duration_ms INTEGER, page_count INTEGER, capabilities TEXT, metrics TEXT, canonical_storage_key TEXT, canonical_sha256 TEXT, canonical_byte_size INTEGER, block_count INTEGER NOT NULL DEFAULT 0, parent_count INTEGER NOT NULL DEFAULT 0, child_count INTEGER NOT NULL DEFAULT 0, output_sha256 TEXT, warning_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE processing_run_attempts (id TEXT PRIMARY KEY, processing_run_id TEXT NOT NULL REFERENCES processing_runs(id), reader_name TEXT NOT NULL, reader_version TEXT, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), error_code TEXT, error_summary TEXT, metadata TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE chunks (id TEXT PRIMARY KEY, resource_version_id TEXT NOT NULL REFERENCES resource_versions(id), processing_run_id TEXT NOT NULL REFERENCES processing_runs(id), parent_chunk_id TEXT REFERENCES chunks(id), chunk_type TEXT NOT NULL DEFAULT 'text' CHECK(chunk_type IN ('text','parent_text')), sequence INTEGER NOT NULL, content TEXT NOT NULL, context_header TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, locator TEXT NOT NULL, strategy TEXT NOT NULL, forced_split INTEGER NOT NULL DEFAULT 0 CHECK(forced_split IN (0,1)), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')), created_at TEXT NOT NULL, UNIQUE(processing_run_id, sequence));
CREATE VIRTUAL TABLE resource_fts USING fts5(chunk_id UNINDEXED, content, title);
CREATE INDEX resource_versions_resource_id_idx ON resource_versions(resource_id, created_at, id);
CREATE INDEX resource_knowledge_bases_kb_idx ON resource_knowledge_bases(knowledge_base_id, resource_id);
CREATE INDEX processing_runs_version_idx ON processing_runs(resource_version_id, created_at, id);
CREATE INDEX chunks_version_idx ON chunks(resource_version_id, processing_run_id, sequence);
CREATE INDEX chunks_parent_idx ON chunks(parent_chunk_id);
CREATE INDEX tasks_resource_version_idx ON tasks(resource_version_id, created_at);
CREATE UNIQUE INDEX tasks_resource_active_idx ON tasks(resource_version_id) WHERE type='resource:process' AND resource_version_id IS NOT NULL AND status IN ('queued','running','retrying');
`;

const userObject = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' LIMIT 1").get();

export function migrate(sqlite) {
  const timestamp = new Date().toISOString();
  const existing = userObject(sqlite);
  if (existing) {
    const hasMeta = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
    const marker = hasMeta ? sqlite.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() : null;
    if (marker?.value !== SCHEMA_VERSION) throw Object.assign(new Error(`database schema is unsupported; recreate the database file for ${SCHEMA_VERSION}`), { code: "DATABASE_RECREATE_REQUIRED" });
    return { fresh: false, schemaVersion: SCHEMA_VERSION };
  }
  sqlite.transaction(() => {
    sqlite.exec(migration);
    sqlite.prepare("INSERT INTO schema_meta (key,value,updated_at) VALUES ('schema_version',?,?)").run(SCHEMA_VERSION, timestamp);
    sqlite.prepare("INSERT INTO schema_meta (key,value,updated_at) VALUES ('derived_schema','ready',?)").run(timestamp);
  })();
  return { fresh: true, schemaVersion: SCHEMA_VERSION };
}

export { SCHEMA_VERSION };
