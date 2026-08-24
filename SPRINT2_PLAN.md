# Sprint 2 raw-source plan (current)

本文件替代早期包含 URL/Base64 实验的 Sprint 2 草案。当前定位是本地单用户个人知识库；允许为更简单、可验证的模型破坏未完成的旧 schema 和派生数据。

## 目标

- 接收 JSON 文本和 native `multipart/form-data` 的本地 `.md`、`.txt`、`.pdf`。
- PDF 处理支持显式 `ocrMode`（`auto`、`off`、`force`）和 `ocrProvider`（`local`、`cloud`、`paddleocr`）；选择随版本、任务和处理 run 持久化。
- 为每次提交建立不可变 `resource_versions`；原始字节以 SHA-256 内容寻址保存。
- 用 `current_version_id` 表示最近一次成功索引的版本；默认搜索只看当前版本，历史版本必须显式指定。
- 解析和索引采用 build-then-swap：新版本成功前保留旧活动索引。
- OCR canonical artifact 保留页码、页面终态、text/table/formula 区块、warnings 和页码范围 locator；失败不替换旧 FTS。
- 任务最多三次总尝试；只有瞬态错误自动重试，手工重试创建新任务并保留旧记录。
- 归档/恢复只改变可见性和任务状态，不删除原始材料、版本或处理记录。

## 状态

- Resource: `pending` → `processing` → `indexed`；当前版本存在但最新版本失败时为 `degraded`；无当前版本且最新版本失败时为 `failed`；任何状态可进入 `archived`，恢复后重新排队未成功版本。
- Version: `pending` → `processing` → `indexed` 或 `failed`。
- Task: `queued` → `running` → `succeeded` / `failed`，瞬态失败可进入 `retrying`。

同一版本只允许一个活动处理任务；数据库部分唯一索引和事务认领共同保证这一点。默认列表和搜索隐藏归档资源。

## API 约定

- `POST /api/resources`: JSON `{ name, knowledgeBaseId, content }` 或 multipart `{ name, knowledgeBaseId, file }`。
- PDF multipart 还必须提供 `ocrMode` 和 `ocrProvider`；`auto` 为 OCR-first/native fallback，`off` 为 native-only，`force` 禁止 native fallback。
- `POST /api/resources/:id/versions`: 创建后续版本。
- `PATCH /api/resources/:id`: 只修改显示名称。
- `POST /api/resources/:id/archive|restore`、`POST /api/resources/:id/rebuild`、`POST /api/resources/:id/retry`、`POST /api/tasks/:id/cancel`：归档、全量重建、失败版本手工重试和取消任务。
- `Idempotency-Key` 可选；同 key 同请求返回原结果，不同请求返回冲突。没有 key 的重复提交始终创建独立版本。
- DTO 不暴露存储键和 canonical 路径；下载和内部读取会重新校验 SHA-256 与字节数。

URL、服务器路径、Base64 和多用户权限不属于当前输入或安全边界。

## 数据和迁移

当前 schema 标记为 `sprint2-pdf-ocr-v2`。旧实验数据库不会兼容迁移；启动时返回 `DATABASE_RECREATE_REQUIRED`，使用以下命令建立干净数据库：

```text
npm run db:recreate -- --confirm D:\MyKnow\data\myknow.db
```

该命令只替换 SQLite 文件，保留 `data/resources` 原始存储。孤儿 blob 通过 `npm run check:storage` 报告但不自动删除。

## 验收

- `npm run check:all`
- `npm run check:ocr`
- `npm run check:storage`
- `npm test`
- `npm --workspace apps/web exec next build`
- `node --check` touched JavaScript modules

逐字段请求/响应、状态转变、迁移和存储规则见 [`docs/SPRINT2_RAW_SOURCE_CONTRACT.md`](docs/SPRINT2_RAW_SOURCE_CONTRACT.md)。PDF OCR 细节见 [`docs/SPRINT2_PDF_OCR.md`](docs/SPRINT2_PDF_OCR.md)。本轮基线证据见 [`artifacts/sprint2/acceptance-report.md`](artifacts/sprint2/acceptance-report.md)，OCR 扩展证据见 [`artifacts/sprint2/pdf-ocr-evidence.md`](artifacts/sprint2/pdf-ocr-evidence.md)。
