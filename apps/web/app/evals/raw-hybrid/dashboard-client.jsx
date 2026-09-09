"use client";

import { useMemo, useState } from "react";
import styles from "./dashboard.module.css";

const METRIC_COLORS = {
  Recall: "#2563eb",
  "Hit Rate": "#0f766e",
  MRR: "#7c3aed",
  NDCG: "#c2410c",
  Judged: "#b45309"
};

const metricKey = (metric, k) => `${metric}@${k}`;

const clampScore = (score) => typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;

const percent = (score) => {
  const value = clampScore(score);
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
};

const decimal = (score) => {
  const value = clampScore(score);
  return value === null ? "n/a" : value.toFixed(3);
};

const formatDate = (value) => {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
};

const formatDuration = (durationMs) => {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return "n/a";
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
};

const metricScore = (query, metric, k) => query.metrics?.[metricKey(metric, k)]?.score ?? null;

const qrelDetails = (query, k) => {
  const relevant = new Set((query.qrels || []).filter((qrel) => (qrel.grade ?? 0) > 0).map((qrel) => qrel.chunkId));
  const judged = new Map((query.qrels || []).map((qrel) => [qrel.chunkId, qrel.grade]));
  const retrieved = (query.retrieved || []).slice(0, k);
  const hits = retrieved.filter((item) => relevant.has(item.chunkId));
  const judgedItems = retrieved.filter((item) => judged.has(item.chunkId));
  return {
    relevantCount: relevant.size,
    hitCount: hits.length,
    judgedCount: judgedItems.length,
    returnedCount: retrieved.length,
    hitIds: new Set(hits.map((item) => item.chunkId)),
    gradeByChunkId: judged
  };
};

const queryStatus = (query, metric, k) => {
  const score = metricScore(query, metric, k);
  if (score === null) return "missing";
  if (score === 1) return "perfect";
  if (score > 0) return "partial";
  return "miss";
};

function ScorePill({ score, tone = "blue" }) {
  const value = clampScore(score);
  const toneClass = tone[0].toUpperCase() + tone.slice(1);
  return <span className={`${styles.scorePill} ${styles[`scorePill${toneClass}`]}`}>{value === null ? "n/a" : percent(value)}</span>;
}

