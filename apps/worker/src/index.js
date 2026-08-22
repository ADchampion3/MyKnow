import crypto from "node:crypto";
import { loadConfig } from "@myknow/config";
import { createDatabase, ensurePendingResourceTasks, migrate, now } from "@myknow/db";
import { createMaterialReader } from "./materials.js";
import { createResourceProcessor } from "./resources/processor.js";
import { createTaskRunner } from "./tasks/runner.js";

const config = loadConfig();
const { sqlite } = createDatabase(config.databaseUrl);
migrate(sqlite);
console.log(`Worker started (poll interval ${config.workerPollIntervalMs}ms, provider ${config.modelProvider})`);
// ponytail: polling is the deliberate Sprint 1 ceiling; replace with a durable queue after MVP validation.
const workerId = `worker-${process.pid}`;
const materialReader = createMaterialReader(config);
const audit = (eventType, entityType, entityId, metadata = {}) => sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), eventType, entityType, entityId, null, JSON.stringify(metadata), now());
const { processResource } = createResourceProcessor({ config, sqlite, materialReader, audit });
const runner = createTaskRunner({ sqlite, workerId, audit, processResource });

runner.recoverInterruptedTasks();
ensurePendingResourceTasks(sqlite, "startup");

await runner.runOne();
setInterval(() => { runner.runOne().catch((caught) => console.error(caught)); }, config.workerPollIntervalMs);
