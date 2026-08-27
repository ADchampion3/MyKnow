# 05 — 检索 Trace 回放与诊断工作台

**What to build:** 用户可以通过 trace ID 重新查看一次检索的范围、双通道候选、seed gate、图路径、provenance、最终 context、预算、耗时、Provider 状态和失败原因；诊断页面不会暴露密钥或把敏感原文写入普通日志。

**Blocked by:** 04 — Provenance 与预算化 Context Assembly

**Status:** ready-for-agent

- [ ] retrieval run 可以通过 trace ID 查询，并完整回放 Wiki seeds、raw seeds、graph expansion、provenance lookups 和 final context。
- [ ] Web 三栏工作区分别展示范围、Wiki/raw 结果、图路径、来源定位、预算和阶段耗时。
- [ ] 重放结果保留每一阶段的类型边界，不能把 provenance 误显示为 graph edge，也不能把 raw 结果显示为 Wiki seed。
- [ ] 向量未配置、Provider 超时、低置信 seed、无结果和预算截断都有明确的可读状态。
- [ ] 密钥不会进入 API 响应、retrieval run、前端 bundle、普通日志或错误堆栈。
