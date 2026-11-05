/**
 * builtin.project-portable —— 单文件工程 .artflow（可编辑内置插件，PureRef 对齐 #8）。
 * 容器：zip = document.json（工程 v2 文档）+ assets.json（索引）+ assets/<sha256>（原始字节）。
 * 文档经 host.platform 存储通道读写；字节经 artflow-asset:// 协议收集、主进程对话框落盘。
 *
 * 宿主注入：Artflow.services.HOST_PLATFORM（服务名常量）、Artflow.host.zip（fflate）、
 * Artflow.host.uiText（按界面语言取文案）、Artflow.bi（双语文案）。
 */
Artflow.definePlugin({
  manifest: {
    manifestVersion: 1,
    id: 'builtin.project-portable',
    version: '1.0.0',
    minHostVersion: '1.0.0',
    name: 'Project Portable',
    category: 'format',
    author: 'Artflow',
    license: 'MIT',
    host: 'renderer',
    runtime: { mode: 'editable', entry: 'plugin.js' },
    requires: [],
    optionalRequires: [],
    capabilities: ['command'],
    contributes: {},
  },

  activate(ctx) {
    const PLUGIN_ID = 'builtin.project-portable';
    const HOST_PLATFORM_SERVICE = Artflow.services.HOST_PLATFORM;
    const { zipSync, strToU8, strFromU8 } = Artflow.host.zip;
    const uiText = Artflow.host.uiText;
    const bi = Artflow.bi;

    const host = (kernel) => kernel.use(HOST_PLATFORM_SERVICE);

    const STORAGE_REF_PREFIX = 'artflow-asset://sha256/';

    const hashFromRef = (reference) => {
      if (typeof reference !== 'string' || !reference.startsWith(STORAGE_REF_PREFIX)) return null;
      const hash = reference.slice(STORAGE_REF_PREFIX.length);
      return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
    };

    const assetHash = (asset) =>
      hashFromRef(asset.locator.originalRef) ?? hashFromRef(asset.locator.fileRef) ?? hashFromRef(asset.locator.previewRef);

    const toArrayBuffer = (bytes) =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const exportArtflow = async (kernel) => {
      const document = await host(kernel).loadProject();
      if (!document || !Array.isArray(document.assets)) {
        console.warn('[project-portable] no open project document to export');
        return;
      }
      const files = {
        'document.json': strToU8(JSON.stringify(document)),
      };
      const index = [];
      for (const asset of document.assets) {
        const hash = assetHash(asset);
        if (!hash) continue; // data: 内联引用已在 document.json 里；blob: 运行态引用跳过。
        const response = await fetch(`${STORAGE_REF_PREFIX}${hash}`);
        if (!response.ok) {
          console.warn(`[project-portable] asset ${asset.id} (${hash.slice(0, 8)}…) fetch failed: ${response.status}`);
          continue;
        }
        const file = `assets/${hash}`;
        files[file] = new Uint8Array(await response.arrayBuffer());
        index.push({ hash, file });
      }
      files['assets.json'] = strToU8(JSON.stringify({ format: 'artflow-portable', version: 1, assets: index }));
      const zipped = zipSync(files, { level: 0 }); // 资产已是压缩格式，store 模式最快。
      const result = await host(kernel).saveBytes({
        title: uiText('导出单文件工程（.artflow）', 'Export portable project (.artflow)'),
        defaultName: `artflow-${new Date().toISOString().slice(0, 10)}.artflow`,
        bytes: toArrayBuffer(zipped),
      });
      if (!result.ok && result.message !== 'canceled') console.warn('[project-portable] export failed:', result.message);
    };

    const importArtflow = async (kernel) => {
      const opened = await host(kernel).openArtflow();
      if (!opened.ok || !opened.bytes) {
        if (opened.message && opened.message !== 'canceled') console.warn('[project-portable] open failed:', opened.message);
        return;
      }
      let document;
      let assetIndex = [];
      try {
        const entries = Artflow.host.zip.unzipSync(new Uint8Array(opened.bytes));
        document = JSON.parse(strFromU8(entries['document.json']));
        if (entries['assets.json']) {
          assetIndex = JSON.parse(strFromU8(entries['assets.json'])).assets ?? [];
        }
        if (!document || !Array.isArray(document.assets)) throw new Error('document.json missing assets');
        // .artflow 导入语义：用户先选一个目标工程文件夹（建议新建空文件夹），资产逐个入托管库后写文档。
        const target = await host(kernel).chooseProject();
        if (!target) return;
        const fileByHash = new Map(assetIndex.map(entry => [entry.hash, entry.file]));
        for (const asset of document.assets) {
          const hash = assetHash(asset);
          if (!hash) continue; // data: 内联无需导入。
          const file = fileByHash.get(hash) ?? `assets/${hash}`;
          const bytes = entries[file];
          if (!bytes) throw new Error(`portable file is missing asset ${hash.slice(0, 8)}…`);
          const result = await host(kernel).importAsset({
            asset: { id: asset.id, kind: asset.kind, locator: { mimeType: asset.locator.mimeType, extension: asset.locator.extension, format: asset.locator.format }, metadata: asset.metadata },
            bytes: toArrayBuffer(bytes),
            originalName: asset.metadata?.originalName,
          });
          if (!result || result.ok === false) {
            throw new Error(`asset ${asset.id} import was rejected`);
          }
        }
        const saved = await host(kernel).saveProject(document);
        if (!saved) throw new Error('target project refused the document');
        // 写回后重载，让启动恢复流程打开新工程。
        globalThis.location?.reload?.();
      } catch (error) {
        console.error('[project-portable] import failed:', error);
      }
    };

    const projectPortableCommands = [
      {
        id: 'project.export-artflow',
        value: {
          title: bi('导出单文件工程（.artflow）', 'Export portable project (.artflow)'),
          description: bi('把当前工程文档与全部托管资产打包成一个 .artflow 文件。', 'Pack the open project document and all managed assets into one .artflow file.'),
          group: 'Project',
          keywords: ['导出', '打包', '单文件', 'artflow', 'export', 'portable', '分享'],
          isEnabled: kernel => host(kernel).canOpenDirs,
          run: kernel => exportArtflow(kernel),
        },
      },
      {
        id: 'project.import-artflow',
        value: {
          title: bi('打开单文件工程（.artflow）', 'Open portable project (.artflow)'),
          description: bi('打开 .artflow 文件：选择目标工程文件夹，资产会重新导入托管存储。', 'Open a .artflow file: pick a target project folder, assets are re-imported into the managed store.'),
          group: 'Project',
          keywords: ['打开', '导入', 'artflow', 'import', 'portable'],
          isEnabled: kernel => host(kernel).canOpenDirs,
          run: kernel => importArtflow(kernel),
        },
      },
    ];

    const disposers = projectPortableCommands.map(({ id, value }) => ctx.contributions.register('commands', {
      id,
      pluginId: PLUGIN_ID,
      priority: 20,
      value,
    }));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
});
