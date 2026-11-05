# ADR-021：Board 视图书签的 v2 兼容持久化边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联**：ADR-003、ADR-011、ADR-019、ADR-020

## Context

Board 已持有 current camera (`panOffset` / `zoom`) 并由 Project Document v2 board record 持久化。R20 Navigator 证明 local camera navigation 可用，但没有可重访的 named locations。需要使 bookmarks 跨现有 save/load 生效，同时防止把 UI metadata 误实现成 storage table、R12 saved spatial query、Element undo operation 或 unbounded history。

## Decision

1. 引入 small `CanvasViewBookmark` value object，位于 Board 和 ProjectBoardRecord 的 `viewBookmarks` optional/normalized field；保持 `artflow-project` version **2**，不迁移 SQLite。
2. 通过 pure normalizer 在 create/edit/serialize/hydrate paths enforce id uniqueness、12-item cap、48-char trimmed name、finite point 和 0.1–10 zoom. Old/malformed values never throw the whole project load solely for bookmarks.
3. `ViewBookmarksPanel` 是 R20 Canvas Navigator 的 renderer overlay child surface。它调用 App-provided handlers；restore/write only uses existing `updateActiveBoard`.
4. Bookmark changes do not generate `CanvasOperation` and are durable only via existing ordinary project save / browser JSON export.
5. Bookmarks remain board-local. There is no generic “saved view” IPC, no repository index, no cross-board lookup and no cloud/sync semantics.

## Consequences

- 用户获得显式、可持久的 spatial shortcut，browser and managed project behavior stays uniform.
- Existing v2 data continues to read because field is optional; newly saved v2 includes safe normalized array.
- Corrupt bookmark entries may be discarded instead of compromising project open; this is appropriate for non-scene metadata.
- Because a view is only a camera position, it can point to empty/deleted content; UI must not promise a snapshot.

## Rejected alternatives

- **New SQLite table / schema version**：12 bounded UI values per board do not justify a storage-owner change.
- **Reuse R12/R13 saved viewport query**：bookmarks target live renderer camera and do not need persisted descriptor query.
- **Encode bookmark edits as CanvasOperation**：they are not Element mutations and must not pollute undo/redo.
- **Unbounded localStorage / generic settings**：would bypass project portability and existing save semantics.

## Revisit triggers

需要 cross-board/global bookmarks、folders/tags, scene thumbnails, transition animation, shared/presence views, autosave/sync or persistent view search 时，必须新建 FDD/ADR。


## Implementation evidence（2026-09-22）

- 实现落在 renderer/Project Document adapter：`utils/viewBookmarks.ts`、`components/ViewBookmarksPanel.tsx`、R20 `CanvasNavigator` 和 `App.tsx`；没有 main/preload、repository、SQLite migration、capability 或 dependency diff。
- `serializeProjectDocument` 与 hydrate 两端均输出/接收 normalized optional metadata，legacy array / old v2 absent-field / malformed records 都收敛为 safe list；document version 固定为 2。
- 所有 bookmark UI handler 委派现有 `updateActiveBoard`。restore 只写 camera，add/rename/delete 只写 active board metadata，不创建 CanvasOperation。
- Remote `typecheck`、`check:foundations` 与 full `check` 全部 exit 0；foundation 保留 13 个 fixed preload/main capability assertion。
