# Raw hybrid retrieval 评测数据流

本文说明 `.scratch/raw-hybrid-retrieval-eval` 对应实现中的数据如何从评测文件流入检索器，再流入 DeepEval 指标和最终报告。评测对象是 `executeRetrieval()` 返回的 raw child chunk 排名，不包含答案生成，也不使用 LLM judge。

## 一、整体链路

```text
corpus.json ─────┐
queries.json ────┼─> 校验后的评测数据
qrels.json ──────┘          │
                            ├─ prepare ─> 真实 Embedding API
                            │             └─> embedding-snapshot.json
                            │
                            └─ evaluate ─> 内存 SQLite fixture
                                           │
                                           ├─ keyword: resource_fts
                                           ├─ vector: query embedding + retrieval_embeddings
                                           └─ RRF merge
                                                  │
                                                  └─ raw ranking
                                                       │
                                  LLMTestCase(input, actualOutput, qrels metadata)
                                                       │
                                                       └─ Recall / Hit Rate / MRR / NDCG
                                                              │
                                                              └─ stdout JSON report
```

准备阶段只负责把语料 chunk 转成可复用的向量快照；评测阶段仍然会为每个 query 调用真实 Embedding provider 生成查询向量。快照向量和查询向量必须使用同一个 provider、model、endpoint 和 4096 维度。

## 二、输入边界：三个文件和一个派生文件

