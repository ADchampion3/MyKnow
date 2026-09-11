# MyKnow

MyKnow 是一个本地优先的个人知识库原型。当前仓库保留 Web、API、Worker 三个运行进程，以及 SQLite 数据层；产品和领域定义分别见 [`PRD.md`](PRD.md) 与 [`CONTEXT.md`](CONTEXT.md)。

## 启动

要求 Node.js 20+。首次安装依赖后，在仓库根目录运行：

```powershell
npm install
npm run dev
```

`npm run dev` 会在一个终端启动 API、Worker 和 Web，按 `Ctrl+C` 会一起停止。默认端口：API `3001`，Web `3000`。API 健康检查：`GET /health`；就绪检查：`GET /ready`。

本地 mock 模式不需要创建 `.env`，默认会使用 SQLite `data/myknow.db` 并自动创建数据目录。如需调整端口、数据库、资源目录或接入真实模型，再复制 `.env.example` 为 `.env`。密钥只放在服务端环境变量中，不要写入前端代码、业务数据或日志。需要单独调试某个进程时，仍可使用 `npm run dev:api`、`npm run dev:worker` 或 `npm run dev:web`。

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

API 的 Fetch 请求/响应边界、Zod 校验、错误脱敏和上传大小策略见
[`docs/API_HTTP_BOUNDARY.md`](docs/API_HTTP_BOUNDARY.md)。

## Wiki mechanism

Wiki 页面、版本、引用、索引和 Agent 审核机制见 [`docs/WIKI_MECHANISM.md`](docs/WIKI_MECHANISM.md)。
Agent Wiki 引用的 `warn|required` 策略见 [`docs/AGENT_CITATION_POLICY.md`](docs/AGENT_CITATION_POLICY.md)。
Web 工作台的模块布局、视觉令牌和空数据库启动说明见 [`docs/FRONTEND_UI.md`](docs/FRONTEND_UI.md)。

## Eval dashboard

启动开发栈后打开 `http://localhost:3000/evals/raw-hybrid`，查看 SciFact raw-hybrid retrieval 报告。页面说明见 [`docs/RAW_HYBRID_RETRIEVAL_DASHBOARD.md`](docs/RAW_HYBRID_RETRIEVAL_DASHBOARD.md)。
