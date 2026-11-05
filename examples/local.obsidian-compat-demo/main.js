/**
 * Obsidian 风格的 artflow 插件 —— 与 Obsidian 插件源码结构完全一致：
 *   const { Plugin } = require('obsidian');
 *   module.exports = class extends Plugin { async onload() { ... } };
 * 沙箱通过 module.exports 自动检测进入 obsidian-compat 激活路径，无需 definePlugin。
 */
const { Plugin, Notice, moment, Platform, normalizePath } = require('obsidian');

module.exports = class ObsidianCompatDemoPlugin extends Plugin {
  async onload() {
    // loadData/saveData：等价 Obsidian 的插件目录 data.json（≤256KB，原子写）。
    const state = (await this.loadData()) || { launches: 0 };
    state.launches += 1;
    await this.saveData(state);

    // addCommand：等价 Obsidian 命令面板（id 自动加插件前缀）。
    this.addCommand({
      id: 'greet',
      name: 'Greet the compat layer',
      callback: () => {
        new Notice(`${state.launches} launch(es) at ${moment().format('YYYY-MM-DD HH:mm:ss')} (desktop=${Platform.isDesktop})`);
      },
    });

    // addSettingTab：Obsidian 用 DOM 画 Setting；这里给 tab 一个 settingsSchema 数组，
    // 控件值自动存进同一个 data.json（等价 PluginSettingTab + Setting 的声明式版）。
    this.addSettingTab({
      settingsSchema: [
        { type: 'text', key: 'greeting', label: '问候语', default: 'Hello from an Obsidian-style plugin' },
        { type: 'toggle', key: 'verbose', label: '详细输出', default: false },
        { type: 'note', key: 'about', label: '提示', text: '值保存在插件目录的 data.json，与 loadData/saveData 共用。' },
      ],
    });

    // registerEvent：接受 { unsubscribe() } 形状的事件引用（onunload 时机见指南说明）。
    this.registerEvent({ unsubscribe: () => console.log('[compat-demo] event unsubscribed') });
    console.log(`[compat-demo] onload done, path=${normalizePath('a/b\\c')}`);
  }
};
