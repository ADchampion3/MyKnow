import assert from "node:assert/strict";
import { createDatabase, ensurePendingResourceTasks, migrate, knowledgeBases, safeStoragePath } from "./index.js";

const { sqlite, db } = createDatabase(":memory:");
migrate(sqlite);
migrate(sqlite);
const now = new Date().toISOString();
db.insert(knowledgeBases).values({ id: crypto.randomUUID(), name: "check", status: "active", createdAt: now, updatedAt: now }).run();
assert.equal(db.select().from(knowledgeBases).all().length, 1);
assert.throws(() => db.insert(knowledgeBases).values({ id: crypto.randomUUID(), name: "   ", status: "active", createdAt: now, updatedAt: now }).run());
assert.throws(() => safeStoragePath("./data/resources", "../outside"));
assert.equal(sqlite.prepare("SELECT 1 FROM resource_fts LIMIT 1").get()?.["1"] ?? 1, 1);
sqlite.close();

const legacy = createDatabase(":memory:").sqlite;
legacy.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY,type TEXT,payload TEXT,status TEXT,progress INTEGER,retry_limit INTEGER,retry_count INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE resources (id TEXT PRIMARY KEY,name TEXT,source_type TEXT,status TEXT,current_version_id TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE resource_versions (id TEXT PRIMARY KEY,resource_id TEXT,content_sha256 TEXT,storage_key TEXT,mime_type TEXT,byte_size INTEGER,title TEXT,source_url TEXT,fetched_at TEXT,parser_name TEXT,parser_version TEXT,parse_duration_ms INTEGER,status TEXT,error_summary TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY,resource_version_id TEXT,sequence INTEGER,content TEXT,start_offset INTEGER,end_offset INTEGER,locator TEXT,status TEXT,created_at TEXT); CREATE VIRTUAL TABLE resource_fts USING fts5(chunk_id UNINDEXED,content,title); INSERT INTO resources VALUES ('legacy-resource','Legacy','file','indexed','legacy-version','2026-01-01','2026-01-01'); INSERT INTO resource_versions VALUES ('legacy-version','legacy-resource','legacy-hash','files/legacy.txt','text/plain',5,NULL,NULL,NULL,NULL,NULL,NULL,'indexed',NULL,'2026-01-01','2026-01-01'); INSERT INTO chunks VALUES ('legacy-chunk','legacy-version',0,'hello',0,5,'{}','active','2026-01-01');");
const migrationResult = migrate(legacy);
assert.equal(migrationResult.requiresFullRebuild, true);
assert.ok(legacy.prepare("PRAGMA table_info(chunks)").all().some((column) => column.name === "processing_run_id"));
assert.equal(legacy.prepare("SELECT status FROM resource_versions WHERE id='legacy-version'").get().status, "pending");
assert.equal(ensurePendingResourceTasks(legacy, "self-check"), 1);
assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM tasks WHERE type='resource:process'").get().n, 1);
legacy.close();
console.log("db self-check passed");
