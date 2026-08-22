import { loadConfig } from "@myknow/config";
import { createDatabase, ensurePendingResourceTasks, migrate } from "@myknow/db";
import { createRequestHandler } from "./app.js";

const config = loadConfig();
const { sqlite, db } = createDatabase(config.databaseUrl);
migrate(sqlite);
ensurePendingResourceTasks(sqlite, "api-startup");

export const requestHandler = createRequestHandler({ config, sqlite, db });
