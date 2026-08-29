# Sprint 5 计划：Pi Agent 开放问答、Wiki 整理与审核回滚

## 1. 计划定位

Sprint 5（第 9-10 周）把 Sprint 4 的可回放检索证据接入 Pi Agent runtime，交付两个可审计的用户闭环：

1. 开放问答/开放聊天：用户可以不选知识库直接聊天，也可以在明确选择的资料和 Wiki 范围内提问。模型自身知识与 MyKnow 证据必须分开呈现。
2. Agent 整理：Agent 可以自主读取、检索、比较和规划，但只输出 Wiki 变更计划。用户审核后，系统才创建不可变 Wiki 版本或页面标签关联。

本 Sprint 使用 Pi 作为 Agent 层抽象，不把 Pi 作为 MyKnow 的业务状态、权限或审计系统。当前官方 Pi 包为 @earendil-works/pi-agent-core 和 @earendil-works/pi-ai，采用精确版本锁定；具体版本在实现时写入 package-lock.json，并以官方仓库为准：
https://github.com/earendil-works/pi

本 Sprint 已确认不交付严格库内问答、SSE 流式回答、网页搜索或其他外部工具。它们必须进入技术债/backlog，不能通过降低证据和审核门槛提前宣告完成。

## 2. 已确认的产品决策

### 2.1 Agent runtime

- 在 Worker 中直接使用 Pi Agent SDK，不运行 pi-coding-agent CLI，不使用 Pi 默认会话文件作为业务事实源。
- 问答和整理共用 agent_runs，通过 runKind 区分 answer 和 organize；二者使用不同的服务端 prompt、只读工具集合和终止工具。
- Agent 可以自主选择读取、检索、比较、总结和规划路径，允许多次检索；硬上限为 8 轮、32 次工具调用、120 秒。
- Worker 继续使用数据库轮询 task、task attempt、重试、取消、恢复和审计机制。

### 2.2 输入范围和快照

- 整理任务必须显式提供 knowledgeBaseId，以及至少一个 resourceVersionId 或 Wiki page ID；可以附带 spaceId 和 retrievalRunId。
- 聊天会话可以不选择知识库；选择知识库时必须显式指定资料版本/Wiki 页面，或引用一个同知识库的 retrieval run。
- 资料使用不可变 resource version；任务创建时锁定 resourceVersionId 和当时的 wikiPageVersionId。
- 运行期间的新资料版本或新 Wiki 版本不会混入当前 Agent 输入；不允许隐式扫描整个知识库。
- 用户 prompt 由服务端限制为 1-4000 字；不能覆盖系统规则、工具权限或输出契约。

### 2.3 开放问答/开放聊天

- Sprint 5 只有 open answer 模式，不暴露 mode 选择；服务端记录 answerMode=open。
- 不选择知识库时，模型可以进行普通开放聊天，不执行检索，也不产生 MyKnow 引用。
- 选择知识库后，Agent 可以检索和读取指定范围；回答分为正文、库内证据和模型补充。
- 没有命中时返回 evidenceStatus=no_match；索引不可用时返回 evidenceStatus=index_unavailable。回答可以继续生成，但不得把它标成库内证据。
- 严格库内问答留到后续 Sprint；它需要独立的拒答、证据覆盖率和提示策略验收。
- Sprint 5 不提供网页搜索、URL 抓取、任意网络、文件系统、Shell 或其他外部数据工具。

### 2.4 Wiki 整理和审核

- Agent 只能生成 page_create、page_update、tag_add、duplicate_finding、conflict_finding 五类计划项。
- 页面更新提交完整的新 Markdown，服务端根据 basePageVersionId 计算 diff；不接受 Agent 生成的 Patch 直接写入。
- 引用和 Wiki 链接是页面变更项内部字段；它们在服务端校验后派生 wiki citations 和 link edges。
- 每条实质性内容建议必须有资料版本和 locator；缺证据的内容显示为 needs_evidence，不可接受或应用。
- 同一事实的冲突来源分别引用；Agent 不得自动合并、覆盖原始资料或物理删除任何记录。
- tree organization mode 只接受显式 resourceVersionIds/wikiPageIds，生成一个受限的多层树：root/synthesis、category/concept、entity/entity、source/source-summary。
- 树最多 4 层、50 页、每个父页 8 个子页；新节点通过稳定 nodeId/parentNodeId 引用，审核应用时服务端才分配真实页面 UUID。
- 根节点可挂载到一个已存在的非 system Wiki 页面；不提供挂载时创建顶层根，index/log 永不修改。父页只总结子页，不生成任意交叉链接。
- 树计划支持整支分支审核、单项拒绝和审核前编辑；分支应用按父先子后在一个事务内完成，版本漂移只使相关项 stale。
- 事实改写、页面创建和冲突发现逐项审核；页面标签新增是唯一允许批量审核的低风险变更。
- 接受、拒绝、应用、失败、过期和回滚都必须可审计；部分接受不会改变其他计划项。

