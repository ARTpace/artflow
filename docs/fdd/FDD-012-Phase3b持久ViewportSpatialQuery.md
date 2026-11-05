# FDD-012：Phase 3b 持久化 Viewport Spatial Query（snapshot R-tree）

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R12
- **关联**：FDD-011 / ADR-011（renderer-local cache），R4–R10（`ProjectRepository`、受限 Electron storage bridge）

## 1. 背景与目标

R11 已将 renderer 内 flat immutable list 的 viewport grid rebuild 降为 changed-entry update，但它只存在于当前 React board；不能为重开项目、未来 Worker/page API 或主进程受控 viewport 查询提供 durable source of truth。R4 已拥有项目私有 SQLite 与 managed v2 snapshot，却没有 `BoardNodeRecord` 的可查询空间投影。

本轮以最小可验证纵切建立 **已保存 snapshot 的持久 AABB R-tree 查询**：保存 managed v2 document 时，在同一个 SQLite transaction 内写入 snapshot 与 node AABB projection；fixed Electron capability 可按 board + world rect 读取一个有界、只含 layout descriptor 的 page。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。它是 R11 后冻结路线中的 persistent spatial query seam；不做它无法让 durable project 具备受控区域读取能力。
2. **已有能力**：复用 R4 `ProjectRepository`、R5 fixed IPC/preload、v2 `BoardNodeRecord` 和 R11 的 AABB 语义；不建第二套 SQLite 或 renderer filesystem path。
3. **标准库**：复用现有 `node:sqlite` `DatabaseSync`；远端实际 probe 已通过 `CREATE VIRTUAL TABLE ... USING rtree`。
4. **原生平台**：复用 Electron `contextBridge` / trusted-main-frame handler；不暴露 generic IPC。
5. **依赖**：不新增任何 npm dependency。
6. **一行方案**：不成立；schema migration、transactional projection、geometry validation 与 fixed capability 都是非平凡 correctness work。
7. **最小实现**：schema v5、save-time whole-snapshot projection rebuild、read-only bounded `queryViewport` page。没有 live mutation transaction、cursor、Worker 或 renderer migration。

## 3. 范围

### 3.1 必须实现

- `ProjectRepository` schema v5：同库增加 node spatial metadata 和 SQLite R-tree；无并行 database/path。
- `saveProjectDocument(document)` 在一个 transaction 内同时保存 JSON snapshot 与该 document 的 spatial projection；失败必须 rollback 二者。
- v4 project reopen migration 从已存 v2 snapshot 回填 spatial projection；无 document 的项目保持空 index。
- AABB projection 与当前 canvas 的 unrotated bounds 语义一致：普通 node 使用 `x/y/width/height`，path/arrow/line 使用 points，group 递归 union same-board direct children；rotation 仍不是本轮 hit-test 范围。
- invalid finite geometry、same-board duplicate node id、unknown board reference、group-parent cycle 必须拒绝保存/迁移，不能写 partial/stale index。
- repository / controller / `main.cjs` / `preload.cjs` / renderer type declaration 贯通一个 named `queryViewport({ boardId, rect, limit? })` fixed capability。
- 查询仅返回 board/node id、node type、parent id、z-index 与 canonical bounds；必须按 `zIndex, id` 稳定排序，bounded page 返回 `truncated`，不返回 properties、asset locator、filesystem path、SQL 或 raw bytes。
- R-tree candidate 必须经过 metadata exact-AABB filter；rect finite/nonnegative、boardId 和 limit 均验证。默认/最大 limit 必须有界。
- foundation 覆盖 v4→v5 backfill、save/query、cross-board isolation、edge intersection、point/path/group bounds、limit/truncated、invalid geometry/cycle rollback，以及 controller/preload/main fixed-channel boundary。

### 3.2 明确不做

- 不让 MainCanvas 在本轮消费 persistent query：未保存 React interaction state 比 durable snapshot 更新，直接替换 R11 cache 会产生 stale render。
- 不实现 cursor/tile cache/prefetch、incremental SQLite mutation、operation + document atomic transaction、multi-window coordination、Worker query service、R-tree hit-test/snap/lasso、rotation exact geometry、group incremental dependency graph、SQLite FTS/GC。
- 不改 R1/R11 renderer-local viewport index，亦不新增 persistent R-tree 的 renderer Node capability。

## 4. 接口契约

```ts
queryViewport({
  boardId: string,
  rect: { x: number; y: number; width: number; height: number },
  limit?: number,
}): Promise<{
  nodes: Array<{
    id: string;
    boardId: string;
    nodeType: string;
    parentId?: string;
    zIndex: number;
    bounds: { x: number; y: number; width: number; height: number };
  }>;
  truncated: boolean;
}>
```

