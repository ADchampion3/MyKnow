# 个人知识库与 AI Agent：MVP Sprint 计划

## 1. 计划基线

- **目标**：交付一个本地优先、单用户可用的完整闭环：导入资料 → 解析/索引 → 选择范围问答 → Agent 提议 Wiki 变更 → 人工审核后写入。当前代码已完成 Sprint 4 的 Page-centric RAG 检索基础；Sprint 5 已完成计划确认，尚待实现。
- **周期**：6 个 Sprint，每个 Sprint 2 周，共 12 周；每个 Sprint 最后半天进行演示、验收和回归。
- **当前可运行输入**：Markdown、TXT、native/OCR PDF；URL 抓取和 Base64 导入不属于当前 contract。当前 Worker 使用本地确定性处理和 mock Provider。
- **后续规划能力**：Sprint 5 交付 Pi Agent 开放问答/开放聊天、Wiki 整理变更计划和人工审核回滚；严格库内问答、SSE 和网页搜索继续留在技术债。URL 快照仍不属于当前输入 contract。
- **明确不做**：多用户协作、实时编辑、原生客户端、自动网页同步、手写 OCR、知识图谱、多 Agent、自训练模型。
- **验收证据**：每项验收都必须留下可复现的测试记录、截图或日志；“通过”以验收人实际操作结果为准，不以代码完成为准。

## 2. 全局定义

### 2.1 角色与状态

- **原始资料层**：导入文件（URL 网页快照属于后续规划），只增不改；更新生成新版本并保留内容指纹、来源和时间。
- **派生知识层**：Wiki、摘要、标签、链接和冲突结果，均保存来源引用、操作者、时间、版本和 diff。
- **任务状态**：`queued`、`running`、`succeeded`、`failed`、`retrying`；前端能看到进度、最近错误和重试入口。
- **Wiki 引用状态**：`active`、`needs_review`、`broken`；资料新版本成功索引后扫描相关引用，无法读取目标或 locator 时标记为 `broken`。
- **Agent 审核与应用状态**：审核状态为 `proposed`、`approved`、`rejected`；应用状态另记录 `applied`、`stale`、`apply_failed`、`rolled_back`。这是 Sprint 5 的规划能力，不是当前代码已交付的写入流程。

### 2.2 每个 Sprint 的通用完成条件

代码合并、自动化测试通过、关键流程有结构化日志、文档/迁移脚本更新、演示环境可从空数据库重复部署。阻塞性缺陷为 0，严重缺陷有明确负责人和修复日期。

## 3. Sprint 计划

### Sprint 1（第 1-2 周）：骨架、数据模型与本地运行

**目标**：建立模块化单体和可演示的三栏工作台骨架，使后续功能有稳定领域边界。

**交付范围**

- Next.js/React 前端、NestJS API、后台 worker、Drizzle + SQLite 初始化。
- 知识库、空间、标签、任务和审计等 Sprint 1 基础表及约束；资料版本、chunk、Wiki 页面和审核计划在后续 Sprint 增量交付。
- 本地文件存储适配器、Provider 接口（嵌入/问答/Agent 分离）、配置校验和密钥不入前端机制。
- 三栏信息架构：左侧知识库树，中间内容区，右侧任务/Agent 区；基础导航和错误边界。

**验收标准**

1. 在全新机器执行 README 中的启动步骤，API、Web、worker 均能启动，健康检查返回 200。
2. 新建知识库、子空间和标签后，刷新页面数据仍存在；空数据库可以按文档启动。
3. 通过浏览器开发者工具和接口响应确认 API 密钥不会出现在 HTML、前端 bundle 或业务表中。
4. 创建一条任务并让 worker 完成/失败各一次；UI 显示状态、进度、错误信息和重试按钮。
5. 主流程页面在 1280px 桌面宽度下三栏不重叠，核心导航可在 1024px 宽度下使用。

**出口证据**：空库部署记录、迁移日志、API contract 测试、密钥扫描结果、三栏页面截图。

### Sprint 2（第 3-4 周）：资料导入、版本与索引流水线

**目标**：可靠接收 Markdown、TXT 和 PDF，形成不可变原始版本，并完成可检索的 FTS5 全文索引。向量索引、URL 抓取和 Base64 导入不属于当前 contract。

**交付范围**

- Markdown/TXT/PDF 上传；PDF 支持显式选择 OCR `auto/off/force` 与 `local/cloud/paddleocr` Provider。URL 抓取和 Base64 导入暂不支持。
- MIME/大小校验、内容指纹去重、版本关系、失败重试和错误日志。
- 原生/OCR 解析、页面/区块结构提取、分块和 SQLite FTS5 全文索引；chunk 关联资料版本、页码范围和定位信息。
- 资料归属多个知识库（引用关系，不复制文件）；标签、导入任务状态和错误信息可查询。