### 2.5 Provider、密钥和出口

- 服务端使用 MODEL_PROVIDER、MODEL_NAME、MODEL_API_BASE_URL 和 MODEL_API_KEY 配置 Pi；不读取用户本机 Pi auth、settings 或 session 文件。
- AI_EGRESS_MODE 只有 local_only 和 allow_cloud 两种值，默认 local_only。
- 不自动从一个 Provider 切换到另一个 Provider；暂时性失败复用同一 Agent run/task attempt。
- 密钥、系统 prompt、完整原文和未脱敏工具结果不进入普通日志、task payload、前端 bundle 或 audit metadata。

## 3. 交付范围

### 3.1 Pi 组合根和领域工具

在 Worker 组合根建立 Pi runtime 适配层，避免 route 模块直接依赖 Pi：

~~~text
apps/worker/src/
  agent/
    runtime.js       # Pi Agent 创建、模型解析、事件映射
    tools.js         # MyKnow 只读领域工具和两个终止工具
    prompts.js       # answer/organize prompt 与版本
    processor.js     # agent task 处理和结果落库
~~~

允许的只读领域工具：

- search_knowledge：在当前快照范围内调用现有 retrieval service。
- read_resource_version：读取指定不可变资料版本的 canonical/定位内容。
- read_raw_chunk：读取选定资料版本的 child chunk 和 parent context。
- read_wiki_page：读取指定 Wiki 页面版本、blocks、citations 和 metadata。
- read_retrieval_run：读取已有检索 trace 和 context snapshot。
- list_wiki_citations：查看页面引用及其完整性状态。

终止工具：

- submit_answer：提交结构化开放回答。
- submit_change_plan：提交结构化 Wiki 变更计划。

禁止向 Pi 注册通用 read、write、edit、bash、PowerShell、web 或任意 SQL 工具。资料和 Wiki 内容以不可信 evidence 传入，不能修改系统 prompt 或获得额外权限。

### 3.2 开放问答链路

~~~text
用户消息
  -> 创建或覆盖本轮范围快照
  -> 创建 chat message + agent:answer task
  -> Worker 启动 Pi Agent
  -> Agent 按需调用 retrieval/read 工具
  -> submit_answer
  -> 服务端校验 evidence、locator、范围和输出大小
  -> 保存回答、trace、metrics
~~~

回答结构至少包含：

~~~json
{
  "answerMarkdown": "...",
  "evidence": [
    {
      "resourceVersionId": "<uuid>",
      "locator": { "chunkId": "<uuid>" },
      "role": "supporting"
    }
  ],
  "modelSupplement": "...",
  "openQuestions": [],
  "evidenceStatus": "used|no_match|index_unavailable|none"
}
~~~

服务端只验证引用对象存在、属于当前范围、locator 合法且来源完整；不把格式校验误当作语义正确性证明。

### 3.3 Wiki 整理链路

~~~text
用户选择资料/Wiki 范围并提交 prompt
  -> 创建 scope snapshot + agent:organize task
  -> Pi Agent 自主读取、检索、比较和规划
  -> submit_change_plan
  -> 服务端验证计划项、引用、locator、base version 和风险
  -> 进入 proposed 审核队列
  -> 用户逐项或批量审核
  -> 每个已接受项独立事务应用
~~~

计划项结构至少包含：

~~~json
{
  "itemType": "page_update",
  "targetPageId": "<uuid>",
  "basePageVersionId": "<uuid>",
  "proposed": {
    "title": "...",
    "pageType": "concept",
    "contentMarkdown": "..."
  },
  "citations": [],
  "risk": "high",
  "evidenceStatus": "valid"
}
~~~

风险由服务端根据 itemType 和 payload 计算，不信任 Agent 自报风险。建议基线为：tag_add=low，page_create=medium，page_update=high，duplicate_finding/conflict_finding=review_only。

