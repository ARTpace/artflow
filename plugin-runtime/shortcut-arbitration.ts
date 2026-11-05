/**
 * shortcut-arbitration.ts —— 快捷键裁决链（P2·本体：快捷键系统，第一片）。
 * 链序：输入态守卫（isEditableTarget）→ 命令槽注册表（priority DESC → id ASC 定序）
 * → 内置遗留默认（useKeyboardShortcuts/App 的 window 监听兜底，未命中命令槽时自然回落）。
 * 裁决与冲突检测同源：同一组合键被多个命令声明即为冲突，注册表同时供设置面板做冲突可见性。
 */

import type { Kernel } from './kernel';
import { listCommandContributions, matchesCommandKeybinding, formatCommandShortcut, type CommandContribution, type CommandKeybinding } from './commands';

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** 输入态守卫：焦点在文本输入/内容可编辑区时，命令快捷键不参与裁决。 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
};

export interface ShortcutRegistryEntry {
  contribution: CommandContribution;
  binding: CommandKeybinding;
  /** 展示串（Ctrl/⌘+Alt+Shift+K 形态）。 */
  display: string;
}

/** 组合键归一身份：mod(⌘/Ctrl)/alt/shift + key 小写。 */
export const bindingIdentity = (binding: CommandKeybinding): string => [
  binding.mod ? 'mod' : '',
  binding.alt ? 'alt' : '',
  binding.shift ? 'shift' : '',
  binding.key.trim().toLowerCase(),
].filter(Boolean).join('+');

/** 注册表：所有声明了 shortcut 的命令，按 priority DESC → id ASC 定序（裁决顺序即列表顺序）。 */
export const buildShortcutRegistry = (kernel: Kernel): readonly ShortcutRegistryEntry[] =>
  listCommandContributions(kernel)
    .filter(contribution => Boolean(contribution.value.shortcut))
    .map(contribution => ({
      contribution,
      binding: contribution.value.shortcut!,
      display: formatCommandShortcut(contribution.value.shortcut) ?? '',
    }))
    .sort((a, b) =>
      (b.contribution.priority - a.contribution.priority)
      || a.contribution.id.localeCompare(b.contribution.id));

/** 冲突分组：同一 bindingIdentity 出现 ≥2 条即为冲突组。 */
export const findShortcutConflicts = (registry: readonly ShortcutRegistryEntry[]): readonly (readonly ShortcutRegistryEntry[])[] => {
  const groups = new Map<string, ShortcutRegistryEntry[]>();
  for (const entry of registry) {
    const identity = bindingIdentity(entry.binding);
    const bucket = groups.get(identity) ?? [];
    bucket.push(entry);
    groups.set(identity, bucket);
  }
  return [...groups.values()].filter(bucket => bucket.length > 1);
};

export interface ShortcutArbitration {
  /** 赢家（注册表定序后第一个匹配且可用的命令）；无可执行命令为 undefined。 */
  winner?: ShortcutRegistryEntry;
  /** 与赢家同组合键的其他命令（裁决牺牲者，供诊断/展示）。 */
  conflicts: readonly ShortcutRegistryEntry[];
}

/** 裁决：按注册表定序取第一个匹配者；同组合键其余命令进入 conflicts。 */
export const arbitrateShortcut = (kernel: Kernel, event: KeyEventLike): ShortcutArbitration => {
  const registry = buildShortcutRegistry(kernel);
  const matched = registry.filter(entry => matchesCommandKeybinding(entry.binding, event));
  if (matched.length === 0) return { conflicts: [] };
  return { winner: matched[0], conflicts: matched.slice(1) };
};
