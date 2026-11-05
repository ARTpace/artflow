# FDD-030：Phase P2 —— 设置内插件管理面板

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R30
- **关联**：FDD-025（`ui_panels`）、FDD-028（commands）、ADR-005 插件内核、现有 `plugins/profile.ts`

## 1. 背景与目标

Artflow 已有 manifest、builtin registry、profile patch、可逆 loader 和 Extensions 面板，但普通用户没有一个在 **设置** 中看见当前插件、理解其状态、或安全改变下次启动启用状态的入口。用户明确要求加入插件管理面板。

R30 交付一个可见的、设置内的 Plugin Manager vertical：在现有 Settings modal 出现一个由 builtin plugin 贡献的「插件 / Plugins」section，展示当前 builtin profile，并可为可管理插件写入已有的 user profile enable override。变更是 staged 的：用户明确点击 reload 后才重新解析 profile、装载/卸载 plugin，而不是在运行中冒险改写 contribution graph。

## 2. Ponytail 七步决策

1. **需要性**：需要。当前 plugin mechanism 已可配置，却没有用户可发现、可恢复的管理 surface；这正是已落地 profile 的直接产品闭环。
2. **现有能力**：复用 `BUILTIN_PLUGINS`、manifest validator、`resolvePluginProfile` / localStorage user patch、loader disposer、现有 Settings modal 和 typed contribution registry。不得另造 plugin database、安装器或配置文件格式。
3. **标准库**：使用 TypeScript、React state、`Storage` 与用户主动 `window.location.reload()`；无需新库。
4. **平台特性**：浏览器/Electron renderer 的 localStorage 与页面 reload 足以应用下次启动 profile；不需要 main/preload/IPC。
5. **已安装依赖**：React 已存在；不新增 npm dependency。
6. **一行方案**：不成立。安全的 profile write、dependency validation、restart boundary 和 Settings extension contribution 都需要最小可测试契约。
7. **最小实现**：新增一个 generic `settings_sections` slot + `ui.settings` capability、一个 generic profile-management service，和一个 manifest-loaded `builtin.ui-plugin-manager` section。仅管理 builtin enable overrides，改变后显示 pending state 与 Reload action。

## 3. 用户路径

1. 用户从现有 Settings 打开「插件 / Plugins」tab。
2. 管理面板列出 builtin plugin 的名称、id、版本、host、capabilities、依赖、预算和 active / next-start state。
3. 用户切换一个可管理 plugin 的 enabled switch；service 合并写入既有 `artflow.profile.patch.v1` user layer，并先用 profile resolver 验证依赖图。
4. 面板说明该变更尚未影响当前 session，显示「Reload to apply」；用户主动 reload 后，既有 startup profile → loader 路径自然决定哪些 plugins activate。
5. 用户可清除 enable overrides 恢复默认 profile。管理器自身是 bootstrap-recovery section，不能在唯一管理 UI 中把自己关闭；该保护是 narrow startup policy，不是 Runtime Core 伪装成 plugin。

## 4. 冻结边界

| 项 | 本轮支持 | 明确不做 |
|---|---|---|
| Inventory | 当前 manifest-loaded builtin plugin profile | marketplace、扫描目录、下载/安装/更新/签名、third-party runtime |
| Enable state | per-plugin user `enabled` override，dependency-safe、reload 后生效 | runtime hot unload/reload、自动重启、任意 JSON 编辑 |
| Settings UI | generic `settings_sections` consumer + builtin manager contribution | 在 App / CanvasSettings 写入具体 plugin id/name/business JSX |
| Persistence | 复用 `artflow.profile.patch.v1` localStorage layer | Project Document/schema、SQLite、asset store、IPC/preload |
| Safety | dependency validation、failed write 留在旧 state、manager recovery protection | 权限授予、capability sandbox、external trust model |

- 每个 tab 的 plugin UI 经 `settings_sections` contribution 到达 Settings；host 仅根据通用 label/component contract 渲染，不能认识 Plugin Manager 的 id、文案或业务逻辑。
- plugin manager 只能使用 `kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE)`；不得直接 import App、CanvasSettings、sibling plugin 或 storage implementation。
- profile manager 只能写已存在的 user patch key，并在写入前 resolver 校验。任何 invalid dependency mutation 都不落盘。
- enabled/disabled active state 永远以 startup profile 为准；pending state 只表示 reload 后的预期。不得宣称开关已在当前 session hot-apply。

## 5. Plugin/core ownership

