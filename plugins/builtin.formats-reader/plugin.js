/**
 * builtin.formats-reader —— 内置可编辑插件：统一注册阅读与漫画类格式处理器。
 *
 * 整合自 formats-book（TXT/HTML/EPUB）、formats-comic（CBZ）、formats-packaged（MOBI/AZW/CBR/CB7/7Z）。
 * 播种到 userData/plugins/builtin.formats-reader/plugin.js，装完可直接改、重启生效。
 *
 * 解析器由宿主注入（Artflow.host.*，依赖 fflate / format-limits 与内部交叉引用）：
 *   parseBookFile(file)         TXT/HTML 纯文本
 *   parseEpubFile(file)         EPUB（fflate）
 *   parseComicFile(file)        CBZ 漫画
 *   parsePalmFile(file)         MOBI/AZW/AZW3
 *   parsePackedComicFile(file)  CBR/CB7/7Z 漫画
 *
 * 产出宿主原生 FormatResult（reader / comic），阅读与翻页 UI 由内置卡片类型包绘制。
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.formats-reader',
    version: '1.0.0',
    minHostVersion: '1.0.0',
    name: '阅读与漫画格式包',
    nameI18n: { en: 'Reader & Comic Formats' },
    author: 'Artflow',
    license: 'MIT',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    host: 'renderer',
    requires: ['builtin.cards-reader'],
    capabilities: ['format.handler'],
    resourceBudget: { maxConcurrentJobs: 2, maxMemoryMB: 128 },
    description: '整合文本/电子书/漫画格式解析：TXT/HTML/EPUB 阅读、MOBI/AZW/AZW3 阅读、CBZ/CBR/CB7/7Z 漫画。由内置卡片类型包绘制阅读与翻页 UI。',
    descriptionI18n: { en: 'Unified reader & comic formats: TXT/HTML/EPUB, MOBI/AZW/AZW3 readers, and CBZ/CBR/CB7/7Z comic archives. Reading UI is drawn by the built-in card type package.' },
    category: 'format',
  },

  activate(ctx) {
    const { host } = Artflow;

    // TXT/HTML/EPUB 阅读（原 formats-book，id 保持兼容）
    const bookHandler = {
      id: 'builtin.format-book-reader',
      // EPUB 故意只按扩展名匹配：通用 .zip 必须保留既有 FileCard 路径。
      extensions: ['txt', 'text', 'html', 'htm', 'epub'],
      mimeTypes: ['text/plain', 'text/html'],
      outputKind: 'reader',
      category: 'document',
      parse: file => file.name.toLowerCase().endsWith('.epub') ? host.parseEpubFile(file) : host.parseBookFile(file),
    };

    // CBZ 漫画（原 formats-comic，id 保持兼容）
    const comicHandler = {
      id: 'builtin.format-cbz-comic',
      // 故意只按扩展名匹配：通用 .zip 必须保留既有 FileCard 路径。
      extensions: ['cbz'],
      outputKind: 'comic',
      category: 'document',
      parse: host.parseComicFile,
    };

    // MOBI/AZW/AZW3 阅读（原 formats-packaged，id 保持兼容）
    const palmHandler = {
      id: 'builtin.format-palm-reader',
      extensions: ['mobi', 'azw', 'azw3'],
      outputKind: 'reader',
      category: 'document',
      parse: host.parsePalmFile,
    };

    // CBR/CB7/7Z 漫画（原 formats-packaged，id 保持兼容）
    const packedComicHandler = {
      id: 'builtin.format-packed-comic',
      extensions: ['cbr', 'cb7', '7z'],
      outputKind: 'comic',
      category: 'document',
      parse: host.parsePackedComicFile,
    };

    const disposers = [
      ctx.contributions.register('format_handlers', { id: bookHandler.id, pluginId: ctx.pluginId, priority: 90, value: bookHandler }),
      ctx.contributions.register('format_handlers', { id: comicHandler.id, pluginId: ctx.pluginId, priority: 95, value: comicHandler }),
      ctx.contributions.register('format_handlers', { id: palmHandler.id, pluginId: ctx.pluginId, priority: 80, value: palmHandler }),
      ctx.contributions.register('format_handlers', { id: packedComicHandler.id, pluginId: ctx.pluginId, priority: 80, value: packedComicHandler }),
    ];
    return () => { for (const dispose of disposers) dispose(); };
  },
});
