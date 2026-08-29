import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, migrate, readBytes, rebuildRetrievalIndexes, SCHEMA_VERSION, sha256 } from "@myknow/db";

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const hasTable = (sqlite, name) => Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name=?").get(name));
const columnsFor = (sqlite, table) => new Set(sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map((column) => column.name));

const copyRows = (source, destination, table, { exclude = [] } = {}) => {
  if (!hasTable(source, table) || !hasTable(destination, table)) return 0;
  const sourceColumns = columnsFor(source, table);
  const destinationColumns = columnsFor(destination, table);
  const columns = [...sourceColumns].filter((column) => destinationColumns.has(column) && !exclude.includes(column));
  if (!columns.length) return 0;
  const rows = source.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).all();
  const insert = destination.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
  return rows.length;
};

const verifySourceStorage = (sqlite, resourceStorageDir) => {
  if (!hasTable(sqlite, "resource_versions")) return { checked: 0 };
  let checked = 0;
  for (const version of sqlite.prepare("SELECT id,storage_key,byte_size,content_sha256 FROM resource_versions ORDER BY id").all()) {
    let bytes;
    try { bytes = readBytes(resourceStorageDir, version.storage_key); }
    catch { throw new Error(`source storage is missing for resource version ${version.id}: ${version.storage_key}`); }
    if (bytes.length !== version.byte_size || sha256(bytes) !== version.content_sha256) throw new Error(`source storage integrity failed for resource version ${version.id}`);
    checked += 1;
  }
  return { checked };
};

const pointerRows = (sqlite, table, column, idColumn = "id") => hasTable(sqlite, table) ? sqlite.prepare(`SELECT "${idColumn}" AS id, "${column}" AS pointer FROM "${table}" WHERE "${column}" IS NOT NULL`).all() : [];

export const rebuildDatabase = ({ target, resourceStorageDir = path.resolve("data/resources") }) => {
  const database = path.resolve(target);
  if (path.extname(database).toLowerCase() !== ".db" || !fs.existsSync(database) || !fs.statSync(database).isFile()) throw new Error("database-file must be an existing .db file");
  const sourceCopy = `${database}.rebuild-source-${process.pid}-${Date.now()}.db`;
  const rebuilt = `${database}.rebuild-target-${process.pid}-${Date.now()}.db`;
  const backup = `${database}.pre-sprint5-${Date.now()}.bak`;
  let source;
  let destination;
  let originalMoved = false;
  let swapped = false;
  try {
    source = createDatabase(`file:${database}`);
    source.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    source.sqlite.close();
    source = null;
    fs.copyFileSync(database, sourceCopy);
    source = createDatabase(`file:${sourceCopy}`);
    const storage = verifySourceStorage(source.sqlite, resourceStorageDir);
    const resourcesBefore = source.sqlite.prepare("SELECT count(*) AS count FROM resources").get()?.count || 0;
    const versionsBefore = source.sqlite.prepare("SELECT count(*) AS count FROM resource_versions").get()?.count || 0;
    const auditBefore = source.sqlite.prepare("SELECT count(*) AS count FROM audit_logs").get()?.count || 0;
    const pointers = {
      resources: pointerRows(source.sqlite, "resources", "current_version_id"),
      versions: pointerRows(source.sqlite, "resource_versions", "active_processing_run_id"),
      pages: pointerRows(source.sqlite, "wiki_pages", "current_version_id"),
      templates: pointerRows(source.sqlite, "wiki_templates", "current_version_id")
    };

    destination = createDatabase(`file:${rebuilt}`);
    migrate(destination.sqlite);
    destination.sqlite.pragma("defer_foreign_keys = ON");
    const copied = destination.sqlite.transaction(() => {
      const counts = {};
      const copy = (table, options) => { counts[table] = copyRows(source.sqlite, destination.sqlite, table, options); };
      copy("knowledge_bases");
      copy("spaces");
      copy("tags");
      copy("resources", { exclude: ["current_version_id"] });
      copy("resource_versions", { exclude: ["active_processing_run_id"] });
      copy("resource_knowledge_bases");
      copy("processing_runs");
      copy("processing_run_attempts");
      copy("chunks");
      copy("resource_fts");
      copy("tasks");
      copy("task_attempts");
      copy("audit_logs");
      copy("agent_runs");
      copy("wiki_templates", { exclude: ["current_version_id"] });
      copy("wiki_template_versions");
      copy("wiki_pages", { exclude: ["current_version_id"] });
      copy("wiki_page_versions");
      copy("wiki_page_blocks");
      copy("wiki_citations");
      copy("wiki_page_citations");
      copy("wiki_page_tags");
      copy("wiki_fts");
      copy("wiki_link_edges");
      copy("retrieval_embeddings");
      copy("retrieval_runs");
      copy("agent_plan_items");
      copy("agent_events");
      copy("chat_sessions");
      copy("chat_messages");
      for (const row of pointers.resources) destination.sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(row.pointer, row.id);
      for (const row of pointers.versions) destination.sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(row.pointer, row.id);
      for (const row of pointers.pages) destination.sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(row.pointer, row.id);
      for (const row of pointers.templates) destination.sqlite.prepare("UPDATE wiki_templates SET current_version_id=? WHERE id=?").run(row.pointer, row.id);
      return counts;
    })();
    copied.retrievalDerived = rebuildRetrievalIndexes(destination.sqlite);
    destination.sqlite.close();
    destination = null;
    source.sqlite.close();
    source = null;
    fs.renameSync(database, backup);
    originalMoved = true;
    try { fs.renameSync(rebuilt, database); }
    catch (caught) {
      fs.renameSync(backup, database);
      originalMoved = false;
      throw caught;
    }
    swapped = true;
    const result = {
      database,
      backup,
      schemaVersion: SCHEMA_VERSION,
      rawStoragePreserved: true,
      storage,
      before: { resources: resourcesBefore, resourceVersions: versionsBefore, auditLogs: auditBefore },
      after: { resources: copied.resources || 0, resourceVersions: copied.resource_versions || 0, auditLogs: copied.audit_logs || 0 },
      copied
    };
    fs.rmSync(sourceCopy, { force: true });
    return result;
  } catch (caught) {
    try { source?.sqlite.close(); } catch {}
    try { destination?.sqlite.close(); } catch {}
    try { fs.rmSync(rebuilt, { force: true }); } catch {}
    try { fs.rmSync(sourceCopy, { force: true }); } catch {}
    if (originalMoved && !swapped && fs.existsSync(backup) && !fs.existsSync(database)) {
      try { fs.renameSync(backup, database); } catch {}
    }
    throw caught;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args[0] !== "--confirm" || !args[1]) throw new Error("usage: node scripts/recreate-db.js --confirm <database-file>");
  const result = rebuildDatabase({ target: args[1], resourceStorageDir: process.env.RESOURCE_STORAGE_DIR || path.resolve("data/resources") });
  console.log(JSON.stringify(result));
}
