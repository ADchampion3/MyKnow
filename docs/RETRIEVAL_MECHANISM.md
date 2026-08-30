# 当前检索机制审核

> 状态：基于当前代码的现状文档与设计复盘，不是下一版检索协议。
>
> 审核范围：`packages/db/src/retrieval.js`、`packages/db/src/text-tokenizer.js`、`packages/db/src/embeddings.js`、`packages/db/src/derived-cleanup.js`、Wiki/检索 API 路由、Worker 的资源与 embedding 任务，以及相关 SQLite/FTS 表。

## 1. 结论先行

当前检索由两个相互独立的通道组成（实现上按顺序执行）：

1. **Wiki 通道**：以当前版本的 Wiki page 为对象；
2. **Raw 通道**：以当前 processing run 的 child chunk 为对象。

两个通道都先做关键词召回；在配置允许时，再做向量召回；随后各通道内部用 RRF（Reciprocal Rank Fusion）融合结果。Wiki 结果还会经过置信度 gate，只有高置信 seed 才能触发最多两跳的 Wiki link graph 扩展。最后系统做 provenance 查询和上下文预算组装，并把通过请求、知识库和空间校验后进入主流程的 retrieval run 保存下来；API 层在 egress 预检查阶段拒绝请求时不会创建 run。

这套机制覆盖了“精确匹配、语义匹配、知识图谱扩展、来源追踪、上下文限额”几个基本问题，作为本地 MVP baseline 是完整的。但它目前不应被称为“关键词 + 向量 + reranker”：现有的 RRF 是**排名融合**，没有独立的学习型或规则型二次 reranker。

## 2. 主流程

```text
POST /api/retrieval/query
    -> 校验知识库/空间/查询参数
    -> 查询规范化与分词
    -> Wiki FTS + Raw FTS
    -> 可选：生成 query embedding，扫描候选向量
    -> 每个通道做 RRF 融合与 topK
    -> Wiki seed gate
    -> Wiki link graph 两跳扩展
    -> Wiki provenance + Raw locator
    -> 60/40 上下文预算组装
    -> 持久化 retrieval_runs 并返回 trace
```

主入口是 [`apps/api/src/routes/retrieval.js`](../apps/api/src/routes/retrieval.js) 的 `POST /api/retrieval/query`。底层编排集中在 [`packages/db/src/retrieval.js`](../packages/db/src/retrieval.js) 的 `executeRetrieval`。

请求体必须是对象；`knowledgeBaseId` 和可选的 `spaceId` 必须是 UUID，`query` 在 NFKC 规范化后为 1–200 个字符，`wikiTopK`/`rawTopK` 为 1–20 的整数，`contextBudgetTokens` 为 1–50000 的整数。请求校验失败返回 `VALIDATION_ERROR`，知识库或空间不存在返回 `NOT_FOUND`；这些前置失败不会建立 retrieval run。已保存的 run 可通过 `GET /api/retrieval/runs/:id` 读取。

仓库还保留了 `GET /api/search`。它是一个较低层的 Raw FTS 查询入口，使用自己的空格切词、AND + 前缀匹配和 SQLite FTS rank；查询侧不使用下面描述的 tokenizer，也不经过向量、RRF、Wiki graph、provenance 和上下文组装。它应被视为独立的 legacy lexical API，而不是主检索流程的一部分。

## 3. 检索对象与过滤边界

### 3.1 Wiki 对象

Wiki 检索对象是 `wiki_pages` 的当前版本：

- 只查指定知识库；
- 可按 `spaceId` 过滤；
- 只查 `active` page；
- 排除 `index` 和 `log` 系统页；
- 要求 page 的 `current_version_id` 与 FTS/embedding 对应版本一致。

Wiki FTS 以 page version 为索引对象，Wiki link edge 以“来源 page + 来源版本”为关系身份。

### 3.2 Raw 对象

Raw 检索对象是当前资源版本、当前 processing run 下的 `chunk_type='text'` child：

- 只查指定知识库关联的资源；
- 排除 archived resource；
- 要求 resource 的 current version、resource version 的 active processing run、processing run 的 indexed 状态全部一致；
- 排除 superseded chunk；
- parent chunk 不直接召回，只在结果上下文中补回。

### 3.3 当前作用域差异

API 接受 `knowledgeBaseId` 和可选 `spaceId`，但当前数据库只有 resource 与 knowledge base 的关联，没有 resource 与 space 的关联。因此：

