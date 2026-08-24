# PDF OCR Processing

Status: ready-for-agent

## Problem Statement

当前 PDF 处理是“文本层解析优先”：先尝试 MarkItDown，再使用基础 PDF 字面量回退。它能完成机械导入、分块、子块 FTS 和 build-then-swap，但不能可靠处理扫描件、图片型 PDF 或损坏的 Unicode 映射。

现有质量门禁主要检查空文本、替换字符、控制字符和最小文本长度，无法识别“可打印但语义错误”的中文乱码。已有 Sprint 2 证据已经记录了这种情况：视觉上可读的中文 PDF 可能被成功索引为 mojibake。没有文本层的 PDF 则无法进入可搜索知识库。

用户需要在保持原始材料不可变、处理过程可审计、失败不破坏旧索引的前提下，增加 OCR，使中文/英文扫描资料、低质量文本层和常见复杂版面能够进入同一套 canonical artifact、分块和搜索链路。

## Solution

将 PDF 解析改造成 OCR-first 的处理管线，并在现有 MaterialReader seam 后放置一个统一 OCR adapter interface。

PDF 支持三种处理模式：

- auto：先执行 OCR；OCR 不可用、失败或未通过质量门禁时回退到现有原生文本解析链路。
- off：跳过 OCR，仅使用原生文本解析。
- force：仅执行 OCR；OCR 失败时整次 processing run 失败，不回退。

每次 PDF 导入或重处理都必须明确选择 local 或 cloud Provider。Provider 选择写入任务和资源版本的处理请求，重试、Worker 重启和启动补偿任务都复用原选择；系统不会因本地 OCR 失败而自动把材料发送到云端。

OCR adapter 接收 Worker 已验证的服务端文件路径、PDF 元数据、请求的能力、资源限制和取消信号，负责页面渲染、OCR 引擎、逐页并发、Provider 调用、Provider 重试以及取消传播。Worker 继续负责任务状态、processing run、审计、质量门禁、canonical artifact、分块、FTS 和 build-then-swap。

adapter 返回 page/block 结构。页面 block 支持 text、table、formula 三种类型，并保留页码、顺序、文本、可选置信度和 warnings。表格以 GFM Markdown 表达，公式以 LaTeX 表达；canonicalText 从页面结构派生并包含稳定页码标记。第一版不保存词级坐标或版面框。

OCR 结果只有在所有页面都获得终态、通用质量门禁通过、请求能力满足且没有未解决页面错误时才允许激活。失败处理保持现有 build-then-swap 语义：旧的 active processing run、chunks 和 FTS 继续可用。

## User Stories

1. As a researcher, I want to import a scanned PDF, so that its printed Chinese and English content becomes searchable in my knowledge base.

2. As a researcher, I want a PDF with no usable text layer to be processed through OCR, so that image-only pages do not silently become empty resources.

3. As a researcher, I want a PDF with visibly readable but corrupted text-layer encoding to be OCR-processed, so that search does not index printable mojibake as if it were correct text.

4. As a researcher, I want Chinese and English printed text to be handled in the same OCR request, so that bilingual papers and books remain searchable without separate imports.

5. As a researcher, I want common two-column and header/footer layouts to preserve reading order, so that retrieved chunks remain understandable.

6. As a researcher, I want recognized tables represented as Markdown tables, so that table relationships remain usable in search and later RAG prompts.

7. As a researcher, I want recognized formulas represented as LaTeX, so that mathematical meaning is not reduced to an arbitrary image-only block.

8. As a researcher, I want every OCR block to retain its source page number, so that search results and later answers can cite the original PDF page.

9. As a researcher, I want OCR output to be searchable through the existing child-only FTS index, so that OCR does not introduce a separate search path.

10. As a researcher, I want to choose a local, generic cloud, or PaddleOCR Provider for each import or reprocessing task, so that I can make an explicit privacy and quality tradeoff.

11. As a researcher, I want the system to reject an OCR-enabled request with a stable validation error when no Provider is selected, so that the processing choice is never guessed.

12. As a researcher, I want cloud OCR to receive rendered page images rather than the original PDF, so that only the pages required by the adapter leave the local process.

13. As a researcher, I want the system to keep cloud credentials and Provider configuration server-side, so that secrets do not appear in browser bundles, task DTOs, audit logs, or business records.