tree page item 另外携带 `nodeId`、`parentNodeId`、`nodeRole` 和可选 operation；服务端校验唯一根、父引用、深度、同级标题、页面类型和证据后才进入审核队列。

### 3.4 审核、应用和回滚

- page_update 在一个事务中校验当前页面版本等于 basePageVersionId，写入新 Wiki page version、blocks、citations、link edges 和 audit log。
- page_create 使用现有页面类型、空间和父页面；slug 由服务端生成和校验；系统页 index/log 不可由 Agent 修改。
- tag_add 写入页面级 wiki_page_tags 关联；Sprint 5 不允许 Agent 删除标签或修改资源标签。
- 单个内容项应用成功后，事务提交，再排队 Wiki embedding task；事务失败不产生半成品。
- 标签批量最多 50 项，整批先校验，再以一个事务应用；任一项不合法则整批失败。
- 页面更新回滚仅在当前版本仍等于 appliedPageVersionId 时执行；通过现有 restore 机制创建新版本并标记 rolled_back。
- 新页面回滚使用 archive 语义，不物理删除；若页面已发生后续变更，则返回冲突并要求人工处理。
- duplicate_finding 和 conflict_finding 是审阅记录，不直接修改 Wiki。

### 3.5 持久化模型

新增内容均属于可审计的运行记录或派生数据，不覆盖原始资料：

- agent_runs：run ID、task ID、run kind、知识库、范围快照、prompt hash、prompt/contract version、Provider、模型、出口模式、状态、指标、错误。
- agent_plan_items：运行 ID、item type、目标页面、base version、结构化建议、引用、风险、evidence status、审核状态、应用状态、应用版本、回滚版本。
- agent_events：序号、Pi 阶段/工具事件、工具名、耗时、输入/输出摘要 hash、token/cost 指标、错误；不保存普通日志级原文。
- chat_sessions：会话默认范围、创建/更新时间和状态。
- chat_messages：角色、内容、状态、agent run、task、retrieval run IDs、结构化回答和错误。
- wiki_page_tags：页面与知识库标签的当前关联及创建时间。

审核状态与应用状态分开保存，避免把 proposed、approved、applied、rolled_back、stale 和 apply_failed 压成不可解释的单字段状态。

## 4. REST API 契约

所有接口继续使用现有 data/error/requestId 包装；失败使用稳定错误码。

### 4.1 Agent 整理

POST /api/agent/runs

请求字段：

- knowledgeBaseId：必填 UUID。
- spaceId：可选、必须属于该知识库。
- resourceVersionIds：可选 UUID 数组，使用不可变版本。
- wikiPageIds：可选 UUID 数组，创建任务时解析当前版本。
- retrievalRunId：可选，必须属于同一知识库和空间范围。
- prompt：1-4000 字。

至少提供一个明确的资料版本、Wiki 页面或 retrieval run。响应 202，返回 agentRun 和 task。

GET /api/agent/runs/:id

返回运行状态、范围快照、阶段 metrics、错误和计划计数，不返回密钥或未脱敏系统 prompt。

GET /api/agent/runs/:id/plan

返回计划项及其引用、diff、风险、审核/应用状态。

POST /api/agent/plan-items/:id/decision

请求为 approve 或 reject 及可选 reason。approve 立即触发该项事务应用；过期、缺证据或范围不一致时拒绝。

POST /api/agent/plan-items/batch-decision

只允许对 tag_add 批量 approve/reject，最多 50 项；整批预校验和事务应用。

POST /api/agent/plan-items/:id/rollback

按页面/标签项回滚，执行 optimistic concurrency 校验。

### 4.2 开放聊天

POST /api/chat/sessions

可选创建默认知识库和范围；不选择知识库时代表普通开放聊天。

POST /api/chat/sessions/:id/messages

请求至少包含 content；可以覆盖本轮的 resourceVersionIds、wikiPageIds 或 retrievalRunId。响应 202，返回 user message、pending assistant message、task 和 agentRun。

GET /api/chat/sessions/:id

返回会话元数据和最近 10 条消息；消息上下文最多使用约 12,000 个估算 token。

GET /api/chat/messages/:id

返回助手消息状态、回答结构、引用、evidenceStatus、retrieval run、Agent trace 和错误。

### 4.3 Agent 与聊天的错误

