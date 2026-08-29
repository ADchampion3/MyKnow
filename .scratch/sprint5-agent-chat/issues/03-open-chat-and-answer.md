# 03 — 开放聊天与结构化回答

Type: task
Status: ready-for-agent
Blocked by: 02

**What to build:** 交付无知识库普通开放聊天和带 MyKnow 范围的开放回答；不实现严格库内 mode 和 SSE。

- [ ] 新增 chat sessions/messages 记录和 agent:answer task。
- [ ] 提供创建会话、发送消息、查询会话和查询消息状态的 REST API；发送返回 202、message ID、task ID 和 agent run ID。
- [ ] Agent 可以多次检索和读取，最后必须调用 submit_answer。
- [ ] 回答保存 answerMarkdown、库内 evidence、modelSupplement、openQuestions 和 evidenceStatus。
- [ ] 无知识库时不执行检索、不生成 MyKnow citation；有范围时库内证据与模型补充分离。
- [ ] no_match 和 index_unavailable 显式返回，不能伪装成库内证据。
- [ ] Provider 错误、超时、取消和 retry 可回放；同一用户消息不会生成重复助手消息。
- [ ] 最近 10 条消息或约 12,000 个估算 token作为上下文上限。
