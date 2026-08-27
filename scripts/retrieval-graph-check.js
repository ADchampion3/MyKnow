import assert from "node:assert/strict";
import { executeRetrieval } from "@myknow/db";
import { createRetrievalFixture } from "./retrieval-fixture.js";

const fixture = createRetrievalFixture();
try {
  const high = await executeRetrieval({
    sqlite: fixture.sqlite,
    config: fixture.config,
    input: { knowledgeBaseId: fixture.ids.kb, spaceId: fixture.ids.space, query: "release deployment runbook", wikiTopK: 5, rawTopK: 10, contextBudgetTokens: 8000 }
  });
  assert.equal(high.wiki.seeds.length, 1);
  assert.equal(high.wiki.seeds[0].pageId, fixture.ids.seed);
  assert.equal(high.wiki.seeds[0].seedGate.passed, true);
  assert.deepEqual(new Set(high.wiki.graphExpanded.map((item) => item.pageId)), new Set([fixture.ids.outboundOne, fixture.ids.inbound, fixture.ids.outboundTwo]));
  assert.equal(high.wiki.graphExpanded.filter((item) => item.hop === 1).length, 2);
  assert.equal(high.wiki.graphExpanded.filter((item) => item.hop === 2).length, 1);
  assert.deepEqual(new Set(high.wiki.graphExpanded.map((item) => item.path[0].direction)), new Set(["outbound", "inbound"]));
  assert.ok(high.wiki.graphExpanded.every((item) => item.pageVersionId === fixture.ids.pageVersion.get(item.pageId)));
  assert.ok(high.wiki.graphExpanded.every((item) => item.pageId !== fixture.ids.rawChunk));
  assert.equal(high.provenance.length, 1);
  assert.equal(high.provenance[0].via, "provenance");
  assert.equal(high.provenance[0].pageId, fixture.ids.seed);
  assert.equal(high.provenance[0].integrity, "valid");

  const low = await executeRetrieval({ sqlite: fixture.sqlite, config: fixture.config, input: { knowledgeBaseId: fixture.ids.kb, query: "release missingtermxyz", contextBudgetTokens: 8000 } });
  assert.ok(low.wiki.seeds.some((item) => item.seedGate.reason === "score_below_min"));
  assert.equal(low.wiki.graphExpanded.length, 0);

  const rawOnly = await executeRetrieval({ sqlite: fixture.sqlite, config: fixture.config, input: { knowledgeBaseId: fixture.ids.kb, query: "raw child chunk", contextBudgetTokens: 8000 } });
  assert.equal(rawOnly.wiki.seeds.length, 0);
  assert.equal(rawOnly.wiki.graphExpanded.length, 0);
  assert.ok(rawOnly.raw.results.some((item) => item.chunkId === fixture.ids.rawChunk));
  assert.ok(rawOnly.raw.results.every((item) => !item.pageId));

  console.log(JSON.stringify({ status: "passed", highConfidenceSeed: fixture.ids.seed, graph: high.wiki.graphExpanded.map((item) => ({ pageId: item.pageId, hop: item.hop, direction: item.path[0].direction, decay: item.decay })), lowConfidenceGraphCount: low.wiki.graphExpanded.length, rawOnlyGraphCount: rawOnly.wiki.graphExpanded.length, provenance: high.provenance.length }));
} finally {
  fixture.close();
}
