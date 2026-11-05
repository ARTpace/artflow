/**
 * contributions.ts —— 贡献项载荷类型 + 皮肤 token 契约。
 * 皮肤形状对齐 AssetLibrary（domains/ui.ts themeTokensSchema 思路）：
 * partial 补丁合并到默认底座，残缺键不清空必填项。
 */

export type SkinMode = 'dark' | 'light';

export interface SkinColorTokens {
  cardBg: string;      // 卡片主底色
  cardBgAlt: string;   // 卡片次级底色（头部/分区）
  accent: string;      // 主强调色（按钮/高亮/描边）
  accentSoft: string;  // 弱化强调（光晕/标签底）
  border: string;      // 卡片描边
  textPrimary: string; // 主文字
  textMuted: string;   // 次要文字
  success: string;     // 成功状态
  danger: string;      // 危险状态
}

/**
 * 外壳（chrome）色板：顶栏/工具条/侧面板等 UI 容器。
 * 默认值 = 迁移前视觉（面板透明 + blur、白字、white/10 描边、white/20 悬停），
 * 保证默认皮肤零视觉变化。
 */
export interface SkinChromeTokens {
  panelBg: string;     // 面板/外壳底色（写入悬空已久的 --ui-bg-color）
  panelBorder: string; // 外壳描边（--ui-border）
  panelText: string;   // 外壳文字（--ui-text）
  hoverBg: string;     // 外壳悬停底色（--ui-hover）
}

/** 画布层：底色/壁纸/网格线/点阵。undefined = 不覆盖（回落应用默认）。 */
export interface SkinCanvasTokens {
  background?: string;      // CSS 颜色或渐变（画布底色默认层）
  backgroundImage?: string; // 'url(...)' 壁纸（板级壁纸优先于皮肤壁纸）
  grid?: string;            // 世界坐标网格线颜色
  dots?: string;            // 点阵开关：'off' = 关闭；缺省 = 显示
  dotColor?: string;        // 点阵颜色（#rrggbb）
  dotSize?: string;         // 点阵半径（占格子的百分比，字符串数字，1-20）
  dotOpacity?: string;      // 点阵不透明度（字符串数字，0.05-1）
}

/** 字体族。undefined = 不覆盖（回落 Tailwind 默认栈）。 */
export interface SkinTypographyTokens {
  ui?: string;      // 界面整体字体（body）
  content?: string; // 卡片正文字体（reader/markdown 等长文）
}

export interface SkinRadiusTokens {
  card: string;    // 卡片圆角
  control: string; // 按钮/输入控件圆角
}

/** 皮肤补丁：所有键可选，缺省回落到底座。 */
export interface SkinTokens {
  mode?: SkinMode;
  color?: Partial<SkinColorTokens>;
  chrome?: Partial<SkinChromeTokens>;
  radius?: Partial<SkinRadiusTokens>;
  /** 卡片类型 → 该卡的个性强调色（如 bookmark/code/markdown/font/file），未声明的卡用全局 accent。 */
  accents?: Record<string, string>;
  /** 画布层：底色/壁纸/网格线（undefined 键 = 不覆盖应用默认）。 */
  canvas?: Partial<SkinCanvasTokens>;
  /** 字体族（undefined 键 = 不覆盖默认栈）。 */
  typography?: Partial<SkinTypographyTokens>;
  /** 图标覆盖：iconId → SVG inner markup（stroke="currentColor" 跟随文字色）或 data:image URI。 */
  icons?: Record<string, string>;
}

export type ResolvedSkinTokens = {
  mode: SkinMode;
  color: SkinColorTokens;
  chrome: SkinChromeTokens;
  radius: SkinRadiusTokens;
  accents: Record<string, string>;
  canvas: SkinCanvasTokens;
  typography: SkinTypographyTokens;
  icons: Record<string, string>;
};

/**
 * 默认底座 = 现有霓虹视觉（取自 BookmarkCanvasCard 等卡片的写死配色）。
 * token 化完成后各卡片改读 CSS 变量，默认视觉保持不变。
 */
