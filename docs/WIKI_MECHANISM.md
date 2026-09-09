# 当前 Wiki 机制

> 状态：基于当前代码的实现说明与机制复盘
>
> 更新时间：2026-09-09
>
> 范围：Wiki 页面、版本、block、模板、引用、Wiki link、检索投影、embedding，以及 Agent 生成和审核 Wiki 变更的完整链路。

## 1. 结论先行

MyKnow 的 Wiki 不是原始资料的覆盖层，也不是向量索引本身，而是建立在原始资料之上的、可版本化的结构化知识层：

```text
原始资源 / resource version
    -> processing run / canonical text / Raw child chunk
    -> 人或 Agent 组织出 Wiki page version
    -> blocks / citations / Wiki links / tags
    -> FTS、link graph、embedding 等可重建投影
    -> RAG retrieval run
```

核心不变量如下：

1. 原始资源和资源版本不被 Wiki 编辑覆盖；Wiki 只引用它们。
2. Wiki 页面内容不原地改写；内容改变会创建新的 `wiki_page_version`。
3. 检索只消费当前有效版本和当前有效派生索引，不直接修改 Wiki。
4. Agent 可以读取和提出变更，但不能直接写入 Wiki；Wiki 写入必须经过计划审核。
5. 审核、版本、引用、diff、应用状态和回滚记录分别保存在不同的持久化对象中，而不是只保留最终页面。

产品原则在 [`PRD.md:13-15`](../PRD.md:13) 和 [`PRD.md:49-51`](../PRD.md:49) 中定义；领域词汇使用 [`CONTEXT.md`](../CONTEXT.md) 中的 `retrieval run`、`provenance lookup`、`context snapshot`、`canonical text` 和 `derived data retention`。

## 2. Wiki 的持久化模型

### 2.1 页面身份和页面内容是两层对象

数据库把页面身份和页面内容拆开：

| 对象 | 作用 | 关键字段 |
| --- | --- | --- |
| `wiki_pages` | 页面身份和当前指针 | `knowledge_base_id`、`space_id`、`parent_page_id`、`slug`、`title`、`page_type`、`status`、`current_version_id` |
| `wiki_page_versions` | 一次不可变的页面内容 | `page_id`、`parent_version_id`、`template_version_id`、`content_markdown`、`content_sha256`、`change_summary`、`restore_of_version_id` |
| `wiki_page_blocks` | 某个页面版本解析出的结构单元 | `page_version_id`、`block_key`、`block_type`、`ordinal`、`heading_path`、`content_markdown`、`content_sha256` |
| `wiki_templates` / `wiki_template_versions` | 页面类型的结构模板 | `page_type`、当前模板版本和 JSON 定义 |
| `wiki_citations` | Wiki block 到原始资源版本的引用 | `page_version_id`、`block_key`、`resource_version_id`、`locator_json`、状态 |
| `wiki_page_citations` | Wiki block 到另一个 Wiki 页面版本的引用 | `page_version_id`、`source_page_version_id`、`source_block_key`、状态 |
| `wiki_fts` | 当前页面版本的全文检索投影 | `page_id`、`page_version_id`、标题和 searchable text |
| `wiki_link_edges` | 从 Markdown `wiki://...` 链接解析出的图边 | 来源页面/版本、目标页面、链接文本 |
| `wiki_page_tags` | 页面和已有标签的关系 | `page_id`、`tag_id` |

对应 schema 定义见 [`packages/db/src/schema.js:45`](../packages/db/src/schema.js:45) 和 SQLite 建表迁移 [`packages/db/src/database/migrations.js:45`](../packages/db/src/database/migrations.js:45)。

这里最重要的字段是 `wiki_pages.current_version_id`：它表示页面当前对用户和检索可见的内容版本。旧版本仍然保留，但不再作为当前页面直接返回，也不会进入当前 Wiki FTS/embedding 查询。

### 2.2 页面类型和系统页面

普通 Wiki 页面类型由 [`packages/db/src/wiki.js:5`](../packages/db/src/wiki.js:5) 定义：

- `concept`：概念页；
- `entity`：实体页；
- `source-summary`：来源资料摘要页；
- `synthesis`：综合或推导页。

`index` 和 `log` 是系统页面类型。它们用于 Wiki 导航和系统日志，不是普通知识内容：

- 创建系统页时状态为 `system`；
- 检索投影明确排除 `index`、`log`；
- Wiki link 目标也排除这两类页面。

类型校验和系统页初始化分别位于 [`packages/db/src/wiki.js:5-7`](../packages/db/src/wiki.js:5) 和 [`apps/api/src/routes/wiki.js:40-68`](../apps/api/src/routes/wiki.js:40)。

### 2.3 模板只提供结构，不替代页面版本

每个知识库会为普通页面类型维护一个 Wiki template。模板由 section 列表组成，服务端会校验 section 数量、标题唯一性、标题长度、是否必填和描述长度；默认定义和 Markdown 初始内容生成逻辑见 [`packages/db/src/wiki.js:9-100`](../packages/db/src/wiki.js:9)。

