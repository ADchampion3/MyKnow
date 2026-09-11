import crypto from "node:crypto";
import { createApiContext } from "./context.js";
import { createHttpTools } from "./http.js";
import { handleKnowledgeBaseRoutes } from "./routes/knowledge-bases.js";
import { handleResourceRoutes } from "./routes/resources.js";
import { handleRetrievalRoutes } from "./routes/retrieval.js";
import { handleTaskRoutes } from "./routes/tasks.js";
import { handleWikiRoutes } from "./routes/wiki.js";
import { handleAgentRoutes } from "./routes/agent.js";

const routeHandlers = [handleAgentRoutes, handleWikiRoutes, handleKnowledgeBaseRoutes, handleResourceRoutes, handleRetrievalRoutes, handleTaskRoutes];

export const createApiRouteHandler = ({ config, sqlite, db, http = createHttpTools({ config }) }) => {
  const ctx = createApiContext({ config, sqlite, db, http });

  return async (webRequest) => {
    const requestId = crypto.randomUUID();
    const reply = ctx.createReply(webRequest?.headers?.get?.("origin") || null);
    try {
      if (!(webRequest instanceof Request)) throw ctx.error("VALIDATION_ERROR", "a Fetch Request is required");
      if (webRequest.method === "OPTIONS") {
        return ctx.empty(reply, 204, requestId, {
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"
        });
      }
      const parsed = new URL(webRequest.url);
      if (parsed.pathname === "/health" && webRequest.method === "GET") return ctx.ok(reply, 200, { status: "ok", service: "api" }, requestId);
      if (parsed.pathname === "/ready" && webRequest.method === "GET") return ctx.ok(reply, 200, { status: "ready", service: "api" }, requestId);

      const method = webRequest.method;
      const request = {
        request: webRequest,
        res: reply,
        parsed,
        pathname: parsed.pathname,
        method,
        body: ["POST", "PATCH"].includes(method) ? await ctx.readBody(webRequest, ctx.bodySchemaFor({ pathname: parsed.pathname, method })) : {},
        requestId,
        idempotencyKey: webRequest.headers.get("idempotency-key")?.trim() || null
      };
      if (request.pathname === "/api/runtime" && request.method === "GET") return ctx.ok(reply, 200, ctx.runtimeView(), requestId);
      for (const handler of routeHandlers) {
        const result = await handler({ ctx, request });
        if (result instanceof Response) return result;
        if (result) {
          if (reply.response) return reply.response;
          throw new Error("route handler did not publish a response");
        }
      }
      return ctx.fail(reply, 404, ctx.error("NOT_FOUND", "Route not found"), requestId);
    } catch (caught) {
      return ctx.respondCaught(reply, caught, requestId);
    }
  };
};

export const createRequestHandler = ({ config, sqlite, db }) => {
  const http = createHttpTools({ config });
  const handleRequest = createApiRouteHandler({ config, sqlite, db, http });

  return async (nodeRequest, nodeResponse) => {
    let response;
    try {
      response = await handleRequest(http.requestFromNode(nodeRequest));
    } catch (caught) {
      const reply = http.createReply(nodeRequest.headers?.origin);
      response = http.respondCaught(reply, caught, crypto.randomUUID());
    }
    return http.sendToNodeResponse(nodeResponse, response);
  };
};