**验收标准**

1. Markdown、TXT、PDF 各准备 3 份样本（含中文、空内容、格式错误）；成功样本在 2 分钟内进入 `indexed`，错误样本进入 `failed` 并给出可读原因。
2. 同一文件重复导入不产生重复原始版本；内容变化后产生新版本，旧版本仍可下载/查看且指纹不同。
3. 一份资料同时加入两个知识库，文件存储只有一份，两个归属关系均可查询和移除。
4. 任一索引 chunk 能反查到资料、版本和 PDF 页码/段落定位；删除/重建派生索引不会删除主数据库记录。
5. 任务中断后点击重试可从最近安全步骤继续，最终状态和错误日志可审计。

**出口证据**：导入验收表、OCR 页面/区块与 Provider 选择、版本链查询结果、chunk 定位抽样（至少 20 个）、任务失败/重试/回滚日志。

### Sprint 3（第 5-6 周）：知识库浏览、Wiki 派生层与版本控制

**状态**：已实现；focused checks、Web build 和 Sprint 3 证据已通过。

**目标**：让用户能浏览原始检索投影和 Wiki 派生投影，并以可回溯方式维护 Wiki 内容。

**交付范围**

- Wiki 默认入口 `index/overview` 和追加式 `log` 系统页；普通页面类型为 `concept`、`entity`、`source-summary`、`synthesis`。
- 页面树、slug、空间和父页面关系；页面元数据可单独修改，页面不能形成父子循环。
- 按页面类型配置默认/自定义模板。模板是 Markdown 初始骨架，包含有序章节、必需性和说明；新页面记录模板版本，不是所有页面统一使用六章节。
- 页面正文以不可变 Markdown 版本保存；从 Markdown 派生稳定 Block，支持版本列表、确定性 diff 和 restore 生成新版本。
- 引用绑定具体 `resourceVersionId` 和 locator，支持来源完整性校验、只读原文下载和文本 locator 预览；原始资料不能修改或删除。
- 知识库默认 Wiki 整理策略；资源可覆盖为 `retrieval-only`，仍可检索但不进入 Wiki 候选。
- 资源版本成功索引后由 Worker 执行确定性影响扫描，生成 `needs_review` 或 `broken` 引用状态及审计记录。
- Web 三栏工作区展示页面树、Markdown 编辑/预览、版本/diff、来源引用、任务状态和影响项，并提供 1280px/1024px/700px 响应式布局。

**验收标准**

1. 从空数据库启动并创建知识库后，默认进入 Wiki `index/overview`；页面树、模板、空间、任务和影响项可查询。
2. 使用四种页面类型创建页面时，初始 Markdown 使用对应模板；模板更新后只影响新页面，历史页面版本保留原模板快照。
3. 对同一页面完成两次编辑，diff 明确标出新增/删除；恢复一次旧版本后生成新版本，历史版本仍保留。
4. 引用始终绑定具体资料版本；有效文本 locator 能预览规范化原文，越界 locator、错误页码和损坏来源被拒绝或标记为 `broken`。
5. 尝试修改或删除原始资料时，UI 和 API 均拒绝，且不改变文件、版本和指纹。
6. `retrieval-only` 资源仍可检索和查看，但不进入 Wiki 整理候选。
7. 资料新版本成功索引后，旧版本引用进入 `needs_review`；Worker 任务、索引状态和审计记录保持一致。
8. 1280px 三栏、1024px 核心导航和 700px 堆叠布局均可使用。

**出口证据**：`artifacts/sprint3/acceptance-report.md`、`wiki-api-contract.log`、`wiki-version-diff.md`、`wiki-citation-evidence.md`、`wiki-impact-scan.log`、`wiki-layout.log`、`wiki-workspace.png` 及对应 focused checks。

### Sprint 4（第 7-8 周）：Page-centric RAG 资料召回与检索

**目标**：先交付不依赖 Agent 和答案生成的 RAG 资料召回、Wiki 图扩展、provenance 查询与 context assembly。

**交付范围**

- Wiki 与 raw 使用独立检索通道和独立 Top-K；Wiki 以页面为主单位，raw 以 child chunk 为主单位。
- 关键词检索支持英文 token/stopwords、中文 CJK bigram、标题/短语加分；向量检索作为可选增强路径。
- 只有高置信 Wiki seed 才能触发同一知识库内显式 Wiki 链接的双向 2-hop graph expansion；raw 永远不能作为 graph seed。
- Wiki → raw 只做 provenance lookup，不把 provenance 当作普通 graph edge，也不自动扩散 raw 内容。
- 以独立预算组装 Wiki 页面和 raw context，记录 query、候选、排序、图扩展、provenance、预算、耗时和失败原因。
- 提供 `POST /api/retrieval/query`、`GET /api/retrieval/runs/:id` 和三栏检索检查器；本 Sprint 不生成答案。