创建页面时，系统把当前模板版本 ID 写入初始 `wiki_page_version.template_version_id`，并用模板生成默认 Markdown（除非请求显式提供内容）。模板更新只创建新的 `wiki_template_version` 并移动模板当前指针，不会改写已经存在的页面：[`apps/api/src/routes/wiki.js:432-455`](../apps/api/src/routes/wiki.js:432)。

### 2.4 Wiki 是持久化知识层，索引是派生层

页面版本、blocks、citations、审核状态和审计事件属于需要保留的业务事实。`wiki_fts`、`wiki_link_edges`、`retrieval_embeddings` 则是可以重建的 derived data：

- 页面内容和版本仍在时，可以重建 FTS 和 link graph；
- embedding 任务可以重新排队；
- 派生数据清理不会删除原始资源、resource version、processing run、Wiki 版本或 audit log。

派生数据保留和清理规则见 [`packages/db/src/derived-cleanup.js:70-139`](../packages/db/src/derived-cleanup.js:70) 及 [`docs/RETRIEVAL_MECHANISM.md:319`](../docs/RETRIEVAL_MECHANISM.md:319)。

### 2.5 原始资源是否参与 Wiki

知识库有 `wiki_default_mode`，资源可以用自己的 `wiki_mode` 覆盖它。当前支持：

- `enabled`：资源可以出现在 Wiki overview 的候选来源中；
- `retrieval-only`：资源仍可作为 Raw child chunk 参与检索，但不作为 Wiki 整理候选；
- 资源没有单独设置时，继承知识库默认值。

候选资源查询使用最终生效的 mode，并只返回 `enabled` 资源：[`apps/api/src/routes/wiki.js:285`](../apps/api/src/routes/wiki.js:285)。资源和知识库的 mode 更新是 metadata 操作，不会自动生成或修改 Wiki 页面；它只是决定资源能否进入 Wiki 组织流程。对应的配置更新入口见 [`apps/api/src/routes/knowledge-bases.js:18`](../apps/api/src/routes/knowledge-bases.js:18) 和 [`apps/api/src/routes/resources.js:228`](../apps/api/src/routes/resources.js:228)。

## 3. 页面创建、编辑和版本生命周期

### 3.1 创建页面

普通用户创建页面的入口是 `POST /api/knowledge-bases/:id/wiki/pages`，实现位于 [`apps/api/src/routes/wiki.js:345-422`](../apps/api/src/routes/wiki.js:345)。主要步骤是：

1. 确认知识库有效，并检查 `spaceId` 和 `parentPageId` 属于同一个知识库且未归档。
2. 校验标题、slug、页面类型，并取得该页面类型的当前模板。
3. 生成页面 ID 和初始页面版本 ID。
4. 将初始 Markdown 解析为 blocks。
5. 在同一个事务中写入页面、页面版本、blocks、引用。
6. 将 `wiki_pages.current_version_id` 指向初始版本。
7. 更新 Wiki FTS/link projection。
8. 为当前页面版本排入 embedding 任务。
9. 写入 `created / wiki_page` 审计事件。

事务边界可以从 [`apps/api/src/routes/wiki.js:401-413`](../apps/api/src/routes/wiki.js:401) 看出。页面创建不是“先写页面、之后再补内容”的两阶段对象；初始版本和页面身份一起成立。

普通用户直接创建页面不经过 Agent 计划审核，这是有意的：用户本身就是该次写入的决策者。Agent 生成的页面创建则必须先进入 `agent_plan_items`，见第 8 节。

### 3.2 内容编辑不是原地 UPDATE

内容版本入口是 `POST /api/wiki/pages/:id/versions`，而页面元数据入口是 `PATCH /api/wiki/pages/:id`：

- `PATCH` 只允许改标题、slug、空间和父页面等 metadata，不允许把 Markdown 内容混入 metadata 更新；
- 新内容必须通过版本接口提交；
- 版本接口要求调用方提供 `baseVersionId`；
- `baseVersionId` 必须等于页面当前的 `current_version_id`，否则返回 `WIKI_VERSION_CONFLICT`。

元数据限制见 [`apps/api/src/routes/wiki.js:459-492`](../apps/api/src/routes/wiki.js:459)，版本和并发校验见 [`apps/api/src/routes/wiki.js:494-512`](../apps/api/src/routes/wiki.js:494)。

新版本的写入过程由 `insertPageVersion` 完成：

```text
校验 baseVersionId
    -> 解析 Markdown blocks
    -> 计算 content_sha256
    -> 插入新的 wiki_page_version
    -> 插入或复制 citations
    -> 更新 wiki_pages.current_version_id
    -> 更新 FTS / Wiki link projection
    -> 排入当前 page version 的 embedding
    -> 写入 version_created 审计事件
```

实现见 [`apps/api/src/routes/wiki.js:244-268`](../apps/api/src/routes/wiki.js:244)。`wiki_page_versions` 的内容摘要由 Markdown 本身计算，而不是由模型提供：[`apps/api/src/routes/wiki.js:268`](../apps/api/src/routes/wiki.js:268)。

因此页面历史不是一组“当前内容的编辑日志”，而是一条可读取的不可变版本链：

- `parent_version_id` 指向编辑前的版本；
- `change_summary` 描述这次变更；
- `restore_of_version_id` 表示该版本是对某个旧版本的恢复；
- 当前指针只在页面身份对象上变化。

