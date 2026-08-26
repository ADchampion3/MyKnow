# 02 — 知识库 Wiki 首页与主题树

**What to build:** 用户打开知识库时默认进入持久化的 Wiki `index/overview`，可以浏览空间、页面树和系统 `log` 页面，并在 Wiki 为空时看到可整理资料和原始资料入口。

**Blocked by:** 01 — Sprint 3 Wiki schema 与数据保留重建

**Status:** ready-for-agent

- [ ] 知识库默认入口是 Wiki，而不是资料列表。
- [ ] 页面树支持知识库、空间、父子页面和稳定页面身份。
- [ ] 页面 slug 校验并阻止页面循环或非法父页面关系。
- [ ] `index/overview` 和追加式 `log` 页面可浏览。
- [ ] Wiki 为空时不静默跳转到资料列表，而是显示原始资料入口。
- [ ] 刷新后页面树和默认入口保持一致。
- [ ] 1280px 三栏和 1024px 核心导航有可复现的 UI 检查。
