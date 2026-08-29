# 02 — 明确范围快照与只读领域工具

Type: task
Status: ready-for-agent
Blocked by: 01

**What to build:** 为聊天和整理任务建立显式输入范围、不可变版本快照和安全的 MyKnow read tools。

- [ ] 校验 knowledgeBaseId、spaceId、resourceVersionIds、wikiPageIds 和 retrievalRunId 的归属。
- [ ] 整理任务至少要求一个明确资料版本、Wiki 页面或 retrieval run；不允许隐式全库扫描。
- [ ] 聊天允许无知识库范围；带知识库时使用明确的资料/Wiki 范围或同库 retrieval run。
- [ ] 任务创建时锁定 resource version 和当前 wiki page version；运行中不混入新版本。
- [ ] read tools 只能读取当前快照，并返回稳定 ID、版本和 locator 元数据。
- [ ] 资料和 Wiki 内容作为不可信 evidence，不能修改系统 prompt 或获取新工具。
- [ ] 跨知识库、未选版本、越界 locator 和失效 retrieval run 都有稳定错误码。