### 3.3 引用的复制和替换

提交新版本时：

- 未提供 `citations` 时，系统把旧版本的资源引用和 Wiki 引用复制到新版本；
- 显式提供 `citations` 时，系统重新校验并写入新的引用集合。

复制逻辑见 [`apps/api/src/routes/wiki.js:221-242`](../apps/api/src/routes/wiki.js:221)。这意味着旧版本的 citation 状态（例如 `needs_review` 或 `broken`）在默认复制时也会保留，而不是因为页面重新保存就自动变成 `active`。

### 3.4 恢复版本也是一次新版本

`POST /api/wiki/pages/:id/restore` 不会删除当前版本，也不会把页面指针直接改回旧版本。它读取待恢复版本的内容，再以当前版本为 `baseVersionId` 创建一个新版本，并写入 `restore_of_version_id`：

- 恢复仍然受并发检查保护；
- 历史版本继续可读；
- 新版本会重新建立 blocks、投影和 embedding 任务。

实现见 [`apps/api/src/routes/wiki.js:526-541`](../apps/api/src/routes/wiki.js:526)。

### 3.5 Diff 是版本之间的派生视图

Wiki diff 使用 `diffMarkdown(before, after)` 对两个版本的 Markdown 做行级比较，代码位于 [`packages/db/src/wiki.js:214-239`](../packages/db/src/wiki.js:214)。diff 不是新的事实表，而是由两个不可变版本计算出的审阅视图。Agent 计划会提前保存同样意义上的 `diff_json`，让审核者在应用前查看变更。

## 4. Markdown 到 block 的解析

### 4.1 block 的来源

`parseMarkdownBlocks` 在 [`packages/db/src/wiki.js:104-147`](../packages/db/src/wiki.js:104) 中完成基础结构解析：

- Markdown 标题（`#` 到 `######`）会关闭前一个 block，并创建一个 `heading` block；
- 非空、但不在标题下的内容会创建普通 `markdown` block；
- `headingPath` 记录标题层级路径，例如 `知识库 / 检索 / Wiki`；
- 每个 block 保存 `ordinal`、内容 Markdown 和内容 SHA-256；
- 空页面也会得到一个空的 fallback block，避免页面没有可引用结构。

block key 是由 `blockType`、`headingPath` 和 `ordinal` 计算出的摘要：

```js
blockKey = sha256(JSON.stringify({ blockType, headingPath, ordinal })).slice(0, 32)
```

实现见 [`packages/db/src/wiki.js:102-123`](../packages/db/src/wiki.js:102)。因此 `blockKey` 是“某个页面版本中的结构定位”，不是跨任意版本永远稳定的段落 ID；如果标题层级或顺序改变，引用应当以新版本重新校验。

### 4.2 block 为什么是引用边界

资源 citation 可以指定 `blockKey`，表示该引用支持页面中的哪一个 block。写入时系统会用当前页面版本解析出的 block key 集合校验它是否存在：

- 普通 Wiki API 在 [`apps/api/src/routes/wiki.js:205-218`](../apps/api/src/routes/wiki.js:205) 校验；
- Agent 计划在 [`packages/db/src/agent.js:264-302`](../packages/db/src/agent.js:264) 重新校验；
- 读取页面时 blocks 和 citations 一起返回，见 [`packages/db/src/agent.js:215-223`](../packages/db/src/agent.js:215)。

这使得审核者可以回答两个不同问题：

1. 这条引用指向哪个原始资料位置？
2. 这条引用支撑页面中的哪个具体 block？

## 5. Citation 和来源完整性

### 5.1 两种来源关系

Wiki 有两种 citation：

```text
Wiki page version / block
    ├── wiki_citations       -> resource version + locator
    └── wiki_page_citations  -> another Wiki page version + source block
```

`wiki_citations` 是“Wiki block 到原始资料”的 provenance；`wiki_page_citations` 是“Wiki block 到另一个 Wiki 版本”的结构化引用。两者的 schema 见 [`packages/db/src/schema.js:60-64`](../packages/db/src/schema.js:60)。

当前普通 Wiki 的 `POST /api/wiki/pages/:id/citations` 入口只接受资源 citation（输入必须包含 `resourceVersionId`）；Wiki-to-Wiki citation 可以被读取和复制，但新的 Wiki-to-Wiki citation 主要由 Agent 计划应用路径写入。前者见 [`apps/api/src/routes/wiki.js:543-566`](../apps/api/src/routes/wiki.js:543)，后者见 [`packages/db/src/agent.js:603-616`](../packages/db/src/agent.js:603)。

### 5.2 原始资料 citation 的服务端校验

API 侧的 `citationInput` 会检查：

1. 引用是对象，且包含 `resourceVersionId`。
2. 资源版本确实属于当前知识库。
3. `blockKey`（如果提供）存在于目标页面版本。
4. locator 至少包含一种受支持的位置字段。
5. offset、页码、chunk、block 等字段类型和值域有效。
6. 如果源文件可读取，则检查文件大小和 SHA-256 是否与 `resource_version` 中的记录一致；如果 API 当下无法读取源文件，当前接口可能只能用已知的 page/chunk/page-count 边界校验 locator，后续 impact scan 才会把缺失源文件标记为 `broken`。

