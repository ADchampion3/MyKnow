import fs from "node:fs";
import { safeStoragePath } from "./resources.js";

const fail = (message, code = "VALIDATION_ERROR") => Object.assign(new Error(message), { code });
const asRetentionDays = (value) => {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36500) throw fail("retentionDays must be an integer between 1 and 36500");
  return days;
};
const timestampFor = (value) => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw fail("cleanup reference time is invalid");
  return date.toISOString();
};
const count = (sqlite, sql, ...args) => Number(sqlite.prepare(sql).get(...args)?.count || 0);

const candidateProcessingRuns = (sqlite, cutoff) => sqlite.prepare(`
  SELECT pr.id,pr.resource_version_id,pr.status,pr.canonical_storage_key,
    CASE WHEN r.current_version_id=rv.id THEN 1 ELSE 0 END AS is_current_version
  FROM processing_runs pr
  JOIN resource_versions rv ON rv.id=pr.resource_version_id
  JOIN resources r ON r.id=rv.resource_id
  WHERE pr.updated_at<?
    AND (
      (pr.status='superseded' AND rv.active_processing_run_id IS NOT NULL AND rv.active_processing_run_id<>pr.id)
      OR (r.current_version_id IS NOT NULL AND r.current_version_id<>rv.id AND pr.status IN ('indexed','superseded'))
      OR (r.status='archived' AND pr.status IN ('indexed','superseded'))
    )
  ORDER BY pr.updated_at,pr.id
`).all(cutoff);

const cleanupCandidates = (sqlite, cutoff) => {
  const runs = candidateProcessingRuns(sqlite, cutoff);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const byResourceVersion = new Map();
  for (const run of runs) byResourceVersion.set(run.resource_version_id, [...(byResourceVersion.get(run.resource_version_id) || []), run.id]);
  const blocked = new Set();
  const activeWikiPageVersions = new Set();
  let unknownWikiEmbeddingTask = false;
  const activeTasks = sqlite.prepare("SELECT resource_version_id,payload FROM tasks WHERE type='retrieval:embed' AND status IN ('queued','running','retrying')").all();
  for (const task of activeTasks) {
    let payload = {};
    try { payload = JSON.parse(task.payload || "{}"); } catch {}
    if (payload.processingRunId && byId.has(payload.processingRunId)) blocked.add(payload.processingRunId);
    else if (task.resource_version_id && (payload.ownerType === "raw_chunk" || !payload.ownerType)) {
      for (const runId of byResourceVersion.get(task.resource_version_id) || []) blocked.add(runId);
    }
    if (payload.ownerType === "wiki_page") {
      if (typeof payload.pageVersionId === "string" && payload.pageVersionId) activeWikiPageVersions.add(payload.pageVersionId);
      else unknownWikiEmbeddingTask = true;
    } else if (!payload.ownerType && !task.resource_version_id) unknownWikiEmbeddingTask = true;
  }
  const staleWikiRows = sqlite.prepare(`
    SELECT DISTINCT v.id
    FROM wiki_page_versions v
    JOIN wiki_pages p ON p.id=v.page_id
    WHERE p.current_version_id<>v.id AND v.created_at<?
  `).all(cutoff);
  const wikiPageVersionIds = staleWikiRows
    .map((row) => row.id)
    .filter((id) => !unknownWikiEmbeddingTask && !activeWikiPageVersions.has(id));
  return {
    runs: runs.filter((run) => !blocked.has(run.id)),
    skippedActiveEmbeddingRuns: runs.filter((run) => blocked.has(run.id)).length,
    wikiPageVersionIds,
    skippedActiveEmbeddingWikiVersions: staleWikiRows.length - wikiPageVersionIds.length
  };
};

