# Sprint 4 计划：Page-centric RAG 资料召回与检索

## 1. 计划定位

Sprint 4（第 7-8 周）先交付可复现、可审计的 RAG 资料召回与检索链路，不交付答案生成。

本 Sprint 参考 `llm_wiki` 的 Page-centric 模型，但适配当前项目已有的 SQLite Wiki 投影、稳定页面 ID、`wiki://UUID` 链接、原始资料版本和 child chunk。Wiki 内容继续由数据库保存，不引入 `wiki/` 文件目录，也不要求查询时扫描多个原始文件。

检索链路为：

```text
用户 query
├─ Wiki 通道：关键词/可选向量 → 独立 Wiki Top-K
│              → 高置信 Wiki seed → 显式 Wiki 图双向 2-hop
└─ raw 通道： 关键词/可选向量 → 独立 raw Top-K

Wiki 结果 → provenance lookup（不作为 graph edge）
        → 双通道预算控制
        → context assembly
```

检索运行时不依赖 Agent。Agent 只在后续查询改写、答案生成、自动补充 wikilink 或 Wiki 变更提议时引入。

## 2. 已确认的产品决策

### 2.1 双通道检索

- Wiki 与 raw 使用独立的 Top-K，不直接竞争一个统一 Top-K。
- 默认 Wiki Top-5，raw Top-10；每个通道单独校验，上限为 20。
- Wiki 通道返回当前 active Wiki 页面；raw 通道返回当前成功索引的资料版本 child chunk。
- raw 命中永远不能作为 Wiki graph traversal 的 seed。
- 只有高置信 Wiki seed 才允许触发图扩展；低置信 Wiki 结果仍可以进入 context，但不扩图。
- 向量检索是可选增强路径；关闭向量时，关键词检索和图扩展仍必须完整可用。

### 2.2 Wiki 图和 provenance

- 图关系只来自当前 Wiki Markdown 中显式存在的 `wiki://UUID` 链接。
- 图扩展使用同一知识库内 active 页面，支持出链和入链，最多 2 hop。
- 每层最多扩展 10 页，hop 1 和 hop 2 的初始衰减分别为 `0.5` 和 `0.25`。
- graph expansion 不消费 Wiki seed 的 Top-K 配额，结果单独记录和排序。
- raw chunk 不作为图节点，不启动图遍历。
- Wiki → raw 只允许做 provenance lookup，返回资料、资料版本、locator 和完整性状态；provenance 不视为普通 graph edge，也不会自动带出 raw 正文。
- raw 正文只有在 raw 通道命中或用户主动展开 provenance 时读取。

### 2.3 范围和版本

- `knowledgeBaseId` 必填，所有结果必须属于该知识库。
- `spaceId` 只过滤 Wiki 页面；当前没有 raw resource-space 关联，因此 raw 仍按整个知识库检索，UI 必须明确展示这一边界。
- 只检索当前有效 Wiki 页面版本和每份资料的当前成功索引版本；历史版本查询不属于本 Sprint。
- `index/overview` 只作为小型导航上下文，`log` 不作为检索语料。

## 3. 交付范围

### 3.1 关键词召回

- 对英文文本进行 token 化和 stopwords 处理。
- 对中文查询生成 CJK bigram。
- 多词查询使用 OR 召回，同时对全词命中、短语命中和标题命中加分。
- 保留原有 raw `resource_fts`，新增按页面建立的 Wiki FTS 派生索引。
- 关键词结果包含可解释的命中特征、通道类型和排名。

### 3.2 可选向量召回

- 定义窄的 Embedding Provider 接口，不引入 Agent 或 completion/chat model。
- Wiki 页面和 raw child chunk 都可以建立向量。
- Worker 在 Wiki 页面版本或资料索引完成后生成向量；查询时只生成 query embedding。
- 关闭向量、Provider 未配置、Provider 超时或 Provider 失败时，降级到关键词路径。
- 先将归一化向量保存为 SQLite 派生数据并执行有上限的 cosine 扫描。

> ponytail：SQLite 内的有上限向量扫描适合当前单用户 MVP；向量规模或并发超过本地验证上限后，再替换为 ANN 存储，不改变 retrieval service 契约。

### 3.3 合并、seed gate 和图扩展

- Wiki 通道内部独立合并关键词排名和向量排名；raw 通道同样独立合并。
- 使用确定性的 RRF 合并，不使用 LLM reranker。
- 高置信 Wiki seed 使用标题精确命中、短语命中、归一化分数和相邻排名 margin 判定。
- 初始配置为 `wikiSeedMinScore=0.70`、`wikiSeedMinMargin=0.10`；是否扩图及各项特征必须写入 trace。
- Wiki graph 仅从通过 gate 的 Wiki seed 启动；图结果使用固定衰减并按页面 ID 稳定打破平局。
- 页面、raw chunk、graph result 和 provenance lookup 在返回值中保持独立类型，禁止扁平化后丢失来源。

### 3.4 Context assembly

