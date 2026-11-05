/** Application-wide visual settings owned by the skin engine, not by Settings/App.
 * Theme tokens stay authoritative; these are validated global UI adjustments on top.
 * Never mutate a board's own wallpaper, drawing colors, or user-authored card data.
 */
import type { ResolvedSkinTokens, SkinMode } from './contributions';

/** 画布/工作区默认底色（暗色主题基线）。皮肤可声明 canvas.background 覆盖；用户可调 canvasBg 覆盖。 */
export const DEFAULT_CANVAS_BACKGROUND = '#111827';

/** 画布点阵默认值 = 迁移前 CanvasBackdrop 写死的 radial-gradient（灰 400 @ 50%）。 */
export const DEFAULT_CANVAS_DOT_COLOR = '#9ca3af';
export const DEFAULT_CANVAS_DOT_SIZE = 5;
export const DEFAULT_CANVAS_DOT_OPACITY = 0.5;

/** 默认 UI / 正文 font-family 栈（与 index.css 的 var() 回落一致）。 */
export const DEFAULT_FONT_UI_STACK = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
export const DEFAULT_FONT_CONTENT_STACK = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
/** 画布网格线默认色（与 CanvasBackground LINES 的 var() 回落一致）。 */
export const DEFAULT_CANVAS_GRID = 'rgba(255,255,255,0.09)';

export type UiThemeMode = 'theme' | 'light' | 'dark' | 'system';
export type WallpaperAutoMode = 'off' | 'interval' | 'system' | 'both';
export type UiButtonStyle = 'soft' | 'solid' | 'outline';
export type UiContrast = 'standard' | 'high';
export interface UiThemeSettings {
  mode: UiThemeMode;
  accent: string | null;
  surface: string | null;
  surfaceOpacity: number | null;
  buttonColor: string | null;
  buttonOpacity: number | null;
  buttonStyle: UiButtonStyle;
  radius: number | null;
  contrast: UiContrast;
  /** null = 跟随皮肤的画布底色（canvas.background）；用户覆盖整面画布默认底色。 */
  canvasBg: string | null;
  /** null = 跟随强调色体系（默认紫，保持现有脉冲环视觉）；用户覆盖动效强调色。 */
  animationAccent: string | null;
  /** 阴影浓度 0-100（%），null = 跟随明暗模式默认；仅作用于工具界面阴影。 */
  shadowScale: number | null;
  /** 画布点阵开关：null = 跟随皮肤（默认显示），true/false = 强制显示/隐藏。 */
  canvasDots: boolean | null;
  /** null = 跟随皮肤声明的点阵颜色。 */
  dotColor: string | null;
  /** 点阵半径（占格子的百分比 1-20），null = 跟随皮肤/默认。 */
  dotSize: number | null;
  /** 点阵不透明度 0.05-1，null = 跟随皮肤/默认。 */
  dotOpacity: number | null;
  /** 卡片圆角（px），null = 跟随皮肤 radius.card。 */
  cardRadius: number | null;
  /** 界面字体族（font-family），null = 跟随皮肤/系统默认栈。 */
  fontUi: string | null;
  /** 正文/长文卡片字体族，null = 跟随皮肤/系统默认栈。 */
  fontContent: string | null;
  /** 画布网格线颜色（#rrggbb），null = 跟随皮肤/默认。 */
  gridColor: string | null;
  /** 画布网格线粗细（px，1-8），null = 跟随皮肤/默认（默认 1px）。 */
  gridWidth: number | null;
  toolbarSide: 'left' | 'right';
  /** null keeps the skin author's original canvas background. Media lives in IndexedDB, not localStorage. */
  wallpaperId: string | null;
  wallpaperLightId: string | null;
  wallpaperDarkId: string | null;
  wallpaperDim: number;
  wallpaperBlur: number;
  wallpaperAuto: WallpaperAutoMode;
  wallpaperIntervalMinutes: number;
  wallpaperSwitchButton: boolean;
}

export const DEFAULT_UI_THEME_SETTINGS: UiThemeSettings = Object.freeze({
  mode: 'theme', accent: null, surface: null, surfaceOpacity: null,
  buttonColor: null, buttonOpacity: null, buttonStyle: 'soft',
  radius: null, contrast: 'standard', canvasBg: null, animationAccent: null, shadowScale: null,
  canvasDots: null, dotColor: null, dotSize: null, dotOpacity: null, cardRadius: null, fontUi: null, fontContent: null, gridColor: null, gridWidth: null, toolbarSide: 'left',
  wallpaperId: null, wallpaperLightId: null, wallpaperDarkId: null,
  wallpaperDim: 0, wallpaperBlur: 0, wallpaperAuto: 'off',
  wallpaperIntervalMinutes: 30, wallpaperSwitchButton: false,
});

