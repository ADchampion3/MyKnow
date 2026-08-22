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
  ["INTERNAL_ERROR", 500]
]);

const allowedOrigin = (origin, webPort) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin || "") ? origin : `http://localhost:${webPort}`;

export const createHttpTools = ({ config }) => {
  const json = (res, status, data, error = null, requestId = crypto.randomUUID()) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": allowedOrigin(res.req?.headers?.origin, config.webPort),
      "access-control-allow-headers": "content-type"
    });
    res.end(JSON.stringify({ data, error, requestId }));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.byteLength;
      body += chunk;
      if (size > config.resourceMaxBytes * 2) reject(Object.assign(new Error("body too large"), { code: "VALIDATION_ERROR" }));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error("invalid JSON"), { code: "VALIDATION_ERROR" })); }
    });
    req.on("error", reject);
  });

  const error = (code, message) => ({ code, message });
  const respondCaught = (res, caught, requestId) => {
    const caughtCode = typeof caught?.code === "string" ? caught.code : "";
    const code = caughtCode.startsWith("SQLITE_CONSTRAINT_UNIQUE") ? "DUPLICATE_NAME" : errorStatus.has(caughtCode) ? caughtCode : "INTERNAL_ERROR";
    const message = code === "INTERNAL_ERROR" ? "Internal server error" : caught?.message || code;
    return json(res, errorStatus.get(code), null, error(code, message), requestId);
  };

  return { allowedOrigin: (origin) => allowedOrigin(origin, config.webPort), json, readBody, error, respondCaught };
};