14. As a researcher, I want an off mode that bypasses OCR, so that I can use the existing native parser when OCR is unnecessary or undesirable.

15. As a researcher, I want a force mode that fails instead of silently falling back, so that an OCR-specific processing request cannot be mistaken for a native-text result.

16. As a researcher, I want OCR processing to run through the existing queued Worker task, so that a slow document does not block the API request.

17. As a researcher, I want page-level progress and a clear terminal task state, so that I can tell whether a long OCR task is still running, succeeded, failed, or was retried.

18. As a researcher, I want cancellation and timeout signals to stop page rendering, local subprocesses, and cloud requests, so that a cancelled task does not continue consuming resources invisibly.

19. As a researcher, I want OCR failures to leave the previous indexed version searchable, so that a bad OCR attempt cannot blank an already usable knowledge base.

20. As a researcher, I want the original PDF bytes, SHA-256, filename, and audit records preserved, so that OCR remains a derived processing result rather than a replacement for the source.

21. As a researcher, I want to inspect which Provider, adapter version, model/version, page count, request ID, duration, warnings, and cost fields were involved, so that OCR quality and privacy decisions remain auditable.

22. As a researcher, I want native and OCR processing attempts recorded separately, so that a successful fallback explains how the final canonical result was produced.

23. As a researcher, I want repeated requests with the same idempotency key but different OCR settings to be rejected, so that a transport retry cannot silently change processing semantics.

24. As a researcher, I want a reprocessing request to preserve its selected mode and Provider across retries and Worker restarts, so that the eventual result matches the choice I made.

25. As a researcher, I want archived resources to remain excluded from OCR work, so that archive semantics continue to protect both the source and the queue.

26. As a maintainer, I want to replace or add a local OCR engine without changing ResourceProcessor, so that engine-specific complexity stays localized behind one deep interface.

27. As a maintainer, I want the OCR adapter to declare supported capabilities and page completion status, so that the Worker can enforce stable activation rules without knowing engine internals.

28. As a maintainer, I want automated tests to use local fixtures and a mock cloud adapter, so that the test suite verifies external behavior without network cost or Provider nondeterminism.

29. As a maintainer, I want real cloud runs recorded as separate manual evidence, so that automated checks remain reproducible while cloud behavior is still demonstrated.

30. As a maintainer, I want a clean empty-database startup and a reproducible migration path for OCR metadata, so that the early-development breaking-schema policy remains operable.

31. As an operator, I want local OCR dependencies installed through the project Python environment using the configured UV mirror, so that setup is reproducible on the development machine.

32. As an operator, I want temporary rendered page images removed after processing, so that OCR does not leave untracked copies of source material.

33. As a reviewer, I want a fixture proving table and formula block structure, so that the P0 capability is tested rather than claimed from a non-empty OCR string.

34. As a reviewer, I want a fixture proving that OCR failure and fallback do not change the source hash or active FTS rows, so that data preservation is independently verifiable.

## Implementation Decisions

- The existing injected MaterialReader seam is the primary external seam. ResourceProcessor remains the caller and does not learn engine-specific OCR details. OCR adapter implementations satisfy the reader interface and return the same high-level parsed-material contract plus structured OCR metadata.

- The adapter interface is intentionally deep: the caller supplies a validated server-side source path, immutable source metadata, requested mode/provider, requested capabilities, resource limits, and an AbortSignal. The adapter hides page rendering, preprocessing, page-level concurrency, local subprocess management, cloud HTTP calls, Provider retry, output normalization, and cleanup.

- The adapter must not access SQLite, create tasks, write chunks, activate a processing run, or bypass audit hooks. Those responsibilities remain in Worker processing modules.

- PDF mode semantics are fixed. auto is OCR-first with native fallback; off is native-only; force is OCR-only. The existing MarkItDown and pdf-basic candidates remain available as native fallback readers, not as the primary PDF path.

- Import and reprocess contracts accept OCR mode and Provider selection. local and cloud are the only Provider choices in this slice. OCR-enabled requests without an explicit Provider fail validation with a stable machine-readable error. The Web flow, when present, passes these values through the existing REST/multipart flow; users select a Provider, not a concrete engine.

- The selected mode and Provider are persisted with the processing request in the task payload and the resource version's current requested settings. A retry, interrupted-task recovery, startup compensation task, rebuild, restore, or manual retry reuses the stored selection. Each processing run still records the actual adapter/Provider used, so historical runs cannot be rewritten by later configuration changes.

