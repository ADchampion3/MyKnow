import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrate, persistBytes, sha256 } from "@myknow/db";
import { rebuildDatabase } from "./recreate-db.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-sprint3-rebuild-"));
const databaseFile = path.join(root, "knowledge.db");
const storage = path.join(root, "resources");
fs.mkdirSync(storage, { recursive: true });
const timestamp = new Date().toISOString();
const ids = { kb: crypto.randomUUID(), resource: crypto.randomUUID(), version: crypto.randomUUID(), run: crypto.randomUUID(), audit: crypto.randomUUID() };
const bytes = Buffer.from("rebuild source material");
const digest = sha256(bytes);
const storageKey = `blobs/${digest.slice(0, 2)}/${digest}`;

try {
  persistBytes(storage, storageKey, bytes);
  const initial = createDatabase(`file:${databaseFile}`);
  migrate(initial.sqlite);
  initial.sqlite.transaction(() => {
    initial.sqlite.prepare("INSERT INTO knowledge_bases (id,name,chunking_config,wiki_default_mode,status,created_at,updated_at) VALUES (?,?,?,'enabled','active',?,?)").run(ids.kb, "Rebuild KB", "{}", timestamp, timestamp);
    initial.sqlite.prepare("INSERT INTO resources (id,name,source_type,wiki_mode,status,current_version_id,created_at,updated_at) VALUES (?,?,?,'retrieval_only','indexed',NULL,?,?)").run(ids.resource, "Rebuild source", "text", timestamp, timestamp);
    initial.sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(ids.resource, ids.kb, timestamp);
    initial.sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'indexed',?,?)").run(ids.version, ids.resource, digest, storageKey, "text/plain", bytes.length, timestamp, timestamp);
    initial.sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,input_sha256,created_at,updated_at) VALUES (?,?, 'indexed',?,?,?)").run(ids.run, ids.version, digest, timestamp, timestamp);
    initial.sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(ids.run, ids.version);
    initial.sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(ids.version, ids.resource);
    initial.sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,metadata,created_at) VALUES (?,?,?,?,?,?)").run(ids.audit, "imported", "resource_version", ids.version, JSON.stringify({ preserved: true }), timestamp);
  })();
  initial.sqlite.close();

  const rebuilt = rebuildDatabase({ target: databaseFile, resourceStorageDir: storage });
  assert.equal(rebuilt.schemaVersion, "sprint5-agent-tree-v1");
  assert.equal(rebuilt.rawStoragePreserved, true);
  assert.equal(rebuilt.storage.checked, 1);
  assert.equal(rebuilt.before.resources, rebuilt.after.resources);
  assert.equal(rebuilt.before.resourceVersions, rebuilt.after.resourceVersions);
  assert.equal(rebuilt.before.auditLogs, rebuilt.after.auditLogs);
  const restored = createDatabase(`file:${databaseFile}`);
  assert.equal(restored.sqlite.prepare("SELECT id FROM resources WHERE id=? AND current_version_id=? AND wiki_mode='retrieval_only'").get(ids.resource, ids.version).id, ids.resource);
  assert.equal(restored.sqlite.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, "sprint5-agent-tree-v1");
  assert.equal(restored.sqlite.prepare("SELECT value FROM schema_meta WHERE key='derived_schema'").get().value, "sprint5-agent-tree-derived-ready");
  for (const table of ["wiki_fts", "wiki_link_edges", "retrieval_embeddings", "retrieval_runs"]) assert.ok(restored.sqlite.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), `missing rebuilt derived table ${table}`);
  assert.equal(restored.sqlite.prepare("SELECT active_processing_run_id FROM resource_versions WHERE id=?").get(ids.version).active_processing_run_id, ids.run);
  assert.equal(restored.sqlite.prepare("SELECT metadata FROM audit_logs WHERE id=?").get(ids.audit).metadata, JSON.stringify({ preserved: true }));
  restored.sqlite.close();

  fs.rmSync(storage, { recursive: true, force: true });
  assert.throws(() => rebuildDatabase({ target: databaseFile, resourceStorageDir: storage }), /source storage is missing/);
  const stillThere = createDatabase(`file:${databaseFile}`);
  assert.equal(stillThere.sqlite.prepare("SELECT id FROM resources WHERE id=?").get(ids.resource).id, ids.resource);
  stillThere.sqlite.close();
  console.log(JSON.stringify({ status: "passed", before: rebuilt.before, after: rebuilt.after, backup: rebuilt.backup, failedRebuildPreservedDatabase: true }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
