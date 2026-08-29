"use client";

import { useEffect, useMemo, useState } from "react";

const api = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const request = async (path, options = {}) => {
  const headers = options.body instanceof FormData ? {} : { "content-type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${api}${path}`, { ...options, headers });
  const body = response.status === 204 ? { data: null, error: null } : await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error?.message || "请求失败"), { code: body.error?.code || "HTTP_ERROR" });
  return body;
};

const json = (value) => JSON.stringify(value);
const retrievalLocatorPath = (item) => {
  const locator = item.locator || {};
  const params = new URLSearchParams();
  if (Number.isInteger(locator.startOffset) && Number.isInteger(locator.endOffset) && locator.startOffset >= 0 && locator.endOffset > locator.startOffset) {
    params.set("startOffset", String(locator.startOffset));
    params.set("endOffset", String(locator.endOffset));
  }
  const query = params.toString();
  return `${api}/api/resources/${encodeURIComponent(item.resourceId)}/versions/${encodeURIComponent(item.resourceVersionId)}/preview${query ? `?${query}` : ""}`;
};
const pageTypes = ["concept", "entity", "source-summary", "synthesis"];
const statusText = { active: "正常", needs_review: "待复核", broken: "失效", indexed: "已索引", pending: "等待处理", queued: "排队中", running: "执行中", retrying: "重试中", processing: "处理中", failed: "失败", degraded: "部分可用", archived: "已归档" };

const flattenPages = (nodes, result = []) => {
  for (const node of nodes || []) {
    result.push(node);
    flattenPages(node.children, result);
  }
  return result;
};

const planDepth = (item, items) => {
  const byNodeId = new Map(items.filter((candidate) => candidate.nodeId).map((candidate) => [candidate.nodeId, candidate]));
  let depth = 0;
  let current = item;
  const seen = new Set();
  while (current?.parentNodeId && !seen.has(current.parentNodeId)) {
    seen.add(current.parentNodeId);
    current = byNodeId.get(current.parentNodeId);
    if (!current) break;
    depth += 1;
  }
  return Math.min(depth, 4);
};