- `spaceId` 会限制 Wiki 结果；
- Raw 结果仍覆盖该知识库下所有资源。

`trace.scope.rawScope` 当前也固定记录为 `knowledge_base`。如果产品语义要求“空间是完整检索边界”，这部分需要先补领域关系或重新定义空间含义。

## 4. 查询规范化与关键词召回

### 4.1 Tokenizer

查询先做 NFKC 规范化、转小写和空白折叠。之后：

- 非 Han 字母和数字连续串作为 word token；
- 英文停用词会从查询 terms 中移除；
- Han 字符连续串会生成相邻 bigram，例如 `知识库` 生成 `知识`、`识库`；
- 最终 terms 是非 Han word token 与 CJK bigram 的去重集合。

例如：

```text
查询：知识库 retrieval
terms：retrieval、知识、识库
FTS："retrieval" OR "知识" OR "识库"
```

实现见 [`packages/db/src/text-tokenizer.js`](../packages/db/src/text-tokenizer.js) 和 `retrieval.js` 的 `tokenizeQuery`/`ftsQueryFor`。

### 4.2 索引文本

写入 `resource_fts` 或 `wiki_fts` 时，`searchableText` 同时保存：

1. 原始文本；
2. word token 以空格拼接的副本；
3. CJK bigram 以空格拼接的副本。

这样做是为了让 SQLite FTS5 的默认 tokenizer 也能对中文产生可匹配的词片段。它不是中文分词器，也不会理解词性、同义词、实体或拼写变体。

### 4.3 自定义关键词评分

FTS 负责找候选，最终关键词相关性由 JavaScript 重新计算。对每个候选，系统计算：

```text
score = min(1,
  0.40 * 内容 term 覆盖率
  + 0.20 * 标题 term 覆盖率
  + 0.25 * 完整短语命中
  + 0.15 * 全部 terms 都命中
)
```

候选命中至少一个 OR term 后，再按这个 `normalizedScore` 排序。查询与索引文本中的 term 集合均来自同一 tokenizer，因此评分和召回的词粒度一致。

这里的“完整短语命中”是规范化字符串的 substring 命中，不是 FTS phrase query；标点、空格和中英文混排可能影响结果。

## 5. 向量召回

### 5.1 向量生成

向量是异步派生数据，不在资源处理事务中同步生成。Worker 启动时会为缺失向量的当前 Wiki page 和 Raw child 排入 `retrieval:embed` 任务。

Raw child 的 embedding 输入是：

```text
contextHeader（标题路径、表头等结构上下文） + child content
```

分块器记录的 `sizeMetrics.estimatedEmbeddingTokens` 与检索的 `estimatedTokens` 默认使用同一个跨语言启发式计数器，但统计的输入不同：前者是 `contextHeader + child content`，后者是最终组装的上下文 item。该计数器会分别处理中文 Han 字符、emoji、非 Han 字母/数字串、空白和符号。embedding provider 可以通过可选 `tokenizer.countTokens(text)` seam 提供真实 token 数；注入后，分块会额外记录 `providerContentTokens`/`providerEmbeddingTokens`，检索上下文预算和 trace 也使用该 tokenizer。没有 provider tokenizer 时，`contextBudgetTokens` 的公开含义仍是“估算 token 预算”。

Wiki page 的 embedding 输入是：

```text
page title + page content
```

向量输入有 SHA-256 摘要，可按相同输入、provider、model、dimension 命中缓存。任务实现见 [`apps/worker/src/retrieval/embeddings.js`](../apps/worker/src/retrieval/embeddings.js)。

### 5.2 Provider 与存储

当前支持：

- 默认 `mock`：基于 token 的确定性 hash 向量，默认 32 维，只用于本地行为和流程验证；
- `openai` / `openai-compatible`：通过 HTTP embeddings 接口生成真实向量；
- `none`、`disabled` 或关闭配置：禁用向量召回。

向量以 JSON 数组保存在 `retrieval_embeddings`，没有 ANN 索引；现有普通索引只用于 owner/version 等元数据筛选。查询时把符合 provider、model、dimension、版本和 active 条件的向量全部读出，在 JavaScript 中计算 cosine similarity，再取前 200 个。这是一个明确的本地 MVP 复杂度上限，数据规模增大后会变成主要瓶颈。

### 5.3 故障语义