默认目录是 `evals/raw-hybrid-retrieval/data/`。路径定义和文件读取入口在 [`contracts.js#L330-L350`](../evals/raw-hybrid-retrieval/src/contracts.js#L330-L350)。

| 文件 | 进入系统后的用途 | 代码引用 |
| --- | --- | --- |
| `corpus.json` | 提供 raw child chunk、资源/版本/处理运行信息和 parent context；chunk ID 是评测主键。 | [`validateCorpus()`](../evals/raw-hybrid-retrieval/src/contracts.js#L82-L150) |
| `queries.json` | 提供 query ID、查询文本和标签。 | [`validateQueries()`](../evals/raw-hybrid-retrieval/src/contracts.js#L152-L173) |
| `qrels.json` | 提供每个 query 对 raw child chunk 的人工相关性等级 `0/1/2`。 | [`validateQrels()`](../evals/raw-hybrid-retrieval/src/contracts.js#L175-L206) |
| `manifest.json` | SciFact 来源 archive/file 哈希、转换规则、test split、数量、规范化影响和输出哈希；由导入器生成并可独立校验。 | [`validateEvaluationManifest()`](../evals/raw-hybrid-retrieval/src/contracts.js) |
| `embedding-snapshot.json` | 由准备阶段生成；保存每个 corpus chunk 的向量和 provider/input 哈希。 | [`validateEmbeddingSnapshot()`](../evals/raw-hybrid-retrieval/src/contracts.js#L268-L326) |

`qrels` 不会被传给生产检索 SQL；它只在指标阶段作为参考答案使用。校验层会拒绝重复 ID、未知 chunk、没有正相关项的 query、过期 hash 以及不完整向量快照。

## 三、测试集来源与可信度

### 3.1 来源优先级

DeepEval 官方建议按以下顺序选择评测数据：

1. 已整理并经过人工复核的数据，尤其是覆盖真实用户旅程、失败场景和边界情况的数据。
2. 生产流量中的真实请求或会话；使用前必须脱敏、清洗和复核。
3. 合成数据；用于缺少真实样本时快速建立初始覆盖和发现明显回归，不应替代真实数据。

具体原则见 [DeepEval Synthetic Data Generation 的 Recommended Priority](https://deepeval.com/docs/synthetic-data-generation-introduction#recommended-priority)。官方还明确要求：高风险场景中，生成的样本必须经过 review、edit 和 enrich 后才能当作 ground truth。

映射到本项目后，推荐采用以下规则：

| 数据 | 首选来源 | 可接受的降级来源 | 最终要求 |
| --- | --- | --- | --- |
| `corpus.json` | 已冻结、可追溯的真实知识库版本和 raw child chunks | 经审核的导出快照 | 保留稳定 chunk ID、资源版本和 parent context；不使用模型凭空生成的语料作为正式 corpus |
| `queries.json` | 人工整理的真实 query、生产请求采样 | 从已提供文档或已准备 context 生成的候选 query | 人工去重、脱敏、复核，并用 `tags` 标记覆盖场景 |
| `qrels.json` | 人工对 raw child chunk 的相关性标注 | LLM 预标注后逐条人工确认 | 只有确认后的 `0/1/2` 才能作为正式指标依据 |
| `embedding-snapshot.json` | 由当前 corpus 和真实 provider 派生 | 无 | 不是测试集来源，必须由准备命令生成，不能手工编辑 |

### 3.2 Golden、query 和 qrels 的区别

DeepEval 将 `Golden` 定义为测试用例的前身：它保存输入和预期结果，运行时再生成动态的 `actual_output`；详情见 [DeepEval Datasets 的 Goldens 说明](https://deepeval.com/docs/evaluation-datasets#what-are-goldens)。本项目的 `qrels.json` 是 IR 专用的人工相关性集合，不是普通问答的 `expected_output`：

- Golden 或合成结果可以帮助发现候选 query。
- 候选 query 必须映射回 `corpus.json` 中的 raw child chunk ID。
- 生成器不能直接决定 `grade`；`grade` 需要人工审核后才可进入正式 qrels。
- 当前评测代码把实际排名放进 `LLMTestCase.actualOutput`，把 qrels 放进 metadata，再由自定义 metric 比较二者；对应实现见 [`evaluate.js#L46-L57`](../evals/raw-hybrid-retrieval/src/evaluate.js#L46-L57)。

如果已有经过 Embedding 和分块的 context，官方建议使用 `generate_goldens_from_contexts`，这样可以直接控制使用的 chunk；见 [DeepEval Generate Goldens From Contexts](https://deepeval.com/docs/synthesizer-generate-from-contexts)。如果只有文档，使用 `generate_goldens_from_docs`；如果有小规模已审核 seed，则可用 `generate_goldens_from_goldens` 扩充。`scratch` 只适合没有任何资料时的初始覆盖或 smoke test。官方 CLI 对应的四种 method 是 `docs`、`contexts`、`goldens` 和 `scratch`，见 [DeepEval CLI Settings](https://deepeval.com/docs/command-line-interface#generate)。

### 3.3 qrels 标注的最低要求

对每条 query，标注人应查看 query 和候选 raw child chunks，再填写：

```json
{
  "queryId": "q-001",
  "relevant": [
    { "chunkId": "chunk-001", "grade": 2 },
    { "chunkId": "chunk-007", "grade": 1 },
    { "chunkId": "chunk-009", "grade": 0 }
  ]
}
```

`grade=2` 表示能直接满足 query，`grade=1` 表示部分相关，`grade=0` 表示明确不相关。当前 metric 只把 `grade>0` 放入相关集合；没有出现在 qrels 中的 chunk 也不会被视为命中。因此，如果只标注少量正例而没有覆盖可能出现的候选，Recall/NDCG 会把未标注结果当成非相关，结果只能作为近似诊断，不能当成完整基准。当前校验规则和正例要求见 [`validateQrels()`](../evals/raw-hybrid-retrieval/src/contracts.js#L175-L206)。

### 3.4 推荐的落地流程

1. 冻结一份真实 corpus，记录来源、版本、采集时间和脱敏状态。
2. 从人工 query 或脱敏生产流量开始；按用户旅程、失败场景、语言和边界条件抽样。
3. 没有足够 query 时，再用文档或 prepared contexts 生成候选 query；把生成结果标记为 `synthetic-candidate`，不直接作为正式测试集。
4. 由领域人员审核 query，并为 raw child chunk 标注 qrels；有争议的样本进行复核或仲裁。
5. 固定一份 regression/test 集，另设可迭代的 development 集，避免调参时反复修改正式基线。
6. 将 corpus、queries、qrels 和数据来源说明一并提交或版本化；重新生成快照后再运行评测。

上述 `synthetic-candidate`、`regression` 等是数据治理标签，当前代码不会自动判定。仓库现有输入 schema 主要保存评测内容和 query tags，因此来源、复核人、版本和脱敏信息应同时记录在同目录说明、提交记录或数据集管理平台中。

## 四、准备阶段：语料如何变成向量快照

命令入口是 [`prepare-raw-hybrid-eval-embeddings.js#L5-L17`](../scripts/prepare-raw-hybrid-eval-embeddings.js#L5-L17)，对应 npm script 为 `npm run eval:raw-hybrid:prepare`。

数据传递顺序如下：

1. `loadEvaluationData({ requireSnapshot: false })` 读取并校验三个输入文件。
2. `assertRealEmbeddingConfig()` 强制要求真实 `openai`/`openai-compatible` provider、显式非 mock model、`4096` 维度、有效 HTTP(S) endpoint 和启用的向量检索；实现见 [`contracts.js#L249-L266`](../evals/raw-hybrid-retrieval/src/contracts.js#L249-L266)。
3. `embeddingInputForChunk()` 复用生产代码的 `embeddingInputText()`，把 `contextHeader` 和 chunk `content` 组成 Embedding 输入；评测封装见 [`contracts.js#L208-L214`](../evals/raw-hybrid-retrieval/src/contracts.js#L208-L214)，生产实现见 [`embeddings.js#L6-L8`](../packages/db/src/embeddings.js#L6-L8)。
4. `npm run eval:raw-hybrid:preflight` 会先对少量真实 corpus 输入调用 `provider.embedText(input)`，检查响应、4096 维度、provider 元数据和标题加正文后的输入长度；它不写入快照。
5. `prepareRawHybridEmbeddingSnapshot()` 按稳定 chunk ID 顺序逐个调用 `provider.embedText(input)`，校验返回向量和 provider 元数据，再记录 chunk 的输入 hash；实现见 [`embedding-snapshot.js#L42-L70`](../evals/raw-hybrid-retrieval/src/embedding-snapshot.js#L42-L70)。
6. 所有向量完成后才生成 manifest。manifest 包含 provider、model、dimensions、endpoint、corpus hash 和每个 chunk 的 input hash；之后再次整体校验并原子写入快照，见 [`embedding-snapshot.js#L71-L84`](../evals/raw-hybrid-retrieval/src/embedding-snapshot.js#L71-L84)。

真实 HTTP provider 最终在 [`createEmbeddingProvider()`](../packages/db/src/embeddings.js#L85-L134) 中通过 `POST /embeddings` 请求服务。准备过程中发生 provider 错误、返回格式错误或维度不匹配时，不会写入半成品，也不会覆盖已有快照。

## 五、运行阶段：评测数据如何进入隔离数据库

Vitest 入口 [`raw-hybrid-retrieval.eval.js#L1-L27`](../evals/raw-hybrid-retrieval/raw-hybrid-retrieval.eval.js#L1-L27) 先调用 `loadConfig()`，再调用 `collectRawHybridEvaluation()`。评测收集器的入口和 query 循环在 [`evaluate.js#L19-L70`](../evals/raw-hybrid-retrieval/src/evaluate.js#L19-L70)：

1. 重新校验真实 Embedding 配置，并以当前配置校验快照 manifest。因此 corpus、model、endpoint 或维度发生变化而未重新准备快照时，评测会直接失败。
2. `createRawHybridEvalFixture()` 默认创建 `:memory:` SQLite，执行正常 migration，再把评测数据写成应用检索器认识的数据库形状；入口见 [`fixture.js#L66-L82`](../evals/raw-hybrid-retrieval/src/fixture.js#L66-L82)。
3. fixture 的映射关系如下：

   | 评测输入 | fixture 中的表/数据 | 代码引用 |
   | --- | --- | --- |
   | `knowledgeBaseId` | `knowledge_bases` | [`fixture.js#L21-L24`](../evals/raw-hybrid-retrieval/src/fixture.js#L21-L24) |
   | resource/version/run 元数据 | `resources`、`resource_versions`、`processing_runs`、`resource_knowledge_bases` | [`fixture.js#L25-L41`](../evals/raw-hybrid-retrieval/src/fixture.js#L25-L41) |
   | parent context | `chunks` 中的 `parent_text` 行 | [`fixture.js#L43-L49`](../evals/raw-hybrid-retrieval/src/fixture.js#L43-L49) |
   | raw child chunk | `chunks` 中的 `text` 行 | [`fixture.js#L50-L54`](../evals/raw-hybrid-retrieval/src/fixture.js#L50-L54) |
   | 快照向量 | `retrieval_embeddings`，`owner_type='raw_chunk'`、`status='ready'` | [`fixture.js#L56-L61`](../evals/raw-hybrid-retrieval/src/fixture.js#L56-L61) |
   | 可检索关键词投影 | `resource_fts` | [`fixture.js#L62-L63`](../evals/raw-hybrid-retrieval/src/fixture.js#L62-L63) |

`rebuildRetrievalIndexes()` 只重建 fixture 内的派生索引。生产数据库文件不会被打开写入；不过 `executeRetrieval()` 产生的 `retrieval_runs` 会持久化在这份内存数据库中，以便保留完整 trace。

## 六、单条 query 在检索器中的传递

对每条 query，收集器把以下数据传给现有 `executeRetrieval()`：

```js
{
  knowledgeBaseId,
  query,
  rawTopK: 10,
  wikiTopK: 1,
  contextBudgetTokens: 8000
}
```

实际调用以及 `onAudit: () => {}` 的隔离设置见 [`evaluate.js#L26-L46`](../evals/raw-hybrid-retrieval/src/evaluate.js#L26-L46)。检索器内部的数据流在 [`retrieval.js#L459-L523`](../packages/db/src/retrieval.js#L459-L523)：

每条 query 使用有限的 `RAW_HYBRID_EVAL_TIMEOUT_MS`（默认 1,800,000 ms）；超时会中止 provider 请求并使整次评测失败，不会发布部分报告。

```text
query text
   ├─ tokenizeQuery()
   │    └─ rawKeywordSearch() ─> resource_fts ─> keyword ranking
   │
   └─ provider.embedText(query)
        └─ vectorRowsForRaw() ─> retrieval_embeddings
             └─ cosine similarity ─> vector ranking

keyword ranking + vector ranking
        └─ mergeResults() ─> RRF score ─> rank 1..rawTopK
```

关键词候选只接受当前 resource version、active processing run 和 active text chunk；向量候选还要求 `provider`、`model`、`dimensions` 与当前查询 provider 一致。相关 SQL 和 RRF 合并实现见 [`retrieval.js#L174-L244`](../packages/db/src/retrieval.js#L174-L244)。最终 raw 结果写入 `trace.raw.results`；parent content 作为上下文随结果返回，但不作为独立排名目标。

评测额外检查 `trace.status === 'succeeded'`，并要求 `trace.vector.status === 'used'` 且没有 `keywordFallback`，见 [`evaluate.js#L41-L46`](../evals/raw-hybrid-retrieval/src/evaluate.js#L41-L46)。因此 Embedding 服务失败时，生产检索器原本可能降级为关键词检索，但这条评测链路会把该情况判为失败，不会把降级结果当成混合检索结果。

## 七、raw ranking 如何传给 DeepEval

检索结果先经过 `publicRawRanking()` 保留稳定的公开字段，再由 `serializeRawRanking()` 编码为带 schema version 的 JSON 字符串。收集器随后创建一个 DeepEval `LLMTestCase`：

| `LLMTestCase` 字段 | 实际内容 |
| --- | --- |
| `input` | 原始 query 文本 |
| `actualOutput` | 序列化后的 raw ranking，包含 chunk ID、rank、keyword/vector rank、RRF 等字段 |
| `additionalMetadata.qrels` | 当前 query 的人工相关性判断 |
| `additionalMetadata.queryId/tags` | 追踪和报告用途的 query 元数据 |

对应代码是 [`evaluate.js#L46-L57`](../evals/raw-hybrid-retrieval/src/evaluate.js#L46-L57)。这意味着指标层不再访问数据库，而是消费 `LLMTestCase` 中的排名 JSON 和 qrels。

`expect(testCase).toPass(metrics)` 位于 [`raw-hybrid-retrieval.eval.js#L16-L25`](../evals/raw-hybrid-retrieval/raw-hybrid-retrieval.eval.js#L16-L25)。自定义 DeepEval metric 会解析 `actualOutput` 和 qrels，检查排名合法性，然后计算结果；实现见 [`metrics.js#L82-L120`](../evals/raw-hybrid-retrieval/src/metrics.js#L82-L120) 和 [`metrics.js#L169-L234`](../evals/raw-hybrid-retrieval/src/metrics.js#L169-L234)。

当前指标组合是 `K = 1, 3, 5, 10` 的 Recall、Hit Rate、MRR、NDCG 和 Judged，共 20 个指标。Recall、Hit Rate、MRR 将 `grade > 0` 视为相关；NDCG 使用 BEIR/TREC 的线性 `grade` gain；Judged@K 统计前 K 个实际返回结果中存在显式 qrel 的比例，显式 `grade=0` 也算已标注。阈值暂时为 `0`，只用于让 matcher 报告分数，不代表产品质量门槛。

## 八、报告和持久化边界

`buildRawHybridReport()` 把每条 query 的 qrels、实际排名、向量 provider 状态、指标分数/解释和所有 query 的 macro average 组合成报告，见 [`evaluate.js#L72-L118`](../evals/raw-hybrid-retrieval/src/evaluate.js#L72-L118)。测试入口通过 `onProgress` 接收 provider 校验、数据加载、fixture、逐条 query 和评分进度，并把带耗时的过程日志写到 stderr；随后用 `formatRawHybridReport()` 将详细 JSON 打印到 stdout，见 [`raw-hybrid-retrieval.eval.js`](../evals/raw-hybrid-retrieval/raw-hybrid-retrieval.eval.js)。
报告顶层同时记录 qrel 覆盖的 query 数和 judgment 行数，便于核对基准规模。

持久化边界如下：

- `manifest.json` 是导入阶段写入的来源和转换证明；`RAW_HYBRID_EVAL_REPORT_PATH` 指定的报告在整批成功后原子发布。
- `embedding-snapshot.json` 是准备阶段写入的可复用派生文件。
- 评测阶段的 SQLite 默认是 `:memory:`，fixture、FTS、向量行和 `retrieval_runs` 随评测生命周期存在。
- 评测使用空的 `onAudit`，不会向正式审计流写入记录。
- 报告默认打印到 stdout；设置 `RAW_HYBRID_EVAL_REPORT_PATH` 后会在整批成功时原子写入 JSON，失败不会覆盖已有报告。

## 九、一次完整运行的可复现顺序

```powershell
# 1. 从固定 archive 导入 SciFact（原始包和解压文件保留在 data/.source）
npm run eval:scifact:import

# 2. 首次编辑根目录 .env 固定评测配置（密钥只放外部环境）
notepad .env

# 3. 先用少量真实输入做预检
npm run eval:raw-hybrid:preflight:configured

# 4. 从 reviewed corpus 生成匹配的向量快照
npm run eval:raw-hybrid:prepare:configured

# 5. 运行隔离 fixture + 真实 query embedding + DeepEval 指标
npm run eval:raw-hybrid:configured

# 6. 如需同时保存过程日志和终端报告
npm run eval:raw-hybrid:configured 2>&1 |
  Tee-Object "eval-results-$(Get-Date -Format yyyyMMdd-HHmmss).log"
```

如果输入文件、Embedding 配置或快照不匹配，失败发生在检索前；如果 query embedding 失败或检索器进入 keyword-only 降级，失败发生在 `collectRawHybridEvaluation()` 的 trace 检查处。这样保存下来的报告可以明确对应一份 corpus hash、Embedding manifest 和一组 qrels，而不是一份无法追溯的排名结果。

该基线是 MyKnow 对 SciFact 文档级 raw child 的 retriever benchmark，不是生产分块 benchmark，也不代表业务质量保证。
