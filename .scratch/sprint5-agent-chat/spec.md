# Sprint 5：Pi Agent 开放问答、Wiki 整理与审核回滚

Status: ready-for-agent

## Scope

本 feature 将 Sprint 4 的 retrieval/context 能力接入 Pi Agent runtime，交付开放问答/开放聊天，以及只提出变更计划、经人工审核后写入 Wiki 的整理流程。

Agent 可以自主读取、检索、比较和规划，但只能调用 MyKnow 只读领域工具和两个结构化终止工具：submit_answer、submit_change_plan。任何 Wiki 写入都必须经过计划审核和服务端事务。

开放模式允许模型自身知识与明确选择的 MyKnow 资料共同参与回答，但必须分开呈现。未选择知识库时可以普通开放聊天。严格库内问答、SSE、网页搜索和其他外部工具记录为技术债。

## Domain boundaries

- 原始资料、资料版本、Wiki 页面版本、引用和审计记录不可变或只追加。
- Agent run、chat message、plan item、tool event 是可回放的运行记录。
- page_create、page_update、tag_add、duplicate_finding、conflict_finding 是唯一计划项类型。
- 标签只支持页面级新增和批量审核；不支持 Agent 删除标签或修改资源标签。
- 版本快照、知识库边界和 locator 校验由 MyKnow 服务端负责，不能交给 Pi 或模型决定。

## Ticket order

1. Pi runtime、Provider 配置和安全工具白名单
2. 明确范围、版本快照和只读领域工具
3. 开放聊天、回答契约和 Agent trace
4. Wiki 变更计划、引用校验和风险计算
5. 审核、事务应用、标签和回滚
6. 重试、迁移、Web 工作区和安全检查
7. Sprint 5 验收、证据和技术债登记

## Out of scope

- 严格库内问答和证据不足拒答模式。
- SSE、实时 token streaming 和 Pi Web UI。
- 网页搜索、URL 抓取、任意网络、文件系统、Shell、MCP 外部工具。
- Agent 直接写 Wiki、自动冲突合并、物理删除原始资料。
- 长期记忆、会话搜索/导出、跨计划依赖和多用户权限。
