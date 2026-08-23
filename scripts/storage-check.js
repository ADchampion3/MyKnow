import { loadConfig } from "@myknow/config";
import { createDatabase, migrate, orphanStorageFiles } from "@myknow/db";

const config = loadConfig();
const { sqlite } = createDatabase(config.databaseUrl);
try {
  migrate(sqlite);
  const keys = [
    ...sqlite.prepare("SELECT storage_key AS key FROM resource_versions").all().map((row) => row.key),
    ...sqlite.prepare("SELECT canonical_storage_key AS key FROM processing_runs WHERE canonical_storage_key IS NOT NULL").all().map((row) => row.key)
  ];
  console.log(JSON.stringify({ storageRoot: config.resourceStorageDir, referenced: keys.length, orphanFiles: orphanStorageFiles(config.resourceStorageDir, keys) }, null, 2));
} finally {
  sqlite.close();
}