- Idempotency fingerprints include OCR mode and Provider. A repeated request with the same idempotency key but different OCR settings is a conflict.

- The generic cloud adapter receives locally rendered page images, not the original PDF bytes. The PaddleOCR adapter is an explicit vendor-specific exception: its async API accepts the server-side PDF upload and returns a JSONL result. Cloud secrets remain in server-side configuration. Normal logs, task DTOs, canonical business records, and audit records never contain API keys, full prompts, or durable raw page images.

- The stable OCR result is a versioned page/block artifact. Each page has a page number and terminal processing status. Each block has a kind, order, text, optional confidence, and warnings. Supported kinds are text, table, and formula. The artifact also records capabilities, adapter/provider metadata, metrics, and warnings without exposing storage coordinates.

- Table block text uses GFM Markdown. Formula block text uses LaTeX. OCR output does not include word-level bounding boxes, page-region geometry, or a normalized cells/formulas database in this slice.

- canonicalText is derived from the page/block artifact, preserves page order, and includes stable page markers so existing chunk offsets can be linked back to source pages. Chunk locator metadata gains page range and block-kind information while retaining existing resource-version and processing-run identity.

- The Worker owns generic quality gates and activation invariants. A run cannot activate when a page is unprocessed, a page error remains unresolved, output is empty, output fails printable/control/replacement checks, or the requested capability result is structurally invalid. General unknown-document accuracy is not inferred from a Provider confidence score.

- OCR page processing is all-or-nothing at the document run level. The adapter may retry individual pages and may process pages concurrently within its own implementation, but an unresolved page fails the run. Vendor job adapters must bound active asynchronous jobs; PaddleOCR defaults to one active job per Worker process and polls each job sequentially. Worker-level cancellation, total timeout, task state, and resource limits are passed through the AbortSignal and adapter interface. A cancelled or failed run never swaps out the active run.

- The adapter exposes capability and completion metadata for text, table, and formula processing. Fixed fixtures enforce the structural contract for these capabilities; arbitrary documents may produce explicit warnings when recognition is uncertain, but cannot silently claim a missing page or block was processed.

- Provider/model/version/request ID/duration/page count/warnings and cost-related metrics are retained in processing attempt or canonical metadata. Secrets and full raw Provider responses are not persisted.

- The existing source integrity checks, content-addressed raw blobs, processing_run_attempts, build-then-swap activation, child-only FTS, archive semantics, and historical-version search isolation remain in force.

- The schema change is intentionally breaking for this early single-user project. It must support clean empty-database startup and a reproducible recreation/migration path. Original source bytes and audit records are preserved; derived canonical artifacts, chunks, FTS rows, and OCR metadata may be rebuilt.

- Local OCR dependencies are installed into the project PDF Python environment. Installation commands use the configured PowerShell mirror setting: UV_DEFAULT_INDEX points to the Tsinghua PyPI simple index. The concrete local engine is an adapter implementation detail and is selected by fixture results, not exposed as a user-facing engine choice.

- The OCR slice adds no separate OCR HTTP service. It deepens the existing Worker reader module and reuses the existing API task and processing-run flow. The Web/API surface only carries user-selected OCR mode and Provider values.

- Sprint 2 PDF evidence remains historical and unchanged. OCR is a new slice with its own migration notes, focused checks, full-chain evidence, and reports under the next sprint evidence directory.

## Testing Decisions

- Tests cross the highest useful seam: the injected MaterialReader/OCR adapter interface and the existing API-to-Worker-to-SQLite full-chain harness. Tests should assert externally visible parsed output, task states, processing-run attempts, canonical page/block metadata, search behavior, source integrity, and rollback behavior rather than private helper calls.

- The primary focused seam is the adapter contract. A fake local adapter and fake cloud adapter can exercise the same Worker processing path, while adapter-specific tests cover page rendering, output normalization, page concurrency, cancellation, Provider error mapping, temporary-file cleanup, and capability metadata.

- Extend the existing material-reader self-check to cover OCR-first ordering, off and force modes, explicit Provider validation, structured page/block output, table Markdown, formula LaTeX, page warnings, native fallback, and source-integrity failure.

