import assert from "node:assert/strict";
import { estimateTokens, executeRetrieval } from "@myknow/db";
import { createRetrievalFixture } from "./retrieval-fixture.js";

const fixture = createRetrievalFixture({ longContent: true });
try {
  const trace = await executeRetrieval({ sqlite: fixture.sqlite, config: fixture.config, input: { knowledgeBaseId: fixture.ids.kb, query: "release deployment runbook", contextBudgetTokens: 120, wikiTopK: 5, rawTopK: 10 } });
  const { context } = trace;
  assert.equal(context.wikiBudgetTokens, 72);
  assert.equal(context.rawBudgetTokens, 48);
  assert.ok(context.wikiEstimatedTokens <= context.wikiBudgetTokens);
  assert.ok(context.rawEstimatedTokens <= context.rawBudgetTokens);
  assert.ok(context.estimatedTokens <= 120);
  assert.equal(context.estimatedTokens, estimateTokens(context.markdown));
  assert.equal(context.truncated, true);
  assert.ok(context.truncatedItems.some((item) => item.reason === "page_truncated"));
  const wikiItem = context.items.find((item) => item.channel === "wiki");
  const rawItem = context.items.find((item) => item.channel === "raw");
  assert.ok(wikiItem);
  assert.ok(rawItem);
  assert.ok(wikiItem.text.length < fixture.sqlite.prepare("SELECT length(content_markdown) AS length FROM wiki_page_versions WHERE id=?").get(fixture.ids.pageVersion.get(fixture.ids.seed)).length);
  assert.equal(wikiItem.provenance[0].via, "provenance");
  assert.equal(wikiItem.provenance[0].source.resourceVersionId, fixture.ids.resourceVersion);
  assert.equal(rawItem.provenance[0].via, "raw");
  assert.equal(rawItem.provenance[0].resourceVersionId, fixture.ids.resourceVersion);
  assert.equal(rawItem.provenance[0].processingRunId, fixture.ids.processingRun);
  assert.deepEqual(rawItem.locator, trace.raw.results[0].locator);

  const normal = createRetrievalFixture();
  try {
    const full = await executeRetrieval({ sqlite: normal.sqlite, config: normal.config, input: { knowledgeBaseId: normal.ids.kb, query: "release deployment runbook", contextBudgetTokens: 240 } });
    const graphItem = full.context.items.find((item) => item.type === "wiki_graph_page");
    assert.ok(graphItem?.graphPath?.length >= 2);
    assert.ok(full.context.items.some((item) => item.channel === "raw"));
  } finally {
    normal.close();
  }

  console.log(JSON.stringify({ status: "passed", budget: { total: context.estimatedTokens, wiki: `${context.wikiEstimatedTokens}/${context.wikiBudgetTokens}`, raw: `${context.rawEstimatedTokens}/${context.rawBudgetTokens}` }, truncated: context.truncated, truncatedItems: context.truncatedItems, provenanceInContext: { wiki: wikiItem.provenance.length, raw: rawItem.provenance.length } }));
} finally {
  fixture.close();
}
