# Sprint 5 evidence manifest

Status: captured for the local focused gate and the real DeepSeek open-chat smoke test

本目录记录 Sprint 5 的可复现验收证据。`acceptance-report.md` 是当前运行结果；重新运行 focused checks 会刷新同名证据文件。

## Required evidence

| 文件 | 证明内容 | 生成方式 |
| --- | --- | --- |
| acceptance-report.md | 最终验收结论、环境和未完成项 | `npm run check:sprint5` |
| agent-plan-review.jsonl | 整理计划、逐项接受/拒绝、批量标签审核、页面回滚和版本漂移 | check:agent / check:sprint5 |
| open-chat.jsonl | 20 条无知识库聊天、带范围开放回答和 no_match | check:chat |
| agent-contract.js 输出 | index_unavailable 及输出契约降级语义 | check:agent / check:sprint5 |
| agent-events.jsonl | Pi 阶段、工具调用、Provider 指标和失败 trace | check:agent / check:chat |
| provider-evidence.log | mock、本地 OpenAI-compatible Provider 和真实 DeepSeek 状态 | `npm run check:sprint5`；真实调用用 `npm run check:deepseek` |
| deepseek-provider.json | 不含密钥的真实 DeepSeek 冒烟摘要 | `scripts/deepseek-api-check.js` |
| migration-rebuild.log | 空库启动和 Sprint 5 数据库安全重建 | `agent-rebuild-check` |
| security-scan.log | 密钥、系统 prompt、完整原文和未脱敏工具结果扫描 | agent-security-check |
| sprint5-layout.png | 三栏聊天、计划 diff、引用和 trace 工作区 | Web layout check |

## Required metadata

每个证据文件应记录：

- 运行日期和时区。
- Node/npm 版本和 commit。
- 使用的数据库文件路径和资源存储路径。
- 配置摘要；不得记录 API key。
- 执行命令、退出码和通过/失败结论。
- 真实 Provider 未运行时，必须明确写为 skipped 或 unavailable。

## Evidence gate

Sprint 5 focused checks、Web build、空库启动和迁移重建均已记录。真实 DeepSeek 冒烟已通过；严格 mode 和 SSE 不属于本 Sprint 的失败项，但必须在 SPRINT5_BACKLOG.md 中保持可见。