通常的 embedding 失败会把向量阶段标记为 `disabled` 或 `degraded`，继续使用关键词结果；没有可用向量时也会正常完成关键词检索。显式的 egress 拒绝会直接失败，因为这代表安全策略不允许发出请求，而不是普通召回降级；API 的 egress 预检查发生在 `executeRetrieval` 之前，因此这类拒绝不会写入 retrieval run。

## 6. 通道内融合与排序

Wiki 和 Raw 分别完成关键词召回、向量召回和融合，不会把 Wiki page 与 Raw chunk 放在同一个候选排序池中。

每个通道的候选上限是：

- Wiki 关键词最多 200 行；
- Raw 关键词最多 400 行；
- 向量扫描后最多保留 200 个；
- 默认输出 `wikiTopK=5`、`rawTopK=10`，请求上限为 20。

融合使用 RRF：

```text
rrfScore = 1 / (60 + keywordRank) + 1 / (60 + vectorRank)
```

未出现在某一路的候选，该路贡献为 0。最终先按 `rrfScore`，再按 `normalizedScore` 和稳定 ID 排序。

注意：`normalizedScore` 在同时命中关键词和向量时保留关键词 score；只有仅命中向量的候选才把 cosine similarity 从 `[-1, 1]` 线性映射到 `[0, 1]`。因此 `normalizedScore` 不是跨候选、跨通道可比较的统一概率，也不能直接解释为“相关度百分比”。真正的融合顺序是 `rrfScore`。

## 7. Wiki seed gate 与图扩展

Wiki 融合结果不会全部参与图扩展。当前 seed gate 要求：

- 有关键词排名；
- `keywordScore >= 0.70`；
- 与下一个候选的分数差 `margin >= 0.10`。

通过 gate 的 page 才是 graph seed。每个 seed 最多扩展两跳：

| 跳数 | 分数衰减 |
| ---: | ---: |
| 1 | `0.5 * seedScore` |
| 2 | `0.25 * seedScore` |

扩展同时考虑出边和入边，只在同一知识库、来源 edge 对应当前 page version、目标有当前 page version、`status` 非 archived 且 `page_type` 不是 `index`/`log` 的页面中遍历；每一层最多选择 10 个候选，并记录 `graphPath`、link text 和方向。

这个设计把“直接命中”和“关系邻居”分开：直接命中必须足够可信，邻居只能以衰减分数进入上下文，避免低置信 query 把整张 Wiki 图带入答案。

但当前 gate 只看关键词证据。一个只有高向量相似度、没有任何关键词命中的 Wiki page，即使进入了融合结果，也不能成为 graph seed。这是一个偏保守的可追溯性策略，但会牺牲语义检索驱动的图扩展能力。注意，gate 只决定能否扩图；未通过 gate 的 Wiki 候选仍可能作为主 Wiki 结果进入上下文。

## 8. Provenance 与上下文组装

### 8.1 Provenance

Wiki page 的 provenance 来自 `wiki_citations`：

- 关联到 page 当前版本；
- 查询来源资源版本和 locator；
- 读取 source storage 并比较字节数与 SHA-256；
- 返回 citation、资源版本、状态、完整性和 locator。

Raw child 不经过 Wiki citation 表，直接用 child locator、resource version 和 processing run 作为来源信息。也就是说，Raw 的来源链是“检索对象本身的处理坐标”，Wiki 的来源链是“Wiki block 到原始资源”的显式引用。

### 8.2 固定预算

默认上下文预算为 8000 个估算 token，最大 50000；固定分配为：

```text
Wiki：60%
Raw ：40%
```

Wiki 主结果（无论 seed gate 是否通过）按融合顺序加入，随后加入 graph 结果；同一 page 去重：

1. 页面足够小则放入全文；
2. 页面过大则找命中 block，并带上前后相邻 block；
3. 仍超预算时按字符截断。

Raw 结果按排序顺序加入，内容形态是：

```text
标题
    + contextHeader（标题路径、表头等结构上下文）
    + parent context
    + child chunk
```

超预算时优先保留 child，再尽量补 parent。最终返回 `items`、拼接后的 `markdown`、每个 item 的 locator、估算 token 数以及截断原因。

当前 token 估算按 Han 字符、emoji、连续非 Han 字母/数字串、空白和符号分别处理，不是实际模型 tokenizer。因此没有 provider tokenizer 时预算是工程近似，不是模型 API 的硬保证；它只作为 code point canonical 大小之外的模型侧二级约束。只有 provider 明确提供真实 tokenizer 时，才允许分块配置 `parentTokenTarget`/`childTokenTarget`。