- Wiki 和 raw 使用独立 context budget，默认分配为 60% Wiki、40% raw。
- Wiki 页面未超预算时加入当前页面完整 Markdown；raw 结果加入 child chunk 及必要的 parent context。
- 大页面超预算时，优先保留命中 block 和相邻 block，返回 `truncated=true`；不能静默截断 Markdown。
- context 中携带页面、资料、版本、locator、graph path 和 provenance 元数据。
- 返回最终组装文本和结构化 context items；本 Sprint 不把 context 交给 completion/chat model。
- token 先使用确定性的字符/token 估算，并记录估算值。

> ponytail：当前没有 Provider tokenizer，先使用保守的代码点估算；未来接入实际模型时，再按模型 tokenizer 替换估算器。

## 4. 数据和索引设计

新增内容均为可重建派生数据，不能覆盖原始资料、资料版本、Wiki 页面版本或审计记录。

### 4.1 `wiki_fts`

按当前 Wiki 页面版本建立 FTS5 页面索引，至少保存：

- `page_id`
- `page_version_id`
- `title`
- 页面检索文本

页面是检索和最终 context 的主单位；block key 作为命中定位和展示信息，不把 Wiki 强制拆成 raw 风格的独立 chunk。

### 4.2 `wiki_link_edges`

由当前页面 Markdown 的显式 `wiki://UUID` 链接派生：

- `source_page_id`
- `source_page_version_id`
- `target_page_id`
- `link_text`

只保存同一知识库内、目标存在的页面关系。页面版本变化时重建对应边；整库重建可以从当前页面版本重新生成。

### 4.3 `retrieval_embeddings`

统一保存 Wiki 页面和 raw child chunk 的向量元数据：

- owner 类型和 owner ID
- 对应页面版本或资料处理版本
- Provider、模型、维度和向量数据
- `ready` / `failed` 状态及错误信息
- 创建和更新时间

向量行属于派生索引，Provider 或模型变化时允许整体重建。

### 4.4 `retrieval_runs`

每次检索保存可回放 trace：

- query、知识库和空间范围
- Wiki/raw Top-K 和 context budget
- Wiki seeds、raw seeds、graph expansion
- provenance lookups
- 最终 context items 和组装快照
- 关键词/向量开关、排名特征、耗时、Provider 指标和失败原因

密钥不得进入数据库、响应或日志；原文不写入普通 console/audit 日志，只有按需生成的 context snapshot 保存到 retrieval run。

## 5. REST API 契约

所有响应继续使用现有 `{ data, error, requestId }` 包装。

### 5.1 发起检索

`POST /api/retrieval/query`

请求：

```json
{
  "knowledgeBaseId": "<uuid>",
  "spaceId": "<uuid>",
  "query": "<1-200 characters>",
  "wikiTopK": 5,
  "rawTopK": 10,
  "contextBudgetTokens": 8000
}
```

其中 `spaceId` 可选；`wikiTopK`、`rawTopK` 和 `contextBudgetTokens` 经过服务端上下限校验。向量是否启用由服务端配置决定，不由客户端任意打开。

响应至少包含：

```json
{
  "traceId": "<uuid>",
  "scope": {
    "knowledgeBaseId": "<uuid>",
    "spaceId": "<uuid>",
    "rawScope": "knowledge_base"
  },
  "wiki": {
    "seeds": [],
    "graphExpanded": []
  },
  "raw": {
    "results": []
  },
  "provenance": [],
  "context": {
    "items": [],
    "markdown": "",
    "estimatedTokens": 0,
    "truncated": false
  },
  "metrics": {}
}
```

### 5.2 查看检索 trace

`GET /api/retrieval/runs/:id`

用于 Web 检索检查器和审计回放。trace 必须保留 Wiki/raw/graph/provenance 的类型边界。

### 5.3 错误和降级

- query、ID、Top-K 和 budget 不合法：`VALIDATION_ERROR`
- 知识库或空间不存在：`NOT_FOUND` 或范围错误
- 向量 Provider 超时/无 key：记录在 trace，关键词路径继续返回
- FTS 派生索引不可用：返回明确的 `RETRIEVAL_INDEX_UNAVAILABLE`，不能静默返回空结果

## 6. 索引生命周期和迁移

### 6.1 页面保存

页面版本、Wiki blocks、Wiki FTS 行和 link edges 在同一个 API 事务中提交。提交后排队向量任务；向量失败只影响向量路径。

### 6.2 资料索引

现有资料 Worker 在成功索引 child chunks 后排队 embedding 任务。raw FTS 的 build-then-swap 行为保持不变；embedding 失败不能撤销已经成功的 raw FTS。

### 6.3 数据库重建

- 新 schema marker 使用 `sprint4-rag-retrieval-v1`。
- 旧数据库必须通过精确路径和确认参数重建。
- 保留原始存储、知识库、空间、资源、资料版本、Wiki 页面版本、引用和审计记录。
- 重建 `wiki_fts`、`wiki_link_edges`、`retrieval_embeddings` 和 retrieval 派生记录。
- 无 embedding Provider 时重建仍成功，关键词 + 图检索仍可用。
- 重建失败时保留原数据库和原始存储对象。

