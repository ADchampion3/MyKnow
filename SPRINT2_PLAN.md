# Sprint 2 实施计划：资源导入、版本与全文检索

## 1. 目标与边界

周期：10 个工作日，单人、本地优先、单用户。

目标是交付可从空数据库复现的最小闭环：

`Markdown/TXT 文件或 URL -> 原始内容持久化 -> 异步解析 -> 版本与指纹 -> 分块 -> 全文检索 -> 可追溯结果`

本 Sprint 复用 Sprint 1 的 Node API、独立 Worker、SQLite 轮询任务和三栏 Web 工作台。不引入 Redis、外部队列、独立解析服务或新的运行时依赖。

纳入范围：

- Markdown、TXT 文件导入；文本型 PDF 解析适配器；HTTP/HTTPS URL 快照。
- 原始文件字节或网页快照不可变保存，SHA-256 去重和版本链。
- 资源与知识库多对多归属；解析、分块、FTS5 索引任务可审计、可重试。
- 资源列表、详情、版本、重试、归属管理和范围受限搜索 API。
- 三栏工作台中的导入、状态、错误、重试和搜索结果。

明确延期至 Sprint 3：DOC/DOCX/XLS/XLSX/PPT/PPTX、OCR/VLM、扫描 PDF、复杂 PDF 布局/表格、向量 embedding、RAG、Agent/Wiki、定时同步、登录和多用户权限。

## 2. 固定技术决策

- ID 使用 UUID 字符串；时间使用 UTC ISO 8601。
- API 统一返回 `{ data, error, requestId }`，错误码至少包含 `VALIDATION_ERROR`、`NOT_FOUND`、`UNSUPPORTED_MEDIA_TYPE`、`SSRF_BLOCKED`、`RESOURCE_DUPLICATE`、`PARSE_FAILED`、`INDEX_FAILED`。
- 原始数据、资源版本、分块和审计记录禁止物理删除；删除归属只删除关联关系，归档使用状态字段。
- 资源状态：`pending`、`processing`、`indexed`、`failed`、`archived`。
- 任务类型：`resource:process`；沿用 `queued`、`running`、`succeeded`、`failed`、`retrying`。
- `MaterialReader` 只负责读取和规范化，返回 `canonicalText`、标题、MIME、定位元数据、解析器名称和版本；不写数据库。
- URL 在 API 接收和 Worker 执行阶段各做一次 SSRF 校验，仅允许 `http`/`https`，拒绝 localhost、回环、私网、链路本地地址和受限重定向。
- FTS5 可用性在启动/自检时确认。若环境不支持，使用带 `ponytail:` 注释的受限 LIKE 降级，并在证据和 Sprint 3 backlog 中记录性能限制。

## 3. 数据库与文件存储

新增可重复迁移和 Drizzle schema：

- `resources`：名称、来源类型、状态、当前版本、归档时间、创建/更新时间。
- `resource_versions`：资源 ID、内容 SHA-256、原始存储键、MIME、字节数、标题、来源 URL、抓取时间、解析器名称/版本、解析摘要、耗时、状态和错误摘要。
- `resource_knowledge_bases`：资源与知识库的多对多关联，唯一约束防重复关联。
- `chunks`：版本 ID、序号、文本、字符起止偏移、行/段落或 URL 定位元数据、状态。
- `resource_fts`：FTS5 虚拟表，以稳定 chunk ID 映射正文和标题。

文件存储根目录由服务端配置（默认 `data/resources`）。路径必须由服务端生成并限制在根目录内；API、日志和前端不得暴露密钥或任意本地路径。原始内容先写临时文件并校验大小/摘要，再原子改名。

## 4. API 交付

- `POST /api/resources`：接收 JSON URL 或受限 multipart 文件；校验名称、扩展名/MIME、大小、知识库归属和协议；创建资源版本及 `resource:process` 任务。
- `GET /api/resources`：支持 `knowledgeBaseId`、状态和分页过滤。
- `GET /api/resources/:id`：返回资源、当前版本、任务状态和错误摘要。
- `GET /api/resources/:id/versions`、`GET /api/resources/:id/versions/:versionId`：返回版本链及定位元数据；原始文件下载走服务端受控路径。
- `POST /api/resources/:id/retry`：仅允许失败版本，遵守 Sprint 1 重试上限和审计规则。
- `POST /api/resources/:id/knowledge-bases/:kbId`、`DELETE ...`：管理归属，不复制或删除原始内容。
- `GET /api/search?q=&knowledgeBaseId=&resourceVersionId=`：查询范围为空时不得返回范围外结果；结果必须包含 chunk、资源、版本和定位信息。

所有新增路由覆盖参数校验、找不到资源/知识库、重复指纹、非法 MIME、SSRF 和错误响应 request ID。

## 5. Worker 流水线

`resource:process` 每次尝试在事务中追加 `task_attempts`，按以下阶段执行：

1. 读取不可变原始文件或 URL 快照。
2. Markdown/TXT 直接 UTF-8 读取；文本 PDF 通过固定版本的 Python MarkItDown 适配器；URL 提取标题和正文并保存快照。
3. 规范化文本，拒绝空文本、无效 JSON、超时和超限输出，统一映射为 `PARSE_FAILED`。
4. 按稳定规则分块，保存字符偏移和可用的行、段落、页码或 URL 定位。
5. 在事务中写入 chunks 与 FTS；失败时不删除旧版本或旧索引。
6. 成功标记版本 `indexed`、资源当前版本和任务 `succeeded`；可重试错误进入 `retrying`，超限后 `failed`。

