# MyKnow 检索机制

本文档记录当前已经实现的 Page-centric RAG 检索链路。实现的事实来源是 [`packages/db/src/retrieval.js`](../packages/db/src/retrieval.js)、[`packages/db/src/embeddings.js`](../packages/db/src/embeddings.js)、API/Worker 路由和 Sprint 4 规格；如果本文档与代码不一致，以代码和可复现检查为准。

当前检索的目标是返回可解释、可回链、可审计的证据，不生成答案，也不调用 Agent 或 completion/chat model。当前 schema marker 为 `sprint4-rag-retrieval-v1`。

## 1. 端到端流程

```text
POST /api/retrieval/query
        |
        v
请求校验 + knowledge base / space 范围校验
        |
        +--> 查询规范化、英文 token/stopword、CJK bigram
        |
        +--> Wiki FTS ------------------+
        |                               |
        +--> raw child FTS -------------+--> 可选 query embedding
                                        |
                                        v
                              各通道独立 RRF 合并
                                        |
                                        v
                              Wiki seed confidence gate
                                        |
                        +---------------+---------------+
                        |                               |
                        v                               v
                 Wiki graph expansion            provenance lookup
                        |                               |
                        +---------------+---------------+
                                        |
                                        v
                               context assembly
                                        |
                                        v
                             persist retrieval trace
                                        |
                                        v
                                   API response

GET /api/retrieval/runs/:id
        |
        v
                         trace replay（raw 结果只返回元数据）
```

检索实现位于 DB 包，API 只负责 HTTP 合同和错误包装；Worker 负责生成派生 embedding。这样 Web、API 和 Worker 使用同一套检索领域规则。

## 2. API 合同与范围

### 2.1 发起检索

`POST /api/retrieval/query`

请求字段：

| 字段 | 必填 | 默认值 | 约束 |
|---|---:|---:|---|
| `knowledgeBaseId` | 是 | - | UUID；必须指向 active knowledge base |
| `spaceId` | 否 | `null` | UUID；必须属于该 knowledge base 的 active space |
| `query` | 是 | - | NFKC 规范化后 1–200 个字符 |
| `wikiTopK` | 否 | `5` | 整数 1–20 |
| `rawTopK` | 否 | `10` | 整数 1–20 |
| `contextBudgetTokens` | 否 | `8000` | 整数 1–50000 |

请求体必须是对象；空 JSON、非法 ID、非法 Top-K 或 budget 返回 `400 / VALIDATION_ERROR`。不存在的知识库或空间返回 `NOT_FOUND`。

### 2.2 结果范围

- Wiki 通道只检索当前 active Wiki 页面版本，排除 `index` 和 `log` 系统页。
- `spaceId` 只过滤 Wiki 通道。
- raw 通道检索整个 knowledge base，因为当前资源还没有 resource-space 关联；trace 中固定记录 `rawScope: "knowledge_base"`。
- raw 通道只使用当前资源版本、当前成功 processing run、active 的 `text` child chunk。
- 历史版本和 superseded chunk 不进入当前检索。

主要响应结构：

```json
{
  "traceId": "<uuid>",
  "scope": {
    "knowledgeBaseId": "<uuid>",
    "spaceId": "<uuid>",
    "rawScope": "knowledge_base"
  },
  "wiki": { "seeds": [], "graphExpanded": [] },
  "raw": { "results": [] },
  "provenance": [],
  "context": {
    "items": [],
    "markdown": "",
    "estimatedTokens": 0,
    "truncated": false
  },
  "vector": {},
  "metrics": {}
}
```

## 3. 关键词检索

### 3.1 查询规范化

[`packages/db/src/text-tokenizer.js`](../packages/db/src/text-tokenizer.js) 提供共享的文本扫描逻辑：

- Unicode NFKC 规范化、大小写和空白规范化由 retrieval 层完成。
- 英文/数字词进入 `words`。
- 连续 CJK 字符生成相邻二元组，例如 `发布流程` 生成 `发布`、`布流`、`流程`。
- 查询中的英文 stopwords 会被移除，但会记录在 trace 的 `keyword.stopwords` 中。
- 多词查询使用 OR 召回，不要求每个词都命中。
- FTS 查询对每个 term 做引号转义后用 `OR` 连接。

索引文本通过 `searchableText()` 生成，包含原始文本、英文 token 和 CJK bigram，保证查询和建索引使用同一套 token 规则。

### 3.2 两个 FTS 通道

Wiki 结果来自 `wiki_fts`，索引单位是当前 Wiki 页面版本，结果包含：

- 页面 ID、页面版本 ID、标题、slug 和 page type。
- 当前页面内容的 snippet。
- 命中的 block keys，作为 Wiki locator。
- keyword score 和可解释的 `matchedFeatures`。

