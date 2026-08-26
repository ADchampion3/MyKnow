# Sprint 3 计划：LLM Wiki 双投影知识库

## 1. 计划定位

Sprint 3（第 5-6 周）把 MyKnow 从“资料导入与原始检索”推进为“以 LLM Wiki 为默认入口、以原始检索为保底”的双投影知识库。

本 Sprint 不实现真实 Agent 整理。先建立可被 Agent 可靠维护的 Wiki 数据层、浏览界面、版本链、引用和影响标记；Sprint 5 再接入 Agent 的多页面变更计划与人工审核。

## 2. 已确认的产品决策

### 2.1 双投影模型

```text
不可变原始资料
├── 检索投影：chunk / FTS / 向量索引
│   └── 所有资料都保留；结构完整的资料可以直接检索
└── Wiki 投影：Markdown 页面、主题树、交叉链接、综合结论
    └── 仅对适合沉淀的资料进行 Wiki 整理
```

- 原始资料、原始版本和来源定位始终保留。
- 所有资料都进入现有的 FTS/后续向量检索链路。
- 知识库有 Wiki 整理默认策略；单份资料可覆盖为 `retrieval-only`。
- `retrieval-only` 资料不生成或更新 Wiki，但仍可作为检索证据。
- 用户打开知识库默认进入 Wiki `index/overview`，而不是资料列表。
- Wiki 页面可以综合多个资料版本，不建立“一份资料对应一篇 Wiki”的强制关系。

### 2.2 Wiki 页面语义

Wiki 是持久化的派生知识层，而不是知识库 UI 的别名。知识库展示页是 Wiki 的入口；Wiki 由可链接、可引用、可版本回滚的 Markdown 页面组成。

系统页面：

- `index`：知识库总览和导航，依据页面元数据生成。
- `log`：追加式系统事件记录，不允许普通页面编辑覆盖。

普通页面类型：

- `concept`
- `entity`
- `source-summary`
- `synthesis`

模板是页面类型的 Markdown 初始骨架，不是所有页面统一使用的六章节 UI 模板。六个章节只作为 `synthesis` 等页面类型的默认配置。

### 2.3 版本和引用

- 每次页面保存生成不可变的完整 Markdown 页面版本。
- 页面版本中的 block 有稳定 key，用于 diff、引用和影响标记。
- 恢复旧版本会生成新版本，历史版本不被覆盖。
- 引用绑定不可变的 `resource_version + locator`，可额外绑定页面 block。
- 资料新版本索引成功后，相关 Wiki 引用标记为 `needs_review`；定位无法解析时标记为 `broken`。
- 资料更新不会自动改写 Wiki，语义更新由 Sprint 5 Agent 提议并经审核后写入。

## 3. Sprint 3 目标

交付一个可以从空数据库启动并演示以下闭环的 Wiki 工作区：

```text
打开知识库
  -> 默认进入 Wiki index/overview
  -> 浏览主题树和多来源 Wiki 页面
  -> 编辑页面并产生版本
  -> 查看 diff 或恢复旧版本
  -> 点击引用打开指定资料版本和原文定位
  -> 更新资料后查看 needs_review / broken 状态
  -> retrieval-only 资料仍可直接检索但不生成 Wiki
```

## 4. 交付范围

### 4.1 Wiki 数据层

- Wiki 页面、页面版本、派生 block、模板版本和结构化引用。
- 页面属于一个知识库，可选一个空间；`parent_page_id` 形成主题树。
- 页面内部链接使用稳定页面 ID；不引入图数据库。
- 页面正文以 Markdown 保存；SQLite 是当前 Sprint 的唯一权威存储。
- blocks 是可重建的派生数据，不作为独立事实数据库。

### 4.2 浏览和编辑

- 知识库默认 Wiki 入口、页面树和页面列表。
- Markdown 编辑器和渲染预览。
- 页面新建、元数据编辑、版本列表、diff、恢复。
- `baseVersionId` 乐观冲突检查；不做实时协作和自动合并。
- 右侧显示来源、引用、版本和待处理影响项。
- 原始资料浏览保持只读。