export const DEFAULT_SKIN: ResolvedSkinTokens = {
  mode: 'dark',
  color: {
    cardBg: '#121824',
    cardBgAlt: '#162032',
    accent: '#22d3ee',
    accentSoft: 'rgba(34, 211, 238, 0.15)',
    border: 'rgba(34, 211, 238, 0.30)',
    textPrimary: '#f3f4f6',
    textMuted: '#9ca3af',
    success: '#34d399',
    danger: '#f87171',
  },
  radius: {
    card: '16px',
    control: '6px',
  },
  // 各卡片现有的个性强调色（token 化前写死在各卡片里的视觉，逐值搬入）
  // 约定：键 = 内容类型；引擎自动注入 --bp-card-accent-<kebab(键)>，卡片读 var(--bp-card-accent-<键>, var(--bp-accent))
  accents: {
    bookmark: '#22d3ee',
    code: '#818cf8',
    markdown: '#f472b6',
    font: '#e879f9',
    file: '#94a3b8',
    audio: '#ec4899',
    '3d': '#818cf8',
  },
  // 外壳默认 = 迁移前视觉（对齐 useSettings uiTheme #171717 @ 0.7 的启动基线）
  chrome: {
    panelBg: 'rgba(23, 23, 23, 0.7)',
    panelBorder: 'rgba(255, 255, 255, 0.10)',
    panelText: '#ffffff',
    hoverBg: 'rgba(255, 255, 255, 0.20)',
  },
  // 画布/字体默认不覆盖：undefined 键不会写入 CSS 变量，应用侧用自身 fallback
  canvas: {},
  typography: {},
  icons: {},
};

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const mergeGroup = <T extends object>(base: T, patch: unknown): T => {
  const out = { ...base };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of Object.keys(base) as (keyof T)[]) {
    const value = (patch as Record<string, unknown>)[key as string];
    if (isNonEmpty(value)) out[key] = value as T[keyof T];
  }
  return out;
};

/** partial 补丁 → 完整 token；空值/非法值忽略而非渲染。 */
export function resolveSkinTokens(patch?: SkinTokens, base: ResolvedSkinTokens = DEFAULT_SKIN): ResolvedSkinTokens {
  if (!patch) return base;
  const accents: Record<string, string> = { ...base.accents };
  if (patch.accents && typeof patch.accents === 'object' && !Array.isArray(patch.accents)) {
    for (const [key, value] of Object.entries(patch.accents)) {
      if (isNonEmpty(value)) accents[key] = value;
    }
  }
  const icons: Record<string, string> = { ...base.icons };
  if (patch.icons && typeof patch.icons === 'object' && !Array.isArray(patch.icons)) {
    for (const [key, value] of Object.entries(patch.icons)) {
      if (isNonEmpty(value)) icons[key] = value;
    }
  }
  return {
    mode: patch.mode ?? base.mode,
    color: mergeGroup(base.color, patch.color),
    chrome: mergeGroup(base.chrome, patch.chrome),
    radius: mergeGroup(base.radius, patch.radius),
    accents,
    // 画布/字体/图标是"覆盖层"语义：皮肤声明的键覆盖，未声明的键回落底座（底座默认全 undefined/空）
    canvas: { ...base.canvas, ...sanitizePartial(patch.canvas, base.canvas) },
    typography: { ...base.typography, ...sanitizePartial(patch.typography, base.typography) },
    icons,
  };
}

/** 过滤 partial 组：仅保留非空字符串键（遍历 patch 自身键，base 为空也能收）。 */
function sanitizePartial<T extends object>(patch: unknown, _base: T): Partial<T> {
  void _base;
  const out: Partial<T> = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (isNonEmpty(value)) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

const kebabVar = (name: string) => name.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);

/** 皮肤 token → CSS 自定义属性（扁平形态，对齐 AssetLibrary flattenThemeTokens）。
 *  undefined 的覆盖层键（canvas/typography）不写变量 → 消费端 var() fallback 生效。 */
export function flattenSkinTokens(tokens: ResolvedSkinTokens): Record<string, string> {
  const vars: Record<string, string> = {
    '--bp-mode': tokens.mode,
    '--bp-card-bg': tokens.color.cardBg,
    '--bp-card-bg-alt': tokens.color.cardBgAlt,
    '--bp-accent': tokens.color.accent,
    '--bp-accent-soft': tokens.color.accentSoft,
    '--bp-border': tokens.color.border,
    '--bp-text-primary': tokens.color.textPrimary,
    '--bp-text-muted': tokens.color.textMuted,
    '--bp-success': tokens.color.success,
    '--bp-danger': tokens.color.danger,
    '--bp-radius-card': tokens.radius.card,
    '--bp-radius-control': tokens.radius.control,
    // 外壳组（--ui-* 是存量消费面：10 个面板组件已在读，落地即生效）
    '--ui-bg-color': tokens.chrome.panelBg,
    '--ui-border': tokens.chrome.panelBorder,
    '--ui-text': tokens.chrome.panelText,
    '--ui-hover': tokens.chrome.hoverBg,
  };
  if (isNonEmpty(tokens.canvas.background)) vars['--bp-canvas-bg'] = tokens.canvas.background;
  if (isNonEmpty(tokens.canvas.backgroundImage)) vars['--bp-canvas-bg-image'] = tokens.canvas.backgroundImage;
  if (isNonEmpty(tokens.canvas.grid)) vars['--bp-canvas-grid'] = tokens.canvas.grid;
  if (isNonEmpty(tokens.typography.ui)) vars['--bp-font-ui'] = tokens.typography.ui;
  if (isNonEmpty(tokens.typography.content)) vars['--bp-font-content'] = tokens.typography.content;
  for (const [cardType, color] of Object.entries(tokens.accents)) {
    if (isNonEmpty(color)) vars[`--bp-card-accent-${kebabVar(cardType)}`] = color;
  }
  return vars;
}
