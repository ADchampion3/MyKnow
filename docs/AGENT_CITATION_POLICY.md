# Agent Wiki 引用策略

Agent 的 Wiki organize 计划支持两种服务端策略，由 `AGENT_CITATION_POLICY` 配置：

- `warn`（默认）：单条引用无法验证时保留可验证引用，记录警告并将计划项标记为 `unverified`。计划仍需人工审核；无效引用不会写入 Wiki 的 active provenance。
- `required`：保持严格模式。引用验证失败会使计划提交失败；缺少证据的计划项不能应用。

该策略只影响 `kind=organize` 的 Agent 计划。Agent answer 和手工 Wiki 写入接口始终使用严格引用校验。作用域、树结构、版本冲突、事务、审计和回滚校验不受影响。

`warn` 不是关闭校验：它只把单条引用验证错误降级为计划警告。源资料、页面版本和审计记录仍然保留；用户可以在人工审核后应用无引用或部分引用的 Wiki 版本，再通过手工引用接口补充正确 provenance。
