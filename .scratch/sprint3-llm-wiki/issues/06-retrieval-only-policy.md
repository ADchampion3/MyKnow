# 06 — 资料 Wiki 参与策略与 retrieval-only

**What to build:** 知识库默认允许资料参与 Wiki 整理，但单份资料可以覆盖为 `retrieval-only`；该资料仍可查看、全文检索和后续向量检索。

**Blocked by:** 01 — Sprint 3 Wiki schema 与数据保留重建

**Status:** ready-for-agent

- [ ] 知识库默认策略为 `wiki-enabled`。
- [ ] 资料可以继承知识库策略，或明确设置为 `wiki-enabled` / `retrieval-only`。
- [ ] `retrieval-only` 资料不会进入 Wiki 整理候选。
- [ ] `retrieval-only` 资料仍保留现有搜索和资料详情路径。
- [ ] 策略状态在 API、资料列表和 Wiki 候选视图中一致。
- [ ] 策略变化有审计记录，刷新后不会丢失。
- [ ] focused check 证明策略不会删除或改变原始资料和检索索引。
