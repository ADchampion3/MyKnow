# Sprint 5 backlog / 技术债

这些事项从 Sprint 5 明确延期，不是隐藏的验收欠账；后续 Sprint 必须单独定义契约和验收阈值。

## 01 — SSE 流式回答

Status: needs-triage

为开放聊天增加 SSE 或等价的事件流，把 Pi 的 turn/tool/provider 事件以安全的增量状态推送到 Web。需要重新定义断线重连、重复 token、取消、代理超时和最终消息幂等。

当前 Sprint 5 使用 Worker task + 轮询，最终回答完成后一次性保存。

## 02 — 严格库内问答

Status: needs-triage

新增显式 strict mode：回答只能使用选定知识库证据；证据不足时必须拒答或明确未知。需要独立的 prompt、证据覆盖率/引用正确率数据集、无命中行为和 UI 范围确认验收。

当前 Sprint 5 只有 open mode；开放回答中的模型补充不能被误标为库内证据。

## 03 — 网页搜索和外部工具

Status: needs-triage

在明确隐私和出口策略后，再考虑网页搜索、URL 抓取或其他外部工具。必须重新评估提示注入、来源可信度、云端外发和审计范围。

## 04 — 长期记忆与会话管理

Status: needs-triage

长期记忆、会话搜索、导出、自动摘要和跨会话上下文留到后续设计；当前只保留最近有限消息窗口。

## 05 — 整理计划高级依赖

Status: needs-triage

同一计划内的跨条目依赖、新页面互链、自动冲突合并、Agent 删除标签和资源标签变更暂不支持。
