# 当前分块机制与结构保护

> 状态：基于当前代码的实现说明与设计复盘，包含代码块/表格结构保护优化。
>
> 审核范围：`packages/db/src/chunker.js`、`apps/worker/src/resources/processor.js`、资源导入路由，以及分块结果在数据库和检索索引中的使用方式。

## 1. 结论先行

当前分块器是一个**结构感知的两级分块器**：先生成较大的 parent，再在 parent 内生成带少量重叠的 child。检索只把 child 当作命中单元，parent 和标题路径用于补充上下文。

它的核心思想是正确的：

- 原文先规范化，分块保留原文范围和定位信息；
- 尽量在标题、段落、表格、代码块和公式等结构边界处分割；
- 小 child 负责召回，大 parent 负责恢复上下文；
- 每次处理都绑定资源版本和 processing run，旧派生结果可以被替换。

它目前仍然是一个“启发式分块器”，并不是严格的语义分块器，也不是按模型 tokenizer 精确控制的 token splitter；本轮已经把大小单位、结构边界优先级、保护结构拆分和 parent/child 职责收敛为明确协议。

## 2. 端到端数据流

```text
资源原文/解析结果
    -> canonicalText 规范化
    -> 结构画像与策略选择
    -> 结构单元识别
    -> parent 分段与打包
    -> parent 内 child 分段与 overlap
    -> canonical artifact + chunks
    -> child 写入 resource_fts，并排入 embedding 任务
```

入口在 Worker 的资源处理流程：解析器返回 `parsed.canonicalText` 后，调用 `chunkDocument`；成功后同一个事务写入 processing run、chunks、FTS 行，并为 child 排入向量任务。对应代码见 [`apps/worker/src/resources/processor.js`](../apps/worker/src/resources/processor.js)。

## 3. 规范化与定位坐标

`normalizeCanonicalText` 做两件事：

1. 去掉文本开头的 BOM；
2. 把 CRLF 和 CR 统一成 LF。

分块器随后用 `Array.from(text)` 建立字符数组。因此 `start`、`end`、`start_offset`、`end_offset` 是**规范化文本的 Unicode code point 偏移**，不是 UTF-8 字节偏移，也不是原始文件的字节位置。这样可以避免 JavaScript UTF-16 surrogate pair 把一个可见字符拆成两个偏移单位。

每个持久化 chunk 的 locator 还会记录：

- `resourceVersionId`、`processingRunId`；
- parent/child 序号；
- block 类型和页码范围（若解析器提供了 page/block 坐标）；
- 结构类型（`code` / `table` / `formula`）、保护结构组、表头和切分原因；
- 保护结构的 part 序号；
- 是否发生 `forcedSplit`；
- `sizeUnit` 和 `sizeMetrics`（正文/embedding 输入的 code point、UTF-8 字节数与估算 token 数）。

因此，分块定位的真实语义是“在某次处理产生的 canonical text 中的范围”。如果解析器版本或规范化规则改变，不能把旧 locator 直接解释为新原文坐标。

每个 chunk 还带有统一的 `canonicalMetadata`（schema `canonical-chunk-v1`）：

```text
locator  -> startOffset / endOffset / unit
structure -> blockTypes / protectedType / protectedGroup / tableHeader / splitReason / forcedSplit / part
context   -> header
relation  -> parentIndex / childIndex
overlap   -> mode / codePoints
size      -> 正文与 embedding 输入的 code point、byte、estimated token
```

## 4. 配置与默认值

默认配置定义在 [`packages/db/src/chunker.js`](../packages/db/src/chunker.js)：

| 配置 | 默认值 | 当前语义 |
| --- | ---: | --- |
| `strategy` | `auto` | 自动选择 `parser`、`heading`、`heuristic` 或 `legacy` |
| `sizeUnit` | `code_point` | 分块目标和 overlap 的规范单位；当前只接受 Unicode code point |
| `parentChunkSize` | `4096` | parent 的目标 code point 数 |
| `childChunkSize` | `384` | child 的目标 code point 数 |
| `childOverlap` | `76` | 相邻 child 的目标重叠 code point 数 |
| `maxProtectedSize` | `7500` | 代码块/公式保持原子性、表格保持行级结构的最大 code point 数 |
| `parentTokenTarget` | `null` | 可选 provider token 目标；没有真实 tokenizer 时不能使用 |
| `childTokenTarget` | `null` | 可选 embedding 输入 token 目标；没有真实 tokenizer 时不能使用 |

