/**
 * 这个示例同时演示两面，说明它们不冲突：
 *   1. `assets`（第 5 面，投稿）：登记一个能读/改资产名的组件面板 —— 见 client.js，
 *      它走 unrestricted 权限，安装时用户要确认。
 *   2. `host`（第 8 面，读取宿主）：读宿主自己的资产库。只读，需在清单里声明
 *      `permissions.host: ["assets.read"]` —— 没声明的话下面的调用会直接抛错。
 *
 * `console.log` 会被转发到主进程终端，前缀 `[plugin] local.asset-rename`。
 * 沙箱窗口是隐藏的，不经过这条转发你看不到任何插件输出。
 */
Artflow.modules.definePlugin(function (api) {
  api.commands.register({
    id: 'local.asset-rename.report',
    title: '统计未引用资产',
    description: '用 host 面读取资产库，报告未被工程引用的资产数量',
    async run() {
      const assets = await api.host.assets.list({ limit: 200 });
      const unused = assets.filter(asset => asset.usage === 'none');
      console.log(`host API ${api.host.meta.hostApiVersion}：共 ${assets.length} 个资产，未引用 ${unused.length} 个`);
      for (const asset of unused.slice(0, 5)) {
        console.log(`  - ${asset.name}（${asset.kind}，${asset.byteSize} B）`);
      }
    },
  });
});
