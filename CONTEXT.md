# MyKnow 检索上下文

MyKnow 的检索上下文围绕版本化 Wiki、可追溯的原始资料和一次检索产生的证据快照组织。检索负责召回和解释证据，不负责生成答案或直接修改 Wiki。

## Language

**Retrieval run**：一次针对知识库的检索执行，包含查询范围、候选结果、图扩展、来源追踪和上下文快照。

**Wiki seed**：直接命中的 Wiki 页面结果；只有通过置信度门槛的 seed 才能启动 Wiki graph expansion。

**Raw child chunk**：来自当前成功资料版本的可检索原始文本片段，保留父级上下文和 locator；它不是 Wiki graph 节点。

**Provenance lookup**：把 Wiki 页面或引用追溯到原始资料版本和 locator 的来源查询；它不是 Wiki graph edge。

**Context snapshot**：一次检索按独立 Wiki/raw 预算组装出的证据文本和定位元数据，用于展示和 trace replay。

**Canonical text**：资料经过统一规范化后、可作为定位基准的原文表示；它保留原始语义，不等同于模型 token 序列。

**Parent context window**：围绕结构边界组织的较大原文上下文窗口，用于恢复命中片段的定义、条件和相邻说明；它不是单纯放大的 child。

**Child retrieval fragment**：从 parent context window 中产生的可检索原文片段，负责关键词/向量召回，并保留对 canonical text 的定位。

**Strong structure**：代码块、表格、公式等需要专用切分规则的结构；普通自然语言可以跨短段落合并，但默认不跨 strong structure。

**Protected structure group**：同一代码块、表格或公式在超过保护尺寸后产生的连续片段集合；片段共享 `protectedGroup`，并通过 part 序号和 canonical locator 重组整体原文。

**Canonical metadata**：所有 retrieval fragment 都共享的定位、结构、上下文、尺寸和派生身份信息集合；格式差异只体现在结构字段的值，不改变元数据契约。

**Structure path**：描述片段所属页、标题、section、parser block 或结构续段的有序上下文路径；它是可序列化的语义定位，不等同于原文 offset。

**Provider tokenizer**：由具体 embedding provider 明确提供的真实 token 计数能力；没有它时，系统只能使用启发式 token 估算，不能声明严格 token 目标。

**Derived data retention**：对 chunks、FTS、embedding、retrieval trace 等可重建结果的保留周期；清理不触及原始资源、版本材料或审计记录。

**Chunk generation**：同一资料版本的一组分块派生结果及其 embedding/FTS 身份；重新分块产生新 generation，旧派生结果可以延迟清理，但不参与 active 检索。