配置会在 API 创建资源版本时从知识库配置快照下来，Worker 再次规范化后执行。处理记录也会保存配置；因此同一资源的不同版本或不同 processing run 可以使用不同分块参数。

当前结构保护、公式拆分、尺寸度量、canonical metadata、parser block 输入与 provider token 目标对应 `chunker_version=5`。已有 chunks、FTS 和 embedding 属于旧 processing run 时，应随资源重新处理后再使用新的结构元数据。

`sizeUnit` 是刻意显式化的边界：`parentChunkSize`、`childChunkSize`、`childOverlap` 和 `maxProtectedSize` 都不是模型 token 上限。每个 chunk 额外记录 `sizeMetrics`，其中 `estimated*Tokens` 是跨语言启发式估算；若 provider 注入真实 tokenizer，还会记录 `provider*Tokens` 和 tokenizer 身份。只有真实 tokenizer 可用时，`parentTokenTarget`/`childTokenTarget` 才会启用，否则配置会明确失败，不会把通用估算伪装成严格 token 上限。

规范化规则包括：

- parent 和 child 必须是正整数，且 parent 必须大于 child；
- overlap 必须非负，并被截断到 child 大小的一半；
- `parentTokenTarget` 和 `childTokenTarget` 是可选的 provider token 目标，必须配合真实 tokenizer；
- 不认识的策略会报校验错误；
- `recursive` 当前只是兼容别名，最终映射到 `legacy`，没有独立的递归实现。

## 5. 策略选择

### 5.1 `auto`

自动策略先建立文档画像：Markdown 标题数、标题密度、启发式标记数、分页符、代码行数、表格行数和 parser block/page 数。

选择规则是：

1. 存在有效 parser block，且包含多个 block、分页边界或 `code/table/formula`：选择 `parser`；
2. Markdown 标题不少于 3 个，且标题密度大于 `0.005`：选择 `heading`；
3. 启发式标记不少于 5 个，或出现分页符：选择 `heuristic`；
4. 否则选择 `legacy`。

如果候选策略生成的 parent 没有通过覆盖范围检查，系统会继续尝试策略链，最终回退到 `legacy`。自动策略的链通常是：

```text
自动选择结果 -> parser/heading -> heuristic -> legacy
```

链中的重复项会被去掉。

### 5.2 `parser`

`parser` 接收解析器提供的 `blocks` 和 `pages`：block 的 `kind/type`、canonical `start/end`、页码和可选 heading path 会被归一化为同一套 `structurePath`。解析器范围必须是合法的 code point 区间；缺失、越界、重叠或类型错误会以 `PARSER_INPUT_INVALID` 失败，不会静默裁剪或丢弃。`code`、`table` 和 `formula` block 直接进入专用 splitter；普通 `text/paragraph` block 仍允许在同一页、同一结构路径内合并短段落。页边界和 heading path 会阻止不相关上下文被合并；跨页 block 会在页边界处分段，但共享同一个保护组身份。

`structurePath` 使用 `structure-path-v1` 的可序列化节点数组，例如：

```json
[
  { "type": "page", "pageNumber": 3 },
  { "type": "heading", "level": 2, "title": "Indexing" },
  { "type": "block", "blockType": "table" }
]
```

heading、heuristic section、parser block 和 protected continuation 都通过同一个路径渲染为 `contextHeader`，并写入 `canonicalMetadata.structure.structurePath`。

### 5.3 `heading`

只把 Markdown ATX 标题（`#` 到 `######`）作为层级边界。标题栈维护当前路径，例如：

```text
# 产品
## 检索
### 召回
```

child 会继承类似下面的 `contextHeader`：

