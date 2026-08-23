"use client";

import { useEffect, useState } from "react";

const api = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const readJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "请求失败");
  return body;
};

export default function Page() {
  const [bases, setBases] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [resources, setResources] = useState([]);
  const [selected, setSelected] = useState(null);
  const [results, setResults] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async (knowledgeBaseId = selected?.id) => {
    try {
      const [baseBody, taskBody, resourceBody] = await Promise.all([
        readJson(`${api}/api/knowledge-bases`),
        readJson(`${api}/api/tasks`),
        readJson(`${api}/api/resources${knowledgeBaseId ? `?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}` : ""}`)
      ]);
      setBases(baseBody.data || []);
      setTasks(taskBody.data || []);
      setResources(resourceBody.data || []);
      setError("");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), 1500);
    return () => clearInterval(timer);
  }, [selected?.id]);

  const createBase = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await readJson(`${api}/api/knowledge-bases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: new FormData(form).get("name") }) });
      form.reset();
      setMessage("知识库已创建");
      await load();
    } catch (caught) { setMessage(caught.message); }
  };

  const createTask = async (event) => {
    event.preventDefault();
    try { await readJson(`${api}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: new FormData(event.currentTarget).get("type") }) }); await load(); } catch (caught) { setMessage(caught.message); }
  };

  const importFile = async (event) => {
    event.preventDefault();
    if (!selected) return setMessage("请先选择知识库");
    const file = event.currentTarget.file.files[0];
    if (!file) return;
    try {
      const payload = new FormData();
      payload.set("name", file.name);
      payload.set("knowledgeBaseId", selected.id);
      payload.set("file", file);
      await readJson(`${api}/api/resources`, { method: "POST", body: payload });
      setMessage("已创建导入任务");
      event.currentTarget.reset();
      await load();
    } catch (caught) { setMessage(caught.message); }
  };

  const retry = async (path) => {
    try { await readJson(`${api}${path}`, { method: "POST" }); setMessage("已重新排队"); await load(); } catch (caught) { setMessage(caught.message); }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const q = new FormData(event.currentTarget).get("q");
    try { setResults((await readJson(`${api}/api/search?q=${encodeURIComponent(q)}&knowledgeBaseId=${encodeURIComponent(selected.id)}`)).data || []); setError(""); } catch (caught) { setError(caught.message); setResults([]); }
  };

  return <>
    <header><h1>MyKnow</h1></header>
    {error && <p className="error">{error}</p>}
    <main>
      <section><h2>知识库</h2><form onSubmit={createBase}><input name="name" placeholder="新知识库" required /><button>创建</button></form>{loading && !bases.length ? <p className="muted">加载中…</p> : <ul>{bases.map((base) => <li key={base.id}><button onClick={() => { setSelected(base); setResults([]); }}>{base.name}</button></li>)}</ul>}{!loading && !bases.length && <p className="muted">暂无知识库</p>}</section>
      <section><h2>工作区</h2><p>{selected ? `当前知识库：${selected.name}` : "请选择知识库。"}</p>{selected && <><form onSubmit={importFile}><input name="file" type="file" accept=".md,.txt,.pdf" required /><button>导入</button></form><p className="muted">{message}</p><form onSubmit={search}><input name="q" placeholder="搜索已索引资料" required /><button>搜索</button></form><h3>资料</h3>{resources.length ? resources.map((item) => <p key={item.id}><b>{item.name}</b> {item.status} {item.status === "failed" && <button onClick={() => retry(`/api/resources/${item.id}/retry`)}>重试</button>} {item.status === "indexed" && <button onClick={() => retry(`/api/resources/${item.id}/reprocess`)}>全量重建</button>}</p>) : <p className="muted">暂无资料</p>}<h3>结果</h3>{results.length ? results.map((item) => <article key={item.id}><b>{item.resource_name}</b><p>{item.content}</p>{item.parent_content && <details><summary>父块上下文</summary><p>{item.parent_content}</p></details>}</article>) : <p className="muted">暂无搜索结果</p>}</>}</section>
      <section><h2>任务</h2><form onSubmit={createTask}><select name="type"><option value="demo_success">演示成功任务</option><option value="demo_failure">演示失败任务</option></select><button>创建任务</button></form>{tasks.length ? tasks.map((task) => <p key={task.id}><b>{task.type}</b> {task.status} {task.errorSummary && <span className="error">{task.errorSummary}</span>} {task.status === "failed" && <button onClick={() => retry(`/api/tasks/${task.id}/retry`)}>重试</button>}</p>) : <p className="muted">暂无任务</p>}</section>
    </main>
    <style jsx>{`body{margin:0;font-family:system-ui;background:#f5f7f9}header{padding:16px 24px;background:#17202a;color:#fff}.error{color:#a4262c}main{display:grid;grid-template-columns:240px 1fr 320px;min-height:calc(100vh - 60px)}section{padding:20px;background:#fff;border-right:1px solid #d9dee5}button,input,select{font:inherit;padding:8px;margin:4px;border:1px solid #bbc4cf;border-radius:4px}.muted{color:#647181}article{border-top:1px solid #ddd}article p{white-space:pre-wrap}@media(max-width:1024px){main{grid-template-columns:200px 1fr}main section:last-child{display:none}}@media(max-width:700px){main{display:block}}`}</style>
  </>;
}