raw 结果来自已有的 `resource_fts`，索引单位是 child chunk，结果包含：

- chunk、resource、resource version、processing run ID。
- child content、parent context、context header。
- start/end offset 和完整 locator。
- keyword score 和可解释的 `matchedFeatures`。

当前 FTS 候选读取上限为 Wiki 200 行、raw 400 行，之后再在应用层计算和排序；最终结果仍受请求的各自 Top-K 限制。

### 3.3 可解释评分

每个页面或 raw chunk 都使用同一个归一化评分模型：

```text
score = min(1,
  0.40 × term coverage
  + 0.20 × title coverage
  + 0.25 × phrase hit
  + 0.15 × full-text hit
)
```

trace 会保留：

- 所有 query terms。
- `matchedTerms` 和 `missingTerms`。
- 标题命中、短语命中、全词命中。
- `coverage`、`titleCoverage` 和归一化分数。

Wiki 和 raw 首先分别完成关键词排序，彼此不共享 Top-K 配额。

## 4. 可选向量检索

### 4.1 Provider 和派生数据

[`packages/db/src/embeddings.js`](../packages/db/src/embeddings.js) 定义窄的 embedding provider 接口。当前内置 deterministic mock provider 和 OpenAI-compatible HTTP provider：

- 默认 provider：`mock`。
- 默认 model：`mock-hash-v1`。
- 默认维度：32；合法范围为 4–4096。
- 使用 token 的 SHA-256 hash 生成并归一化向量，不需要 API key。
- `openai-compatible`（也接受 `openai`）向配置的 `/embeddings` 端点发送 `{ model, input, dimensions }`，兼容本地 vLLM/OpenAI-compatible 服务；返回向量必须是 4–4096 个有限数字。Provider 记录实际返回维度，检索只合并相同维度的派生向量；某些服务会忽略请求中的 `dimensions`，不会被客户端静默截断。
- 使用 cosine similarity 排序。

`retrieval_embeddings` 是可重建的派生表，支持两类 owner：

- `wiki_page`：绑定 `page_version_id`。
- `raw_chunk`：绑定 `resource_version_id` 和 `processing_run_id`。

向量行有 `ready` / `failed` 状态，并记录 provider、model、dimensions 和错误摘要。原始材料、版本、processing run 和 audit log 不依赖向量行的存在。

### 4.2 生成时机

- Wiki 页面版本保存成功后，API 排队 Wiki page embedding task。
- 资源成功索引 child chunks 后，Worker 排队 raw chunk embedding task。
- Worker 启动时扫描当前有效页面和 raw chunks，只为没有 ready embedding 的对象补排队。
- 同一批次使用 embedding task cache；已有 active task 或 ready embedding 不重复创建。

### 4.3 查询时合并

向量开启时，API 只生成一次 query embedding，然后分别扫描当前范围内 ready 的 Wiki/raw embedding。关键词结果和向量结果在每个通道内部使用 Reciprocal Rank Fusion 合并：

```text
RRF = 1 / (60 + keyword rank) + 1 / (60 + vector rank)
```

最终分别截取 Wiki `wikiTopK` 和 raw `rawTopK`。

以下情况不会阻断关键词检索：

| 情况 | trace 中的 vector 状态 | 结果行为 |
|---|---|---|
| `RETRIEVAL_VECTOR_ENABLED=false` | `disabled` | 只走关键词和 graph |
| provider 超时 | `degraded` + `EMBEDDING_TIMEOUT` | 只走关键词和 graph |
| provider 失败 | `degraded` + `EMBEDDING_FAILED` | 只走关键词和 graph |
| provider 未配置 | `degraded` + `EMBEDDING_PROVIDER_UNAVAILABLE` | 只走关键词和 graph |
| 没有 ready 向量 | `no_embeddings` | 保留关键词结果 |

配置入口：

```text
RETRIEVAL_VECTOR_ENABLED=true|false
EMBEDDING_PROVIDER=mock|openai-compatible|timeout|failed|...
EMBEDDING_MODEL=mock-hash-v1
EMBEDDING_DIMENSIONS=32
EMBEDDING_FAILURE_MODE=timeout|failed
EMBEDDING_API_BASE_URL=http://localhost:9000/v1/embeddings
EMBEDDING_API_KEY=
```

`EMBEDDING_API_BASE_URL` 可以填写完整的 `/embeddings` URL，也可以填写 API base URL（例如 `http://localhost:9000/v1`），Provider 会补上 `/embeddings`。真实模型检查会请求 `qwen3-embedding-8b` 和 1024 维；如果服务忽略该参数，检查会同时报告实际返回维度，不改变常规 mock 检查：

