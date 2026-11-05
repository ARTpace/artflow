import React from 'react';
import type { ResolvedSkinTokens } from '../../plugin-runtime/contributions';
import { resolveUiChrome, DEFAULT_CANVAS_BACKGROUND, DEFAULT_CANVAS_DOT_COLOR, DEFAULT_CANVAS_DOT_SIZE, DEFAULT_CANVAS_DOT_OPACITY, DEFAULT_CANVAS_GRID, DEFAULT_FONT_UI_STACK, DEFAULT_FONT_CONTENT_STACK, type UiThemeMode, type UiThemeSettings, type UiButtonStyle } from '../../plugin-runtime/ui-theme-settings';

interface UiThemeControlsProps {
  zh: boolean;
  settings: UiThemeSettings;
  tokens: ResolvedSkinTokens;
  onChange: (patch: Partial<UiThemeSettings>) => void;
  onMode: (mode: UiThemeMode) => void;
}
const title = (zh: boolean, cn: string, en: string) => zh ? cn : en;
const parseColor = (value: string, fallback: string): string => {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(value);
  if (!match) return fallback;
  return `#${match.slice(1, 4).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('')}`;
};
const inferredOpacity = (surface: string): number => {
  const match = /^rgba\([^,]+,[^,]+,[^,]+,\s*(0?\.\d+|1)\s*\)$/.exec(surface);
  return match ? Math.min(1, Math.max(0.55, Number(match[1]))) : 0.9;
};

/** Keys whose `null` means "inherit from the active theme" — used for per-group custom badges and resets. */
type NullableKey =
  | 'accent' | 'surface' | 'surfaceOpacity' | 'buttonColor' | 'buttonOpacity'
  | 'radius' | 'canvasBg' | 'animationAccent' | 'shadowScale' | 'canvasDots'
  | 'dotColor' | 'dotSize' | 'dotOpacity' | 'cardRadius' | 'fontUi'
  | 'fontContent' | 'gridColor' | 'gridWidth';

const ResetIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3.5 8a4.5 4.5 0 1 1 1.3 3.2M3.5 8V5M3.5 8h3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Sticky-headed group of related controls with a custom/reset affordance. Always expanded; tab switching replaces per-group collapse. */
const Group: React.FC<{
  label: string;
  zh: boolean;
  fields?: NullableKey[];
  settings: UiThemeSettings;
  onChange: (patch: Partial<UiThemeSettings>) => void;
  panelId?: string;
  labelledBy?: string;
  children: React.ReactNode;
}> = ({ label, zh, fields = [], settings, onChange, panelId, labelledBy, children }) => {
  const customized = fields.some(k => (settings as Record<string, unknown>)[k] != null);
  const reset = () => {
    const patch: Partial<UiThemeSettings> = {};
    for (const k of fields) if ((settings as Record<string, unknown>)[k] != null) (patch as Record<string, null>)[k] = null;
    if (Object.keys(patch).length) onChange(patch);
  };
  return (
    <section data-bp-group="" role={panelId ? 'tabpanel' : undefined} id={panelId} aria-labelledby={labelledBy}>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-xl border border-white/10 bg-[rgba(17,21,26,0.82)] px-3 py-2 backdrop-blur" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 className="truncate text-xs font-semibold text-slate-100">{label}</h3>
        {customized && <span className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-300">{zh ? '已自定义' : 'Custom'}</span>}
        {customized && <button type="button" onClick={reset}
          className="shrink-0 rounded-md border border-white/15 px-2 py-1 text-[10px] text-slate-200 transition-colors hover:bg-white/10">{zh ? '还原' : 'Reset'}</button>}
      </header>
      <div className="space-y-2.5 rounded-b-xl border border-t-0 border-white/10 p-3">{children}</div>
    </section>
  );
};

/** Universal knobs for the actual application's visual chrome, not per-component color overrides. */
export const UiThemeControls: React.FC<UiThemeControlsProps> = ({ zh, settings, tokens, onChange, onMode }) => {
  const chrome = resolveUiChrome(tokens, settings);
  const mode = chrome.mode;
  const accent = settings.accent ?? parseColor(tokens.color.accent, '#22d3ee');
  const surface = settings.surface ?? parseColor(chrome.vars['--bp-ui-surface'], mode === 'dark' ? '#181e26' : '#f9fcfd');
  const buttonColor = settings.buttonColor ?? accent;
  const surfaceOpacity = settings.surfaceOpacity ?? inferredOpacity(chrome.vars['--bp-ui-surface']);
  const buttonOpacity = settings.buttonOpacity ?? 1;
  const radius = settings.radius ?? Math.min(24, Math.max(0, parseInt(tokens.radius.control, 10) || 0));
  const canvasBg = settings.canvasBg ?? parseColor(tokens.canvas.background ?? DEFAULT_CANVAS_BACKGROUND, DEFAULT_CANVAS_BACKGROUND);
  const animationAccent = settings.animationAccent ?? '#a855f7';
  const shadowScalePct = settings.shadowScale ?? 100;
  const canvasDotColor = settings.dotColor ?? parseColor(tokens.canvas.dotColor ?? DEFAULT_CANVAS_DOT_COLOR, DEFAULT_CANVAS_DOT_COLOR);
  const canvasDotSize = settings.dotSize ?? (tokens.canvas.dotSize ? Number(tokens.canvas.dotSize) : DEFAULT_CANVAS_DOT_SIZE);
  const canvasDotOpacity = settings.dotOpacity ?? (tokens.canvas.dotOpacity ? Number(tokens.canvas.dotOpacity) : DEFAULT_CANVAS_DOT_OPACITY);
  const dotState: 'theme' | 'on' | 'off' = settings.canvasDots === null ? 'theme' : settings.canvasDots ? 'on' : 'off';
  const cardRadius = settings.cardRadius ?? Math.min(32, Math.max(0, parseInt(tokens.radius.card, 10) || 0));
  const gridColor = settings.gridColor ?? parseColor(tokens.canvas.grid ?? DEFAULT_CANVAS_GRID, DEFAULT_CANVAS_GRID);
  const gridWidth = settings.gridWidth ?? 1;
  const fontUi = settings.fontUi ?? (tokens.typography.ui || DEFAULT_FONT_UI_STACK);
  const fontContent = settings.fontContent ?? (tokens.typography.content || DEFAULT_FONT_CONTENT_STACK);

  const [tab, setTab] = React.useState<'colors' | 'canvas' | 'buttons' | 'fonts'>('colors');

  const segment = <T extends string>(items: [T, string, string][], value: T, select: (item: T) => void, label: string) => (
    <div role="group" aria-label={label} className="flex gap-1 rounded-lg border border-white/10 bg-black/15 p-1">
      {items.map(([key, cn, en]) => <button type="button" key={key} aria-pressed={value === key} onClick={() => select(key)}
        className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${value === key ? 'bg-white/15 text-slate-50' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'}`}>{title(zh, cn, en)}</button>)}
    </div>
  );
  const picker = (label: string, value: string, custom: boolean, update: (value: string) => void, reset: () => void) => (
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
      <span className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/20" style={{ backgroundColor: value }}>
        <input type="color" value={value} aria-label={label} title={label} onChange={event => update(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium">{label}
          {custom
            ? <span className="rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-medium text-cyan-300">{zh ? '已调' : 'Set'}</span>
            : <span className="rounded bg-white/10 px-1 py-0 text-[9px] text-slate-400">{zh ? '自动' : 'Auto'}</span>}
        </span>
        <span className="mt-0.5 block font-mono text-[10px] text-slate-400">{custom ? value.toUpperCase() : title(zh, '跟随主题取色', 'From theme')}</span>
      </span>
      {custom && <button type="button" onClick={reset} aria-label={title(zh, '恢复跟随主题', 'Reset to theme')}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-white/15 text-slate-300 transition-colors hover:bg-white/10 hover:text-slate-100"><ResetIcon /></button>}
    </div>
  );
  const slider = (label: string, value: number, min: number, max: number, step: number, unit: string,
    inherited: boolean, update: (value: number) => void, reset: () => void) => (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1.5">{label}
          {inherited
            ? <span className="rounded bg-white/10 px-1 py-0 text-[9px] text-slate-400">{zh ? '自动' : 'Auto'}</span>
            : <span className="rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-medium text-cyan-300">{zh ? '已调' : 'Set'}</span>}
        </span>
        <span className="flex items-center gap-2 font-mono text-slate-300">{value}{unit}
          {!inherited && <button type="button" onClick={reset} aria-label={title(zh, '恢复跟随主题', 'Reset to theme')}
            className="grid h-6 w-6 place-items-center rounded-md border border-white/15 text-slate-300 transition-colors hover:bg-white/10 hover:text-slate-100"><ResetIcon /></button>}
        </span>
      </div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
        onChange={event => update(Number(event.target.value))} className="w-full cursor-pointer accent-[var(--bp-ui-accent-text)]" />
    </div>
  );
  const fontField = (label: string, value: string, custom: boolean, update: (value: string) => void, reset: () => void) => (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1.5">{label}
          {custom
            ? <span className="rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-medium text-cyan-300">{zh ? '已调' : 'Set'}</span>
            : <span className="rounded bg-white/10 px-1 py-0 text-[9px] text-slate-400">{zh ? '自动' : 'Auto'}</span>}
        </span>
        {custom && <button type="button" onClick={reset} aria-label={title(zh, '恢复跟随主题', 'Reset to theme')}
          className="grid h-6 w-6 place-items-center rounded-md border border-white/15 text-slate-300 transition-colors hover:bg-white/10 hover:text-slate-100"><ResetIcon /></button>}
      </div>
      <input type="text" aria-label={label} value={value} placeholder={title(zh, '字体族，逗号分隔', 'font-family, comma separated')}
        onChange={event => update(event.target.value || null)} className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 font-mono text-[10px] text-slate-200 outline-none focus:border-white/40" />
    </div>
  );

  return <div data-bp-ui-controls="" className="space-y-3 pb-1">
    <p className="px-1 text-[11px] leading-5 text-slate-400">{title(zh,
      '这里统一调整按钮、工具栏、设置、弹窗、菜单和其他工具界面。画板自定义背景及作品内容不受覆盖。',
      'One set of controls for toolbars, buttons, settings, dialogs, menus and the rest of the interface. Personal board backgrounds and content are untouched.')}</p>

    <Group label={title(zh, '明暗模式', 'Interface mode')} zh={zh} settings={settings} onChange={onChange}>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{title(zh, '当前界面', 'Current')}</span>
        <span className="font-medium text-slate-300">{mode === 'dark' ? title(zh, '深色', 'Dark') : title(zh, '浅色', 'Light')}</span>
      </div>
      {segment<UiThemeMode>([['theme', '跟随主题', 'Theme'], ['system', '跟随系统', 'System'], ['light', '浅色', 'Light'], ['dark', '深色', 'Dark']], settings.mode, onMode, title(zh, '界面明暗', 'Interface mode'))}
      <p className="text-[10px] leading-4 text-slate-500">{title(zh, '有明暗双版的主题会自动切换对应版本；其他主题只切换工具界面的明暗。', 'Paired themes switch variants. Other themes adapt the interface while keeping their artwork.')}</p>
    </Group>

    <div role="tablist" aria-label={title(zh, '外观分类', 'Appearance categories')} className="flex gap-1 rounded-lg border border-white/10 bg-black/15 p-1">
      {(['colors', 'canvas', 'buttons', 'fonts'] as const).map((key) => {
        const labels: Record<typeof key, [string, string]> = {
          colors: ['配色', 'Colors'],
          canvas: ['工作区', 'Workspace'],
          buttons: ['控件', 'Controls'],
          fonts: ['字体', 'Fonts'],
        };
        const selected = tab === key;
        return (
          <button type="button" key={key} role="tab" id={`bp-tab-${key}`} aria-selected={selected} aria-controls={`bp-panel-${key}`}
            onClick={() => setTab(key)}
            className={`min-w-0 flex-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors ${selected ? 'bg-white/15 text-slate-50' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'}`}>
            {title(zh, labels[key][0], labels[key][1])}
          </button>
        );
      })}
    </div>

    {tab === 'colors' && <Group label={title(zh, '界面配色', 'Interface colors')} zh={zh} settings={settings} onChange={onChange}
      panelId="bp-panel-colors" labelledBy="bp-tab-colors"
      fields={['accent', 'surface', 'surfaceOpacity', 'shadowScale', 'animationAccent']}>
      {picker(title(zh, '强调色', 'Accent color'), accent, settings.accent !== null, value => onChange({ accent: value }), () => onChange({ accent: null }))}
      <div role="group" aria-label={title(zh, '主题色快捷选择', 'Quick accent colors')} className="flex items-center justify-between gap-1 rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-2">
        <span className="text-[10px] text-slate-400">{title(zh, '快捷主题色', 'Quick colors')}</span>
        <span className="flex items-center gap-1.5">
          {['#22d3ee', '#6366f1', '#a855f7', '#ec4899', '#f59e0b', '#10b981'].map(color =>
            <button type="button" key={color} aria-label={title(zh, `设为 ${color}`, `Set accent ${color}`)} aria-pressed={settings.accent === color}
              title={color} onClick={() => onChange({ accent: color })} className="grid h-7 w-7 place-items-center rounded-full border border-white/10 hover:border-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70">
              <i className="h-4 w-4 rounded-full" style={{ backgroundColor: color, boxShadow: settings.accent === color ? '0 0 0 2px var(--bp-ui-focus)' : undefined }} />
            </button>)}
        </span>
      </div>
      {picker(title(zh, '界面底色', 'Surface color'), surface, settings.surface !== null, value => onChange({ surface: value }), () => onChange({ surface: null }))}
      {slider(title(zh, '界面不透明度', 'Surface opacity'), Math.round(surfaceOpacity * 100), 55, 100, 5, '%', settings.surfaceOpacity === null,
        value => onChange({ surfaceOpacity: value / 100 }), () => onChange({ surfaceOpacity: null }))}
      {segment<UiThemeSettings['contrast']>([['standard', '标准对比', 'Standard'], ['high', '高对比', 'High contrast']], settings.contrast,
        value => onChange({ contrast: value }), title(zh, '文字对比度', 'Text contrast'))}
      {slider(title(zh, '阴影浓度', 'Shadow intensity'), shadowScalePct, 0, 100, 5, '%', settings.shadowScale === null,
        value => onChange({ shadowScale: value }), () => onChange({ shadowScale: null }))}
      {picker(title(zh, '动效强调色', 'Motion accent'), animationAccent, settings.animationAccent !== null,
        value => onChange({ animationAccent: value }), () => onChange({ animationAccent: null }))}
    </Group>}

    {tab === 'canvas' && <Group label={title(zh, '工作区背景', 'Workspace background')} zh={zh} settings={settings} onChange={onChange}
      panelId="bp-panel-canvas" labelledBy="bp-tab-canvas"
      fields={['canvasBg', 'canvasDots', 'dotColor', 'dotSize', 'dotOpacity', 'gridColor', 'gridWidth']}>
      <p className="text-[11px] leading-5 text-slate-400">{title(zh, '调整主题的默认工作区；当前画板的专属背景在设置 → 画布中修改。', 'Adjust the default workspace. For a board-specific background, open Settings → Canvas.')}</p>
      {picker(title(zh, '工作区底色', 'Workspace background'), canvasBg, settings.canvasBg !== null,
        value => onChange({ canvasBg: value }), () => onChange({ canvasBg: null }))}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium">{title(zh, '点阵开关', 'Dot grid')}</p>
        {segment<'theme' | 'on' | 'off'>([['theme', '跟随主题', 'Theme'], ['on', '开启', 'On'], ['off', '关闭', 'Off']], dotState,
          value => onChange({ canvasDots: value === 'theme' ? null : value === 'on' ? true : false }), title(zh, '点阵开关', 'Dot grid'))}
      </div>
      <details className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
        <summary className="cursor-pointer text-[11px] font-medium">{title(zh, '画布点阵', 'Canvas dot grid')}
          {settings.canvasDots !== null && <span className="ml-1.5 rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-medium text-cyan-300">{zh ? '已调' : 'Set'}</span>}</summary>
        <p className="text-[10px] leading-4 text-slate-500">{title(zh, '缩放时随网格一起缩放的小圆点。', 'Dots that scale with the grid as you zoom.')}</p>
        {picker(title(zh, '点阵颜色', 'Dot color'), canvasDotColor, settings.dotColor !== null,
          value => onChange({ dotColor: value }), () => onChange({ dotColor: null }))}
        {slider(title(zh, '点阵大小', 'Dot size'), canvasDotSize, 1, 20, 1, '%', settings.dotSize === null,
          value => onChange({ dotSize: value }), () => onChange({ dotSize: null }))}
        {slider(title(zh, '点阵浓度', 'Dot opacity'), Math.round(canvasDotOpacity * 100), 5, 100, 5, '%', settings.dotOpacity === null,
          value => onChange({ dotOpacity: value / 100 }), () => onChange({ dotOpacity: null }))}
      </details>
      <details className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
        <summary className="cursor-pointer text-[11px] font-medium">{title(zh, '网格线', 'Grid lines')}
          {(settings.gridColor !== null || settings.gridWidth !== null) && <span className="ml-1.5 rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-medium text-cyan-300">{zh ? '已调' : 'Set'}</span>}</summary>
        {picker(title(zh, '网格线颜色', 'Grid line color'), gridColor, settings.gridColor !== null,
          value => onChange({ gridColor: value }), () => onChange({ gridColor: null }))}
        {slider(title(zh, '网格线粗细', 'Grid line width'), gridWidth, 1, 8, 1, 'px', settings.gridWidth === null,
          value => onChange({ gridWidth: value }), () => onChange({ gridWidth: null }))}
      </details>
    </Group>}

    {tab === 'buttons' && <Group label={title(zh, '按钮', 'Buttons')} zh={zh} settings={settings} onChange={onChange}
      panelId="bp-panel-buttons" labelledBy="bp-tab-buttons"
      fields={['buttonColor', 'buttonOpacity']}>
      {picker(title(zh, '按钮颜色', 'Button color'), buttonColor, settings.buttonColor !== null,
        value => onChange({ buttonColor: value }), () => onChange({ buttonColor: null }))}
      {segment<UiButtonStyle>([['soft', '柔和', 'Soft'], ['solid', '实色', 'Solid'], ['outline', '描边', 'Outline']], settings.buttonStyle,
        value => onChange({ buttonStyle: value }), title(zh, '按钮样式', 'Button style'))}
      {slider(title(zh, '按钮不透明度', 'Button opacity'), Math.round(buttonOpacity * 100), 80, 100, 5, '%', settings.buttonOpacity === null,
        value => onChange({ buttonOpacity: value / 100 }), () => onChange({ buttonOpacity: null }))}
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5 text-[11px]">
        <span className="min-w-0 flex-1 text-slate-400">{title(zh, '实际控件示例', 'Real control sample')}</span>
        <button type="button" data-bp-ui-action="primary" className="rounded-lg border px-2.5 py-1.5 font-medium">{title(zh, '主要操作', 'Primary')}</button>
        <button type="button" className="rounded-lg border border-white/15 px-2.5 py-1.5">{title(zh, '次要', 'Other')}</button>
      </div>
    </Group>}

    {tab === 'fonts' && <Group label={title(zh, '字体与圆角', 'Fonts & corners')} zh={zh} settings={settings} onChange={onChange}
      panelId="bp-panel-fonts" labelledBy="bp-tab-fonts"
      fields={['fontUi', 'fontContent', 'cardRadius', 'radius']}>
      {fontField(title(zh, '界面字体', 'UI font'), fontUi, settings.fontUi !== null,
        value => onChange({ fontUi: value }), () => onChange({ fontUi: null }))}
      {fontField(title(zh, '正文字体', 'Content font'), fontContent, settings.fontContent !== null,
        value => onChange({ fontContent: value }), () => onChange({ fontContent: null }))}
      {slider(title(zh, '卡片圆角', 'Card corners'), cardRadius, 0, 32, 1, 'px', settings.cardRadius === null,
        value => onChange({ cardRadius: value }), () => onChange({ cardRadius: null }))}
      {slider(title(zh, '控件圆角', 'Control corners'), radius, 0, 24, 1, 'px', settings.radius === null,
        value => onChange({ radius: value }), () => onChange({ radius: null }))}
      <div className="space-y-1.5"><p className="text-[11px] font-medium">{title(zh, '工具栏位置', 'Toolbar side')}</p>
        {segment<UiThemeSettings['toolbarSide']>([['left', '左侧', 'Left'], ['right', '右侧', 'Right']], settings.toolbarSide,
          value => onChange({ toolbarSide: value }), title(zh, '工具栏位置', 'Toolbar side'))}</div>
    </Group>}
  </div>;
};
