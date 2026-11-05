# FDD-019：Phase UX1 —— 可见工作区状态与项目中心

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R19
- **关联**：FDD-005 / ADR-005（受限 Electron storage UI）、FDD-018 / ADR-018（managed-only durable import jobs）

## 1. 背景与目标

用户反馈此前多轮存储与恢复改动在当前画布 UI 中几乎不可感知。这个反馈成立：R18 的 Import Jobs 是刻意仅在 **Electron managed project 已打开**时显示；普通浏览器 / File System Access / JSON fallback 不会出现它，以免伪造 durable job capability。因此用户从默认画布进入时无法一眼知道当前是 browser workspace、是否已打开项目、保存会写到哪里，以及为什么 Import Jobs 不出现。

本轮交付一个始终可见的 **Workspace status dock** 和可打开的 **Project Workspace panel**。它将现有 App 状态转成用户可理解的工作区、存储模式、画板/卡片统计和现有 open/save/import-jobs 入口；不制造假任务，不改变 storage ownership。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。用户明确看不到先前改变；应优先补可见、诚实的产品 surface，而不是继续添加隐藏 infrastructure。
2. **已有能力**：复用 `App.tsx` 的 boards/elements/frames/selection、`useFileSystem` 的 open/save/project name/runtime capability，以及已验证的 R18 `ImportJobsPanel` action。
3. **标准库**：使用 React `useMemo` / state 和现有 SVG/utility classes，不新增状态库。
4. **平台特性**：不需要新的 Electron、filesystem 或 IPC feature；仅显示现有 renderer state。
5. **依赖**：不新增 npm dependency。
6. **一行方案**：不成立。要确保 browser 与 managed 模式的文案、真实 action、统计和 R18 conditional boundary 一致，需要一个最小 panel/dock 接口。
7. **最小实现**：新增一个纯 renderer `ProjectWorkspacePanel.tsx`（dock + panel），App 传入已存在的状态/handlers；hook 只暴露 already-detectable managed-runtime boolean。

## 3. 范围

### 3.1 必须实现

- 在非 presentation 画布上始终显示可点击的 `Workspace` status dock；它明确展示 Browser workspace 或 Desktop managed storage、项目/untitled label、画板数量，并在保存时显示真实 saving state。
- 打开 Workspace panel 后显示来自当前 React state 的：当前项目名、storage mode、open state、active board、总 board/card/asset-linked-card 数、当前 board card/frame/selection 数和 activity text。
- panel 的 Open 与 Save/Export 操作只复用 `App` 已有 handler；浏览器模式要明确为 JSON / browser-folder fallback，managed 模式要明确为 project-private desktop storage。不可声称 cloud sync 或自动保存。
- 仅当 existing R18 `isManagedImportJobsAvailable` 为 true 时显示 `Open import jobs` action；它只打开 existing panel / refresh，不能在 browser mode 显示 job affordance、读取 job list 或伪造 job status。
- `useFileSystem` 可单独暴露 runtime-level `isManagedProjectStorageAvailable`，使 UI 在尚未选择项目时也可诚实地显示 desktop managed storage capability；R18 job availability 的更严格 open-project 条件不变。
- 文案和 panel 需有 accessible label/button labels，并保持窄 viewport 可用。
- foundation 至少覆盖 renderer-only dock/panel wiring、managed/browser copy and conditional import action、no extra IPC/capability count change；remote typecheck/build/full check 和 exact read-back 必须通过。

### 3.2 明确不做

- 不新增 preload/main IPC、database/schema、storage metadata、recent-project history、cloud/sync、autosave、project creation wizard、analytics 或 telemetry。
- 不改变 R18 25-summary bound、polling/cancel semantics 或在 browser fallback 显示 durable jobs。
- 不实现 retry/batch parser/thumbnail worker、document+job transaction、GC、streaming 或 multi-window ownership。
- 不重写 BoardPanel、Toolbar、Canvas interaction 或 format handler flows。

## 4. 语义契约

```ts
// Renderer-only presentation; no storage records cross a new boundary.
<WorkspaceStatusDock
  storageMode={managedRuntime ? 'managed' : 'browser'}
  projectName={projectFolderName}
  boardCount={boards.length}
  isSaving={isSavingProject}
  onOpen={() => setIsWorkspacePanelOpen(true)}
/>

// R18 remains the only durable-job surface and remains conditional.
{isManagedImportJobsAvailable && <button onClick={openExistingImportJobs}>Open import jobs</button>}
```