```text
# 产品
## 检索
### 召回
```

标题本身也保留在对应 section 的正文范围内，所以标题既是上下文元数据，也是原文内容的一部分。

### 5.4 `heuristic`

对非标准 Markdown 文档，以下行会被视为 section 边界：

- 编号标题和中英文 Chapter/Section 形式；
- 分隔线；
- 形似全大写标题的行；
- 分页符。

这里的“标题”主要用于切分和生成一行 `contextHeader`，不会像 Markdown 标题一样建立完整的父子标题栈。

### 5.5 `legacy`

不按标题建立 section，直接把整个 canonical text 作为一个范围，再依据结构单元和大小目标打包。这是所有回退路径的最终策略，也是 `chunkText` 旧接口继续使用的策略。

## 6. 结构单元与切分规则

分块器先把文本拆成结构单元：

- fenced code block：三个反引号或 `~~~` 包围的代码块；
- 连续表格行及其间的空行；
- display math：`$$...$$`、`\[...\]` 和 LaTeX environment；
- Markdown 标题行；
- 普通段落；
- 空行。

打包遵循“结构边界优先，长度目标其次”的顺序。代码块和表格会被隔离成独立 chunk，不与普通文本拼接；普通文本仍可按结构单元组合到目标大小附近。

### 6.1 普通文本

普通超长文本的切点优先级如下：

1. 先把目标点限制在当前单元范围内；
2. 如果目标点落在 inline protected range 内，尝试把切点移到该范围末尾，或移到范围开始处；
3. 依次向前寻找段落边界（空行）、换行、中文/英文标点和空白；
4. 找不到安全边界时才使用目标点。

当前保护的 inline 结构包括 Markdown 链接、`$$...$$`、`\[...\]`、LaTeX 环境和单行 `$...$`。

### 6.2 代码块

代码块的目标不是强行满足 `childChunkSize`，而是优先保持可复制、可阅读的代码结构：

- 代码块长度不超过 `maxProtectedSize` 时，作为一个原子 chunk 保留，即使它大于 `childChunkSize`；
- 代码块超过 `maxProtectedSize` 时，优先按完整代码行分组，目标会自动收紧到 `min(target, maxProtectedSize)`；
- 单行本身超过目标大小时，才允许在该行内部做最后的长度切分，并标记 `forcedSplit`；
- 按完整代码行或完整表格行分组属于结构性切分，不标记 `forcedSplit`；`forcedSplit` 只表示真正打断单行、表头或无法识别结构的应急切分；
- 每个代码片段记录 `protectedType=code`、`partIndex`、`partCount` 和 `splitReason`，不会使用普通文本 overlap 跨代码边界扩展。
- 超长代码的 parent 片段共享 `protectedGroup`；完整代码对象可按 `protectedGroup`、part 序号和 locator 重组，不用未经验证的摘要替换原文。

这样 `384` 仍然是普通文本的软目标，而不是代码块的硬切刀。

### 6.3 表格

表格使用“表头 + 完整数据行”的切分模型：

- 首行和 Markdown 分隔行识别为表头；没有分隔行时，首个表格行作为表头；
- 表格块按完整数据行分组，普通边界不会落在 `| ... |` 行的中间；
- 后续表格 chunk 不复制表头到 `content`，而是把原始表头放入 `contextHeader` 和 locator 的 `tableHeader`，避免破坏 canonical text 的一一对应关系；
- 单行超过有效保护目标时，才允许在该行内部应急切分，并标记 `table-row-too-large` 和 `forcedSplit`；超长表头同理记录 `table-header-too-large`；
- 表格和普通文本之间不使用 overlap，避免检索内容出现半行或跨结构重复。
- 超长表格的 parent 片段同样共享 `protectedGroup`；表头通过 `contextHeader/tableHeader` 保留语义，原始数据行仍只在各自 locator 中出现。

表格表头因此既能参与 FTS/embedding 上下文，又不会造成数据库中的 offset 与原文不一致。

### 6.4 公式

