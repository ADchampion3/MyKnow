import { executeRetrieval, getRetrievalRun, isUuid } from "@myknow/db";

export const handleRetrievalRoutes = async ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  if (pathname === "/api/retrieval/query" && method === "POST") {
    ctx.assertEmbeddingEgress();
    try {
      const trace = await executeRetrieval({
        sqlite: ctx.sqlite,
        config: ctx.config,
        input: body,
        onAudit: (eventType, result) => ctx.audit(eventType, "retrieval_run", result.traceId, requestId, { status: result.status, wikiCount: result.wiki?.seeds?.length || 0, rawCount: result.raw?.results?.length || 0, graphCount: result.wiki?.graphExpanded?.length || 0, truncated: Boolean(result.context?.truncated), vectorStatus: result.vector?.status || "unknown" })
      });
      ctx.ok(res, 200, trace, requestId);
    } catch (caught) {
      ctx.respondCaught(res, caught, requestId);
    }
    return true;
  }

  const runMatch = pathname.match(/^\/api\/retrieval\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    if (!isUuid(runMatch[1])) { ctx.fail(res, 400, ctx.error("VALIDATION_ERROR", "retrieval run id must be a UUID"), requestId); return true; }
    const trace = getRetrievalRun(ctx.sqlite, runMatch[1]);
    if (!trace) { ctx.fail(res, 404, ctx.error("NOT_FOUND", "Retrieval trace not found"), requestId); return true; }
    ctx.ok(res, 200, trace, requestId);
    return true;
  }
  return false;
};