解析器必须使用 `spawn` 且 `shell: false`，输入路径必须经过存储根目录校验。配置单文件大小、子进程超时、并发数和 JSON 输出上限，并留下超限测试。

## 6. 十日安排

1. 第 1-2 天：确认现有迁移/自检流程；新增资源表、FTS 表、索引、约束；实现安全的文件存储和 fixture。
2. 第 3 天：实现 Markdown/TXT reader、SHA-256 去重、版本链、资源仓储和审计事件。
3. 第 4 天：实现导入 API、multipart/URL 输入、大小/MIME/名称校验及统一错误响应。
4. 第 5 天：实现 URL SSRF 校验、超时、重定向策略、HTML 正文抽取和快照保存。
5. 第 6 天：实现 `MaterialReader` 契约、PDF MarkItDown 适配器及边界映射。
6. 第 7 天：实现 Worker `resource:process`、事务性分块、任务重试和中断恢复。
7. 第 8 天：实现 FTS5 搜索、知识库范围隔离、版本/定位回溯和索引重建。
8. 第 9 天：接入三栏工作台的导入、资源状态、错误重试、搜索和空/加载状态。
9. 第 10 天：运行空库端到端验收、性能/安全检查、截图、README 更新和证据归档。

## 7. 必须留下的自动化检查

- `npm run check:db`：空库迁移可重复执行，表、约束、FTS 能力和文件根目录检查通过。
- `npm run check:api`：四类输入、重复指纹、版本链、归属隔离、错误码和 SSRF API 合约通过。
- `npm run check:worker`：成功、解析失败、重试、任务尝试、审计和中断恢复通过。
- `node --check` 覆盖 API、Worker、Web 新增入口；所有非平凡逻辑至少有一个可运行断言。
- fixture 至少包含正常中文 Markdown、空文本、超限/非法类型、文本 PDF、损坏 PDF、允许 URL、SSRF 拒绝 URL。
- 运行 100 个混合 fixture 导入/重试演练，验证没有重复版本、chunk 或 FTS 行，且原始记录未被删除。

## 8. 验收标准

- 从空数据库启动 API、Web、Worker，完成文件导入或 URL 快照到 `indexed` 的端到端流程。
- 相同内容重复导入只复用指纹，不新增版本或索引任务；内容变化生成新版本，旧版本仍可读/下载。
- 一个资源可关联两个知识库；两个范围的搜索结果严格隔离。
- 任意搜索结果可反查资源、版本、chunk 序号、字符偏移及输入类型匹配的定位信息。
- 失败任务重试后从安全阶段继续，任务最终状态、每次 attempt、错误摘要和审计事件可查看。
- 禁止 URL 在 API 或 Worker 任一阶段绕过 SSRF 校验；拒绝请求不产生资源数据。
- 原始字节、旧版本、chunk 和审计记录无物理删除；索引重建只影响派生索引。
- 普通 fixture 从导入到可搜索在本地 2 分钟内完成；超出时记录实测值，不降低正确性门槛。

## 9. 证据目录

所有结果写入 `artifacts/sprint2/`：

- `acceptance-report.md`：逐条记录通过、失败或延期，含命令、时间、环境和结论。
- `migration-startup.log`：空库迁移及 API/Web/Worker 启动记录。
- `import-fixtures.md`：各 fixture、预期状态、实际状态、耗时和错误码。
- `version-dedup.log`：重复导入、内容更新、版本链和指纹结果。
- `search-scope.log`：多知识库归属和范围隔离结果。
- `retry-audit.log`：失败、重试、attempt、审计和索引重建结果。
- `chunk-trace.jsonl`：至少 20 条 chunk 到版本和定位的反查样本。
- `ssrf-check.log`：允许/拒绝 URL 及无越界外发验证。
- `workspace-import-search.png`：三栏工作台导入、状态和搜索结果截图。

## 10. 时间不足时的降级顺序

1. 原始文件持久化、SHA-256 去重、版本链和任务审计。
2. Markdown/TXT 解析、分块、FTS5 和范围隔离。
3. URL SSRF 校验与快照。
4. 文本 PDF；复杂 PDF 明确延期。
5. Web 视觉 polish、批量操作和非核心筛选。

任何未达验收标准的项目必须进入 Sprint 3 backlog，并在 `acceptance-report.md` 标记为延期，不得通过删除证据或降低阈值宣告完成。

## Sprint 2 优化重构决策

本轮在 Sprint 2 基础上采用破坏性更新策略：项目仍处于初步开发阶段，旧的 fixed-800 派生 chunks/FTS 不作为兼容约束，schema 变更会触发全量重建；原始材料和审计记录继续保留。

- 统一 `MaterialReader.read` 结果为 canonical text、结构 blocks、assets、metadata、quality 和 parser identity。
- 每次解析/分块生成 `processing_run` 和 reader attempts，并保存不可变 canonical artifact。
- 分块采用 `auto -> heading -> heuristic -> legacy` 校验降级链，按 Unicode code point 记录 offset。
- 默认 parent/child 大小为 4096/384，child overlap 为 76；parent 不进 FTS，child 才进 FTS，搜索结果回填 parent 上下文。
- 受保护的 fenced code、Markdown table、LaTeX、link/image 引用不在普通路径中切断；超长强制切分留下 `forced_split`。
- URL 本轮只接受网页语义，API/Worker 双重 SSRF 校验，保存 HTML snapshot；Office、OCR/VLM、ASR、file URL 继续延期。
- 新增 processing-runs、chunk preview、单资源 reprocess 和全量 rebuild 控制面。
