/**
 * pluginReload.ts —— 插件设置应用后的受控重载。
 *
 * 插件 profile 变更需要整页重载重新 materialize 贡献快照，但 location.reload()
 * 会触发 beforeunload——若被 App 的未保存更改守卫拦截，会误弹"Unsaved changes"
 * 确认框，且其确认按钮 window.close() 在 Electron 里会真关窗（整个应用退出）。
 * 本模块用同步标志让守卫识别"插件受控重载"并放行；模块状态无需跨文档存活，
 * beforeunload 在同一文档内同步读到标志即可。
 */

let pluginReloadPending = false;

/** 受控重载入口：置标志后整页刷新（仅本体根装配调用，插件面板经 manager.reload() 间接使用）。 */
export function reloadForPluginApply(): void {
  pluginReloadPending = true;
  window.location.reload();
}

/** beforeunload 守卫调用：是否为插件受控重载（读后即清，不影响同会话后续真实关闭拦截）。 */
export function consumePluginReloadFlag(): boolean {
  const pending = pluginReloadPending;
  pluginReloadPending = false;
  return pending;
}
