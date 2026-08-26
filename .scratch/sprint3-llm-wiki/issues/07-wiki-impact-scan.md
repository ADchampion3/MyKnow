# 07 — 资料更新后的 Wiki 引用影响扫描

**What to build:** 资料新版本成功索引后，Worker 自动检查相关 Wiki 引用并标记受影响内容，但不自动改写 Wiki。

**Blocked by:** 05 — Wiki block 引用与只读原始资料

**Status:** ready-for-agent

- [ ] 资料新版本成功后产生可审计的 `wiki:impact-scan` 任务。
- [ ] 引用旧资料版本的 Wiki block 进入 `needs_review`。
- [ ] 无法读取目标版本或 locator 的引用进入 `broken`。
- [ ] 仍然有效且没有更新影响的引用保持 `active`。
- [ ] 旧 Wiki 页面和旧资料版本仍可查看和回溯。
- [ ] Worker 失败、重试和最终结果可从任务界面定位。
- [ ] focused check 覆盖资料更新、影响状态、任务审计和无自动改写。