入口见 [`apps/api/src/routes/wiki.js:205-218`](../apps/api/src/routes/wiki.js:205)，locator 规则和来源边界见 [`packages/db/src/wiki.js:161-212`](../packages/db/src/wiki.js:161)。支持的 locator 形式包括：

- `startOffset` / `endOffset`；
- `page`、`pageStart`、`pageEnd` 或 `pages`；
- `lineStart` / `lineEnd`；
- `chunkId`、`blockId` 或受限的 `selector`。

对文本资源，offset 的语义是规范化 `canonical text` 的 Unicode code point 范围，不是原始 UTF-8 字节偏移。这个边界和 Raw child chunk 的定位规则由分块/检索文档定义：[`docs/CHUNKING_MECHANISM.md`](../docs/CHUNKING_MECHANISM.md)。

### 5.3 Agent citation 的更严格约束

Agent 输出的每个 citation 必须明确选择一种来源：

- 一个 `resourceVersionId`；或
- 一个选定范围内的 `wikiPageVersionId`。

不能同时指定两类来源，也不能两类都不指定。资源 citation 必须属于 Agent 的 scope，若指定 `chunkId`，该 chunk 必须属于被引用的 resource version；Wiki citation 的 `sourceBlockKey` 必须存在于被引用的 Wiki page version。[`packages/db/src/agent.js:264-302`](../packages/db/src/agent.js:264)

这一步很关键：模型可以提出“看起来合理”的引用，但最终能否落库由数据库中的版本、范围和 locator 关系决定。

### 5.4 Citation 状态和影响扫描

资源 citation 的状态是：

- `active`：引用仍指向当前有效资源版本，且 locator/source integrity 有效；
- `needs_review`：资源已有更新版本，旧引用仍可能正确，但需要人确认；
- `broken`：源文件缺失、摘要不匹配、locator 越界或目标 chunk/block 不存在。

状态定义见 [`packages/db/src/wiki.js:5-7`](../packages/db/src/wiki.js:5)。资源重处理完成后，Worker 会排入 impact scan；`scanWikiImpacts` 遍历同一资源族的 `wiki_citations`，执行完整性检查，再按当前资源版本更新状态：[`packages/db/src/wiki.js:262-279`](../packages/db/src/wiki.js:262)。

新建 citation 时数据库默认先写成 `active`；因此在尚未完成 impact scan、或源存储暂时不可读的瞬间，`active` 更准确地表示“最近一次写入/检查结果”，而不是永久的完整性保证。

Wiki overview 会把 `wiki_citations` 和 `wiki_page_citations` 的待复核数量都统计出来，见 [`apps/api/src/routes/wiki.js:131-148`](../apps/api/src/routes/wiki.js:131)。但当前影响扫描函数的查询对象只有 `wiki_citations`；代码中没有看到 Wiki 页面版本变化后对 `wiki_page_citations` 做同等自动重检。因此 Wiki-to-Wiki 引用虽然有状态字段，自动失效传播还不完整。

## 6. Wiki link、全文检索和 embedding 投影

### 6.1 Wiki link 的来源

Wiki link 使用 `wiki://<page-id>` 形式。Markdown 中的 link 目标由 [`packages/db/src/wiki.js:242`](../packages/db/src/wiki.js:242) 和 [`packages/db/src/retrieval.js:553-570`](../packages/db/src/retrieval.js:553) 解析。

投影时系统只接受以下目标：

- 与来源页面属于同一知识库；
- 目标页面未归档；
- 目标不是 `index` 或 `log` 系统页；
- 目标不是来源页面自身。

边的身份包含来源页面、来源页面版本、目标页面和 link 文本，所以同一个页面不同版本的链接关系可以被区分。

### 6.2 更新单个页面的检索投影

`updateWikiSearchProjection` 更新一个页面时先删除该页面旧的 `wiki_fts` 行和旧的 `wiki_link_edges`，再按当前页面版本重新插入：

```text
删除 page_id 对应的 FTS 行和出边
    -> 读取 wiki_pages.current_version_id
    -> 写入 title + current Markdown 的 searchableText
    -> 解析 wiki:// 链接
    -> 写入当前 page version 的 link edges
```

实现见 [`packages/db/src/retrieval.js:572-593`](../packages/db/src/retrieval.js:572)。页面归档、系统页面或没有当前版本时不会被写入普通 Wiki 检索投影。

系统也支持从数据库事实全量重建投影：[`packages/db/src/retrieval.js:595-610`](../packages/db/src/retrieval.js:595)。这说明 FTS 和 link graph 是 derived data，而不是 Wiki 内容的唯一来源。

### 6.3 Wiki embedding

Wiki embedding 是异步派生任务，不阻塞页面版本的持久化。页面版本创建、恢复、元数据更新和 Agent 应用页面后，都会为当前页面排入 embedding 任务；代码入口分别见 [`apps/api/src/routes/wiki.js:244-268`](../apps/api/src/routes/wiki.js:244) 和 [`packages/db/src/agent.js:619-701`](../packages/db/src/agent.js:619)。

