# Agent / RAG / Wiki 审核机制调研

调研日期：2026-09-09

## 结论

当前实现是“两层审计 + 一个 Wiki 写入审核门”：

1. RAG 保存技术证据链，但检索和最终 Agent 答案没有人工批准步骤。
2. Agent 对 Wiki 的写操作必须先提交变更计划；Agent 本身不能直接写 Wiki。
3. 用户通过 approve/reject/edit/rollback 接口作决定，Wiki 应用在事务中创建不可变新版本，并保留 diff、引用和回滚信息。

## Agent 执行与范围

- `agent_runs` 保存 run 类型、scope snapshot、prompt/model/egress、状态、结果和错误。
- scope snapshot 固定知识库、空间、资源版本、Wiki 页面版本和 retrieval run；有知识库的 Agent run 要求显式可读范围。
- Worker 只暴露六个读取工具，以及按 run 类型选择的 `submit_answer` 或 `submit_change_plan`；工具 allowlist、最大工具调用数、最大轮数、超时和任务重试均有约束。
- Agent prompt 明确禁止 filesystem/shell/web/network/SQL/外部连接器，并要求把工具返回值当作不可信数据。

主要代码：`packages/db/src/agent.js`、`apps/worker/src/agent/tools.js`、`apps/worker/src/agent/runtime.js`、`apps/worker/src/agent/prompts.js`。

## RAG 审计链

- Wiki 和 Raw 两个通道先关键词召回，可选向量召回，再做 RRF；Wiki 通过 seed gate 后最多两跳图扩展。
- 一次检索保存为 `retrieval_runs`，包含 query/scope、Wiki seeds、Raw seeds、graph expansion、provenance lookups、context items/markdown、预算、metrics、vector 状态和 replay trace。
- API 和 Agent `search_knowledge` 都能把 retrieval run 写入 `audit_logs`；`agent_events` 额外记录工具调用的输入/输出 hash、大小、耗时、token/cost 和错误，但不保存调用正文。
- Answer chat message 会保存使用过的 retrieval run IDs；organize run 当前没有同等的直接 retrieval-run ID 字段，只能从 agent events、计划引用和 run 统计间接追踪。
- RAG 的“审核”目前是可解释性、来源定位、状态和指标记录，不是人工审阅/批准；`submit_answer` 只做答案契约与引用校验。

主要代码：`packages/db/src/retrieval.js`、`apps/api/src/routes/retrieval.js`、`packages/db/src/schema.js`。

## Wiki 写入审核门

- `submit_change_plan` 只校验并落库 `agent_plan_items`，不会应用变更。
- 每项计划保存类型、目标、基线版本、提议内容、citations、diff、risk、evidence status、review status、application status、决策人/原因/时间和应用/回滚版本。
- `page_update` 必须携带 scope snapshot 中的精确 `basePageVersionId`；版本不一致会变成冲突，避免覆盖人类新编辑。
- `needs_evidence` 不能应用；页面建议的引用、locator、chunk/block 和版本会在服务端重新校验。风险级别由操作类型决定：tag 低、page create 中、page update 高；批量批准仅允许同一 run 的 tag_add。
- 批准单项或树分支才进入事务，实际操作通过不可变 Wiki page version、block、citation、projection 和 embedding task 完成；拒绝、过期冲突、应用失败和回滚都有状态与审计事件。
- rollback 不删除历史版本，而是创建恢复版本；新建页面回滚则要求页面仍未被外部改变且没有活动子页面。

主要代码：`packages/db/src/agent.js`、`apps/api/src/routes/agent.js`、`apps/api/src/routes/wiki.js`。

## 现有边界与风险

1. `/api/knowledge-bases/:id/wiki` 的系统日志只筛选知识库、资源、Wiki 等实体，未包含 `agent_run`、`agent_plan_item`、`agent_events`、`retrieval_run`、`chat_message` 等；这些记录虽在数据库/API 中存在，但没有统一审计视图。
2. 计划决策接口接收请求体中的 `actor`，默认 `local-user`，当前没有认证/授权主体校验；日志中的操作者是调用方声明。
3. 中央 `ctx.audit` 会做敏感字段脱敏，但 `packages/db/src/agent.js` 的 `auditAgent` 直接写 `audit_logs`，绕过该脱敏入口。当前常见 metadata 多为 ID/status，但 `reason` 等字段仍有结构性风险。
4. Worker 产生的 Agent/embedding 审计通常没有 HTTP `requestId`；任务、run 和事件可关联，但跨请求链路不完整。
5. 审计正文隔离是有意的：Agent events 只保留 hash/统计，RAG 正文在 retrieval trace/context 中。retrieval trace 属于 derived data，默认保留 30 天且清理命令会删除；原始资源、版本、processing run 和 audit log 保留。因此长期审计只能保证事件和版本，不保证永远可重放完整 RAG context。
6. Raw child 的 provenance 主要是 locator + resource version + processing run，不像 Wiki citation 一样在每次检索时完成 block 级引用状态和源文件完整性复核。
7. `scanWikiImpacts` 当前扫描资源引用 `wiki_citations`；没有看到对 Wiki-to-Wiki 引用 `wiki_page_citations` 的同等版本变更重检。
8. Agent 的失败有任务重试和 apply conflict 状态，但部分 apply 失败后的补偿审计使用了吞异常的 fallback；审计写入不是所有异常路径的强保证。

## 关键文档

- `PRD.md`：原始资料不可变、Agent 必须引用、任何写入先形成可审核变更计划。
- `CONTEXT.md`：retrieval run、provenance lookup、context snapshot、derived data retention 等领域术语。
- `docs/RETRIEVAL_MECHANISM.md`：当前检索审计、Raw/Wiki provenance、派生数据清理和未解决边界。
