# SciFact Dataset Migration and Reproducible Retrieval Baseline

Status: ready-for-agent
Label: ready-for-agent

## Problem Statement

MyKnow 已有基于 DeepEval/Vitest 的 raw hybrid retrieval 评测基座，但评测数据目录尚无真实 corpus、queries 和 qrels，因而无法产生可信的首次检索基线。直接使用 Synthesizer 还需要上下文组织与相关性复核；公开 IR 数据集已有人工标注，可以先验证数据导入、隔离 fixture、真实检索和指标计算的完整流程。

当前契约与 SciFact 存在实际冲突：查询上限为 200，test query 528 长度为 204；标题上限为 200，41 篇标题超限，最长为 300。现有 NDCG 使用指数 gain，与 BEIR/TREC 的线性 gain 不同。现有报告只输出到 stdout，尚未形成关联数据、代码、配置和实际排名的持久基线。

公开数据上的一次成功运行不能独立证明指标实现正确，也不能证明生产 parser、chunker 或真实业务检索质量。这些边界必须在验收与报告中明确。

## Solution

完整迁移固定来源版本的 BEIR SciFact corpus 与 test split，复用现有三文件契约和 raw retrieval orchestration。一个公开文档映射为一个 raw child chunk，不重新分块，不伪造 parent context window。保留原始相关性等级和稳定来源身份，沿用 MyKnow 的文本规范化及标题上下文处理。

以最小必要变更扩展输入边界、对齐 NDCG、增加标注覆盖信息和持久报告。通过真实 OpenAI-compatible embedding 服务准备 corpus 快照，在空白隔离数据库中完成全部 test queries 的混合检索，保存首份可独立复算指标的基线。

真实模型与 endpoint 尚未提供，作为真实运行前置条件。开发、离线验证及导入可以先完成，但全部真实评测成功前不得将功能标记为完成。首版不设置产品质量分数门槛。

## User Stories

1. As a MyKnow developer, I want a pinned public dataset, so that every import refers to the same source materials.
2. As a MyKnow developer, I want archive integrity checked before import, so that corrupt or changed downloads fail explicitly.
3. As a MyKnow developer, I want the entire SciFact corpus retained, so that candidate sampling does not change retrieval difficulty.
4. As a MyKnow developer, I want queries selected from test qrels, so that other splits do not enter the evaluation.
5. As a MyKnow developer, I want every official test query retained, so that length restrictions do not silently alter the benchmark.
6. As a MyKnow developer, I want one document mapped to one raw child chunk, so that document judgments remain valid for the ranked target.
7. As a MyKnow developer, I want stable and distinct resource, version, run, chunk and query identities, so that references remain reproducible and fixture insertion succeeds.
8. As a dataset reviewer, I want original IDs and source records preserved, so that each converted record is auditable.
9. As a MyKnow developer, I want titles represented through the existing context header, so that embedding input follows production behavior without duplicate title concatenation.
10. As a dataset reviewer, I want normalization changes documented, so that converted text is not misrepresented as byte-identical source text.
11. As a MyKnow developer, I want invalid input rejected before publication, so that an incomplete conversion cannot replace usable data.
12. As a dataset reviewer, I want original qrel grades retained, so that conversion does not redefine relevance.
13. As an evaluator, I want unjudged results distinguished from explicit grade zero, so that incomplete annotation is visible.
14. As an evaluator, I want NDCG aligned with the BEIR/TREC convention, so that differences are not caused by an undocumented gain formula.
15. As a MyKnow developer, I want fixed rankings checked against an independent reference, so that metric correctness is established separately from retrieval quality.
16. As a MyKnow operator, I want existing databases upgraded without losing source materials or audit records, so that the expanded query boundary is safe to adopt.
17. As a MyKnow developer, I want the same flow to work from an empty database, so that setup is reproducible.
18. As a MyKnow developer, I want a small real-provider preflight, so that configuration and input compatibility failures are discovered before a full embedding batch.
19. As a MyKnow developer, I want a complete corpus embedding snapshot retained, so that subsequent runs reuse successful preparation.
20. As a MyKnow developer, I want provider failures and keyword fallback to fail evaluation, so that reports cannot falsely claim a successful hybrid run.
21. As an evaluator, I want every query's actual ranking persisted, so that scores can be independently recomputed.
22. As an evaluator, I want data, code, configuration and snapshot identities attached to the report, so that comparisons have an explicit provenance.
23. As a contributor, I want large data and vectors kept outside Git while manifests and the first report are versioned, so that reproducibility does not require committing bulky artifacts.
24. As a MyKnow developer, I want documented download, import, preparation and evaluation commands, so that the workflow can be rerun without an agent.
25. As a product owner, I want the report to state its benchmark scope, so that public retriever results are not mistaken for production chunking or business-quality validation.