Embedding worker 读取页面标题和当前版本内容，按输入摘要、provider、model 和维度缓存/复用结果；Wiki 与 Raw child 的异步 embedding 逻辑见 [`apps/worker/src/retrieval/embeddings.js:10-40`](../apps/worker/src/retrieval/embeddings.js:10)。

因此页面写入的即时一致性和向量检索的一致性是两件事：

- 页面版本、blocks、引用和 Wiki FTS/link projection 在写入事务中更新；
- embedding 在 Worker 中异步完成；
- embedding 不可用时，检索可以退化到关键词通道，而不是把页面版本回滚。

## 7. Wiki 如何进入 RAG

### 7.1 Wiki 检索对象是当前页面版本

Wiki 关键词查询和向量查询都在 SQL 阶段硬过滤：

- 指定知识库；
- 可选指定空间；
- 页面为 active；
- 页面类型不是 `index` / `log`；
- `wiki_pages.current_version_id` 与 FTS/embedding 中的 `page_version_id` 一致。

关键词查询见 [`packages/db/src/retrieval.js:172-194`](../packages/db/src/retrieval.js:172)，向量查询见 [`packages/db/src/retrieval.js:205-232`](../packages/db/src/retrieval.js:205)。旧页面版本即使仍有 FTS 或 embedding 行，也不会以当前 Wiki 内容参与召回。

### 7.2 召回、seed gate 和图扩展

一次 retrieval run 的流程是：

```text
规范化 query
    -> Wiki FTS / Raw FTS
    -> 可选 Wiki / Raw vector search
    -> 各通道内部 RRF 融合
    -> Wiki seed gate
    -> 最多两跳 Wiki link graph 扩展
    -> provenance lookup
    -> context snapshot 组装
    -> 持久化 retrieval_runs
```

RRF 只融合关键词和向量的排名，不把两种不可比的原始分数直接相加，见 [`packages/db/src/retrieval.js:239-254`](../packages/db/src/retrieval.js:239)。

Wiki graph 不会从所有命中页面无限扩散。`applySeedGates` 要求 Wiki 结果有关键词排名、`keywordScore >= 0.70`，并且与下一候选的分数差至少为 `0.10`；通过 gate 的页面才是 Wiki seed：[`packages/db/src/retrieval.js:407-415`](../packages/db/src/retrieval.js:407)。

图扩展最多两跳，并对第 1 跳和第 2 跳施加衰减；同时检查边的来源版本、目标当前版本、知识库和页面状态。实现见 [`packages/db/src/retrieval.js:258-313`](../packages/db/src/retrieval.js:258)。

### 7.3 Provenance 和上下文

Wiki 的 `provenance lookup` 读取页面当前版本上的 `wiki_citations`，然后检查：

- citation 指向的 resource version；
- source storage 的 byte size 和 SHA-256；
- locator 是否仍然可解释；
- citation 状态和完整性。

实现见 [`packages/db/src/retrieval.js:315-341`](../packages/db/src/retrieval.js:315)。Raw child 则用 child locator、resource version 和 processing run 作为来源坐标，它没有 Wiki block citation 那样的来源关系。

上下文组装给 Wiki 和 Raw 分别分配预算，默认 Wiki 60%、Raw 40%：

- Wiki 页面较小时放入全文；
- 页面较大时按命中 block 选择相邻 block，再按预算截断；
- Wiki context item 会携带 page version、locator、graph path 和 provenance；
- Raw context item 会携带 `contextHeader`、parent context 和 child content；
- 最终生成 `context snapshot` 和 `context.markdown`。

实现见 [`packages/db/src/retrieval.js:348-405`](../packages/db/src/retrieval.js:348)。

### 7.4 retrieval run 是 RAG 的审计对象

`executeRetrieval` 会在请求和知识库/空间校验通过后建立 trace，并在成功或失败时写入 `retrieval_runs`：

- query 和 scope；
- Wiki seeds、图扩展和 Raw seeds；
- keyword/vector 状态、provider、model、维度和耗时；
- provenance lookups；
- context items、Markdown、预算和截断原因；
- error 和完整 trace JSON。

主流程见 [`packages/db/src/retrieval.js:468-552`](../packages/db/src/retrieval.js:468)，表结构见 [`packages/db/src/database/migrations.js:61`](../packages/db/src/database/migrations.js:61)。

这保证了 Wiki 进入某次回答时可以追溯“使用了哪个页面版本、哪个引用、哪条 link path 和哪份上下文”。它仍然不是人工审核：RAG 查询和 Agent 答案可以在没有用户逐条批准的情况下完成。

## 8. Agent 对 Wiki 的操作

### 8.1 Agent 的权限模型是“读取 + 提案”，不是“直接写入”

Agent run 启动时会建立 scope snapshot，固定：

- knowledge base；
- space；
- resource version；
- Wiki page 和 page version；
- retrieval run。

有知识库的 Agent run 要求显式提供可读范围；如果 retrieval run 被纳入范围，系统还会从其 trace 中补入所引用的资源版本和 Wiki 页面版本。实现见 [`packages/db/src/agent.js:105-146`](../packages/db/src/agent.js:105)。

Agent 的读取接口包括：