**验收标准**

1. Wiki 和 raw 各自返回独立 Top-K，不互相挤占配额；当前版本和知识库范围过滤正确。
2. 只有高置信 Wiki seed 才能扩展最多 2-hop 的同库 Wiki 图；raw 命中永远不触发图遍历。
3. provenance lookup 不改变 graph 结果；结果可反查 Wiki 页面、资料、资料版本和 locator。
4. 关键词路径支持英文 token、stopwords、中文 CJK bigram、标题加分和 OR 召回；向量关闭或失败时仍可检索。
5. context 的 Wiki/raw 独立预算生效；超预算有 `truncated` 标记，无静默截断。
6. 20 条带标注查询的目标结果 Recall@10 ≥90%，范围泄漏为 0，低置信不扩图和 raw 不扩图反例全部通过。
7. 100 份资料、约 5,000 个 chunk 的本地关键词 + 图扩展 + context assembly P95 ≤2 秒；向量 Provider 耗时单独记录。
8. 每次检索都能通过 trace 回放 query、候选、排序、图扩展、provenance、context、耗时和失败原因。

**出口证据**：`artifacts/sprint4/acceptance-report.md`、`retrieval-api-contract.log`、`retrieval-trace.jsonl`、`graph-expansion.log`、`context-budget.log`、`retrieval-vector.log`、`migration-rebuild.log`、`retrieval-layout.png` 及对应 focused checks。

**明确延期**：开放问答、严格库内问答、completion/chat model 答案生成、Agent runtime、查询改写、自动 wikilink enrichment、Agent 驱动的多资料 Wiki 综合和 raw resource-space 关联。原 MVP 问答门槛保留为后续验收要求，不通过降低阈值完成 Sprint 4。

本句是 Sprint 4 的出口边界；开放问答、completion/chat model 和 Agent runtime 已在本计划的 Sprint 5 重新纳入，严格库内问答和 SSE 仍然延期。

### Sprint 5（第 9-10 周）：Pi Agent 开放问答、Wiki 整理与审核回滚

**状态**：计划已确认，详细契约见 [SPRINT5_PLAN.md](SPRINT5_PLAN.md)；本节描述目标，不代表当前代码已经交付。

**目标**：使用 Pi Agent runtime 交付开放问答/开放聊天，并让 Agent 只提出可审阅的 Wiki 变更，用户审核后才写入。

**交付范围**

- 在 Worker 中使用 Pi Agent SDK；Agent 只能调用 MyKnow 只读领域工具和结构化回答/变更计划终止工具。
- 开放问答支持无知识库普通聊天，也支持明确资料/Wiki 范围的回答；库内证据与模型补充分开显示。
- 整理 Agent 可自主检索、读取、比较和规划，生成 page_create、page_update、tag_add、duplicate_finding、conflict_finding。
- 页面变更使用完整 Markdown 和服务端 diff；引用、locator、范围、base version 和风险由服务端校验。
- 事实改写、页面创建和冲突处理逐项审核；页面标签新增支持最多 50 项批量审核。
- 接受、拒绝、应用、失败、过期和回滚均可审计；应用使用不可变 Wiki 版本和 optimistic concurrency。
- 使用数据库 task 轮询、retry、cancel、恢复和 trace；默认最多 8 轮、32 次工具调用、120 秒。
- 使用 local_only/allow_cloud 出口闸门，默认 local_only；密钥不进前端、task payload、普通日志或业务记录。

**Sprint 5 不纳入**

- 严格库内问答、SSE 流式回答、网页搜索、URL 抓取和其他外部工具。
- Pi 默认会话、文件系统/Shell 工具、Agent 直接写 Wiki、自动冲突合并和原始资料删除。

**验收标准**

1. 20 条开放问题可以完成无知识库聊天或带范围回答；引用不伪造，no_match/index_unavailable 状态可见。
2. 至少 10 份资料运行整理任务，只输出计划，不直接改写 Wiki；缺证据项不可应用。
3. 拒绝、接受、标签批量审核、冲突发现和页面回滚均能通过 Web/API 演示并留下审计链。
4. 20 条整理建议抽样中至少 14 条可直接采纳（≥70%）；失败任务可定位到阶段、Provider 和错误原因。
5. 空库启动、Sprint 4 数据库安全重建、task retry/幂等/取消、API/Worker/Web focused checks 均可复现。

**出口证据**：详见 [artifacts/sprint5/evidence-manifest.md](artifacts/sprint5/evidence-manifest.md)，至少包括开放聊天、计划审核、Pi 事件、Provider、迁移、安全和 Web layout 证据。

