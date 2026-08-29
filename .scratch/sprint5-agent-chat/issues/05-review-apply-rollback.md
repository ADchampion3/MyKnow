# 05 — 审核、标签、事务应用与回滚

Type: task
Status: ready-for-agent
Blocked by: 04

**What to build:** 用户可以逐项接受/拒绝 Wiki 计划，批量接受低风险页面标签，并安全应用或回滚。

- [ ] 采用独立的 review status 和 application status，覆盖 proposed、approved、rejected、applied、stale、apply_failed、rolled_back。
- [ ] 支持树分支审核：根分支按父先子后在一个事务中应用，单项子节点不能绕过被拒绝或未应用的父节点。
- [ ] 审核前允许编辑标题、类型、正文和父节点引用，并重新校验整棵计划。
- [ ] page_update 接受时以事务校验 base page version，写入不可变 page version、blocks、citations、link edges 和 audit log。
- [ ] page_create 不能修改 index/log 系统页；应用后排队 Wiki embedding task。
- [ ] 新增页面级 wiki_page_tags；tag_add 是唯一允许批量审核的变更，最多 50 项且整批事务应用。
- [ ] 页面更新、页面创建和冲突处理逐项审核；接受后立即应用，失败不留下半成品。
- [ ] 回滚要求当前页面版本仍等于 appliedPageVersionId；使用现有 restore 机制创建新版本。
- [ ] 新页面回滚使用 archive 语义；不物理删除原始资料、审计或计划记录。
- [ ] 版本漂移、重复审核、越权页面和重复幂等请求都有稳定错误。
