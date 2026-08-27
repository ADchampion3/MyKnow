# 06 — Sprint 4 重建、性能与验收硬化

**What to build:** Sprint 4 的检索能力可以从空数据库启动、从现有数据库安全重建，并通过完整的召回、范围隔离、图扩展、向量降级、预算和性能验收；所有结果生成可复现的 Sprint 4 证据。

**Blocked by:** 05 — 检索 Trace 回放与诊断工作台

**Status:** ready-for-agent

- [ ] 现有数据库升级使用明确的 Sprint 4 schema marker；安全重建保留原始存储、资源、资料版本、Wiki 页面版本、引用和审计记录，只重建派生索引。
- [ ] 20 条带标注查询的目标结果 Recall@10 ≥90%；Wiki/raw 独立配额、低置信不扩图、raw 不扩图和 provenance 不传播反例全部通过。
- [ ] 向量关闭时关键词路径完整通过；mock Provider、无 key、超时和失败降级均有记录。
- [ ] 100 份资料、约 5,000 个 chunk 的本地关键词 + 图扩展 + context assembly P95 ≤2 秒；向量 Provider 耗时单独报告。
- [ ] 生成验收报告、API contract、retrieval trace、graph expansion、context budget、vector、migration rebuild 和 Web layout 证据。
