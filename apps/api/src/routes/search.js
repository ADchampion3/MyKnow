export const handleSearchRoutes = ({ ctx, request }) => {
  const { pathname, method, parsed, requestId, res } = request;
  if (pathname !== "/api/search" || method !== "GET") return false;

  const q = (parsed.searchParams.get("q") || "").trim();
  const kb = parsed.searchParams.get("knowledgeBaseId");
  const versionId = parsed.searchParams.get("resourceVersionId");
  if (!q || q.length > 200 || (!kb && !versionId)) {
    ctx.json(res, 400, null, ctx.error("VALIDATION_ERROR", "q must be 1-200 characters and include knowledgeBaseId or resourceVersionId"), requestId);
    return true;
  }
  const ftsQuery = q.split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll("\"", "\"\"")}"*`).join(" AND ");
  const currentClause = versionId ? "" : "AND r.current_version_id=rv.id ";
  const sql = "SELECT c.*,p.content AS parent_content,p.start_offset AS parent_start_offset,p.end_offset AS parent_end_offset,rv.resource_id,r.name AS resource_name,rv.title FROM resource_fts f JOIN chunks c ON c.id=f.chunk_id LEFT JOIN chunks p ON p.id=c.parent_chunk_id AND p.status='active' JOIN resource_versions rv ON rv.id=c.resource_version_id JOIN resources r ON r.id=rv.resource_id " + (kb ? "JOIN resource_knowledge_bases rkb ON rkb.resource_id=r.id " : "") + "WHERE f.content MATCH ? AND c.chunk_type='text' AND c.status='active' AND rv.active_processing_run_id=c.processing_run_id AND r.status <> 'archived' " + currentClause + (kb ? "AND rkb.knowledge_base_id=? " : "") + (versionId ? "AND c.resource_version_id=? " : "") + "ORDER BY rank LIMIT 20";
  const args = [ftsQuery, ...(kb ? [kb] : []), ...(versionId ? [versionId] : [])];
  ctx.json(res, 200, ctx.sqlite.prepare(sql).all(...args), null, requestId);
  return true;
};