- `search_knowledge`；
- `read_resource_version`；
- `read_raw_chunk`；
- `read_wiki_page`；
- `read_retrieval_run`；
- `list_wiki_citations`。

这些接口都会进行 scope 检查；读取 Wiki 时要求精确的选定页面版本，见 [`packages/db/src/agent.js:191-237`](../packages/db/src/agent.js:191)。

Worker 只把读取工具和当前 run 对应的一个终结工具放入 allowlist：

- `answer` run 只能调用 `submit_answer`；
- `organize` run 只能调用 `submit_change_plan`；
- 两者都没有 Wiki 写入工具。

工具定义见 [`apps/worker/src/agent/tools.js:32-131`](../apps/worker/src/agent/tools.js:32)，系统 prompt 还明确禁止文件系统、Shell、网络、SQL 和外部连接器：[`apps/worker/src/agent/prompts.js:5-34`](../apps/worker/src/agent/prompts.js:5)。

### 8.2 Agent 计划的结构

`submit_change_plan` 的职责是验证并落库计划，不应用 Wiki 变更。计划项类型包括：

- `page_create`；
- `page_update`；
- `tag_add`；
- `duplicate_finding`；
- `conflict_finding`。

计划校验会检查：

1. 目标页面和目标版本是否在 scope 内。
2. 页面类型、标题、Markdown 大小、space 和 parent 是否有效。
3. `page_update` 的 `basePageVersionId` 是否正好等于 scope 中的页面版本。
4. 每条引用是否指向唯一来源，且 locator/chunk/block 可验证。
5. 引用是否与 `evidenceStatus` 一致。
6. 是否满足树计划的深度、页面数、子节点数、根节点和循环约束。
7. 服务端重新计算 diff、风险级别和 evidence status。

实现见 [`packages/db/src/agent.js:424-480`](../packages/db/src/agent.js:424)。服务端不会信任模型直接传来的 risk 或 diff。

风险和证据规则当前是：

| 操作 | 服务端风险 | 证据/应用规则 |
| --- | --- | --- |
| `tag_add` | `low` | 无引用时为 `not_applicable`，可以应用已有标签关系 |
| `page_create` | `medium` | 无引用时为 `needs_evidence`，不能应用 |
| `page_update` | `high` | 无引用时为 `needs_evidence`，不能应用 |
| `duplicate_finding` / `conflict_finding` | `high` | 作为审核发现，不直接改变 Wiki |

计划项插入数据库时初始为 `review_status='proposed'`、`application_status='pending'`，见 [`packages/db/src/agent.js:483-506`](../packages/db/src/agent.js:483)。

### 8.3 审核状态和应用状态是两套状态

计划项同时拥有：

```text
evidence_status:   used | needs_evidence | not_applicable
review_status:     proposed | approved | rejected
application_status: pending | applied | not_applicable
                   | stale | apply_failed | rolled_back
```

这一区分解决了几个常见混淆：

- `approved` 只表示审核者同意，不代表数据库写入成功；
- `stale` 表示提案基线已经过期，通常是页面被别人更新；
- `apply_failed` 表示审核通过但应用阶段失败；
- `rolled_back` 表示曾经应用成功，后来通过受保护的回滚流程恢复；
- `needs_evidence` 的计划不能进入应用事务。

计划项的状态、决策人、原因、时间、应用版本和回滚版本都在 schema 中持久化：[`packages/db/src/database/migrations.js:66`](../packages/db/src/database/migrations.js:66)。

### 8.4 单项、分支和批量审核

审核 API 位于 [`apps/api/src/routes/agent.js:132-169`](../apps/api/src/routes/agent.js:132)：

- `POST /api/agent/plan-items/:id/decision`：批准或拒绝单项；
- `POST /api/agent/plan-items/:id/branch-decision`：对树计划的分支批准或拒绝；
- `PATCH /api/agent/plan-items/:id`：只允许编辑仍为 pending 的提案字段，并重新计算整个计划约束；
- `POST /api/agent/plan-items/batch-decision`：批量批准；
- `POST /api/agent/plan-items/:id/rollback`：回滚已应用项。

批量批准被限制为同一个 Agent run 的 `tag_add`，最多 50 项；页面创建和内容更新不能通过这个低风险批量入口：[`packages/db/src/agent.js:869-882`](../packages/db/src/agent.js:869)。

树计划还要求父节点先成功应用：

- 被拒绝或失败的父节点会阻塞子节点；
- 子节点不能绕过未应用的父节点单独写入；
- 分支批准会按父子顺序应用页面节点。

相关规则见 [`packages/db/src/agent.js:707-778`](../packages/db/src/agent.js:707)。

### 8.5 真正的 Wiki 写入只发生在批准后的事务中

`applyItemInTransaction` 是 Agent Wiki 写入的关键边界：[`packages/db/src/agent.js:643-704`](../packages/db/src/agent.js:643)。

不同计划项的行为是：

#### `tag_add`

- 目标页面必须仍然 active；
- 标签必须已经存在；
- 如果关系已经存在，则标记为 `not_applicable`；
- 否则插入 `wiki_page_tags`，并标记为 `applied`。

Agent 不能在这个流程中创建新标签。

#### `page_update`

