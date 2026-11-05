# FDD-023：Phase UX5 —— 项目变更感知与保存状态

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R23
- **关联**：FDD-003 / ADR-003（Project Document v2）、FDD-019 / ADR-019（workspace visibility / truthful save outcome）、FDD-021 / ADR-021（ordinary project save persistence）

## 1. 背景与目标

R19 让用户能看见 workspace 与现有 Save action，R21 明确 view bookmarks 只有在 ordinary Save 后才持久化；但正常使用中，用户仍无法从 UI 判断当前 board/camera/bookmark/content 的改动是否已经进入最近一次成功保存。对一个带 browser fallback 与 managed project 的画布应用，这会让“已保存 / 仍需保存”成为不可见风险。

本轮在 visible Workspace dock 和 Project Workspace panel 中加入 **save-change awareness**：显示 New workspace、Unsaved changes、Saving project 或 No changes since last save or load。它只追踪 existing immutable `Board[]` reference 在成功 save / successful nonempty load baseline 之后的变更，不重新实现 serializer、picker 或 storage。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。它让用户知道当前 canvas、camera 和 R21 bookmark metadata 是否仍需普通 Save，补足可见 workflow 的保存反馈。
2. **已有能力**：复用 `useCanvasState` immutable `Board[]`、App existing open/save handlers、R19 WorkspaceStatusDock / ProjectWorkspacePanel、`saveProject` truthful boolean outcome 和 `loadBoardData` ingress。
3. **标准库**：仅 React state/ref/effect 与一个 pure reference-baseline reducer；不引入 state store、route、diff library 或 browser storage。
4. **平台特性**：不需要新的 Electron/browser API。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要明确 baseline、load/save race、cancel/error 保留 dirty state、fresh workspace copy 以及 dock/panel 一致 surface。
7. **最小实现**：增加 pure project-change tracker，`loadBoardData` return status，App reference-baseline orchestration，R19 workspace dock/panel scalar props；不触碰 save implementation。

## 3. 范围

### 3.1 必须实现

- normal browser/Electron authoring UI 的 visible Workspace dock 和 Project Workspace panel 都显示以下之一：New workspace、Unsaved changes、Saving project、No changes since last save。
- Tracker 以 existing immutable `Board[]` reference 为信号：initial/new workspace clean；successful **nonempty** project load accepts loaded Board[] as baseline；Board[] 之后改变则 dirty。
- Existing `saveProject(boards)` return true only clears dirty when the exact saved Board[] is still current upon completion；save cancelled / error / later board change 保持或恢复 dirty。成功 save / load 标记 session baseline；不宣称 disk sync、autosave、transactional close safety 或 generic unsaved-change protection。
- Camera pan/zoom、R21 view bookmark metadata、elements/history/board changes 都走 Board[] 时被同一 tracker 正确反映；selection、panel/query/filter/open state 不应触发 dirty。
- `useCanvasState.loadBoardData` returns whether a nonempty normalized Board[] was actually applied，供 App 不把 empty/rejected load 误记为 clean baseline。
- Foundation 覆盖 pure baseline/dirty/save-race/load state transition、App open/save wiring、dock/panel copy、no serializer/IPC/capability/storage expansion；remote typecheck/full check/exact read-back 必须通过。

### 3.2 明确不做

- 不做 autosave、periodic save、beforeunload/native close confirmation、crash recovery、file watcher、cross-window conflict、cloud/sync receipt、revision hash、deep JSON diff 或 persistent dirty marker。
- 不修改 `serializeProjectDocument` / `saveProject` internals、Project Document version、SQLite/schema、main/preload/IPC、R11/R12/R13 consumer、operation history、dependency 或 generic settings。
- 不把 selection、Finder query/filter、panel visibility、theme/API settings误表示成 project Board save state。

## 4. 语义契约

```ts
const baseline = createProjectChangeState(boards);
const dirty = observeProjectBoards(baseline, nextBoards).isDirty;

// Only a successful save of still-current boards clears the UI signal.
const next = completeProjectSave(state, boardsAtSaveStart, latestBoards);

// A nonempty successful load establishes a new in-memory baseline.
const loaded = acceptLoadedProjectBoards(normalizedBoards);
```

- “No changes since last save” is an in-memory reference-baseline status, not a filesystem durability audit.
- `saveProject` keeps ownership of serialization, picker/fallback and managed import materialization. The tracker consumes only its existing boolean outcome.
- The UI remains truthful in browser fallback: a returned success is a completed existing export/save path; no durability/sync guarantee is added.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Workspace dock and Project Workspace panel visibly distinguish fresh, dirty, saving and clean-after-baseline states. |
| AC-2 | Nonempty load accepts a baseline; Board[] change becomes dirty; failed/cancelled save does not clear it; a stale save completion cannot erase a later change. |
| AC-3 | Tracker observes Board[] only; selection/panel state does not become dirty and no Board/Element/history semantics are modified solely for status. |
| AC-4 | No serializer/save-path implementation, IPC/schema/dependency/R11/R12/R13 consumer/capability change occurs. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/doc read-back pass. |

## 6. 风险与回退

- Reference tracking relies on the existing immutable Board update contract; it is intentionally not a deep document diff or disk verification service.
- If the user changes a board during an asynchronous save, the stale-completion guard leaves the UI dirty instead of falsely claiming clean.
- UI state is session-only; reload resets it to New workspace until a nonempty load or successful save establishes a baseline.

## 7. 完成边界

R23 is session-local, reference-based save awareness. A future FDD is required for autosave, close prompts, crash recovery, deep fingerprints/revisions, cross-window conflicts, filesystem watchers, cloud sync or persistent workspace dirty metadata.


## 8. 已实现事实与验证（2026-09-22）

- `utils/projectChangeTracker.ts` 是 pure reference-baseline reducer：initial/load baseline clean、immutable Board[] reference change dirty，且只有 saved snapshot 仍是 current Board[] 时才清除 dirty；后续 edit 不会被 stale save completion 误清除。
- `hooks/useCanvasState.ts` 的 `loadBoardData` 现在返回 boolean，只有 nonempty normalized Board[] 真正应用时才返回 true；它不改变 deserialize、Board state 或 operation semantics。
- `App.tsx` 围绕 existing `openProjectFolder` / `loadBoardData` / `saveProject` 添加 session refs；existing `saveProject` implementation、serializer、picker/fallback 与 managed materialization 完全不变。save cancel/error 不清除状态。
- R19 `WorkspaceStatusDock` 与 `ProjectWorkspacePanel` 现在共同显示 New workspace、Unsaved changes、Saving project 或 No changes since last save or load，并明确说明它是 session-local Board signal，非 autosave / disk audit。
- 远端验证已通过：`npm --prefix artflow run typecheck`、`npm --prefix artflow run check:foundations`、`npm --prefix artflow run check`（typecheck + production Vite build + foundations）均 exit 0。Foundation 额外覆盖 baseline/dirty/load/stale-save transition、App open/save wiring、UI copy、unchanged save ownership 与 13 个 fixed capabilities。
