/**
 * builtin.formats-image-doc —— 内置可编辑插件：图像 / PSD / PDF / 音频格式解析。
 *
 * 播种到 userData/plugins/builtin.formats-image-doc/plugin.js（首次启动，已存在则不覆盖）。
 * 装完可直接改本文件，重启应用即生效，无需重新编译宿主。
 *
 * 宿主注入的解析器（Artflow.host.*，依赖 ag-psd / pdfjs-dist / 内部图像代理链）：
 *   parsePsdFile(file)          → PSD/PSB 解析结果
 *   parsePdfFile(file)          → PDF 页数组
 *   parseAudioFile(file)        → 音频元数据
 *   readAndCompressImage(file)  → 图像读取 + 多档压缩（含 svg/tga/exr 分支）
 *
 * 产出的是宿主原生 FormatResult（image / psd / image-pages / audio），宿主直接消费，
 * 无需自建 cardType。
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.formats-image-doc',
    version: '0.1.0',
    minHostVersion: '1.0.0',
    name: '内置图像与文档格式包',
    nameI18n: { en: 'Built-in Image & Document Formats' },
    author: 'Artflow',
    license: 'MIT',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    host: 'renderer',
    capabilities: ['format.handler'],
    resourceBudget: { maxConcurrentJobs: 1, maxMemoryMB: 256 },
    description: '图像与文档格式解析：PNG/JPG/WebP/SVG/GIF 等通用图片路径与 PDF/DOC 类文档卡',
    descriptionI18n: { en: 'Image and document format parsing: general image paths such as PNG/JPG/WebP/SVG/GIF, plus PDF/DOC-style document cards.' },
    category: 'format',
  },

  activate(ctx) {
    const { host, constants } = Artflow;

    // 保留 fileUtils 产出的全部档位，否则画布会把每张 JPG 静默按 1024px 渲染。
    // imageFrom 由宿主注入（Artflow.host.imageFrom），与内置实现同源。
    const imageFrom = host.imageFrom;

    const handlers = [
      {
        id: 'builtin.format-psd',
        extensions: ['psd', 'psb'],
        outputKind: 'psd',
        mimeTypes: ['image/vnd.adobe.photoshop', 'image/x-photoshop', 'application/x-photoshop', 'application/photoshop', 'image/psd', 'application/psd'],
        category: 'image',
        parse: async file => ({ kind: 'psd', psd: await host.parsePsdFile(file) }),
      },
      {
        id: 'builtin.format-pdf',
        extensions: ['pdf'],
        mimeTypes: ['application/pdf'],
        outputKind: 'image-pages',
        category: 'document',
        parse: async file => ({
          kind: 'image-pages',
          pages: (await host.parsePdfFile(file)).map(page => imageFrom(
            `${file.name.replace(/\.[^/.]+$/, '')} - Page ${page.pageNumber}`,
            { width: page.width, height: page.height, dataUrl: page.dataUrl, originalDataUrl: page.dataUrl, mimeType: 'image/png' },
          )),
        }),
      },
      {
        id: 'builtin.format-audio',
        extensions: [...constants.AUDIO_EXTENSIONS],
        outputKind: 'audio',
        category: 'audio',
        parse: async file => {
          const audio = await host.parseAudioFile(file);
          return {
            kind: 'audio',
            name: audio.name,
            width: audio.width,
            height: audio.height,
            dataUrl: audio.dataUrl,
            mimeType: audio.mimeType,
            duration: audio.duration,
          };
        },
      },
      {
        id: 'builtin.format-image',
        extensions: [...constants.IMAGE_EXTENSIONS],
        mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'image/tiff'],
        outputKind: 'image',
        category: 'image',
        parse: async file => imageFrom(file.name, await host.readAndCompressImage(file)),
      },
    ];

    const disposers = handlers.map((handler, index) => ctx.contributions.register('format_handlers', {
      id: handler.id,
      pluginId: ctx.pluginId,
      // 专用解析器优先于通用图像处理器；注册表另有 id 兜底排序。
      priority: 100 - index,
      value: handler,
    }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
});