display math 和 LaTeX environment 使用独立的 `formula` protected splitter：在 `maxProtectedSize` 内保持原子性，超限时优先按完整公式行分组；只有超长公式行或无法保持安全边界时才做强制长度切分。公式片段同样记录 `protectedType`、part 序号和 `splitReason`，不与普通文本 overlap。

## 7. Parent/child 层级

### 7.1 Parent

parent 默认目标约 4096 个 code point，是结构化原文上下文窗口，不是简单放大的 child，主要承担：

- 保留较完整的章节/段落上下文；
- 在 child 命中后供上下文组装读取；
- 作为 processing run 的结构统计对象。

parent 不会写入 `resource_fts`，也不会排入 raw chunk embedding 任务，因此不会直接参与 raw 检索排序。

### 7.2 Child

child 默认目标约 384 个 code point，默认 overlap 目标为 76 个 code point。child 是当前 raw 检索的基本对象：

- 写入 `chunks`，`chunk_type='text'`；
- 写入 `resource_fts`；
- 可生成 `retrieval_embeddings`；
- locator 指向 child 在 canonical text 中的范围；
- 记录 `parent_chunk_id`，以便命中后恢复 parent 内容。

相邻普通 child 的 overlap 只向前扩展当前 child 的起点，不改变前一个 child 的终点，也不会跨 parent 边界。代码块、表格和公式 child 不使用 overlap，也不会跨保护结构边界扩展。普通 parent 足够小、只产生一个完全相同的 child 时会省略 parent 行；超过 child 目标的 protected parent 则保留，以便保留整体对象，并通过 `protectedGroup`、part 序号和 locator 重组超长结构。

普通自然语言 child 可以合并多个短段落，但默认不跨代码、表格、公式等强结构边界；overlap 只在段落、换行、句子或词边界上生成，找不到安全边界时不强行制造重叠。

### 7.3 检索时的上下文形态

raw 检索结果由三层组成：

```text
contextHeader（标题路径、保护结构上下文）
    + parentContext（较大 parent）
    + content（实际命中的 child）
```

向量生成只使用 `contextHeader + child content`，不把 parent 全文放入向量输入；这让向量更聚焦，但也意味着 parent 中没有出现在 child/header 的信息不会帮助向量召回。`sizeMetrics.embeddingInput*` 正是对这段实际 embedding 输入的度量。

## 8. 持久化关系

| 运行对象 | 保存内容 | 用途 |
| --- | --- | --- |
| `resource_versions` | 本次版本采用的 `chunking_config` | 重现版本处理参数 |
| `processing_runs` | chunker 名称/版本、配置、输入摘要、输出摘要、parent/child 数量 | 处理审计和派生结果身份 |
| `chunks` | parent/child 层级、正文、范围、locator、策略、强制切分标记 | 检索与来源定位 |
| canonical artifact | canonical text、解析 blocks、策略画像和校验信息 | 解析结果快照与回放 |
| `resource_fts` | child 的可检索文本和标题 | 关键词召回 |
| `retrieval_embeddings` | child 的向量和输入摘要 | 可选向量召回 |

当同一资源版本重新处理时，新 processing run 先生成新的 chunks；成功后新 generation 才成为 active，旧 child 的 FTS 行被删除，旧 chunks 和旧 processing run 标记为 `superseded`。旧 embedding 允许延迟清理，但查询通过 active processing run 过滤它们。源文件本身不由分块器覆盖。

`chunking-diagnostics-v1` 会随 canonical artifact 和 `processing_runs.metrics` 保存结构统计，例如保护 block/child 数量、forced split、边界 overlap、split reason、child 大小均值和最大值。它们用于定位结构回归，不是 retrieval 质量结论。

## 9. 当前实现符合的原理

### 9.1 召回单元小、上下文单元大

这是 parent-child chunking 的基本原则。小单元通常有更高的主题纯度和更少的无关 token；大单元则能恢复定义、条件、例外和相邻说明。当前 child 负责召回、parent 负责补上下文，职责分离是合理的。

### 9.2 结构边界优先于裸长度

