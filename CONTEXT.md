# MyKnow 检索上下文

MyKnow 的检索上下文围绕版本化 Wiki、可追溯的原始资料和一次检索产生的证据快照组织。检索负责召回和解释证据，不负责生成答案或直接修改 Wiki。

## Language

**Retrieval run**：一次针对知识库的检索执行，包含查询范围、候选结果、图扩展、来源追踪和上下文快照。

**Wiki seed**：直接命中的 Wiki 页面结果；只有通过置信度门槛的 seed 才能启动 Wiki graph expansion。

**Raw child chunk**：来自当前成功资料版本的可检索原始文本片段，保留父级上下文和 locator；它不是 Wiki graph 节点。

**Provenance lookup**：把 Wiki 页面或引用追溯到原始资料版本和 locator 的来源查询；它不是 Wiki graph edge。

**Context snapshot**：一次检索按独立 Wiki/raw 预算组装出的证据文本和定位元数据，用于展示和 trace replay。