### 4.3 模板

- 知识库级模板配置和模板版本。
- 新页面记录使用的模板版本。
- 模板更新只影响新建页面；已有页面不被静默改写。
- 提供最小模板配置：页面类型、章节顺序、标题、是否必需和说明。
- 不实现复杂的可视化 Block Editor。

### 4.4 影响扫描

- 页面保存、版本、diff、恢复均使用 API 事务同步完成。
- 资料版本成功索引后，Worker 排队 `wiki:impact-scan`。
- 影响扫描只做确定性检查，不调用 LLM：
  - 旧资料版本出现新的成功版本：相关引用进入 `needs_review`。
  - 目标版本或 locator 无法读取：引用进入 `broken`。
  - 目标仍可读取且没有新版本：保持 `active`。
- 扫描结果通过引用状态和审计记录展示，不另建复杂的影响规则引擎。

## 5. 不在 Sprint 3 做

- 真实 LLM/Agent 生成或自动改写 Wiki。
- Agent 多页面变更计划、逐项审核、批量接受和回滚审核。
- RAG 生成逻辑和外部开放问答。
- 自动判断资料是否适合 Wiki 的分类器。
- 实时协作、细粒度权限、图数据库和 Obsidian/Git 双写。
- 词级引用、复杂 PDF 坐标高亮和语义事实识别。

## 6. 建议数据模型

### 6.1 知识库和资料策略

在现有表上增加：

- `knowledge_bases.wiki_default_mode`：`enabled` / `retrieval_only`，默认 `enabled`。
- `resources.wiki_mode`：`NULL` 表示继承知识库，或明确为 `enabled` / `retrieval_only`。

不使用自动分类器；策略变化写入审计日志。

### 6.2 Wiki 表

`wiki_pages`

- `id`、`knowledge_base_id`、`space_id`、`parent_page_id`
- `slug`、`title`、`page_type`
- `status`、`current_version_id`
- `created_at`、`updated_at`

约束：UUID 字符串 ID；同一知识库内 slug 唯一；页面不能把自己或后代设为父页面。

`wiki_page_versions`

- `id`、`page_id`、`parent_version_id`
- `template_version_id`
- `content_markdown`、`content_sha256`
- `change_summary`、`restore_of_version_id`
- `created_at`

版本只增不改。`content_markdown` 是页面内容权威来源。

`wiki_page_blocks`

- `id`、`page_version_id`、`block_key`
- `block_type`、`ordinal`、`heading_path`
- `content_markdown`、`content_sha256`

这是从 Markdown 解析的派生表，可由页面版本重建。Sprint 3 的 block key 以页面结构、标题路径和顺序为基础；任意大幅重排可能使旧引用进入 `needs_review`。

`wiki_templates`

- `id`、`knowledge_base_id`、`page_type`
- `current_version_id`
- `created_at`、`updated_at`

`wiki_template_versions`

- `id`、`template_id`
- `definition_json`
- `created_at`

`definition_json` 只描述有序章节、标题、必需性和说明，不保存密钥或 Provider 配置。

`wiki_citations`

- `id`、`page_version_id`、`block_key`
- `resource_version_id`、`locator_json`
- `status`：`active` / `needs_review` / `broken`
- `stale_reason`、`checked_at`、`created_at`

引用永远指向具体资料版本，不指向会移动的 `resources.current_version_id`。内部页面链接保存在 Markdown 的稳定页面引用中，反向链接在需要时从页面版本派生，不引入图数据库。

## 7. API 契约

所有响应继续使用现有 `{ data, error, requestId }` 包装；所有写入在 API 边界和数据库约束双重校验。

### 7.1 Wiki 浏览和页面

