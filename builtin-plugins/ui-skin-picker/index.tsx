import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { PluginPanelContribution } from '../../plugin-runtime/panel-contributions';
import { bi } from '../../plugin-runtime/i18n';
import { SKIN_ENGINE_SERVICE, type SkinEngine } from '../../plugin-runtime/skin-engine';
import { ThemeStudio } from './ThemeStudio';
import manifest from './manifest.json';
// 工具界面的主题映射（原 index.css 里的 UNIFIED UI THEME 段）由主题插件持有，
// 经 SkinEngine 以「基座 <style>」注入并常驻：它是整套界面能跟随主题切换的底层规则，
// 因此从本体的 index.css 迁到这里，本体样式表不再承载任何主题映射。
import baseThemeCss from './ui-theme-map.css?raw';

export const uiSkinPickerPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const engine = ctx.use(SKIN_ENGINE_SERVICE) as SkinEngine;
    const disposers = [
      // 基座映射常驻（与皮肤是否激活无关）：默认皮肤也需要它。
      engine.registerBaseThemeCss(manifest.id, baseThemeCss),
      // 主题工作台只以「悬浮面板」形态出现：非模态、可拖拽，背景界面实时可见，
      // 调参数时整套工具立刻预览，关闭即还原未应用的预览。
      ctx.contributions.register<PluginPanelContribution>('ui_panels', {
        id: 'builtin.panel-skin-picker',
        pluginId: 'builtin.ui-skin-picker',
        priority: 10,
        value: {
          title: bi('主题工作台', 'Theme Studio'),
          description: bi('统一设置整套工具界面，浏览、预览、应用和收藏主题。', 'Style the entire interface; browse, preview, apply and save themes.'),
          component: ThemeStudio,
          presentation: 'floating',
          floatingWidth: 'lg',
          quickEntry: 'appearance',
        },
      }),
    ];
    return () => disposers.forEach(dispose => dispose());
  },
});
