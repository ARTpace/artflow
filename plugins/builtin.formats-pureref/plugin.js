/**
 * builtin.formats-pureref —— 内置可编辑插件：PureRef `.pur` 导入。
 *
 * 把 .pur 里内嵌的图片与便签铺到画布（图片/文本成为画布元素，本插件不画卡片）。
 * 播种到 userData/plugins/builtin.formats-pureref/plugin.js，装完可直接改、重启生效。
 *
 * 宿主注入的能力（Artflow.host.*）：
 *   parsePurBytes(bytes)          .pur 原始字节 → 场景（自研 purParser）
 *   purItemToSceneItem(item)      场景项 → FormatSceneItem（不可转换返回 undefined）
 *   limitBytes(spec) / limitMessage(spec, bytes)   阈值检查与文案
 *   bindFormatLimitConfig(ctx)    activate 里接一次：把 maxPurMiB 接成解析器阈值来源
 *   formatLimits                  FORMAT_LIMITS 声明表（如 formatLimits.purFileMiB）
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.formats-pureref',
    version: '0.1.0',
    minHostVersion: '1.0.0',
    name: '内置 PureRef 导入',
    nameI18n: { en: 'Built-in PureRef Import' },
    author: 'Artflow',
    license: 'MIT',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    host: 'renderer',
    configSchema: { maxPurMiB: 'number' },
    capabilities: ['format.handler'],
    resourceBudget: { maxConcurrentJobs: 1, maxMemoryMB: 128 },
    description: '把 PureRef .pur 铺到画布。1.x 与 2.x 都还原原图、位置和尺寸（2.x 直接读内嵌场景数据库）。',
    descriptionI18n: { en: 'Lay PureRef .pur files onto the canvas. Both 1.x and 2.x keep the original images, positions and sizes (2.x reads the embedded scene database).' },
    category: 'format',
  },

  activate(ctx) {
    const { host } = Artflow;
    const { limitBytes, limitMessage, formatLimits } = host;

    const purHandler = {
      id: 'builtin.format-pureref',
      extensions: ['pur'],
      outputKind: 'scene',
      category: 'scene',
      parse: async file => {
        const spec = formatLimits.purFileMiB;
        const limit = limitBytes(spec);
        if (file.size > limit) throw new Error(limitMessage(spec, limit));
        const scene = await host.parsePurBytes(new Uint8Array(await file.arrayBuffer()));
        const items = scene.items.flatMap(item => {
          const converted = host.purItemToSceneItem(item);
          return converted ? [converted] : [];
        });
        if (items.length === 0) throw new Error('这个 PureRef 文件里没有能放上画布的图片。');
        return { kind: 'scene', items, notice: scene.notice };
      },
    };

    // 把 maxPurMiB 接成解析器的阈值来源（详见 plugins/format-limits.ts）。
    const unbindLimits = host.bindFormatLimitConfig(ctx);
    const effect = ctx.contributions.register('format_handlers', {
      id: purHandler.id,
      pluginId: ctx.pluginId,
      priority: 80,
      value: purHandler,
    });
    return () => {
      effect();
      unbindLimits();
    };
  },
});