- 输入范围、UUID、prompt、计划 schema 或 locator 不合法：VALIDATION_ERROR。
- Agent 输出无法通过 submit 工具契约：AGENT_OUTPUT_INVALID。
- Provider 暂时性失败：复用 task retry，并记录 attempt。
- Provider 永久失败、超时、取消：任务进入 failed，并保留错误和事件 trace。
- Retrieval index 不可用：回答可以是开放回答，但必须携带 index_unavailable 状态，不得返回空的“已使用库内证据”。

## 5. 运行状态和审计

### 5.1 Task 和 Agent run

沿用 queued、running、succeeded、failed、retrying 五种 task 状态。Agent run 与 task 一对一，重试只增加 task attempt，不创建重复的 run 或助手消息。

同一个 Idempotency-Key 只创建一个 run。Worker 在模型调用完成后，先在事务中写入结构化回答/计划，再结束 task；不会先写 Wiki 再补审计。

### 5.2 Pi 事件映射

至少记录以下脱敏阶段：

- agent_start / agent_end
- turn_start / turn_end
- tool_execution_start / tool_execution_end
- submit_answer / submit_change_plan
- provider_started / provider_finished / provider_failed

事件中保存阶段耗时、工具名称、参数摘要 hash、结果大小、token/cost 指标和错误码。系统 prompt、API key、原始资料全文和完整工具结果不进入普通日志。

## 6. 数据库重建和配置

- schema marker 升级为 sprint5-agent-tree-v1；从 sprint5-agent-review-v1 到树版只追加 Wiki-page citation 表并原地更新 marker。
- 空数据库使用正常 API/Worker 启动路径。
- 旧 Sprint 4 数据库通过精确数据库路径和确认参数重建；保留资源存储、原始资料、资料版本、Wiki 页面版本、引用、审计和已保存 retrieval run。
- retrieval embeddings、wiki FTS、link edges、Agent 运行派生数据按需要重建；重建失败时保留原数据库和存储目录。
- 迁移检查不得复制 API key、Pi auth、完整原文或系统 prompt。
- MODEL_* 与 EMBEDDING_* 配置分离；AI_EGRESS_MODE 默认 local_only。

## 7. Web 交付

继续使用 MyKnow 三栏工作区：

- 左栏：当前会话、知识库/资料范围、Agent 任务和审核计数；Wiki 树显示真实多层父子关系，并可勾选 Wiki 来源。
- 资料来源栏可勾选当前已索引 resource version，整理入口支持选择挂载父页和树模式。
- 中栏：开放聊天消息、模型补充标记、库内引用、Agent 计划项、Markdown diff 和冲突项。
- 右栏：Pi/Agent 阶段、检索 trace、Provider、出口模式、耗时、失败、重试和回滚入口。

聊天和 Agent 任务均使用轮询；Sprint 5 不实现 SSE。任何引用都可以回到 Wiki page version 或 resource version locator preview。

## 8. 两周排期（10 个工作日）

### 第 1 天：契约和 Pi spike

- 锁定包版本、Worker 组合根、模型配置和 AI egress。
- 实现 mock Pi model 的最小 Agent prompt/事件闭环。
- 定义 answer-contract-v1、plan-contract-v1 和稳定错误码。

### 第 2 天：schema 和重建路径

- 增加 agent_runs、agent_plan_items、agent_events、chat_sessions、chat_messages、wiki_page_tags。
- 更新 schema marker、空库初始化和精确数据库重建。

### 第 3 天：范围快照和只读工具

- 实现 explicit scope 校验、版本快照、资料/Wiki read tools 和 retrieval tool。
- 验证跨知识库、未选版本和运行期间新版本不会泄漏。

### 第 4 天：开放回答核心

- 实现 submit_answer、开放回答分区、evidenceStatus、无知识库普通聊天和 Provider 错误。
- 保存 assistant message、retrieval IDs、Agent events 和 metrics。

### 第 5 天：聊天 API 和 Web

- 实现 chat session/message API、异步 task 轮询、重试/取消和三栏聊天展示。
- 完成无知识库与带资料范围的开放聊天 focused check。

### 第 6 天：Wiki 整理计划

- 实现 organize run、submit_change_plan、五类计划项、结构化校验、引用和风险计算。
- 完成 10 份资料的 mock 整理 fixture。

### 第 7 天：审核和页面应用

- 实现逐项 approve/reject、tag_add 批量审核、base version 校验和事务应用。
- 事务提交后排 embedding task；失败不产生部分 Wiki 版本。