- Extend the API contract checks to cover OCR mode and Provider fields on JSON/multipart import and reprocess requests, stable validation errors for missing/unsupported values, idempotency conflicts when OCR settings differ, DTO redaction, and persistence of the selected processing request.

- Extend the Worker check to cover task payload persistence, retry and interrupted-task recovery with the same Provider, page progress, AbortSignal cancellation, all-or-nothing page failure, OCR-to-native fallback, force-mode failure, processing_run_attempts metadata, canonical artifact publication, page-aware chunk locators, and build-then-swap preservation of the previous active index.

- Extend the existing PDF full-chain harness rather than creating a parallel lifecycle. It should run isolated API/Worker/database/storage processes, upload an OCR fixture, wait for queued/running/succeeded or failed transitions, inspect the canonical artifact, search a selected OCR token, verify page metadata, verify child-only FTS, and verify source SHA-256 round-trip.

- The deterministic fixture set should include: a native text PDF; an image-only Chinese/English PDF; a visually readable PDF with a broken text map; a two-column PDF; a PDF containing a table; a PDF containing a formula; a mixed PDF with both text and image pages; and a fixture whose adapter fails on one page.

- Fixture assertions should require full page status coverage, correct page numbering, expected block kinds, readable text, Markdown table structure, LaTeX formula structure, searchable child chunks, and explicit warnings for unsupported or uncertain content. Unknown real documents are not used to claim universal semantic accuracy.

- Generic cloud behavior is tested automatically through a mock cloud adapter that asserts it receives rendered page images and no raw PDF upload. PaddleOCR behavior is tested with a fake async job endpoint for submission, polling, JSONL normalization, cancellation, and concurrency bounds. A separately run manual Provider check records Provider/model/request metadata and network-dependent evidence; it is not a prerequisite for deterministic local checks.

- Regression checks must prove that OCR success does not alter immutable source bytes, OCR failure does not delete the active FTS rows, a failed replacement leaves current_version_id unchanged, historical runs remain inspectable, archived resources are not processed, and raw/audit records are never physically deleted.

- Reproducible evidence records commands, timestamp, environment, fixture identity, selected mode/Provider, task transitions, parser attempts, page/block counts, canonical digest, search result, source digest, and failure/rollback outcome under the new sprint evidence directory.

- Prior art is the existing material-reader self-check, API contract harness, Worker state-transition check, chunker checks, storage integrity check, and timestamped PDF full-chain evidence. The new tests should extend those seams and conventions rather than introduce a second task lifecycle.

## Out of Scope

- Handwritten OCR, signatures, stamps, cursive text, and handwriting recognition.
- Word-level bounding boxes, page-region geometry, visual layout trees, or coordinate-based highlighting.
- A normalized OCR pages/blocks/cells/formulas database.
- Guaranteed perfect table reconstruction or formula semantics for arbitrary real-world PDFs. Fixed fixtures have structural acceptance requirements; unknown documents may carry warnings.
- Automatic Provider selection, automatic local-to-cloud fallback, automatic quality comparison by an LLM, or silent external uploads.
- Uploading the original PDF directly to a generic cloud Provider; PaddleOCR's explicit vendor-specific PDF upload is implemented as the `paddleocr` Provider.
- Exposing concrete OCR engine selection to users or implementing several local engines as a public API.
- Languages beyond the initial Chinese and English scope.
- URL fetching, Base64 imports, PDF source deletion, source mutation, multi-user collaboration, production deployment, RAG generation changes, Agent writes, Wiki review/rollback, or vector indexing.
- Replacing or rewriting Sprint 2 evidence.
- Real cloud calls in the default automated test suite.
- OCR support for non-PDF resources.

## Further Notes

The current PDF reader is intentionally documented as best-effort in Sprint 2. This spec changes the PDF processing path for a new slice while preserving that historical evidence and the existing immutable source/audit model.

The selected seam keeps OCR complexity local: callers learn one reader/adapter interface, while local and cloud implementations can evolve behind it. The Worker remains the authority for task state, processing-run activation, source integrity, and rollback safety.

The implementation should first prove the adapter contract and deterministic fixtures with a minimal local implementation. Any dependency installation uses the configured UV mirror:

`UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple`

A missing local OCR runtime must produce an explicit adapter/Provider failure and, in auto mode, allow the existing native candidates to decide whether the document can still be indexed.