```powershell
npm run check:retrieval-real
```

当前向量实现是 SQLite 有上限扫描，适合本地单用户 MVP。`retrieval.js` 中的 `ponytail:` 注释记录了规模超过本地上限后引入带身份索引或 ANN 存储的升级路径。

## 5. Wiki seed gate 与 graph expansion

### 5.1 Seed gate

Wiki 关键词/向量合并后，所有 Wiki 结果都会带 `seedGate`，但只有高置信结果能启动 graph：

```text
keywordScore >= 0.70
且当前结果分数 - 下一名结果分数 >= 0.10
```

gate 会记录：

- `minScore`、`minMargin`。
- 当前分数、相邻结果分数和 margin。
- `high_confidence`、`score_below_min` 或 `margin_below_min` 原因。

低置信 Wiki 结果仍可以进入 context，但不会扩图。

### 5.2 Link projection

当前 Wiki 页面版本中的显式 `wiki://UUID` 链接会写入 `wiki_link_edges`。支持：

- Markdown link：`[Checklist](wiki://<uuid>)`。
- 裸链接：`wiki://<uuid>`。
- 只保留同一 knowledge base 内存在、未归档、非系统页的目标。
- 页面版本变化时重建该页面的 FTS 行和出边。

raw chunk 永远不会成为 graph 节点，也不会触发 graph traversal。

### 5.3 Expansion 规则

- 只从通过 gate 的 Wiki seed 开始。
- 支持 outbound 和 inbound 两个方向。
- 最多 2 hop。
- hop 1 decay 为 `0.5`，hop 2 decay 为 `0.25`。
- 每层最多选 10 个页面。
- 同一页面只保留最佳路径，结果按 score、page ID 稳定排序。
- 只允许同一 knowledge base 的 active 页面。
- 指定 `spaceId` 时，graph 目标也必须属于该 space。
- graph expansion 不占用 Wiki seed 的 Top-K 配额，单独记录在 `graphExpanded`。

每个 graph 结果保留 `hop`、`decay`、`seedPageId`、`path` 和 `graphPath`，方便在 Web 和 trace 中解释为什么被带入。

## 6. Provenance lookup

Provenance 只针对 Wiki seed 和 graph 页面做 lookup，不把 citation 当作 graph edge。

对页面当前版本的 citation，系统返回：

- citation、Wiki page/version ID。
- resource/resource version ID 和标题。
- locator。
- citation status 和 stale reason。
- source integrity：`valid`、`invalid` 或 `unavailable`。
- `complete`、`unavailable`、`needs_review` 或 `broken` 等 completeness。

Provenance 默认只返回来源元数据，不自动把 raw 正文带入 Wiki 结果；用户命中 raw 通道或主动展开来源时才读取原文。

## 7. Context assembly

### 7.1 预算

总预算按固定比例划分：

```text
Wiki budget = floor(total × 0.60)
Raw budget  = total - Wiki budget
```

Wiki 与 raw 的预算互不争抢。结果顺序为 Wiki seeds、Wiki graph、raw results；同一 Wiki 页面只加入一次。

### 7.2 Wiki context

在页面内容未超预算时，加入标题和完整当前 Markdown。超预算时：

1. 找出命中 query term 的 block。
2. 优先保留命中 block 及前后相邻 block。
3. 使用确定性的字符/token 估算器裁切。
4. 记录 `truncated=true` 和 `truncatedItems`，不静默截断。

每个 Wiki context item 保留 page/version、locator、graph path、文本、估算 token 数和 provenance。

### 7.3 Raw context

raw item 按以下结构组装：

```text
### Raw · <resource name>
Context header: ...
Parent context: ...
Child chunk: ...
```

未超预算时保留完整 child、parent 和 context header。超预算时优先保留 child，再在剩余预算中补 parent context，并记录 `chunk_truncated`。

当前没有 provider tokenizer，token 估算为 Unicode code point 数除以 4 后向上取整，最少为 1；未来接入实际模型时只替换估算器，不改变 context item 合同。

Context 只在本 Sprint 组装并返回/保存，不交给 completion/chat model。

## 8. Trace、replay 与审计

### 8.1 `retrieval_runs`

每次检索都会保存：

- query、knowledge base、space、Top-K 和 context budget。
- Wiki seeds、raw seeds、seed gate 和 graph expansion。
- provenance lookups。
- context items、组装 Markdown、预算和截断状态。
- keyword 特征、vector provider/status、各阶段耗时。
- 成功或失败状态及错误原因。

### 8.2 原文保护

