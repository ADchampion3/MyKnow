# MyKnow 分块机制

本文记录当前生效的文档规范化、父子分块、检索索引和重建语义。实现以 [`packages/db/src/chunker.js`](../packages/db/src/chunker.js) 为准；如果本文与代码不一致，应先修正本文或明确记录设计变更。

## 1. 目标与范围

分块的目标是同时满足：

- 保留原材料的可追溯性和 Unicode 定位信息；
- 让检索子块足够小，降低召回噪声；
- 让父块保留章节上下文，供结果展示和后续生成使用；
- 尽量不切断代码、表格、LaTeX、链接和图片引用；
- 让同一输入、同一配置得到确定性的分块结果；
- 允许通过 processing run 对解析、分块和索引结果进行审计与重建。

当前只实现文本分块和 SQLite FTS5 关键词检索，不包含向量 embedding 或向量索引。

## 2. 处理流程

```text
不可变原始材料
    │
    ▼
MaterialReader
    │  canonicalText / blocks / metadata / quality
    ▼
规范化配置与文本
    │
    ▼
文档画像 + 策略选择
    │
    ▼
父级分块（章节/启发式/legacy）
    │
    ▼
子级分块（legacy packing + overlap）
    │
    ├── canonical/<versionId>/<runId>.json
    ├── chunks：parent_text + text
    └── resource_fts：只写入 text 子块
```

一次完整处理对应一个 `processing_run`。只有处理成功的 run 才能成为 `resource_versions.active_processing_run_id`，搜索始终限制在当前 active run。

## 3. 默认配置

配置字段保存在知识库的 `chunking_config` 中；导入时复制到资源版本，单次 `reprocess` 可以覆盖版本配置。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `strategy` | `auto` | 策略选择方式 |
| `parentChunkSize` | `4096` | 父块目标大小，单位为 Unicode code point |
| `childChunkSize` | `384` | 子块目标大小，单位为 Unicode code point |
| `childOverlap` | `76` | 相邻子块重叠大小，最大自动限制为子块大小的一半 |
| `maxProtectedSize` | `7500` | 保护结构允许整体保留的最大大小 |

约束：

- `parentChunkSize` 和 `childChunkSize` 必须为正整数；
- `parentChunkSize` 必须大于 `childChunkSize`；
- `childOverlap` 必须为非负整数；超出上限时会被限制，而不是产生非法配置；
- 支持 `auto`、`heading`、`heuristic`、`legacy`；`recursive` 是兼容名称，会映射到 `legacy`。

## 4. 文本规范化与偏移

`normalizeCanonicalText` 在分块前执行：

1. 移除开头 UTF-8 BOM；
2. 将 CRLF 和单独 CR 统一为 LF；
3. 不做 `trim`，保留正文中的前后空白和换行结构。

所有 `startOffset`、`endOffset` 都是从零开始的半开区间 `[start, end)`，单位是 Unicode code point，而不是 JavaScript UTF-16 code unit。

例如 `A😀B` 的 code point 位置是：

```text
A  -> [0, 1)
😀 -> [1, 2)
B  -> [2, 3)
```

这样中文、emoji 等非 BMP 字符不会造成定位偏移。当前实现使用 `Array.from(text)` 计算偏移；这是本地 MVP 的确定性实现，超大文档后续可升级为流式 segmenter。

## 5. 文档画像与策略选择

### 5.1 `auto` 选择

`auto` 先生成文档画像：Markdown 标题数量、标题密度、启发式标记数量、分页符、代码行和表格行。

选择规则：

1. 标题数量至少 3 且标题密度大于 `0.005`：选择 `heading`；
2. 启发式标记至少 5 个，或存在分页符 `\f`：选择 `heuristic`；
3. 其他文档：选择 `legacy`。

### 5.2 降级链

每个候选策略都会经过覆盖和边界校验：

- `auto`：`选中策略 → heading → heuristic → legacy`，去重后执行；
- 显式 `heading` 或 `heuristic`：`指定策略 → legacy`；
- 显式 `legacy`：只执行 `legacy`。

如果候选策略不能覆盖全文、产生空块、出现间隙/异常重叠，或长文档错误地产生单一大块，则继续尝试下一策略。最终结果的 `strategy` 和 `strategyChain` 会写入 canonical artifact 与 processing run。

### 5.3 三种实际策略

#### `heading`

识别 Markdown ATX 标题（`#` 至 `######`），按标题层级维护上下文栈。子块的 `contextHeader` 会包含当前章节路径，例如：

```text
# 产品
## 导入
```

正文子块会携带 `#1 产品\n#2 导入` 作为上下文，但原始正文 `content` 不被改写。

#### `heuristic`

用于没有规范 Markdown 标题的材料，识别：

- 编号标题；
- 视觉分隔线；
- 全大写标题；
- 分页符。

启发式边界会产生上下文标题，之后仍使用统一的安全 packing。

#### `legacy`

以段落、空行和保护结构为基本单元，在目标大小附近寻找空白或标点边界。它是最终兜底策略，也是父块内部生成子块时使用的策略。

## 6. 结构保护与强制切分

普通切分路径会保护以下结构：

