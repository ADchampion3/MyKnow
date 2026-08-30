import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDerivedData, createDatabase, migrate } from "@myknow/db";
import { loadConfig } from "@myknow/config";

const parseArgs = (values) => {
  const options = { confirm: false, dryRun: false, retentionDays: null, database: null, resourceStorageDir: null };
  for (const value of values) {
    if (value === "--confirm") options.confirm = true;
    else if (value === "--dry-run") options.dryRun = true;
    else if (value.startsWith("--older-than-days=")) options.retentionDays = Number(value.slice("--older-than-days=".length));
    else if (value.startsWith("--database=")) options.database = value.slice("--database=".length);
    else if (value.startsWith("--resource-storage-dir=")) options.resourceStorageDir = value.slice("--resource-storage-dir=".length);
    else throw new Error("usage: npm run db:cleanup-derived -- [--older-than-days=N] [--dry-run] [--confirm]");
  }
  return options;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const databaseUrl = options.database ? (options.database.startsWith("file:") ? options.database : `file:${path.resolve(options.database)}`) : config.databaseUrl;
  const database = createDatabase(databaseUrl);
  try {
    migrate(database.sqlite);
    const result = cleanupDerivedData({
      sqlite: database.sqlite,
      resourceStorageDir: options.resourceStorageDir ? path.resolve(options.resourceStorageDir) : config.resourceStorageDir,
      retentionDays: options.retentionDays ?? config.derivedDataRetentionDays,
      dryRun: options.dryRun || !options.confirm
    });
    console.log(JSON.stringify({ ...result, mode: result.dryRun ? "dry-run" : "confirmed" }, null, 2));
    if (result.storage.errors.length) process.exitCode = 1;
  } finally {
    database.sqlite.close();
  }
}
