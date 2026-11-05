# FDD-013：Phase 3c 快照一致的 Viewport Keyset Cursor

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R13
- **关联**：FDD-012 / ADR-012（saved-snapshot R-tree）、R11（live renderer cache）

## 1. 背景与目标

R12 已能对 saved v2 snapshot 执行有界 `queryViewport`，但 `truncated: true` 没有 continuation；超过 limit 的区域无法完整、稳定地读取。简单 offset pagination 不适合 R-tree candidate + `zIndex/id` 稳定排序，也无法识别 query 期间 snapshot 已被保存更新。

本轮为**同一份 saved snapshot**提供 keyset cursor continuation：页面携带 persisted spatial revision，后续 cursor 必须绑定相同 board、canonical rect 和 revision；若 save 发生，旧 cursor fail closed，而不是返回混合 snapshot 的重复/遗漏 page。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。R12 已返回 `truncated`，却不能取得余页；没有 continuation 时 durable large-viewport API 不完整。
2. **已有能力**：复用 R12 metadata/R-tree、stable `zIndex,id` ordering、single `queryViewport` fixed capability 和 v5 snapshot transaction；不新建 query service。
3. **标准库**：复用已核验的 `node:sqlite` transaction/prepared statement；不增加数据库或 npm package。
4. **原生平台**：不增加 Electron channel，直接演进既有 typed `queryViewport` request/result。
5. **依赖**：无新依赖。
6. **一行方案**：不成立。仅增加 `after` 会在 save 后产生跨 snapshot 页；需要 persisted revision、migration、query-snapshot read transaction 和 keyset validation。
7. **最小实现**：schema v6 projection revision table、keyset predicate、structured cursor + stale fail-closed；不做 opaque signing、cursor store、Worker、UI consumer 或 live mutation。

## 3. 范围

### 3.1 必须实现

- schema v6 在现有 `metadata.sqlite` 中加入 singleton spatial projection revision metadata；不能另建 database/path。
- 每次 successful `saveProjectDocument` 在 snapshot + R-tree projection 同一 write transaction 中递增 revision；rollback 不得推进 revision。
- v5 reopen 在 migration transaction 中从 saved v2 snapshot 重建/验证 projection 并 seed revision；v4 及更早 path 同样先 backfill 后 seed。
- `queryViewport` 使用 read transaction，初页返回 `snapshotRevision`；有余页时返回 `nextCursor`，无余页为 `null`。
- cursor 至少绑定 `snapshotRevision`、`boardId`、canonical rect、last `(zIndex,id)`；后续 query 以 keyset predicate，而不是 offset。
- cursor 与当前 revision/board/rect 不匹配、malformed cursor、无效 z-index/id 必须 fail closed；同 query 可调整 page limit，但不得混用 snapshot。
- 保留 R12 canonical metadata exact-AABB filter、R-tree epsilon candidate narrowing、stable `zIndex,id` sort、descriptor-only result 与现有 4 KiB request cap。
- TypeScript API 更新但不新增 `main.cjs`/preload channel；fixed capability 总数仍为 12。
- foundation 覆盖 deterministic multi-page union/no duplicate/tie z-index、end-of-page null、v5→v6 seed、legacy backfill regression、save 后 stale cursor、rect/board/malformed cursor rejection、rollback revision stability 和 source channel boundary。

### 3.2 明确不做

- 不实现 cursor token signing/server-side cursor store、cross-process snapshot lease、offset pagination、cursor-based live MainCanvas render、Worker/page prefetch、tile cache、operation-level incremental projection、rotation hit-test、selection/snap/lasso 或 Hybrid renderer。
- 不改变 R11 local cache 的 live state ownership，也不增加 generic IPC/filesystem/SQL exposure。

## 4. API 契约

```ts
queryViewport({
  boardId,
  rect,
  limit?,
  cursor?: {
    snapshotRevision,
    boardId,
    rect,
    after: { zIndex, id },
  },
}): Promise<{
  nodes: PersistentViewportNode[];
  truncated: boolean;
  snapshotRevision: number;
  nextCursor: PersistentViewportCursor | null;
}>
```

