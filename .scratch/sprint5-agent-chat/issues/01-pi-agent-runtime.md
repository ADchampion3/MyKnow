# 01 — Pi Agent runtime、Provider 与权限边界

Type: task
Status: ready-for-agent
Blocked by: None

**What to build:** 在 Worker 中接入 Pi Agent SDK，建立 answer/organize 两种运行 profile，服务端配置模型和 AI 出口，并严格限制工具白名单。

- [ ] 固定并安装 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai 的精确版本；不引入 pi-coding-agent CLI。
- [ ] 从 MODEL_PROVIDER、MODEL_NAME、MODEL_API_BASE_URL、MODEL_API_KEY 创建 Pi model；密钥只存在 Worker 进程。
- [ ] 支持 deterministic mock model 和 local_only/allow_cloud 出口校验，禁止隐式 Provider 切换。
- [ ] 只注册 MyKnow 只读领域工具和 submit_answer、submit_change_plan；没有 filesystem、Shell、web、MCP 或 SQL 工具。
- [ ] 映射 Pi agent/turn/tool/provider 事件，保存脱敏的 agent_events。
- [ ] 配置 8 轮、32 次工具调用、120 秒硬上限；取消使用 AbortSignal，失败交给现有 task retry。
- [ ] 为 prompt、answer contract 和 plan contract 记录版本。