- 区域相交为闭区间 AABB；边界接触算 candidate，与 existing viewport semantics 一致。
- `limit` 默认 500、最大 5000；`truncated` 表示后续需要未来 cursor/page FDD，调用者不得猜测完整结果。
- API 仅在 managed project open 且至少一次 save/backfill 后有数据；它读取最新持久 snapshot，而非 renderer 的未保存 state。

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | new schema v5 创建 metadata + R-tree；v4 reopen 可从 valid saved document 回填，snapshot 与 index 不分裂。 |
| AC-2 | save 后按 board/rect 精确返回 stable z/id ordered descriptors；R-tree candidate 的 metadata exact filter 保证边界语义。 |
| AC-3 | path/arrow/line、nested group union、empty group fallback 与 current unrotated bounds contract 对齐；invalid geometry/cycle/duplicate/unknown board reject 且旧 snapshot/query 保持可用。 |
| AC-4 | controller/main/preload/type declaration 仅新增 named query channel，trusted sender check 保留；不泄漏 generic IPC/path/SQL/raw bytes。 |
| AC-5 | foundation、typecheck、build、full `npm --prefix artflow run check` 和 source read-back 全部通过。 |

## 6. 风险与回退

- SQLite R-tree 使用浮点 candidate narrowing；metadata table 使用 canonical bounds 进行 exact SQL filter，且 R-tree rect 以安全 epsilon 外扩，避免将 candidate approximation 当最终命中。
- schema migration 读到无效旧 snapshot 时将拒绝 open，而不是静默留下空/陈旧 index；项目可由原 snapshot/backup 修复。
- 若 main-side page API 与 live renderer state 出现差异，以 R11 local cache 为 UI correctness authority；本轮 API 只作为 durable-query seam。

## 7. 完成边界

完成后 R12 只能被称为“save-time snapshot R-tree + bounded fixed query capability”。它不是 persistent incremental spatial service、not a live viewport renderer、not selection/snap spatial index，也不是 Hybrid renderer。


## 8. 实现与验证（2026-09-22）

- `storage/projectRepository.cjs` schema 已升至 v5：`board_node_spatial_metadata` 保存 canonical board/node AABB 与排序字段，SQLite `board_node_spatial_index` 仅承担 integer-key R-tree candidate narrowing。
- `saveProjectDocument` 先验证 managed v2 snapshot 和 spatial graph，再在同一个 `BEGIN IMMEDIATE` transaction 内更新 snapshot 与全量 projection；任何失败 rollback，旧 snapshot/index 不分裂。
- v4 reopen 会在 version update 同一 transaction 中从 existing managed v2 document backfill v5 projection；invalid stored snapshot fail closed，而不是无声创建 stale/empty index。
- `queryViewport` 经 metadata exact-AABB SQL filter、stable `zIndex/id` order 与 `limit + 1` 返回 `{ nodes, truncated }`。R-tree query rect 有 epsilon 外扩，最终命中仍以 canonical metadata bounds 为准。
- group snapshot bounds 递归 union same-board children；nested/empty group、path/arrow/line point bounds、cross-board isolation 都已可验证。rotation 继续按现有 unrotated AABB contract 处理。
- `ProjectStorageController`、trusted `main.cjs` handler、preload 和 `ArtflowStorageApi` 新增唯一 named `queryViewport` capability；controller 对 request 另加 4 KiB serialized cap，未暴露 SQL/path/raw bytes/generic IPC。

### 验证证据

- 远端 `npm --prefix artflow run check:foundations` exit 0：覆盖 v4→v5 backfill、group nested/empty、path/arrow/line、edge intersection、cross-board isolation、truncated、geometry/cycle/duplicate/unknown-board rejection 与 rollback、controller/type/preload/main fixed-channel boundary。
- 远端 `npm --prefix artflow run typecheck` exit 0。
- 远端 `npm --prefix artflow run check` exit 0（TypeScript、Vite production build、foundation）。构建仍报告既有 >500 kB chunk warning；并非本轮失败或空间 query 功能回归。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：schema v5 建立 R-tree projection；foundation 模拟 v4 saved document reopen 后 backfill 并确认 schema=5。 |
| AC-2 | 通过：save/query 按 board、闭区间 edge、metadata exact filter、stable order 和 `truncated` 返回 descriptor page。 |
| AC-3 | 通过：path/arrow/line、nested + empty group；non-finite geometry、cycle、duplicate id、unknown board 均 reject，旧 snapshot/query 保留。 |
| AC-4 | 通过：controller/main/preload/type declaration 只新增 named channel，foundation 静态确认 handler 先 trusted sender check。 |
| AC-5 | 通过：远端 foundation/typecheck/full check 全部 exit 0。 |

## 9. 完成边界 / 后续入口

R12 是 **save-time whole-snapshot R-tree projection**，不是 live renderer spatial index。MainCanvas 仍以 R11 cache 为未保存 interaction correctness authority；persistent query 没有 cursor/tile/prefetch、incremental operation mutation、Worker、多窗口、rotation exact hit-test、snap/lasso/selection consumer 或 Hybrid renderer。下一轮若要消费/扩展它，必须新建 FDD，先定义 snapshot freshness、cursor 和 transaction ownership。


> **后续关系（2026-09-22）**：FDD-013 已在不改变 R12 projection ownership 的前提下，supersede 本 FDD 的“无 cursor”完成边界：`queryViewport` 现有 revision-bound keyset cursor。R12 仍只描述 saved snapshot R-tree，不变为 live renderer service。
