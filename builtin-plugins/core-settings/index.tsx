/**
 * core-settings —— 设置面板核心页（本体 CanvasSettings 的模块化组织）。
 * 组件语义与迁移前一致（保护条款）；状态经 settings.ui-bridge 服务读写，
 * 共享 UI 原语来自 plugins/settings-ui。侧栏 navGroup='core'。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { SETTINGS_UI_BRIDGE_SERVICE, type SettingsUiBridge } from '../../plugin-runtime/settings-bridge';
import type { SettingsSectionContribution, SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { SectionBlock, SettingsRow, Segmented } from '../../plugin-runtime/settings-ui';
import { listAvailableLanguages } from '../../utils/language-store';
import { buildShortcutRegistry, findShortcutConflicts, bindingIdentity, type ShortcutRegistryEntry } from '../../plugin-runtime/shortcut-arbitration';
import { resolveCommandText } from '../../plugin-runtime/commands';
import { ACCEPTED_FILE_TYPES_STRING } from '../../utils/formatDetector';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import type { Hotkey, PresentationHotkeys, WheelAction } from '../../types';

const useBridge = (kernel: Kernel): SettingsUiBridge =>
  kernel.use(SETTINGS_UI_BRIDGE_SERVICE) as SettingsUiBridge;

const formatHotkey = (hotkey: Hotkey): string => {
  if (!hotkey) return '';
  const parts: string[] = [];
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  if (hotkey.metaOrCtrlKey) parts.push(isMac ? '⌘' : 'Ctrl');
  if (hotkey.altKey) parts.push(isMac ? '⌥' : 'Alt');
  if (hotkey.shiftKey) parts.push('⇧');
  let keyName = hotkey.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();
  parts.push(keyName);
  return parts.join(' + ');
};

/** 快捷键录制（原 CanvasSettings 逻辑原样迁入）。 */
const useHotkeyRecorder = (
  recordingKey: string | null,
  onRecord: (hotkey: Hotkey) => void,
): void => {
  useEffect(() => {
    if (!recordingKey) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      onRecord({
        key: e.key,
        metaOrCtrlKey: e.metaKey || e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingKey, onRecord]);
};

/**
 * 语言码 → 展示名。
 * 语习惯用名（中文写「中文」、英文写「English」）保证内置两档在所有平台上都稳定；
 * 语言包注册的新语言码交给 Intl.DisplayNames 按**该语言本身**取名（jpn → 日本語、
 * deu → Deutsch），比裸显示语言码友好得多；Intl 不认的码再回落原样。
 */
const languageLabel = (code: string): string => {
  if (code === 'en') return 'English';
  if (code === 'zho') return '中文';
  try {
    const display = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (display && display !== code) return display.charAt(0).toUpperCase() + display.slice(1);
  } catch {
    // Intl 不支持该语言码（或运行环境裁剪了 Intl）→ 回落原样显示
  }
  return code;
};

const GeneralSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const bridge = useBridge(kernel).general;
  const fileLabel = language === 'zho';
  // 选项来自「内置底座 + 已注册语言包」，而不是写死两档 —— 注册语言包的插件会自动出现在这里。
  const languageOptions = listAvailableLanguages().map(code => ({ value: code, label: languageLabel(code) }));
  return (
    <>
      <SectionBlock title={fileLabel ? 'API 密钥' : 'API Key'}>
        <input
          type="password"
          value={bridge.apiKey}
          onChange={(e) => bridge.setApiKey(e.target.value)}
          placeholder={fileLabel ? '输入 API 密钥…' : 'Enter API key…'}
          className="w-full px-3 py-2 text-sm bg-black/20 border border-white/10 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        />
        <div className="text-xs text-gray-400">
          {bridge.apiKey ? (fileLabel ? '密钥已设置' : 'API key is set') : (fileLabel ? '需要配置 API 密钥后才能使用 AI 功能' : 'An API key is required for AI features')}
        </div>
      </SectionBlock>
      <SectionBlock title={fileLabel ? '语言' : 'Language'}>
        <SettingsRow label={fileLabel ? '语言' : 'Language'}>
          <Segmented
            options={languageOptions}
            active={bridge.language}
            onSelect={value => bridge.setLanguage(value)}
          />
        </SettingsRow>
      </SectionBlock>
      {/* 应用级操作放通用页末尾：与 API 密钥/语言同属"会话级"设置，且便于随手重启。 */}
      <AppSessionSection kernel={kernel} language={language} />
    </>
  );
};

/**
 * 应用会话：重启整个应用（Electron 主进程 relaunch + 清理退出，窗口随进程销毁）。
 * 能力经 host.platform 消费（插件面板禁直连渲染层 preload 桥）；无桥环境（浏览器模式）按钮禁用。
 * 重启语义即丢弃当前会话（含未保存改动），故点击后先经 window.confirm 二次确认
 * （与 builtin.asset-library / ui-plugin-manager 的既有确认方式一致）。
 */
const AppSessionSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const zho = language === 'zho';
  const host = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const handleRestart = async (): Promise<void> => {
    if (restarting) return;
    const confirmed = window.confirm(zho
      ? '重启会关闭当前窗口并重新启动 Artflow，未保存的改动将丢失。确定要重启吗？'
      : 'Restart closes this window and relaunches Artflow; unsaved changes will be lost. Continue?');
    if (!confirmed) return;
    setNotice(null);
    setRestarting(true);
    try {
      const result = await host.restartApp();
      // 主进程先回执再退出：ok 时窗口随即销毁，按钮无需（也无法）恢复原态。
      if (result.ok) return;
      setRestarting(false);
      setNotice(zho ? '当前环境不支持重启应用，请手动重启。' : 'Restart is unavailable here; please restart manually.');
    } catch (error) {
      setRestarting(false);
      setNotice(zho ? '重启请求失败，请手动重启。' : 'Restart request failed; please restart manually.');
      console.error('[core-settings] restart request failed:', error);
    }
  };
  return (
    <SectionBlock title={zho ? '应用重启' : 'Application Restart'}>
      <SettingsRow label={zho ? '重启 Artflow' : 'Restart Artflow'}>
        <button
          type="button"
          disabled={restarting || !host.canRestartApp}
          title={host.canRestartApp ? undefined : (zho ? '当前环境不支持重启应用' : 'Restart is unavailable in this environment')}
          onClick={() => { void handleRestart(); }}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {restarting ? (zho ? '重启中…' : 'Restarting…') : (zho ? '重启应用' : 'Restart App')}
        </button>
      </SettingsRow>
      <div className="text-xs text-neutral-500">
        {zho
          ? '重启会重新加载主进程与全部插件；未保存的改动将丢弃。'
          : 'Restart reloads the main process and every plugin; unsaved changes are discarded.'}
      </div>
      {notice && <div className="text-xs text-amber-100">{notice}</div>}
    </SectionBlock>
  );
};

const AppearanceSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const { available, openThemeStudio } = useBridge(kernel).appearance;
  const zho = language === 'zho';
  return (
    <SectionBlock title={zho ? '主题与界面外观' : 'Themes & interface'}>
      <div className="space-y-3 text-sm text-[var(--bp-ui-muted)]">
        <p>{zho
          ? '在主题工作台选择整套主题，或分别调节界面配色、控件、字体和工作区背景。预览满意后再应用。'
          : 'Choose a theme or adjust interface colors, controls, fonts and the workspace background. Preview before applying.'}</p>
        <button type="button" disabled={!available} onClick={openThemeStudio} data-bp-ui-action="primary"
          className="rounded-lg border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40">
          {zho ? '打开主题工作台 ↗' : 'Open Theme Studio ↗'}
        </button>
      </div>
    </SectionBlock>
  );
};

const CanvasSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const bridge = useBridge(kernel).canvas;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zho = language === 'zho';
  return (
    <SectionBlock title={zho ? '当前画板背景' : 'Current board background'}>
      <p className="text-xs leading-5 text-[var(--bp-ui-muted)]">{zho ? '仅修改当前画板，优先于主题的工作区背景。主题壁纸与默认点阵请到主题工作台设置。' : 'Only affects this board and overrides the theme workspace background. Theme wallpapers and default dots are in Theme Studio.'}</p>
      <SettingsRow label={zho ? '背景颜色' : 'Background Color'}>
        <div className="relative h-7 w-9 overflow-hidden rounded border border-white/15" style={{ backgroundColor: bridge.canvasBackgroundColor.startsWith('url') ? '#111827' : bridge.canvasBackgroundColor }}>
          <input type="color" value={bridge.canvasBackgroundColor.startsWith('url') ? '#111827' : bridge.canvasBackgroundColor} onChange={e => bridge.onCanvasBackgroundColorChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </div>
      </SettingsRow>
      <SettingsRow label={zho ? '上传背景图' : 'Upload Background'}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) {
              bridge.onCanvasBackgroundImageChange(e.target.files[0]);
              e.target.value = '';
            }
          }}
          accept={ACCEPTED_FILE_TYPES_STRING}
          className="hidden"
        />
        <button onClick={() => fileInputRef.current?.click()} className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          {zho ? '上传' : 'Upload'}
        </button>
      </SettingsRow>
    </SectionBlock>
  );
};

const HotkeysSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const { wheelAction, setWheelAction, generateHotkey, setGenerateHotkey, presentationHotkeys, setPresentationHotkeys } = useBridge(kernel).hotkeys;
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const zho = language === 'zho';

  // 快捷键冲突可见性：命令槽注册表 + 同组合键冲突组（裁决顺序 priority DESC → id ASC）。
  const registry = React.useMemo(() => buildShortcutRegistry(kernel), [kernel]);
  const conflictIdentities = React.useMemo(
    () => new Set(findShortcutConflicts(registry).map(group => bindingIdentity(group[0].binding))),
    [registry],
  );
  const conflictEntries = React.useMemo(
    () => new Map(findShortcutConflicts(registry).flatMap(group => group.map(entry => [entry.contribution.id, group] as const))),
    [registry],
  );

  useHotkeyRecorder(recordingKey, hotkey => {
    if (recordingKey === 'generate') setGenerateHotkey(hotkey);
    else if (recordingKey) setPresentationHotkeys({ ...presentationHotkeys, [recordingKey]: hotkey });
    setRecordingKey(null);
  });

  const presentationHotkeyMap: { key: keyof PresentationHotkeys; label: string }[] = [
    { key: 'nextSmooth', label: zho ? '下一页（平滑）' : 'Next (smooth)' },
    { key: 'prevSmooth', label: zho ? '上一页（平滑）' : 'Previous (smooth)' },
    { key: 'nextDirect', label: zho ? '下一页（直接）' : 'Next (direct)' },
    { key: 'prevDirect', label: zho ? '上一页（直接）' : 'Previous (direct)' },
  ];

  return (
    <>
      <SectionBlock title={zho ? '鼠标滚轮' : 'Mouse Wheel'}>
        <SettingsRow label={zho ? '鼠标滚轮' : 'Mouse Wheel'}>
          <Segmented
            options={[{ value: 'zoom', label: zho ? '缩放' : 'Zoom' }, { value: 'pan', label: zho ? '平移' : 'Pan' }]}
            active={wheelAction}
            onSelect={value => setWheelAction(value as WheelAction)}
          />
        </SettingsRow>
      </SectionBlock>
      <SectionBlock title={zho ? '生成快捷键' : 'Generate Hotkey'}>
        <SettingsRow label={zho ? '生成快捷键' : 'Generate Hotkey'}>
          <span className="min-w-[7rem] rounded-md bg-black/25 px-2.5 py-1 text-center font-mono text-sm text-neutral-200">{formatHotkey(generateHotkey)}</span>
          <button onClick={() => setRecordingKey('generate')} className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
            {recordingKey === 'generate' ? (zho ? '按下按键…' : 'Press a key…') : (zho ? '设置' : 'Set')}
          </button>
        </SettingsRow>
      </SectionBlock>
      <SectionBlock title={zho ? '放映快捷键' : 'Presentation Hotkeys'}>
        {presentationHotkeyMap.map(({ key, label }) => (
          <SettingsRow key={key} label={label}>
            <span className="min-w-[7rem] rounded-md bg-black/25 px-2.5 py-1 text-center font-mono text-sm text-neutral-200">{formatHotkey(presentationHotkeys[key])}</span>
            <button onClick={() => setRecordingKey(key)} className="w-24 rounded-md bg-white/10 px-3 py-1.5 text-center text-sm hover:bg-white/20">
              {recordingKey === key ? (zho ? '按下按键…' : 'Press a key…') : (zho ? '设置' : 'Set')}
            </button>
          </SettingsRow>
        ))}
      </SectionBlock>
      <SectionBlock title={zho ? '命令快捷键' : 'Command Shortcuts'}>
        {registry.length === 0 && (
          <p className="px-0.5 text-xs text-neutral-500">{zho ? '没有已注册的命令快捷键。' : 'No command shortcuts registered.'}</p>
        )}
        {registry.map(entry => {
          const identity = bindingIdentity(entry.binding);
          const conflicted = conflictIdentities.has(identity);
          const others = (conflictEntries.get(entry.contribution.id) ?? [])
            .filter(other => other.contribution.id !== entry.contribution.id)
            .map(other => resolveCommandText(other.contribution.value, language).title);
          return (
            <div key={entry.contribution.id} className="flex items-center justify-between gap-2 py-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm text-neutral-200">{resolveCommandText(entry.contribution.value, language).title}</span>
                {conflicted && (
                  <span
                    className="shrink-0 rounded-full bg-amber-300/15 px-2 py-0.5 text-[10px] font-medium text-amber-100"
                    title={zho ? `组合键被占用：${others.join('、')}` : `Key also used by: ${others.join(', ')}`}
                  >
                    {zho ? `冲突 ×${others.length}` : `conflict ×${others.length}`}
                  </span>
                )}
              </div>
              <code className={`shrink-0 rounded bg-black/25 px-2 py-0.5 font-mono text-xs ${conflicted ? 'text-amber-100' : 'text-neutral-300'}`}>
                {entry.display}
              </code>
            </div>
          );
        })}
        <p className="px-0.5 pt-1 text-[11px] leading-4 text-neutral-500">
          {zho
            ? '同组合键冲突时，按注册顺序（插件优先级 → id）第一个可用命令生效。'
            : 'On conflict, the first available command in registry order (plugin priority → id) wins.'}
        </p>
      </SectionBlock>
    </>
  );
};

const SECTIONS: { id: string; navPriority: number; label: (language: 'en' | 'zho') => string; component: React.FC<SettingsSectionProps> }[] = [
  { id: 'general', navPriority: 40, label: lang => (lang === 'zho' ? '通用' : 'General'), component: GeneralSection },
  { id: 'appearance', navPriority: 30, label: lang => (lang === 'zho' ? '外观' : 'Appearance'), component: AppearanceSection },
  { id: 'canvas', navPriority: 20, label: lang => (lang === 'zho' ? '画布' : 'Canvas'), component: CanvasSection },
  { id: 'hotkeys', navPriority: 10, label: lang => (lang === 'zho' ? '快捷键' : 'Hotkeys'), component: HotkeysSection },
];

/** Host-owned registration; never participates in the optional plugin lifecycle. */
export function activateCoreSettings(ctx: Kernel): Effect {
  const disposers = SECTIONS.map(section =>
    ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
      id: `builtin.core-settings.${section.id}`,
      pluginId: 'builtin.core-settings',
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
