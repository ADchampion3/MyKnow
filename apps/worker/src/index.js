import crypto from "node:crypto";
import { loadConfig, redactAuditMetadata } from "@myknow/config";
import { createDatabase, createEmbeddingProvider, ensurePendingEmbeddingTasks, ensurePendingResourceTasks, migrate, now, scanWikiImpacts } from "@myknow/db";
import { createMaterialReader } from "./materials.js";
import { DefaultOcrProviderRegistry } from "./ocr/adapter.js";
import { createResourceProcessor } from "./resources/processor.js";
import { createTaskRunner } from "./tasks/runner.js";
import { createEmbeddingTaskProcessor } from "./retrieval/embeddings.js";
import { createAgentTaskProcessor } from "./agent/processor.js";

const config = loadConfig();
const { sqlite } = createDatabase(config.databaseUrl);
migrate(sqlite);
console.log(`Worker started (poll interval ${config.workerPollIntervalMs}ms, provider ${config.modelProvider})`);
// ponytail: polling is the deliberate MVP ceiling; replace with a durable queue after usage validates the need.
const workerId = `worker-${process.pid}`;
const ocrProviderRegistry = new DefaultOcrProviderRegistry(config);
const materialReader = createMaterialReader({ ...config, ocrProviderRegistry });
const audit = (eventType, entityType, entityId, metadata = {}) => sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), eventType, entityType, entityId, null, JSON.stringify(redactAuditMetadata(metadata)), now());
const embeddingProvider = createEmbeddingProvider(config);
const { processResource } = createResourceProcessor({ config, sqlite, materialReader, audit, embeddingProvider });
const impactScan = async (task) => {
  const resourceVersionId = task.resource_version_id || (() => { try { return JSON.parse(task.payload || "{}").resourceVersionId; } catch { return null; } })();
  if (!resourceVersionId) throw Object.assign(new Error("impact scan resource version is missing"), { code: "VALIDATION_ERROR" });
  scanWikiImpacts({ sqlite, resourceVersionId, resourceStorageDir: config.resourceStorageDir, audit });
};
const embedRetrieval = createEmbeddingTaskProcessor({ config, sqlite, audit, provider: embeddingProvider });
const processAgent = createAgentTaskProcessor({ config, sqlite, audit: (eventType, entityType, entityId, metadata) => audit(eventType, entityType, entityId, metadata) });
const runner = createTaskRunner({ sqlite, workerId, audit, processResource, impactScan, embedRetrieval, processAgent });

runner.recoverInterruptedTasks();
ensurePendingResourceTasks(sqlite, "startup");
if (config.retrievalVectorEnabled !== false) ensurePendingEmbeddingTasks(sqlite, "startup", config);

let running = false;
const poll = async () => {
  if (running) return;
  running = true;
  try { await runner.runOne(); } catch (caught) { console.error(redactAuditMetadata({ code: caught?.code || "INTERNAL_ERROR", error: caught?.message || "worker poll failed" })); }
  finally { running = false; }
};
await poll();
setInterval(poll, config.workerPollIntervalMs);