## 9. Trace 与持久化

一次主检索会写入 `retrieval_runs`，包括：

- 查询与作用域；
- Wiki seeds、graph expansion；
- Raw seeds；
- 关键词分词、候选数量、各阶段耗时；
- 向量 provider/model/status；
- provenance lookup；
- 上下文 item、markdown、预算和截断信息；
- 错误信息和完整 trace JSON。

数据库结构见 [`packages/db/src/database/migrations.js`](../packages/db/src/database/migrations.js) 的 `retrieval_embeddings`、`retrieval_runs`、`resource_fts`、`wiki_fts` 和 `wiki_link_edges`。

Raw seed 的持久化视图会去掉 `content`、parent、header 和 snippet，完整文本仍在 `context_items/context_markdown` 中用于本次回放。检索 API 的审计日志只记录计数、状态和向量状态；embedding 任务审计还会记录 owner/version、provider/model 和输入摘要等元数据，但不直接写入正文。

## 10. 当前实现符合的原理

检索质量的最终判断以命中率、召回率、排序质量和上下文可用性等下游 retrieval 指标为准；chunk 数量、平均 code point、protected 边界、forced split 和 overlap 数量只作为结构诊断指标。结构指标可以解释回归，但不能单独证明检索质量提升。

### 10.1 Hybrid retrieval

关键词适合精确名称、数字、错误码和专有名词；向量适合表达改写和语义近似。两路先独立排序，再用 rank fusion 合并，避免强行把不可比的原始分数线性相加。

### 10.2 Hard filter before relevance

当前版本、processing run、资源状态和 Wiki page 状态在 SQL 阶段过滤，避免旧版本或 superseded chunk 以高分污染结果。这比先召回再在应用层过滤更可靠。

### 10.3 Graph expansion needs a confidence gate

图扩展会引入 query 没有直接命中的页面，必须限制 seed 质量、跳数和衰减。当前 gate + 两跳衰减满足“相关邻居可补充、低置信结果不能无限扩散”的基本原则。

### 10.4 Context selection is separate from ranking

排序结果不等于可以直接塞给模型的上下文。当前流程把召回、来源、去重、页面 block 选择、parent 补充和预算截断分开，符合 RAG 的分层职责。

### 10.5 Retrieval must be replayable

保存 query、scope、候选摘要、版本、locator、预算和 trace，能够解释一次回答使用了什么派生数据。这对调试和来源审计比只保存最终答案更重要。

## 11. 审核发现与边界

以下是当前限制与后续优化边界。

### 高影响：空间作用域不完整

用户可以选择 space，但 Raw 资源没有 space 关联，导致同一个请求里的 Wiki 与 Raw 实际作用域不同。如果空间被定义为检索边界，这会造成“界面显示选择了空间、答案却使用了空间外原始材料”的语义不一致。

### 高影响：向量查询是全表扫描

向量 JSON 存储和 JavaScript cosine scan 在数据量增长时是 O(N) 读和 O(N) 计算。它适合本地小规模数据，不适合直接扩展到大量 chunk；未来要在 SQLite vector extension、LanceDB 或其他 ANN 后端之间作明确选择。

### 高影响：没有真正的 reranker

RRF 只使用两个召回排名，不能判断一个候选是否完整回答问题、是否包含条件/例外，也不会做 cross-encoder 或 LLM 重排。若产品需要“候选相关性”和“答案可用性”的第二层判断，必须单独定义 reranker 输入、输出和成本边界。

### 中影响：seed gate 偏向关键词

gate 要求 `keywordRank` 且使用 `keywordScore`，所以向量独有的 Wiki 命中不能触发图扩展。这样可避免纯语义误扩散，但会让图检索依赖词面重叠；是否允许高置信向量 seed 应成为显式策略，而不是由当前实现隐含决定。

### 中影响：存在两条不一致的查询路径

`/api/retrieval/query` 使用共享 tokenizer、混合召回、RRF、graph、provenance 和 context assembly；`/api/search` 使用另一套 FTS 查询。两者对中文、前缀、AND/OR、排序、作用域和返回形态的解释不同，后续容易出现“同一个问题在搜索框和 Agent 中得到不同结果”的维护成本。

### 中影响：分数没有统一标尺

关键词 score 是 term 覆盖规则，向量 score 是 cosine similarity，RRF 是 rank 分数。当前排序是可用的，但任何 UI 进度条或业务阈值都不应直接把 `normalizedScore` 当成概率。seed gate 也只适用于当前这套关键词规则，不能自动迁移到新的 scorer。

