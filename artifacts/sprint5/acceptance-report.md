# Sprint 5 acceptance report

- Status: passed (local mock/provider contract gate)
- Date: 2026-08-28T13:44:32.250Z (UTC; local timezone Asia/Shanghai)
- Node: v24.16.0
- npm: 12.0.2
- Commit under test: 0156cd9
- Database: each focused check uses an isolated temporary SQLite database.
- Resource storage: each focused check uses an isolated temporary storage directory.
- API key: not recorded; local checks force MODEL_API_KEY to an empty value.

## Passed checks

- agent-contract: passed
- agent-provider: passed
- agent-tree: passed
- agent-review: passed
- agent-scale: passed
- agent-advanced: passed
- open-chat: passed
- agent-rebuild: passed
- agent-security: passed
- sprint5-layout: passed
- web-build: passed

## Provider boundary

- Mock Agent and a local OpenAI-compatible SSE provider are covered by the focused gate.
- Real DeepSeek check: passed (deepseek-chat, evidenceStatus=none).
- Tree mode is covered by explicit source selection, bounded node validation, transactional branch review, and archive-safe rollback.
