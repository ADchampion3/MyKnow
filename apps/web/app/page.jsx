"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = () => typeof document !== "undefined" ? document.body?.dataset.apiUrl || "http://localhost:3001" : "http://localhost:3001";

const request = async (path, options = {}) => {
  const headers = { ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }), ...(options.headers || {}) };
  const response = await fetch(`${apiBase()}${path}`, { ...options, headers });
  const body = response.status === 204 ? { data: null, error: null } : await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error?.message || "请求失败"), { code: body.error?.code || "HTTP_ERROR" });
  return body;
};

const json = (value) => JSON.stringify(value);
const uploadStatusText = { queued: "等待上传", uploading: "上传中", processing: "处理中", success: "处理成功", error: "上传失败", "processing-error": "处理失败", invalid: "格式不支持" };
const ocrModeText = { auto: "自动 OCR（失败回退原生解析）", off: "跳过 OCR（仅原生解析）", force: "强制 OCR（失败即终止）" };
const processingRequestForMode = (mode, isPdf) => {
  const selectedMode = isPdf && ["auto", "off", "force"].includes(mode) ? mode : "off";
  return { ocrMode: selectedMode, ocrProvider: selectedMode === "off" ? "local" : "paddleocr" };
};
const supportedUploadExtensions = new Set([".md", ".txt", ".pdf"]);
const uploadFileExtension = (name) => {
  const value = String(name || "").toLowerCase();
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(index) : "";
};
const isSupportedUploadFile = (file) => supportedUploadExtensions.has(uploadFileExtension(file?.name));
const uploadFileKey = (file) => [file?.name || "", file?.size || 0, file?.lastModified || 0].join("\u0000");
const createUploadId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const formatFileSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const retrievalLocatorPath = (item) => {
  const locator = item.locator || {};
  const params = new URLSearchParams();
  if (Number.isInteger(locator.startOffset) && Number.isInteger(locator.endOffset) && locator.startOffset >= 0 && locator.endOffset > locator.startOffset) {
    params.set("startOffset", String(locator.startOffset));
    params.set("endOffset", String(locator.endOffset));
  }
  const query = params.toString();
  return `${apiBase()}/api/resources/${encodeURIComponent(item.resourceId)}/versions/${encodeURIComponent(item.resourceVersionId)}/preview${query ? `?${query}` : ""}`;
};
const pageTypes = ["concept", "entity", "source-summary", "synthesis"];
const statusText = { active: "正常", needs_review: "待复核", broken: "失效", indexed: "已索引", pending: "等待处理", queued: "排队中", running: "执行中", retrying: "重试中", processing: "处理中", failed: "失败", degraded: "部分可用", archived: "已归档", completed: "已完成", cancelled: "已取消", disabled: "未启用", integrity_warning: "需检查", superseded: "已被替代" };
const embeddingCountText = (progress) => progress ? `${progress.ready || 0}/${progress.total || 0}` : "-";
const embeddingStatusText = (progress) => progress ? statusText[progress.status] || progress.status : "未开始";

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

const navItems = [
  { id: "overview", label: "知识库总览", icon: "layout" },
  { id: "resources", label: "资料库", icon: "file" },
  { id: "wiki", label: "Wiki", icon: "book" },
  { id: "retrieval", label: "检索问答", icon: "search" },
  { id: "review", label: "待审核", icon: "check" },
  { id: "tasks", label: "任务与记录", icon: "activity" }
];

