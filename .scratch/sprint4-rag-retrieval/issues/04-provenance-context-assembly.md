# 04 — Provenance 与预算化 Context Assembly

**What to build:** 用户可以查看一次检索最终选中的 Wiki 页面、raw chunk、来源版本和 locator；系统按 Wiki/raw 独立预算组装可供后续 LLM 使用的 context，但本 ticket 不生成答案，也不自动通过 citation 扩散 raw 内容。

**Blocked by:** 02 — Wiki 高置信 Seed 与图扩展；03 — 可选向量召回与关键词降级

**Status:** ready-for-agent

- [ ] Wiki 页面命中后可查询资料、资料版本、locator 和完整性状态；provenance lookup 不改变 graph 结果，也不成为 graph edge。
- [ ] Wiki 页面在预算允许时以当前完整 Markdown 加入 context；超大页面改为命中 block 及相邻 block，并明确返回 `truncated` 状态。
- [ ] raw 结果加入 child chunk 和必要的 parent context；raw 正文不会仅因 Wiki citation 存在而自动进入普通 context。
- [ ] Wiki/raw 使用独立预算，默认分配为 60%/40%；`index/overview` 可作为导航上下文，`log` 不进入语料。
- [ ] API、Web 和 trace 同时提供结构化 context items、组装文本、locator、估算 token 数、预算分配和截断项目。