**技术债**：详见 [SPRINT5_BACKLOG.md](SPRINT5_BACKLOG.md)。SSE 和严格库内问答不得被当作 Sprint 5 未记录的验收欠账。

### Sprint 6（第 11-12 周）：隐私策略、可观察性、回归与发布硬化

**目标**：补齐安全与运维边界，完成 MVP 规模验证和发布决策。

**交付范围**

- 知识库级“允许云端/仅本地/禁止 AI”策略；资料可进一步收紧；调用取最严格策略。
- Provider 配置、脱敏/拒绝发送、成本与耗时看板；任务日志和检索日志筛选导出。
- 30～50 个真实问题回归集，覆盖重复、冲突、更新、无答案；100 份混合资料压测与恢复演练。
- 安装/升级/备份恢复文档、已知限制、发布检查清单和 MVP 演示脚本。

**验收标准**

1. 对“禁止 AI”资料发起问答/Agent 任务，调用在 API 层被拒绝且无外发请求；“仅本地”只路由到本地 Provider；混合范围按最严格策略执行。
2. 密钥、原文和敏感字段不出现在前端、普通业务日志、错误堆栈或导出的非授权日志中；完成一次密钥轮换验证。
3. 100 份混合资料连续导入、更新、检索无数据丢失；失败任务可重试，主数据库记录和文件可从备份恢复。
4. 回归集包含 30～50 题，关键结论正确引用率 ≥80%；报告列出每个失败样本和处理结论。
5. 发布候选版本在全新环境按文档部署成功，核心 E2E 流程（导入、问答、Agent 审核、回滚）连续跑通 3 次。

**出口证据**：策略隔离测试、密钥扫描/轮换记录、100 份压测报告、回归报告、备份恢复记录、发布候选包。

## 4. MVP 整体验收（发布闸门）

只有以下条件全部满足，MVP 才可标记为“可用”并发布：

> 本节是六个 Sprint 的最终发布门槛，不代表当前 Sprint 3 已全部实现。当前已交付能力以 Sprint 3 小节和 `artifacts/sprint3/acceptance-report.md` 为准；未完成项继续由 Sprint 4-6 交付。

### 4.1 功能闭环

- [ ] Markdown、TXT、PDF（含显式 OCR 模式/Provider）可导入；URL 快照只有在重新纳入输入 contract 后再验收；原始资料不可变，更新保留版本关系和内容指纹。
- [ ] 资料可加入多个知识库/空间；标签、来源、时间、敏感度和任务状态可查看、修改和审计。
- [ ] 解析、分块、FTS5 全文索引（以及 Sprint 4 规划的向量索引）完成后可检索；chunk 可反查来源和位置。
- [ ] 对话发送前展示实际检索范围；严格库内/开放问答均可用，证据不足时明确未知。
- [ ] Agent 只生成可审核变更计划；用户可逐项/批量接受、拒绝，Wiki 支持版本、diff 和回滚。
- [ ] 重复、冲突、更新影响能被标记；禁止删除或覆盖原始资料。

### 4.2 量化门槛

- [ ] 100 份混合资料稳定导入、更新和检索，失败可重试且无数据丢失。
- [ ] 30～50 个真实问题回归集已入库，覆盖重复、冲突、更新、无答案。
- [ ] 回归集关键结论正确引用率 ≥80%。
- [ ] Agent 整理建议直接采纳率 ≥70%。
- [ ] 资料更新后，所有受影响 Wiki 章节/事实/引用均被标记。
- [ ] 单份普通资料从导入到可问答 ≤2 分钟（不含超长外部模型排队）。
- [ ] 用户连续两周完成至少一次真实研究任务，并明确愿意继续使用。

### 4.3 安全、可观察性与质量

- [ ] 云端/本地/禁止 AI 策略按最严格限制执行；禁止 AI 资料无外发请求。
- [ ] API 密钥不进入前端或明文业务数据；模型、检索、任务、审核日志可审计。
- [ ] 阻塞性缺陷为 0；严重缺陷均有发布结论（修复或书面豁免）。
- [ ] 新环境部署、升级、备份恢复均按文档成功；核心 E2E 连续 3 次通过。

## 5. 验收责任与节奏

- **产品负责人**：确认范围、模板、风险级别和最终业务验收。
- **技术负责人**：确认架构、数据不可变性、性能、安全和发布质量。
- **验收人**：每个 Sprint 结束前使用独立测试数据执行验收，记录“通过/不通过/豁免”及证据链接。
- **延期规则**：未满足出口标准的事项进入下一 Sprint 的明确 backlog；不以删除验收项或降低阈值来宣告完成。
