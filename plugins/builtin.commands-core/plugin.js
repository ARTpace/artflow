/**
 * builtin.commands-core —— 核心命令与画布右键菜单（editable channel）。
 *
 * 原 builtin/commands-core/index.ts 的迁移：全部命令/菜单注册与文案都可在本文件里改。
 * 所需宿主能力经 Artflow 注入：
 *   - Artflow.services.ELEMENT_COMMAND_ACTIONS / WORKSPACE_COMMAND_ACTIONS：动作服务名；
 *   - Artflow.bi：双语文案。
 *
 * 装完可改，重启生效。改坏了删 userData/plugins/builtin.commands-core/ 即可恢复。
 */
Artflow.definePlugin({
  manifest: {},
  activate(ctx) {
    const ELEMENT = Artflow.services.ELEMENT_COMMAND_ACTIONS;
    const WORKSPACE = Artflow.services.WORKSPACE_COMMAND_ACTIONS;
    const bi = Artflow.bi;

    const actions = () => ctx.use(ELEMENT);
    const workspaceActions = () => ctx.use(WORKSPACE);

    // ==================== Edit & Presentation ====================
    const editCommands = [
      { id: 'edit.undo', value: { title: bi('撤销', 'Undo'), description: bi('撤销上一次画布修改。', 'Undo the last canvas change.'), group: 'Edit', keywords: ['history', 'revert'], shortcut: { key: 'z', mod: true }, run: () => actions().undo() } },
      { id: 'edit.redo', value: { title: bi('重做', 'Redo'), description: bi('重做上一次被撤销的画布修改。', 'Redo the last undone canvas change.'), group: 'Edit', keywords: ['history', 'restore'], shortcut: { key: 'z', mod: true, shift: true }, run: () => actions().redo() } },
      { id: 'edit.copy', value: { title: bi('复制所选', 'Copy selection'), description: bi('复制选中的画布卡片。', 'Copy the selected canvas cards.'), group: 'Edit', keywords: ['duplicate', 'clipboard'], shortcut: { key: 'c', mod: true }, isEnabled: () => actions().canEditSelection(), run: () => actions().copy() } },
      { id: 'edit.delete', value: { title: bi('删除所选', 'Delete selection'), description: bi('删除选中的画布卡片。', 'Delete the selected canvas cards.'), group: 'Edit', keywords: ['remove', 'trash'], shortcut: { key: 'Delete' }, isEnabled: () => actions().canEditSelection(), mcp: { impact: 'write', destructive: true }, run: () => actions().deleteSelection() } },
      { id: 'presentation.start', value: { title: bi('开始放映', 'Start presentation'), description: bi('播放当前画布的帧序列。', 'Play the current board frames.'), group: 'Presentation', keywords: ['slideshow', 'play'], run: () => actions().startPresentation() } },
      { id: 'presentation.next', value: { title: bi('下一帧', 'Next frame'), description: bi('放映前进一步。', 'Advance the presentation.'), group: 'Presentation', keywords: ['slideshow', 'forward'], isEnabled: () => actions().isPresenting(), run: () => actions().presentationNext() } },
      { id: 'presentation.prev', value: { title: bi('上一帧', 'Previous frame'), description: bi('放映后退一帧。', 'Go back one presentation frame.'), group: 'Presentation', keywords: ['slideshow', 'back'], isEnabled: () => actions().isPresenting(), run: () => actions().presentationPrev() } },
      { id: 'presentation.exit', value: { title: bi('退出放映', 'Exit presentation'), description: bi('离开放映模式。', 'Leave the presentation.'), group: 'Presentation', keywords: ['slideshow', 'stop'], isEnabled: () => actions().isPresenting(), run: () => actions().exitPresentation() } },
    ];

    // ==================== Workspace ====================
    const workspaceCommands = [
      { id: 'workspace.fit-canvas', value: { title: bi('适配画布', 'Fit canvas'), description: bi('把当前画布的所有卡片框进视野。', 'Frame all cards in the current canvas.'), group: 'Workspace', keywords: ['zoom', 'overview', 'navigator'], shortcut: { key: 'f', alt: true, shift: true }, isEnabled: () => workspaceActions().canFitCanvas(), mcp: { impact: 'write' }, run: () => workspaceActions().fitCanvas() } },
      { id: 'workspace.open-canvas-finder', value: { title: bi('在画布中查找', 'Find on canvas'), description: bi('在当前画布中搜索卡片。', 'Search cards on the current board.'), group: 'Workspace', keywords: ['search', 'filter', 'cards'], shortcut: { key: 'k', alt: true, shift: true }, run: () => workspaceActions().openCanvasFinder() } },
      { id: 'workspace.open-saved-views', value: { title: bi('打开视图标签', 'Open saved views'), description: bi('管理画布本地的镜头标签。', 'Manage board-local camera bookmarks.'), group: 'Workspace', keywords: ['bookmarks', 'camera', 'navigator'], shortcut: { key: 'v', alt: true, shift: true }, run: () => workspaceActions().openSavedViews() } },
      { id: 'workspace.open-extensions', value: { title: bi('打开扩展', 'Open extensions'), description: bi('浏览已启用的扩展面板。', 'Browse enabled extension panels.'), group: 'Workspace', keywords: ['plugins', 'theme', 'library'], shortcut: { key: 'e', alt: true, shift: true }, isEnabled: () => workspaceActions().canOpenExtensions(), run: () => workspaceActions().openExtensions() } },
    ];

    // ==================== Canvas Menus ====================
    const isRasterizable = types => types.some(type => ['path', 'shape', 'text', 'arrow', 'line'].includes(type));

    const ITEMS = [
      { id: 'bring-forward', priority: 40, group: 'layer', label: lang => (lang === 'zho' ? '上移一层' : 'Bring Forward'), visible: c => !c.isMultiSelection && c.element !== null, run: c => c.actions.layerAction(c.element.id, 'forward') },
      { id: 'send-backward', priority: 30, group: 'layer', label: lang => (lang === 'zho' ? '下移一层' : 'Send Backward'), visible: c => !c.isMultiSelection && c.element !== null, run: c => c.actions.layerAction(c.element.id, 'backward') },
      { id: 'bring-to-front', priority: 20, group: 'layer', label: lang => (lang === 'zho' ? '移到最前' : 'Bring to Front'), visible: c => !c.isMultiSelection && c.element !== null, run: c => c.actions.layerAction(c.element.id, 'front') },
      { id: 'send-to-back', priority: 10, group: 'layer', label: lang => (lang === 'zho' ? '移到最后' : 'Send to Back'), visible: c => !c.isMultiSelection && c.element !== null, run: c => c.actions.layerAction(c.element.id, 'back') },
      { id: 'group', priority: 30, group: 'group', label: lang => (lang === 'zho' ? '编组' : 'Group'), visible: c => c.isMultiSelection, run: c => c.actions.group() },
      { id: 'ungroup', priority: 20, group: 'group', label: lang => (lang === 'zho' ? '取消编组' : 'Ungroup'), visible: c => !c.isMultiSelection && c.element?.type === 'group', run: c => c.actions.ungroup() },
      { id: 'merge-group', priority: 10, group: 'group', label: lang => (lang === 'zho' ? '合并编组' : 'Merge Group'), visible: c => !c.isMultiSelection && c.element?.type === 'group', run: c => c.actions.mergeGroup() },
      { id: 'rasterize-selection', priority: 20, group: 'group', label: lang => (lang === 'zho' ? '栅格化所选' : 'Rasterize Selection'), visible: c => c.isMultiSelection && isRasterizable(c.selectedElements.map(el => el.type)), run: c => c.actions.rasterizeSelection() },
      { id: 'copy', priority: 10, group: 'clipboard', label: lang => (lang === 'zho' ? '复制' : 'Copy'), visible: () => true, run: c => { if (c.isMultiSelection) c.actions.copySelection(); else if (c.element) c.actions.copyElement(c.element); } },
      { id: 'delete', priority: 10, group: 'destructive', danger: true, label: lang => (lang === 'zho' ? '删除' : 'Delete'), visible: () => true, run: c => { if (c.isMultiSelection) c.actions.deleteSelection(); else if (c.element) c.actions.deleteElement(c.element.id); } },
    ];

    const disposers = [
      ...editCommands.map(({ id, value }) => ctx.contributions.register('commands', { id, pluginId: 'builtin.commands-core', priority: 30, value })),
      ...workspaceCommands.map(({ id, value }) => ctx.contributions.register('commands', { id, pluginId: 'builtin.commands-core', priority: 20, value })),
      ...ITEMS.map(item => ctx.contributions.register('ui_menus', {
        id: `builtin.canvas-menus.${item.id}`,
        pluginId: 'builtin.commands-core',
        priority: item.priority,
        value: { label: item.label, danger: item.danger, group: item.group, visible: item.visible, run: item.run },
      })),
    ];
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
});