## 7. Web 交付

在现有三栏工作区增加检索检查器，不显示答案生成界面：

- 左栏：知识库、Wiki 页面和空间范围；明确 raw scope 仍为整个知识库。
- 中栏：Wiki 独立结果、raw 独立结果、graph expansion 和最终 context。
- 右栏：关键词/向量排名、seed gate、graph path、provenance、预算和耗时 trace。

所有结果可以点击回 Wiki 页面版本、资料版本和 locator。没有结果、向量失败、低置信 seed 和预算截断都必须有明确状态。

## 8. 两周排期（10 个工作日）

### 第 1 天：范围和契约

- 锁定双通道结果、Top-K、seed gate、graph/provenance 边界。
- 定义 API DTO、错误码、trace 字段和配置上下限。

### 第 2 天：schema 和派生索引

- 增加 `wiki_fts`、`wiki_link_edges`、`retrieval_embeddings`、`retrieval_runs`。
- 更新空库初始化、schema marker 和安全重建检查。

### 第 3 天：关键词检索

- 实现英文 token/stopwords、中文 CJK bigram 和标题/短语加分。
- 实现 Wiki page FTS 和 raw FTS 的独立查询。

### 第 4 天：双通道检索 API

- 实现 `POST /api/retrieval/query`。
- 保持 Wiki/raw 独立 Top-K 和独立结果结构。

### 第 5 天：向量可选路径

- 实现 Embedding Provider seam、mock Provider 和 SQLite 向量存储。
- 验证无 Provider、超时和失败时的关键词降级。

### 第 6 天：seed gate 和 Wiki 图

- 实现高置信判定、显式 link edge、双向 2-hop、衰减和去重。
- 验证 raw 结果永远不能触发图扩展。

### 第 7 天：provenance 和 context assembly

- 实现 citation provenance lookup。
- 实现独立 60/40 budget、整页/邻近 block 选择、parent context 和 truncation 标记。

### 第 8 天：trace 和 Web 检查器

- 实现 `GET /api/retrieval/runs/:id`。
- 完成三栏检索结果、graph、provenance 和预算展示。

### 第 9 天：focused checks 和性能

- 执行 20 条标注查询、范围隔离、图扩展、向量降级和预算测试。
- 在 100 份资料、约 5,000 个 chunk 上执行本地检索性能检查。

### 第 10 天：验收和证据

- 运行 API、Worker、Web build、数据库重建和全部 focused checks。
- 生成 `artifacts/sprint4/` 证据并更新 README、MVP 计划和延期 backlog。

## 9. 自动化检查和证据

新增或扩展：

- `scripts/retrieval-contract.js`
- `scripts/retrieval-graph-check.js`
- `scripts/retrieval-budget-check.js`
- `scripts/retrieval-vector-check.js`
- `scripts/retrieval-performance-check.js`
- 现有 `npm run check:all`
- Web build、API/Worker `node --check`

`artifacts/sprint4/` 至少包含：

- `acceptance-report.md`
- `retrieval-api-contract.log`
- `retrieval-trace.jsonl`
- `graph-expansion.log`
- `context-budget.log`
- `retrieval-vector.log`
- `migration-rebuild.log`
- `retrieval-layout.png`

## 10. Sprint 4 验收标准

1. Wiki 与 raw 各自返回独立 Top-K，不互相挤占配额。
2. 只有高置信 Wiki seed 可以触发最多 2-hop 的同库 Wiki 图扩展。
3. raw 结果永远不会启动 Wiki 图遍历；provenance lookup 不改变图结果。
4. 关键词路径支持英文 token、stopwords、中文 CJK bigram、标题加分和 OR 召回。
5. 向量关闭或 Provider 失败时，关键词 + 图扩展仍可用。
6. 所有结果可反查 Wiki 页面、资料、资料版本和 locator；历史版本和跨知识库结果不会混入。
7. context 的 Wiki/raw 独立预算严格生效；超预算有 `truncated` 标记，无静默截断。
8. 20 条带标注查询的目标结果 Recall@10 ≥90%；范围泄漏为 0；raw 不扩图和低置信不扩图反例全部通过。
9. 100 份资料、约 5,000 个 chunk 的本地关键词 + 图扩展 + context assembly P95 ≤2 秒；向量 Provider 耗时单独记录。
10. 每次检索都能通过 trace 回放 query、候选、排序、图扩展、provenance、context、耗时和失败原因。

## 11. 明确延期

- 开放问答和严格库内问答。
- completion/chat model 答案生成。
- Agent runtime、查询改写和自动 wikilink enrichment。
- 由 Agent 读取多个资料后综合 Wiki 或提出 Wiki 变更。
- raw resource-space 关联和按空间过滤 raw 资料。
- 网页搜索、URL 抓取和多用户协作。

这些能力不能通过降低 Sprint 4 的召回、范围隔离或 trace 验收门槛来提前宣告完成。