- `GET /api/knowledge-bases/:id/wiki`：返回默认入口、页面树、页面计数和待处理引用计数。
- `GET /api/knowledge-bases/:id/wiki/pages`：按空间、类型、状态分页。
- `POST /api/knowledge-bases/:id/wiki/pages`：使用当前模板创建页面和初始版本。
- `GET /api/wiki/pages/:id`：页面元数据、当前版本、引用摘要。
- `PATCH /api/wiki/pages/:id`：修改标题、slug、空间、父页面等元数据，不修改正文。
- `GET /api/wiki/pages/:id/versions`：版本列表。
- `GET /api/wiki/pages/:id/versions/:versionId`：指定版本正文、blocks 和引用。
- `POST /api/wiki/pages/:id/versions`：提交新正文，必须带 `baseVersionId`。
- `POST /api/wiki/pages/:id/restore`：从指定旧版本生成新版本。
- `GET /api/wiki/pages/:id/citations`：查询当前或指定版本引用。

### 7.2 模板和策略

- `GET /api/knowledge-bases/:id/wiki/templates`
- `POST /api/knowledge-bases/:id/wiki/templates`
- `PATCH /api/knowledge-bases/:id`：更新 Wiki 默认策略或基础设置。
- `PATCH /api/resources/:id`：更新资料显示名称和 `wikiMode`。

### 7.3 影响项和错误码

- `GET /api/knowledge-bases/:id/wiki/impacts`：返回 `needs_review` 和 `broken` 引用按页面聚合的列表。
- `WIKI_VERSION_CONFLICT`：`baseVersionId` 不是当前版本。
- `WIKI_PAGE_CYCLE`：页面树会产生循环。
- `WIKI_CITATION_INVALID`：引用目标或 locator 不满足结构约束。
- 其他请求继续使用现有 `VALIDATION_ERROR`、`NOT_FOUND`、`DUPLICATE_NAME`、`INVALID_STATE_TRANSITION`。

## 8. Web 交互

三栏工作台保持现有信息架构：

- 左栏：知识库、空间、Wiki 页面树和页面类型筛选。
- 中栏：Wiki `index/overview`、Markdown 渲染/编辑、目录和 diff。
- 右栏：来源引用、资料版本、原文定位、页面版本和待处理影响项。

特殊状态：

- Wiki 为空：仍显示 Wiki 入口，同时列出可整理资料和“查看原始资料”入口，不静默跳转到资料列表。
- 页面有 `needs_review`：显示来源新版本和待处理标记，但继续允许查看旧 Wiki 版本。
- 引用 `broken`：页面内标红，右栏给出资料版本/定位错误。
- `retrieval-only` 资料：在资料列表和搜索中可见，显示“不参与 Wiki 整理”。

## 9. Q23 选择的数据库重建方案

本 Sprint 采用“干净数据库重建 + 重新装载”，不采用增量迁移。但重建不是删除数据：

1. 重建前导出知识库、空间、标签、资源、资源版本、处理记录、任务审计和 `audit_logs` 的保留清单。
2. 逐个校验原始存储对象的 SHA-256、字节数和路径，原始存储目录不删除。
3. 只替换明确指定的 SQLite 数据库文件，使用 `--confirm` 精确确认路径。
4. 在新 schema 中恢复原始资料和审计相关记录，尽量保留原 UUID、时间和版本关系。
5. 允许重建 chunks、FTS、Wiki blocks 和其他派生索引；必要时重新排队处理任务。
6. 对比重建前后的资源/版本/审计计数、内容指纹和当前版本指针。
7. 空数据库仍必须可以直接启动；重建失败不能删除原始存储。

需要新增或扩展一个可重复执行的重建检查，禁止把“重新导入”实现成新的逻辑资源而丢失历史 ID 和审计链。

> ponytail：Sprint 3 使用单文件数据库重建，不实现通用在线 schema migration；升级上限是可靠的离线重建与数据保留。未来需要无停机升级或多实例部署时，再引入正式迁移框架。

## 10. 两周排期（10 个工作日）

