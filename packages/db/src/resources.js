import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";

const supported = new Map([[".md", "text/markdown"], [".txt", "text/plain"], [".pdf", "application/pdf"]]);
export const now = () => new Date().toISOString();
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const supportedMime = (name, mimeType) => supported.get(path.extname(name || "").toLowerCase()) === mimeType;
export const safeStoragePath = (root, key) => {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, key);
  const relative = path.relative(rootPath, target);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("invalid storage key");
  return target;
};
export const persistBytes = (root, key, bytes) => {
  const target = safeStoragePath(root, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) { const temp = target + "." + crypto.randomUUID() + ".tmp"; fs.writeFileSync(temp, bytes, { flag: "wx" }); fs.renameSync(temp, target); }
  return target;
};
export const readBytes = (root, key) => fs.readFileSync(safeStoragePath(root, key));
export const decodeBase64 = (value) => {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw Object.assign(new Error("contentBase64 must be valid base64"), { code: "VALIDATION_ERROR" });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw Object.assign(new Error("contentBase64 must be canonical base64"), { code: "VALIDATION_ERROR" });
  return bytes;
};
const privateIpv4 = (host) => {
  const [a, b, c] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113) || a >= 224;
};
const privateIpv6 = (host) => {
  const lower = host.toLowerCase();
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || /^(?:fe[89a-f])/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:") || (lower.startsWith("::ffff:") && privateIpv4(lower.slice(7)));
};
const blockedHost = (host) => {
  const ipVersion = net.isIP(host);
  return ipVersion === 4 ? privateIpv4(host) : ipVersion === 6 ? privateIpv6(host) : host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal";
};
export const validatePublicUrl = (value) => {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error("invalid URL"), { code: "SSRF_BLOCKED" }); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw Object.assign(new Error("URL is not allowed"), { code: "SSRF_BLOCKED" });
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHost(host)) throw Object.assign(new Error("URL host is not public"), { code: "SSRF_BLOCKED" });
  return url.toString();
};
export const validatePublicUrlResolved = async (value) => {
  const canonical = validatePublicUrl(value);
  const host = new URL(canonical).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) return canonical;
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch { throw Object.assign(new Error("URL host could not be resolved"), { code: "SSRF_BLOCKED" }); }
  if (!addresses.length || addresses.some(({ address }) => blockedHost(address))) throw Object.assign(new Error("URL resolves to a private host"), { code: "SSRF_BLOCKED" });
  return canonical;
};
export const ensurePendingResourceTasks = (sqlite, reason = "pending") => sqlite.transaction(() => {
  const versions = sqlite.prepare("SELECT rv.id,rv.resource_id FROM resource_versions rv JOIN resources r ON r.id=rv.resource_id WHERE rv.status='pending' AND r.status <> 'archived'").all();
  let queued = 0;
  for (const version of versions) {
    const activeTask = sqlite.prepare("SELECT id FROM tasks WHERE type='resource:process' AND json_extract(payload,'$.resourceVersionId')=? AND status IN ('queued','running','retrying') LIMIT 1").get(version.id);
    if (activeTask) continue;
    const taskId = crypto.randomUUID();
    const timestamp = now();
    sqlite.prepare("INSERT INTO tasks (id,type,payload,status,progress,retry_limit,retry_count,created_at,updated_at) VALUES (?,?,?,'queued',0,3,0,?,?)").run(taskId, "resource:process", JSON.stringify({ resourceVersionId: version.id, reason }), timestamp, timestamp);
    sqlite.prepare("INSERT INTO audit_logs (id,event_type,entity_type,entity_id,request_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), "queued", "task", taskId, null, JSON.stringify({ resourceVersionId: version.id, reason }), timestamp);
    queued += 1;
  }
  return queued;
})();

export { chunkText } from "./chunker.js";
