# 03 — 可选向量召回与关键词降级

**What to build:** 在 Wiki 和 raw 两条检索通道中启用可选向量召回；向量结果只在各自通道内与关键词结果合并。没有 embedding Provider、Provider 超时或生成失败时，用户仍能获得完整的关键词检索结果。

**Blocked by:** 01 — 双通道关键词检索基线

**Status:** ready-for-agent

- [ ] Wiki 页面和 raw child chunk 都可以生成、保存和按当前版本查询向量；向量属于可重建派生数据。
- [ ] Worker 能生成向量，查询只生成 query embedding；mock Provider 可以产生确定性结果，且不调用 completion/chat model 或 Agent。
- [ ] Wiki 和 raw 各自在本通道内用确定性的排名合并方式合并关键词/向量结果，不形成统一 Top-K。
- [ ] 向量关闭、无 key、Provider 超时或 Provider 失败时，API 降级到关键词路径并明确记录原因，不返回静默空结果。
- [ ] trace 和 Web 检查器能区分关键词排名、向量排名、合并结果、Provider、模型、耗时和降级状态。