### 第 1-2 天：合同、schema 和重建路径

- 锁定表、状态、错误码和 REST DTO。
- 实现新 schema 的空库初始化。
- 实现重建前导出、原始存储校验和新库恢复检查。
- 增加 Wiki 策略字段和数据库约束。

### 第 3-4 天：页面版本、block 和模板

- 页面树和 slug 约束。
- 页面版本追加写入、SHA-256、恢复和 base-version 冲突。
- Markdown block 派生和确定性 diff 输入。
- 模板版本和新页面模板快照。

### 第 5-6 天：API、引用和只读资料入口

- 完成页面、版本、恢复、模板、引用 API。
- 接入现有资源版本详情、下载/原文和 canonical locator。
- 增加原始资料不可修改的 API contract 测试。

### 第 7-8 天：三栏 Wiki 工作台

- 默认 Wiki `index/overview`。
- 页面树、Markdown 编辑/预览、版本和 diff。
- 来源引用、版本定位、`retrieval-only` 标记和空状态。
- 1280px 三栏和 1024px 核心导航检查。

### 第 9 天：影响扫描和端到端流程

- `wiki:impact-scan` Worker 任务。
- 资料更新后的 `needs_review` / `broken` 流程。
- 多来源页面、两次编辑、恢复和引用跳转端到端检查。

### 第 10 天：验收、证据和收尾

- 空库重建和保留记录检查。
- API/Worker/Web/数据库 focused checks。
- 截图、diff、引用和影响扫描证据。
- 更新 README、Sprint 3 计划和明确延期 backlog。

## 11. 自动化检查和证据

新增或扩展以下检查：

- `scripts/wiki-contract.js`：页面、模板、版本、冲突、恢复和引用 REST contract。
- `scripts/wiki-version-check.js`：两次编辑、diff、恢复新版本和历史保留。
- `scripts/wiki-citation-check.js`：资料版本/locator 跳转、失效引用和只读源层。
- `scripts/wiki-impact-check.js`：资料更新后影响状态和 Worker 任务审计。
- `scripts/wiki-rebuild-check.js`：干净重建、原始存储校验、记录恢复和指纹对比。
- 现有 `check:all`、`npm test`、Web build、`node --check`。

证据目录 `artifacts/sprint3/` 至少包含：

- `acceptance-report.md`
- `migration-rebuild.log`
- `wiki-api-contract.log`
- `wiki-version-diff.md` 或对应截图
- `wiki-citation-evidence.md`
- `wiki-impact-scan.log`
- `wiki-workspace.png`
- `source-readonly.log`

## 12. Sprint 3 验收标准

1. 从空数据库启动，打开知识库默认进入 Wiki `index/overview`。
2. 能创建多来源 Wiki 页面；页面类型和模板版本可见。
3. 同一页面完成两次编辑，diff 标出新增/删除；恢复旧版本会生成新版本，历史不丢失。
4. 引用能打开指定资料版本和原文 locator；失效引用显示为 `broken` 并进入待处理列表。
5. 原始资料修改/删除请求被 UI 和 API 拒绝，文件、版本、指纹和审计不变。
6. `retrieval-only` 资料仍可检索和查看，但不会进入 Wiki 整理候选。
7. 资料新版本成功索引后，相关引用进入 `needs_review`；旧 Wiki 内容保持可回溯。
8. 空库启动、数据库重建和原始资料/审计恢复均有可复现证据。

## 13. 明确延期

- Sprint 5：真实 Agent 读取资料和 Wiki，生成多页面变更计划、冲突分析和人工审核。
- Sprint 4：Wiki-first + 原始 chunk fallback 的实际问答检索与引用回答。
- 后续：自动资料分类、向量/全文权重学习、Git/Obsidian 双向同步、图谱视图和多用户协作。

如果工期不足，不降低上述验收阈值；未完成项进入下一 Sprint backlog，并记录阻塞原因和证据缺口。
