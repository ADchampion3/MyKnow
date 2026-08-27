import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDatabase,
  migrate,
  parseMarkdownBlocks,
  persistBytes,
  searchableText,
  sha256,
  updateWikiSearchProjection
} from "@myknow/db";

const uuid = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();

export const createRetrievalFixture = ({ longContent = false } = {}) => {
  const { sqlite } = createDatabase(":memory:");
  migrate(sqlite);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-retrieval-"));
  const now = timestamp();
  const ids = {
    kb: uuid(),
    otherKb: uuid(),
    space: uuid(),
    otherSpace: uuid(),
    seed: uuid(),
    outboundOne: uuid(),
    outboundTwo: uuid(),
    inbound: uuid(),
    noise: uuid(),
    otherPage: uuid(),
    pageVersion: new Map(),
    resource: uuid(),
    resourceVersion: uuid(),
    processingRun: uuid(),
    parentChunk: uuid(),
    rawChunk: uuid()
  };

  const insertKb = (id, name) => sqlite.prepare("INSERT INTO knowledge_bases (id,name,status,created_at,updated_at) VALUES (?,?, 'active',?,?)").run(id, name, now, now);
  insertKb(ids.kb, "Retrieval fixture KB");
  insertKb(ids.otherKb, "Other fixture KB");
  sqlite.prepare("INSERT INTO spaces (id,knowledge_base_id,name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(ids.space, ids.kb, "Core", now, now);
  sqlite.prepare("INSERT INTO spaces (id,knowledge_base_id,name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(ids.otherSpace, ids.kb, "Other", now, now);

  const addPage = ({ id, knowledgeBaseId = ids.kb, spaceId = ids.space, title, contentMarkdown, pageType = "concept" }) => {
    const versionId = uuid();
    ids.pageVersion.set(id, versionId);
    sqlite.prepare("INSERT INTO wiki_pages (id,knowledge_base_id,space_id,parent_page_id,slug,title,page_type,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)").run(id, knowledgeBaseId, spaceId, null, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}`, title, pageType, now, now);
    sqlite.prepare("INSERT INTO wiki_page_versions (id,page_id,parent_version_id,template_version_id,content_markdown,content_sha256,change_summary,created_at) VALUES (?,?,NULL,NULL,?,?,?,?)").run(versionId, id, contentMarkdown, sha256(contentMarkdown), "fixture", now);
    for (const block of parseMarkdownBlocks(contentMarkdown)) sqlite.prepare("INSERT INTO wiki_page_blocks (id,page_version_id,block_key,block_type,ordinal,heading_path,content_markdown,content_sha256) VALUES (?,?,?,?,?,?,?,?)").run(uuid(), versionId, block.blockKey, block.blockType, block.ordinal, JSON.stringify(block.headingPath), block.contentMarkdown, block.contentSha256);
    sqlite.prepare("UPDATE wiki_pages SET current_version_id=? WHERE id=?").run(versionId, id);
    return { id, versionId };
  };

  const longTail = longContent ? `\n\n${"Long context paragraph for deterministic truncation. ".repeat(160)}` : "";
  addPage({ id: ids.seed, title: "Deployment Runbook", contentMarkdown: `# Deployment Runbook\n\n## Release procedure\nThe release deployment runbook explains the release procedure and rollback evidence. [Operations checklist](wiki://${ids.outboundOne})${longTail}` });
  addPage({ id: ids.outboundOne, title: "Operations Checklist", contentMarkdown: `# Operations Checklist\n\nUse the operations checklist before execution. [Rollback guide](wiki://${ids.outboundTwo})${longTail}` });
  addPage({ id: ids.outboundTwo, title: "Rollback Guide", contentMarkdown: `# Rollback Guide\n\nThe rollback guide records safe recovery steps.${longTail}` });
  addPage({ id: ids.inbound, title: "Audit Note", contentMarkdown: `# Audit Note\n\nThis note links back to the primary procedure. [Primary page](wiki://${ids.seed})${longTail}` });
  addPage({ id: ids.noise, title: "Unrelated Note", contentMarkdown: "# Unrelated Note\n\nA page with no matching retrieval terms." });
  addPage({ id: ids.otherPage, knowledgeBaseId: ids.otherKb, spaceId: null, title: "Deployment Runbook Elsewhere", contentMarkdown: "# Deployment Runbook Elsewhere\n\nThis belongs to another knowledge base." });
  for (const pageId of [ids.seed, ids.outboundOne, ids.outboundTwo, ids.inbound, ids.noise, ids.otherPage]) updateWikiSearchProjection(sqlite, pageId);

  const sourceBytes = Buffer.from("Source evidence for the deployment release.");
  const sourceDigest = sha256(sourceBytes);
  const storageKey = `blobs/${sourceDigest.slice(0, 2)}/${sourceDigest}`;
  persistBytes(storageDir, storageKey, sourceBytes);
  sqlite.prepare("INSERT INTO resources (id,name,source_type,wiki_mode,status,current_version_id,created_at,updated_at) VALUES (?,?,? ,NULL,'indexed',NULL,?,?)").run(ids.resource, "Release source", "text", now, now);
  sqlite.prepare("INSERT INTO resource_knowledge_bases (resource_id,knowledge_base_id,created_at) VALUES (?,?,?)").run(ids.resource, ids.kb, now);
  sqlite.prepare("INSERT INTO resource_versions (id,resource_id,content_sha256,storage_key,mime_type,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'indexed',?,?)").run(ids.resourceVersion, ids.resource, sourceDigest, storageKey, "text/plain", sourceBytes.length, now, now);
  sqlite.prepare("INSERT INTO processing_runs (id,resource_version_id,status,input_sha256,created_at,updated_at) VALUES (?,?, 'indexed',?,?,?)").run(ids.processingRun, ids.resourceVersion, sourceDigest, now, now);
  sqlite.prepare("UPDATE resource_versions SET active_processing_run_id=? WHERE id=?").run(ids.processingRun, ids.resourceVersion);
  sqlite.prepare("UPDATE resources SET current_version_id=? WHERE id=?").run(ids.resourceVersion, ids.resource);
  const parent = "Parent context: release deployment operations and recovery notes.";
  const child = "The raw child chunk contains release deployment runbook evidence.";
  sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,status,created_at) VALUES (?,?,?,?, 'parent_text',?,?,?,?,?,?,?,'active',?)").run(ids.parentChunk, ids.resourceVersion, ids.processingRun, null, 0, parent, null, 0, parent.length, JSON.stringify({ startOffset: 0, endOffset: parent.length, resourceVersionId: ids.resourceVersion, processingRunId: ids.processingRun }), "fixture", now);
  sqlite.prepare("INSERT INTO chunks (id,resource_version_id,processing_run_id,parent_chunk_id,chunk_type,sequence,content,context_header,start_offset,end_offset,locator,strategy,status,created_at) VALUES (?,?,?,?, 'text',?,?,?,?,?,?,?,'active',?)").run(ids.rawChunk, ids.resourceVersion, ids.processingRun, ids.parentChunk, 1, child, "release deployment", parent.length, parent.length + child.length, JSON.stringify({ startOffset: parent.length, endOffset: parent.length + child.length, resourceVersionId: ids.resourceVersion, processingRunId: ids.processingRun }), "fixture", now);
  sqlite.prepare("INSERT INTO resource_fts (chunk_id,content,title) VALUES (?,?,?)").run(ids.rawChunk, searchableText(`${parent}\n\n${child}`), "Release source");
  sqlite.prepare("INSERT INTO wiki_citations (id,page_version_id,block_key,resource_version_id,locator_json,status,checked_at,created_at) VALUES (?,?,?,?,?,'active',?,?)").run(uuid(), ids.pageVersion.get(ids.seed), null, ids.resourceVersion, JSON.stringify({ startOffset: 0, endOffset: 12 }), now, now);

  return {
    sqlite,
    storageDir,
    ids,
    config: { resourceStorageDir: storageDir, retrievalVectorEnabled: false, embeddingProvider: "mock", embeddingModel: "mock-hash-v1", embeddingDimensions: 32 },
    close() { sqlite.close(); fs.rmSync(storageDir, { recursive: true, force: true }); }
  };
};
