/**
 * builtin.formats-files —— 内置可编辑插件示例（Markdown / 代码 / 书签 / 字体 / 3D）。
 *
 * 这个文件随安装包播种到 userData/plugins/builtin.formats-files/plugin.js（首次启动，
 * 若目标已存在则保留用户改动）。装完之后你**可以直接改这个文件**，重启应用即生效，
 * 无需重新编译宿主。
 *
 * 可用 API（宿主注入的全局 Artflow，受信任执行，能力等同内置插件）：
 *   Artflow.definePlugin({ manifest, activate })   声明插件
 *   Artflow.host.*                                 宿主工具（见下方用到的函数）
 *   Artflow.constants.*                            扩展名表 / 常量
 *   ctx.contributions.register(slot, { id, pluginId, priority, value })
 *
 * 注意：改这里等于改宿主行为，请自行保证正确性（不存在 sandbox 的 API 白名单）。
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.formats-files',
    version: '0.1.0',
    minHostVersion: '1.0.0',
    name: '内置文档与文件格式',
    nameI18n: { en: 'Built-in Document & File Formats' },
    author: 'Artflow',
    license: 'MIT',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    host: 'renderer',
    requires: ['builtin.cards-files'],
    capabilities: ['format.handler'],
    resourceBudget: { maxConcurrentJobs: 1, maxMemoryMB: 32 },
    description: 'Markdown、代码、书签、字体、3D 文件解析为已有卡片。普通未知文件仍由导入流程兜底。',
    descriptionI18n: { en: 'Parse Markdown, code, bookmarks, fonts, and 3D files into existing cards. Unrecognized files still fall back to the import flow.' },
    category: 'format',
  },

  activate(ctx) {
    const { host, constants } = Artflow;
    const card = (cardType, name, width, height, fields) => ({ kind: 'card', cardType, name, width, height, fields });
    const extensionOf = file => (file.name.split('.').pop() || '').toLowerCase();

    const handlers = [
      {
        id: 'builtin.format-markdown',
        extensions: [...constants.MARKDOWN_EXTENSIONS],
        outputKind: 'card',
        category: 'document',
        parse: async file => card('markdown', file.name, 380, 260, { content: await host.readTextFile(file) }),
      },
      {
        id: 'builtin.format-code',
        extensions: Object.keys(constants.CODE_EXTENSIONS_MAP),
        outputKind: 'card',
        category: 'document',
        parse: async file => card('code', file.name, 420, 280, {
          code: await host.readTextFile(file),
          language: host.getLanguageFromExt(extensionOf(file)),
        }),
      },
      {
        id: 'builtin.format-bookmark',
        extensions: [...constants.URL_EXTENSIONS],
        outputKind: 'card',
        category: 'document',
        parse: async file => {
          const { url, title } = await host.parseUrlFile(file);
          let domain = url;
          try { domain = new URL(url).hostname; } catch { /* keep the raw url */ }
          return card('bookmark', title || file.name, 360, 130, { url, title: title || file.name, domain });
        },
      },
      {
        id: 'builtin.format-font',
        extensions: [...constants.FONT_EXTENSIONS],
        outputKind: 'card',
        category: 'document',
        parse: async file => {
          const font = await host.loadFontFile(file);
          return card('font', file.name, 380, 180, {
            fontFamily: font.fontFamily,
            fontUrl: font.fontUrl,
            format: font.format,
            fileSize: file.size,
          });
        },
      },
      {
        id: 'builtin.format-model3d',
        extensions: [...constants.MODEL_3D_EXTENSIONS],
        outputKind: 'card',
        category: 'document',
        parse: async file => card('model3d', file.name, 400, 320, {
          fileUrl: URL.createObjectURL(file),
          fileExtension: extensionOf(file),
          fileSize: file.size,
        }),
      },
    ];

    const disposers = handlers.map((handler, index) => ctx.contributions.register('format_handlers', {
      id: handler.id,
      pluginId: ctx.pluginId,
      priority: 40 - index,
      value: handler,
    }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
});
