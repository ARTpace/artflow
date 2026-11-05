/** Generic renderer command surface. It deliberately renders contribution metadata only. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Kernel } from './kernel';
import {
  formatCommandShortcut,
  invokeCommandContribution,
  isCommandEnabled,
  listCommandContributions,
  resolveCommandText,
  searchCommandContributions,
  type CommandContribution,
} from './commands';
import { arbitrateShortcut, isEditableTarget as guardEditableTarget } from './shortcut-arbitration';
import { useLanguage } from '../utils/language-store';

interface CommandPaletteProps {
  kernel: Kernel;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Presentation deliberately retains its own dedicated keyboard controls. */
  commandSurfaceEnabled: boolean;
}

const isEditableTarget = guardEditableTarget;

const stopPaletteEvent = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/** Ctrl/⌘K opens a generic palette; plugin shortcut dispatch is only active outside editable and presentation contexts. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  kernel,
  isOpen,
  onOpen,
  onClose,
  commandSurfaceEnabled,
}) => {
  const language = useLanguage();
  const zho = language === 'zho';
  // 面板外壳文案跟随界面语言；命令自身的 title/description 由插件贡献、按语言解析。
  const copy = zho ? {
    paletteLabel: '命令面板',
    searchLabel: '搜索命令',
    searchPlaceholder: '搜索命令…',
    empty: '没有匹配的插件命令。',
    listLabel: '可用命令',
    footer: '↑↓ 移动 · Enter 执行 · Esc 关闭',
    count: (total: number) => `${total} 条插件命令`,
    runFailed: '命令执行失败。',
  } : {
    paletteLabel: 'Command Palette',
    searchLabel: 'Search commands',
    searchPlaceholder: 'Search commands…',
    empty: 'No plugin command matches this search.',
    listLabel: 'Available commands',
    footer: '↑↓ to move · Enter to run · Esc to close',
    count: (total: number) => `${total} plugin ${total === 1 ? 'command' : 'commands'}`,
    runFailed: 'Command failed.',
  };

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = listCommandContributions(kernel);
  const filtered = useMemo(() => searchCommandContributions(commands, query), [commands, query]);

  const runContribution = useCallback(async (contribution: CommandContribution) => {
    setRunError(null);
    try {
      const didRun = await invokeCommandContribution(kernel, contribution);
      if (didRun) onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[commands] failed to run ${contribution.id}:`, error);
      setRunError(message || copy.runFailed);
    }
  }, [kernel, onClose, copy.runFailed]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    setRunError(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex(previous => Math.min(previous, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const isPaletteShortcut = (event.ctrlKey || event.metaKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === 'k';

      if (isOpen) {
        if (isPaletteShortcut) {
          stopPaletteEvent(event);
          return;
        }
        if (event.key === 'Escape') {
          stopPaletteEvent(event);
          onClose();
          return;
        }
        if (event.key === 'ArrowDown' && filtered.length > 0) {
          stopPaletteEvent(event);
          setActiveIndex(previous => (previous + 1) % filtered.length);
          return;
        }
        if (event.key === 'ArrowUp' && filtered.length > 0) {
          stopPaletteEvent(event);
          setActiveIndex(previous => (previous - 1 + filtered.length) % filtered.length);
          return;
        }
        if (event.key === 'Enter') {
          const contribution = filtered[activeIndex];
          if (contribution && isCommandEnabled(kernel, contribution)) {
            stopPaletteEvent(event);
            void runContribution(contribution);
          }
          return;
        }
        return;
      }

      if (!commandSurfaceEnabled || isEditableTarget(event.target)) return;
      if (isPaletteShortcut) {
        stopPaletteEvent(event);
        onOpen();
        return;
      }
      if (event.repeat) return;
      // 快捷键裁决链：注册表定序 → 第一个匹配且可用者执行。
      const { winner } = arbitrateShortcut(kernel, event);
      if (!winner || !isCommandEnabled(kernel, winner.contribution)) return;
      stopPaletteEvent(event);
      void runContribution(winner.contribution);
    };

    // Capture lets an open palette retain Escape/Arrow/Enter before legacy window listeners see them.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeIndex, commandSurfaceEnabled, filtered, isOpen, kernel, onClose, onOpen, runContribution]);

  if (!isOpen) return null;

  return (
    <div
      role="presentation"
      data-bp-ui-scrim="" className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 px-4 pt-[min(18vh,9rem)] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        data-bp-ui-command=""
        aria-modal="true"
        aria-label={copy.paletteLabel}
        className="w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-neutral-950/95 text-white shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="border-b border-white/10 px-4 py-3">
          <label className="sr-only" htmlFor="artflow-command-search">{copy.searchLabel}</label>
          <input
            ref={inputRef}
            id="artflow-command-search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={copy.searchPlaceholder}
            autoComplete="off"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
          />
        </div>
        <div className="max-h-[min(28rem,calc(100vh-14rem))] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="rounded-xl px-3 py-8 text-center text-sm text-neutral-400">{copy.empty}</p>
          ) : (
            <ul className="space-y-1" aria-label={copy.listLabel}>
              {filtered.map((contribution, index) => {
                const command = contribution.value;
                const commandText = resolveCommandText(command, language);
                const enabled = isCommandEnabled(kernel, contribution);
                const shortcut = formatCommandShortcut(command.shortcut);
                return (
                  <li key={contribution.id}>
                    <button
                      type="button"
                      disabled={!enabled}
                      data-bp-ui-active={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => { void runContribution(contribution); }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${index === activeIndex
                        ? 'bg-sky-400/15 text-white'
                        : 'text-neutral-200 hover:bg-white/[0.07]'} disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{commandText.title}</span>
                        {commandText.description && <span className="mt-0.5 block truncate text-xs text-neutral-400">{commandText.description}</span>}
                      </span>
                      {shortcut && <kbd className="shrink-0 rounded-md border border-white/15 bg-black/25 px-1.5 py-0.5 text-[11px] text-neutral-300">{shortcut}</kbd>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-white/10 px-4 py-2 text-[11px] text-neutral-500">
          <span>{copy.footer}</span>
          <span>{copy.count(commands.length)}</span>
        </footer>
        {runError && <p role="alert" className="border-t border-rose-300/20 bg-rose-400/10 px-4 py-2 text-xs text-rose-100">{runError}</p>}
      </section>
    </div>
  );
};