function Icon({ name, size = 19 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {name === "book" && <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M4 5.5v16" /><path d="M8 7h8M8 11h8" /></>}
    {name === "layout" && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>}
    {name === "file" && <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>}
    {name === "search" && <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.5 4.5" /></>}
    {name === "check" && <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.3 2.4 4.8-5" /></>}
    {name === "activity" && <><path d="M4 17h3l2-8 3 11 2-7 2 4h4" /></>}
    {name === "settings" && <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.6V20a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H6v-2.6h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V5h2.6v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v2.6h-.2a1.7 1.7 0 0 0-1.6 1z" /></>}
    {name === "menu" && <><path d="M4 6h16M4 12h16M4 18h16" /></>}
    {name === "chevron-down" && <path d="m7 9 5 5 5-5" />}
    {name === "chevron-right" && <path d="m9 6 6 6-6 6" />}
    {name === "chevron-left" && <path d="m15 6-6 6 6 6" />}
    {name === "plus" && <><path d="M12 5v14M5 12h14" /></>}
    {name === "upload" && <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 15v4h14v-4" /></>}
    {name === "refresh" && <><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></>}
    {name === "close" && <><path d="m6 6 12 12M18 6 6 18" /></>}
    {name === "external" && <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>}
    {name === "quote" && <><path d="M7 17H4v-4a4 4 0 0 1 4-4h1v3H8a1 1 0 0 0-1 1zM17 17h-3v-4a4 4 0 0 1 4-4h1v3h-1a1 1 0 0 0-1 1z" /></>}
    {name === "edit" && <><path d="m4 16-.7 4.7L8 20l10.8-10.8a2.1 2.1 0 0 0-3-3z" /><path d="m14.5 7.5 2 2" /></>}
    {name === "history" && <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4l2.7 1.6" /></>}
    {name === "hard-drive" && <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 15h18M7 10h.01M10 10h.01" /></>}
    {name === "alert" && <><path d="m12 3 9 17H3z" /><path d="M12 9v4M12 17h.01" /></>}
  </svg>;
}

function Notice({ error, message, onDismiss }) {
  if (!error && !message) return null;
  return <div className={error ? "notice error" : "notice"} role={error ? "alert" : "status"}><Icon name={error ? "alert" : "check"} size={17} /><span>{error || message}</span>{onDismiss && <button className="notice-close" type="button" onClick={onDismiss} aria-label="关闭提示"><Icon name="close" size={17} /></button>}</div>;
}

export default function Page() {
  const [bases, setBases] = useState([]);
  const [selected, setSelected] = useState(null);
  const [wiki, setWiki] = useState(null);
  const [page, setPage] = useState(null);
  const [versions, setVersions] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [tags, setTags] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [resources, setResources] = useState([]);
  const [processingRuns, setProcessingRuns] = useState([]);
  const [embeddingDetails, setEmbeddingDetails] = useState({});
  const [embeddingDetailLoading, setEmbeddingDetailLoading] = useState({});
  const [embeddingActionLoading, setEmbeddingActionLoading] = useState({});
  const [expandedProcessingRunId, setExpandedProcessingRunId] = useState(null);
  const [showHistoricalRuns, setShowHistoricalRuns] = useState(false);
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
  const [expandedWikiPageIds, setExpandedWikiPageIds] = useState([]);
  const [wikiTab, setWikiTab] = useState("read");
  const [drawer, setDrawer] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [wikiDirectoryOpen, setWikiDirectoryOpen] = useState(true);
  const [resourceFilter, setResourceFilter] = useState("");
  const [resourceStatusFilter, setResourceStatusFilter] = useState("all");
  const [uploadQueue, setUploadQueue] = useState([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadDropActive, setUploadDropActive] = useState(false);
  const [uploadOcrMode, setUploadOcrMode] = useState("auto");

  const allPages = useMemo(() => flattenPages(wiki?.pages), [wiki]);
  const treeSourceCount = selectedResourceVersionIds.length + selectedWikiPageIds.length;
  const currentProcessingRuns = useMemo(() => {
    const seenResources = new Set();
    return processingRuns.filter((run) => {
      const resourceKey = run.resourceId || run.resourceVersionId || run.id;
      if (seenResources.has(resourceKey)) return false;
      seenResources.add(resourceKey);
      return true;
    });
  }, [processingRuns]);
  const displayedProcessingRuns = showHistoricalRuns ? processingRuns : currentProcessingRuns;
  const ordinaryPages = useMemo(() => allPages.filter((item) => !item.system), [allPages]);
  const filteredResources = useMemo(() => resources.filter((resource) => {
    const matchesText = !resourceFilter.trim() || resource.name.toLowerCase().includes(resourceFilter.trim().toLowerCase());
    const matchesStatus = resourceStatusFilter === "all" || resource.status === resourceStatusFilter;
    return matchesText && matchesStatus;
  }), [resources, resourceFilter, resourceStatusFilter]);
  const reviewCount = impacts.length + agentPlan.filter((item) => item.reviewStatus === "proposed" && item.applicationStatus === "pending").length;
  const actionableUploadCount = uploadQueue.filter((item) => ["queued", "error"].includes(item.status)).length;
  const uploadProcessingCount = uploadQueue.filter((item) => item.status === "processing").length;
  const uploadCompletedCount = uploadQueue.filter((item) => ["success", "error", "processing-error", "invalid"].includes(item.status)).length;
  const uploadFailureCount = uploadQueue.filter((item) => ["error", "processing-error", "invalid"].includes(item.status)).length;

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

  const reconcileUploadQueue = (resourceRows) => {
    const byResourceId = new Map((resourceRows || []).map((resource) => [resource.id, resource]));
    setUploadQueue((current) => {
      let changed = false;
      const next = current.map((item) => {
        if (item.status !== "processing" || !item.resourceId) return item;
        const resource = byResourceId.get(item.resourceId);
        if (!resource) return item;
        const version = (resource.versions || []).find((candidate) => candidate.id === item.versionId) || resource.latestVersion;
        const task = resource.task?.id === item.taskId ? resource.task : null;
        if (task?.status === "failed" || task?.status === "cancelled" || version?.status === "failed") {
          changed = true;
          return { ...item, status: "processing-error", error: task?.error_summary || task?.errorSummary || version?.error_summary || version?.errorSummary || "原材料处理失败" };
        }
        if (version?.status === "superseded") {
          changed = true;
          return { ...item, status: "processing-error", error: "该版本已被更新版本替代" };
        }
        if (version?.status === "indexed" && (!task || task.status === "succeeded")) {
          changed = true;
          return { ...item, status: "success", error: "" };
        }
        return item;
      });
      return changed ? next : current;
    });
  };

  const loadWorkspace = async (knowledgeBaseId = selected?.id) => {
    if (!knowledgeBaseId) { setWiki(null); setSpaces([]); setTags([]); setResources([]); setProcessingRuns([]); setEmbeddingDetails({}); setEmbeddingDetailLoading({}); setExpandedProcessingRunId(null); setShowHistoricalRuns(false); setImpacts([]); setLoading(false); return; }
    try {
      const [wikiBody, spaceBody, tagBody, resourceBody, processingRunBody, impactBody] = await Promise.all([
        request(`/api/knowledge-bases/${knowledgeBaseId}/wiki`),
        request(`/api/knowledge-bases/${knowledgeBaseId}/spaces`),
        request(`/api/knowledge-bases/${knowledgeBaseId}/tags`),
        request(`/api/resources?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`),
        request(`/api/knowledge-bases/${knowledgeBaseId}/processing-runs?limit=50`),
        request(`/api/knowledge-bases/${knowledgeBaseId}/wiki/impacts`)
      ]);
      setWiki(wikiBody.data);
      setSpaces(spaceBody.data || []);
      setTags(tagBody.data || []);
      const resourceRows = resourceBody.data || [];
      setResources(resourceRows);
      reconcileUploadQueue(resourceRows);
      setProcessingRuns(processingRunBody.data?.items || []);
      setImpacts(impactBody.data?.items || []);
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setLoading(false); }
  };

  const loadEmbeddingDetails = async (run, filterStatus = "failed", page = 1, append = false) => {
    if (!run?.resourceId || !run?.id) return;
    const filter = filterStatus === "all" ? null : filterStatus;
    const key = `${run.id}:${filter || "all"}`;
    setEmbeddingDetailLoading((current) => ({ ...current, [key]: true }));
    try {
      const query = new URLSearchParams({ page: String(page), limit: "20" });
      if (filter) query.set("status", filter);
      const body = await request(`/api/resources/${encodeURIComponent(run.resourceId)}/processing-runs/${encodeURIComponent(run.id)}/embedding-tasks?${query}`);
      setEmbeddingDetails((current) => {
        const next = { ...current };
        const previous = append ? current[key] : null;
        next[key] = { ...body.data, items: append ? [...(previous?.items || []), ...(body.data.items || [])] : body.data.items || [], filterStatus: filter || "all" };
        if (filter === "failed") delete next[`${run.id}:all`];
        return next;
      });
      setExpandedProcessingRunId(run.id);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setEmbeddingDetailLoading((current) => ({ ...current, [key]: false })); }
  };

  const retryEmbeddingTask = async (run, item) => {
    if (!item?.taskId) return;
    try {
      await request(`/api/tasks/${encodeURIComponent(item.taskId)}/retry`, { method: "POST", body: "{}" });
      setMessage("已重新加入向量处理队列");
      await loadWorkspace(selected?.id);
      await loadEmbeddingDetails(run, "failed");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const controlEmbeddingRun = async (run, action) => {
    if (!run?.resourceId || !run?.id) return;
    const key = `${run.id}:${action}`;
    setEmbeddingActionLoading((current) => ({ ...current, [key]: true }));
    try {
      const body = await request(`/api/resources/${encodeURIComponent(run.resourceId)}/processing-runs/${encodeURIComponent(run.id)}/${action}`, { method: "POST", body: json({}) });
      await loadWorkspace(selected?.id);
      await loadEmbeddingDetails(run, action === "retry" ? "failed" : "all");
      const result = body.data || {};
      if (action === "retry") setMessage(result.queued ? `已将 ${result.queued} 个异常 chunk 重新加入 embedding 队列` : "当前没有可重试的 embedding 异常项");
      else setMessage(`已请求取消 ${result.requested || 0} 个 embedding task${result.running ? `，${result.running} 个运行中任务正在停止` : ""}`);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
    finally { setEmbeddingActionLoading((current) => ({ ...current, [key]: false })); }
  };

  const cancelTask = async (task) => {
    if (!task?.id || !["queued", "running", "retrying"].includes(task.status)) return;
    try {
      const body = await request(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST", body: json({}) });
      await loadWorkspace(selected?.id);
      setMessage(body.data?.status === "failed" ? "任务已取消" : "已请求取消任务，worker 会在安全边界停止");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
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
      setView("wiki");
      setWikiTab("read");
      setError("");
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  useEffect(() => { loadBases(); }, []);
  useEffect(() => {
    let active = true;
    const loadRuntime = async () => {
      try { const body = await request("/api/runtime"); if (active) setRuntime(body.data); }
      catch (caught) { if (active) setError(`${caught.code}: ${caught.message}`); }
    };
    loadRuntime();
    const timer = setInterval(loadRuntime, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    setShowHistoricalRuns(false);
    loadWorkspace(selected?.id);
    // ponytail: five-second polling is the local MVP ceiling; upgrade to server-sent updates when multi-user task freshness matters.
    const timer = selected?.id ? setInterval(() => loadWorkspace(selected.id), 5000) : null;
    return () => { if (timer) clearInterval(timer); };
  }, [selected?.id]);

  useEffect(() => {
    if (view === "wiki" && page && !allPages.some((item) => item.id === page.id)) {
      setPage(null);
      setView("overview");
    }
  }, [allPages, page, view]);

  useEffect(() => {
    if (!page?.id) return;
    const byId = new Map(ordinaryPages.map((item) => [item.id, item]));
    const ancestors = [];
    let current = byId.get(page.id);
    const seen = new Set();
    while (current?.parentPageId && !seen.has(current.parentPageId)) {
      seen.add(current.parentPageId);
      ancestors.push(current.parentPageId);
      current = byId.get(current.parentPageId);
    }
    setExpandedWikiPageIds((currentIds) => [...new Set([...currentIds, ...ancestors])]);
  }, [ordinaryPages, page?.id]);

  useEffect(() => {
    if (!drawer) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setDrawer(null); };
    document.addEventListener("keydown", closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawer]);

  const selectBase = (base) => {
    if (uploadBusy) {
      setError("批量上传进行中，请等待当前批次完成后再切换知识库");
      return;
    }
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
    setExpandedWikiPageIds([]);
    setWikiTab("read");
    setDrawer(null);
    setUploadQueue([]);
    setUploadDropActive(false);
  };

  const createBase = async (event) => {
    event.preventDefault();
    if (uploadBusy) {
      setError("批量上传进行中，请等待当前批次完成后再创建知识库");
      return;
    }
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    try {
      const body = await request("/api/knowledge-bases", { method: "POST", body: json({ name }) });
      form.reset();
      setMessage("知识库已创建");
      await loadBases();
      setUploadQueue([]);
      setUploadDropActive(false);
      setSelected(body.data);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const createWorkspaceLabel = async (event, kind) => {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    try {
      await request(`/api/knowledge-bases/${selected.id}/${kind === "space" ? "spaces" : "tags"}`, { method: "POST", body: json({ name }) });
      form.reset();
      await loadWorkspace(selected.id);
      setMessage(`${kind === "space" ? "空间" : "标签"}已创建`);
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
    setDrawer({ kind: "citation", citation });
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

  const queueUploadFiles = (fileList) => {
    if (uploadBusy) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const incomingKeys = new Set();
    const additions = files.reduce((result, file) => {
      const fileKey = uploadFileKey(file);
      if (incomingKeys.has(fileKey)) return result;
      incomingKeys.add(fileKey);
      const valid = isSupportedUploadFile(file);
      result.push({ id: createUploadId(), idempotencyKey: createUploadId(), file, fileKey, status: valid ? "queued" : "invalid", resourceId: null, versionId: null, taskId: null, error: valid ? "" : "仅支持 Markdown、TXT 和 PDF 文件" });
      return result;
    }, []);
    setUploadQueue((current) => {
      const existingKeys = new Set(current.map((item) => item.fileKey));
      return [...current, ...additions.filter((item) => !existingKeys.has(item.fileKey))];
    });
    setError("");
    setMessage("");
  };

  const handleUploadInput = (event) => {
    queueUploadFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  };

  const handleUploadDrop = (event) => {
    event.preventDefault();
    setUploadDropActive(false);
    queueUploadFiles(event.dataTransfer.files);
  };

  const removeUploadItem = (itemId) => {
    if (uploadBusy) return;
    setUploadQueue((current) => current.filter((item) => item.id !== itemId));
  };

  const clearUploadQueue = () => {
    if (uploadBusy) return;
    setUploadQueue([]);
    setError("");
    setMessage("");
  };

  const importResource = async (event) => {
    event.preventDefault();
    if (!selected || uploadBusy) return;
    const pendingItems = uploadQueue.filter((item) => ["queued", "error"].includes(item.status));
    if (!pendingItems.length) return;
    setUploadBusy(true);
    setError("");
    setMessage("");
    let submitted = 0;
    let failed = 0;
    // ponytail: uploads stay sequential to keep the local API/SQLite worker predictable; upgrade to bounded parallelism when large batches need throughput.
    for (const item of pendingItems) {
      setUploadQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "uploading", error: "" } : candidate));
      const payload = new FormData();
      payload.set("name", item.file.name);
      payload.set("knowledgeBaseId", selected.id);
      payload.set("file", item.file);
      const isPdf = item.file.type === "application/pdf" || item.file.name.toLowerCase().endsWith(".pdf");
      const processingRequest = processingRequestForMode(uploadOcrMode, isPdf);
      payload.set("ocrMode", processingRequest.ocrMode);
      payload.set("ocrProvider", processingRequest.ocrProvider);
      try {
        const body = await request("/api/resources", { method: "POST", body: payload, headers: { "idempotency-key": item.idempotencyKey } });
        submitted += 1;
        setUploadQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "processing", resourceId: body.data?.resource?.id || null, versionId: body.data?.version?.id || null, taskId: body.data?.task?.id || null, ocrMode: processingRequest.ocrMode, error: "" } : candidate));
      } catch (caught) {
        failed += 1;
        const uploadError = `${caught.code || "NETWORK_ERROR"}: ${caught.message || "上传失败"}`;
        setUploadQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "error", error: uploadError } : candidate));
      }
    }
    await loadWorkspace(selected.id);
    setUploadBusy(false);
    if (failed) setError(`${failed} 个文件提交失败，请检查列表后重试${submitted ? `；${submitted} 个文件已进入处理，结果会显示在文件清单中` : ""}`);
    else setMessage(`${submitted} 个文件已进入处理队列，文件清单会反馈处理成功或失败`);
  };

  const appendResourceVersion = async (event, resource) => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const processingRequest = processingRequestForMode(uploadOcrMode, isPdf);
    const payload = new FormData();
    payload.set("name", resource.name);
    payload.set("file", file);
    payload.set("ocrMode", processingRequest.ocrMode);
    payload.set("ocrProvider", processingRequest.ocrProvider);
    try {
      await request(`/api/resources/${resource.id}/versions`, { method: "POST", body: payload });
      event.currentTarget.value = "";
      await loadWorkspace(selected.id);
      setMessage(`资源已提交新版本（${ocrModeText[processingRequest.ocrMode]}），处理结果会显示在资源状态中`);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const reprocessResource = async (resource) => {
    const version = resource.currentVersion;
    if (!version) return;
    const isPdf = version.mime_type === "application/pdf";
    const processingRequest = processingRequestForMode(uploadOcrMode, isPdf);
    try {
      await request(`/api/resources/${resource.id}/reprocess`, { method: "POST", body: json({ versionId: version.id, ...processingRequest, ...(isPdf && processingRequest.ocrMode === "force" ? { refreshOcr: true } : {}) }) });
      await loadWorkspace(selected.id);
      setMessage(`已提交显式重处理（${ocrModeText[processingRequest.ocrMode]}），处理结果会显示在资源状态中`);
    } catch (caught) { setError(`${caught.code}: ${caught.message}`); }
  };

  const retryResource = async (resource) => {
    try {
      await request(`/api/resources/${resource.id}/retry`, { method: "POST", body: json({ versionId: resource.latestVersion?.id || resource.currentVersion?.id }) });
      await loadWorkspace(selected.id);
      setMessage("已提交资源重试；旧的成功索引仍保留");
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
      const body = await request("/api/retrieval/query", { method: "POST", body: json({ knowledgeBaseId: selected.id, query, wikiTopK: 1, rawTopK: 20, contextBudgetTokens: 8000 }) });
      setSearchResults(body.data?.raw?.results || []);
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


  const guardEditorExit = () => {
    const currentMarkdown = page?.currentVersion?.contentMarkdown || "";
    const dirty = wikiTab === "edit" && (
      contentDraft !== currentMarkdown ||
      titleDraft !== (page?.title || "") ||
      slugDraft !== (page?.slug || "") ||
      spaceDraft !== (page?.spaceId || "") ||
      parentDraft !== (page?.parentPageId || "")
    );
    return !dirty || typeof window === "undefined" || window.confirm("当前页面有未保存修改，确定离开吗？");
  };

  const navigate = (nextView) => {
    if (nextView !== "wiki" && !guardEditorExit()) return;
    setView(nextView);
    setMobileNavOpen(false);
    if (nextView === "overview") setPage(null);
    if (nextView === "wiki" && !page && ordinaryPages[0]) loadPage(ordinaryPages[0].id);
  };

  const selectWikiPage = (pageId) => {
    if (!guardEditorExit()) return;
    loadPage(pageId);
  };

  const switchWikiTab = (nextTab) => {
    if (nextTab !== "edit" && !guardEditorExit()) return;
    setWikiTab(nextTab);
  };

  const toggleWikiBranch = (pageId) => {
    setExpandedWikiPageIds((current) => current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  };

  const closeDrawer = () => {
    setDrawer(null);
    setSourcePreview(null);
  };

  const openResource = (resource) => setDrawer({ kind: "resource", resource });
  const openRetrievalTrace = () => setDrawer({ kind: "retrieval", retrieval });
  const openAgentTrace = () => setDrawer({ kind: "agent", agentRun, agentEvents });
  const openSettings = () => setDrawer({ kind: "settings" });

  const spaceName = (spaceId) => spaces.find((space) => space.id === spaceId)?.name || "未指定空间";
  const statusLabel = (status) => <span className={"status-tag " + (status || "")}>{statusText[status] || status || "未知状态"}</span>;

  const renderWikiTree = (nodes, depth = 0) => {
    const visibleNodes = (nodes || []).filter((item) => !item.system);
    if (!visibleNodes.length) return null;
    return <ul className={depth ? "wiki-tree-children" : "wiki-tree-list"}>
      {visibleNodes.map((item) => {
        const children = (item.children || []).filter((child) => !child.system);
        const hasChildren = children.length > 0;
        const expanded = expandedWikiPageIds.includes(item.id);
        return <li key={item.id}>
          <div className="wiki-node" style={{ paddingLeft: Math.min(depth, 5) * 4 }}>
            {hasChildren ? <button className="icon-btn tree-toggle" type="button" aria-expanded={expanded} aria-label={(expanded ? "折叠 " : "展开 ") + item.title} title={expanded ? "折叠页面分支" : "展开页面分支"} onClick={() => toggleWikiBranch(item.id)}><Icon name="chevron-right" size={17} /></button> : <span className="tree-spacer" aria-hidden="true" />}
            <label className="tree-checkbox" title="选择为 Agent 整理来源">
              <input type="checkbox" checked={selectedWikiPageIds.includes(item.id)} onChange={() => toggleWikiPage(item.id)} aria-label={"选择 " + item.title + " 作为 Agent 来源"} />
            </label>
            <button className="wiki-select" type="button" aria-current={page?.id === item.id ? "page" : undefined} onClick={() => selectWikiPage(item.id)}>
              <span className="page-type">{(item.pageType || "concept").slice(0, 1).toUpperCase()}</span>
              <span className="wiki-node-title">{item.title}</span>
              {item.pendingCitationCount > 0 && <span className="warning-count">{item.pendingCitationCount}</span>}
            </button>
          </div>
          {hasChildren && expanded && renderWikiTree(children, depth + 1)}
        </li>;
      })}
    </ul>;
  };

  const renderOverview = () => <div className="view-stack">
    <header className="page-head">
      <div>
        <span className="eyebrow">WORKSPACE / INDEX</span>
        <h1>知识库总览</h1>
        <p>从稳定 Wiki 页面、来源引用和待处理影响项开始工作。原始资料始终保留为可追溯底座。</p>
      </div>
      <div className="page-head-actions">
        <button className="btn btn-primary" type="button" onClick={() => navigate("wiki")}><Icon name="book" size={17} />打开 Wiki</button>
        <button className="btn btn-secondary" type="button" onClick={() => loadWorkspace(selected?.id)}><Icon name="refresh" size={17} />刷新</button>
      </div>
    </header>

    <section className="stats-grid" aria-label="知识库统计">
      <div className="stat"><span className="stat-num">{wiki?.pageCount || ordinaryPages.length}</span><span className="stat-label">Wiki 页面</span></div>
      <div className="stat"><span className="stat-num">{resources.length}</span><span className="stat-label">原始资料</span></div>
      <div className="stat"><span className="stat-num">{impacts.length}</span><span className="stat-label">需要关注</span></div>
      <div className="stat"><span className="stat-num">{currentProcessingRuns.length}</span><span className="stat-label">处理运行</span></div>
    </section>

    <div className="overview-columns">
      <section className="section-block">
        <div className="section-lead"><div><h2>继续阅读</h2><p>Wiki 页面按自己的版本链保存，切换页面不会混用版本。</p></div><span className="meta">{selected?.wikiDefaultMode === "retrieval-only" ? "仅检索" : "Wiki 可写入"}</span></div>
        <button className="continue-reading" type="button" onClick={() => navigate("wiki")}>
          <span><strong>{page?.title || ordinaryPages[0]?.title || "还没有 Wiki 页面"}</strong><small>{page ? "当前页面 · v" + versions.length : "创建第一篇页面，开始沉淀知识"}</small></span>
          <Icon name="chevron-right" size={19} />
        </button>
        {wiki?.empty && <div className="article-note"><Icon name="alert" size={18} /><span>Wiki 还是空的。可以先创建页面，也可以打开资料库导入原始材料；系统不会静默替你跳转或生成内容。</span></div>}
      </section>

      <section className="section-block">
        <div className="section-lead"><div><h3>需要关注</h3><p>影响项不是自动修复结果，处理前请确认来源版本。</p></div><span className="meta">{impacts.length}</span></div>
        {impacts.length ? <div className="impact-list">{impacts.slice(0, 6).map((impact) => <div className="impact-row" key={impact.citationId}><span className={"status-dot " + impact.status} /><div><b>{impact.page.title}</b><small>{impact.resource.name} · {statusText[impact.status] || impact.status}</small></div></div>)}</div> : <div className="empty">暂无待复核或失效引用。</div>}
      </section>
    </div>

    <div className="overview-columns">
      <section className="section-block">
        <div className="section-lead"><div><h3>Wiki 整理候选</h3><p>只有明确进入 Agent 整理范围的资料才会生成提案。</p></div></div>
        {wiki?.candidates?.length ? wiki.candidates.slice(0, 8).map((item) => <div className="list-row" key={item.id}><span><b>{item.name}</b><small>{item.mimeType || item.mime_type || "原始资料"}</small></span>{statusLabel(item.status)}</div>) : <div className="empty">暂无候选资料。导入并完成索引后会出现在这里。</div>}
      </section>
      <section className="section-block">
        <div className="section-lead"><div><h3>最近活动</h3><p>系统事件用于追溯处理过程。</p></div><button className="btn btn-ghost" type="button" onClick={() => navigate("tasks")}>查看记录</button></div>
        {(wiki?.log?.events || []).length ? <div className="activity-list">{wiki.log.events.slice(0, 6).map((event) => <div className="list-row" key={event.id}><span><b>{event.event_type}</b><small>{event.entity_type}</small></span><time>{new Date(event.created_at).toLocaleString()}</time></div>)}</div> : <div className="empty">暂无审计事件。</div>}
      </section>
    </div>
  </div>;

  const renderResources = () => <div className="view-stack">
    <header className="page-head">
      <div>
        <span className="eyebrow">LIBRARY / SOURCES</span>
        <h1>资料库</h1>
        <p>原始资料和每个资料版本均为只读事实底座；归档、重处理和追加版本不会删除历史。</p>
      </div>
      <div className="page-head-actions"><button className="btn btn-secondary" type="button" onClick={() => loadWorkspace(selected?.id)}><Icon name="refresh" size={17} />刷新资料</button></div>
    </header>

    <div className="toolbar">
      <form className="toolbar-search" onSubmit={search}>
        <label className="search-field"><span className="visually-hidden">搜索原始资料</span><input name="q" value={resourceFilter} onChange={(event) => setResourceFilter(event.target.value)} maxLength={256} placeholder="搜索原始资料" required /></label>
        <select value={resourceStatusFilter} onChange={(event) => setResourceStatusFilter(event.target.value)} aria-label="按资料状态筛选">
          <option value="all">全部状态</option>
          {["pending", "processing", "indexed", "degraded", "failed", "archived"].map((status) => <option value={status} key={status}>{statusText[status] || status}</option>)}
        </select>
        <button className="btn btn-secondary" type="submit"><Icon name="search" size={17} />搜索</button>
      </form>
    </div>

    <section className="upload-panel" aria-labelledby="upload-title">
      <div className="upload-panel-head">
        <div>
          <span className="eyebrow">BATCH IMPORT</span>
          <h2 id="upload-title">添加原始资料</h2>
          <p>一次选择多个文件，系统会逐个加入处理队列；原始文件始终保留为只读版本。提交后会持续反馈原材料处理结果。</p>
        </div>
        <div className="upload-summary" aria-live="polite">
          {uploadQueue.length ? <><strong>{uploadCompletedCount}/{uploadQueue.length}</strong><span>{uploadProcessingCount ? `处理中 ${uploadProcessingCount} 项` : actionableUploadCount ? `待提交 ${actionableUploadCount} 项` : uploadFailureCount ? `失败 ${uploadFailureCount} 项` : "全部处理成功"}</span></> : <span>支持 MD、TXT、PDF</span>}
        </div>
      </div>
      <form className="upload-form" onSubmit={importResource}>
        <div className="upload-inputs">
          <label className={"upload-dropzone" + (uploadDropActive ? " active" : "") + (uploadBusy ? " disabled" : "")} onDragOver={(event) => { event.preventDefault(); if (!uploadBusy) setUploadDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setUploadDropActive(false); }} onDrop={handleUploadDrop}>
            <input name="file" type="file" accept=".md,.txt,.pdf" multiple disabled={uploadBusy} onChange={handleUploadInput} aria-label="选择要导入的资料，可多选" />
            <span className="upload-drop-icon"><Icon name="upload" size={22} /></span>
            <span><strong>拖拽文件到这里</strong><small>或点击选择，可一次添加多个文件</small></span>
          </label>
          <div className="upload-options">
            <label htmlFor="upload-ocr-mode"><strong>PDF 处理方式（上传、追加、重处理）</strong><select id="upload-ocr-mode" value={uploadOcrMode} onChange={(event) => setUploadOcrMode(event.target.value)} disabled={uploadBusy} aria-describedby="upload-ocr-mode-help"><option value="auto">自动 OCR（推荐）</option><option value="off">跳过 OCR，仅使用原生解析</option><option value="force">强制 OCR（失败即终止）</option></select></label>
            <small id="upload-ocr-mode-help">仅对 PDF 生效；Markdown/TXT 始终使用原生解析。自动 OCR 失败会回退，强制 OCR 失败会标记处理失败。</small>
          </div>
        </div>
        <div className="upload-actions">
          <button className="btn btn-primary" type="submit" disabled={uploadBusy || !actionableUploadCount}><Icon name="upload" size={17} />{uploadBusy ? "上传中…" : actionableUploadCount ? `上传 ${actionableUploadCount} 个文件` : "开始上传"}</button>
          {uploadQueue.length > 0 && <button className="btn btn-ghost" type="button" onClick={clearUploadQueue} disabled={uploadBusy}>清空列表</button>}
        </div>
      </form>
      {uploadQueue.length > 0 && <div className="upload-queue" aria-live="polite">
        <div className="upload-queue-head"><strong>文件清单</strong><span>{uploadQueue.length} 个文件</span></div>
        <ul>
          {uploadQueue.map((item) => <li className={"upload-item " + item.status} key={item.id}>
            <span className="upload-file-type">{uploadFileExtension(item.file.name).slice(1).toUpperCase() || "FILE"}</span>
            <div className="upload-file-info"><strong title={item.file.name}>{item.file.name}</strong><small>{formatFileSize(item.file.size)} · {uploadFileExtension(item.file.name).slice(1).toUpperCase() || "未知类型"}{item.ocrMode && uploadFileExtension(item.file.name) === ".pdf" ? ` · ${ocrModeText[item.ocrMode]}` : ""}</small>{item.error && <span className="upload-item-error" role="alert">{item.error}</span>}</div>
            <span className="upload-item-state"><span className="upload-status-dot" aria-hidden="true" />{uploadStatusText[item.status] || item.status}</span>
            <button className="icon-btn upload-remove" type="button" onClick={() => removeUploadItem(item.id)} disabled={uploadBusy} aria-label={`移除 ${item.file.name}`} title="移除文件"><Icon name="close" size={17} /></button>
          </li>)}
        </ul>
      </div>}
    </section>

    <section className="table-wrap" aria-label="资料列表">
      <table className="data-table">
        <thead><tr><th>资料</th><th>状态 / 版本</th><th className="resource-strategy">Wiki 策略</th><th>操作</th></tr></thead>
        <tbody>
          {filteredResources.map((resource) => <tr key={resource.id}>
            <td data-label="资料"><div className="file-title"><Icon name="file" size={19} /><span><button className="table-link" type="button" onClick={() => openResource(resource)}>{resource.name}</button><span className="table-meta">{resource.mimeType || resource.mime_type || "原始资料"}</span></span></div></td>
            <td data-label="状态 / 版本"><div>{statusLabel(resource.status)}{resource.task?.status && <span className={"status-tag resource-processing-status " + resource.task.status}>处理：{resource.task.status === "succeeded" ? "成功" : statusText[resource.task.status] || resource.task.status}</span>}</div><span className="table-meta">{resource.currentVersion?.id ? "v" + resource.versions.length : "尚未索引"}</span>{resource.latestVersion?.mime_type === "application/pdf" && resource.latestVersion.processingRequest && <span className="table-meta">PDF：{ocrModeText[resource.latestVersion.processingRequest.mode] || resource.latestVersion.processingRequest.mode}</span>}{resource.task?.error_summary && <span className="table-meta resource-error" role="alert">{resource.task.error_summary}</span>}{resource.embeddingProgress && <span className="table-meta">Embedding {embeddingCountText(resource.embeddingProgress)} · {embeddingStatusText(resource.embeddingProgress)}</span>}</td>
            <td data-label="Wiki 策略" className="resource-strategy"><select className="strategy-select" value={resource.wikiMode || "inherit"} onChange={(event) => setResourceMode(resource, event.target.value)} aria-label={resource.name + " 的 Wiki 策略"}><option value="inherit">继承知识库</option><option value="enabled">参与 Wiki</option><option value="retrieval-only">仅检索</option></select></td>
            <td data-label="操作"><div className="resource-actions"><button className="btn btn-secondary" type="button" onClick={() => openResource(resource)}>详情</button><label className="btn btn-secondary">追加版本<input type="file" accept=".md,.txt,.pdf" onChange={(event) => appendResourceVersion(event, resource)} /></label><button className="btn btn-secondary" type="button" disabled={!resource.currentVersion} onClick={() => reprocessResource(resource)}>重处理</button><button className="btn btn-secondary" type="button" disabled={!resource.currentVersion} onClick={() => retryResource(resource)}>重试</button>{["queued", "running", "retrying"].includes(resource.task?.status) && <button className="btn btn-secondary" type="button" onClick={() => cancelTask(resource.task)}>取消处理</button>}</div></td>
          </tr>)}
        </tbody>
      </table>
      {!filteredResources.length && <div className="empty">没有匹配的资料。可以调整筛选条件或导入一份新的原始材料。</div>}
    </section>

    {searchResults.length > 0 && <section className="section-block search-results"><div className="section-lead"><div><h2>搜索结果</h2><p>结果来自当前知识库的原始资料。</p></div><span className="meta">{searchResults.length}</span></div>{searchResults.map((result) => <article key={result.chunkId || result.id}><b>{result.resource?.name || result.resource?.title || "未知资料"}</b><p>{result.snippet || result.content}</p></article>)}</section>}
  </div>;

  const renderWiki = () => <section className="wiki-layout">
    <aside className="wiki-directory" aria-label="Wiki 目录">
      <button className="directory-toggle" type="button" aria-expanded={wikiDirectoryOpen} onClick={() => setWikiDirectoryOpen((open) => !open)}>
        <h2>Wiki 目录</h2><span className="meta">{ordinaryPages.length}<Icon name="chevron-down" size={17} /></span>
      </button>
      {wikiDirectoryOpen && <div className="wiki-directory-body">
        {ordinaryPages.length ? renderWikiTree(wiki?.pages) : <p className="tree-empty">还没有 Wiki 页面，先创建一篇页面。</p>}
        <form className="create-page" onSubmit={createPage}>
          <h3>新建页面</h3>
          <input name="title" placeholder="页面标题" required />
          <input name="slug" placeholder="slug（可选）" pattern="[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?" />
          <select name="pageType" defaultValue="concept">{pageTypes.map((type) => <option key={type}>{type}</option>)}</select>
          <select name="spaceId" defaultValue=""><option value="">不指定空间</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select>
          <select name="parentPageId" defaultValue=""><option value="">顶层页面</option>{ordinaryPages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <button className="btn btn-primary" type="submit"><Icon name="plus" size={17} />新建 Wiki 页面</button>
        </form>
      </div>}
    </aside>

    <div className="wiki-reading">
      {!page && <div className="empty"><h2>选择一篇 Wiki 页面</h2><p>从左侧目录选择页面。主题树是页面父子关系，不是当前正文的大纲。</p></div>}
      {page && <article>
        <header className="article-heading">
          <span className="article-kicker">{page.pageType} / {page.slug}</span>
          <div className="article-heading-row">
            <h1>{page.title}</h1>
            <div className="article-actions">
              <button className="btn btn-secondary" type="button" onClick={() => switchWikiTab("edit")}><Icon name="edit" size={17} />编辑</button>
              <button className="btn btn-secondary" type="button" onClick={() => switchWikiTab("history")}><Icon name="history" size={17} />历史</button>
            </div>
          </div>
          <dl className="page-facts">
            <div><dt>空间</dt><dd>{spaceName(page.spaceId)}</dd></div>
            <div><dt>版本</dt><dd>v{versions.length}</dd></div>
            <div><dt>引用</dt><dd>{currentCitationCount}</dd></div>
            <div><dt>ID</dt><dd>{page.id}</dd></div>
          </dl>
        </header>

        <div className="tabs" role="tablist" aria-label="Wiki 页面内容">
          <button className={"tab " + (wikiTab === "read" ? "selected" : "")} type="button" role="tab" aria-selected={wikiTab === "read"} onClick={() => switchWikiTab("read")}>阅读</button>
          <button className={"tab " + (wikiTab === "edit" ? "selected" : "")} type="button" role="tab" aria-selected={wikiTab === "edit"} onClick={() => switchWikiTab("edit")}>编辑</button>
          <button className={"tab " + (wikiTab === "history" ? "selected" : "")} type="button" role="tab" aria-selected={wikiTab === "history"} onClick={() => switchWikiTab("history")}>版本历史</button>
        </div>

        {wikiTab === "read" && <div className="article">
          <div className="article-text">{markdownPreview(page.currentVersion?.contentMarkdown || "")}</div>
          <div className="article-note"><Icon name="quote" size={18} /><span>引用状态和资料版本保持独立。手动改写内容后，需要重新建立或验证对应引用关系。</span></div>
          <section className="article-bottom">
            <div className="section-lead"><div><h2>引用与原始资料</h2><p>点击引用打开只读原文定位，资料更新不会把旧版本替换成最新版本。</p></div><span className="meta">{currentCitationCount}</span></div>
            {page.currentVersion?.citations?.length ? page.currentVersion.citations.map((citation) => <button className="citation-row" type="button" key={citation.id} onClick={() => openCitation(citation)}><Icon name="quote" size={18} /><div><b>{citation.source?.resourceName || "来源不可用"}</b><small>版本 {citation.resourceVersionId.slice(0, 8)} · locator {JSON.stringify(citation.locator)}</small></div>{statusLabel(citation.status)}</button>) : <div className="empty">当前页面还没有绑定引用。</div>}
          </section>
        </div>}

        {wikiTab === "edit" && <div className="edit-mode">
          <div className="edit-layout">
            <section className="editor-panel"><h3>Markdown 编辑</h3><textarea className="markdown-editor" value={contentDraft} onChange={(event) => setContentDraft(event.target.value)} spellCheck={false} aria-label="Wiki Markdown 内容" /><div className="editor-foot"><span>保存会创建新的不可变版本</span><span className="num">{contentDraft.length.toLocaleString()} 字符</span></div></section>
            <section className="preview-panel"><h3>预览</h3><div className="preview-content"><div className="markdown-preview">{markdownPreview(contentDraft)}</div></div></section>
          </div>
          <div className="metadata-form">
            <label>页面标题<input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={saveMetadata} /></label>
            <label>slug<input value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} onBlur={saveMetadata} /></label>
            <label>空间<select value={spaceDraft} onChange={(event) => setSpaceDraft(event.target.value)} onBlur={saveMetadata}><option value="">不指定空间</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
            <label>父页面<select value={parentDraft} onChange={(event) => setParentDraft(event.target.value)} onBlur={saveMetadata}><option value="">顶层页面</option>{ordinaryPages.filter((item) => item.id !== page.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          </div>
          <div className="edit-actions"><span className="muted">页面 ID：{page.id}</span><button className="btn btn-primary" type="button" onClick={savePage}><Icon name="check" size={17} />保存为新版本</button></div>
        </div>}

        {wikiTab === "history" && <section className="history-mode">
          <div className="section-lead"><div><h2>版本历史</h2><p>恢复会创建新版本，旧版本链和审计记录都会保留。</p></div><span className="meta">{versions.length} versions</span></div>
          <div className="history-list">{versions.length ? versions.map((version, index) => <div className={"version-row " + (version.id === page.currentVersionId ? "current" : "")} key={version.id}><div><b>{version.id === page.currentVersionId ? "当前版本" : "版本 " + (versions.length - index)}</b><small>{new Date(version.created_at || version.createdAt).toLocaleString()} · {version.change_summary || version.changeSummary || "无说明"}</small></div><div className="version-actions"><button className="btn btn-secondary" type="button" disabled={version.id === page.currentVersionId} onClick={() => showDiff(version.id)}>查看 diff</button>{version.id !== page.currentVersionId && <button className="btn btn-secondary" type="button" onClick={() => window.confirm("恢复会创建一个新的版本，原历史不会删除。继续吗？") && restore(version.id)}>恢复为新版本</button>}</div></div>) : <div className="empty">暂无版本历史。</div>}</div>
          {diff && <div className="diff-box"><div className="diff-header"><b>diff：{compareVersionId.slice(0, 8)} → 当前</b><button className="icon-btn" type="button" onClick={() => setDiff(null)} aria-label="关闭 diff" title="关闭 diff"><Icon name="close" size={17} /></button></div><pre>{(diff.lines || []).map((line, index) => <span className={line.type} key={index}>{line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}{line.value}{"\n"}</span>)}</pre></div>}
        </section>}
      </article>}
    </div>
  </section>;

  const renderScope = () => <section className="agent-scope">
    <div>
      <h3>本次整理范围</h3>
      <p className="muted">仅勾选的当前资料版本和 Wiki 页面会进入 Agent 快照；调整范围不会修改旧回答或旧运行。</p>
      <div className="scope-list">
        {resources.map((resource) => {
          const versionId = resource.currentVersion?.id;
          return <label key={resource.id}><input type="checkbox" checked={Boolean(versionId && selectedResourceVersionIds.includes(versionId))} disabled={!versionId} onChange={() => versionId && toggleResourceVersion(versionId)} /><span><b>{resource.name}</b><small>{versionId ? "当前版本 v" + resource.versions.length : "尚未索引"}</small></span></label>;
        })}
        {ordinaryPages.map((item) => <label key={item.id}><input type="checkbox" checked={selectedWikiPageIds.includes(item.id)} onChange={() => toggleWikiPage(item.id)} /><span><b>{item.title}</b><small>Wiki 页面 · {item.pageType}</small></span></label>)}
        {!resources.length && !ordinaryPages.length && <div className="empty">先导入资料或创建 Wiki 页面。</div>}
      </div>
    </div>
    <div className="scope-controls">
      <div className="section-lead"><div><h3>范围摘要</h3><p>{treeSourceCount} 个来源已选择</p></div><span className="num">{treeSourceCount}</span></div>
      <button className="btn btn-secondary" type="button" onClick={selectAllCurrentResources} disabled={!resources.some((resource) => resource.currentVersion?.id)}>选择全部当前资料</button>
      <label>新建树挂载到<select value={mountPageId} onChange={(event) => setMountPageId(event.target.value)}><option value="">顶层</option>{ordinaryPages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <p>资料版本、Wiki 页面和挂载位置会写入本次 Agent run 的范围快照。生成的根节点不会使用系统 index / log 页面。</p>
    </div>
  </section>;

  const renderChat = () => <section className="agent-panel" data-testid="agent-chat">
    <div className="agent-panel-header">
      <div><span className="eyebrow">PI AGENT / READ ONLY</span><h2>Agent 问答</h2><p>当前范围：{page?.title ? "Wiki 页面「" + page.title + "」" : "开放对话（未附带知识库证据）"}</p></div>
      <div className="agent-header-actions"><span className="meta">{agentRun ? "run " + agentRun.status : "尚无运行"}</span>{agentRun && <button className="btn btn-ghost" type="button" onClick={openAgentTrace}>查看运行 trace</button>}<button className="btn btn-secondary" type="button" onClick={chatSession ? () => refreshChatSession() : createChatSession}>{chatSession ? "刷新聊天" : "开始聊天"}</button></div>
    </div>
    <div className="chat-window" aria-live="polite">
      {chatMessages.length ? chatMessages.map((item) => <article className={"chat-message " + item.role + " " + item.status} key={item.id}>
        <div className="chat-message-meta"><b>{item.role === "user" ? "你" : "Pi Agent"}</b><span>{item.status}</span></div>
        <p>{item.content || (["pending", "running", "retrying"].includes(item.status) ? "正在读取范围并整理回答…" : "暂无回答")}</p>
        {item.answer && <div className="answer-meta"><span>evidence: {item.answer.evidenceStatus || "none"}</span><span>{item.answer.evidence?.length || 0} citation(s)</span></div>}
        {item.error && <div className="trace-warning">{item.error.code}: {item.error.message}</div>}
      </article>) : <div className="empty"><b>还没有消息</b><p>可以先问一个开放问题，也可以在打开 Wiki 页面后询问当前范围。</p></div>}
    </div>
    <form className="chat-form" onSubmit={sendChat}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} maxLength={4000} rows={2} placeholder="向 Agent 提问；回答会区分 MyKnow 证据和模型补充…" aria-label="Agent 问题" /><button className="btn btn-primary" type="submit" disabled={chatBusy || !chatInput.trim()}>{chatBusy ? "发送中…" : "发送"}</button></form>
  </section>;

  const renderRetrieval = () => {
    const wikiSeeds = retrieval?.wiki?.seeds || [];
    const rawResults = retrieval?.raw?.results || [];
    const graphExpanded = retrieval?.wiki?.graphExpanded || [];
    return <div className="retrieval-layout">
      <header className="page-head">
        <div><span className="eyebrow">RETRIEVAL / ANSWERS</span><h1>检索问答</h1><p>先明确范围，再查看 Wiki 命中、原始资料定位和上下文预算；证据不足时保留未知。</p></div>
        {retrieval && <button className="btn btn-secondary" type="button" onClick={openRetrievalTrace}><Icon name="activity" size={17} />查看运行 trace</button>}
      </header>
      <section className="section-block">
        <div className="section-lead"><div><h2>运行一次检索</h2><p>本次运行会保存知识库、空间、Top-K 和上下文预算快照。</p></div><span className="meta">{retrieval ? "trace " + retrieval.traceId.slice(0, 8) : "尚未运行"}</span></div>
        <form className="retrieval-form" onSubmit={runRetrieval}>
          <input name="query" required maxLength={256} placeholder="输入要查找的问题或关键词" />
          <select name="spaceId" defaultValue=""><option value="">全部空间</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select>
          <input name="wikiTopK" type="number" min="1" max="20" defaultValue="5" aria-label="Wiki Top K" />
          <input name="rawTopK" type="number" min="1" max="20" defaultValue="10" aria-label="原始资料 Top K" />
          <input name="contextBudgetTokens" type="number" min="1" max="50000" defaultValue="8000" aria-label="上下文预算" />
          <button className="btn btn-primary" type="submit" disabled={retrievalBusy}>{retrievalBusy ? "检索中…" : "开始检索"}</button>
        </form>
        <div className="scope-chips"><span className="tag">知识库：{selected.name}</span><span className="tag">Wiki / 原始资料独立排序</span><span className="tag">原始资料：当前知识库</span></div>
      </section>
      {retrieval && <div className="retrieval-results">
        <section className="result-group"><h3>Wiki 命中 <span>{wikiSeeds.length}</span></h3>{wikiSeeds.length ? wikiSeeds.map((item) => <button className="retrieval-result" type="button" key={item.pageId} onClick={() => selectWikiPage(item.pageId)}><span><b>{item.rank}. {item.title}</b><small>{item.page?.pageType} · score {item.normalizedScore.toFixed(2)} · {item.seedGate?.passed ? "允许图扩展" : "未通过 seed 门槛"}</small></span><code>{item.pageVersionId.slice(0, 8)}</code></button>) : <div className="empty">没有 Wiki 页面命中。</div>}</section>
        <section className="result-group"><h3>原始资料片段 <span>{rawResults.length}</span></h3>{rawResults.length ? rawResults.map((item) => <a className="retrieval-result" key={item.chunkId} href={retrievalLocatorPath(item)} target="_blank" rel="noreferrer"><span><b>{item.rank}. {item.resource?.name}</b><small>{item.content.slice(0, 180)}{item.content.length > 180 ? "…" : ""}</small></span><code>{item.locator?.startOffset ?? "-"}:{item.locator?.endOffset ?? "-"}</code></a>) : <div className="empty">没有原始资料片段命中。</div>}</section>
        <section className="result-group"><h3>关系扩展 <span>{graphExpanded.length}</span></h3>{graphExpanded.length ? graphExpanded.map((item) => <button className="retrieval-result" type="button" key={item.pageId + "-" + item.rank} onClick={() => selectWikiPage(item.pageId)}><span><b>{item.hop}-hop · {item.title}</b><small>{item.path?.map((edge) => edge.direction + " " + edge.linkText).join(" → ")} · decay {item.decay}</small></span><code>{item.pageId.slice(0, 8)}</code></button>) : <div className="empty">只有高置信度 Wiki 命中才会扩展关系。</div>}<div className="context-summary"><b>上下文快照</b><span>{retrieval.context.estimatedTokens}/{retrieval.limits.contextBudgetTokens} tokens · {retrieval.context.truncated ? "已截断" : "在预算内"}</span><small>Wiki {retrieval.context.wikiEstimatedTokens}/{retrieval.context.wikiBudgetTokens} · 原始资料 {retrieval.context.rawEstimatedTokens}/{retrieval.context.rawBudgetTokens}</small></div></section>
      </div>}
      {renderChat()}
    </div>;
  };

  const renderReview = () => <div className="view-stack">
    <header className="page-head">
      <div><span className="eyebrow">REVIEW / CHANGE PLAN</span><h1>待审核</h1><p>Agent 只提交整理计划；审核、证据和真正写入是分开的状态维度。</p></div>
      <div className="page-head-actions"><button className="btn btn-primary" type="button" disabled={!treeSourceCount || agentBusy} onClick={startOrganizePlan}>{agentBusy ? "生成中…" : "生成整理计划"}</button>{agentRun && <button className="btn btn-secondary" type="button" onClick={openAgentTrace}>运行 trace</button>}</div>
    </header>
    {renderScope()}
    {!agentRun && <div className="empty"><h2>尚未生成计划</h2><p>先勾选明确的资料版本或 Wiki 页面，Agent 只能通过审阅计划申请写入。</p></div>}
    {agentRun && !agentPlan.length && <div className="empty"><h2>计划正在生成</h2><p>run {agentRun.id.slice(0, 8)} · {agentRun.status}</p></div>}
    {agentPlan.length > 0 && <div className="plan-summary"><b>Plan status: {agentPlanStatus}</b><span>{agentPlan.filter((item) => item.applicationStatus === "applied").length}/{agentPlan.length} applied · citation policy: {agentRun?.citationPolicy || "required"} · {agentPlan.reduce((count, item) => count + (item.validationWarnings?.length || 0), 0)} warning(s)</span></div>}
    {agentPlan.map((item) => {
      const isTreeNode = Boolean(item.nodeId);
      const isRoot = isTreeNode && !item.parentNodeId;
      const isEditing = editingPlanItemId === item.id;
      return <article className="plan-item" key={item.id}>
        <div className="plan-item-header"><div><b>{item.nodeRole || item.itemType}</b><small>{isTreeNode ? "node " + item.nodeId + " · parent " + (item.parentNodeId || "top-level") : "target " + (item.targetPageId?.slice(0, 8) || "new page")} · risk {item.risk}</small></div>{statusLabel(item.applicationStatus)}</div>
        {isEditing ? <div className="plan-edit-form"><input value={planEditDraft?.title || ""} onChange={(event) => setPlanEditDraft((current) => ({ ...current, title: event.target.value }))} maxLength={200} aria-label="提案标题" /><select value={planEditDraft?.pageType || "concept"} onChange={(event) => setPlanEditDraft((current) => ({ ...current, pageType: event.target.value }))} aria-label="提案页面类型">{pageTypes.map((type) => <option key={type}>{type}</option>)}</select><textarea value={planEditDraft?.contentMarkdown || ""} onChange={(event) => setPlanEditDraft((current) => ({ ...current, contentMarkdown: event.target.value }))} maxLength={120000} rows={6} aria-label="提案内容" /><div className="plan-actions"><button className="btn btn-primary" type="button" onClick={() => savePlanEdit(item)}>保存编辑</button><button className="btn btn-secondary" type="button" onClick={() => { setEditingPlanItemId(null); setPlanEditDraft(null); }}>取消</button></div></div> : <><h3>{item.proposed?.title || "未命名提案"}</h3>{item.proposed?.contentMarkdown && <pre className="plan-content">{item.proposed.contentMarkdown.slice(0, 1600)}</pre>}</>}
        {item.diff?.lines?.length > 0 && <pre className="plan-diff">{item.diff.lines.slice(0, 80).map((line) => (line.type === "added" ? "+" : line.type === "removed" ? "-" : " ") + " " + line.value).join("\n")}</pre>}
        <div className="plan-evidence"><span>证据：{item.evidenceStatus}</span><span>{item.citations?.length || 0} citation(s)</span><span>审核：{item.reviewStatus}</span></div>
        {item.validationWarnings?.length > 0 && <div className="trace-warning">{item.validationWarnings.map((warning, index) => <div key={warning.code + "-" + (warning.citationIndex ?? "missing") + "-" + index}>{warning.code}: {warning.message}</div>)}</div>}
        {item.error && <div className="trace-warning">{item.error.code}: {item.error.message}</div>}
        <div className="plan-actions">
          {item.reviewStatus === "proposed" && item.applicationStatus === "pending" && <>{item.evidenceStatus === "needs_evidence" ? <span className="plan-blocked">需要补充证据后才能应用</span> : isTreeNode && isRoot ? <button className="btn btn-primary" type="button" onClick={() => decidePlanBranch(item, "approve")}>审阅并应用整棵分支</button> : <button className="btn btn-primary" type="button" onClick={() => decidePlanItem(item, "approve")}>审阅并应用</button>}<button className="btn btn-secondary" type="button" onClick={() => decidePlanBranch(item, "reject")}>拒绝{isTreeNode ? "分支" : ""}</button>{!isEditing && <button className="btn btn-secondary" type="button" onClick={() => beginPlanEdit(item)}>编辑</button>}</>}
          {item.applicationStatus === "applied" && <button className="btn btn-secondary" type="button" onClick={() => rollbackPlanItem(item)}>恢复为新版本</button>}
        </div>
      </article>;
    })}
  </div>;

  const renderTasks = () => <div className="view-stack">
    <header className="page-head"><div><span className="eyebrow">OPERATIONS / HISTORY</span><h1>任务与记录</h1><p>按资源处理运行查看解析、分块和向量进度；成功项默认折叠，失败项保留可重试和可溯源细节。</p></div><button className="btn btn-secondary" type="button" onClick={() => loadWorkspace(selected?.id)}><Icon name="refresh" size={17} />刷新状态</button></header>
    <section className="section-block"><div className="section-lead"><div><h2>处理运行</h2><p>Embedding 进度按 processing run 聚合，不再把每个 chunk 的成功事件铺满页面。</p></div><div className="inline-actions"><span className="meta">{displayedProcessingRuns.length} / {processingRuns.length}</span>{processingRuns.length > currentProcessingRuns.length && <button className="btn btn-ghost" type="button" onClick={() => setShowHistoricalRuns((visible) => !visible)}>{showHistoricalRuns ? "仅显示当前运行" : `查看历史运行 (${processingRuns.length - currentProcessingRuns.length})`}</button>}</div></div><div className="run-list">{displayedProcessingRuns.length ? displayedProcessingRuns.map((run) => {
      const progress = run.embeddingProgress;
      const isExpanded = expandedProcessingRunId === run.id;
      const detail = embeddingDetails[`${run.id}:all`] || embeddingDetails[`${run.id}:failed`];
      const detailKey = `${run.id}:${detail?.filterStatus || "failed"}`;
      const detailLoading = embeddingDetailLoading[detailKey] || embeddingDetailLoading[`${run.id}:all`] || embeddingDetailLoading[`${run.id}:failed`];
      const retryableCount = (progress?.failed || 0) + (progress?.cancelled || 0) + (progress?.missing || 0);
      const cancelBusy = embeddingActionLoading[`${run.id}:cancel`];
      const retryBusy = embeddingActionLoading[`${run.id}:retry`];
      return <article className="run-row" key={run.id}>
        <div className="run-row-head"><div><b>{run.resourceName || "未命名资源"}</b><small>run {run.id.slice(0, 8)} · version {(run.resourceVersionId || "").slice(0, 8)} · {new Date(run.createdAt).toLocaleString()}</small></div>{statusLabel(progress?.status || run.status)}</div>
        <div className="run-summary"><div className="run-progress-line"><span>Embedding</span><strong>{embeddingCountText(progress)}</strong><span>{embeddingStatusText(progress)}</span></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, progress?.progressPercent || 0))}%` }} /></div><div className="run-metrics"><span>待处理 {progress?.pending || 0}</span><span>失败 {progress?.failed || 0}</span><span>取消 {progress?.cancelled || 0}</span><span>缺失 {progress?.missing || 0}</span><span>{progress?.provider || "-"} / {progress?.model || "-"}</span></div></div>
        {progress?.errorGroups?.length > 0 && <div className="run-error-groups">{progress.errorGroups.slice(0, 5).map((group) => <span key={`${group.errorCode}-${group.provider}-${group.model}`}>{group.errorCode} × {group.count}</span>)}</div>}
        <div className="inline-actions"><button className="btn btn-ghost" type="button" onClick={() => { setExpandedProcessingRunId(isExpanded ? null : run.id); if (!isExpanded && !detail) loadEmbeddingDetails(run, "failed"); }}>{isExpanded ? "收起明细" : "查看失败项"}</button>{isExpanded && <button className="btn btn-ghost" type="button" onClick={() => loadEmbeddingDetails(run, null)}>查看全部</button>}{progress?.pending > 0 && run.status !== "superseded" && <button className="btn btn-secondary" type="button" disabled={cancelBusy || retryBusy} onClick={() => controlEmbeddingRun(run, "cancel")}>{cancelBusy ? "取消中…" : `取消剩余任务 (${progress.pending})`}</button>}{retryableCount > 0 && run.status !== "superseded" && <button className="btn btn-secondary" type="button" disabled={cancelBusy || retryBusy} onClick={() => controlEmbeddingRun(run, "retry")}>{retryBusy ? "重试中…" : `一键重试异常项 (${retryableCount})`}</button>}</div>
        {isExpanded && <div className="run-detail">{detailLoading && <div className="muted">正在加载明细…</div>}{detail && !detailLoading && <>{detail.items?.length ? detail.items.map((item) => <div className="run-detail-row" key={item.chunkId}><div><b>#{item.sequence} · {statusText[item.status] || item.status}</b><small>{item.errorCode || `${item.provider} / ${item.model}`} · chunk {item.chunkId.slice(0, 8)} · retry {item.retryCount}/{item.retryLimit}</small>{item.errorSummary && <small>{item.errorSummary}</small>}</div>{["failed", "cancelled"].includes(item.status) && item.taskId && <button className="btn btn-secondary" type="button" onClick={() => retryEmbeddingTask(run, item)}>重试</button>}</div>) : <div className="empty">当前筛选没有明细项。</div>}{detail.total > detail.items.length && <><small className="muted">当前显示 {detail.items.length} / {detail.total} 项。</small><button className="btn btn-ghost" type="button" onClick={() => loadEmbeddingDetails(run, detail.filterStatus === "all" ? null : detail.filterStatus, Math.floor(detail.items.length / 20) + 1, true)}>加载下一页</button></>}</>}{!detail && !detailLoading && <div className="empty">暂无可显示的明细。</div>}</div>}
      </article>;
    }) : <div className="empty">暂无处理运行。</div>}</div></section>
    <section className="section-block"><div className="section-lead"><div><h2>系统事件</h2><p>默认只展示高层生命周期事件；逐项失败和重试请从上面的运行明细进入。</p></div><span className="meta">{(wiki?.log?.events || []).length}</span></div><div className="log-table">{(wiki?.log?.events || []).map((event) => <div className="log-row" key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time><b>{event.event_type}</b><span>{event.entity_type} / {event.entity_id.slice(0, 8)}</span><small>{JSON.stringify(event.metadata || {})}</small></div>)}{!wiki?.log?.events?.length && <div className="empty">暂无系统事件。</div>}</div></section>
  </div>;

  const currentNav = navItems.find((item) => item.id === (view === "log" ? "tasks" : view)) || navItems[0];
  const currentViewLabel = currentNav.label;

  return <div className="knowledge-shell">
    <aside className={"global-sidebar " + (mobileNavOpen ? "visible" : "")} aria-label="全局导航">
      <div className="sidebar-top">
        <div className="brand"><Icon name="book" size={27} />MyKnow</div>
        <div className="library-switch">
          <span><span className="label-text">当前知识库</span>{bases.length ? <select value={selected?.id || ""} onChange={(event) => { const next = bases.find((base) => base.id === event.target.value); if (next) selectBase(next); }} aria-label="选择当前知识库">{bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}</select> : <strong>暂无知识库</strong>}</span>
          <Icon name="chevron-down" size={17} />
        </div>
        <form className="library-create" onSubmit={createBase}><input name="name" placeholder="新知识库名称" required /><button className="btn btn-primary" type="submit" aria-label="创建知识库" title="创建知识库"><Icon name="plus" size={17} /></button></form>
        <nav aria-label="工作区模块">
          <p className="nav-label">工作区</p>
          <div className="nav-list">{navItems.map((item) => {
            const count = item.id === "resources" ? resources.length : item.id === "wiki" ? ordinaryPages.length : item.id === "review" ? reviewCount : item.id === "tasks" ? currentProcessingRuns.length : null;
            return <button className={"nav-link " + (view === item.id ? "active" : "")} type="button" key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} size={19} /><span>{item.label}</span>{count !== null && <span className="count">{count}</span>}</button>;
          })}</div>
        </nav>
      </div>
      <div className="sidebar-foot">
        <div className="row"><Icon name="hard-drive" size={16} /><span>本地工作区</span></div>
        <p>{runtime ? (runtime.aiEgressMode === "local_only" ? "AI 仅允许本地 Provider" : "AI 可使用云端 Provider") : "运行策略加载中"}</p>
        <button className="policy-button" type="button" onClick={openSettings}>AI 策略与运行状态</button>
      </div>
    </aside>
    {mobileNavOpen && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}

    <div className="workspace-column">
      <header className="topnav" data-testid="personal-runtime">
        <div className="crumb"><button className="icon-btn mobile-menu" type="button" aria-label="切换导航" title="切换导航" onClick={() => setMobileNavOpen((open) => !open)}><Icon name="menu" size={19} /></button><span className="muted">{selected?.name || "MyKnow"}</span><span className="muted">/</span><strong>{currentViewLabel}</strong></div>
        <div className="top-actions"><span className="runtime-status" data-testid="runtime-status">{runtime ? (runtime.aiEgressMode === "local_only" ? "仅本地 AI" : "允许云端 AI") + " · " + runtime.model.provider : "运行状态加载中"}</span><button className="icon-btn" type="button" title="检索知识库" aria-label="检索知识库" onClick={() => navigate("retrieval")}><Icon name="search" size={19} /></button><button className="icon-btn" type="button" title="知识库设置" aria-label="知识库设置" onClick={openSettings}><Icon name="settings" size={19} /></button></div>
      </header>

      <main className="main-content">
        <Notice error={error} message={message} onDismiss={() => { setError(""); setMessage(""); }} />
        {!selected && <div className="empty"><h1>选择或创建一个知识库</h1><p>知识库是检索和 Wiki 的边界；先创建或选择一个知识库，再开始导入资料。</p><form className="library-create" onSubmit={createBase}><input name="name" placeholder="新知识库名称" required /><button className="btn btn-primary" type="submit"><Icon name="plus" size={17} />创建知识库</button></form></div>}
        {selected && loading && <div className="loading-line" role="status">正在加载当前知识库…</div>}
        {selected && view === "overview" && renderOverview()}
        {selected && view === "resources" && renderResources()}
        {selected && view === "wiki" && renderWiki()}
        {selected && view === "retrieval" && renderRetrieval()}
        {selected && view === "review" && renderReview()}
        {selected && (view === "tasks" || view === "log") && renderTasks()}
      </main>
    </div>

    {drawer && <div className="drawer-overlay open" role="presentation" onClick={closeDrawer}>
      <aside className="context-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head"><div><span className="eyebrow">CONTEXT / DETAIL</span><h2 id="drawer-title">{drawer.kind === "citation" ? "引用追溯" : drawer.kind === "resource" ? "资料详情" : drawer.kind === "retrieval" ? "检索运行" : drawer.kind === "agent" ? "Agent 运行" : "知识库设置"}</h2></div><button className="icon-btn" type="button" data-drawer-close="true" aria-label="关闭详情" title="关闭详情" onClick={closeDrawer}><Icon name="close" size={19} /></button></div>

        {drawer.kind === "citation" && <div>
          <section className="drawer-section"><h3>{drawer.citation.source?.resourceName || "来源不可用"}</h3><dl className="drawer-facts"><div><dt>引用状态</dt><dd>{statusLabel(drawer.citation.status)}</dd></div><div><dt>资料版本</dt><dd>{drawer.citation.resourceVersionId}</dd></div><div><dt>原文位置</dt><dd>{JSON.stringify(drawer.citation.locator)}</dd></div></dl></section>
          <section className="drawer-section"><h3>只读上下文</h3>{drawer.citation.source?.previewPath ? sourcePreview?.citationId === drawer.citation.id ? <div className="source-preview">{sourcePreview.snippet || "该文件类型暂无文本预览。"}</div> : <p className="muted">正在读取引用位置…</p> : <p className="muted">该引用没有可用的原文预览入口。</p>}</section>
          {drawer.citation.source?.downloadPath && <section className="drawer-section"><a className="btn btn-secondary" href={apiBase() + drawer.citation.source.downloadPath} target="_blank" rel="noreferrer">打开只读原文 <Icon name="external" size={16} /></a></section>}
        </div>}

        {drawer.kind === "resource" && <div>
          <section className="drawer-section"><h3>{drawer.resource.name}</h3><dl className="drawer-facts"><div><dt>当前状态</dt><dd>{statusLabel(drawer.resource.status)}</dd></div><div><dt>Wiki 策略</dt><dd>{drawer.resource.wikiMode || "继承知识库"}</dd></div><div><dt>资料类型</dt><dd>{drawer.resource.mimeType || drawer.resource.mime_type || "原始资料"}</dd></div></dl></section>
          <section className="drawer-section"><h3>不可变版本</h3><div className="drawer-list">{(drawer.resource.versions || []).map((version, index) => <div key={version.id}><b>v{(drawer.resource.versions || []).length - index}</b><small>{version.id}<br />{version.created_at || version.createdAt || "时间未知"}</small></div>)}</div></section>
          <section className="drawer-section"><p className="settings-note">原始文件保持只读。追加版本会重新进入处理队列，旧版本仍可用于引用追溯。</p><div className="inline-actions"><button className="btn btn-secondary" type="button" disabled={!drawer.resource.currentVersion} onClick={() => { reprocessResource(drawer.resource); closeDrawer(); }}>重处理</button><button className="btn btn-secondary" type="button" disabled={!drawer.resource.currentVersion} onClick={() => { retryResource(drawer.resource); closeDrawer(); }}>重试</button></div></section>
        </div>}

        {drawer.kind === "retrieval" && drawer.retrieval && <div>
          <section className="drawer-section"><dl className="drawer-facts"><div><dt>Trace</dt><dd>{drawer.retrieval.traceId}</dd></div><div><dt>范围</dt><dd>{drawer.retrieval.scope.knowledgeBaseId} · raw = whole KB</dd></div><div><dt>向量状态</dt><dd>{drawer.retrieval.vector.status}</dd></div><div><dt>模型</dt><dd>{drawer.retrieval.vector.provider} / {drawer.retrieval.vector.model}</dd></div><div><dt>耗时</dt><dd>{drawer.retrieval.metrics.durationMs}ms</dd></div></dl></section>
          {drawer.retrieval.vector.error && <section className="drawer-section"><div className="trace-warning">关键词降级：{drawer.retrieval.vector.error.code}</div></section>}
          <section className="drawer-section"><h3>上下文</h3><p className="settings-note">{drawer.retrieval.context.estimatedTokens}/{drawer.retrieval.limits.contextBudgetTokens} tokens · {drawer.retrieval.context.truncated ? "已截断" : "在预算内"}</p></section>
        </div>}

        {drawer.kind === "agent" && drawer.agentRun && <div>
          <section className="drawer-section"><dl className="drawer-facts"><div><dt>Provider</dt><dd>{drawer.agentRun.provider} / {drawer.agentRun.model}</dd></div><div><dt>状态</dt><dd>{drawer.agentRun.status}</dd></div><div><dt>范围</dt><dd>{drawer.agentRun.scope?.knowledgeBaseId ? drawer.agentRun.scope.knowledgeBaseId + " · snapshot" : "open chat"}</dd></div><div><dt>引用策略</dt><dd>{drawer.agentRun.citationPolicy || "required"}</dd></div><div><dt>事件</dt><dd>{drawer.agentEvents?.length || 0}</dd></div></dl></section>
          {drawer.agentRun.error && <section className="drawer-section"><div className="trace-warning">{drawer.agentRun.error.code}: {drawer.agentRun.error.message}</div></section>}
          <section className="drawer-section"><h3>最近事件</h3><div className="event-list">{(drawer.agentEvents || []).slice(-8).map((event) => <div className="event-row" key={event.id}><b>{event.eventType}</b><span>{event.toolName || event.stage || "agent"}</span></div>)}</div></section>
        </div>}

        {drawer.kind === "settings" && <div>
          <section className="drawer-section"><h3>{selected?.name || "当前知识库"}</h3><dl className="drawer-facts"><div><dt>Wiki 默认策略</dt><dd>{selected?.wikiDefaultMode === "retrieval-only" ? "仅检索" : "Wiki 可参与整理"}</dd></div><div><dt>AI 出站策略</dt><dd>{runtime?.aiEgressMode === "local_only" ? "仅本地 Provider" : "允许云端 Provider"}</dd></div><div><dt>模型</dt><dd>{runtime ? runtime.model.provider + " / " + runtime.model.model : "加载中"}</dd></div><div><dt>向量模型</dt><dd>{runtime ? runtime.embedding.provider + " / " + runtime.embedding.model : "加载中"}</dd></div></dl></section>
          <section className="drawer-section"><p className="settings-note">密钥和内部配置只保留在服务端；这里仅展示帮助用户理解当前运行边界的状态。</p></section>
        </div>}
      </aside>
    </div>}
  </div>;
}