## Implementation Decisions

### Scope and source identity

- 首版仅支持 SciFact。使用既有 JavaScript、Node 标准库及已有平台下载/解压工具；不引入通用 importer 抽象、TypeScript 工程或应用运行时依赖。
- 固定官方 ZIP 的 SHA256 为 `536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165`，字节数为 2,816,079。官方公布的 MD5 为 `5f7d1de60b170fc8027bb7898e2efca1`。版本以 archive hash 定义，不虚构独立发布版本号。
- 预期完整 corpus 为 5,183 条；原始 queries 为 1,109 条；test qrels 对应 300 个不同查询及 339 条判断，全部 grade 为 1。仅根据 test qrels 选择查询；其余 split 的查询不属于本次评测范围。
- 原始 ZIP、解压源文件和来源/许可信息可追溯保留。下载或哈希验证失败不得继续导入；解压不得允许 archive 条目逃逸目标目录。
- 不采样 corpus，不截断正文或查询，不悄悄跳过不兼容样本。

### Input boundaries and database migration

- 查询上限统一扩展为 256 个 Unicode code points，沿用输入规范化后校验的语义。覆盖评测 contract、生产检索边界、持久化约束、调用方和有关接口文档；检查其他输入边界，避免某一入口继续采用旧上限或 UTF-16 code units。
- 评测 title 上限扩展为 512。资源名继续遵守 120 上限，使用短来源名与原始文档 ID，不以完整文档标题充当资源名。
- 沿用正常数据库迁移机制扩展检索记录的 query 约束。SQLite 如需重建表，必须保留已有行、关系、索引和审计可追溯性。不得以清库作为已有数据库的升级方案。
- 同时维护空数据库的正常迁移启动路径。检查每个受影响函数的调用方，尽量复用已有校验与迁移机制。

### Conversion and provenance

- 输出继续采用现有版本的 `corpus.json`、`queries.json`、`qrels.json` 契约，增加独立 `manifest.json`。字段上限扩展不引入兼容包装层。
- 每个源文档对应一个 raw child chunk、一个 resource、一个 resource version 和一个 processing run。ID 使用确定性 SciFact 命名空间及身份类型前缀；不同资源不能共享 version/run ID。知识库 ID 同样确定且满足现有 UUID 契约。
- 保留原始文档和查询 ID，来源及 split 可从 locator、tags、manifest 追溯。ID 转换必须避免碰撞，并验证所有 qrel 引用可解析。
- 原文 text 映射为 content；原 title 分别映射为 title 与 contextHeader。parentChunkId 和 parentContent 为空。resourceName 使用短格式。原 title 不再次拼入 content；真实 embedding 输入复用现有 contextHeader 与 content 组合路径。
- 文本沿用既有 NFKC + trim 规范化。manifest 记录规则、受影响字段、原始文档 ID 与数量；原始材料保持可恢复。已知 corpus 中 63 篇正文会受影响，test 查询不受该规范化影响。
- query tags 至少保留 beir、scifact、test、en。首版保留标签，不增加按标签分组的报告系统。
- qrels 原始 grade 保持为 1。当前 contract 仅接受 0、1、2；遇到其他值报错，不自动缩放。不存在于 qrels 的文档保持 unjudged；显式 grade 0 表示来源已判断不相关。
- 校验 JSONL/TSV 格式、必需字段、唯一 ID、正文非空、长度限制、qrel 等级和引用完整性。每个入选 query 必须有正例，全部输出必须通过现有评测 loader 校验。
- 先完成解析、转换、所有文件及跨文件校验，再发布完整输出。重复导入应产生一致的数据内容和哈希。失败不得留下可被误用的半套数据，也不得覆盖已有完整数据；复用可用的原子写入机制，并优先使用全新输出目录。
- manifest 记录源 URL、archive 与输入文件哈希、转换规则版本、split、预期与实际数量、ID/文本规则、输出文件哈希。不得记录秘密或含凭据的 URL。

### Metrics and report semantics

