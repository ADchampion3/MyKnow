# 02 — Wiki 高置信 Seed 与图扩展

**What to build:** 当 Wiki 关键词结果达到高置信条件时，用户可以看到由页面显式链接扩展出的同库 Wiki 相关页面；低置信 Wiki 结果不扩图，raw 结果永远不能启动 Wiki 图遍历。

**Blocked by:** 01 — 双通道关键词检索基线

**Status:** ready-for-agent

- [ ] 图边只来自当前 Wiki Markdown 中显式的 `wiki://UUID` 链接，并能从页面版本重建。
- [ ] 只有通过确定性 seed gate 的 Wiki 页面才扩图；标题/短语命中、归一化分数、排名 margin 和最终判定原因可追踪。
- [ ] 图扩展支持同一知识库内 active 页面的出链和入链，最多 2 hop，每层有数量上限和固定衰减。
- [ ] graph expansion 结果与 Wiki seed 分开返回，不消耗 Wiki seed Top-K；raw 命中不会产生 graph expansion。
- [ ] Web 和 retrieval trace 展示 seed、hop、路径、衰减、去重和范围过滤结果。