function TrendBars({ report }) {
  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>MACRO AVERAGE</p>
          <h2>指标随 K 的变化</h2>
        </div>
        <span className={styles.muted}>基于 {report.queryCount} 条 query</span>
      </div>
      <div className={styles.trendList}>
        {report.metricNames.map((metric) => (
          <div className={styles.trendRow} key={metric}>
            <div className={styles.trendLabel}>
              <span className={styles.metricDot} style={{ backgroundColor: METRIC_COLORS[metric] || "#64748b" }} />
              <span>{metric}</span>
            </div>
            <div className={styles.trendBars}>
              {report.metricKValues.map((k) => {
                const score = report.macroAverage[metricKey(metric, k)];
                return (
                  <div className={styles.barLine} key={k}>
                    <span className={styles.barK}>K{k}</span>
                    <div className={styles.barTrack}>
                      <span className={styles.barFill} style={{ width: `${(clampScore(score) ?? 0) * 100}%`, backgroundColor: METRIC_COLORS[metric] || "#64748b" }} />
                    </div>
                    <b>{percent(score)}</b>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DistributionChart({ queries, metric, k }) {
  const buckets = [
    { label: "0", min: 0, max: 0 },
    { label: "0–25%", min: 0, max: 0.25 },
    { label: "25–50%", min: 0.25, max: 0.5 },
    { label: "50–75%", min: 0.5, max: 0.75 },
    { label: "75–99%", min: 0.75, max: 1 },
    { label: "100%", min: 1, max: 1 }
  ];
  const counts = buckets.map((bucket, index) => queries.reduce((count, query) => {
    const score = clampScore(metricScore(query, metric, k));
    if (score === null) return count;
    const matches = bucket.min === bucket.max
      ? score === bucket.min
      : index === 1
        ? score > 0 && score <= bucket.max
        : index === 4
          ? score > bucket.min && score < bucket.max
        : score > bucket.min && score <= bucket.max;
    return count + (matches ? 1 : 0);
  }, 0));
  const maxCount = Math.max(...counts, 1);
  const nonMissing = counts.reduce((sum, count) => sum + count, 0);

  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>QUERY DISTRIBUTION</p>
          <h2>{metric}@{k} 分数分布</h2>
        </div>
        <span className={styles.muted}>{nonMissing}/{queries.length} 有效分数</span>
      </div>
      <div className={styles.histogram} aria-label={`${metric}@${k} query 分数分布`}>
        {buckets.map((bucket, index) => (
          <div className={styles.histogramColumn} key={bucket.label}>
            <span className={styles.histogramCount}>{counts[index]}</span>
            <div className={styles.histogramTrack}>
              <span className={styles.histogramBar} style={{ height: `${(counts[index] / maxCount) * 100}%` }} />
            </div>
            <span className={styles.histogramLabel}>{bucket.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function QueryDetail({ query, metric, k }) {
  const details = qrelDetails(query, k);
  const selectedMetric = query.metrics?.[metricKey(metric, k)];
  return (
    <div className={styles.queryDetail}>
      <div className={styles.detailHeader}>
        <div>
          <p className={styles.eyebrow}>QUERY DETAIL</p>
          <h3>{query.queryId}</h3>
        </div>
        <ScorePill score={selectedMetric?.score} tone={queryStatus(query, metric, k) === "miss" ? "orange" : "blue"} />
      </div>
      <p className={styles.fullQuery}>{query.query || "（空 query）"}</p>
      <div className={styles.tagList}>
        {query.tags.map((tag) => <span className={styles.tag} key={tag}>{tag}</span>)}
        <span className={styles.tag}>{query.vectorStatus === "used" ? "vector used" : `vector: ${query.vectorStatus}`}</span>
      </div>
      <div className={styles.detailStats}>
        <span><b>{details.hitCount}</b> / {details.relevantCount} relevant hit</span>
        <span><b>{details.judgedCount}</b> / {details.returnedCount} judged</span>
        <span>top-1 <b>{query.retrieved[0]?.chunkId || "n/a"}</b></span>
      </div>
      {selectedMetric?.reason && <p className={styles.metricReason}>{selectedMetric.reason}</p>}
      <div className={styles.detailColumns}>
        <div>
          <h4>QREL ground truth</h4>
          <div className={styles.idList}>
            {query.qrels.length ? query.qrels.map((qrel) => (
              <div className={styles.idRow} key={qrel.chunkId}>
                <code>{qrel.chunkId}</code><span>grade {qrel.grade ?? "n/a"}</span>
              </div>
            )) : <span className={styles.muted}>无 qrel</span>}
          </div>
        </div>
        <div>
          <h4>Retrieved top {Math.min(k, query.retrieved.length)}</h4>
          <div className={styles.retrievedList}>
            {query.retrieved.slice(0, k).map((item) => (
              <div className={`${styles.retrievedRow} ${details.hitIds.has(item.chunkId) ? styles.retrievedHit : ""}`} key={`${item.chunkId}-${item.rank}`}>
                <span className={styles.rank}>{item.rank ?? "–"}</span>
                <code>{item.chunkId}</code>
                <span className={styles.retrievedScore}>{decimal(item.rrfScore)}</span>
                {details.gradeByChunkId.has(item.chunkId) && <span className={styles.grade}>g{details.gradeByChunkId.get(item.chunkId) ?? "n/a"}</span>}
              </div>
            ))}
          </div>
          <p className={styles.detailNote}>报告只保存 chunk 标识与排名分数，不包含 corpus 正文。</p>
        </div>
      </div>
    </div>
  );
}

function QueryTable({ report }) {
  const [metric, setMetric] = useState("Recall");
  const [k, setK] = useState(10);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("score-asc");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  const visibleQueries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return report.queries
      .filter((query) => {
        const status = queryStatus(query, metric, k);
        const matchesFilter = filter === "all" || status === filter;
        const haystack = [query.queryId, query.query, ...(query.tags || []), ...(query.retrieved || []).map((item) => item.chunkId)].join(" ").toLowerCase();
        return matchesFilter && (!needle || haystack.includes(needle));
      })
      .sort((left, right) => {
        if (sort === "query-id") return left.queryId.localeCompare(right.queryId);
        const leftScore = metricScore(left, metric, k) ?? -1;
        const rightScore = metricScore(right, metric, k) ?? -1;
        return sort === "score-desc" ? rightScore - leftScore : leftScore - rightScore;
      });
  }, [filter, k, metric, report.queries, search, sort]);

  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>QUERY EXPLORER</p>
          <h2>逐条检索结果</h2>
        </div>
        <span className={styles.muted}>点击一行展开排名与 qrel</span>
      </div>
      <div className={styles.controls}>
        <label className={styles.searchField} htmlFor="eval-query-search">
          <span>搜索 query / chunk</span>
          <input id="eval-query-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="例如 scifact:query:42" />
        </label>
        <label htmlFor="eval-metric-select">
          <span>指标</span>
          <select id="eval-metric-select" value={metric} onChange={(event) => setMetric(event.target.value)}>
            {report.metricNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label htmlFor="eval-k-select">
          <span>K</span>
          <select id="eval-k-select" value={k} onChange={(event) => setK(Number(event.target.value))}>
            {report.metricKValues.map((value) => <option key={value} value={value}>@{value}</option>)}
          </select>
        </label>
        <label htmlFor="eval-status-select">
          <span>状态</span>
          <select id="eval-status-select" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="miss">未命中</option>
            <option value="partial">部分命中</option>
            <option value="perfect">满分</option>
            <option value="missing">缺失</option>
          </select>
        </label>
        <label htmlFor="eval-sort-select">
          <span>排序</span>
          <select id="eval-sort-select" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="score-asc">分数从低到高</option>
            <option value="score-desc">分数从高到低</option>
            <option value="query-id">Query ID</option>
          </select>
        </label>
      </div>
      <div className={styles.tableMeta}>{visibleQueries.length} / {report.queries.length} 条 query</div>
      <div className={styles.tableWrap}>
        <table className={styles.queryTable}>
          <thead>
            <tr><th>Query</th><th>指标</th><th>命中</th><th>Top result</th><th>状态</th></tr>
          </thead>
          <tbody>
            {visibleQueries.map((query) => {
              const score = metricScore(query, metric, k);
              const details = qrelDetails(query, k);
              const status = queryStatus(query, metric, k);
              const expanded = expandedId === query.queryId;
              return (
                <tr className={expanded ? styles.expandedRow : ""} key={query.queryId}>
                  <td colSpan="5">
                    <button className={styles.queryRowButton} onClick={() => setExpandedId(expanded ? null : query.queryId)}>
                      <span className={styles.queryCell}>
                        <b>{query.queryId}</b>
                        <span>{query.query || "（空 query）"}</span>
                        <small>{query.tags.join(" · ")}</small>
                      </span>
                      {!expanded && <><ScorePill score={score} tone={status === "miss" ? "orange" : "blue"} /><span>{details.hitCount}/{details.relevantCount}</span><code>{query.retrieved[0]?.chunkId || "n/a"}</code><span className={`${styles.status} ${styles[`status${status[0].toUpperCase()}${status.slice(1)}`]}`}>{status === "perfect" ? "满分" : status === "partial" ? "部分" : status === "miss" ? "未命中" : status === "missing" ? "缺失" : status}</span></>}
                    </button>
                    {expanded && <QueryDetail query={query} metric={metric} k={k} />}
                  </td>
                </tr>
              );
            })}
            {!visibleQueries.length && <tr><td colSpan="5" className={styles.emptyState}>没有匹配的 query。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Provenance({ report }) {
  const vectorUsed = report.queries.filter((query) => query.vectorStatus === "used").length;
  const retrievedCount = report.queries.reduce((sum, query) => sum + query.retrieved.length, 0);
  const missingKeyword = report.queries.reduce((sum, query) => sum + query.retrieved.filter((item) => item.keywordRank === null).length, 0);
  const missingVector = report.queries.reduce((sum, query) => sum + query.retrieved.filter((item) => item.vectorRank === null).length, 0);
  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>RUN CONTEXT</p>
          <h2>运行与数据 provenance</h2>
        </div>
        <span className={styles.muted}>{report.schemaVersion}</span>
      </div>
      <div className={styles.provenanceGrid}>
        <div><span>Dataset</span><b>{report.provenance.dataset || "n/a"}</b><small>split: {report.provenance.split || "n/a"}</small></div>
        <div><span>Embedding</span><b>{report.embedding.model || "n/a"}</b><small>{report.embedding.provider || "n/a"} · {report.embedding.dimensions ?? "n/a"} dims</small></div>
        <div><span>Corpus</span><b>{report.corpus.chunkCount ?? "n/a"} chunks</b><small>{report.corpus.corpusSha256 ? `${report.corpus.corpusSha256.slice(0, 16)}…` : "hash n/a"}</small></div>
        <div><span>Run</span><b>{formatDuration(report.durationMs)}</b><small>commit {report.provenance.commit ? report.provenance.commit.slice(0, 9) : "n/a"}</small></div>
        <div><span>Vector status</span><b>{vectorUsed}/{report.queries.length} used</b><small>raw top K {report.provenance.rawTopK ?? "n/a"}</small></div>
        <div><span>Returned rows</span><b>{retrievedCount.toLocaleString("en-US")}</b><small>keyword rank 缺失 {missingKeyword} · vector rank 缺失 {missingVector}</small></div>
      </div>
      <div className={styles.definitionBox}>
        <span>指标定义</span>
        <p>Relevant：{report.metricDefinition.relevantWhen || "n/a"}；gain：{report.metricDefinition.gain || "n/a"}；Judged：{report.metricDefinition.judgedDefinition || "n/a"}。</p>
      </div>
    </section>
  );
}

export default function EvalDashboard({ report }) {
  const k = report.metricKValues.includes(10) ? 10 : report.metricKValues.at(-1);
  const headlineMetrics = ["Recall", "Hit Rate", "MRR", "NDCG", "Judged"];

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <div>
            <div className={styles.breadcrumb}>MYKNOW <span>/</span> EVALUATIONS <span>/</span> SCIFACT</div>
            <h1>Raw-hybrid retrieval</h1>
            <p className={styles.subtitle}>用一页看清 SciFact test split 的检索质量、query 分布和失败样例。</p>
          </div>
          <div className={styles.heroMeta}>
            <span className={styles.metaPill}>static report</span>
            <span className={styles.metaPill}>{report.queryCount} queries</span>
            <span className={styles.metaPill}>generated {formatDate(report.generatedAt)}</span>
          </div>
        </header>

        <section className={styles.kpiGrid}>
          {headlineMetrics.map((metric) => (
            <div className={styles.kpiCard} key={metric}>
              <span>{metric}@{k}</span>
              <strong>{percent(report.macroAverage[metricKey(metric, k)])}</strong>
              <small>macro average · K={k}</small>
            </div>
          ))}
        </section>

        <div className={styles.callout}>
          <span className={styles.calloutIcon}>i</span>
          <p><b>如何读这份报告：</b> Recall / Hit Rate / MRR / NDCG 衡量检索命中质量；Judged 只代表返回结果中有明确 qrel 标注的比例，不是产品质量门槛。当前报告没有 corpus 正文，query 明细因此以 chunk ID 和排名 trace 为主。</p>
        </div>

        <div className={styles.chartGrid}>
          <TrendBars report={report} />
          <DistributionChart queries={report.queries} metric="Recall" k={k} />
        </div>

        <QueryTable report={report} />
        <Provenance report={report} />

        <footer className={styles.footer}>
          <span>Source: evals/raw-hybrid-retrieval/reports/scifact-raw-hybrid-report.json</span>
          <span>本地只读查看器 · 不上传报告数据</span>
        </footer>
      </div>
    </main>
  );
}
