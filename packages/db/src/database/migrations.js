const migration = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), description TEXT, chunking_config TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(name));
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(knowledge_base_id, name));
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(knowledge_base_id, name));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','retrying')), progress INTEGER NOT NULL DEFAULT 0, retry_limit INTEGER NOT NULL DEFAULT 3, retry_count INTEGER NOT NULL DEFAULT 0, worker_id TEXT, error_summary TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), worker_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, error_summary TEXT, UNIQUE(task_id, attempt_number));
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, request_id TEXT, metadata TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('file','url')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','failed','archived')), current_version_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resource_versions (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), content_sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, title TEXT, source_url TEXT, fetched_at TEXT, parser_name TEXT, parser_version TEXT, parse_duration_ms INTEGER, chunking_config TEXT, active_processing_run_id TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','failed')), error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(resource_id, content_sha256));
CREATE TABLE IF NOT EXISTS resource_knowledge_bases (resource_id TEXT NOT NULL REFERENCES resources(id), knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id), created_at TEXT NOT NULL, PRIMARY KEY(resource_id, knowledge_base_id));
CREATE TABLE IF NOT EXISTS processing_runs (id TEXT PRIMARY KEY, resource_version_id TEXT NOT NULL REFERENCES resource_versions(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','indexed','failed','superseded')), parser_name TEXT, parser_version TEXT, chunker_name TEXT, chunker_version TEXT, chunking_config TEXT, input_sha256 TEXT, canonical_storage_key TEXT, canonical_sha256 TEXT, canonical_byte_size INTEGER, block_count INTEGER NOT NULL DEFAULT 0, parent_count INTEGER NOT NULL DEFAULT 0, child_count INTEGER NOT NULL DEFAULT 0, output_sha256 TEXT, warning_count INTEGER NOT NULL DEFAULT 0, error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS processing_run_attempts (id TEXT PRIMARY KEY, processing_run_id TEXT NOT NULL REFERENCES processing_runs(id), reader_name TEXT NOT NULL, reader_version TEXT, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), error_code TEXT, error_summary TEXT, metadata TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, resource_version_id TEXT NOT NULL REFERENCES resource_versions(id), processing_run_id TEXT NOT NULL REFERENCES processing_runs(id), parent_chunk_id TEXT, chunk_type TEXT NOT NULL DEFAULT 'text' CHECK(chunk_type IN ('text','parent_text')), sequence INTEGER NOT NULL, content TEXT NOT NULL, context_header TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, locator TEXT NOT NULL, strategy TEXT NOT NULL, forced_split INTEGER NOT NULL DEFAULT 0 CHECK(forced_split IN (0,1)), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')), created_at TEXT NOT NULL, UNIQUE(processing_run_id, sequence));
CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(chunk_id UNINDEXED, content, title);
CREATE INDEX IF NOT EXISTS resource_versions_resource_id_idx ON resource_versions(resource_id, created_at);
CREATE INDEX IF NOT EXISTS resource_knowledge_bases_kb_idx ON resource_knowledge_bases(knowledge_base_id, resource_id);
CREATE INDEX IF NOT EXISTS processing_runs_version_idx ON processing_runs(resource_version_id, created_at);
CREATE INDEX IF NOT EXISTS chunks_version_idx ON chunks(resource_version_id, processing_run_id, sequence);
CREATE INDEX IF NOT EXISTS chunks_parent_idx ON chunks(parent_chunk_id);
`;

export function migrate(sqlite) {
  const now = new Date().toISOString();
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const chunkTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'").get();
  const chunkColumns = chunkTable ? sqlite.prepare("PRAGMA table_info(chunks)").all().map((column) => column.name) : [];
  const legacyDerivedSchema = chunkTable && !chunkColumns.includes("processing_run_id");
  const rebuildMarker = sqlite.prepare("SELECT value FROM schema_meta WHERE key='derived_schema_v2'").get();
  if (legacyDerivedSchema && !rebuildMarker) {
    // Breaking-development policy: chunks and FTS are derived data and are rebuilt from immutable source bytes.
    sqlite.exec("DROP TABLE IF EXISTS resource_fts; DROP TABLE IF EXISTS chunks;");
  }
  sqlite.exec(migration);
  const knowledgeBaseColumns = sqlite.prepare("PRAGMA table_info(knowledge_bases)").all().map((column) => column.name);
  if (!knowledgeBaseColumns.includes("chunking_config")) sqlite.exec("ALTER TABLE knowledge_bases ADD COLUMN chunking_config TEXT");
  const versionColumns = sqlite.prepare("PRAGMA table_info(resource_versions)").all().map((column) => column.name);
  if (!versionColumns.includes("chunking_config")) sqlite.exec("ALTER TABLE resource_versions ADD COLUMN chunking_config TEXT");
  if (!versionColumns.includes("active_processing_run_id")) sqlite.exec("ALTER TABLE resource_versions ADD COLUMN active_processing_run_id TEXT");
  const columns = sqlite.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name);
  if (!columns.includes("payload")) sqlite.exec("ALTER TABLE tasks ADD COLUMN payload TEXT");
  if (legacyDerivedSchema && !rebuildMarker) {
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE resource_versions SET status='pending',active_processing_run_id=NULL,error_summary='Derived data rebuild required',updated_at=?").run(now);
      sqlite.prepare("UPDATE resources SET status=CASE WHEN status='archived' THEN status ELSE 'pending' END,updated_at=?").run(now);
      sqlite.prepare("INSERT INTO schema_meta (key,value,updated_at) VALUES ('derived_schema_v2','full-rebuild-required',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(now);
    })();
    return { requiresFullRebuild: true };
  }
  sqlite.prepare("INSERT INTO schema_meta (key,value,updated_at) VALUES ('derived_schema_v2','ready',?) ON CONFLICT(key) DO NOTHING").run(now);
  return { requiresFullRebuild: false };
}