- A Browser workspace may be untitled; its panel must say that saving uses existing browser-folder / JSON download behavior, not persistent Electron jobs.
- A Desktop managed workspace can be shown before a folder is selected, but it must not claim a project is open until `projectFolderName` / existing open state says so.
- Counts are presentation metrics of current React `Board[]`; `asset-linked cards` means placements that have `assetId`, not a unique repository asset count.
- Activity is local UI state only. It is not a durable save receipt or a cross-process synchronization signal.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Default browser and Electron canvas both visibly show a Workspace status dock; it reports the correct storage mode and never needs privileged data. |
| AC-2 | Workspace panel exposes accurate current React-state counts, active board and open/save actions; Save label/copy distinguishes browser export from managed project save. |
| AC-3 | Managed runtime with an open project can enter existing R18 Import Jobs from the panel; browser mode has no Import Jobs action or durable-job list. |
| AC-4 | No Electron channel/API/schema/dependency changes occur; fixed capability count remains 13 and R18 contracts are unchanged. |
| AC-5 | Foundation, remote typecheck, production build/full check and exact source/doc read-back pass. |

## 6. 风险与回退

- Counts can change as the current canvas changes; that is desired renderer-state presentation, not a saved snapshot assertion.
- `saveProject` still owns folder selection/fallback behavior; the panel delegates rather than duplicating that logic.
- If the user closes the panel, the dock remains as the visible, compact route back to the same information.

## 7. 实现与验证证据（2026-09-22）

### 7.1 实现

- 新增 `components/ProjectWorkspacePanel.tsx`：`WorkspaceStatusDock` 在 every-runtime、non-presentation canvas 的左下持续可见；它显示 `Browser workspace` 或 `Desktop managed storage`、项目/untitled name、board count 和 saving pulse。点击后打开 `ProjectWorkspacePanel`。
- panel 只接收 App 的 scalar React state：project/open state、active board、all-board canvas-card / asset-linked-card count、current-board cards/frames、selection、activity 和 existing callbacks。asset-linked 指有 `assetId` 的 placement，文案明确不是 repository-wide inventory。
- `App.tsx` 以 `useMemo` 计算这些 current-canvas metrics；打开、保存、managed import progress、失败和取消都映射为本地 truthful activity text。`saveProject` 现在返回 boolean outcome，因此 project/folder chooser cancellation 显示 cancelled，不会误报 saved。
- `useFileSystem` 暴露现有 runtime detection 的 `isManagedProjectStorageAvailable`，同时保留 R18 更严格的 `isManagedImportJobsAvailable`。只有后者为 true 时 panel 显示 existing `Open import jobs` action；该 action 复用 R18 refresh/panel，browser panel 不包含 job list、cancel 或 bridge call。
- 没有修改 `main.cjs`、`preload.cjs`、schema、repository、IPC 或依赖。fixed capability 仍为 **13**。

### 7.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 / AC-2 | 通过：production build 纳入新增 dock/panel；foundation 静态验证 `WorkspaceStatusDock`、`ProjectWorkspacePanel`、browser/managed mode copy、App scalar wiring、save outcome 和 browser/managed storage-mode selection。 |
| AC-3 | 通过：foundation 验证 panel source 只在 `canOpenImportJobs` 条件下呈现 action，App 传入 existing `isManagedImportJobsAvailable`；panel 不含 `listImportJobs` / `artflowStorage` / request/get/cancel bridge symbols。 |
| AC-4 | 通过：foundation 继续验证 main/preload fixed capability count 均为 13、R18 trusted bridge 和 no generic IPC；本轮没有 main/preload/types/schema dependency 变更。 |
| AC-5 | 通过：remote `npm --prefix artflow run typecheck`、`check:foundations` 和 full `check` 均 exit 0；final R19 source/governance exact read-back matched。Vite production build 处理 2,088 modules；仅保留既有 >500 kB chunk warning 与 Node SQLite ExperimentalWarning。 |

## 8. 完成边界

R19 is a visibility and truthful-navigation slice. A future FDD is required for recent projects, persistent workspace preferences, autosave/sync status, unbounded asset inventory, cloud collaboration or changing durable import behavior.
