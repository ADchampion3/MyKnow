# 01 — Sprint 3 Wiki schema 与数据保留重建

**What to build:** 在不丢失原始资料、版本关系和审计链的前提下，将数据库重建为支持 Sprint 3 Wiki 的干净 schema，并让空数据库可以启动。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 空数据库启动后包含 Wiki 页面、版本、block、模板和引用所需的数据结构。
- [ ] 重建前校验原始存储对象的 SHA-256、字节数和路径。
- [ ] 重建后恢复资源、资源版本、当前版本指针和审计相关记录，并保留原 UUID 与时间关系。
- [ ] chunks、FTS、Wiki blocks 等派生数据可以重建，不删除原始存储。
- [ ] 重建失败不会破坏原数据库或原始资料存储。
- [ ] 有一个 focused check 能证明重建前后的资源、版本、指纹和审计记录一致。