- NDCG 全局统一使用线性 gain，即 grade；更新既有指数 gain 测试及文档，不保留两套运行模式。旧报告保持原样；新报告显式记录 gain 和指标定义，避免把历史分数当成同口径结果。
- Recall、Hit Rate、MRR 继续将 grade > 0 视为相关，K 固定为 1、3、5、10。Recall 分母为该查询全部已知正例。
- 引入 Judged@K：前 K 个实际返回结果中，有显式 qrel 的数量除以实际返回数量；没有返回结果时为 0。显式 grade 0 属于 judged，缺失 qrel 不属于 judged。保留实际返回数量，并报告每查询及宏平均覆盖率。
- 未标注结果在现有排名计分中贡献零收益，但报告不得称其为人工确认不相关，也不得宣称 qrels 覆盖了全部真实正例。
- 保留现有评分用阈值 0，不新增产品质量门槛。实现、完整性和真实执行成功是本次验收标准。

### Real-provider execution and persistence

- 使用明确模型名称的 OpenAI-compatible embedding 服务，维度保持 4096，vector retrieval 必须启用。模型、endpoint 和所需密钥由本地配置提供，遵守已有 egress 策略；秘密仅存在于环境配置中。
- 真实运行前使用少量实际源文档验证响应、向量维度、标题组合后的输入长度兼容性和耗时。provider 无法接受完整输入时明确失败，不以截断改变 benchmark。
- 保留现有串行 embedding 准备和整批成功后原子发布快照的流程。完整准备覆盖 5,183 个 corpus 输入；实际测试另外生成 300 个在线 query embeddings。已有兼容快照可复用。
- 失败退出，不自动重复整批付费或耗时调用。新增或触及相关实现时用 ponytail 注释说明串行、无断点恢复的规模上限与未来升级条件。
- 一次完整评测创建一个正常迁移后的隔离 fixture，所有查询顺序复用；不写入运行时数据库。修正文档中每条 query 重建 fixture 的错误描述。
- 为完整真实评测提供明确、可配置的有限超时，依据预检估算选择运行值并记录；不得依赖默认短单测超时，也不得无限等待。
- 快照缺失、输入哈希过期、配置不匹配、provider 失败、维度错误或关键词降级都为硬失败。不得使用 mock 补齐真实基线。
- 成功报告持久化时复用现有报告构建及序列化路径。完整成功后才发布新基线；失败保留已有报告，避免将部分结果当成成功基线。
- 基线记录每查询原文、ID、tags、qrels、实际排名及公开 rank metadata、指标；汇总数量、macro averages、Judged@K、运行时间、指标 gain/K/阈值、文本与标题规则。
- 报告关联来源、split、数据及 corpus 快照哈希、代码 commit、模型/维度和脱敏服务身份。若代码工作区未提交，增加相关代码内容哈希，避免仅使用 HEAD 假称精确版本。运行配置仅采用明确允许的非敏感字段。
- 数据可重复导入；保存的 ranking 和 qrels 可独立复算指标。在线 query embedding 可能随服务端变化，因此不保证跨时间重跑得到完全一致的排名。
- Git 保存脚本、测试、文档、来源/转换 manifest 副本和首份完整基线报告。原始包、解压文件、转换数据及 embedding snapshot 留在独立本地忽略目录；保存快照供重跑复用。

### Delivery order and acceptance gates

1. 固定来源校验与导入规则，完成查询边界、标题边界和保留数据的数据库迁移。以空库及已有库升级测试通过为完成条件。
2. 完成 importer、manifest、完整输出校验及失败保护。以固定源输入导入得到 5,183 corpus、300 queries、339 qrels，且重复转换内容哈希一致为完成条件。
3. 对齐线性 NDCG、增加 Judged@K、持久报告及代码/配置身份。以独立参考对照、报告复算和失败不覆盖验证通过为完成条件。
4. 配置真实服务、完成小规模预检和完整 corpus 快照，再执行全部 300 条查询。以真实混合路径全部成功且首份完整报告保存为完成条件。
5. 更新数据契约、迁移、失败行为、完整运行和基线解释文档，验证文档所列命令及空数据库流程可复现。只有以上条件全部满足才可将实现标记完成。

## Testing Decisions

