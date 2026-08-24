import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentStorageKey, createDatabase, migrate, orphanStorageFiles, persistBytes, safeStoragePath, sha256 } from "./index.js";

const { sqlite } = createDatabase(":memory:");
const first = migrate(sqlite);
assert.equal(first.fresh, true);
assert.equal(migrate(sqlite).fresh, false);
const now = new Date().toISOString();
sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), "check", "active", now, now);
assert.throws(() => sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), "   ", "active", now, now));
assert.throws(() => safeStoragePath("./data/resources", "../outside"));
assert.equal(sqlite.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, "sprint2-pdf-ocr-v2");
assert.ok(sqlite.prepare("PRAGMA index_list(tasks)").all().some((index) => index.name === "tasks_resource_active_idx"));
sqlite.close();

const legacy = createDatabase(":memory:").sqlite;
legacy.exec("CREATE TABLE old_table (id TEXT PRIMARY KEY)");
assert.throws(() => migrate(legacy), (caught) => caught.code === "DATABASE_RECREATE_REQUIRED");
legacy.close();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-db-check-"));
try {
  const bytes = Buffer.from("immutable blob");
  const key = contentStorageKey(sha256(bytes));
  persistBytes(root, key, bytes);
  fs.writeFileSync(path.join(root, "orphan.txt"), "orphan");
  assert.deepEqual(orphanStorageFiles(root, [key]), ["orphan.txt"]);
  assert.equal(fs.readFileSync(safeStoragePath(root, key)).toString(), "immutable blob");
  assert.throws(() => persistBytes(root, key, Buffer.from("tampered")), (caught) => caught.code === "SOURCE_INTEGRITY_FAILED");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("db self-check passed");