const hex = (value: unknown): value is string => typeof value === 'string' && /^#[\da-fA-F]{6}$/.test(value);
const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Only allow known, well-formed keys. null resets an override back to its theme value. */
export function normalizeUiThemeSettings(raw: unknown, base: UiThemeSettings = DEFAULT_UI_THEME_SETTINGS): UiThemeSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const next = { ...base };
  if (value.mode === 'theme' || value.mode === 'light' || value.mode === 'dark' || value.mode === 'system') next.mode = value.mode;
  for (const key of ['accent', 'surface', 'buttonColor'] as const) {
    if (value[key] === null) next[key] = null;
    else if (hex(value[key])) next[key] = value[key].toLowerCase();
  }
  if (value.surfaceOpacity === null) next.surfaceOpacity = null;
  else if (bounded(value.surfaceOpacity, 0.55, 1)) next.surfaceOpacity = Math.round(value.surfaceOpacity * 100) / 100;
  if (value.buttonOpacity === null) next.buttonOpacity = null;
  else if (bounded(value.buttonOpacity, 0.8, 1)) next.buttonOpacity = Math.round(value.buttonOpacity * 100) / 100;
  if (value.buttonStyle === 'soft' || value.buttonStyle === 'solid' || value.buttonStyle === 'outline') next.buttonStyle = value.buttonStyle;
  if (value.radius === null) next.radius = null;
  else if (bounded(value.radius, 0, 24)) next.radius = Math.round(value.radius);
  if (value.contrast === 'standard' || value.contrast === 'high') next.contrast = value.contrast;
  for (const key of ['canvasBg', 'animationAccent'] as const) {
    if (value[key] === null) next[key] = null;
    else if (hex(value[key])) next[key] = value[key].toLowerCase();
  }
  if (value.shadowScale === null) next.shadowScale = null;
  else if (bounded(value.shadowScale, 0, 100)) next.shadowScale = Math.round(value.shadowScale);
  // 画布点阵：null = 跟随皮肤（默认显示）；true/false = 强制显示/隐藏。
  if (value.canvasDots === true || value.canvasDots === false) next.canvasDots = value.canvasDots;
  if (value.dotColor === null) next.dotColor = null;
  else if (hex(value.dotColor)) next.dotColor = value.dotColor.toLowerCase();
  if (value.dotSize === null) next.dotSize = null;
  else if (bounded(value.dotSize, 1, 20)) next.dotSize = Math.round(value.dotSize);
  if (value.dotOpacity === null) next.dotOpacity = null;
  else if (bounded(value.dotOpacity, 0.05, 1)) next.dotOpacity = Math.round(value.dotOpacity * 100) / 100;
  // 卡片圆角 0-32px
  if (value.cardRadius === null) next.cardRadius = null;
  else if (bounded(value.cardRadius, 0, 32)) next.cardRadius = Math.round(value.cardRadius);
  // 字体族：仅放行的字符集，拒绝 ; < > { } @ 等可破坏 CSS 的字符，最长 200。
  if (value.fontUi === null) next.fontUi = null;
  else if (typeof value.fontUi === 'string' && value.fontUi.trim().length > 0 && value.fontUi.length <= 200 && !/[;<>`{}@]/.test(value.fontUi)) next.fontUi = value.fontUi;
  if (value.fontContent === null) next.fontContent = null;
  else if (typeof value.fontContent === 'string' && value.fontContent.trim().length > 0 && value.fontContent.length <= 200 && !/[;<>`{}@]/.test(value.fontContent)) next.fontContent = value.fontContent;
  // 网格线颜色（hex）
  if (value.gridColor === null) next.gridColor = null;
  else if (hex(value.gridColor)) next.gridColor = value.gridColor.toLowerCase();
  // 网格线粗细 1-8px
  if (value.gridWidth === null) next.gridWidth = null;
  else if (bounded(value.gridWidth, 1, 8)) next.gridWidth = Math.round(value.gridWidth);
  if (value.toolbarSide === 'left' || value.toolbarSide === 'right') next.toolbarSide = value.toolbarSide;
  for (const key of ['wallpaperId', 'wallpaperLightId', 'wallpaperDarkId'] as const) {
    if (value[key] === null) next[key] = null;
    else if (typeof value[key] === 'string' && /^(builtin\.wallpaper\.[\w-]+|user-wall-[\w-]+)$/.test(value[key]) && value[key].length <= 100) next[key] = value[key];
  }
  if (bounded(value.wallpaperDim, 0, 100)) next.wallpaperDim = Math.round(value.wallpaperDim);
  if (bounded(value.wallpaperBlur, 0, 30)) next.wallpaperBlur = Math.round(value.wallpaperBlur);
  if (value.wallpaperAuto === 'off' || value.wallpaperAuto === 'interval' || value.wallpaperAuto === 'system' || value.wallpaperAuto === 'both') next.wallpaperAuto = value.wallpaperAuto;
  if (bounded(value.wallpaperIntervalMinutes, 1, 1440)) next.wallpaperIntervalMinutes = Math.round(value.wallpaperIntervalMinutes);
  if (typeof value.wallpaperSwitchButton === 'boolean') next.wallpaperSwitchButton = value.wallpaperSwitchButton;
  return next;
}