- 初次请求没有 cursor；`nextCursor` 只能原样用于同 board、同 canonical rect 的下一页。
- `truncated === true` 必有 `nextCursor`；`truncated === false` 时 `nextCursor === null`。
- revision 不相等表示 snapshot 已变，调用方必须从初页重新开始；这是 expected control-flow error，不是自动补页。
- keyset order 为 ascending `zIndex, id`；不同 page limit 允许，但 offset 一律不存在。

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | v6 revision 与 document/index 同 transaction 推进；v5 project seed、legacy v4 backfill 不回归。 |
| AC-2 | 同 snapshot 多页 keyset union 与未分页结果相同、无重复、tie z-index 排序稳定；末页 null cursor。 |
| AC-3 | save 后旧 cursor、board/rect mismatch、malformed cursor 均拒绝；failed save 不改变 revision/page continuity。 |
| AC-4 | R12 exact bounds/filter/security cap 保留；typed API 可编译，main/preload 没有新增 channel，capability count 保持 12。 |
| AC-5 | foundation、typecheck、production build、full remote check、source read-back 通过。 |

## 6. 风险与回退

- cursor 不是权限凭证；它是已验证的 continuation state，仍经 trusted named IPC、request size cap 和 repository validation。
- read transaction 将单页 revision 与 rows 绑定为同一 SQLite snapshot；R12 的 single-project ownership 不宣称 multi-process lease。
- 若 snapshot 刷新频繁，stale cursor 是正确结果；future FDD 可设计 snapshot lease/cursor cache，而不是暗中放宽 freshness。

## 7. 完成边界

R13 只能被称为“saved snapshot 的 revision-bound keyset cursor”。它不解决 UI 实时加载、live mutation、Worker、无限 scroll、cursor cache 或 10k DOM rendering。


## 8. 实现与验证（2026-09-22）

- `ProjectRepository` schema 已升至 v6；same `metadata.sqlite` 新增 singleton `spatial_projection_metadata` revision，未新建 database、path、IPC channel 或 renderer capability。
- successful `saveProjectDocument` 在既有 snapshot + R-tree projection write transaction 中最后 advance revision；失败 rollback 不推进 revision。
- schema v5→v6 在 migration transaction 内由 saved v2 snapshot 重建/验证 projection 并 seed revision；v4→v6 仍保留 R12 spatial backfill，再 seed revision。
- `queryViewport` 现在在 SQLite read transaction 内读取 revision 和 rows。初页返回 `snapshotRevision`；`truncated` 时返回 structured `nextCursor`；后续页用 `zIndex,id` keyset predicate，不使用 offset。
- incoming cursor 要求 revision、board、canonical rect 和 `after` 全部有效；save 后旧 cursor 明确报 stale，调用方必须从第一页重新开始。page limit 可改变，仍不会跨 snapshot 混页。
- `PersistentViewportQuery/Page` 已补齐 cursor/revision types；`main.cjs` 和 preload 无新增 channel，fixed capability 总数保持 12，R11 MainCanvas 未新增 IPC hot path。

### 验证证据

- 远端 `npm --prefix artflow run check:foundations` exit 0：覆盖 10-node spatial fixture 的多页 union、tie z-index stable order、no duplicate、末页 null cursor、v5→v6 seed、v4 backfill regression、board/rect/malformed/stale cursor reject、failed save revision stability、R12 bounds/group/path/arrow/line/security boundary。
- 远端 `npm --prefix artflow run typecheck` exit 0。
- 远端 `npm --prefix artflow run check` exit 0（TypeScript、Vite production build、foundation）。既有 >500 kB bundle warning 与 Node `node:sqlite` ExperimentalWarning 仍存在，均非本轮 failure。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：schema v6 revision 与 save projection 同 transaction；foundation 覆盖 v5 seed 与 v4 backfill。 |
| AC-2 | 通过：keyset 多页合并与 full page 一致，tie z-index 以 id stable order，无重复，末页 cursor 为 null。 |
| AC-3 | 通过：save 后 cursor stale；board/rect/malformed cursor reject；rejected save 保留 revision 和 continuation。 |
| AC-4 | 通过：R12 exact AABB/filter/request cap 保留，type API 编译；static foundation 确认 main/preload query channel 仍各一个。 |
| AC-5 | 通过：远端 foundation/typecheck/full check 全部 exit 0。 |

## 9. 完成边界 / 后续入口

R13 是 **saved-snapshot revision-bound keyset cursor**，不是 live data subscription 或 infinite-scroll UI。它不提供 signed token、cursor store/lease、Worker prefetch、tile cache、operation-level mutation、多窗口 consistency、MainCanvas consumer、selection/snap/lasso or Hybrid renderer。下一步若继续空间路线，必须以新 FDD 定义 live mutation/cursor cache/Worker 的 ownership 和 freshness，而不能绕过 R11/R12/R13 边界。