### 第 8 天：回滚、事件和安全

- 实现页面/标签回滚、stale/apply_failed 状态、Pi 事件映射、密钥和原文扫描。
- 验证提示注入文本不能扩大权限或改变输出契约。

### 第 9 天：验收 checks 和真实 Provider

- 执行 20 条开放问答 fixture、20 条整理建议评分、重试/幂等/迁移和 Web layout 检查。
- 有可用本地 OpenAI-compatible Provider 时执行真实运行记录；不可用时不阻塞 mock 验收。

### 第 10 天：演示、回归和证据

- 从空数据库跑通导入、检索、开放问答、整理计划、审核、Wiki 版本和回滚。
- 生成 artifacts/sprint5/ 全部证据，更新 README、MVP 计划和技术债 backlog。

## 9. 自动化检查和证据

建议新增：

- scripts/agent-contract.js
- scripts/agent-review-check.js
- scripts/chat-open-check.js
- scripts/agent-provider-check.js
- scripts/agent-rebuild-check.js
- scripts/agent-security-check.js
- scripts/sprint5-check.js

package scripts：

- check:agent：Pi runtime、工具白名单、结构化计划和审核契约。
- check:chat：开放问答、无范围聊天、引用分离、失败和重试。
- check:sprint5：顺序运行 Sprint 5 focused checks、Web build 和语法检查。

artifacts/sprint5/ 至少包含：

- acceptance-report.md
- agent-plan-review.jsonl
- agent-tree.jsonl
- open-chat.jsonl
- agent-events.jsonl
- provider-evidence.log
- migration-rebuild.log
- security-scan.log
- sprint5-layout.png

每个证据文件必须标记运行日期、数据库路径、配置摘要、命令和通过/失败结果；未执行的真实 Provider 检查不能写成通过。

## 10. Sprint 5 验收标准

1. 不选知识库时可以完成开放聊天；不产生伪造 MyKnow 引用。
2. 选定资料或 Wiki 范围后，开放回答能调用检索并把库内证据与模型补充分开显示。
3. 20 条开放问题全部记录回答状态、引用和 evidenceStatus；库内引用无越界/不存在 locator，错误样例有可读失败原因。
4. 至少 10 份资料运行整理任务，只输出计划，不直接改写 Wiki；每条内容建议都有合法来源或 needs_evidence。
5. 拒绝一条、接受一条、批量接受标签后，只有已接受项反映到 Wiki；每项有操作者、时间、request ID、依据和版本审计。
6. 两个冲突来源会生成独立 conflict_finding，要求逐项处理，不能自动合并或覆盖原始资料。
7. 回滚一次页面更新和一次页面标签，页面/标签状态恢复，且产生新的可追踪记录；并发版本不一致时拒绝操作。
8. 20 条整理建议抽样中至少 14 条可直接采纳，达到 70%；评分表记录不可采纳原因。
9. Provider 超时、永久失败、取消、task retry、幂等提交和 Worker 恢复均可回放；密钥和完整原文不出现在响应、普通日志或审计 metadata。
10. 空数据库启动、Sprint 4 数据库安全重建、API/Worker/Web checks 和 artifacts/sprint5 证据全部可复现。
11. 树模式能从显式资料/Wiki 版本生成唯一根、多层父子关系，整支审核事务应用到真实页面 UUID；拒绝分支不创建页面，越界挂载和非法树结构被服务端拒绝。

## 11. 明确延期和技术债

以下项目记录在 SPRINT5_BACKLOG.md，不降低本 Sprint 验收阈值：

- SSE/流式回答和实时 token UI。
- 严格库内问答 mode，包含证据不足拒答和独立引用质量门槛。
- 网页搜索、URL 抓取和其他外部工具。
- 长期记忆、会话搜索、导出和自动摘要。
- 同一整理计划内的跨条目依赖和新页面互链。
- Agent 删除标签、资源标签和自动冲突合并。

## 12. 设计取舍记录

> ponytail：Sprint 5 使用 MyKnow 自己的异步 task 轮询承载 Pi Agent；这是本地单用户 MVP 的简单边界。若未来需要实时交互或多 Worker 并发，再引入 SSE/事件总线和租约队列。

> ponytail：页面变更使用完整 Markdown 而不是 Agent Patch，牺牲少量传输效率换取版本、diff、引用和回滚的一致性；大页面增量编辑留到有明确性能证据后再做。