在标题、段落、表格、代码块和公式边界处分割，比固定长度硬切更能保持语义完整性。当前实现进一步把代码块、表格和公式变成专用切分路径：代码/公式按块与行处理，表格按表头/行处理，只有超过 `maxProtectedSize` 或单行无法容纳时才进入强制切分。

### 9.3 重叠用于缓解边界信息损失

固定长度分割可能把一句话或条件表达式切在两个 chunk 之间。有限 overlap 可以提高边界附近的召回概率。当前 overlap 受半个 child 的上限约束，并优先选择段落、换行、句子或词边界，避免重复量失控和半词开头。

### 9.4 预算单位必须可追踪

canonical offset 使用 code point，资源上传使用 UTF-8 byte limit，检索上下文使用估算 token budget。三者职责不同，不能混用；当前通过 `sizeUnit`、`sizeMetrics` 和 `estimatedTokens` 明确记录坐标，避免把字符目标误当成模型 token 目标。

### 9.5 派生数据必须绑定输入版本

chunk 的资源版本、处理运行和内容范围都被保存，且输出有 digest。这符合“原文不变、派生索引可重建”的知识库原则。

## 10. 审核发现与边界

以下是当前限制与后续优化边界。

### 高影响：大小目标不是 token 目标

`parentChunkSize`、`childChunkSize` 和 overlap 仍按 Unicode code point 计算；现在配置显式返回 `sizeUnit=code_point`，并为每个 chunk 记录 code point、UTF-8 byte 和启发式 estimated token 度量。中文、英文、代码、数学公式和不同模型的真实 token 密度仍然不同，因此同一个 `384` 对不同材料的上下文容量并不等价；当前没有把 code point 伪装成模型 token。

检索侧的 token 估算已按 Han、拉丁/数字串、emoji、空白和符号区分，但仍只是预算近似。inline protected range 和结构保护为避免被切开，也可能使实际 chunk 大于普通目标；目标是结构优先的软上限，不是严格 provider token 上限。

### 高影响：保护结构仍受最大尺寸约束

代码块、表格和公式现在有专用切分路径：在 `maxProtectedSize` 内保持原子性，超限代码/公式按完整行分组，表格按完整数据行分组；后续表格块通过 `contextHeader` 重复表头语义，而不重复正文。只有超长单行、超长表头/公式行或无法识别结构时才会进入强制长度切分，并记录 `forcedSplit` 与 `splitReason`。

因此 `protected` 的准确含义是“优先保持结构边界”，不是在无限大小下保证永不切分。`maxProtectedSize` 是内存、embedding 输入和检索可处理性的上限。

### 中影响：启发式结构没有统一的层级模型

Markdown 标题有层级栈，启发式标题只有 section 边界和一行 header，legacy 没有结构 header。相同语义的文档如果格式稍有变化，得到的 `contextHeader` 形态可能完全不同，影响 embedding 和上下文一致性。

### 中影响：自动策略阈值是格式启发式，不是语义判断

标题数量、标题密度、分页符和全大写行不能可靠判断文档的语义结构。例如标题很少但段落边界清晰的长文会走 legacy；扫描 PDF 产生的分页符又可能制造过多 section。策略选择没有使用解析器提供的 block 语义作为第一等输入。

### 中影响：重处理身份与旧派生数据需要持续治理

新 run 会替换 active FTS/chunk，但旧 embedding 行由版本化的 owner 继续保留，查询通过 active run 过滤它们。现在由 `DERIVED_DATA_RETENTION_DAYS` 定义保留窗口，并通过显式 `db:cleanup-derived` 命令清理过期派生结果；processing run 和审计记录仍保留。

### 低影响：存在多个大小坐标体系

分块 offset、目标大小和 preview 输入校验按 code point，Wiki 内容上限按 UTF-8 byte，检索上下文又使用估算 token 数。它们职责不同且已明确记录，但对用户展示“字符数/大小”和定位边界的含义仍不完全统一。

## 11. 已确定的分块协议

