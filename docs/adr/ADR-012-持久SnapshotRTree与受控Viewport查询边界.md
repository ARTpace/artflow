# ADR-012：持久 Snapshot R-tree 与受控 Viewport 查询边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-012

## Context

`ProjectRepository` 已是 project-private SQLite、managed snapshot、blob/job metadata 的唯一 owner。R11 的 `ViewportIndexCache` 只覆盖 live renderer flat list，不能安全代替 durable spatial store；group bounds 又依赖 child graph，不能把 R11 reference diff 直接搬进 SQLite。

## Decision

1. 将 storage schema 升至 v5，并在同一 `metadata.sqlite` 中保存 `board_node_spatial_metadata` 与 SQLite R-tree；R-tree 使用 internal integer id，metadata 持有 board/node identity、order、parent 和 canonical double AABB。
2. 仅在 `saveProjectDocument` 时从完整 v2 snapshot 重建 projection，snapshot write 与 delete/insert R-tree 在同一 SQLite transaction。v4 reopen 一次性 backfill。
3. `queryViewport` 用 R-tree 缩小候选，再以 metadata canonical AABB exact filter、stable `zIndex/id` sort 和 `limit + 1` 截断检测返回 descriptor page。
4. 通过现有 trusted main-frame IPC 扩展一个固定 channel；preload 只暴露 named `queryViewport` 方法。请求不接受 SQL、table、path 或 arbitrary projection field。
5. group bounds 在 save-time 使用 same-board parent/children graph 递归计算；任何 cycle、duplicate same-board node id、unknown board 或 non-finite geometry fail closed。

## Consequences

### Positive

- 数据库、snapshot 与空间投影有一个 owner、一条 transaction boundary；future worker/cursor API 有可验证的持久 seam。
- query result 没有 asset bytes/properties，保持 R5 security model。
- R11 local cache 不被 premature durable API 替换，避免 unsaved interaction stale render。

### Negative / accepted limits

- 每次 save 全量 rebuild projection，未解决 live high-frequency node mutation。
- 查询没有 cursor/prefetch，limit page 只提供 `truncated`。
- AABB 不处理 rotation；不提供 exact lasso/hit-test/snap。
- invalid legacy spatial data 会阻止 migration/open，优先 correctness over silent stale index。

## Alternatives rejected

- **Renderer persistent Map/R-tree**：不能跨 reopen，也会与 R11/group invalidation 重复 ownership。
- **立即让 MainCanvas 调用 IPC**：live board 尚未保存，durable result 会陈旧；还会让 camera hot path 跨 IPC。
- **新 SQLite database 或 Worker**：重复 R4 ownership，且超出最小 vertical slice。
- **以 node id 文本直接作 SQLite R-tree key**：R-tree key 是 integer；使用 internal id + metadata identity 更符合 native mechanism。

## Revisit triggers

只有在 operation pipeline 具备 transactionally persisted node mutation、query page 真实消费或 benchmark 显示 save-time rebuild 不足时，才以新 FDD 引入 incremental mutation、cursor/tile/Worker、group dependency graph 或 UI consumption。


## Implementation evidence（2026-09-22）

- schema v5 的 metadata + R-tree 落在 R4 `metadata.sqlite`，save snapshot 与 projection 使用同一 `BEGIN IMMEDIATE` transaction；v4 reopen backfill 已由 foundation proof。
- `queryViewport` 的 R-tree candidate 不直接作为 answer：canonical metadata exact-AABB filter、stable order 和 bounded truncation 保持 correctness/security contract。
- 12th fixed renderer capability 只暴露 descriptor query；`main.cjs` 保留 trusted-main-frame check，preload 不泄漏 `ipcRenderer`。
- 完整远端 `npm --prefix artflow run check` 已通过。R11 没有被替换，MainCanvas 没有新增 IPC camera hot path。


> **后续关系（2026-09-22）**：ADR-013 已以 v6 revision-bound keyset cursor 补足 R12 的 `truncated` continuation；R12 的 database owner、exact-AABB filter、fixed capability 与 live-state separation 保持不变。
