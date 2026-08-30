# MyKnow

MyKnow 是一个本地优先的个人知识库原型。当前仓库保留 Web、API、Worker 三个运行进程，以及 SQLite 数据层；产品和领域定义分别见 [`PRD.md`](PRD.md) 与 [`CONTEXT.md`](CONTEXT.md)。

## 启动

要求 Node.js 20+。在三个终端分别运行：

```powershell
npm run dev:api
npm run dev:worker
npm run dev:web
```

默认端口：API `3001`，Web `3000`。API 健康检查：`GET /health`；就绪检查：`GET /ready`。

复制 `.env.example` 为 `.env` 后可调整数据库、资源存储、模型和端口配置。密钥只放在服务端环境变量中，不要写入前端代码、业务数据或日志。

## 运行边界

- API 和 Worker 共用 SQLite 数据库。
- Worker 通过数据库轮询任务并处理资料、检索和 Agent 工作。
- Web 通过 API 访问业务数据。
- 原始资源存放在 `RESOURCE_STORAGE_DIR` 指定的服务端目录。
- 数据库重建工具：`npm run db:recreate`；过期派生数据先用 `npm run db:cleanup-derived -- --dry-run` 预览，确认后追加 `--confirm`。

## 目录

```text
apps/api/        HTTP API 与路由
apps/worker/     任务轮询、资料处理、OCR、嵌入和 Agent 执行
apps/web/        Next.js Web 界面
packages/db/     SQLite/Drizzle schema、迁移和领域数据操作
packages/config/ 运行配置与敏感信息处理
scripts/         运行所需的数据库/PDF 辅助脚本
docs/agents/     仓库协作与领域文档规则
docs/CHUNKING_MECHANISM.md   当前分块机制与审核
docs/RETRIEVAL_MECHANISM.md  当前检索机制与审核
```

项目细节仍在重新设计中；新的设计决定和验证方式应在需求明确后再补充。
