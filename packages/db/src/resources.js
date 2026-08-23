import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const supported = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".pdf", "application/pdf"]
]);

export const now = () => new Date().toISOString();
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const mimeForExtension = (name) => supported.get(path.extname(name || "").toLowerCase()) || null;
export const supportedMime = (name, mimeType) => mimeForExtension(name) === mimeType;

export const safeStoragePath = (root, key) => {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, key);
  const relative = path.relative(rootPath, target);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("invalid storage key");
  return target;
};

export const contentStorageKey = (digest) => path.posix.join("blobs", digest.slice(0, 2), digest);

export const persistBytes = (root, key, bytes) => {
  const target = safeStoragePath(root, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.length !== bytes.length || sha256(existing) !== sha256(bytes)) throw Object.assign(new Error("existing blob failed integrity check"), { code: "SOURCE_INTEGRITY_FAILED" });
    return target;
  }
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx" });
    fs.renameSync(temp, target);
  } catch (caught) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (existing.length === bytes.length && sha256(existing) === sha256(bytes)) return target;
    }
    throw caught;
  }
  return target;
};

export const readBytes = (root, key) => fs.readFileSync(safeStoragePath(root, key));

export const storageFiles = (root) => {
  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) files.push(path.relative(rootPath, full).split(path.sep).join("/"));
    }
  };
  visit(rootPath);
  return files.sort();
};

export const orphanStorageFiles = (root, referencedKeys) => {
  const referenced = new Set(referencedKeys);
  return storageFiles(root).filter((key) => !referenced.has(key));
};

export const refreshResourceStatus = (sqlite, resourceId, timestamp = now()) => {
  const resource = sqlite.prepare("SELECT * FROM resources WHERE id=?").get(resourceId);
  if (!resource || resource.status === "archived") return resource?.status || null;
  const current = resource.current_version_id ? sqlite.prepare("SELECT * FROM resource_versions WHERE id=?").get(resource.current_version_id) : null;
  const latest = sqlite.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(resourceId);
  let status = "pending";
  if (current) {
    status = latest && latest.id !== current.id && latest.status === "failed" ? "degraded" : "indexed";
  } else if (latest?.status === "processing") {
    status = "processing";
  } else if (latest?.status === "failed") {
    status = "failed";
  }
  sqlite.prepare("UPDATE resources SET status=?,updated_at=? WHERE id=? AND status <> 'archived'").run(status, timestamp, resourceId);
  return status;
};

export const ensurePendingResourceTasks = (sqlite, reason = "pending") => sqlite.transaction(() => {
  const versions = sqlite.prepare("SELECT rv.id,rv.resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.status='pending' AND r.status <> 'archived'").all();
  let queued = 0;
  for (const version of versions) {
    const activeTask = sqlite.prepare("SELECT id FROM tasks WHERE type='resource:process' AND resource_version_id=? AND status IN ('queued','running','retrying') LIMIT 1").get(version.id);
    if (activeTask) continue;
    const taskId = crypto.randomUUID();
    const timestamp = now();
    sqlite.prepare("INSERT INTO tasks (id,type,resource_version_id,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,?,'queued',0,3,0,?,?)").run(taskId, "resource:process", version.id, JSON.stringify({ reason }), timestamp, timestamp);
    sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), "queued", "task", taskId, null, JSON.stringify({ resourceVersionId: version.id, reason }), timestamp);
    queued += 1;
  }
  return queued;
})();

export { chunkText } from "./chunker.js";