实时 `POST` 响应需要返回 raw 命中的内容，供检索器查看；但写入 `retrieval_runs` 和之后 `GET /api/retrieval/runs/:id` replay 时，raw result 会剥离：

- `content`
- `parentContext`
- `contextHeader`
- `snippet`

context snapshot 仍保留按预算组装后的文本，因为它是本次检索明确生成的上下文快照。replay 读取时还会再次清洗，避免旧 trace 泄露 raw 结果正文。

审计日志只记录状态、trace ID、结果数量、vector 状态和是否截断，不记录 API key 或 raw 正文。检索 trace 持久化失败不会被静默吞掉；失败 trace 也会尽力保留并向调用方报告持久化/审计错误。

## 9. 派生索引生命周期

相关派生对象：

| 对象 | 作用 | 来源 |
|---|---|---|
| `wiki_fts` | 当前 Wiki 页面关键词索引 | 当前 Wiki page version |
| `wiki_link_edges` | 当前 Wiki 显式链接图 | 当前 Markdown 中的 `wiki://UUID` |
| `resource_fts` | 当前 raw child chunk 关键词索引 | 当前成功 processing run |
| `retrieval_embeddings` | Wiki/raw 向量派生索引 | Worker embedding task |
| `retrieval_runs` | 检索 trace 和 context replay | 每次 retrieval |

Wiki 页面保存和资源索引成功后分别更新相应的 FTS/edge 并排 embedding task。旧的源材料、资源版本、Wiki 版本、引用、processing run 和审计记录不物理删除。

`rebuildRetrievalIndexes()` 可以清空并重建上述派生索引；它不会删除原始材料和审计记录。跨 Sprint 的旧数据库需要按 README 中的精确路径执行 rebuild，而空数据库会在 API/Worker 启动时完成迁移。

## 10. Web 观察面

Web overview 中的 Retrieval checker 展示：

- Wiki seeds、raw child chunks 和 graph expansion 三个独立区域。
- Wiki/raw scope 和独立 Top-K。
- score、seed gate、graph path、decay、provenance。
- context 总预算及 Wiki/raw 分预算、截断状态。
- vector provider/status 和阶段耗时。

结果链接保留来源定位：

- Wiki/graph：打开准确的 Wiki page version。
- raw：打开 `/api/resources/:resourceId/versions/:versionId/preview`，并携带 `startOffset` / `endOffset`。

该页面是检索检查器，不生成答案，也不写入 Wiki。

## 11. 验证入口

Focused checks：

```powershell
npm run check:retrieval-contract   # API、范围、CJK、replay、locator、校验
npm run check:retrieval-graph      # seed gate、双向 graph、hop 和边界
npm run check:retrieval-budget     # 60/40 budget、截断和 provenance
npm run check:retrieval-vector     # provider、降级、Worker embedding 和去重
npm run check:embedding-provider  # OpenAI-compatible HTTP 请求合同
npm run check:retrieval-real      # 本地真实 OpenAI-compatible embedding 模型端到端检查
npm run check:retrieval-performance # 合成规模下的召回和核心耗时
npm run check:retrieval
npm run check:all
npm --workspace apps/web run build
```

性能检查使用内存 SQLite 和确定性合成数据：100 个性能文档、5000 个新增 child chunks、100 个新增 Wiki 页面，再加基础 fixture 的 1 个 raw child chunk 和 6 个 Wiki 页面。它执行 20 个标注查询，验证每个 query 的 raw Top-10 至少命中一个正确 term；该指标用于 Sprint 验收，不代表真实生产数据分布或端到端 HTTP/Provider 延迟。

证据目录为 [`artifacts/sprint4/`](../artifacts/sprint4/)，验收摘要为 [`acceptance-report.md`](../artifacts/sprint4/acceptance-report.md)。

## 12. 相关实现

- [`packages/db/src/retrieval.js`](../packages/db/src/retrieval.js)：查询规范化、关键词/向量合并、seed gate、graph、provenance、context、trace 和派生任务。
- [`packages/db/src/text-tokenizer.js`](../packages/db/src/text-tokenizer.js)：共享英文词和 CJK bigram 扫描。
- [`packages/db/src/embeddings.js`](../packages/db/src/embeddings.js)：provider seam、mock vector 和 cosine similarity。
- [`apps/api/src/routes/retrieval.js`](../apps/api/src/routes/retrieval.js)：retrieval REST routes。
- [`apps/api/src/routes/resources.js`](../apps/api/src/routes/resources.js)：raw locator preview。
- [`apps/worker/src/retrieval/embeddings.js`](../apps/worker/src/retrieval/embeddings.js)：embedding task processor。
- [`packages/db/src/database/migrations.js`](../packages/db/src/database/migrations.js)：retrieval schema 和 derived indexes。