const rgb = (hexColor: string): [number, number, number] => {
  const color = hexColor.replace('#', '');
  return [0, 2, 4].map(start => parseInt(color.slice(start, start + 2), 16)) as [number, number, number];
};
const rgba = (hexColor: string, alpha: number): string => `rgba(${rgb(hexColor).join(', ')}, ${Math.round(alpha * 100) / 100})`;
const parseRgb = (value: string): [number, number, number] | null => {
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0?\.\d+|[01]))?\s*\)$/i.exec(value);
  if (match) {
    const channels = match.slice(1, 4).map(Number) as [number, number, number];
    if (channels.every(channel => channel >= 0 && channel <= 255)) return channels;
  }
  return hex(value) ? rgb(value) : null;
};
const withOpacity = (value: string, opacity: number, fallback: string): string => {
  const channels = parseRgb(value) ?? parseRgb(fallback)!;
  return `rgba(${channels.join(', ')}, ${opacity})`;
};
const toHex = (channels: [number, number, number]): string =>
  `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
const blend = (a: string, b: string, portion: number): string => {
  const first = parseRgb(a) ?? rgb('#20252b');
  const second = parseRgb(b) ?? rgb('#ffffff');
  return toHex(first.map((x, i) => x * (1 - portion) + second[i] * portion) as [number, number, number]);
};
const luminance = (color: string): number => {
  const channels = parseRgb(color) ?? rgb('#808080');
  const linear = channels.map(channel => {
    const n = channel / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrastRatio = (a: string, b: string): number => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const readableOn = (color: string): string => contrastRatio('#ffffff', color) > contrastRatio('#101720', color) ? '#ffffff' : '#101720';
const readableAccent = (accent: string, dark: boolean): string => {
  const surface = dark ? '#1b2229' : '#fafcfd';
  const toward = dark ? '#ffffff' : '#101720';
  for (let step = 0; step <= 10; step++) {
    const candidate = blend(accent, toward, step / 10);
    if (contrastRatio(candidate, surface) >= 4.5) return candidate;
  }
  return toward;
};

/** Match the OS without creating a second appearance source or saving an automatic flip. */
export function systemUiMode(): SkinMode {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export interface ResolvedUiChrome {
  mode: SkinMode;
  vars: Record<string, string>;
}

/** One palette for dialogs, buttons, popovers, settings, prompt, toolbars and panels. */
export function resolveUiChrome(tokens: ResolvedSkinTokens, settings: UiThemeSettings): ResolvedUiChrome {
  const mode = settings.mode === 'theme' ? tokens.mode : settings.mode === 'system' ? systemUiMode() : settings.mode;
  const dark = mode === 'dark';
  const remap = mode !== tokens.mode;
  const neutral = dark ? '#181e26' : '#f9fcfd';
  const accent = settings.accent ?? tokens.color.accent;
  const soft = settings.accent ? rgba(accent, dark ? 0.19 : 0.15) : tokens.color.accentSoft;
  const surfaceColor = settings.surface ?? (remap ? neutral : tokens.chrome.panelBg);
  // A custom surface can be dark even in a light theme (or vice versa).
  // Choose legible text against the actual surface, not just its mode label.
  const contentDark = settings.surface ? readableOn(settings.surface) === '#ffffff' : dark;
  const surface = settings.surfaceOpacity !== null
    ? withOpacity(surfaceColor, settings.surfaceOpacity, neutral)
    : settings.surface ? rgba(settings.surface, dark ? 0.94 : 0.97)
      : remap ? rgba(neutral, dark ? 0.93 : 0.96) : tokens.chrome.panelBg;
  const strong = parseRgb(surfaceColor) ? withOpacity(surfaceColor, settings.surfaceOpacity ?? 0.985, neutral) : tokens.color.cardBg;
  const text = settings.contrast === 'high' || remap || settings.surface
    ? contentDark ? '#f9fcff' : '#111e29' : tokens.chrome.panelText;
  const muted = settings.contrast === 'high'
    ? contentDark ? '#d5e0e9' : '#354655'
    : remap || settings.surface ? contentDark ? '#aebdc9' : '#536474' : tokens.color.textMuted;
  const border = settings.contrast === 'high'
    ? contentDark ? 'rgba(245,250,255,0.38)' : 'rgba(20,35,48,0.36)'
    : remap || settings.surface ? contentDark ? 'rgba(240,247,255,0.20)' : 'rgba(20,42,58,0.18)' : tokens.chrome.panelBorder;
  const hover = remap || settings.surface
    ? contentDark ? 'rgba(255,255,255,0.13)' : 'rgba(17,42,58,0.09)' : tokens.chrome.hoverBg;
  const raised = contentDark ? 'rgba(255,255,255,0.075)' : 'rgba(20,42,58,0.055)';
  const subdued = contentDark ? 'rgba(0,0,0,0.23)' : 'rgba(20,42,58,0.045)';
  const buttonColor = settings.buttonColor ?? accent;
  const buttonHover = settings.buttonColor ? rgba(buttonColor, contentDark ? 0.22 : 0.13) : hover;
  const opacity = settings.buttonOpacity ?? 1;
  const buttonBg = settings.buttonStyle === 'solid' ? rgba(buttonColor, opacity)
    : settings.buttonStyle === 'outline' ? 'transparent' : rgba(buttonColor, contentDark ? 0.22 * opacity : 0.14 * opacity);
  const buttonText = settings.buttonStyle === 'solid' ? readableOn(buttonColor) : readableAccent(buttonColor, contentDark);
  const buttonBorder = settings.buttonStyle === 'outline' ? readableAccent(buttonColor, contentDark)
    : settings.buttonStyle === 'solid' ? readableAccent(buttonColor, contentDark) : 'transparent';
  const radius = settings.radius === null ? tokens.radius.control : `${settings.radius}px`;
  const panelRadius = settings.radius === null ? '18px' : `${Math.min(28, settings.radius + 7)}px`;
  const shadowColor = contentDark ? '0,0,0' : '18,35,48';
  const baseShadowAlpha = contentDark ? 0.38 : 0.18;
  const shadowScalePct = settings.shadowScale ?? 100;
  const shadowAlpha = Math.min(0.6, baseShadowAlpha * (shadowScalePct / 100));
  // 画布点阵（圆点网格）：迁移前 CanvasBackdrop 写死的 radial-gradient，现由主题提供。
  // 皮肤可声明 canvas.dots='off' 关闭；用户 setting canvasDots=false 强制关闭；关闭时写入 none。
  const skinDotMode = tokens.canvas.dots;
  const dotsEnabled = skinDotMode !== 'off' && settings.canvasDots !== false;
  let dotImage = 'none';
  if (dotsEnabled) {
    const rawDotColor = settings.dotColor ?? tokens.canvas.dotColor ?? DEFAULT_CANVAS_DOT_COLOR;
    const rawDotSize = settings.dotSize ?? tokens.canvas.dotSize ?? DEFAULT_CANVAS_DOT_SIZE;
    const rawDotOpacity = settings.dotOpacity ?? tokens.canvas.dotOpacity ?? DEFAULT_CANVAS_DOT_OPACITY;
    const color = typeof rawDotColor === 'string' && hex(rawDotColor) ? rawDotColor.toLowerCase() : DEFAULT_CANVAS_DOT_COLOR;
    const size = typeof rawDotSize === 'number' ? rawDotSize
      : typeof rawDotSize === 'string' && /^\d{1,2}(\.\d+)?$/.test(rawDotSize) ? Number(rawDotSize)
      : DEFAULT_CANVAS_DOT_SIZE;
    const opacity = typeof rawDotOpacity === 'number' ? rawDotOpacity
      : typeof rawDotOpacity === 'string' && /^\d?\.?\d+$/.test(rawDotOpacity) ? Number(rawDotOpacity)
      : DEFAULT_CANVAS_DOT_OPACITY;
    const clampedSize = Math.min(20, Math.max(1, Math.round(size)));
    const clampedOpacity = Math.min(1, Math.max(0.05, Math.round(opacity * 100) / 100));
    dotImage = `radial-gradient(circle at 5% 5%, ${rgba(color, clampedOpacity)} 0 ${clampedSize}%, transparent ${clampedSize + 0.6}%)`;
  }
  return { mode, vars: {
    '--ui-bg-color': surface,
    '--ui-text': text,
    '--ui-border': border,
    '--ui-hover': buttonHover,
    '--button-bg-color': buttonBg,
    '--bp-accent': accent,
    '--bp-accent-soft': soft,
    '--bp-radius-control': radius,
    '--bp-ui-surface': surface,
    '--bp-ui-surface-strong': strong,
    '--bp-ui-raised': raised,
    '--bp-ui-subdued': subdued,
    '--bp-ui-text': text,
    '--bp-ui-muted': muted,
    '--bp-ui-border': border,
    '--bp-ui-hover': buttonHover,
    '--bp-ui-selected-bg': settings.accent ? rgba(accent, contentDark ? 0.23 : 0.17) : soft,
    '--bp-ui-selected-border': rgba(accent, contentDark ? 0.65 : 0.62),
    '--bp-ui-accent-text': readableAccent(accent, contentDark),
    '--bp-ui-accent-soft': soft,
    '--bp-ui-warning': dark ? '#fbbf24' : '#d97706',
    '--bp-ui-warning-soft': dark ? 'rgba(251, 191, 36, 0.16)' : 'rgba(217, 119, 6, 0.14)',
    '--bp-ui-danger': dark ? '#fb7185' : '#dc2626',
    '--bp-ui-danger-soft': dark ? 'rgba(251, 113, 133, 0.14)' : 'rgba(220, 38, 38, 0.12)',
    '--bp-ui-success': dark ? '#34d399' : '#059669',
    '--bp-ui-success-soft': dark ? 'rgba(52, 211, 153, 0.16)' : 'rgba(5, 150, 105, 0.13)',
    '--bp-ui-on-accent': readableOn(accent),
    '--bp-ui-button-bg': buttonBg,
    // Icon-only top actions use the chosen button hue without a solid button background.
    '--bp-ui-button-icon': readableAccent(buttonColor, contentDark),
    '--bp-ui-prompt-action': settings.buttonColor ? buttonBg : 'var(--bp-abyssal-prompt-action, var(--bp-ui-button-bg))',
    '--bp-ui-button-hover': settings.buttonStyle === 'soft' ? rgba(buttonColor, contentDark ? 0.29 : 0.22) : rgba(buttonColor, Math.min(1, opacity + 0.06)),
    '--bp-ui-button-text': buttonText,
    '--bp-ui-button-border': buttonBorder,
    '--bp-ui-focus': readableAccent(accent, contentDark),
    '--bp-ui-radius': radius,
    '--bp-ui-radius-panel': panelRadius,
    '--bp-ui-shadow': `0 18px 56px rgba(${shadowColor}, ${shadowAlpha})`,
    '--bp-ui-scrim': contentDark ? 'rgba(0,0,0,.60)' : 'rgba(13,25,37,.36)',
    '--bp-canvas-bg': settings.canvasBg ?? tokens.canvas.background ?? '#111827',
    '--bp-canvas-dot-image': dotImage,
    // 卡片圆角 / 网格线 / 字体：始终写入（用户值 → 皮肤值 → 默认栈），UI 层在皮肤层之后写入，重置也能正确回落。
    '--bp-radius-card': settings.cardRadius !== null ? `${settings.cardRadius}px` : tokens.radius.card,
    '--bp-canvas-grid': settings.gridColor ?? tokens.canvas.grid ?? DEFAULT_CANVAS_GRID,
    '--bp-canvas-grid-width': settings.gridWidth !== null ? `${settings.gridWidth}px` : '1px',
    '--bp-font-ui': settings.fontUi ?? (tokens.typography.ui || DEFAULT_FONT_UI_STACK),
    '--bp-font-content': settings.fontContent ?? (tokens.typography.content || DEFAULT_FONT_CONTENT_STACK),
    '--bp-ui-animation-accent': settings.animationAccent ?? '#a855f7',
  } };
}
