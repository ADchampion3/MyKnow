import crypto from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { redactSecrets } from "@myknow/config";

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
  ["RESOURCE_READ_ONLY", 409],
  ["WIKI_VERSION_CONFLICT", 409],
  ["WIKI_PAGE_CYCLE", 409],
  ["WIKI_PAGE_METADATA_ONLY", 409],
  ["WIKI_CITATION_INVALID", 400],
  ["TASK_CANCELLED", 409],
  ["PROCESSING_RUN_SUPERSEDED", 409],
  ["OCR_MODE_INVALID", 400],
  ["OCR_PROVIDER_INVALID", 400],
  ["OCR_PROVIDER_REQUIRED", 400],
  ["OCR_CAPABILITIES_INVALID", 400],
  ["OCR_REQUEST_INVALID", 400],
  ["OCR_UNSUPPORTED_MEDIA", 415],
  ["OCR_RESULT_INVALID", 422],
  ["OCR_RESULT_EMPTY", 422],
  ["OCR_PAGE_NUMBER_INVALID", 422],
  ["OCR_PAGE_ERROR", 422],
  ["OCR_PAGE_INCOMPLETE", 422],
  ["OCR_CAPABILITY_UNAVAILABLE", 422],
  ["OCR_LIMIT_EXCEEDED", 422],
  ["OCR_PROVIDER_UNAVAILABLE", 422],
  ["OCR_FAILED", 422],
  ["OCR_EGRESS_BLOCKED", 403],
  ["OCR_CACHE_INVALID", 422],
  ["OCR_CACHE_WRITE_FAILED", 500],
  ["PROCESSING_TIMEOUT", 422],
  ["RETRIEVAL_INDEX_UNAVAILABLE", 503],
  ["AGENT_SCOPE_INVALID", 400],
  ["AGENT_OUTPUT_INVALID", 422],
  ["AGENT_PLAN_INVALID", 422],
  ["AGENT_PLAN_BLOCKED", 409],
  ["AGENT_REVIEW_CONFLICT", 409],
  ["AGENT_APPLY_FAILED", 422],
  ["AGENT_ROLLBACK_CONFLICT", 409],
  ["MODEL_EGRESS_BLOCKED", 403],
  ["PROVIDER_AUTH_MISSING", 503],
  ["PROVIDER_FAILED", 422],
  ["TRANSIENT_ERROR", 503],
  ["EMBEDDING_CONFIG_INVALID", 500],
  ["EMBEDDING_DISABLED", 422],
  ["EMBEDDING_PROVIDER_UNAVAILABLE", 422],
  ["EMBEDDING_TIMEOUT", 422],
  ["EMBEDDING_FAILED", 422],
  ["EMBEDDING_EGRESS_BLOCKED", 403],
  ["EMBEDDING_RESPONSE_INVALID", 422],
  ["EMBEDDING_DIMENSION_MISMATCH", 422],
  ["SOURCE_INTEGRITY_FAILED", 500],
  ["DATABASE_RECREATE_REQUIRED", 500],
  ["INTERNAL_ERROR", 500]
]);

const allowedOrigin = (origin, webPort) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin || "") ? origin : `http://localhost:${webPort}`;
const validationError = (message) => Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
const jsonBodySchema = z.object({}).passthrough();
const uploadFileSchema = z.object({
  filename: z.string().max(255),
  mimeType: z.string().max(255),
  bytes: z.instanceof(Buffer)
});
const uploadBodySchema = z.object({
  name: z.string().max(120).optional(),
  knowledgeBaseId: z.string().max(200).optional(),
  file: uploadFileSchema.optional(),
  content: z.string().optional(),
  mimeType: z.string().max(255).optional(),
  ocrMode: z.union([z.string(), z.null()]).optional(),
  ocrProvider: z.union([z.string(), z.null()]).optional(),
  ocrCapabilities: z.unknown().optional(),
  refreshOcr: z.union([z.string(), z.boolean(), z.null()]).optional(),
  chunkingConfig: z.unknown().optional(),
  wikiMode: z.unknown().optional()
}).passthrough();

const bodySchemaFor = ({ pathname, method }) => method === "POST" && (pathname === "/api/resources" || /^\/api\/resources\/[^/]+\/versions$/u.test(pathname))
  ? uploadBodySchema
  : jsonBodySchema;

const formatIssues = (issues) => issues.map((issue) => {
  const path = issue.path.length ? issue.path.join(".") : "body";
  return `${path}: ${issue.message}`;
}).join("; ");

const parseSchema = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(formatIssues(result.error.issues));
  return result.data;
};

const isBlob = (value) => typeof Blob !== "undefined" && value instanceof Blob;

const formDataObject = async (formData) => {
  const body = {};
  for (const [key, value] of formData.entries()) {
    body[key] = isBlob(value)
      ? {
          filename: typeof value.name === "string" && value.name ? value.name : "blob",
          mimeType: value.type || "application/octet-stream",
          bytes: Buffer.from(await value.arrayBuffer())
        }
      : value;
  }
  return body;
};