1. 再次读取 Agent run 和目标页面。
2. 检查页面当前版本仍等于计划的 `basePageVersionId`。
3. 以当前版本为 `parent_version_id` 创建新 `wiki_page_version`。
4. 解析 blocks 并写入新版本 blocks。
5. 写入计划中的 citations。
6. 更新标题、slug、space、parent 等页面元数据。
7. 更新 Wiki FTS 和 link projection。
8. 排入新版本 embedding。
9. 把新版本 ID 写入 `applied_page_version_id`。

#### `page_create`

- 生成新的 `wiki_page`；
- 校验 parent、slug、模板和页面类型；
- 创建初始页面版本和 blocks；
- 写入 citations、FTS、link projection 和 embedding task；
- 保存创建出的页面版本，供后续回滚。

#### `duplicate_finding` / `conflict_finding`

它们是审核记录，不直接变更 Wiki 数据，应用时标记为 `not_applicable`。这使 Agent 可以报告问题，但不能通过“发现项”伪装成已执行的写操作。

### 8.6 回滚的安全条件

回滚也不是删除或覆盖历史：

- `page_update` 只有在当前页面版本仍是该计划应用出的版本时才能回滚；
- 系统用原始 base version 的内容创建新的恢复版本，并恢复必要的 metadata/citations；
- `page_create` 只有在页面仍未被外部改变且没有活动子页面时才能归档；
- `tag_add` 删除对应关系；
- finding 类型没有实际 Wiki 变更，因此不能回滚。

实现见 [`packages/db/src/agent.js:884-925`](../packages/db/src/agent.js:884)。

### 8.7 UI 中的审核语义

前端明确把两个面板区分为：

- `PI AGENT / READ ONLY`：Agent 对话和证据读取；
- `REVIEW GATE / TRANSACTIONAL WRITE`：Wiki 整理计划、diff、风险、引用、批准/拒绝/回滚。

对应 UI 位于 [`apps/web/app/page.jsx:694-752`](../apps/web/app/page.jsx:694)。UI 展示的“应用状态”来自 `agent_plan_items`，不是根据页面内容猜出来的。

## 9. 审计、可观测性和失败处理

### 9.1 四类记录各自回答不同问题

| 记录 | 回答的问题 | 是否保存正文 |
| --- | --- | --- |
| `audit_logs` | 哪个实体发生了 queued/created/approve/reject/rollback/failed 等生命周期事件？ | 通常只保存 metadata |
| `agent_events` | Agent 依次调用了什么工具、耗时多少、是否失败、输入输出是否发生变化？ | 只保存 hash、大小、token/cost，不保存调用正文 |
| `retrieval_runs` | 一次 RAG 使用了什么 query、版本、候选、来源和 context snapshot？ | 保存 trace/context；Raw seed 正文会被隔离 |
| `wiki_page_versions` / `agent_plan_items` | 页面实际变成了什么、谁审核、哪个版本被应用或回滚？ | 页面版本保存 Markdown；计划保存提案/diff/状态 |

表结构见 [`packages/db/src/schema.js:23-25`](../packages/db/src/schema.js:23)、[`packages/db/src/schema.js:75-91`](../packages/db/src/schema.js:75)；Agent event 写入见 [`packages/db/src/agent.js:501-570`](../packages/db/src/agent.js:501)。

### 9.2 页面写入成功不等于 embedding 已完成

Wiki 页面写事务完成后，FTS 和 link projection 会立即更新，但 embedding 由 Worker 异步处理。embedding 失败通常只会让向量阶段变成 disabled/degraded，关键词检索仍可工作；显式 egress 安全策略拒绝则会直接失败。检索故障语义见 [`packages/db/src/retrieval.js:468-552`](../packages/db/src/retrieval.js:468) 和 [`docs/RETRIEVAL_MECHANISM.md:157`](../docs/RETRIEVAL_MECHANISM.md:157)。

任务层还会记录 queued/running/retrying/succeeded/failed/cancelled，并对可重试的 transient error 进行有限次数重试：[`apps/worker/src/tasks/runner.js:5-59`](../apps/worker/src/tasks/runner.js:5)。

### 9.3 审计正文隔离

API 的通用 `ctx.audit` 会调用 `redactAuditMetadata`，对 prompt、source text、raw text、content Markdown 和 secret 类字段进行省略或脱敏：[`apps/api/src/context.js:12-13`](../apps/api/src/context.js:12)。

但 Agent 的 `auditAgent` 直接序列化 metadata 写入 `audit_logs`，没有复用这个脱敏函数：[`packages/db/src/agent.js:928`](../packages/db/src/agent.js:928)。当前常见调用主要写 ID、状态和版本号，但 `reason` 等字段可能来自请求，因此这是一个实现边界。

## 10. 当前 API 入口总览

