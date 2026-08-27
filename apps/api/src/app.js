import crypto from "node:crypto";
import { createApiContext } from "./context.js";
import { createHttpTools } from "./http.js";
import { handleKnowledgeBaseRoutes } from "./routes/knowledge-bases.js";
import { handleResourceRoutes } from "./routes/resources.js";
import { handleRetrievalRoutes } from "./routes/retrieval.js";
import { handleSearchRoutes } from "./routes/search.js";
import { handleTaskRoutes } from "./routes/tasks.js";
import { handleWikiRoutes } from "./routes/wiki.js";

const routeHandlers = [handleWikiRoutes, handleKnowledgeBaseRoutes, handleResourceRoutes, handleRetrievalRoutes, handleSearchRoutes, handleTaskRoutes];

export const createRequestHandler = ({ config, sqlite, db }) => {
  const ctx = createApiContext({ config, sqlite, db, http: createHttpTools({ config }) });

  return async (req, res) => {
    const requestId = crypto.randomUUID();
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": ctx.allowedOrigin(req.headers.origin),
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type, idempotency-key"
      });
      return res.end();
    }
    if (req.url === "/health" && req.method === "GET") return ctx.json(res, 200, { status: "ok", service: "api" });
    if (req.url === "/ready" && req.method === "GET") return ctx.json(res, 200, { status: "ready", service: "api" });

    try {
      const parsed = new URL(req.url, "http://localhost");
      const request = {
        req,
        res,
        parsed,
        pathname: parsed.pathname,
        method: req.method,
        body: ["POST", "PATCH"].includes(req.method) ? await ctx.readBody(req) : {},
        requestId,
        idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : null
      };
      for (const handler of routeHandlers) if (await handler({ ctx, request })) return;
      return ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Route not found"), requestId);
    } catch (caught) {
      return ctx.respondCaught(res, caught, requestId);
    }
  };
};
