# Sprint 3 — LLM Wiki 双投影知识库

来源：已确认的 Sprint 3 计划设计。

Sprint 3 将 MyKnow 建成以 LLM Wiki 为默认入口、以原始 FTS/向量检索为保底的双投影知识库。所有原始资料和版本保持不可变；适合沉淀的资料进入 Wiki 投影，结构完整的资料可以设置为 `retrieval-only`。

本 Sprint 交付 Wiki 首页和主题树、类型化 Markdown 页面、模板版本、页面版本/diff/恢复、结构化引用、只读原始资料跳转、资料更新后的影响标记，以及从空数据库和干净数据库重建路径启动的证据。

真实 LLM/Agent 生成、多页面变更计划、审核和 Wiki-first 问答属于后续 Sprint。

## Tickets

1. 数据库 schema 与保留数据重建
2. Wiki 首页与主题树
3. 类型化 Wiki 页面与模板
4. 编辑、diff、恢复与版本冲突
5. Block 引用与只读原始资料
6. retrieval-only 资料策略
7. Wiki 引用影响扫描
8. Sprint 3 集成验收与证据
