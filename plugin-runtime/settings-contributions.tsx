/** Typed, trusted-renderer contract for Settings sections contributed by builtin plugins. */
import type { ComponentType } from 'react';
import type { Contribution, Kernel } from './kernel';
import type { UiLanguage } from './i18n';

/**
 * 语言联合类型收敛到 plugins/i18n 的 UiLanguage（单一真相）。
 * 保留本别名是为了不动既有导入方（menu-contributions / 各 builtin 插件）。
 */
export type SettingsSectionLanguage = UiLanguage;

export interface SettingsSectionProps {
  /** Settings extensions collaborate through services; they never import App or sibling builtins. */
  kernel: Kernel;
  language: SettingsSectionLanguage;
}

export interface SettingsSectionContribution {
  label: (language: SettingsSectionLanguage) => string;
  component: ComponentType<SettingsSectionProps>;
  /** 侧栏分组：core=核心设置组（优先展示），extensions=扩展组。缺省 extensions。 */
  navGroup?: 'core' | 'extensions';
}

export type SettingsSectionRegistryEntry = Contribution<SettingsSectionContribution>;

/** Stable projection for the generic Settings host and diagnostics. */
export const listSettingsSectionContributions = (kernel: Kernel): readonly SettingsSectionRegistryEntry[] =>
  kernel.contributions.list<SettingsSectionContribution>('settings_sections');