export const planDerivedCleanup = (sqlite, { retentionDays = 30, now = new Date() } = {}) => {
  const days = asRetentionDays(retentionDays);
  const referenceTime = timestampFor(now);
  const cutoff = new Date(new Date(referenceTime).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const selection = cleanupCandidates(sqlite, cutoff);
  const runs = selection.runs;
  const runIds = runs.map((run) => run.id);
  const runPlaceholders = runIds.map(() => "?").join(",") || "NULL";
  const wikiVersionPlaceholders = selection.wikiPageVersionIds.map(() => "?").join(",") || "NULL";
  const counts = {
    processingRuns: runs.length,
    supersededProcessingRuns: runs.filter((run) => run.status === "superseded").length,
    staleVersionRuns: runs.filter((run) => !run.is_current_version).length,
    skippedActiveEmbeddingRuns: selection.skippedActiveEmbeddingRuns,
    wikiPageVersions: selection.wikiPageVersionIds.length,
    skippedActiveEmbeddingWikiVersions: selection.skippedActiveEmbeddingWikiVersions,
    chunks: runIds.length ? count(sqlite, `SELECT count(*) AS count FROM chunks WHERE processing_run_id IN (${runPlaceholders})`, ...runIds) : 0,
    resourceFts: runIds.length ? count(sqlite, `SELECT count(*) AS count FROM resource_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE processing_run_id IN (${runPlaceholders}))`, ...runIds) : 0,
    rawEmbeddings: runIds.length ? count(sqlite, `SELECT count(*) AS count FROM retrieval_embeddings WHERE owner_type='raw_chunk' AND processing_run_id IN (${runPlaceholders})`, ...runIds) : 0,
    wikiEmbeddings: selection.wikiPageVersionIds.length ? count(sqlite, `SELECT count(*) AS count FROM retrieval_embeddings WHERE owner_type='wiki_page' AND page_version_id IN (${wikiVersionPlaceholders})`, ...selection.wikiPageVersionIds) : 0,
    wikiFts: selection.wikiPageVersionIds.length ? count(sqlite, `SELECT count(*) AS count FROM wiki_fts WHERE page_version_id IN (${wikiVersionPlaceholders})`, ...selection.wikiPageVersionIds) : 0,
    failedEmbeddings: count(sqlite, "SELECT count(*) AS count FROM retrieval_embeddings WHERE status='failed' AND updated_at<?", cutoff),
    retrievalRuns: count(sqlite, "SELECT count(*) AS count FROM retrieval_runs WHERE created_at<?", cutoff),
    canonicalArtifacts: runs.filter((run) => String(run.canonical_storage_key || "").startsWith("canonical/")).length
  };
  return { retentionDays: days, referenceTime, cutoff, candidates: counts, canonicalStorageKeys: runs.map((run) => run.canonical_storage_key).filter((key) => String(key || "").startsWith("canonical/")) };
};

const removeCanonicalArtifacts = (resourceStorageDir, keys) => {
  const errors = [];
  let removed = 0;
  for (const key of keys) {
    try {
      const target = safeStoragePath(resourceStorageDir, key);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removed += 1;
      }
    } catch (caught) {
      errors.push({ key, code: caught?.code || "STORAGE_CLEANUP_FAILED", error: caught?.message || "canonical artifact could not be removed" });
    }
  }
  return { removed, errors };
};

export const cleanupDerivedData = ({ sqlite, resourceStorageDir, retentionDays = 30, now = new Date(), dryRun = false } = {}) => {
  if (!sqlite) throw fail("sqlite is required");
  const plan = planDerivedCleanup(sqlite, { retentionDays, now });
  if (dryRun) return { ...plan, dryRun: true, deleted: {}, storage: { removed: 0, errors: [] } };
  const execution = sqlite.transaction(() => {
    const currentPlan = planDerivedCleanup(sqlite, { retentionDays, now: plan.referenceTime });
    if (currentPlan.canonicalStorageKeys.length && !resourceStorageDir) throw fail("resourceStorageDir is required to remove canonical artifacts", "STORAGE_CLEANUP_REQUIRED");
    const currentSelection = cleanupCandidates(sqlite, currentPlan.cutoff);
    const runIds = currentSelection.runs.map((run) => run.id);
    const runPlaceholders = runIds.map(() => "?").join(",") || "NULL";
    const wikiVersionPlaceholders = currentSelection.wikiPageVersionIds.map(() => "?").join(",") || "NULL";
    const result = {};
    result.resourceFts = runIds.length ? sqlite.prepare(`DELETE FROM resource_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE processing_run_id IN (${runPlaceholders}))`).run(...runIds).changes : 0;
    result.rawEmbeddings = runIds.length ? sqlite.prepare(`DELETE FROM retrieval_embeddings WHERE owner_type='raw_chunk' AND processing_run_id IN (${runPlaceholders})`).run(...runIds).changes : 0;
    result.wikiEmbeddings = currentSelection.wikiPageVersionIds.length ? sqlite.prepare(`DELETE FROM retrieval_embeddings WHERE owner_type='wiki_page' AND page_version_id IN (${wikiVersionPlaceholders})`).run(...currentSelection.wikiPageVersionIds).changes : 0;
    result.failedEmbeddings = sqlite.prepare("DELETE FROM retrieval_embeddings WHERE status='failed' AND updated_at<?").run(currentPlan.cutoff).changes;
    result.wikiFts = currentSelection.wikiPageVersionIds.length ? sqlite.prepare(`DELETE FROM wiki_fts WHERE page_version_id IN (${wikiVersionPlaceholders})`).run(...currentSelection.wikiPageVersionIds).changes : 0;
    if (runIds.length) {
      const childChanges = sqlite.prepare(`DELETE FROM chunks WHERE processing_run_id IN (${runPlaceholders}) AND chunk_type='text'`).run(...runIds).changes;
      const parentChanges = sqlite.prepare(`DELETE FROM chunks WHERE processing_run_id IN (${runPlaceholders}) AND chunk_type='parent_text'`).run(...runIds).changes;
      result.chunks = childChanges + parentChanges;
    } else result.chunks = 0;
    result.retrievalRuns = sqlite.prepare("DELETE FROM retrieval_runs WHERE created_at<?").run(currentPlan.cutoff).changes;
    return { plan: currentPlan, deleted: result };
  })();
  const storage = removeCanonicalArtifacts(resourceStorageDir, execution.plan.canonicalStorageKeys);
  return { ...execution.plan, dryRun: false, deleted: execution.deleted, storage };
};
