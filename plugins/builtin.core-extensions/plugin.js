/**
 * builtin.core-extensions —— declarative extension host（可编辑内置插件）。
 *
 * 与编译期内置插件同源同信任级：宿主把「服务名常量」与「operation-guard 工厂」
 * 通过 Artflow.services / Artflow.host 注入，此处只做编排。
 * 管理 UI 仍在唯一的 Plugin Manager 分区；运行时与命令注册保持在此。
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.core-extensions',
    version: '1.0.0',
    minHostVersion: '1.0.0',
    name: 'Core Extension Host',
    category: 'ui',
    author: 'Artflow',
    license: 'MIT',
    host: 'renderer',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    requires: [],
    optionalRequires: [],
    capabilities: ['ui.settings', 'command'],
    contributes: {},
  },

  activate(ctx) {
    const PLUGIN_ID = 'builtin.core-extensions';
    const EXTENSION_RUNTIME_SERVICE = Artflow.services.EXTENSION_RUNTIME;
    const bi = Artflow.bi;

    // —— 动态命令投影：每个启用的扩展工具对应一条命令面板条目 ——
    const syncExtensionCommands = (kernel, service) => {
      let commandDisposers = [];
      let currentKey = '';
      const sync = () => {
        const installed = service.runtime.installed();
        const active = installed.filter(entry => entry.enabled);
        const key = active.map(entry => `${entry.package.id}:${entry.package.version}`).join('|');
        if (key === currentKey) return;
        currentKey = key;
        commandDisposers.forEach(dispose => dispose());
        commandDisposers = [];
        for (const entry of active) {
          for (const tool of entry.package.tools) {
            const contributionId = `${entry.package.id}.${tool.id}`;
            commandDisposers.push(kernel.contributions.register('commands', {
              id: contributionId,
              pluginId: PLUGIN_ID,
              priority: 0,
              value: {
                title: tool.title,
                description: bi(`扩展工具（${entry.package.id}）`, `Extension tool (${entry.package.id})`),
                group: 'Extensions',
                keywords: ['extension', entry.package.id, tool.field],
                run: (root) => {
                  const host = root.use(EXTENSION_RUNTIME_SERVICE);
                  return host.invokeTool(entry.package.id, tool.id, tool.default, 'command');
                },
              },
            }));
          }
        }
      };
      sync();
      const unsubscribe = service.runtime.subscribe(sync);
      return () => { unsubscribe(); commandDisposers.forEach(dispose => dispose()); };
    };

    const service = ctx.use(EXTENSION_RUNTIME_SERVICE);

    const guardDisposer = ctx.contributions.register('hooks', {
      id: 'core.operation-guard',
      pluginId: PLUGIN_ID,
      priority: 1000,
      value: Artflow.host.createOperationGuardHook({
        isPackageActive: id => service.runtime.installed().some(entry => entry.package.id === id && entry.enabled),
        packagePermissions: id => service.runtime.installed().find(entry => entry.package.id === id)?.grants ?? [],
      }),
    });

    const commandsDisposer = syncExtensionCommands(ctx, service);

    return () => { commandsDisposer(); guardDisposer(); };
  },
});
