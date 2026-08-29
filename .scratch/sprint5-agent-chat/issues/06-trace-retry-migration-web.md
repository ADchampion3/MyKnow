# 06 — Trace、重试、迁移与三栏工作区

Type: task
Status: ready-for-agent
Blocked by: 03, 05

**What to build:** 把 Pi/检索/任务/审核状态接入可回放 trace、schema 重建和 MyKnow 三栏 Web 工作区。

- [ ] agent_events 保存阶段、工具、Provider、耗时、token/cost 和错误摘要，不保存密钥、系统 prompt 或普通日志级原文。
- [ ] task retry 复用同一 agent run 和助手消息；Idempotency-Key 复用同一 run。
- [ ] schema marker 升级为 sprint5-agent-tree-v1；从 sprint5-agent-review-v1 原地追加 Wiki-page citation 表，精确数据库重建保留原始资料、Wiki 版本、引用、审计和 retrieval run。
- [ ] 新增 chat、Agent 计划、diff、引用、错误、重试和回滚 API/Web 展示。
- [ ] 左栏显示范围和任务，中栏显示聊天/计划/diff，右栏显示 Pi/检索 trace 和 Provider 状态。
- [ ] 左栏 Wiki 树显示真实多层层级，资料/Wiki 来源可显式勾选，整理计划显示树节点、挂载点和分支审核入口。
- [ ] Sprint 5 使用轮询，不实现 SSE；strict mode 和 SSE 链接到技术债 backlog。
- [ ] Web layout、API error wrapper、密钥扫描和 Worker 恢复检查通过。
