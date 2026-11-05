# FDD-025：Phase P1 —— 插件面板宿主与皮肤选择器

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R25
- **关联**：`docs/插件系统设计.md` §1 原则 7、§3 `ui_panels`、§7 内置插件流程；`docs/插件化迁移清单.md` P1；FDD-007 / R7 format handler plugin vertical

## 1. 背景与目标

现有 `skins` 插槽和 SkinEngine 已能装载默认霓虹 / 纸质笔记两套 skin token，但只能通过调试口调用；同时 `ui_panels` 虽已是内核插槽，却没有消费端。把新的主题选择 UI 再硬编码进 `App.tsx` 或 `CanvasSettings.tsx` 会违反插件系统设计的“UI 必须走贡献通道”原则，并继续积累本体 UI 债务。

R25 交付一个完整、可见的 P1 插件纵向切片：**generic PanelHost** 读取 `ui_panels`，`builtin/ui-skin-picker` 通过 manifest/loader/activation 注册 Theme library panel，用户从 TopBar 的通用 Extensions action 打开它，预览并切换已注册 skin。主题业务和 skin picker UI 不进入本体；本体只提供通用 host、受控 service 和 generic launcher。

## 2. 前置核对与 Ponytail 七步决策

- 已先核对用户上传的《插件系统设计》《插件化迁移清单》与远端真实 `plugins/kernel.ts`、loader、manifest、SkinEngine、builtin registry、profile、R7 format handler vertical。远端文档含后续 R7 / UI-contribution 原则扩展，故以远端权威副本为治理基线，而不覆盖为上传的旧副本。
1. **需要性**：需要。已存在两套 skin，但用户没有正常 UI 路径；同时必须给 `ui_panels` 插槽一个可验证消费端。
2. **已有能力**：复用 Kernel registry、`ui_panels` slot、builtin manifest/loader/profile、skins slot、SkinEngine 与 TopBar。
3. **标准库**：React state/effect 与现有 CSS variables 足够；不引入 router、state-store、UI library 或依赖。
4. **平台特性**：不需要 Electron/IPC/main/preload；正常 browser/Electron renderer 同路径。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要泛化 panel contribution 契约、host lifecycle / close semantics、受控 SkinEngine service，以及一个真实 builtin panel 验证完整加载链。
7. **最小实现**：`panel-contributions.ts` + `panel-host.tsx` generic mechanism、SkinEngine service/preview API、`builtin/ui-skin-picker` manifest/activation/panel、builtin registry、generic Extensions trigger。不得迁移旧五个硬编码 UX 面板。

## 3. 用户工作流

1. 正常打开 Artflow，TopBar 显示通用 **Extensions** action（仅当 profile 中有 `ui_panels` contribution 时可用）。
2. 点击后由 PanelHost 列出当前 profile 的插件面板；选择 **Theme library**。
3. skin picker 从 `SkinEngine.listSkins()` 展示每套已注册 skin 的名称、light/dark 标记和 token 色块；点击即通过 host service 切换。
4. 当前 skin 的 CSS variables 立即作用于已 token 化的 card surfaces；关闭/返回/按 Escape 不写项目内容、不改变 selection、不进入 undo/redo。
5. 本轮 skin selection 是 renderer session 状态：不伪造 project Save、autosave、profile patch 或同步持久化承诺。

## 4. 契约与归属

```ts
interface PluginPanelProps { kernel: Kernel; onClose(): void }
interface PluginPanelContribution { title: string; description?: string; component: React.ComponentType<PluginPanelProps> }

ctx.contributions.register('ui_panels', {
  id: 'builtin.panel-skin-picker',
  pluginId: 'builtin.ui-skin-picker',
  value: { title: 'Theme library', component: SkinPickerPanel },
});
```

- `plugins/panel-*` 只处理 generic list/selection/close/render；不得出现 skin id、skin label 或 plugin-specific UI。
- `builtin.ui-skin-picker` 必须声明 `ui.panel` capability 和 `requires: ['builtin.skins-default']`，并只经 `kernel.use(SKIN_ENGINE_SERVICE)` 获取 SkinEngine；禁止直接 import other builtin plugin implementation。
- SkinEngine service 在 builtin activation 后、React mount 前由 bootstrap 提供；PanelHost 将 Kernel 显式传入 panel component。
- Contribution registration 返回 disposer；dispose 后 `listPanelContributions` 不再返回该 panel。profile 可以在启动时禁用 builtin panel plugin，generic launcher 不应硬编码 skin picker。

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | 一个 generic `ui_panels` host 以 registry `list()` 渲染 profile 中的面板，支持 empty / list / selected / back / close / Escape，不硬编码 skin business。 |
| AC-2 | `builtin/ui-skin-picker` 是独立 manifest builtin plugin，注册/卸载可逆，并通过 host service 展示/切换 skins。 |
| AC-3 | TopBar 仅出现 generic Extensions trigger；Theme library workflow 正常可发现，切 skin 不改变 Board、selection、history、Save 或 persistence ownership。 |
| AC-4 | 现有 skins/card tokens、R7 format plugin、profile/manifest contract 和 13-capability boundary 不回归；无 IPC/main/preload/Worker/SQLite/dependency。 |
| AC-5 | Foundation、remote typecheck、production full check、exact remote source/governance read-back 通过。 |

## 6. 明确不做

- 不做旧 ImportJobs/Workspace/Finder/ViewBookmarks/Settings/Toolbar 的大规模插件化迁移；它们保持已验证行为，P2 再按绞杀者迁移。
- 不做 `ui_toolbar` / commands / keybinding / dock layout / drag-resize / multi-window / panel persistence。
- 不做 skin editor、custom skin JSON import/export、persistent active skin/profile patch UI、external plugin、sandbox、theme marketplace 或 third-party React components。
- 不做 canvas_widgets、AI provider、format/comic/book/PureRef、storage/IPC/schema/Project Document 变更。

## 7. 验证记录（2026-09-22）

- 远端 `npm --prefix artflow run typecheck` exit 0。
- 远端 `npm --prefix artflow run check:foundations` exit 0：验证 `ui_panels` priority/id order、builtin loader disposer、SkinEngine service provide/use disposal、skin preview/set/listener，以及 PanelHost/skin picker/App/TopBar 的 generic boundary static checks。
- 远端 `npm --prefix artflow run check` exit 0（typecheck、Vite production build、foundations）；只出现既有 large-chunk advisory 与 Node SQLite experimental warning。
- Closing exact remote read-back matches the 10 R25 application/foundation sources and 6 R25 governance/plugin documents.

## 8. 风险与回退

- React component contributions 仅限 trusted builtin；restricted/external runtime 未就绪前不得开放。
- 若 skin plugin 被 profile 禁用，host 可为空，generic action 不得假定 Theme library 存在。
- 皮肤变量已存在且默认 skin 保持原视觉；本轮只把已有能力接入可见入口，可通过禁用 builtin plugin / 回退代码撤销。

## 9. 完成边界

R25 只验证第一个 `ui_panels` consumer + builtin skin picker。下一阶段需独立 FDD/ADR 才能迁移旧 UI、增加 commands/ui_toolbar、panel persisted layout、config center、external/restricted plugins 或 skin persistence。
