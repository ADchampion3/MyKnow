# Sprint 4：Page-centric RAG 资料召回与检索

**来源**：[SPRINT4_PLAN.md](../../SPRINT4_PLAN.md)

## Scope

本 feature 交付不依赖 Agent 和答案生成的 RAG 检索链路：Wiki/raw 双通道独立 Top-K、关键词召回、可选向量召回、高置信 Wiki seed、同库显式 Wiki 图双向 2-hop、provenance lookup、独立预算的 context assembly 和可回放 retrieval trace。

Wiki 页面是 Page-centric 检索单位，raw 资料是 child chunk 检索单位。raw 永远不能作为 Wiki graph seed；Wiki → raw 只做 provenance lookup，不作为 graph edge。向量关闭或 Provider 失败时，关键词路径必须继续可用。

开放问答、严格库内问答、completion/chat model、Agent runtime、自动 wikilink enrichment、Agent 驱动的多资料 Wiki 综合和 raw resource-space 关联不属于本 feature。

## Ticket order

1. 双通道关键词检索基线
2. Wiki 高置信 Seed 与图扩展
3. 可选向量召回与关键词降级
4. Provenance 与预算化 Context Assembly
5. 检索 Trace 回放与诊断工作台
6. Sprint 4 重建、性能与验收硬化