const markdownPreview = (markdown) => String(markdown || "").split("\n").map((line, index) => {
  if (/^###\s+/.test(line)) return <h4 key={index}>{line.replace(/^###\s+/, "")}</h4>;
  if (/^##\s+/.test(line)) return <h3 key={index}>{line.replace(/^##\s+/, "")}</h3>;
  if (/^#\s+/.test(line)) return <h2 key={index}>{line.replace(/^#\s+/, "")}</h2>;
  if (/^[-*]\s+/.test(line)) return <li key={index}>{line.replace(/^[-*]\s+/, "")}</li>;
  if (!line.trim()) return <div className="markdown-gap" key={index} />;
  return <p key={index}>{line}</p>;
});

function Notice({ error, message }) {
  if (!error && !message) return null;
  return <div className={error ? "notice error" : "notice"}>{error || message}</div>;
}

export default function Page() {
  const [bases, setBases] = useState([]);
  const [selected, setSelected] = useState(null);
  const [wiki, setWiki] = useState(null);
  const [page, setPage] = useState(null);
  const [versions, setVersions] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [resources, setResources] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [impacts, setImpacts] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [retrieval, setRetrieval] = useState(null);
  const [retrievalBusy, setRetrievalBusy] = useState(false);
  const [view, setView] = useState("overview");
  const [contentDraft, setContentDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [slugDraft, setSlugDraft] = useState("");
  const [spaceDraft, setSpaceDraft] = useState("");
  const [parentDraft, setParentDraft] = useState("");
  const [compareVersionId, setCompareVersionId] = useState("");
  const [diff, setDiff] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [chatSession, setChatSession] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [agentRun, setAgentRun] = useState(null);
  const [agentPlan, setAgentPlan] = useState([]);
  const [agentPlanStatus, setAgentPlanStatus] = useState("draft");
  const [agentEvents, setAgentEvents] = useState([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [selectedResourceVersionIds, setSelectedResourceVersionIds] = useState([]);
  const [selectedWikiPageIds, setSelectedWikiPageIds] = useState([]);
  const [mountPageId, setMountPageId] = useState("");
  const [editingPlanItemId, setEditingPlanItemId] = useState(null);
  const [planEditDraft, setPlanEditDraft] = useState(null);

  const allPages = useMemo(() => flattenPages(wiki?.pages), [wiki]);
  const resourceVersionIds = useMemo(() => new Set(resources.flatMap((resource) => (resource.versions || []).map((version) => version.id))), [resources]);
  const treeSourceCount = selectedResourceVersionIds.length + selectedWikiPageIds.length;
  const visibleTasks = useMemo(() => tasks.filter((task) => resourceVersionIds.has(task.resourceVersionId || task.resource_version_id)).slice(0, 8), [resourceVersionIds, tasks]);

  useEffect(() => {
    const available = new Set(resources.map((resource) => resource.currentVersion?.id).filter(Boolean));
    setSelectedResourceVersionIds((current) => current.filter((id) => available.has(id)));
  }, [resources]);

  useEffect(() => {
    const available = new Set(allPages.filter((item) => !item.system).map((item) => item.id));
    setSelectedWikiPageIds((current) => current.filter((id) => available.has(id)));
    if (mountPageId && !available.has(mountPageId)) setMountPageId("");
  }, [allPages, mountPageId]);

  const loadBases = async () => {
    try {
      const body = await request("/api/knowledge-bases");
      setBases(body.data || []);
      setSelected((current) => current && body.data.some((item) => item.id === current.id) ? body.data.find((item) => item.id === current.id) : body.data[0] || null);
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const loadWorkspace = async (knowledgeBaseId = selected?.id) => {
    if (!knowledgeBaseId) { setWiki(null); setSpaces([]); setResources([]); setTasks([]); setImpacts([]); setLoading(false); return; }
    try {
      const [wikiBody, spaceBody, resourceBody, taskBody, impactBody] = await Promise.all([
        request(`/api/knowledge-bases/${knowledgeBaseId}/wiki`),
        request(`/api/knowledge-bases/${knowledgeBaseId}/spaces`),
        request(`/api/resources?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`),
        request("/api/tasks"),
        request(`/api/knowledge-bases/${knowledgeBaseId}/wiki/impacts`)
      ]);
      setWiki(wikiBody.data);
      setSpaces(spaceBody.data || []);
      setResources(resourceBody.data || []);
      setTasks(taskBody.data || []);
      setImpacts(impactBody.data?.items || []);
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setLoading(false); }
  };

  const loadPage = async (pageId) => {
    try {
      const [pageBody, versionsBody] = await Promise.all([
        request(`/api/wiki/pages/${pageId}`),
        request(`/api/wiki/pages/${pageId}/versions`)
      ]);
      setPage(pageBody.data);
      setVersions(versionsBody.data || []);
      setContentDraft(pageBody.data.currentVersion?.contentMarkdown || "");
      setTitleDraft(pageBody.data.title || "");
      setSlugDraft(pageBody.data.slug || "");
      setSpaceDraft(pageBody.data.spaceId || "");
      setParentDraft(pageBody.data.parentPageId || "");
      setCompareVersionId("");
      setDiff(null);
      setSourcePreview(null);
      setView("page");
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  useEffect(() => { loadBases(); }, []);
  useEffect(() => {
    loadWorkspace(selected?.id);
    // ponytail: five-second polling is the local MVP ceiling; upgrade to server-sent updates when multi-user task freshness matters.
    const timer = selected?.id ? setInterval(() => loadWorkspace(selected.id), 5000) : null;
    return () => { if (timer) clearInterval(timer); };
  }, [selected?.id]);

  useEffect(() => {
    if (view === "page" && page && !allPages.some((item) => item.id === page.id)) {
      setPage(null);
      setView("overview");
    }
  }, [allPages, page, view]);

  const selectBase = (base) => {
    setSelected(base);
    setPage(null);
    setView("overview");
    setSearchResults([]);
    setRetrieval(null);
    setChatSession(null);
    setChatMessages([]);
    setAgentRun(null);
    setAgentPlan([]);
    setAgentPlanStatus("draft");
    setAgentEvents([]);
    setSelectedResourceVersionIds([]);
    setSelectedWikiPageIds([]);
    setMountPageId("");
    setEditingPlanItemId(null);
    setPlanEditDraft(null);
  };

  const createBase = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    try {
      const body = await request("/api/knowledge-bases", { method: "POST", body: json({ name }) });
      form.reset();
      setMessage("知识库已创建");
      await loadBases();
      setSelected(body.data);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const createPage = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const body = await request(`/api/knowledge-bases/${selected.id}/wiki/pages`, { method: "POST", body: json({ title: form.get("title"), pageType: form.get("pageType"), slug: form.get("slug")?.trim() || undefined, spaceId: form.get("spaceId") || null, parentPageId: form.get("parentPageId") || null }) });
      formElement.reset();
      await loadWorkspace(selected.id);
      await loadPage(body.data.id);
      setMessage("Wiki 页面已创建");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const savePage = async () => {
    if (!page?.currentVersion) return;
    try {
      await request(`/api/wiki/pages/${page.id}/versions`, { method: "POST", body: json({ baseVersionId: page.currentVersionId, contentMarkdown: contentDraft, changeSummary: "编辑页面" }) });
      await loadPage(page.id);
      await loadWorkspace(selected.id);
      setMessage("已保存为新版本");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const saveMetadata = async () => {
    if (!page) return;
    const payload = {};
    if (titleDraft.trim() !== page.title) payload.title = titleDraft.trim();
    if (slugDraft.trim() !== page.slug) payload.slug = slugDraft.trim();
    if (spaceDraft !== (page.spaceId || "")) payload.spaceId = spaceDraft || null;
    if (parentDraft !== (page.parentPageId || "")) payload.parentPageId = parentDraft || null;
    if (!Object.keys(payload).length) return;
    try {
      await request(`/api/wiki/pages/${page.id}`, { method: "PATCH", body: json(payload) });
      await loadPage(page.id);
      await loadWorkspace(selected.id);
      setMessage("页面元数据已更新");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const openCitation = async (citation) => {
    if (!citation.source?.previewPath) return;
    try {
      const body = await request(citation.source.previewPath);
      setSourcePreview(body.data);
      setMessage("已定位到引用原文");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const showDiff = async (versionId) => {
    if (!page?.currentVersionId || !versionId) return;
    try {
      const body = await request(`/api/wiki/pages/${page.id}/diff?fromVersionId=${encodeURIComponent(versionId)}&toVersionId=${encodeURIComponent(page.currentVersionId)}`);
      setCompareVersionId(versionId);
      setDiff(body.data.diff);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const restore = async (versionId) => {
    if (!page) return;
    try {
      await request(`/api/wiki/pages/${page.id}/restore`, { method: "POST", body: json({ versionId, baseVersionId: page.currentVersionId }) });
      await loadPage(page.id);
      await loadWorkspace(selected.id);
      setMessage("已恢复为新版本，历史版本仍保留");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const importResource = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const file = form.file.files[0];
    if (!file) return;
    const payload = new FormData();
    payload.set("name", file.name);
    payload.set("knowledgeBaseId", selected.id);
    payload.set("file", file);
    try {
      await request("/api/resources", { method: "POST", body: payload });
      form.reset();
      await loadWorkspace(selected.id);
      setMessage("原始资料已加入索引队列；原文保持只读");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const setResourceMode = async (resource, mode) => {
    try {
      await request(`/api/resources/${resource.id}`, { method: "PATCH", body: json({ wikiMode: mode === "inherit" ? null : mode }) });
      await loadWorkspace(selected.id);
      setMessage("资料 Wiki 策略已更新");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const addCitation = async (event) => {
    event.preventDefault();
    if (!page) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await request(`/api/wiki/pages/${page.id}/citations`, { method: "POST", body: json({ resourceVersionId: values.get("resourceVersionId"), locator: { startOffset: Number(values.get("startOffset")), endOffset: Number(values.get("endOffset")) } }) });
      form.reset();
      await loadPage(page.id);
      await loadWorkspace(selected.id);
      setMessage("引用已绑定到资料版本");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const query = new FormData(event.currentTarget).get("q");
    try {
      const body = await request(`/api/search?q=${encodeURIComponent(query)}&knowledgeBaseId=${encodeURIComponent(selected.id)}`);
      setSearchResults(body.data || []);
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const runRetrieval = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const values = new FormData(event.currentTarget);
    setRetrievalBusy(true);
    try {
      const body = await request("/api/retrieval/query", { method: "POST", body: json({ knowledgeBaseId: selected.id, spaceId: values.get("spaceId") || undefined, query: values.get("query"), wikiTopK: Number(values.get("wikiTopK")), rawTopK: Number(values.get("rawTopK")), contextBudgetTokens: Number(values.get("contextBudgetTokens")) }) });
      setRetrieval(body.data);
      setError("");
      setMessage(`检索完成 · trace ${body.data.traceId.slice(0, 8)}`);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setRetrievalBusy(false); }
  };

  const agentScope = () => {
    if (!selected) return {};
    if (page?.id) {
      const resourceVersionIds = (page.currentVersion?.citations || []).map((citation) => citation.resourceVersionId).filter(Boolean);
      return { knowledgeBaseId: selected.id, wikiPageIds: [page.id], ...(resourceVersionIds.length ? { resourceVersionIds } : {}) };
    }
    const resourceVersionIds = resources.map((resource) => resource.currentVersion?.id).filter(Boolean).slice(0, 20);
    return resourceVersionIds.length ? { knowledgeBaseId: selected.id, resourceVersionIds } : {};
  };

  const treeAgentScope = () => ({
    knowledgeBaseId: selected?.id,
    organizationMode: "tree",
    resourceVersionIds: selectedResourceVersionIds,
    wikiPageIds: selectedWikiPageIds,
    ...(mountPageId ? { mountPageId } : {})
  });

  const toggleResourceVersion = (versionId) => {
    setSelectedResourceVersionIds((current) => current.includes(versionId) ? current.filter((id) => id !== versionId) : [...current, versionId]);
  };

  const toggleWikiPage = (pageId) => {
    setSelectedWikiPageIds((current) => current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  };

  const selectAllCurrentResources = () => {
    setSelectedResourceVersionIds(resources.map((resource) => resource.currentVersion?.id).filter(Boolean));
  };

  const createChatSession = async () => {
    const body = await request("/api/chat/sessions", { method: "POST", body: json(agentScope()) });
    setChatSession(body.data);
    setChatMessages(body.data?.messages || []);
    return body.data;
  };

  const refreshChatSession = async (sessionId = chatSession?.id) => {
    if (!sessionId) return;
    const body = await request(`/api/chat/sessions/${sessionId}`);
    setChatSession(body.data);
    setChatMessages(body.data?.messages || []);
  };

  const sendChat = async (event) => {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content || chatBusy) return;
    setChatBusy(true);
    try {
      const session = chatSession || await createChatSession();
      const body = await request(`/api/chat/sessions/${session.id}/messages`, { method: "POST", body: json({ content }) });
      setChatInput("");
      setChatMessages((current) => [...current, body.data.userMessage, body.data.assistantMessage].filter(Boolean));
      if (body.data.agentRun) {
        setAgentRun(body.data.agentRun);
        setAgentPlan([]);
        setAgentEvents([]);
      }
      setMessage("Agent 已接收问题；回答会在任务完成后出现");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setChatBusy(false); }
  };

  const refreshAgent = async (runId = agentRun?.id) => {
    if (!runId) return;
    const [runBody, eventBody] = await Promise.all([
      request(`/api/agent/runs/${runId}`),
      request(`/api/agent/runs/${runId}/events`)
    ]);
    setAgentRun(runBody.data);
    setAgentEvents(eventBody.data?.items || []);
    if (["succeeded", "failed", "cancelled"].includes(runBody.data?.status)) {
      const planBody = await request(`/api/agent/runs/${runId}/plan`);
      setAgentPlan(planBody.data?.items || []);
      setAgentPlanStatus(planBody.data?.planStatus || "draft");
    }
  };

  const startOrganizePlan = async () => {
    if (!selected || !treeSourceCount || agentBusy) return;
    setAgentBusy(true);
    try {
      const body = await request("/api/agent/runs", { method: "POST", body: json({ kind: "organize", ...treeAgentScope(), prompt: "Organize the selected sources and Wiki pages into one evidence-backed hierarchical Wiki tree." }) });
      setAgentRun(body.data.agentRun);
      setAgentPlan([]);
      setAgentPlanStatus("draft");
      setAgentEvents([]);
      setMessage("Wiki 整理计划已排队；写入前仍需逐项审阅");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setAgentBusy(false); }
  };

  const decidePlanItem = async (item, decision) => {
    try {
      const body = await request(`/api/agent/plan-items/${item.id}/decision`, { method: "POST", body: json({ decision }) });
      setAgentPlan((current) => current.map((candidate) => candidate.id === item.id ? body.data : candidate));
      await loadWorkspace(selected?.id);
      if (page?.id) await loadPage(page.id);
      setMessage(decision === "approve" ? "计划项已审阅并应用" : "计划项已拒绝；原始资料和历史版本保留");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const decidePlanBranch = async (item, decision) => {
    try {
      const body = await request(`/api/agent/plan-items/${item.id}/branch-decision`, { method: "POST", body: json({ decision }) });
      setAgentPlan(body.data?.items || []);
      setAgentPlanStatus(body.data?.planStatus || "draft");
      await loadWorkspace(selected?.id);
      if (page?.id) await loadPage(page.id);
      setMessage(decision === "approve" ? "整棵分支已在一个事务中应用" : "整棵分支已拒绝，原始资料和历史版本保留");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const beginPlanEdit = (item) => {
    setEditingPlanItemId(item.id);
    setPlanEditDraft({
      title: item.proposed?.title || "",
      pageType: item.proposed?.pageType || "concept",
      contentMarkdown: item.proposed?.contentMarkdown || ""
    });
  };

  const savePlanEdit = async (item) => {
    if (!planEditDraft) return;
    try {
      const body = await request(`/api/agent/plan-items/${item.id}`, { method: "PATCH", body: json({ proposed: planEditDraft }) });
      setAgentPlan((current) => current.map((candidate) => candidate.id === item.id ? body.data : candidate));
      setEditingPlanItemId(null);
      setPlanEditDraft(null);
      setMessage("计划项已编辑并重新校验证据与层级");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const rollbackPlanItem = async (item) => {
    try {
      const body = await request(`/api/agent/plan-items/${item.id}/rollback`, { method: "POST", body: json({}) });
      setAgentPlan((current) => current.map((candidate) => candidate.id === item.id ? body.data : candidate));
      await loadWorkspace(selected?.id);
      if (page?.id) await loadPage(page.id);
      setMessage("计划项已回滚为新的不可变版本");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  useEffect(() => {
    if (!chatSession?.id) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const body = await request(`/api/chat/sessions/${chatSession.id}`);
        if (!cancelled) {
          setChatSession(body.data);
          setChatMessages(body.data?.messages || []);
        }
      } catch (caught) { if (!cancelled) setError(`${caught.code}: ${caught.message}`); }
    };
    refresh();
    // ponytail: one-second polling is the local MVP ceiling; upgrade to SSE when live multi-user freshness matters.
    const timer = setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [chatSession?.id]);

  useEffect(() => {
    if (!agentRun?.id) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [runBody, eventBody] = await Promise.all([
          request(`/api/agent/runs/${agentRun.id}`),
          request(`/api/agent/runs/${agentRun.id}/events`)
        ]);
        if (cancelled) return;
        setAgentRun(runBody.data);
        setAgentEvents(eventBody.data?.items || []);
        if (["succeeded", "failed", "cancelled"].includes(runBody.data?.status)) {
          const planBody = await request(`/api/agent/runs/${agentRun.id}/plan`);
          if (!cancelled) {
            setAgentPlan(planBody.data?.items || []);
            setAgentPlanStatus(planBody.data?.planStatus || "draft");
          }
        }
      } catch (caught) { if (!cancelled) setError(`${caught.code}: ${caught.message}`); }
    };
    refresh();
    // ponytail: one-second polling is the local MVP ceiling; upgrade to SSE when live agent traces matter.
    const timer = setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [agentRun?.id]);

  const renderWikiTree = (nodes, depth = 0) => (nodes || []).filter((item) => !item.system).map((item) => <div className="wiki-tree-node" key={item.id}>
    <div className="wiki-tree-row">
      <input type="checkbox" checked={selectedWikiPageIds.includes(item.id)} onChange={() => toggleWikiPage(item.id)} aria-label={`Use ${item.title} as Agent source`} />
      <button className={`tree-item ${page?.id === item.id ? "selected" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => loadPage(item.id)}><span className="page-type">{item.pageType.slice(0, 1).toUpperCase()}</span><span>{item.title}</span>{item.pendingCitationCount > 0 && <b className="warning-count">{item.pendingCitationCount}</b>}</button>
    </div>
    {renderWikiTree(item.children, depth + 1)}
  </div>);

  const currentCitationCount = page?.currentVersion?.citations?.length || 0;

  return <div className="app-shell">
    <header className="topbar">
      <div><span className="eyebrow">MYKNOW / SPRINT 5</span><h1>知识工作台</h1></div>
      <div className="topbar-state">{selected ? `当前知识库：${selected.name}` : "从知识库开始"}</div>
      <button className="ghost-button" onClick={() => loadWorkspace(selected?.id)}>刷新</button>
    </header>
    <Notice error={error} message={message} />
    <main className="workspace">
      <aside className="rail left-rail">
        <section className="rail-section">
          <div className="section-heading"><h2>知识库</h2><span>{bases.length}</span></div>
          <form className="inline-form" onSubmit={createBase}><input name="name" placeholder="新知识库名称" required /><button>创建</button></form>
          <div className="base-list">{bases.map((base) => <button className={`base-item ${selected?.id === base.id ? "selected" : ""}`} key={base.id} onClick={() => selectBase(base)}><span className="base-dot" />{base.name}<small>{base.wikiDefaultMode === "retrieval-only" ? "只读检索" : "Wiki"}</small></button>)}</div>
          {!bases.length && !loading && <p className="muted">还没有知识库。</p>}
        </section>
        {selected && <section className="rail-section tree-section">
          <div className="section-heading"><h2>Wiki 页面</h2><span>{wiki?.pageCount || 0}</span></div>
          <button className={`tree-item system ${view === "overview" ? "selected" : ""}`} onClick={() => { setView("overview"); setPage(null); }}><span>⌂</span>index / overview</button>
          <button className={`tree-item system ${view === "log" ? "selected" : ""}`} onClick={() => { setView("log"); setPage(null); }}><span>≡</span>log / events</button>
          {renderWikiTree(wiki?.pages)}
          {!allPages.some((item) => !item.system) && <p className="muted tree-empty">Wiki 还是空的，先创建一个页面。</p>}
          <form className="create-page" onSubmit={createPage}><input name="title" placeholder="新页面标题" required /><input name="slug" placeholder="slug（可选）" pattern="[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?" /><select name="pageType" defaultValue="concept">{pageTypes.map((type) => <option key={type}>{type}</option>)}</select><select name="spaceId" defaultValue=""><option value="">不指定空间</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select><select name="parentPageId" defaultValue=""><option value="">顶层页面</option>{allPages.filter((item) => !item.system).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button>新建 Wiki 页面</button></form>
        </section>}
        {selected && <section className="rail-section agent-launcher">
          <div className="section-heading"><h2>Agent 工作台</h2><span>{agentRun?.status || "idle"}</span></div>
          <p className="muted">聊天只读；Wiki 整理先生成计划，审阅后才会写入。</p>
          <div className="agent-scope-summary">
            <div><b>Tree scope</b><span>{treeSourceCount} selected source(s)</span></div>
            <button type="button" onClick={selectAllCurrentResources} disabled={!resources.some((resource) => resource.currentVersion?.id)}>Select all current resources</button>
            <label>Mount under
              <select value={mountPageId} onChange={(event) => setMountPageId(event.target.value)}>
                <option value="">Top-level root</option>
                {allPages.filter((item) => !item.system).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <small>Tick resource cards or Wiki pages in the left tree. The generated root is new and is never index/log.</small>
          </div>
          <div className="agent-launch-actions">
            <button className="primary-button" onClick={createChatSession}>打开聊天</button>
            <button disabled={!treeSourceCount || agentBusy} onClick={startOrganizePlan}>{agentBusy ? "排队中…" : "生成整理计划"}</button>
          </div>
          {!treeSourceCount && <small className="agent-hint">至少勾选一个已索引资料版本或 Wiki 页面后再生成树形计划。</small>}
        </section>}
      </aside>

      <section className="main-panel">
        {!selected && <div className="empty-state large"><span className="icon">◎</span><h2>选择或创建一个知识库</h2><p>Wiki 会成为默认入口，原始资料仍作为可追溯的检索底座。</p></div>}
        {selected && view === "overview" && <>
          <div className="panel-header"><div><span className="eyebrow">WIKI / INDEX</span><h2>Wiki overview</h2><p>从稳定页面、来源引用和待复核影响项开始工作。</p></div><span className="mode-pill">{selected.wikiDefaultMode === "retrieval-only" ? "知识库：retrieval-only" : "知识库：wiki-enabled"}</span></div>
          <div className="overview-grid">
            <article className="overview-card hero-card"><span className="card-label">默认入口</span><strong>index / overview</strong><p>刷新后仍从 Wiki 进入。页面内容以 Markdown 版本保存，原始资料不会被覆盖。</p><div className="stat-row"><span><b>{wiki?.pageCount || 0}</b> 个页面</span><span><b>{wiki?.pendingCitationCount || 0}</b> 个待处理引用</span></div></article>
            <article className="overview-card"><span className="card-label">Wiki 整理候选</span>{wiki?.candidates?.length ? wiki.candidates.slice(0, 5).map((item) => <div className="candidate" key={item.id}><span>{item.name}</span><small>{statusText[item.status] || item.status}</small></div>) : <div className="empty-card"><b>暂无候选资料</b><span>导入资料后会出现在这里。</span></div>}</article>
            <article className="overview-card"><span className="card-label">系统日志</span><div className="log-preview">{(wiki?.log?.events || []).slice(0, 5).map((event) => <div key={event.id}><b>{event.event_type}</b><span>{event.entity_type}</span><time>{new Date(event.created_at).toLocaleTimeString()}</time></div>)}</div></article>
          </div>
          <section className="retrieval-panel">
            <div className="card-title-row"><div><h3>Retrieval checker</h3><span className="retrieval-subtitle">Page-centric RAG · no answer generation</span></div><span>{retrieval ? `trace ${retrieval.traceId.slice(0, 8)}` : "not run"}</span></div>
            <form className="retrieval-form" onSubmit={runRetrieval}>
              <input name="query" required maxLength="200" placeholder="Ask the knowledge base to retrieve evidence" />
              <select name="spaceId" defaultValue=""><option value="">All Wiki spaces</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select>
              <input name="wikiTopK" type="number" min="1" max="20" defaultValue="5" aria-label="Wiki Top K" />
              <input name="rawTopK" type="number" min="1" max="20" defaultValue="10" aria-label="Raw Top K" />
              <input name="contextBudgetTokens" type="number" min="1" max="50000" defaultValue="8000" aria-label="Context budget" />
              <button className="primary-button" disabled={retrievalBusy}>{retrievalBusy ? "Retrieving…" : "Retrieve"}</button>
            </form>
            <p className="scope-note">Wiki scope: {selected.name}{spaces.length ? " · optional space filter" : ""} · Raw scope: entire knowledge base · Wiki/raw Top-K are independent.</p>
            {retrieval && <div className="retrieval-grid">
              <article className="retrieval-card"><div className="retrieval-heading"><b>Wiki seeds</b><span>{retrieval.wiki.seeds.length}</span></div>{retrieval.wiki.seeds.length ? retrieval.wiki.seeds.map((item) => <a className="retrieval-result" key={item.pageId} href={`${api}/api/wiki/pages/${encodeURIComponent(item.pageId)}/versions/${encodeURIComponent(item.pageVersionId)}`} target="_blank" rel="noreferrer"><span><b>{item.rank}. {item.title}</b><small>{item.page?.pageType} · score {item.normalizedScore.toFixed(2)} · {item.seedGate?.passed ? "seed passed" : `no graph: ${item.seedGate?.reason}`}</small></span><code>{item.pageVersionId.slice(0, 8)}</code></a>) : <p className="muted">No Wiki page match.</p>}</article>
              <article className="retrieval-card"><div className="retrieval-heading"><b>Raw child chunks</b><span>{retrieval.raw.results.length}</span></div>{retrieval.raw.results.length ? retrieval.raw.results.map((item) => <a className="retrieval-result" key={item.chunkId} href={retrievalLocatorPath(item)} target="_blank" rel="noreferrer"><span><b>{item.rank}. {item.resource?.name}</b><small>{item.content.slice(0, 180)}{item.content.length > 180 ? "…" : ""}</small></span><code>{item.locator?.startOffset ?? "-"}:{item.locator?.endOffset ?? "-"}</code></a>) : <p className="muted">No raw child chunk match.</p>}</article>
              <article className="retrieval-card"><div className="retrieval-heading"><b>Graph expansion</b><span>{retrieval.wiki.graphExpanded.length}</span></div>{retrieval.wiki.graphExpanded.length ? retrieval.wiki.graphExpanded.map((item) => <a className="retrieval-result" key={`${item.pageId}-${item.rank}`} href={`${api}/api/wiki/pages/${encodeURIComponent(item.pageId)}/versions/${encodeURIComponent(item.pageVersionId)}`} target="_blank" rel="noreferrer"><span><b>{item.hop}-hop · {item.title}</b><small>{item.path?.map((edge) => `${edge.direction} ${edge.linkText}`).join(" → ")} · decay {item.decay}</small></span><code>{item.pageId.slice(0, 8)}</code></a>) : <p className="muted">Only high-confidence Wiki seeds expand the graph.</p>}<div className="context-summary"><b>Context</b><span>{retrieval.context.estimatedTokens}/{retrieval.limits.contextBudgetTokens} tokens · {retrieval.context.truncated ? "truncated" : "within budget"}</span><small>Wiki {retrieval.context.wikiEstimatedTokens}/{retrieval.context.wikiBudgetTokens} · Raw {retrieval.context.rawEstimatedTokens}/{retrieval.context.rawBudgetTokens}</small></div></article>
            </div>}
          </section>
          {wiki?.empty && <div className="callout"><div><b>Wiki 还是空的</b><p>可以先创建一页沉淀知识，也可以只查看右侧原始资料；不会被静默跳转到资料列表。</p></div><button onClick={() => document.querySelector(".create-page input")?.focus()}>创建第一篇</button></div>}
          <div className="lower-grid"><article className="content-card"><div className="card-title-row"><h3>主题树</h3><span>稳定页面 ID</span></div>{allPages.filter((item) => !item.system).length ? <div className="topic-list">{allPages.filter((item) => !item.system).map((item) => <button key={item.id} onClick={() => loadPage(item.id)}><span className="page-type large-type">{item.pageType.slice(0, 1).toUpperCase()}</span><span><b>{item.title}</b><small>{item.slug} · {item.citationCount} 个引用</small></span><span>→</span></button>)}</div> : <p className="muted">页面创建后会在这里形成主题树。</p>}</article><article className="content-card"><div className="card-title-row"><h3>最近影响项</h3><span>{impacts.length}</span></div>{impacts.length ? impacts.slice(0, 5).map((impact) => <div className="impact-row" key={impact.citationId}><span className={`status-dot ${impact.status}`} /><div><b>{impact.page.title}</b><small>{impact.resource.name} · {statusText[impact.status]}</small></div></div>) : <p className="muted">资料更新后，旧版本引用会在这里标记。</p>}</article></div>
        </>}
        {selected && <section className="agent-panel" data-testid="agent-chat">
          <div className="agent-panel-header">
            <div><span className="eyebrow">PI AGENT / READ ONLY</span><h2>Agent chat</h2><p>当前范围：{page?.title ? `Wiki 页面「${page.title}」` : "开放对话（未附带知识库证据）"}</p></div>
            <div className="agent-header-actions"><span className={`mode-pill ${agentRun?.status || ""}`}>{agentRun ? `run ${agentRun.status}` : "no active run"}</span><button onClick={chatSession ? () => refreshChatSession() : createChatSession}>{chatSession ? "刷新聊天" : "开始聊天"}</button></div>
          </div>
          <div className="chat-window" aria-live="polite">
            {chatMessages.length ? chatMessages.map((item) => <article className={`chat-message ${item.role} ${item.status}`} key={item.id}>
              <div className="chat-message-meta"><b>{item.role === "user" ? "你" : "Pi Agent"}</b><span>{item.status}</span></div>
              <p>{item.content || (item.status === "pending" || item.status === "running" || item.status === "retrying" ? "正在读取范围并整理回答…" : "暂无回答")}</p>
              {item.answer && <div className="answer-meta"><span>evidence: {item.answer.evidenceStatus || "none"}</span><span>{item.answer.evidence?.length || 0} citation(s)</span></div>}
              {item.error && <div className="trace-warning">{item.error.code}: {item.error.message}</div>}
            </article>) : <div className="empty-card"><b>还没有消息</b><span>可以先问一个开放问题，也可以打开 Wiki 页面后询问当前范围。</span></div>}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} maxLength={4000} rows={2} placeholder="向 Agent 提问；回答会区分 MyKnow 证据和模型补充…" aria-label="Chat message" />
            <button className="primary-button" disabled={chatBusy || !chatInput.trim()}>{chatBusy ? "发送中…" : "发送"}</button>
          </form>
        </section>}
        {selected && <section className="agent-panel agent-plan" data-testid="agent-plan">
          <div className="agent-panel-header">
            <div><span className="eyebrow">REVIEW GATE / TRANSACTIONAL WRITE</span><h2>Wiki 整理计划</h2><p>每一项都保留基线版本、引用、风险和应用状态。</p></div>
            <button className="primary-button" disabled={!treeSourceCount || agentBusy} onClick={startOrganizePlan}>{agentBusy ? "生成中…" : "重新生成计划"}</button>
          </div>
          {!agentRun && <div className="empty-card"><b>尚未生成计划</b><span>先勾选明确的资料版本或 Wiki 页面，Agent 只能通过审阅计划申请写入。</span></div>}
          {agentRun && !agentPlan.length && <div className="empty-card"><b>计划正在生成</b><span>run {agentRun.id.slice(0, 8)} · {agentRun.status}</span></div>}
          {agentPlan.length > 0 && <div className="plan-summary"><b>Plan status: {agentPlanStatus}</b><span>{agentPlan.filter((item) => item.applicationStatus === "applied").length}/{agentPlan.length} applied · branches are transactional</span></div>}
          {agentPlan.map((item) => {
            const isTreeNode = Boolean(item.nodeId);
            const isRoot = isTreeNode && !item.parentNodeId;
            const isEditing = editingPlanItemId === item.id;
            return <article className="plan-item" style={{ marginLeft: `${planDepth(item, agentPlan) * 18}px` }} key={item.id}>
              <div className="plan-item-header"><div><b>{item.nodeRole || item.itemType}</b><small>{isTreeNode ? `node ${item.nodeId} · parent ${item.parentNodeId || "top-level"}` : `target ${item.targetPageId?.slice(0, 8) || "new page"}`} · risk {item.risk}</small></div><span className={`plan-status ${item.applicationStatus}`}>{item.applicationStatus}</span></div>
              {isEditing ? <div className="plan-edit-form"><input value={planEditDraft?.title || ""} onChange={(event) => setPlanEditDraft((current) => ({ ...current, title: event.target.value }))} maxLength={200} /><select value={planEditDraft?.pageType || "concept"} onChange={(event) => setPlanEditDraft((current) => ({ ...current, pageType: event.target.value }))}>{pageTypes.map((type) => <option key={type}>{type}</option>)}</select><textarea value={planEditDraft?.contentMarkdown || ""} onChange={(event) => setPlanEditDraft((current) => ({ ...current, contentMarkdown: event.target.value }))} maxLength={120000} rows={6} /><div className="plan-actions"><button className="primary-button" onClick={() => savePlanEdit(item)}>保存编辑</button><button onClick={() => { setEditingPlanItemId(null); setPlanEditDraft(null); }}>取消</button></div></div> : <><h3>{item.proposed?.title || "Untitled proposal"}</h3>{item.proposed?.contentMarkdown && <pre className="plan-content">{item.proposed.contentMarkdown.slice(0, 1600)}</pre>}</>}
              {item.diff?.lines?.length > 0 && <pre className="plan-diff">{item.diff.lines.slice(0, 80).map((line) => `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "} ${line.value}`).join("\n")}</pre>}
              <div className="plan-evidence"><span>{item.evidenceStatus}</span><span>{item.citations?.length || 0} citation(s)</span><span>{item.reviewStatus}</span></div>
              {item.error && <div className="trace-warning">{item.error.code}: {item.error.message}</div>}
              <div className="plan-actions">
                {item.reviewStatus === "proposed" && item.applicationStatus === "pending" && <>{item.evidenceStatus === "needs_evidence" ? <span className="plan-blocked">需要补充证据后才能应用</span> : isTreeNode && isRoot ? <button className="primary-button" onClick={() => decidePlanBranch(item, "approve")}>审阅并应用整棵分支</button> : <button className="primary-button" onClick={() => decidePlanItem(item, "approve")}>审阅并应用</button>}<button onClick={() => decidePlanBranch(item, "reject")}>拒绝{isTreeNode ? "分支" : ""}</button>{!isEditing && <button onClick={() => beginPlanEdit(item)}>编辑</button>}</>}
                {item.applicationStatus === "applied" && <button onClick={() => rollbackPlanItem(item)}>回滚</button>}
              </div>
            </article>;
          })}
        </section>}
        {selected && view === "log" && <div className="log-page">
          <div className="panel-header"><div><span className="eyebrow">WIKI / LOG</span><h2>Audit log</h2><p>页面、版本、引用和影响扫描都保留可追溯记录。</p></div><span className="mode-pill">最近 100 条</span></div>
          <div className="log-table">{(wiki?.log?.events || []).map((event) => <div className="log-row" key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time><b>{event.event_type}</b><span>{event.entity_type} / {event.entity_id.slice(0, 8)}</span><small>{JSON.stringify(event.metadata || {})}</small></div>)}{!wiki?.log?.events?.length && <p className="muted">暂无审计事件。</p>}</div>
        </div>}
        {selected && view === "page" && page && <>
          <div className="panel-header page-header"><div className="page-heading"><span className="eyebrow">{page.pageType} / {page.slug}</span><input className="title-input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={saveMetadata} /><div className="metadata-grid"><label>slug<input value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} onBlur={saveMetadata} /></label><label>空间<select value={spaceDraft} onChange={(event) => setSpaceDraft(event.target.value)} onBlur={saveMetadata}><option value="">不指定空间</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label><label>父页面<select value={parentDraft} onChange={(event) => setParentDraft(event.target.value)} onBlur={saveMetadata}><option value="">顶层页面</option>{allPages.filter((item) => !item.system && item.id !== page.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div><p>页面 ID：{page.id}</p></div><div className="page-actions"><span className="mode-pill">v{versions.length}</span><button className="primary-button" onClick={savePage}>保存新版本</button></div></div>
          <div className="editor-tabs"><button className="active">编辑</button><button onClick={() => setContentDraft(page.currentVersion?.contentMarkdown || "")}>Markdown</button><label>模板版本 <code>{page.currentVersion?.templateVersionId?.slice(0, 8) || "—"}</code></label></div>
          <div className="editor-layout"><div className="editor-column"><textarea className="markdown-editor" value={contentDraft} onChange={(event) => setContentDraft(event.target.value)} spellCheck={false} /><div className="editor-foot"><span>每次保存都会生成不可变版本</span><span>{contentDraft.length.toLocaleString()} 字符</span></div></div><article className="preview-column"><div className="preview-label">预览</div><div className="markdown-preview">{markdownPreview(contentDraft)}</div></article></div>
          <section className="versions-section"><div className="card-title-row"><h3>版本与 diff</h3><span>旧版本不会被覆盖</span></div><div className="version-list">{versions.map((version, index) => <div className={`version-row ${version.id === page.currentVersionId ? "current" : ""}`} key={version.id}><div><b>{version.id === page.currentVersionId ? "当前版本" : `版本 ${versions.length - index}`}</b><small>{new Date(version.created_at || version.createdAt).toLocaleString()} · {version.change_summary || version.changeSummary || "无说明"}</small></div><div className="version-actions"><button onClick={() => showDiff(version.id)} disabled={version.id === page.currentVersionId}>查看 diff</button>{version.id !== page.currentVersionId && <button onClick={() => restore(version.id)}>恢复为新版本</button>}</div></div>)}</div>{diff && <div className="diff-box"><div className="diff-header"><b>diff：{compareVersionId.slice(0, 8)} → 当前</b><button onClick={() => setDiff(null)}>关闭</button></div><pre>{diff.lines.map((line, index) => <span className={line.type} key={index}>{line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}{line.value}{"\n"}</span>)}</pre></div>}</section>
        </>}
      </section>

      <aside className="rail right-rail">
        {selected && <>
          <section className="rail-section"><div className="section-heading"><h2>来源与引用</h2><span>{currentCitationCount}</span></div>{page?.currentVersion?.citations?.length ? page.currentVersion.citations.map((citation) => <div className="citation-card" key={citation.id}><div className="citation-status"><span className={`status-dot ${citation.status}`} />{statusText[citation.status] || citation.status}</div><b>{citation.source?.resourceName || "来源不可用"}</b><small>版本 {citation.resourceVersionId.slice(0, 8)}</small><small>locator：{JSON.stringify(citation.locator)}</small>{citation.source && <><button className="citation-link" onClick={() => openCitation(citation)}>查看原文定位</button>{sourcePreview?.citationId === citation.id && <pre className="source-preview">{sourcePreview.snippet || "该文件类型暂无文本预览，请打开只读原文。"}</pre>}<a href={`${api}${citation.source.downloadPath}`} target="_blank" rel="noreferrer">打开只读原文 ↗</a></>}</div>) : <p className="muted">打开页面后，这里会显示绑定到具体资料版本的引用。</p>}</section>
          <section className="rail-section"><div className="section-heading"><h2>处理任务</h2><span>{visibleTasks.length}</span></div>{visibleTasks.length ? visibleTasks.map((task) => <div className="task-row" key={task.id}><div><b>{task.type}</b><small>{statusText[task.status] || task.status} · {task.progress ?? 0}%</small>{task.errorSummary && <small>{task.errorSummary}</small>}</div><span className={`task-status ${task.status}`}>{statusText[task.status] || task.status}</span></div>) : <p className="muted">暂无资料处理任务。</p>}</section>
          {retrieval && <section className="rail-section retrieval-trace"><div className="section-heading"><h2>检索 trace</h2><span>{retrieval.vector.status}</span></div><div className="trace-line"><b>Scope</b><span>{retrieval.scope.knowledgeBaseId.slice(0, 8)} · raw = whole KB</span></div><div className="trace-line"><b>Vector</b><span>{retrieval.vector.provider} / {retrieval.vector.model} · {retrieval.vector.durationMs}ms</span></div>{retrieval.vector.error && <div className="trace-warning">关键词降级：{retrieval.vector.error.code}</div>}<div className="trace-line"><b>Provenance</b><span>{retrieval.provenance.length} lookup(s)</span></div><div className="trace-line"><b>Timing</b><span>{retrieval.metrics.durationMs}ms · trace {retrieval.traceId.slice(0, 8)}</span></div>{retrieval.context.truncated && <div className="trace-warning">Context budget truncated {retrieval.context.truncatedItems.length} item(s)</div>}</section>}
          {agentRun && <section className="rail-section agent-trace"><div className="section-heading"><h2>Agent trace</h2><span>{agentEvents.length} events</span></div><div className="trace-line"><b>Provider</b><span>{agentRun.provider} / {agentRun.model}</span></div><div className="trace-line"><b>Egress</b><span>{agentRun.egressMode}</span></div><div className="trace-line"><b>Status</b><span>{agentRun.status}</span></div><div className="trace-line"><b>Scope</b><span>{agentRun.scope?.knowledgeBaseId ? `${agentRun.scope.knowledgeBaseId.slice(0, 8)} · snapshot` : "open chat"}</span></div>{agentRun.error && <div className="trace-warning">{agentRun.error.code}: {agentRun.error.message}</div>}<div className="event-list">{agentEvents.slice(-6).map((event) => <div className="event-row" key={event.id}><b>{event.eventType}</b><span>{event.toolName || event.stage || "agent"}</span></div>)}</div></section>}
          {page && resources.some((resource) => resource.versions?.length) && <section className="rail-section"><div className="section-heading"><h2>绑定引用</h2><span>版本级</span></div><form className="citation-form" onSubmit={addCitation}><select name="resourceVersionId" required defaultValue=""><option value="" disabled>选择资料版本</option>{resources.flatMap((resource) => (resource.versions || []).map((version) => <option key={version.id} value={version.id}>{resource.name} · v{version.id.slice(0, 8)}</option>))}</select><div><input name="startOffset" type="number" min="0" placeholder="开始 offset" required /><input name="endOffset" type="number" min="1" placeholder="结束 offset" required /></div><button>绑定到当前版本</button></form></section>}
          <section className="rail-section"><div className="section-heading"><h2>待处理影响</h2><span className={impacts.length ? "count-warning" : ""}>{impacts.length}</span></div>{impacts.length ? impacts.slice(0, 6).map((impact) => <div className="impact-row" key={impact.citationId}><span className={`status-dot ${impact.status}`} /><div><b>{impact.page.title}</b><small>{impact.resource.name} · {statusText[impact.status]}</small></div></div>) : <p className="muted">没有待复核或失效引用。</p>}</section>
          <section className="rail-section"><div className="section-heading"><h2>原始资料</h2><span>{resources.length}</span></div><form className="search-form" onSubmit={search}><input name="q" placeholder="搜索 FTS 原文" required /><button>搜索</button></form><form className="upload-form" onSubmit={importResource}><input name="file" type="file" accept=".md,.txt,.pdf" required /><button>导入资料</button></form>{resources.length ? resources.map((resource) => <div className="resource-card" key={resource.id}><div><b>{resource.name}</b><small>{statusText[resource.status] || resource.status} · {resource.currentVersion?.id ? `v${resource.versions.length}` : "未索引"}</small></div><select value={resource.wikiMode || "inherit"} onChange={(event) => setResourceMode(resource, event.target.value)}><option value="inherit">继承 Wiki 策略</option><option value="enabled">参与 Wiki</option><option value="retrieval-only">仅检索</option></select>{resource.wikiMode === "retrieval-only" && <span className="readonly-label">retrieval-only：不参与 Wiki</span>}</div>) : <p className="muted">暂无原始资料。</p>}</section>
          {searchResults.length > 0 && <section className="rail-section search-results"><div className="section-heading"><h2>搜索结果</h2><span>{searchResults.length}</span></div>{searchResults.map((result) => <article key={result.id}><b>{result.resource_name}</b><p>{result.content}</p></article>)}</section>}
        </>}
        <section className="rail-section agent-sources">
          <div className="section-heading"><h2>Tree sources</h2><span>{treeSourceCount}</span></div>
          {resources.map((resource) => {
            const versionId = resource.currentVersion?.id;
            return <label className="source-check" key={resource.id}>
              <input type="checkbox" checked={Boolean(versionId && selectedResourceVersionIds.includes(versionId))} disabled={!versionId} onChange={() => versionId && toggleResourceVersion(versionId)} />
              <span><b>{resource.name}</b><small>{versionId ? `current v${resource.versions.length}` : "not indexed"}</small></span>
            </label>;
          })}
          {!resources.length && <p className="muted">Import and index a resource first.</p>}
        </section>
      </aside>
    </main>
    <style jsx>{`
      :global(*){box-sizing:border-box}:global(body){margin:0;background:#eef1f5;color:#1d2939;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}:global(button),:global(input),:global(select),:global(textarea){font:inherit}:global(button){cursor:pointer}.app-shell{min-height:100vh}.topbar{height:76px;display:flex;align-items:center;gap:24px;padding:14px 24px;background:#14202d;color:#fff}.topbar h1{margin:2px 0 0;font-size:19px;font-weight:650;letter-spacing:-.02em}.eyebrow{display:block;color:#8fa4b9;font-size:10px;font-weight:750;letter-spacing:.14em}.topbar-state{margin-left:auto;color:#b8c7d6;font-size:13px}.ghost-button,.primary-button,.inline-form button,.create-page button,.upload-form button,.search-form button{border:1px solid #91a5b8;background:transparent;color:inherit;border-radius:7px;padding:8px 12px}.primary-button{background:#2f6fed;border-color:#2f6fed;color:#fff;font-weight:650}.notice{position:fixed;z-index:5;right:18px;top:88px;max-width:420px;padding:12px 14px;background:#e9f7ef;border:1px solid #9bd3ad;color:#1e6a3a;border-radius:8px;box-shadow:0 8px 24px #17202a18;font-size:13px}.notice.error{background:#fff0f0;border-color:#e2a5a5;color:#9b2b2b}.workspace{display:grid;grid-template-columns:260px minmax(0,1fr) 340px;min-height:calc(100vh - 76px);max-width:1680px;margin:0 auto}.rail{background:#f8fafc;border-right:1px solid #d8e0e8}.right-rail{border-left:1px solid #d8e0e8;border-right:0}.rail-section{padding:18px 16px;border-bottom:1px solid #dfe6ed}.section-heading,.card-title-row,.diff-header,.stat-row,.page-actions,.editor-foot,.citation-status{display:flex;align-items:center;justify-content:space-between;gap:8px}.section-heading h2,.card-title-row h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#526579}.section-heading>span,.card-title-row>span{font-size:11px;color:#8a9bad}.inline-form{display:flex;gap:5px;margin:14px 0 12px}.inline-form input,.create-page input,.search-form input{min-width:0;width:100%;border:1px solid #cbd6e1;background:#fff;border-radius:6px;padding:8px 9px;outline:none}.inline-form button,.create-page button,.upload-form button,.search-form button{background:#fff;border-color:#c5d1de;color:#34495e;padding:7px 9px;white-space:nowrap}.base-list{display:grid;gap:4px}.base-item,.tree-item{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:6px;background:transparent;color:#405268;text-align:left;padding:9px 8px;font-size:13px}.base-item:hover,.tree-item:hover,.base-item.selected,.tree-item.selected{background:#e4ebf3;color:#172b42}.base-item small{margin-left:auto;color:#8a9bad;font-size:10px}.base-dot{width:7px;height:7px;border-radius:50%;background:#7695b6}.tree-section{min-height:360px}.tree-item{font-size:12px}.tree-item.system{font-weight:650;margin-top:14px}.tree-item .page-type{width:19px;height:19px;display:grid;place-items:center;border:1px solid #b8c8d8;border-radius:4px;color:#62809d;font-size:10px}.warning-count{margin-left:auto;color:#b36b25;background:#fff0d9;border-radius:10px;padding:1px 6px;font-size:10px}.tree-empty{font-size:12px;line-height:1.5}.create-page{display:grid;gap:7px;margin-top:14px}.create-page select,.resource-card select{border:1px solid #cbd6e1;background:#fff;border-radius:6px;padding:7px 8px;color:#405268}.main-panel{min-width:0;padding:28px 34px 56px;background:#fff}.panel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:25px}.panel-header h2{margin:5px 0 7px;font-size:29px;letter-spacing:-.04em}.panel-header p,.page-header p{margin:0;color:#738399;font-size:13px}.mode-pill,.readonly-label{display:inline-flex;align-items:center;padding:6px 9px;border:1px solid #d7e1ea;border-radius:999px;color:#65788c;background:#f7f9fb;font-size:11px;white-space:nowrap}.overview-grid{display:grid;grid-template-columns:1.45fr 1fr 1fr;gap:12px}.overview-card,.content-card{border:1px solid #dae3eb;border-radius:10px;background:#fbfcfd;padding:17px}.hero-card{background:linear-gradient(135deg,#f1f6fc,#fff)}.card-label,.preview-label{display:block;margin-bottom:13px;color:#7e90a3;font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.hero-card strong{display:block;font-size:23px;letter-spacing:-.04em}.overview-card p{font-size:13px;color:#64768a;line-height:1.6}.stat-row{justify-content:flex-start;margin-top:22px;color:#718399;font-size:12px}.stat-row b{color:#203952;font-size:18px;margin-right:3px}.candidate{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid #ebeff3;font-size:12px}.candidate:last-child{border-bottom:0}.candidate small,.empty-card span{color:#8b9aaa;font-size:10px}.empty-card{display:grid;gap:6px;padding:16px 0;color:#53677b;font-size:12px}.log-preview{display:grid;gap:10px}.log-preview div{display:grid;grid-template-columns:1fr auto;gap:3px;font-size:11px}.log-preview b{font-weight:650}.log-preview span,.log-preview time{color:#8b9aaa;font-size:10px}.log-preview time{grid-column:2;grid-row:1 / span 2}.callout{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0;padding:15px 17px;border:1px solid #c9dcef;border-radius:9px;background:#f3f8fd}.callout b{font-size:14px}.callout p{margin:5px 0 0;color:#687d91;font-size:12px}.callout button{border:1px solid #8eafd0;background:#fff;color:#356086;border-radius:6px;padding:7px 10px;white-space:nowrap}.lower-grid{display:grid;grid-template-columns:1.35fr 1fr;gap:12px;margin-top:12px}.content-card{min-height:180px}.topic-list{display:grid;gap:5px}.topic-list button{display:flex;align-items:center;gap:10px;border:0;border-radius:7px;background:transparent;text-align:left;padding:9px;color:#2d4359}.topic-list button:hover{background:#eef4f9}.topic-list button>span:last-child{margin-left:auto;color:#8ba0b3}.large-type{width:28px!important;height:28px!important;font-size:12px!important}.topic-list small,.impact-row small,.resource-card small,.citation-card small{display:block;color:#8494a5;font-size:10px;margin-top:3px}.impact-row{display:flex;align-items:flex-start;gap:9px;padding:8px 0}.status-dot{display:inline-block;flex:0 0 auto;width:8px;height:8px;margin-top:4px;border-radius:50%;background:#6d9a78}.status-dot.needs_review{background:#d59640}.status-dot.broken{background:#c95858}.count-warning{color:#bd6d31!important}.page-header{margin-bottom:14px}.title-input{display:block;width:100%;max-width:640px;border:0;border-bottom:1px solid transparent;padding:0;margin:5px 0 7px;color:#192c40;background:transparent;font-size:29px;font-weight:700;letter-spacing:-.04em;outline:none}.title-input:focus{border-bottom-color:#9cb8d5}.page-actions{align-items:flex-start}.editor-tabs{display:flex;align-items:center;gap:16px;border-bottom:1px solid #e1e7ed;margin-bottom:16px}.editor-tabs button{border:0;background:none;padding:8px 0;color:#8a9aaa;font-size:12px}.editor-tabs button.active{color:#2f6fed;border-bottom:2px solid #2f6fed}.editor-tabs label{margin-left:auto;color:#8797a7;font-size:11px}.editor-tabs code{color:#4e6882}.editor-layout{display:grid;grid-template-columns:1fr 1fr;gap:14px;min-height:420px}.editor-column,.preview-column{min-width:0;border:1px solid #d8e1e9;border-radius:8px;overflow:hidden}.markdown-editor{display:block;width:100%;height:390px;resize:vertical;border:0;padding:17px;background:#fbfcfd;color:#253b51;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}.editor-foot{padding:8px 12px;border-top:1px solid #e1e7ed;color:#8b9aaa;font-size:10px}.preview-column{padding:17px;background:#fff}.markdown-preview{font-size:14px;line-height:1.7}.markdown-preview h2{font-size:22px;margin:0 0 16px}.markdown-preview h3{font-size:17px;margin:17px 0 7px}.markdown-preview h4{font-size:15px;margin:14px 0 5px}.markdown-preview p{margin:5px 0;color:#445b70}.markdown-preview li{margin-left:18px;color:#445b70}.markdown-gap{height:4px}.versions-section{margin-top:24px}.version-list{border:1px solid #dce4eb;border-radius:8px;margin-top:11px}.version-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid #e7ecf1;font-size:12px}.version-row:last-child{border-bottom:0}.version-row.current{background:#f3f7fb}.version-row small{display:block;color:#8796a5;font-size:10px;margin-top:4px}.version-actions{display:flex;gap:5px}.version-actions button,.diff-header button{border:1px solid #ccd8e3;background:#fff;border-radius:5px;padding:6px 8px;color:#55718b;font-size:11px}.version-actions button:disabled{opacity:.4}.diff-box{margin-top:12px;border:1px solid #d5dee7;border-radius:8px;overflow:hidden}.diff-header{padding:9px 12px;background:#f4f7fa;color:#536b82;font-size:11px}.diff-box pre{margin:0;padding:13px;overflow:auto;background:#101820;color:#c5d1dc;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}.diff-box .added{display:block;color:#9ee0ae;background:#153423}.diff-box .removed{display:block;color:#f2a3a3;background:#3e1e22}.right-rail .rail-section{padding:18px}.citation-card{display:grid;gap:5px;padding:10px 0;border-bottom:1px solid #e4eaf0;font-size:12px}.citation-card:last-child{border-bottom:0}.citation-status{justify-content:flex-start;color:#71869b;font-size:10px}.citation-card a{color:#2f6fed;font-size:11px;text-decoration:none;margin-top:3px}.search-form{display:flex;gap:5px;margin:12px 0 7px}.upload-form{display:flex;gap:5px;align-items:center;margin-bottom:12px}.upload-form input{min-width:0;width:100%;font-size:11px;color:#74879a}.resource-card{display:grid;gap:7px;padding:10px 0;border-bottom:1px solid #e4eaf0}.resource-card>div:first-child{display:flex;justify-content:space-between;gap:7px}.resource-card select{font-size:11px}.readonly-label{justify-content:center;border-color:#e8c996;background:#fff7e9;color:#9a6b2d;font-size:10px}.search-results article{padding:9px 0;border-bottom:1px solid #e4eaf0;font-size:11px}.search-results p{margin:5px 0;color:#586f84;line-height:1.5}
      .log-page{max-width:1100px}.log-table{border:1px solid #dce4eb;border-radius:9px;overflow:hidden}.log-row{display:grid;grid-template-columns:150px 150px 1fr 1.5fr;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #e7ecf1;font-size:12px}.log-row:last-child{border-bottom:0}.log-row time,.log-row span,.log-row small{color:#8191a1;font-size:10px}.log-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.page-heading{min-width:0;flex:1}.metadata-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-width:640px;margin:12px 0}.metadata-grid label{display:grid;gap:4px;color:#8494a5;font-size:10px}.metadata-grid input,.metadata-grid select{min-width:0;width:100%;border:1px solid #cbd6e1;background:#fff;border-radius:6px;padding:7px 8px;color:#405268;font-size:11px}.citation-form{display:grid;gap:7px;margin-top:12px}.citation-form select,.citation-form input{min-width:0;width:100%;border:1px solid #cbd6e1;background:#fff;border-radius:6px;padding:8px;color:#405268;font-size:11px}.citation-form div{display:grid;grid-template-columns:1fr 1fr;gap:5px}.citation-form button,.citation-link{border:1px solid #b9ccdf;background:#f5f9fd;color:#356086;border-radius:6px;padding:8px;font-size:11px}.citation-form button:hover,.citation-link:hover{background:#e8f1fa}.citation-link{justify-self:start}.source-preview{max-height:180px;margin:4px 0;padding:9px;overflow:auto;border:1px solid #d8e2eb;border-radius:6px;background:#f7fafc;color:#526a80;white-space:pre-wrap;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.task-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #e4eaf0;font-size:11px}.task-row:last-child{border-bottom:0}.task-row b,.task-row small{display:block}.task-row small{margin-top:3px;color:#8494a5;font-size:10px}.task-status{flex:0 0 auto;color:#5f7891;font-size:10px}.task-status.failed{color:#b24f4f}.task-status.retrying{color:#ad722e}
      .retrieval-panel{margin-top:14px;border:1px solid #cbdceb;border-radius:10px;padding:17px;background:linear-gradient(135deg,#f8fbff,#fff)}.retrieval-subtitle{display:block;margin-top:4px;color:#8a9bad;font-size:10px}.retrieval-form{display:grid;grid-template-columns:minmax(180px,1fr) 150px 70px 70px 88px auto;gap:7px;margin-top:14px}.retrieval-form input,.retrieval-form select{min-width:0;border:1px solid #cbd6e1;background:#fff;border-radius:6px;padding:8px;color:#405268;font-size:11px}.retrieval-form .primary-button{padding:7px 12px}.scope-note{margin:9px 0 0;color:#718399;font-size:11px}.retrieval-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:14px}.retrieval-card{min-width:0;border:1px solid #dce5ed;border-radius:8px;background:#fff;padding:11px}.retrieval-heading{display:flex;align-items:center;justify-content:space-between;color:#526579;font-size:11px}.retrieval-heading span{color:#8a9bad}.retrieval-result{display:flex;align-items:flex-start;justify-content:space-between;gap:7px;width:100%;border:0;border-bottom:1px solid #edf1f4;background:transparent;color:#30465d;text-align:left;text-decoration:none;padding:9px 0;font-size:11px}.retrieval-result:last-of-type{border-bottom:0}.retrieval-result:hover{color:#2f6fed}.retrieval-result small{display:block;margin-top:4px;color:#8494a5;font-size:10px;line-height:1.35}.retrieval-result code{flex:0 0 auto;color:#8092a4;font-size:9px}.retrieval-result.static{cursor:default}.context-summary{display:grid;gap:4px;margin-top:12px;padding-top:10px;border-top:1px solid #e7edf2;color:#526579;font-size:11px}.context-summary span,.context-summary small{color:#8494a5;font-size:10px}.trace-line{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #edf1f4;font-size:10px}.trace-line span{color:#8091a2;text-align:right}.trace-warning{margin-top:8px;padding:7px 8px;border-radius:5px;background:#fff5e5;color:#9a692a;font-size:10px}.retrieval-trace{background:#fbfdff}
      .agent-launcher{background:#f2f7fc}.agent-launcher p{margin:10px 0;color:#72859a;font-size:11px;line-height:1.5}.agent-launch-actions,.agent-header-actions,.plan-actions{display:flex;flex-wrap:wrap;gap:6px}.agent-launch-actions button,.agent-header-actions button,.plan-actions button{border:1px solid #b9ccdf;background:#fff;color:#356086;border-radius:6px;padding:7px 9px;font-size:11px}.agent-launch-actions .primary-button,.agent-header-actions .primary-button,.plan-actions .primary-button{color:#fff;background:#2f6fed;border-color:#2f6fed}.agent-launch-actions button:disabled,.agent-header-actions button:disabled,.plan-actions button:disabled{cursor:not-allowed;opacity:.45}.agent-hint{display:block;margin-top:9px;color:#8494a5;font-size:10px;line-height:1.4}.agent-panel{margin-top:14px;border:1px solid #cbdceb;border-radius:10px;padding:17px;background:linear-gradient(135deg,#f8fbff,#fff)}.agent-plan{background:#fffdf8;border-color:#e5d8bc}.agent-panel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:13px}.agent-panel-header h2{margin:4px 0 6px;font-size:20px;letter-spacing:-.03em}.agent-panel-header p{margin:0;color:#718399;font-size:11px}.agent-header-actions{align-items:flex-start}.agent-header-actions .mode-pill{font-size:10px}.chat-window{display:grid;gap:8px;max-height:420px;overflow:auto;padding:3px}.chat-message{max-width:88%;padding:10px 12px;border:1px solid #dce5ed;border-radius:8px;background:#fff;font-size:12px}.chat-message.user{justify-self:end;background:#edf5ff;border-color:#c9ddef}.chat-message-meta{display:flex;justify-content:space-between;gap:12px;color:#526b83;font-size:10px}.chat-message-meta span{color:#8a9bad}.chat-message p{margin:7px 0 0;color:#30465d;line-height:1.55;white-space:pre-wrap}.answer-meta,.plan-evidence{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;color:#67809a;font-size:10px}.chat-form{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}.chat-form textarea{min-width:0;resize:vertical;border:1px solid #cbd6e1;border-radius:7px;padding:9px;color:#30465d;font-size:12px;line-height:1.5;outline:none}.chat-form textarea:focus{border-color:#80a7cf}.chat-form button{align-self:stretch}.plan-item{margin-top:9px;padding:12px;border:1px solid #e2d8c5;border-radius:8px;background:#fff}.plan-item-header{display:flex;justify-content:space-between;gap:10px;font-size:11px}.plan-item-header b{color:#425b73}.plan-item-header small{display:block;margin-top:4px;color:#8997a4;font-size:10px}.plan-item h3{margin:10px 0 7px;color:#263f58;font-size:14px}.plan-status{color:#6e7f8c;font-size:10px}.plan-status.applied{color:#2b7b4a}.plan-status.stale,.plan-status.apply_failed{color:#b04f4f}.plan-content,.plan-diff{max-height:170px;margin:0;padding:9px;overflow:auto;border:1px solid #e4e9ee;border-radius:6px;background:#f8fafc;color:#52697e;white-space:pre-wrap;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.plan-diff{margin-top:7px;background:#101820;color:#c5d1dc}.plan-blocked{padding:7px 9px;border-radius:6px;background:#fff5e5;color:#9a692a;font-size:10px}.event-list{margin-top:8px;border-top:1px solid #e7edf2}.event-row{display:flex;justify-content:space-between;gap:7px;padding:6px 0;border-bottom:1px solid #edf1f4;font-size:10px}.event-row span{color:#8091a2}.agent-trace{background:#fbfdff}
      @media(max-width:1100px){.workspace{grid-template-columns:220px minmax(0,1fr)}.right-rail{display:none}.main-panel{padding:24px}.overview-grid{grid-template-columns:1fr 1fr}.hero-card{grid-column:1 / -1}.retrieval-form{grid-template-columns:minmax(180px,1fr) 140px 64px 64px 82px auto}.retrieval-grid{grid-template-columns:1fr 1fr}.log-row{grid-template-columns:1fr 1fr}.log-row small{grid-column:1 / -1}}
      @media(max-width:700px){.topbar{height:auto;align-items:flex-start;padding:14px 16px}.topbar-state{display:none}.workspace{display:block}.left-rail{border-right:0}.main-panel{padding:20px 16px}.overview-grid,.lower-grid,.editor-layout,.metadata-grid,.retrieval-grid{grid-template-columns:1fr}.retrieval-form{grid-template-columns:1fr 1fr}.retrieval-form input[name=query],.retrieval-form button{grid-column:1 / -1}.hero-card{grid-column:auto}.panel-header{display:block}.page-actions{margin-top:15px}.editor-layout{min-height:0}.markdown-editor{height:320px}.version-row{align-items:flex-start;display:block}.version-actions{margin-top:9px}}
    `}</style>
    <style jsx>{`.wiki-tree-node{display:grid}.wiki-tree-row{display:grid;grid-template-columns:20px 1fr;align-items:center;gap:2px}.wiki-tree-row>input{justify-self:center}.agent-scope-summary{display:grid;gap:7px;margin:10px 0;padding:9px;border:1px solid #d7e4ef;border-radius:7px;background:#fff;color:#526579;font-size:10px}.agent-scope-summary>div{display:flex;justify-content:space-between;gap:8px}.agent-scope-summary>div span,.agent-scope-summary small,.source-check small{color:#8494a5;font-size:10px}.agent-scope-summary button{justify-self:start;border:1px solid #c5d5e3;background:#fff;border-radius:5px;padding:5px 7px;color:#356086;font-size:10px}.agent-scope-summary label{display:grid;gap:4px;color:#72859a}.agent-scope-summary select{border:1px solid #cbd6e1;background:#fff;border-radius:5px;padding:6px;color:#405268;font-size:10px}.source-check{display:flex;align-items:flex-start;gap:7px;padding:8px 0;border-bottom:1px solid #e4eaf0;color:#405268;font-size:11px}.source-check:last-child{border-bottom:0}.source-check span{min-width:0}.source-check b,.source-check small{display:block}.plan-summary{display:flex;justify-content:space-between;gap:8px;margin:8px 0;color:#526579;font-size:10px}.plan-summary span{color:#8494a5;text-align:right}.plan-edit-form{display:grid;gap:7px}.plan-edit-form input,.plan-edit-form select,.plan-edit-form textarea{min-width:0;width:100%;border:1px solid #cbd6e1;border-radius:6px;padding:7px;background:#fff;color:#30465d;font-size:11px}.plan-edit-form textarea{resize:vertical;line-height:1.5}`}</style>
  </div>;
}
