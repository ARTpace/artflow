/** Typed, trusted-renderer contract for `ui_panels` contributions. */
import type { ComponentType } from 'react';
import type { Contribution, Kernel } from './kernel';
import { resolveLocalizedText, type LocalizedText, type UiLanguage } from './i18n';

export interface PluginPanelProps {
  /** Explicit host boundary: panels collaborate through registered services, never sibling imports. */
  kernel: Kernel;
  onClose: () => void;
  /** When the host already renders a window frame (title bar / move handle / close), panels skip their own header to avoid duplication. */
  chromeless?: boolean;
}

export interface PluginPanelContribution {
  /** 展示文案：字符串（各语言同文案）或按语言的解析函数。 */
  title: LocalizedText;
  description?: LocalizedText;
  component: ComponentType<PluginPanelProps>;
  /** Generic presentation hint; floating panels are movable and non-modal. */
  presentation?: 'standard' | 'wide' | 'floating';
  /** 仅 floating 生效的宽度档：sm=30rem（默认）· md=38rem · lg=46rem，实际类名由宿主映射。 */
  floatingWidth?: 'sm' | 'md' | 'lg';
  /** Generic TopBar quick entry; no plugin ID is hard-coded in the shell. */
  quickEntry?: 'appearance';
}

export type PluginPanelRegistryEntry = Contribution<PluginPanelContribution>;

/** 解析面板展示文案；宿主（PluginPanelHost）按当前界面语言调用。 */
export function resolvePanelText(
  contribution: PluginPanelContribution,
  language: UiLanguage,
): { title: string; description?: string } {
  return {
    title: resolveLocalizedText(contribution.title, language) ?? '',
    description: resolveLocalizedText(contribution.description, language),
  };
}

/** Stable registry projection used by generic hosts and diagnostics. */
export const listPanelContributions = (kernel: Kernel): readonly PluginPanelRegistryEntry[] =>
  kernel.contributions.list<PluginPanelContribution>('ui_panels');
