/**
 * locale-contributions.ts —— 界面语言包槽位的读取面。
 *
 * 与 commands.ts / ai-providers.ts 等契约同构：插件用 ctx.register('locales', { id, value })
 * 注册补丁，宿主在启动期（root.render 之前）一次性取出并注入语言 store。
 *
 * 为什么不在插件里直接调用 store：plugins/ 下的模块必须能被自检脚本（node）直接 require，
 * 而 utils/language-store.ts 依赖 React。保持这条依赖方向，check 链就不会被拖下水。
 */
import type { Kernel } from './kernel';
import type { LocaleBundle } from './i18n';

/** 槽位名与 kernel.ts 的 SLOTS 保持一致。 */
export const LOCALES_SLOT = 'locales' as const;

/**
 * 取出所有语言包补丁。list() 已按 priority 降序 + id tie-break 排序，
 * 因此后注册的补丁在高优先级前提下稳定覆盖前一个（与 skins 的合成顺序同语义）。
 */
export function listLocaleContributions(kernel: Kernel): LocaleBundle[] {
  return kernel.contributions.list<LocaleBundle>(LOCALES_SLOT).map(entry => entry.value);
}
