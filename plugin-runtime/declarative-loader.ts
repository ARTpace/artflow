/**
 * Applies contributions from the userData plugin folder (declarative JSON manifests only).
 * The main process already rejected manifests that declare an executable entry, and has
 * resolved locale shard files into ready tables — this layer does no file system work.
 */

import { registerFormatAlias } from './format-handlers';
import { externalPluginStorage, isExternalPluginEnabled } from './external-plugin-prefs';
import type { LocaleBundle } from './i18n';
import type { SkinTokens } from './contributions';
import { SKIN_ENGINE_SERVICE, type SkinEngine, type SkinGalleryMetadata } from './skin-engine';
import type { SkinCustomizationDecl } from './skin-customization';
import type { Kernel } from './kernel';

/** Contribution ids must be `<ns>.<name>` and globally unique, hence the per-plugin prefix. */
const localeContributionId = (pluginId: string, language: string): string =>
  `${pluginId}.locale.${language.toLowerCase()}`;

/** 外部声明式皮肤的清单形状（主进程已校验；这里只消费）。 */
interface DeclarativeSkinEntry {
  id: string;
  name: string;
  mode?: 'dark' | 'light';
  tokens?: SkinTokens;
  nameI18n?: Record<string, string>;
  order?: number;
  tags?: string[];
  css?: string;
  customization?: SkinCustomizationDecl;
  preview?: { dark?: string; light?: string };
  gallery?: SkinGalleryMetadata;
}
interface DeclarativePluginResult {
  id: string;
  name: string;
  formatAliases: Array<{ extension: string; handlerId: string }>;
  locales?: LocaleBundle[];
  skins?: DeclarativeSkinEntry[];
}

/**
 * `storage` 是外部插件开关的来源，默认走主进程配置卷（`plugins.external.disabled`）。
 * 保留参数是为了让"停用某个外部插件"这条规则可以被单测精确注入，不依赖模块级单例状态。
 */
export async function applyDeclarativePlugins(
  kernel: Kernel,
  storage: Pick<Storage, 'getItem'> = externalPluginStorage,
): Promise<void> {
  const list = window.artflowApp?.listDeclarativePlugins;
  if (!list) return;
  try {
    const payload = await list();
    const plugins = payload.plugins as DeclarativePluginResult[];
    const engine = kernel.use(SKIN_ENGINE_SERVICE) as SkinEngine | null;
    for (const plugin of plugins) {
      if (!isExternalPluginEnabled(storage, plugin.id)) continue;
      for (const alias of plugin.formatAliases) {
        registerFormatAlias(alias.extension, alias.handlerId);
      }
      // 外部语言包进**同一个 locales 槽位**，与 builtin 插件走完全相同的合并路径 ——
      // 调用方只需在之后刷新一次 language-store 的补丁快照。
      for (const bundle of plugin.locales ?? []) {
        kernel.contributions.register<LocaleBundle>('locales', {
          id: localeContributionId(plugin.id, bundle.language),
          pluginId: plugin.id,
          value: bundle,
        });
      }
      // 外部声明式皮肤进**同一个 skins 槽位**，与 builtin 插件走完全相同的合并路径
      // （loader.stageSkins 透传）。皮肤 id（如 builtin.skin-default）必须保留，
      // 否则 skin-engine 的默认皮肤回退与混搭底座会失效。
      for (const skin of plugin.skins ?? []) {
        // 静态 CSS 覆盖层经引擎静态消毒（skin-css-sanitize）后登记；非法 CSS 只拒该皮肤，不影响其它。
        if (skin.css) {
          try {
            engine?.registerSkinCss(plugin.id, skin.id, skin.css);
          } catch (error) {
            console.warn(`[declarative-plugins] ${plugin.id} skin ${skin.id} css rejected`, error);
          }
        }
        kernel.contributions.register('skins', {
          id: skin.id,
          pluginId: plugin.id,
          value: {
            name: skin.name,
            mode: skin.mode ?? 'dark',
            tokens: (skin.tokens ?? {}) as SkinTokens,
            ...(skin.nameI18n ? { nameI18n: skin.nameI18n } : {}),
            ...(skin.order !== undefined ? { order: skin.order } : {}),
            ...(skin.tags ? { tags: skin.tags } : {}),
            ...(skin.css ? { css: skin.css } : {}),
            ...(skin.customization ? { customization: skin.customization } : {}),
            ...(skin.preview ? { preview: skin.preview } : {}),
            ...(skin.gallery ? { gallery: skin.gallery } : {}),
          },
        });
      }
    }
  } catch (error) {
    console.warn('[declarative-plugins] skipped external manifests', error);
  }
}
