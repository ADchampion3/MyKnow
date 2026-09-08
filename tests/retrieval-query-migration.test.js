import { describe, expect, it } from "vitest";
import { createDatabase, migrate, SCHEMA_VERSION } from "@myknow/db";

describe("retrieval query boundary migration", () => {
  it("creates the 256 code point query constraint on an empty database", () => {
    const database = createDatabase(":memory:");
    try {
      expect(migrate(database.sqlite)).toMatchObject({ fresh: true, schemaVersion: SCHEMA_VERSION });
      const sql = database.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='retrieval_runs'").get().sql;
      expect(sql).toContain("BETWEEN 1 AND 256");
    } finally { database.sqlite.close(); }
  });

  it("upgrades the prior schema without dropping retrieval rows", () => {
    const database = createDatabase(":memory:");
    try {
      migrate(database.sqlite);
      const currentSql = database.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='retrieval_runs'").get().sql;
      database.sqlite.exec("DROP INDEX retrieval_runs_scope_idx; ALTER TABLE retrieval_runs RENAME TO retrieval_runs_previous;");
      database.sqlite.exec(currentSql.replace("BETWEEN 1 AND 256", "BETWEEN 1 AND 200"));
      database.sqlite.exec("CREATE INDEX retrieval_runs_scope_idx ON retrieval_runs(knowledge_base_id, created_at, id); DROP TABLE retrieval_runs_previous;");
      const now = new Date().toISOString();
      const kb = "00000000-0000-4000-8000-000000000099";
      database.sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?, 'active',?,?)").run(kb, "Migration fixture", now, now);
      database.sqlite.prepare("INSERT INTO retrieval_runs (id,query,knowledge_base_id,wiki_top_k,raw_top_k,context_budget_tokens,wiki_budget_tokens,raw_budget_tokens,vector_enabled,status,wiki_seeds,raw_seeds,graph_expansion,provenance_lookups,context_items,context_markdown,metrics,vector_status,trace_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("run-preserved", "😀".repeat(100), kb, 1, 10, 100, 60, 40, 0, "succeeded", "[]", "[]", "[]", "[]", "[]", "", "{}", "{}", "{}", now, now);
      database.sqlite.prepare("UPDATE schema_meta SET value=? WHERE key='schema_version'").run("sprint6-personal-acceptance-v1");
      expect(migrate(database.sqlite)).toMatchObject({ fresh: false, migratedFrom: "sprint6-personal-acceptance-v1", schemaVersion: SCHEMA_VERSION });
      expect(database.sqlite.prepare("SELECT query FROM retrieval_runs WHERE id=?").get("run-preserved").query).toBe("😀".repeat(100));
      database.sqlite.prepare("INSERT INTO retrieval_runs (id,query,knowledge_base_id,wiki_top_k,raw_top_k,context_budget_tokens,wiki_budget_tokens,raw_budget_tokens,vector_enabled,status,wiki_seeds,raw_seeds,graph_expansion,provenance_lookups,context_items,context_markdown,metrics,vector_status,trace_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("run-expanded", "😀".repeat(256), kb, 1, 10, 100, 60, 40, 0, "succeeded", "[]", "[]", "[]", "[]", "[]", "", "{}", "{}", "{}", now, now);
      expect(database.sqlite.prepare("SELECT length(query) AS length FROM retrieval_runs WHERE id=?").get("run-expanded").length).toBe(256);
      expect(database.sqlite.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value).toBe(SCHEMA_VERSION);
    } finally { database.sqlite.close(); }
  });
});