| Layer | Owns | Must not own |
|---|---|---|
| `plugins/settings-contributions.tsx` | generic Settings section contract / sorted registry projection | plugin inventory, profile storage, builtin ids, UI business |
| `plugins/plugin-profile-manager.ts` | generic staged profile state, validated local user patch update, reload callback / protected-id policy | React Settings JSX, concrete manager wording, App/canvas behavior |
| `components/CanvasSettings.tsx` | generic Settings tab discovery and component hosting | `builtin.ui-plugin-manager` id, storage/profile algorithm, builtin plugin names |
| `builtin/ui-plugin-manager/` | list presentation, bilingual labels, toggle/reload/reset interactions | direct localStorage, App import, loader/profile reimplementation |
| startup `index.tsx` | instantiate generic manager service before builtin activation and declare narrow recovery plugin list | manager UI / plugin-specific controls |

## 6. Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-1 | Existing Settings contains a visible `Plugins / 插件` tab contributed through a manifest-loaded builtin, showing all current builtin profile entries and meaningful manifest/status detail. |
| AC-2 | A user can stage enable/disable of a non-protected builtin; valid changes persist as the existing user patch and explicitly show a reload-needed state. Reset removes only enabled overrides, preserving any future declared config patches. |
| AC-3 | Dependency-invalid disable/enable, storage error and protected manager disable fail closed with a user-visible reason and no invalid patch write. Current active state remains truthful until reload. |
| AC-4 | Generic host contains no Plugin Manager id/title/localStorage/profile business; builtin manager consumes a service, and actual activation/disposal removes its settings contribution. |
| AC-5 | No dependency, Project Document/schema, storage/IPC/preload capability, generic external plugin loader, marketplace, runtime hot-reload or profile config editor is introduced. Foundation, remote typecheck, production full check and exact read-back pass. |

## 7. Validation plan

1. Exercise generic profile-management service with in-memory storage: enable/disable, pending-versus-active state, restart callback, reset, rejected dependency and protected-ID cases; confirm failed mutation leaves storage unchanged.
2. Load the real `builtin.ui-plugin-manager`, assert manifest compatibility, service-only activation, settings section contribution order and disposer cleanup.
3. Static check generic Settings host / App have no manager id, manager has no localStorage/App/CanvasSettings import, startup exposes only generic service and existing profile machinery.
4. Build UI/typecheck and run the full foundation suite. Verify package/lockfile unchanged and exact-read selected source/governance files.

## 8. Non-goals

- No install, uninstall, marketplace, update, download, filesystem scanning, external/third-party plugin execution, trust/signature or permission UI.
- No hot activation/unload, process restart, plugin config editor, dependency graph visualization, telemetry, crash isolation or per-project plugin state.
- No migration of existing hardcoded Settings sections, Extensions panel, UI toolbar/menu/tools, or Runtime Core into profile control.

## 9. Remaining boundary

R30 makes existing builtin profile control discoverable and safe to stage. Full plugin lifecycle management (external discovery, permissions, install/update, crash recovery and live reload) remains a later P4/security/lifecycle workflow and cannot be inferred from a local Settings toggle.

## 10. 实现与验证记录（2026-09-22）

- 已新增 typed `settings_sections` slot / `ui.settings` capability。`CanvasSettings` 只消费通用 section label/component contract，`App` 只传入已有 kernel；两者都不包含 Plugin Manager id、文案、profile storage 或 enable business。
- `builtin.ui-plugin-manager` 以普通 manifest-loaded builtin 形式贡献「插件 / Plugins」Settings tab。它显示 resolved builtin manifest/profile detail、active vs pending 状态、依赖/被依赖关系与声明预算；它只经 `kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE)` 交互。
- `plugins/plugin-profile-manager.ts` 复用现有 `artflow.profile.patch.v1` user layer。每一次 enable mutation 都先 re-resolve dependency graph，再写入；有效配置 staged 后明确要求用户点击 Reload。它不执行 runtime unload/hot activation，也不新增 Project Document、IPC 或 storage owner。
- 唯一 bootstrap recovery section `builtin.ui-plugin-manager` 不可被自己的唯一管理 UI 关闭；startup supplied protected-id policy 会忽略一个已保存的 self-disable patch。清除 enable overrides 保留已有/未来声明的 config patch。
- Foundation 覆盖 valid/invalid dependency mutation、pending-vs-active truthfulness、storage write failure、reload callback、reset preserving config、protected recovery、actual plugin activation/settings contribution/disposal，以及 generic host/source boundary。
- 远端 `npm --prefix artflow run typecheck`、`npm --prefix artflow run check:foundations`、`npm --prefix artflow run check` 均 exit 0；production build 仅保留既有 large-chunk warning。package.json/lockfile 未变化；selected source、FDD/ADR 与四份治理文档的 canonical SHA-256 read-back 已匹配。