- 沿用访谈确认的测试边界：导入命令的产物与失败行为、现有公开评测 loader、正常迁移、真实 retrieval orchestration、固定排名的指标和报告输出。测试可观察行为，不复制 RRF 或 parser 实现，不另造生产检索路径。
- 导入测试使用最小的 BEIR 格式 fixture 覆盖重复 ID、未知文档/查询引用、非法等级、缺失正例、损坏 JSONL/TSV、空正文、字段超限和规范化；这些是格式测试数据，不充当真实 benchmark goldens。
- 实际固定 archive 的完整导入检查数量、test 选择和全部 qrel 引用，确保查询 528 和 41 篇长标题完整保留，规范化影响可追溯。验证 manifest 哈希及重复转换确定性。
- 以 256 code points 可接受、257 拒绝等边界验证 query；包含非 BMP 文本以发现 UTF-16/code-point 混用。title 验证 512/513 边界。
- 使用正常迁移测试空库和包含历史数据的旧库升级；验证旧记录、引用、索引和审计记录保留，新长度输入可正常通过公开检索流程写入。验证评测不修改 runtime 数据库。
- 指标测试保留现有确定性 IR 测试先例，但预期值必须对齐独立参考。使用包含 grade 0/1/2、无命中、晚命中、多正例、短 ranking、K 截断、未标注结果的固定 rankings 与 qrels，记录参考实现/版本和可重跑对照方法。独立验证工具不成为应用运行时依赖。
- 明确检查线性与指数 NDCG 会产生不同结果的案例；SciFact 的全 grade 1 数据不能作为分级 gain 正确性的唯一证据。
- Judged@K 验证显式 0、正例、缺失判断及空 ranking 的区分，并核对宏平均。原始 qrels 中不新增伪造 grade 0。
- 沿用现有 snapshot/fixture 测试，覆盖兼容完整快照复用、陈旧哈希、模型/endpoint/维度不匹配、服务失败及失败保留旧文件。新增导入和报告发布测试同样验证不会形成半成品或覆盖旧成功产物。
- 完整真实验收必须经过现有 prepare 和评测入口，使用 4096 维真实服务完成全部 corpus 与 test 查询。mock/offline 测试通过不能替代这一条件；测试超时需覆盖真实运行。
- 从保存的排名与 qrels 重算报告中的指标，核对运行身份、数据身份和报告字段；检查记录配置的方式不会包含密钥。
- 更新和执行相关测试后停止无依据的重复测试。规格文档本身不要求运行完整应用测试；真实运行属于后续实施验收。

## Out of Scope

- NFCorpus、MIRACL、TREC-COVID、MS MARCO 和通用数据集适配框架。
- 重新使用 production parser/chunker 加工 SciFact；生产 chunker 质量评估及 parent context window 质量评估。
- Synthesizer、语义分组、真实查询收集、人工 qrel 工作流、pooling 和 product-golden 数据集。
- 新增关键词-only/vector-only baseline、按 tags 切片报告、RRF/embedding/分词器调参、ANN 或性能压测。
- 查询向量缓存与回放、断点恢复、自动整批重试或为大规模数据改造快照存储。
- LLM 答案质量、tracing、Confident AI 上传和托管报告。
- 产品质量 gate，以及未核对输入处理与评测设置就声称可与公开排行榜直接比较。

## Further Notes

- 本规格源于已完成的逐轮访谈；用户确认首版范围、最小必要变更、真实运行验收、线性 NDCG、标题处理、Git 产物策略、在线查询语义、服务前置条件、无断点恢复及长度/规范化规则。当前请求为将共识发布成规格，不表示实现或真实运行已经完成。
- 关联前置规格：[Raw Hybrid Retrieval Deterministic Evaluation](../raw-hybrid-retrieval-eval/spec.md)。本规格将此前明确延期的数据供应推进为独立任务，并明确取代旧 NDCG gain、字段上限及“转换数据全部进入 Git”的相关约定；其他检索行为保持原有定义。
- 截至本次调查，本地未配置 embedding provider、model、endpoint 或维度，真实模型身份仍为未满足的运行前置条件。4096 维服务不可用时应报告阻碍，不自行改成其他维度或降低验收标准。
- 官方 ZIP 已在规划期间以内存读取方式核实数量、哈希和边界；实施仍必须对实际下载重新校验。数据版本以指定 archive hash 为准。
- 完整指标口径对照与 benchmark 输入处理是不同的验证：前者确定评分数学一致，后者决定检索成绩能否横向比较。
- 基线是 MyKnow 对 SciFact 文档级相关性映射后的 retriever benchmark，不是生产分块 benchmark 或业务质量保证。
- 官方参考：[BEIR 数据格式](https://github.com/beir-cellar/beir/wiki/Load-your-custom-dataset)、[数据表及 MD5](https://github.com/beir-cellar/beir/wiki/Datasets-available)、[固定源 ZIP](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip)、[corpus 数据卡](https://huggingface.co/datasets/BeIR/scifact/blob/main/README.md)、[qrels 数据卡](https://huggingface.co/datasets/BeIR/scifact-qrels/blob/main/README.md)、[BEIR 评测实现](https://github.com/beir-cellar/beir/blob/main/beir/retrieval/evaluation.py)、[TREC NDCG 实现](https://github.com/usnistgov/trec_eval/blob/master/m_ndcg_cut.c)。
