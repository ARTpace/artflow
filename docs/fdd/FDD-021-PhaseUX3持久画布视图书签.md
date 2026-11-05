# FDD-021：Phase UX3 —— 持久画布视图书签

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R21
- **关联**：FDD-003 / ADR-003（Project Document v2）、FDD-019 / ADR-019（workspace UI）、FDD-020 / ADR-020（local canvas navigator）

## 1. 背景与目标

R20 给出了当前画布的可见 Navigator、click recenter 和 Fit canvas；但用户仍不能保存常用的相机位置，例如“封面”“参考区”“交付区”。每次需要回到某个区域仍要在 Navigator 上重新定位。这个能力应成为用户可看见、可保存的生产力功能，但不能把 camera bookmark 偷接到 SQLite/R12 saved query、generic storage 或 undo history。

本轮在 Canvas Navigator 中加入 **Views** 入口和 board-scoped **View Bookmarks** panel：用户可保存当前 pan/zoom 为有名字的 view，点击恢复、重命名或删除；它作为 Project Document v2 board 的 optional、backward-compatible metadata 随既有保存路径保存。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。它直接延伸刚交付的可见 navigator，解决反复定位同一空间区域的真实操作；比继续隐藏底层工作更符合用户反馈。
2. **已有能力**：复用 existing Board `panOffset` / `zoom`、R20 `CanvasNavigator` overlay、`updateActiveBoard`、R19 existing save flow，以及 Project Document v2 board metadata adapter。
3. **标准库**：仅使用 React state/input、existing `generateId` 与 TypeScript utility；不使用 router/state-store/modal dependency。
4. **平台特性**：不需要新的 Electron 或 browser API。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要稳定的 bookmark sanitization、legacy/v2 hydration、bounded name/count、persistence proof 和 panel interactions。
7. **最小实现**：增加 `CanvasViewBookmark` optional board metadata、pure normalizer、navigator `Views` entry 和一个 renderer panel；复用 normal save，不改 storage schema/API。

## 3. 范围

### 3.1 必须实现

- Canvas Navigator 显示 `Views` action；在 browser/Electron authoring canvas 中都可打开 board-scoped View Bookmarks panel。
- 用户可从当前 finite `panOffset` / `zoom` 保存一个 named view，点击某个 view 恢复它，重命名或删除它；这些动作只能更新 active Board metadata / camera，不创建 Element operation、不改变 elements/selection/parenting。
- 每 Board 最多 **12** 个 bookmark；name trim 后最大 **48** 个字符，空 name 获得 deterministic `View N` fallback；bookmark id 唯一，camera 坐标 finite，zoom clamp 在 existing **0.1–10** 范围。
- `Board` 和 `ProjectBoardRecord` 增加 `viewBookmarks`。`serializeProjectDocument` 持久化 sanitized metadata；legacy `Board[]`、旧 v2 document 缺该 field 或存在 malformed bookmark 时必须 hydrate 为 safe list（通常空 list），不升级 project version、不改 SQLite schema。
- panel 明确说明 bookmark 随 next ordinary project save 持久化；不承诺 autosave/cloud/sync。页面窄时仍可操作。
- foundation 覆盖 normalizer bound/trim/id/finite/zoom behavior、legacy/v2 serialize/hydrate preservation、camera action wiring、no IPC/capability count change；remote typecheck/build/full check 和 exact read-back 必须通过。

### 3.2 明确不做

- 不做 autosave、recent views、cross-board/global view、folder/workspace bookmarks、share/collaboration presence、animation/timeline、navigator drag/inertia、thumbnail snapshots。
- 不修改 `PROJECT_DOCUMENT_VERSION`、SQLite/project schema、main/preload/IPC、R11/R12/R13 query 或 storage ownership。
- 不将 bookmarks 写进 Element operation history、undo/redo、asset metadata 或 import job journal。

## 4. 语义契约

```ts
// Board-local, v2-compatible metadata. It is persisted only by the existing Save flow.
type CanvasViewBookmark = {
  id: string;
  name: string;
  panOffset: { x: number; y: number };
  zoom: number; // 0.1 <= zoom <= 10
};

updateActiveBoard(board => ({
  ...board,
  viewBookmarks: [...(board.viewBookmarks ?? []), bookmark].slice(0, 12),
}));

// Restoring a view updates only current camera fields.
updateActiveBoard(board => ({ ...board, panOffset: bookmark.panOffset, zoom: bookmark.zoom }));
```

- A saved view is camera metadata, not a scene snapshot. It does not freeze elements, guarantee a region still has content, or alter selection.
- View name and camera are sanitized at both renderer update and deserialize ingress. Invalid persisted data cannot make a board unusable.
- Bookmark edits become durable only when the user uses existing Save/Export. Browser JSON and Electron managed v2 project use the same adapter.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Navigator exposes visible Views entry; user can add, restore, rename and delete bounded named views on current board. |
| AC-2 | Bookmark metadata round-trips through v2 and safe legacy hydration; old projects without field remain valid, malformed values fail closed to safe bookmarks. |
| AC-3 | Restoring/editing views only changes camera/board metadata, never elements, operation history, R20 marker model or selection semantics. |
| AC-4 | No IPC/schema/dependency/R11/R12/R13 consumer change occurs; fixed capability count remains 13. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/doc read-back pass. |

## 6. 风险与回退

- A bookmark can point to a now-empty area after the user moves/deletes cards; it remains a truthful camera position rather than a broken persisted snapshot.
- Truncating to 12 is an explicit UX bound. Future user-configurable or cross-board view collections need a new FDD.
- An interrupted save can leave unsaved bookmark edits in memory, exactly like existing board camera/settings edits; no false autosave claim is made.

## 7. 完成边界

R21 is bounded, board-scoped camera metadata. A future FDD is required for view folders, cross-board/shared views, animated transitions, autosave/sync, scene snapshots, collaboration/presence or thumbnail-based navigation.


## 8. 已实现事实与验证（2026-09-22）

- `types.ts` 增加 `CanvasViewBookmark`，并为 `Board` / `ProjectBoardRecord` 增加 backward-compatible `viewBookmarks`；`createNewBoard` 初始化空列表。
- `utils/viewBookmarks.ts` 是唯一纯净化边界：最多 12 条、48 个 Unicode 字符、空名 deterministic `View N`、unique id、finite pan 和 0.1–10 zoom clamp。坏记录被跳过，不会阻断项目打开。
- `utils/projectDocument.ts` 在 serialize / v2 hydrate / legacy `Board[]` ingress 都调用 normalizer；Project Document 仍为 v2，沿用原有 Save/JSON path。
- R20 Navigator 现在有可见 `Views` action；`ViewBookmarksPanel` 可保存当前 camera、restore、rename、delete。restore 仅经 existing `updateActiveBoard` 写 active board `panOffset` / `zoom`；metadata action 不进入 `CanvasOperation`、elements、selection 或 import workflow。
- 远端验证已通过：`npm --prefix artflow run typecheck`、`npm --prefix artflow run check:foundations`、`npm --prefix artflow run check`（typecheck + production Vite build + foundations）均 exit 0。Foundation 额外覆盖 cap/name/id/finite/zoom、v2 round-trip、missing/malformed legacy/v2 data、App camera-only wiring 与 13 个 fixed capabilities 不变。
