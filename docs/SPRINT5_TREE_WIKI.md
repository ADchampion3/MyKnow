# Sprint 5 hierarchical Wiki organization

This slice adds a reviewable, AI-generated Wiki tree on top of the existing API → Worker → SQLite flow. The model proposes a plan; only a human review request can apply it.

## Contract

Create a run with `POST /api/agent/runs`:

```json
{
  "kind": "organize",
  "organizationMode": "tree",
  "knowledgeBaseId": "<kb-uuid>",
  "resourceVersionIds": ["<resource-version-uuid>"],
  "wikiPageIds": ["<selected-page-uuid>"],
  "mountPageId": "<optional-existing-page-uuid>",
  "prompt": "Build a reviewable hierarchy from the selected evidence."
}
```

The scope is a server-created snapshot. A tree run must name at least one readable resource version or Wiki page version. `mountPageId`, when present, must be an active non-system page. The generated root is a new `synthesis` page; `index` and `log` are never changed.

Generated page nodes use stable plan references until approval:

- `root` / `synthesis`: exactly one root.
- `category` / `concept`: a conceptual grouping page.
- `entity` / `entity`: an entity page.
- `source` / `source-summary`: a source-backed leaf page.

The server enforces maximum depth 4, 50 pages per run, and 8 children per parent. `parentNodeId` is the only hierarchy reference in tree output; the server allocates real UUID page IDs during apply. Every non-tag page needs at least one valid resource-version or selected Wiki-page citation. Missing evidence is `needs_evidence` and cannot be applied.

## Review API

- `GET /api/agent/runs/:runId/plan` returns flat items, a nested `tree`, `planStatus`, and the scope mode/mount.
- `PATCH /api/agent/plan-items/:itemId` edits pending title/type/content or hierarchy metadata and revalidates the entire plan. The stable `nodeId` cannot be changed and source scope cannot be expanded.
- `POST /api/agent/plan-items/:itemId/branch-decision` with `{"decision":"approve"}` applies the page branch in parent-first order and one SQLite transaction. `reject` recursively rejects pending page descendants without touching Wiki data.
- `POST /api/agent/plan-items/:itemId/decision` remains available for individual review. A child cannot be applied before its parent branch.
- `POST /api/agent/plan-items/:itemId/rollback` creates a new restoring version or archives a created page. It refuses to archive a created page that still has active children.

Updates use the existing page-version optimistic check. If a selected existing page changed after plan creation, the relevant item/branch becomes stale; there is no force overwrite. Original source bytes, Wiki versions, citation rows, and audit logs remain retained.

## Human verification from an empty database

Run the three processes in separate terminals:

```powershell
npm run dev:api
npm run dev:worker
npm run dev:web
```

Then:

1. Open the Web workspace and create/select a knowledge base.
2. Import a small `.md` or `.txt` source and wait until its status is `indexed`.
3. In the left Wiki tree, tick one or more Wiki pages if desired. In `Tree sources`, tick the current indexed resource version, or use `Select all current resources`.
4. Optionally choose an existing non-system page under `Mount under`; leave `Top-level root` to create a top-level root.
5. Click `生成整理计划`. Wait for the Agent run to become `succeeded`.
6. In the plan panel, verify one root, nested node indentation, node role/type, evidence count, diff (for updates), risk, and `Plan status: ready`.
7. Edit a pending item and save it. Confirm it remains pending and the server reports revalidated evidence.
8. Click `审阅并应用整棵分支` on the root. Confirm the Wiki tree has root → category/entity → source-summary pages and the chosen mount is the root parent.
9. Open each generated page and verify its citation returns to a read-only source/version locator. Inspect `log / events` for branch approval/audit entries.
10. Generate another tree plan and click `拒绝分支`. Confirm no new pages appear. For a rollback check, roll back an applied leaf first; rollback creates a new version and retains the prior version.
11. Try submitting a run with `mountPageId` set to `index` or `log`; the API must reject it with `AGENT_SCOPE_INVALID`.

The deterministic end-to-end fixture is:

```powershell
node scripts/agent-tree-check.js
```

The full local acceptance gate is `npm run check:sprint5`; it writes redacted evidence under `artifacts/sprint5/`, including `agent-tree.jsonl` and `acceptance-report.md`. Real DeepSeek verification is separate: `npm run check:deepseek` reads the server-side `MODEL_API_KEY` and records only a redacted status summary. Do not paste the key into Web requests, browser bundles, screenshots, or ordinary logs.

## Current deliberate ceiling

The local MVP uses one initial model call, deterministic mock fixtures, and one-second Web polling. Retry/repair prompting, SSE, richer cross-page links, and multi-user permissions remain follow-up work; the tree review gate and transactional writes are not bypassed by those deferrals.
