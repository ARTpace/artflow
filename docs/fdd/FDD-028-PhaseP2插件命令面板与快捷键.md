# FDD-028：Phase P2 —— 插件命令面板与受控快捷键

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R28
- **关联**：插件系统设计 §11（P2 commands）、插件化迁移清单 P2、FDD-025（generic PanelHost）、FDD-020 / FDD-022（Navigator / Finder）

## 1. 背景与目标

R25 已证明 trusted builtin 可以通过 `ui_panels` 在正常 UI 路径中提供可见功能；R26/R27 又证明格式业务可以留在插件内。然而，现有画布常用动作仍散落在 Navigator、Extensions、按钮和各自的事件监听器中，插件没有一个统一、可搜索、可快捷触发的命令入口。

R28 交付一个用户能直接发现的纵切：点击 TopBar 的命令按钮或按 `Ctrl+K` / `⌘K`，打开 **Command Palette**；用户可搜索并执行由启用插件贡献的工作区命令。首个 `builtin.commands-workspace` 用该通道暴露 Fit canvas、Find on canvas、Saved views 和 Extensions。命令定义、默认快捷键和动作归属插件；本体只拥有 generic registry、palette、keyboard dispatch 与受控 host service。

## 2. Ponytail 七步决策

1. **需要性**：需要。用户已可直接使用 Navigator/Finder/Extensions，但入口分散；P2 command contribution 是既有插件路线的下一项冻结能力，也能让用户立即通过一个快捷入口发现这些工作流。
2. **现有能力**：`Kernel` 已有 `commands` slot、manifest 已有 `command` capability、贡献 registry 已有稳定 priority/id 排序；R25 有 generic overlay host，R20/R22 有现成的 camera/Finder 工作流。因此不新增 IPC、存储、依赖或新的 canvas data model。
3. **先用现有能力**：保留 `useKeyboardShortcuts` 中已有 undo/redo/copy/delete/presentation hotkeys，R28 不重写它们。只为新命令 surface 增加 typed contract、generic palette 和 scoped key dispatcher；首个 builtin 调用 App 提供的现有动作。
4. **平台特性**：renderer 的 `KeyboardEvent`、React state/effects、既有 Tailwind/CSS；无 Electron/main/preload/IPC、无 Worker、无网络。
5. **依赖**：不新增 npm dependency。
6. **一行方案**：不成立。必须定义可排序/可卸载的命令 contract、统一搜索/执行路径、避免 editable/presentation 场景抢键，并通过 mediated service 让 plugin action 不直接 import App。
7. **最小实现**：一个 `commands` typed adapter、一个 generic `CommandPalette`、一个 host-reserved `Ctrl/⌘K` opener、一个 trusted builtin workspace command plugin、四个现有 UI/camera action；不做用户绑定、菜单/toolbar 贡献、命令参数、macro、第三方插件或快捷键设置页。

## 3. 用户路径

1. 用户点击 TopBar 的命令按钮，或在非输入、非演示状态按 `Ctrl+K` / `⌘K`。
2. generic palette 显示当前 plugin profile 的命令，支持大小写无关的 title / description / keyword 搜索，并显示默认快捷键。
3. 用户点击项目或按 Enter 执行。首个 builtin 命令可 fit 当前画布、打开 Canvas Finder、打开 Saved Views 或打开 Extensions。
4. 可用的 `Alt+Shift+F/K/V/E` 默认快捷键在非 editable、非演示状态直接执行同一命令；Esc 关闭 palette。
5. action 使用 existing camera/UI state；不会写 board element、Project Document、SQLite、profile 或 user settings。

## 4. 冻结接口与职责

| 层 | 允许职责 | 禁止职责 |
|---|---|---|
| `plugins/commands.ts` | typed `CommandContribution`、stable list/search/shortcut resolution、enabled/invoke pure adapter | 具体 workspace action、React JSX、plugin id 判断 |
| `plugins/command-palette.tsx` | generic overlay、search/list/keyboard dispatch、error presentation | builtin command title/id/action、直接 import App 或 Navigator/Finder business |
| App | 只提供 explicit `workspace.command-actions` mediated service；桥接现有 fit/Finder/views/extensions callbacks；打开 generic palette | 注册 builtin command、解析 command ids、添加 plugin-specific JSX/shortcut case |
| `builtin/commands-workspace` | four command contributions、title/description/keywords/default shortcuts、调用 mediated service | 修改 App、直接 import canvas/UI sibling component、存储/IPC |

### 4.1 Command contract

