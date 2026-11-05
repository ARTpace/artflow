/**
 * builtin.media —— 视频文件导入解析（editable channel）。
 *
 * 原 builtin/media/index.tsx 的迁移：handler 定义与注册都在本文件里，可装完直接改。
 * 所需宿主能力经 Artflow 注入：
 *   - Artflow.constants.VIDEO_EXTENSIONS：视频扩展名表；
 *   - Artflow.host.hasManagedProjectStorage / fileToDataUrl：托管 vs JSON 两种工程的取图路径。
 *
 * 性能：Electron managed 管线下视频用 ObjectURL（blob:）引用文件本体——
 * 整文件 base64（fileToDataUrl）会让 100MB 视频变成 133MB JS 字符串。
 * blob: 是 managed 保存管线认可的运行时引用；browser JSON 模式的项目文档必须自包含，保留 dataURL。
 *
 * 装完可改，重启生效。改坏了删 userData/plugins/builtin.media/ 即可恢复。
 */
Artflow.definePlugin({
  manifest: {},
  activate(ctx) {
    const VIDEO_EXTENSIONS = Artflow.constants.VIDEO_EXTENSIONS;
    const { hasManagedProjectStorage, fileToDataUrl } = Artflow.host;

    const videoHandler = {
      id: 'builtin.media.format-video',
      extensions: [...VIDEO_EXTENSIONS],
      mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-matroska', 'video/x-m4v'],
      outputKind: 'video',
      category: 'video',
      parse: async file => {
        const useRuntimeUrl = hasManagedProjectStorage();
        const { dataUrl, mimeType } = useRuntimeUrl
          ? { dataUrl: URL.createObjectURL(file), mimeType: file.type || 'video/mp4' }
          : await fileToDataUrl(file);
        const fileSize = file.size;
        const dimensions = await new Promise(resolve => {
          const probe = document.createElement('video');
          let settled = false;
          const finish = (width = 800, height = 450) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            probe.onloadedmetadata = null;
            probe.onerror = null;
            // Metadata probes must not retain readers/decoders after import.
            // Keep the object URL alive: the canvas and managed save still use it.
            probe.pause();
            probe.removeAttribute('src');
            probe.load();
            resolve({ width, height });
          };
          const timeout = setTimeout(() => finish(), 10000);
          probe.preload = 'metadata';
          probe.onloadedmetadata = () => finish(probe.videoWidth || 800, probe.videoHeight || 450);
          probe.onerror = () => finish();
          probe.src = dataUrl;
        });
        return { kind: 'video', name: file.name, ...dimensions, dataUrl, mimeType, fileSize };
      },
    };

    return ctx.contributions.register('format_handlers', {
      id: videoHandler.id,
      pluginId: 'builtin.media',
      // Room below for third-party takeovers: they register a higher priority to win.
      priority: 100,
      value: videoHandler,
    });
  },
});