- fenced code：````` 和 `~~~` 包围的代码块；
- Markdown table：包含多个 `|` 的连续表格行；
- Markdown link/image：`[text](url)`、`![alt](url)`；
- display LaTeX：`$$...$$`、`\[...\]`；
- LaTeX environment：`\begin{...}...\end{...}`；
- inline LaTeX：单行 `$...$`。

切点优先向空白或常见标点移动；如果保护单元过大，无法在 `maxProtectedSize` 内完整保留，则允许强制切分。此时：

- 输出对象记录 `forcedSplit: true`；
- 数据库字段记录 `forced_split = 1`；
- locator 中记录 `forcedSplit: true`，便于审计和质量分析。

## 7. 父子分块模型

### 7.1 父块

父块以章节或启发式区域为上下文边界，再按 `parentChunkSize` packing。数据库中保存为：

```text
chunks.chunk_type = 'parent_text'
```

父块保留较大的上下文，默认目标大小为 4096 code points。父块不写入 FTS。

### 7.2 子块

每个父块内部使用 `legacy` packing，目标大小默认为 384 code points，相邻子块默认重叠 76 code points。重叠会优先从空白处开始，避免从单词或标点中间切入。

子块数据库字段：

```text
chunks.chunk_type = 'text'
chunks.parent_chunk_id = <parent row id> | NULL
```

如果一个父块本身就是一个完全相同的单一子块，则不额外创建父块行，子块的 `parent_chunk_id` 为 `NULL`，避免无意义重复存储。

每个 processing run 内的 `sequence` 是全局递增序号；输出顺序确定，但数据库 ID 仍使用 UUID。

### 7.3 父子关系示意

```text
resource_version
└── processing_run
    ├── parent_text  (#1 导入 / 章节内容)
    │   ├── text child 0
    │   ├── text child 1  ← 与 child 0 有 overlap
    │   └── text child 2
    └── parent_text  (#2 搜索 / 章节内容)
        ├── text child 0
        └── text child 1
```

## 8. 持久化与检索

### 8.1 canonical artifact

Worker 在写入 chunks 前保存：

```text
canonical/<resourceVersionId>/<processingRunId>.json
```

artifact 至少包含：

- `canonicalText`；
- `blocks`；
- `assets`；
- reader metadata 和 quality；
- `strategy`、`strategyChain`、`validation`、`profile`。

它是可审计的规范化中间结果，不替代不可变原始材料。

### 8.2 SQLite chunks

`chunks` 保存：

- 资源版本和 processing run；
- 父子关系和 chunk type；
- 正文、上下文标题；
- code-point 起止偏移；
- locator、策略和 forced split 标记；
- `active` 或 `superseded` 状态。

重新处理不会物理删除旧 chunk，而是将旧 run 的 chunks 标记为 `superseded`。

### 8.3 FTS5

`resource_fts` 只索引 `chunk_type='text'` 的子块。索引正文是：

```text
contextHeader + "\n\n" + child.content
```

搜索必须同时满足：

- 子块状态为 `active`；
- 子块属于版本当前的 `active_processing_run_id`；
- 可选的知识库和资源版本范围过滤；
- 返回匹配子块，并通过 `parent_chunk_id` 回填 `parent_content`。

因此父块负责上下文，子块负责召回，旧 run 不会污染当前搜索结果。

## 9. 配置与控制接口

| 接口 | 作用 |
|---|---|
| `POST /api/knowledge-bases` | 创建知识库并保存 chunking config |
| `PATCH /api/knowledge-bases/:id` | 修改知识库默认分块配置 |
| `POST /api/resources/:id/chunk-preview` | 对输入文本预览策略、blocks、父子块和诊断；不写 DB/FTS |
| `POST /api/resources/:id/reprocess` | 重新处理指定资源版本，可覆盖本次 chunking config |
| `POST /api/resources/rebuild` | 将所有派生 chunks/FTS 标记为需重建并重新排队 |
| `GET /api/resources/:id/processing-runs` | 查看处理 run 和 reader attempts |
| `GET /api/resources/:id/processing-runs/:runId/canonical` | 读取 canonical artifact |

全量重建只影响派生数据。原始字节、资源版本和审计日志保留。

## 10. 验证与证据

运行：

```powershell
npm run check:chunker
npm run check:worker
npm run check:api
npm run trace:chunks
```

相关实现和证据：

- 分块实现：[`packages/db/src/chunker.js`](../packages/db/src/chunker.js)
- 分块断言：[`packages/db/src/chunker-check.js`](../packages/db/src/chunker-check.js)
- Worker 落库：[`apps/worker/src/resources/processor.js`](../apps/worker/src/resources/processor.js)
- 搜索查询：[`apps/api/src/routes/search.js`](../apps/api/src/routes/search.js)
- 表结构：[`packages/db/src/schema.js`](../packages/db/src/schema.js)
- 分块 trace：[`artifacts/sprint2/chunk-trace.jsonl`](../artifacts/sprint2/chunk-trace.jsonl)

当前 raw-source 合同不接收公网 URL；PDF/MarkItDown 与混合 fixture 的扩展证据属于 Sprint 3 选择性工作，见 [`SPRINT3_BACKLOG.md`](../SPRINT3_BACKLOG.md)。