- contribution uses existing `commands` slot and normal `ContributionRegistry` priority + id stable ordering;
- each command has a global contribution id, title, optional description/group/keywords/default shortcut, `isEnabled(kernel)` and `run(kernel)`;
- matching shortcut selection uses the registry's first ordered command. A disabled winning command does **not** fall through to a lower-priority claimant; palette leaves it visibly disabled. User remapping/conflict policy is a later P4 concern.
- `Ctrl/⌘K` is a generic host-reserved palette opener, not an implicit plugin command. `Alt+Shift+F/K/V/E` are the initial builtin defaults.

### 4.2 Mediated host service

`workspace.command-actions` exposes only these current-renderer operations: `fitCanvas`, `canFitCanvas`, `openCanvasFinder`, `openSavedViews`, `openExtensions`, `canOpenExtensions`. It is a renderer-local live callback proxy, not a new public IPC capability. The plugin gets it only at command invocation via `kernel.use`; no plugin imports App or other UI implementation.

## 5. Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-1 | TopBar button and `Ctrl/⌘K` open a usable generic Command Palette; it searches current contributions, supports mouse/Enter execution and Esc close. |
| AC-2 | `builtin.commands-workspace` supplies the four visible existing-workspace actions; each is reachable in palette, and its stated default shortcut triggers the same action when allowed. |
| AC-3 | Typed registry gives deterministic list/search/shortcut resolution, enabled handling, duplicate registry protection and full plugin disposal behavior. Input/contenteditable/IME/presentation states do not accidentally execute command shortcuts. |
| AC-4 | Host files do not contain builtin command ids/titles/action business; plugin does not import App/Navigator/Finder/TopBar. It uses only the mediated service at invocation. |
| AC-5 | No npm dependency, Project Document/schema, operation semantics, storage/IPC/preload capability or plugin profile behavior changes. Foundation fixture, remote typecheck, production full check and exact read-back pass. |

## 6. Validation plan

1. Pure command contract fixture: ordered listing, search, exact modifier matching, priority collision, disabled winner, invoke behavior and duplicate protection.
2. Real builtin lifecycle fixture: provide mock `workspace.command-actions`, load `builtin.commands-workspace`, invoke each action, dispose plugin and verify commands disappear.
3. Static boundary fixture: manifest capability, generic host source does not contain builtin workspace id/title/action terms, plugin source does not import App/UI sibling modules, App only references generic service contract and palette host.
4. Run remote `npm --prefix artflow run typecheck`, `check:foundations`, and full `check`; read back all changed source/governance files and package manifests to prove no dependency change.

## 7. Non-goals / rejected scope

- No migration of existing undo/redo/copy/delete/presentation shortcuts; their legacy behavior stays untouched.
- No user configurable bindings, keybinding conflict settings, command macros, parameter prompts, recent-command history, command telemetry or persistence.
- No `ui_toolbar`/`ui_menus`/`canvas_tools` implementation yet; their future consumers may reuse this contract but are separate FDDs.
- No external/restricted plugin loading, profile mutation, App-owned plugin business, IPC/preload/main process, schema/document/storage change.
- No Finder semantic/global search or Navigator feature expansion; commands only expose their existing bounded UI actions.

## 8. Remaining boundary

R28 is the first command surface, not the whole P2 migration. Toolbar/menu contributions, canvas tool control lending, node actions/card slots, binding customization and P4 external plugin policy remain separately scoped.


## 9. R28 实施与验证记录（verified）

- Added generic `plugins/commands.ts`, `plugins/command-palette.tsx` and the narrow `workspace.command-actions` renderer service. The Palette has no builtin command ids, titles or workspace UI imports; it consumes only ordered command contributions.
- Added trusted `builtin/commands-workspace` through the normal manifest/loader path. It contributes Fit canvas, Find on canvas, Saved views and Extensions; labels, keywords, exact `Alt+Shift+F/K/V/E` shortcuts and action selection remain plugin-owned.
- App supplies a stable live service proxy that invokes existing camera/Finder/views/Extensions UI state. It does not inspect command ids or register commands. The global command listener captures a resolved shortcut before legacy listeners, so `Alt+Shift+F` cannot also trigger the pre-existing plain `F` focus-selection shortcut.
- Foundation validates ordered search, exact modifier matching, priority collision/disabled-winner behavior, duplicate protection, real builtin service invocation and reverse disposal. It also checks generic host/plugin source boundaries and the unchanged renderer-only/no-IPC contract.
- 2026-09-22 remote commands (all exit 0): `npm --prefix artflow run typecheck`; `npm --prefix artflow run check:foundations`; `npm --prefix artflow run check` (production Vite build included). The build emits only the existing >500 kB chunk-size advisory and Node `node:sqlite` experimental warning.
