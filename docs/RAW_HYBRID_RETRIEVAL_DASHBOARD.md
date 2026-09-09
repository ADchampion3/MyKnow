# Raw-hybrid retrieval eval dashboard

仓库内置了一个只读的 SciFact raw-hybrid retrieval 报告查看器。它直接读取：

`evals/raw-hybrid-retrieval/reports/scifact-raw-hybrid-report.json`

## 启动

在仓库根目录运行：

```powershell
npm run dev
```

然后打开 <http://localhost:3000/evals/raw-hybrid>。

页面包含：

- K=1/3/5/10 的 Recall、Hit Rate、MRR、NDCG、Judged macro average；
- 以 query 为单位的分数分布；
- 可搜索、筛选、排序和展开的 query 明细；
- qrel、top-k chunk ID、排名分数和 metric reason；
- 数据集、embedding、corpus hash、运行耗时和指标定义 provenance。

这份报告只保存检索排名和 chunk 标识，不包含 corpus 正文，因此查看器不会假造文档内容。报告在构建时被规范化并作为静态数据传入页面；页面不提供上传、任意路径读取、写入或网络同步功能。

> ponytail: 当前 ceiling 是单个本地 JSON 报告和约数百条 query；若报告数量或体积继续增长，再升级为服务端报告 API、虚拟列表和多报告索引。
