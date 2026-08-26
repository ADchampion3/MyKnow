# 03 — 类型化 Wiki 页面与版本化模板

**What to build:** 用户可以在主题树中创建 `concept`、`entity`、`source-summary` 或 `synthesis` 页面；新页面使用当前模板版本，模板修改不会重写已有页面。

**Blocked by:** 02 — 知识库 Wiki 首页与主题树

**Status:** ready-for-agent

- [ ] 可以创建普通 Wiki 页面并设置页面类型、标题、slug、空间和父页面。
- [ ] 新页面使用对应页面类型的当前模板。
- [ ] 模板可按知识库配置章节顺序、标题、必需性和说明。
- [ ] 修改模板后，新页面使用新模板，历史页面保持原内容和模板快照。
- [ ] 页面正文以 Markdown 保存并可渲染预览。
- [ ] API 和 UI 都拒绝无效页面类型、非法模板定义和重复 slug。
- [ ] 有 focused check 覆盖默认模板、自定义模板和旧页面不变。
