import { externalWikiMode, knowledgeBases, normalizeChunkingConfig, normalizeWikiMode, spaces, tags } from "@myknow/db";
import { desc, eq } from "drizzle-orm";

export const handleKnowledgeBaseRoutes = ({ ctx, request }) => {
  const { pathname, method, body, requestId, res } = request;
  const { db, sqlite } = ctx;
  const kbView = (row) => row ? { ...row, wikiDefaultMode: externalWikiMode(row.wikiDefaultMode || row.wiki_default_mode || "enabled") } : row;

  if (pathname === "/api/knowledge-bases" && method === "GET") {
    ctx.json(res, 200, db.select().from(knowledgeBases).orderBy(desc(knowledgeBases.updatedAt)).all().map(kbView), null, requestId);
    return true;
  }
  if (pathname === "/api/knowledge-bases" && method === "POST") {
    let chunkingConfig;
    let wikiDefaultMode;
    try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body?.chunkingConfig ?? {})); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    try { wikiDefaultMode = normalizeWikiMode(body?.wikiDefaultMode ?? body?.wikiMode); }
    catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    const result = ctx.collection(body, { description: body?.description || null, chunkingConfig, wikiDefaultMode, status: "active" });
    if (result.error) { ctx.json(res, 400, null, result.error, requestId); return true; }
    db.insert(knowledgeBases).values(result.value).run();
    ctx.audit("created", "knowledge_base", result.value.id, requestId, { chunkingConfig: JSON.parse(chunkingConfig) });
    ctx.json(res, 201, kbView(result.value), null, requestId);
    return true;
  }

  const knowledgeBaseMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)$/);
  if (knowledgeBaseMatch && method === "PATCH") {
    const found = sqlite.prepare("SELECT * FROM knowledge_bases WHERE id=? AND status='active'").get(knowledgeBaseMatch[1]);
    if (!found) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const nextName = body?.name === undefined ? found.name : ctx.inputName(body);
    if (!nextName) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "name must be 1-120 characters"), requestId); return true; }
    let chunkingConfig = found.chunking_config;
    let wikiDefaultMode = found.wiki_default_mode;
    if (body?.chunkingConfig !== undefined) {
      try { chunkingConfig = JSON.stringify(normalizeChunkingConfig(body.chunkingConfig)); }
      catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    if (body?.wikiDefaultMode !== undefined || body?.wikiMode !== undefined) {
      try { wikiDefaultMode = normalizeWikiMode(body.wikiDefaultMode ?? body.wikiMode); }
      catch (caught) { ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", caught.message), requestId); return true; }
    }
    sqlite.prepare("UPDATE knowledge_bases SET name=?,description=?,chunking_config=?,wiki_default_mode=?,updated_at=? WHERE id=?").run(nextName, body?.description === undefined ? found.description : body.description, chunkingConfig, wikiDefaultMode, ctx.now(), found.id);
    ctx.audit("updated", "knowledge_base", found.id, requestId, { chunkingConfigChanged: body?.chunkingConfig !== undefined, wikiDefaultModeChanged: body?.wikiDefaultMode !== undefined || body?.wikiMode !== undefined });
    ctx.json(res, 200, kbView(db.select().from(knowledgeBases).where(eq(knowledgeBases.id, found.id)).get()), null, requestId);
    return true;
  }

  const spaceMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/spaces$/);
  if (spaceMatch && method === "GET") {
    ctx.json(res, 200, db.select().from(spaces).where(eq(spaces.knowledgeBaseId, spaceMatch[1])).all(), null, requestId);
    return true;
  }
  if (spaceMatch && method === "POST") {
    if (!ctx.validKb(spaceMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const result = ctx.collection(body, { knowledgeBaseId: spaceMatch[1], status: "active" });
    if (result.error) { ctx.json(res, 400, null, result.error, requestId); return true; }
    db.insert(spaces).values(result.value).run();
    ctx.json(res, 201, result.value, null, requestId);
    return true;
  }

  const tagMatch = pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/tags$/);
  if (tagMatch && method === "GET") {
    ctx.json(res, 200, db.select().from(tags).where(eq(tags.knowledgeBaseId, tagMatch[1])).all(), null, requestId);
    return true;
  }
  if (tagMatch && method === "POST") {
    if (!ctx.validKb(tagMatch[1])) { ctx.json(res, 404, null, ctx.error("NOT_FOUND", "Knowledge base not found"), requestId); return true; }
    const result = ctx.collection(body, { knowledgeBaseId: tagMatch[1] });
    if (result.error) { ctx.json(res, 400, null, result.error, requestId); return true; }
    db.insert(tags).values(result.value).run();
    ctx.json(res, 201, result.value, null, requestId);
    return true;
  }
  return false;
};
