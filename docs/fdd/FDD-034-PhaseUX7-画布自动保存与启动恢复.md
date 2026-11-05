# FDD-034：Phase UX7 画布自动保存与启动恢复

- 状态：verified
- 日期：2026-09-22
- 轮次：R34 (REQ-001)
- ADR：`ADR-034-画布自动保存与启动恢复边界.md`

## 1. 问题

在 R33 之前，Artflow 具备完整的 SQLite 资产仓与 v2 文档持久化能力，但用户关闭应用未手动保存会导致数据丢失，且重启后无法自动载入上一次的项目。这直接影响日常使用体验（《需求文档.md》REQ-001）。

## 2. 实现范围

1. **主进程会话记录与自愈恢复**：
   - `main/projectStorageController.cjs` 增加 `sessionFilePath` 选项；
   - 在 `openProject(projectRoot)` 成功时持久化 `{ lastProjectRoot: projectRoot, savedAt }`；
   - 暴露 `restoreLastSession()`、`readPersistedSession()` 与 `clearPersistedSession()`；
   - 当持久化目录被删除或不存在时，平稳清除无效记录并返回 null；
   - `main.cjs` 在应用就绪时自动调用 `restoreLastSession()`。

2. **渲染进程自动恢复与防抖保存**：
   - `hooks/useFileSystem.ts` 暴露 `restoreStartupProject()`，当项目处于打开状态时安全加载项目文档；
   - `utils/projectAutoSync.ts` 提供 `AUTOSAVE_DEBOUNCE_MS`（1500ms）与纯谓词 `canScheduleAutoSave`；
   - `App.tsx` 在挂载时检测并执行启动恢复，恢复成功后更新状态为 `Workspace restored.` 并重置变更基线；
   - `App.tsx` 在桌面受管模式下检测未保存变更（`hasUnsavedChanges`），1500ms 防抖静默触发 `saveProject`；
   - 监听 `beforeunload` 事件在页面关闭时冲刷未保存状态；
   - 保持手动保存与快捷键（Ctrl+S）完全一致。

3. **测试与质量守护**：
   - 在 `scripts/check-core-foundations.cjs` 中建立 `runAutoSyncChecks`；
   - 覆盖纯谓词状态机组合、会话序列化、控制器多实例重启恢复、路径失效容错与源码接线检查。

## 3. 验收标准达成情况

- [x] 编辑或变动画布内容后，1500ms 内无后续操作，自动完成非阻塞后台保存；
- [x] 重启应用后自动探测并恢复上次打开的项目，无需手动二次选择；
- [x] 自动保存过程中不阻塞画布交互、不挂载全屏遮罩；
- [x] 手动 Ctrl+S 保存不受影响，浏览器降级环境行为不变；
- [x] Preload 与主进程 IPC capability 保持为 13。

## 4. 验证命令与结果

- `npm --prefix artflow run typecheck`：exit 0
- `npm --prefix artflow run build`：exit 0
- `npm --prefix artflow run check:foundations`：exit 0 (`foundation checks: ok`)
- `npm --prefix artflow run check`：exit 0
