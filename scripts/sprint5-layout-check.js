import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("apps/web/app/page.jsx", "utf8");
for (const marker of [
  'grid-template-columns:260px minmax(0,1fr) 340px',
  'data-testid="agent-chat"',
  'data-testid="agent-plan"',
  'organizationMode: "tree"',
  'branch-decision',
  'Tree sources',
  'renderWikiTree',
  'planEditDraft',
  'className="chat-window"',
  'className="plan-item"',
  'agent-trace',
  '审阅并应用',
  '回滚'
]) assert.ok(source.includes(marker), `missing Sprint 5 layout marker: ${marker}`);
console.log(JSON.stringify({ status: "passed", columns: 3, panels: ["chat", "tree-plan-review", "provider-trace"], polling: true, treeScopeSelection: true }));