| 目的 | API |
| --- | --- |
| Wiki overview、树、待复核引用、候选资源、系统日志 | `GET /api/knowledge-bases/:id/wiki` |
| 页面列表 | `GET /api/knowledge-bases/:id/wiki/pages` |
| 创建页面 | `POST /api/knowledge-bases/:id/wiki/pages` |
| 查看/更新页面 metadata | `GET/PATCH /api/wiki/pages/:id` |
| 查看/创建页面版本 | `GET/POST /api/wiki/pages/:id/versions` |
| 查看版本 diff | `GET /api/wiki/pages/:id/diff` |
| 恢复旧版本 | `POST /api/wiki/pages/:id/restore` |
| 查看/创建资源 citation | `GET/POST /api/wiki/pages/:id/citations` |
| 查看待复核影响 | `GET /api/knowledge-bases/:id/wiki/impacts` |
| 创建 Agent answer/organize run | `POST /api/agent/runs` |
| 查看计划和 Agent events | `GET /api/agent/runs/:id/plan`、`GET /api/agent/runs/:id/events` |
| 审核/编辑/回滚 Agent 计划 | `/api/agent/plan-items/...` 下的 decision、branch-decision、PATCH、rollback |

Wiki 路由的实际分派见 [`apps/api/src/routes/wiki.js:345-624`](../apps/api/src/routes/wiki.js:345)，Agent 路由见 [`apps/api/src/routes/agent.js:95-207`](../apps/api/src/routes/agent.js:95)。

## 11. 当前边界和后续风险

### 11.1 Wiki 写入审核已经闭环，但不是所有 Wiki 写入都经过 Agent 审核

Agent 的页面创建/更新必须经过计划审核；用户直接编辑页面则直接走版本接口，因为该写入本身就是用户决定。不能把“Agent 写入需审核”解读成“所有 Wiki 写操作都要再批准一次”。

### 11.2 RAG 有 trace，没有答案人工审核

RAG 保存 retrieval run、provenance 和 context snapshot；Agent answer 还会保存使用过的 retrieval run IDs。但当前没有“用户批准本次检索证据后才允许回答”的状态机，也没有对最终答案逐条人工确认的入口。

### 11.3 审计日志没有统一视图

Wiki overview 的系统日志 SQL 只筛选 knowledge base、space、resource、processing run、task、Wiki page/version/citation/template 等实体，不包含 `agent_run`、`agent_plan_item`、`agent_events`、`retrieval_run` 或 `chat_message`：[`apps/api/src/routes/wiki.js:285-323`](../apps/api/src/routes/wiki.js:285)。这些记录虽然可以通过各自 API 读取，但当前没有统一的跨对象审计时间线。

### 11.4 操作者身份仍是本地调用约定

Agent 决策接口从请求体读取 `actor`，默认 `local-user`：[`apps/api/src/routes/agent.js:132-166`](../apps/api/src/routes/agent.js:132)。当前没有认证/授权主体校验，因此 `decided_by` 是调用方声明，而不是经过身份系统确认的用户身份。对个人本地应用可以接受；如果部署为多用户服务，需要补权限边界。

### 11.5 Raw 和 Wiki 的来源协议还不完全统一

Wiki provenance 是 block 到 resource version 的显式 citation；Raw child chunk 主要靠 locator、resource version 和 processing run。Raw 在每次检索时不会像 Wiki citation 一样重新做 block 级来源状态复核。相关边界见 [`docs/RETRIEVAL_MECHANISM.md:207-214`](../docs/RETRIEVAL_MECHANISM.md:207) 和 [`docs/RETRIEVAL_MECHANISM.md:315`](../docs/RETRIEVAL_MECHANISM.md:315)。

### 11.6 空间边界只完整约束 Wiki

当前 Wiki 查询会使用 `spaceId`，但 Raw 资源只有 knowledge base 关联，没有 resource-to-space 关系，因此同一个 retrieval run 中可能是“限定空间的 Wiki + 整个知识库的 Raw”。这是当前检索领域文档明确记录的待决策项：[`docs/RETRIEVAL_MECHANISM.md:46-73`](../docs/RETRIEVAL_MECHANISM.md:46)。

### 11.7 完整 RAG trace 不是永久审计材料

`retrieval_runs` 属于 derived data，默认保留 30 天并可通过显式清理命令删除；audit log、原始资源、资源版本、processing run 和 Wiki 版本不会被同一清理流程删除。因此长期可以证明页面版本和审核结果，但不一定能永久恢复当时完整的 RAG context。

## 12. 代码阅读索引

- 数据表：[`packages/db/src/schema.js`](../packages/db/src/schema.js)、[`packages/db/src/database/migrations.js`](../packages/db/src/database/migrations.js)
- Wiki 规则、Markdown blocks、citation bounds、impact scan：[`packages/db/src/wiki.js`](../packages/db/src/wiki.js)
- Wiki API、版本、恢复、citation、overview：[`apps/api/src/routes/wiki.js`](../apps/api/src/routes/wiki.js)
- FTS、Wiki link projection、RAG、provenance、context：[`packages/db/src/retrieval.js`](../packages/db/src/retrieval.js)
- Agent scope、计划校验、审核应用、回滚：[`packages/db/src/agent.js`](../packages/db/src/agent.js)
- Agent 工具、prompt、runtime 和 Worker：[`apps/worker/src/agent/`](../apps/worker/src/agent/)
- Wiki 页面和 Agent 审核 UI：[`apps/web/app/page.jsx`](../apps/web/app/page.jsx)
- 检索机制边界：[`docs/RETRIEVAL_MECHANISM.md`](../docs/RETRIEVAL_MECHANISM.md)
