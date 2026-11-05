/**
 * Typed adapter for the existing `commands` contribution slot.
 * Command business belongs to plugins; this module only defines deterministic discovery and dispatch.
 */

import type { Contribution, Kernel } from './kernel';
import { resolveLocalizedText, type LocalizedText, type UiLanguage } from './i18n';

export interface CommandKeybinding {
  /** `KeyboardEvent.key`, normalized to lowercase (for example `f` or `k`). */
  key: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface CommandDefinition {
  /** 展示文案：字符串（各语言同文案）或按语言的解析函数。 */
  title: LocalizedText;
  description?: LocalizedText;
  group?: string;
  keywords?: readonly string[];
  shortcut?: CommandKeybinding;
  /** A command that is currently unavailable remains visible but cannot execute. */
  isEnabled?: (kernel: Kernel) => boolean;
  /**
   * MCP 投影元数据。真正能否出现在工具面，还要看所属插件 manifest 的 mcp.export 是否点名这条命令。
   * 缺省按写入、非破坏处理。
   */
  mcp?: {
    impact?: 'read' | 'write';
    destructive?: boolean;
  };
  run: (kernel: Kernel) => void | Promise<void>;
}

export type CommandContribution = Contribution<CommandDefinition>;

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

const normalizeText = (value: string): string => value.trim().toLowerCase();

const normalizedKey = (key: string): string => normalizeText(key);

/** 检索面固定覆盖全部语言档：中文界面下敲 "undo" 同样能找到「撤销」。 */
const SEARCH_LANGUAGES: readonly UiLanguage[] = ['zho', 'en'];

/** 解析命令的展示文案（title 必需，description 可选）。UI 消费端统一走这里。 */
export function resolveCommandText(
  definition: CommandDefinition,
  language: UiLanguage,
): { title: string; description?: string } {
  return {
    title: resolveLocalizedText(definition.title, language) ?? '',
    description: resolveLocalizedText(definition.description, language),
  };
}

export function listCommandContributions(kernel: Kernel): readonly CommandContribution[] {
  return kernel.contributions.list<CommandDefinition>('commands');
}

/** Space-separated terms must each occur in the plugin-supplied searchable metadata. */
export function searchCommandContributions(
  contributions: readonly CommandContribution[],
  query: string,
): readonly CommandContribution[] {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return contributions;
  return contributions.filter(({ value }) => {
    const localized: string[] = [];
    for (const language of SEARCH_LANGUAGES) {
      localized.push(resolveLocalizedText(value.title, language) ?? '');
      localized.push(resolveLocalizedText(value.description, language) ?? '');
    }
    const haystack = normalizeText([
      ...localized,
      value.group ?? '',
      ...(value.keywords ?? []),
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

/** Exact modifier matching prevents an unrelated browser/editor shortcut from being claimed. */
export function matchesCommandKeybinding(binding: CommandKeybinding, event: KeyEventLike): boolean {
  return normalizedKey(binding.key) === normalizedKey(event.key)
    && Boolean(binding.mod) === Boolean(event.ctrlKey || event.metaKey)
    && Boolean(binding.alt) === Boolean(event.altKey)
    && Boolean(binding.shift) === Boolean(event.shiftKey);
}

/** Registry order (priority, then id) is the deterministic shortcut conflict policy for the first slice. */
export function resolveCommandShortcut(kernel: Kernel, event: KeyEventLike): CommandContribution | undefined {
  return listCommandContributions(kernel).find(contribution =>
    contribution.value.shortcut && matchesCommandKeybinding(contribution.value.shortcut, event));
}

/** A faulty enabled predicate fails closed instead of making the palette or global key listener crash. */
export function isCommandEnabled(kernel: Kernel, contribution: CommandContribution): boolean {
  try {
    return contribution.value.isEnabled?.(kernel) ?? true;
  } catch (error) {
    console.error(`[commands] failed to evaluate ${contribution.id}:`, error);
    return false;
  }
}

/** Returns false for a disabled command; errors from an enabled command deliberately remain visible to the caller. */
export async function invokeCommandContribution(kernel: Kernel, contribution: CommandContribution): Promise<boolean> {
  if (!isCommandEnabled(kernel, contribution)) return false;
  await contribution.value.run(kernel);
  return true;
}

export function formatCommandShortcut(shortcut: CommandKeybinding | undefined): string | null {
  if (!shortcut) return null;
  const parts: string[] = [];
  if (shortcut.mod) parts.push('Ctrl/⌘');
  if (shortcut.alt) parts.push('Alt');
  if (shortcut.shift) parts.push('Shift');
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return parts.join('+');
}
