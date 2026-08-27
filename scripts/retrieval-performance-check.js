import assert from "node:assert/strict";
import crypto from "node:crypto";
import { executeRetrieval, persistBytes, searchableText, sha256, updateWikiSearchProjection } from "@myknow/db";
import { createRetrievalFixture } from "./retrieval-fixture.js";

const uuid = () => crypto.randomUUID();
const fixture = createRetrievalFixture();
try {
  const now = new Date().toISOString();
  const pageIds = Array.from({ length: 100 }, () => ({ id: uuid(), versionId: uuid() }));
  const rawInsert = fixture.sqlite.transaction(() => {
    for (let documentIndex = 0; documentIndex < 100; documentIndex += 1) {
      const resourceId = uuid();
      const resourceVersionId = uuid();
      const processingRunId = uuid();
      const bytes = Buffer.from(`performance source ${documentIndex}`);
      const digest = sha256(bytes);
      const storageKey = `blobs/${digest.slice(0, 2)}/${digest}`;
      persistBytes(fixture.storageDir, storageKey, bytes);
      fixture.sqlite.prepare("INSERT INTO resources (id,name,source_type,wiki_mode,status,current_version_id,created_at,updated_at) VALUES (?,?,? ,NULL,'indexed',NULL,?,?)").run(resourceId, `Performance document ${documentIndex}`, "text", now, now);
      fixture.sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(resourceId, fixture.ids.kb, now);
      fixture.sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,status,title,created_at,updated_at) VALUES (?,?,?,?,?,?,'indexed',?,?,?)").run(resourceVersionId, resourceId, digest, storageKey, "text/plain", bytes.length, `Performance document ${documentIndex}`, now, now);
      fixture.sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,input_sha256,created_at,updated_at) VALUES (?,?, 'indexed',?,?,?)").run(processingRunId, resourceVersionId, digest, now, now);
      fixture.sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(processingRunId, resourceVersionId);
      fixture.sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(resourceVersionId, resourceId);
      const parentId = uuid();
      const parent = `Document ${documentIndex} parent context.`;
      fixture.sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,status,created_at) VALUES (?,?,?,?, 'parent_text',?,?,?,?,?,?,?,'active',?)").run(parentId, resourceVersionId, processingRunId, null, 0, parent, null, 0, parent.length, JSON.stringify({ startOffset: 0, endOffset: parent.length, resourceVersionId, processingRunId }), "performance", now);
      for (let chunkIndex = 0; chunkIndex < 50; chunkIndex += 1) {
        const chunkId = uuid();
        const content = `performanceterm${documentIndex % 10} document ${documentIndex} chunk ${chunkIndex} searchable evidence.`;
        const startOffset = parent.length + chunkIndex * content.length;
        fixture.sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,status,created_at) VALUES (?,?,?,?, 'text',?,?,?,?,?,?,?,'active',?)").run(chunkId, resourceVersionId, processingRunId, parentId, chunkIndex + 1, content, parent, startOffset, startOffset + content.length, JSON.stringify({ startOffset, endOffset: startOffset + content.length, resourceVersionId, processingRunId, childIndex: chunkIndex }), "performance", now);
        fixture.sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)").run(chunkId, searchableText(`${parent}\n\n${content}`), `Performance document ${documentIndex}`);
      }
    }
    for (let pageIndex = 0; pageIndex < pageIds.length; pageIndex += 1) {
      const page = pageIds[pageIndex];
      const link = pageIndex + 1 < pageIds.length ? ` [Next](wiki://${pageIds[pageIndex + 1].id})` : "";
      const content = `# Performance topic ${pageIndex}\n\nperformanceterm${pageIndex % 10} page evidence.${link}`;
      fixture.sqlite.prepare("INSERT INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)").run(page.id, fixture.ids.kb, fixture.ids.space, null, `performance-${pageIndex}`, `Performance topic ${pageIndex}`, "concept", now, now);
      fixture.sqlite.prepare("INSERT INTO wiki_page_versions (id,page_id,parent_version_id,template_version_id,content_markdown,content_sha256,change_summary,created_at) VALUES (?,?,NULL,NULL,?,?,?,?)").run(page.versionId, page.id, content, sha256(content), "performance", now);
      fixture.sqlite.prepare("INSERT INTO wiki_page_blocks (id,page_version_id,block_key,block_type,ordinal,heading_path,content_markdown,content_sha256) VALUES (?,?,?,?,?,?,?,?)").run(uuid(), page.versionId, sha256(content).slice(0, 32), "paragraph", 0, "[]", content, sha256(content));
      fixture.sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(page.versionId, page.id);
    }
  });
  rawInsert();
  fixture.sqlite.transaction(() => { for (const page of pageIds) updateWikiSearchProjection(fixture.sqlite, page.id); })();

  const rawCount = fixture.sqlite.prepare("SELECT count(*) AS count FROM chunks WHERE chunk_type='text' AND status='active'").get().count;
  const wikiCount = fixture.sqlite.prepare("SELECT count(*) AS count FROM wiki_fts").get().count;
  assert.ok(rawCount >= 5000);
  assert.ok(wikiCount >= 100);
  const durations = [];
  let recalled = 0;
  for (let index = 0; index < 20; index += 1) {
    const query = `performanceterm${index % 10}`;
    const started = performance.now();
    const trace = await executeRetrieval({ sqlite: fixture.sqlite, config: fixture.config, input: { knowledgeBaseId: fixture.ids.kb, query, wikiTopK: 5, rawTopK: 10, contextBudgetTokens: 8000 } });
    durations.push(performance.now() - started);
    assert.equal(trace.status, "succeeded");
    assert.equal(trace.scope.rawScope, "knowledge_base");
    assert.ok(trace.raw.results.length <= 10);
    assert.ok(trace.wiki.seeds.length <= 5);
    if (trace.raw.results.some((result) => result.matchedFeatures.matchedTerms.includes(query))) recalled += 1;
  }
  assert.ok(recalled / 20 >= 0.9, `Recall@10 was ${(recalled / 20 * 100).toFixed(1)}%`);
  const sorted = [...durations].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 <= 2000, `retrieval p95 exceeded 2 seconds: ${p95.toFixed(2)}ms`);
  console.log(JSON.stringify({ status: "passed", corpus: { documents: 100, childChunks: rawCount, wikiPages: wikiCount }, queries: durations.length, recallAt10: `${recalled}/20`, timingMs: { p50: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)), p95: Number(p95.toFixed(2)), max: Number(sorted.at(-1).toFixed(2)) }, vectorProvider: "disabled" }));
} finally {
  fixture.close();
}
