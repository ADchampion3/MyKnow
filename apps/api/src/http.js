import crypto from "node:crypto";

const errorStatus = new Map([
  ["VALIDATION_ERROR", 400],
  ["NOT_FOUND", 404],
  ["SSRF_BLOCKED", 403],
  ["UNSUPPORTED_MEDIA_TYPE", 415],
  ["PARSE_FAILED", 422],
  ["INDEX_FAILED", 422],
  ["DUPLICATE_NAME", 409],
  ["RESOURCE_DUPLICATE", 409],
  ["INVALID_STATE_TRANSITION", 409],
  ["TASK_RETRY_LIMIT", 409],
  ["IDEMPOTENCY_KEY_REUSED", 409],
  ["RESOURCE_ARCHIVED", 409],
  ["SOURCE_INTEGRITY_FAILED", 500],
  ["DATABASE_RECREATE_REQUIRED", 500],
  ["INTERNAL_ERROR", 500]
]);

const allowedOrigin = (origin, webPort) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin || "") ? origin : `http://localhost:${webPort}`;

export const createHttpTools = ({ config }) => {
  const json = (res, status, data, error = null, requestId = crypto.randomUUID()) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": allowedOrigin(res.req?.headers?.origin, config.webPort),
      "access-control-allow-headers": "content-type, idempotency-key"
    });
    res.end(JSON.stringify({ data, error, requestId }));
  };

  const readRawBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const maxBytes = config.resourceMaxBytes + 512 * 1024;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxBytes) { fail(Object.assign(new Error("body too large"), { code: "VALIDATION_ERROR" })); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", fail);
  });

  const parseMultipart = (raw, contentType) => {
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
    if (!boundaryMatch) throw Object.assign(new Error("multipart boundary is required"), { code: "VALIDATION_ERROR" });
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const delimiter = Buffer.from(`--${boundary}`);
    const delimiterLine = Buffer.from(`\r\n--${boundary}`);
    const headerSeparator = Buffer.from("\r\n\r\n");
    const invalid = () => { throw Object.assign(new Error("invalid multipart body"), { code: "VALIDATION_ERROR" }); };
    const fields = {};
    let file = null;
    let cursor = raw.indexOf(delimiter);
    if (cursor < 0 || (cursor > 0 && raw.subarray(0, cursor).toString("latin1") !== "\r\n")) invalid();
    while (cursor >= 0) {
      if (!raw.subarray(cursor, cursor + delimiter.length).equals(delimiter)) invalid();
      cursor += delimiter.length;
      const suffix = raw.subarray(cursor, cursor + 2).toString("latin1");
      if (suffix === "--") break;
      if (suffix !== "\r\n") invalid();
      cursor += 2;
      const headerEnd = raw.indexOf(headerSeparator, cursor);
      if (headerEnd < 0) invalid();
      const headerText = raw.subarray(cursor, headerEnd).toString("latin1");
      const bodyStart = headerEnd + headerSeparator.length;
      let next = raw.indexOf(delimiterLine, bodyStart);
      while (next >= 0) {
        const afterDelimiter = next + delimiterLine.length;
        const delimiterSuffix = raw.subarray(afterDelimiter, afterDelimiter + 2).toString("latin1");
        if (delimiterSuffix === "\r\n" || delimiterSuffix === "--") break;
        next = raw.indexOf(delimiterLine, next + 1);
      }
      if (next < 0) invalid();
      const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
      if (!disposition) invalid();
      const fieldName = disposition[1];
      const filename = disposition[2];
      const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || "application/octet-stream";
      const value = raw.subarray(bodyStart, next);
      if (filename !== undefined) {
        if (file) invalid();
        file = { filename, mimeType: type, bytes: Buffer.from(value) };
      } else fields[fieldName] = value.toString("utf8");
      cursor = next + 2;
    }
    return { ...fields, file };
  };

  const readBody = async (req) => {
    const raw = await readRawBody(req);
    if (!raw.length) return {};
    const contentType = req.headers["content-type"] || "";
    if (/^multipart\/form-data/i.test(contentType)) return parseMultipart(raw, contentType);
    if (!/^application\/json/i.test(contentType)) throw Object.assign(new Error("content-type must be application/json or multipart/form-data"), { code: "VALIDATION_ERROR" });
    try { return JSON.parse(raw.toString("utf8")); }
    catch { throw Object.assign(new Error("invalid JSON"), { code: "VALIDATION_ERROR" }); }
  };

  const error = (code, message) => ({ code, message });
  const respondCaught = (res, caught, requestId) => {
    const caughtCode = typeof caught?.code === "string" ? caught.code : "";
    const code = caughtCode.startsWith("SQLITE_CONSTRAINT_UNIQUE") ? "DUPLICATE_NAME" : errorStatus.has(caughtCode) ? caughtCode : "INTERNAL_ERROR";
    const message = code === "INTERNAL_ERROR" ? "Internal server error" : caught?.message || code;
    return json(res, errorStatus.get(code), null, error(code, message), requestId);
  };

  return { allowedOrigin: (origin) => allowedOrigin(origin, config.webPort), json, readBody, error, respondCaught };
};
