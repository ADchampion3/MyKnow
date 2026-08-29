# 04 — Wiki 变更计划、引用和风险校验

Type: task
Status: ready-for-agent
Blocked by: 02

**What to build:** Agent 使用通用推理能力读取、比较和规划资料，输出结构化的 Wiki 变更计划，而不是直接写入。

- [ ] 新增 agent:organize task、agent_runs 和 agent_plan_items。
- [ ] submit_change_plan 只接受 page_create、page_update、tag_add、duplicate_finding、conflict_finding。
- [ ] page_update 使用完整 Markdown 和 basePageVersionId；服务端计算 diff，不接受模型 Patch 直接写入。
- [ ] 每条实质性内容建议校验资料版本和 locator；缺证据项标记 needs_evidence 且不可应用。
- [ ] 引用和 Wiki 链接作为页面变更项字段，服务端校验后派生 citations 和 link edges。
- [ ] 服务端根据 item type 计算风险，不信任模型自报风险。
- [ ] 新页面的 page type、space、parent 和 slug 经过同库约束与服务端规范化。
- [ ] tree mode 生成唯一 root 和有限多层 page tree，使用 nodeId/parentNodeId 直到审核应用时再分配页面 UUID。
- [ ] 树根只可顶层创建或挂载到显式选择的非 system Wiki 页面；index/log 永不修改。
- [ ] duplicate_finding 和 conflict_finding 只进入审阅记录，不自动合并或改写 Wiki。
