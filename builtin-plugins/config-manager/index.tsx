/**
 * config-manager —— 设置页的「设置预设」与「存储」两个分组。
 *
 * 拆成独立本体模块而不是塞进 core-settings：core-settings 是"用户偏好本身"（语言/外观/快捷键），
 * 这里是"用户数据的搬运与体检"（导出/导入/体积/来源）。两者的变更节奏与失败模式都不同，
 * 混在一个模块里会让"导出预设"这个动作的改动牵动快捷键录制那块保护代码。
 */
import type { ComponentType } from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import type { SettingsSectionContribution, SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { PresetsSection } from './presets-section';
import { StorageSection } from './storage-section';

const SECTIONS: {
  id: string;
  navPriority: number;
  label: (language: 'en' | 'zho') => string;
  component: ComponentType<SettingsSectionProps>;
}[] = [
  // navPriority 比 core-settings（40/30/20/10）低：这两页是"维护"性质，排在日常设置之后。
  { id: 'presets', navPriority: 5, label: lang => (lang === 'zho' ? '设置预设' : 'Presets'), component: PresetsSection },
  { id: 'storage', navPriority: 4, label: lang => (lang === 'zho' ? '存储' : 'Storage'), component: StorageSection },
];

/** Host-owned registration; never participates in the optional plugin lifecycle. */
export function activateConfigManager(ctx: Kernel): Effect {
  const disposers = SECTIONS.map(section =>
    ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
      id: `builtin.config-manager.${section.id}`,
      pluginId: 'builtin.config-manager',
      priority: section.navPriority,
      value: {
        label: section.label,
        component: section.component,
        navGroup: 'core',
      },
    }),
  );
  return () => disposers.forEach(dispose => dispose());
}
