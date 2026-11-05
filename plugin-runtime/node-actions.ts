/**
 * Typed contract for context actions on canvas elements (`node_actions` slot).
 * Appears in context menus / action bars for selected cards (e.g. AI repaint, expand, prompt enrich).
 */

import type { Contribution, Kernel } from './kernel';
import type { Element } from '../types';
import { resolveLocalizedText, type LocalizedText, type UiLanguage } from './i18n';

export interface NodeActionContext {
  element: Element;
  selectedElements: readonly Element[];
  allElements: readonly Element[];
}

export interface NodeActionDefinition {
  /** 展示文案：字符串（各语言同文案）或按语言的解析函数。 */
  title: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  targetTypes?: readonly string[]; // If undefined, applies to all element types
  isApplicable?: (ctx: NodeActionContext) => boolean;
  run: (ctx: NodeActionContext, kernel: Kernel) => void | Promise<void>;
}

export type NodeActionContribution = Contribution<NodeActionDefinition>;

export function listNodeActionContributions(kernel: Kernel): readonly NodeActionContribution[] {
  return kernel.contributions.list<NodeActionDefinition>('node_actions');
}

/** 解析节点操作展示文案；宿主按当前界面语言调用。 */
export function resolveNodeActionText(
  definition: NodeActionDefinition,
  language: UiLanguage,
): { title: string; description?: string } {
  return {
    title: resolveLocalizedText(definition.title, language) ?? '',
    description: resolveLocalizedText(definition.description, language),
  };
}

export function getApplicableNodeActions(
  kernel: Kernel,
  ctx: NodeActionContext
): readonly NodeActionContribution[] {
  return listNodeActionContributions(kernel).filter(action => {
    if (action.value.targetTypes && !action.value.targetTypes.includes(ctx.element.type)) {
      return false;
    }
    if (action.value.isApplicable && !action.value.isApplicable(ctx)) {
      return false;
    }
    return true;
  });
}