const contentLength = (request) => {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const readBody = async (request, schema = jsonBodySchema) => {
  if (!(request instanceof Request)) throw validationError("a Fetch Request is required");
  if (!request.body || contentLength(request) === 0) return parseSchema(schema, {});

  const mediaType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  let value;
  if (mediaType === "application/json") {
    try { value = await request.json(); }
    catch (caught) {
      if (caught?.code) throw caught;
      throw validationError("invalid JSON body");
    }
  } else if (mediaType === "multipart/form-data") {
    try { value = await formDataObject(await request.formData()); }
    catch (caught) {
      if (caught?.code) throw caught;
      throw validationError("invalid multipart form data");
    }
  } else {
    throw validationError("content-type must be application/json or multipart/form-data");
  }
  return parseSchema(schema, value);
};

const bodyLimitFor = (config) => {
  const resourceLimit = Number(config.resourceMaxBytes ?? 2_000_000);
  // ponytail: keep multipart uploads in-process while the configured ceiling is small; upgrade to object-storage keys before allowing hundreds of MB.
  return Number.isFinite(resourceLimit) ? resourceLimit + 512 * 1024 : Number.POSITIVE_INFINITY;
};

const limitedRequest = (request, maxBytes) => {
  if (!request.body || !Number.isFinite(maxBytes)) return request;
  const knownLength = contentLength(request);
  if (Number.isFinite(knownLength) && knownLength > maxBytes) {
    const body = new ReadableStream({ start(controller) { controller.error(validationError("request body is too large")); } });
    return new Request(request, { body, duplex: "half" });
  }

  let size = 0;
  const body = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const chunkSize = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      size += chunkSize;
      if (size > maxBytes) {
        controller.error(validationError("request body is too large"));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
  return new Request(request, { body, duplex: "half" });
};

const headersFromNode = (nodeRequest) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers || {})) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
};

const createReply = (origin = null) => ({
  origin,
  response: null,
  payload: null,
  respond(response, payload = null) {
    this.response = response;
    this.payload = payload;
  }
});

export const createHttpTools = ({ config }) => {
  const responseHeaders = (reply, requestId, extra = {}) => ({
    "access-control-allow-origin": allowedOrigin(reply?.origin, config.webPort),
    "access-control-allow-headers": "content-type, idempotency-key",
    "x-request-id": requestId,
    ...extra
  });

  const publish = (reply, response, payload) => {
    if (typeof reply?.respond !== "function") throw new TypeError("HTTP response sink is required");
    reply.respond(response, payload);
    return response;
  };

  const ok = (reply, status, data, requestId = crypto.randomUUID()) => {
    if (status === 204) return empty(reply, status, requestId);
    const payload = { data, error: null, requestId };
    return publish(reply, Response.json(payload, { status, headers: responseHeaders(reply, requestId) }), payload);
  };

  const fail = (reply, status, problem, requestId = crypto.randomUUID()) => {
    const payload = { data: null, error: redactSecrets(problem), requestId };
    return publish(reply, Response.json(payload, { status, headers: responseHeaders(reply, requestId) }), payload);
  };

  const empty = (reply, status, requestId = crypto.randomUUID(), extraHeaders = {}) => publish(
    reply,
    new Response(null, { status, headers: responseHeaders(reply, requestId, extraHeaders) }),
    null
  );

  const binary = (reply, status, bytes, requestId = crypto.randomUUID(), extraHeaders = {}) => publish(
    reply,
    new Response(bytes, { status, headers: responseHeaders(reply, requestId, extraHeaders) }),
    null
  );

  const error = (code, message) => ({ code, message });
  const respondCaught = (reply, caught, requestId) => {
    const caughtCode = typeof caught?.code === "string" ? caught.code : "";
    const code = caughtCode.startsWith("SQLITE_CONSTRAINT_UNIQUE") ? "DUPLICATE_NAME" : errorStatus.has(caughtCode) ? caughtCode : "INTERNAL_ERROR";
    const providerFailure = /^(?:MODEL_|EMBEDDING_|OCR_PROVIDER_|OCR_CACHE_|PROVIDER_|TRANSIENT_)/u.test(code);
    const message = code === "INTERNAL_ERROR" ? "Internal server error" : providerFailure ? `${code}: provider details redacted` : redactSecrets(caught?.message || code);
    return fail(reply, errorStatus.get(code), error(code, message), requestId);
  };

  const requestFromNode = (nodeRequest) => {
    const method = String(nodeRequest.method || "GET").toUpperCase();
    const headers = headersFromNode(nodeRequest);
    const hasBody = !["GET", "HEAD"].includes(method);
    const init = { method, headers };
    if (hasBody) {
      init.body = Readable.toWeb(nodeRequest);
      init.duplex = "half";
    }
    return new Request(new URL(nodeRequest.url || "/", "http://localhost"), init);
  };

  const readBodyWithLimit = (request, schema = jsonBodySchema) => readBody(limitedRequest(request, bodyLimitFor(config)), schema);

  const sendToNodeResponse = async (nodeResponse, response) => {
    if (!response || typeof nodeResponse?.status !== "function" || typeof nodeResponse?.set !== "function" || typeof nodeResponse?.send !== "function") {
      throw new Error("HTTP adapter requires an Express-compatible response");
    }
    const target = nodeResponse.status(response.status);
    target.set(Object.fromEntries(response.headers.entries()));
    return response.status === 204 ? target.send() : target.send(Buffer.from(await response.arrayBuffer()));
  };

  return {
    allowedOrigin: (origin) => allowedOrigin(origin, config.webPort),
    bodySchemaFor,
    createReply,
    error,
    empty,
    binary,
    ok,
    fail,
    readBody: readBodyWithLimit,
    requestFromNode,
    respondCaught,
    sendToNodeResponse
  };
};
