# 01 — 双通道关键词检索基线

**What to build:** 用户选择知识库、可选 Wiki 空间并输入 query 后，系统分别返回当前 Wiki 页面结果和当前 raw 资料 child chunk 结果；两组结果拥有独立配额、独立类型和可追踪的检索记录，Web 工作区可以查看结果但不会生成答案。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] query、知识库 ID、Wiki 空间 ID、Top-K 和 context budget 在 API 边界和数据库边界通过校验；raw 检索范围明确展示为整个知识库。
- [ ] Wiki 默认返回 Top-5，raw 默认返回 Top-10；两组结果不互相竞争配额，只使用当前有效 Wiki 版本和当前成功索引的资料版本。
- [ ] 英文 token/stopwords、中文 CJK bigram、OR 召回、全词/短语/标题加分可复现，结果包含命中特征和 locator。
- [ ] 每次检索产生 trace ID 和可持久化 retrieval run；API 响应继续使用现有响应包装，Web 显示 Wiki/raw 两个结果区。
- [ ] 空数据库可以启动；派生索引重建不会删除原始资料、资料版本、Wiki 页面版本或审计记录。