### 中影响：上下文预算不是模型 tokenizer 预算

固定 60/40 比例简单且可解释，但无法根据问题类型动态调整；没有 provider tokenizer 时，启发式估算即使已区分 Han 字符、非 Han 字母/数字串、空白、emoji 和符号，仍可能与实际 provider 偏差很大。若 provider 提供真实 tokenizer，当前上下文组装会直接使用它做预算校验。

### 中影响：Raw provenance 弱于 Wiki provenance

Raw 结果包含 locator 和处理运行 ID，但不会在每次检索时重新读取源文件并校验完整性，也没有像 Wiki citation 那样的 block 级引用状态。因此“Raw 可定位”不等于“Raw 已完成独立来源校验”。

### 低影响：旧派生结果需要显式清理

重处理后旧 chunk/embedding 不参与 active 查询。现在可以用 `DERIVED_DATA_RETENTION_DAYS` 配置保留天数，并先运行 `npm run db:cleanup-derived -- --dry-run` 查看候选，确认后加 `--confirm` 清理 superseded 或已不再是当前 resource version 的 indexed generation 的 chunks、FTS、旧 embedding 和 canonical artifact，并按同一截止时间清理失败 embedding 与 retrieval trace；仍有 queued/running/retrying embedding task 的 generation 会被跳过，避免任务随后读取不到 chunk；原始资源、resource version、processing run 和 audit log 不会被删除。canonical 存储删除失败时命令以非零状态退出，方便重试。

## 12. 当前协议与待定事项

分块协议已经确定：Raw 只检索 active processing run 的 child；embedding 输入使用 `contextHeader + child content`；大小坐标以 code point 为 canonical，检索上下文默认使用明确标注的估算 token 预算，provider tokenizer 可作为二级精确约束；旧 generation 的派生结果按保留周期显式清理但不参与 active 查询。检索质量仍以召回、排序和上下文可用性等下游指标判断，分块结构数据只用于解释回归。

仍待单独决定、且不改变上述分块协议的事项：

1. 检索的唯一公开契约是什么，是否保留 `/api/search`，还是让它成为主检索的简化视图？
2. space 是否覆盖 Raw resource，还是明确规定 space 只组织 Wiki？
3. 关键词召回要继续使用 CJK bigram，还是引入可替换的语言 tokenizer/BM25 实现？
4. 向量后端的规模上限是多少，何时从全表扫描切换到 ANN？
5. RRF 后是否需要独立 reranker；如果需要，重排的是 Wiki page、Raw child，还是统一候选？
6. 向量独有结果能否成为 Wiki seed，gate 应基于关键词、向量、融合排名还是证据完整性？
7. Raw 和 Wiki 是否需要统一的 citation/provenance 对象，以便 Agent 只消费一种来源协议？
8. 旧版本 embedding 和 retrieval trace 的保留周期由 `DERIVED_DATA_RETENTION_DAYS` 控制，默认 30 天；实际清理通过显式命令执行。


## 13. 相关代码

- [`packages/db/src/retrieval.js`](../packages/db/src/retrieval.js)：查询规范化、关键词/向量召回、RRF、seed gate、图扩展、provenance、上下文和 trace。
- [`packages/db/src/text-tokenizer.js`](../packages/db/src/text-tokenizer.js)：非 Han word token 与 CJK bigram。
- [`packages/db/src/embeddings.js`](../packages/db/src/embeddings.js)：embedding provider、tokenizer seam、向量校验、hash mock 和 cosine similarity。
- [`packages/db/src/derived-cleanup.js`](../packages/db/src/derived-cleanup.js)：派生数据保留计划与显式清理。
- [`apps/worker/src/retrieval/embeddings.js`](../apps/worker/src/retrieval/embeddings.js)：异步 embedding 任务和缓存。
- [`apps/worker/src/resources/processor.js`](../apps/worker/src/resources/processor.js)：Raw child 写入 FTS、排入 embedding 任务。
- [`apps/api/src/routes/retrieval.js`](../apps/api/src/routes/retrieval.js)：主检索 API。
- [`apps/api/src/routes/search.js`](../apps/api/src/routes/search.js)：独立的 legacy Raw FTS API。
- [`packages/db/src/database/migrations.js`](../packages/db/src/database/migrations.js)：检索派生数据表和 FTS5 表结构。
