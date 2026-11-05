# artflow 插件示例

这两个文件夹是**可以直接运行的完整插件**，给没有 artflow 源码的第三方开发者照抄。
把任意一个文件夹整体复制出去，在 artflow 里执行「安装插件」并选中它即可生效。

| 示例 | 通道 | 展示什么 |
|---|---|---|
| `local.asset-rename` | sandboxed（含 `client.js`） | 两面同时演示：第 5 面 `assets` 注册 React 面板做批量重命名，第 8 面 `host` 用命令读宿主资产库 |
| `local.locale-jpn` | declarative | 零代码，纯 JSON 提供一套日文语言包 |

## 一个插件就是一个文件夹

```
local.my-plugin/
  manifest.json   清单，id 必须以 local. 开头
  plugin.js       沙箱入口，必须同步调用 Artflow.modules.definePlugin
  client.js       可选；提供后以 unrestricted 权限在画布进程内运行，安装时用户需授权
```

安装方式：在 artflow 的插件管理器里点「安装插件」选中该文件夹，或从命令面板执行同名命令。
安装后 `plugin.js` 的改动需要重新加载生效；卸载后授权自动撤销。

## 八面能力：投稿 vs 读取宿主

前七面（`formats` / `commands` / `panels` / `cards` / `assets` / `files` / `net`）都是**投稿** ——
你登记一个东西，等宿主来用。第 8 面 `host` 不同：它是**读取并操作宿主自己的状态**
（目前开放资产库），粒度从"条目级"变成"对象级"。

```js
Artflow.modules.definePlugin(function (api) {
  api.commands.register({
    id: 'local.my-plugin.count',
    title: '数一下资产',
    run: async function () {
      var assets = await api.host.assets.list({ limit: 100 });
      console.log('共 ' + assets.length + ' 个资产');
    },
  });
});
```

**每个方法都要在清单里声明权限**，否则调用被拒绝（抛错，不是返回空）：

```json
{ "permissions": { "host": ["assets.read"] } }
```

| 方法 | 需要的权限 | 说明 |
|---|---|---|
| `api.host.assets.list(options?)` | `assets.read` | 返回 `AssetRef[]`；`limit` 上限 200 |
| `api.host.assets.get(id)` | `assets.read` | 找不到返回 `null` |
| `api.host.assets.rename(changes)` | `assets.write` | 1~40 条 `{ id, name }` |

声明 `minHostVersion` 可以要求一个最低宿主版本；宿主比它旧时插件不会被激活，
插件管理器里会显示原因，而不是运行到一半才报方法不存在。

## 看不到输出？

沙箱窗口是隐藏的，插件的 `console.log` 会转发到**主进程终端**，前缀 `[plugin] <插件 id>`。
用 `npm run dev` 启动时直接可见。

- 完整 API 契约与全部会被真实校验的硬限制：上一层目录的 `artflow-plugin.d.ts`
- 应用内入口：插件管理器 → 更多菜单 →「插件开发指南」