1. 大小规范单位是 Unicode code point；token 只作为模型侧二级预算约束，不能把通用估算当成 provider 的严格 token 上限。
2. parent 是结构化原文上下文窗口，不是简单放大的 child；它保留章节、段落和保护结构的组合上下文。
3. child 默认不跨代码、表格、公式等强结构边界；普通自然语言可以在安全边界内合并多个短段落。
4. 表格、代码和公式使用专用 splitter；超长结构按行/数据行拆分，并保留整体 parent 对象，不生成未经验证的摘要替代原文。
5. overlap 按段落、换行、句子或词边界生成；没有安全边界时宁可不重叠，不做机械固定字符回退。
6. 所有 chunk 使用 `canonical-chunk-v1` metadata，统一记录 locator、structure、context、relation、overlap 和 size。
7. 重分块以 processing run 作为 generation 切换边界：新 generation 成功后才成为 active，旧 embedding 可以延迟清理，但始终被 active run 过滤。
8. 下游 retrieval 指标是最终质量指标；chunk 大小、边界、protected/forced split 和 overlap 数量只作为结构诊断指标。

## 12. 下一轮改善计划

### P0：本轮已落地

- 用 `sizeUnit=code_point` 明确分块目标单位；locator 和 preview 不再把目标描述成 token。
- 记录正文与 embedding 输入的 `sizeMetrics`，包括 code point、UTF-8 byte 和 estimated token。
- protected 结构的有效目标为 `min(target, maxProtectedSize)`；完整代码行/表格行分组不算 `forcedSplit`，只有真正打断结构才算。
- 处理身份升级到 `chunker_version=5`，旧派生数据通过重新处理进入新协议。
- 代码、表格和公式的结构诊断摘要随 canonical artifact 与 processing run 保存，作为诊断指标，不替代 retrieval 质量指标。

### P1：已完成

1. 标题、heuristic section、解析器 block、页边界和 protected continuation 统一为可序列化的 `structurePath`，所有 chunk 使用相同的 canonical metadata 位置。
2. `auto` 在存在有效 parser blocks、分页或 strong structure 时优先选择 `parser`；文本启发式仅作为解析器信息不足时的回退。
3. embedding provider 暴露可选 `tokenizer` seam。只有注入真实 `countTokens(text)` 的 provider 才能使用 `parentTokenTarget`/`childTokenTarget`；Worker/API 默认不伪造 tokenizer，未注入时继续以 code point 为 canonical 单位并保留启发式 token 观测。
4. `DERIVED_DATA_RETENTION_DAYS` 默认 30 天；`npm run db:cleanup-derived -- --dry-run` 只预览，实际清理必须显式加 `--confirm`。命令清理过期 superseded 或已不再属于当前 resource version 的 indexed generation 的 chunks、resource/wiki FTS、旧 embedding、retrieval trace 和 canonical artifact；仍有活动 embedding task 的 generation 会跳过，不删除原始资源、resource version 或 audit log。

清理不会删除 `processing_runs` 与 `processing_run_attempts`，因为它们仍是处理审计和 generation 身份；不再是当前 resource version 的 indexed/superseded run 也会进入候选，仍有 queued/running/retrying embedding task 的 run 会被跳过，避免 Worker 后续读取不到 chunk。canonical 文件删除失败会返回 storage error，CLI 以非零状态退出，便于重试；旧派生结果会从 active 检索中排除，之后可按保留周期清理。

## 13. 相关代码

- [`packages/db/src/chunker.js`](../packages/db/src/chunker.js)：规范化、策略选择、结构单元、parent/child 生成。
- [`apps/worker/src/resources/processor.js`](../apps/worker/src/resources/processor.js)：处理 run、artifact、chunks、FTS 和 embedding 任务的落库。
- [`apps/api/src/routes/knowledge-bases.js`](../apps/api/src/routes/knowledge-bases.js)：知识库级分块配置。
- [`apps/api/src/routes/resources.js`](../apps/api/src/routes/resources.js)：资源版本快照和 chunk preview。
- [`packages/db/src/database/migrations.js`](../packages/db/src/database/migrations.js)：`processing_runs`、`chunks`、`resource_fts` 等表结构。
