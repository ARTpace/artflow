# ADR-013：持久 Viewport Keyset Cursor 与快照 Revision 边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-013

## Context

R12 的 descriptor page 使用 `limit + 1` 报告 `truncated`，但没有 continuation。offset 需要扫描/跳过先前 rows，在 R-tree 结果和稳定 order 下不必要；更严重的是 R12 save 可重建 projection，裸 `(zIndex,id)` cursor 无法证明下一页还属于同一 saved snapshot。

## Decision

1. schema v6 在 R12 同一 database 增加 singleton projection revision；successful snapshot + index write 在一个 write transaction 内 advance revision。
2. query 使用 read transaction 读取 revision 与 row page；`nextCursor` 包含 revision、board、canonical rect、last key。
3. 仅接受 keyset predicate `(z_index > after.zIndex) OR (z_index = after.zIndex AND node_id > after.id)`，SQL order 保持 `z_index ASC, node_id ASC`。
4. incoming cursor 必须在 repository 比对 revision、board 与 canonical rect；任一不匹配拒绝，不自动恢复或混合页面。
5. 不增 main/preload IPC channel，只演进既有 typed named `queryViewport` contract。

## Consequences

### Positive

- `truncated` 变成可实际消费的 continuation，且同一 cursor sequence 有 clear snapshot consistency rule。
- 无 offset cost；stable ordering 在 tie z-index 下仍可无重复枚举。
- R11 live cache 与 R12/R13 saved snapshot 查询保持明确 freshness separation。

### Negative / accepted limits

- 保存发生后调用者必须重新从第一页读取，不能继续旧 cursor。
- structured cursor 不是 signed opaque token，也不提供 multi-process snapshot lease。
- read transaction 仅保证一页内 consistency；不代表 Worker/page cache 或 live spatial service。

## Alternatives rejected

- **OFFSET/LIMIT**：大 page 越来越昂贵，且不表达 snapshot freshness。
- **无 revision 的 after cursor**：save 后可能跨 projection 混页。
- **新增 cursor IPC channel**：同一个 query contract 足够，增加 channel 无收益。
- **直接把 R13 接到 MainCanvas**：未保存 interaction state 会与 persisted revision 分离，违反 R11/R12 boundary。

## Revisit triggers

只有 consumer 真正需要 background prefetch、cross-process/multi-window cursor lease 或 live node mutations 时，才另建 FDD 引入 cursor cache/Worker/transaction coordinator。


## Implementation evidence（2026-09-22）

- v6 revision metadata、R-tree rebuild/validation seed and save-time advance 已落在 same R4 repository/database transaction boundary。
- `queryViewport` uses read transaction + R-tree/exact metadata filter + keyset predicate; old revision returns a fail-closed `ProjectStorageError` rather than mixed rows.
- types changed, but main/preload query channel remained singular and trusted; capability count is still 12.
- remote full `npm --prefix artflow run check` passed; R11 local cache remains the live renderer authority.
