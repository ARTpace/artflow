/**
 * skin-css-sanitize.ts —— 皮肤 CSS 覆盖层的注册门禁（M1）。
 *
 * 红线（见《皮肤系统升级开发文档》第 0/4.4 节）：皮肤永远不能注入 script/JS 事件，
 * CSS 是纯样式且必须完全作用域在本皮肤内。本文件是零依赖的静态检查，
 * 命中任一规则即**整份拒收**（返回错误列表），不做部分应用。
 *
 * 规则：
 * 1. 禁止 @import / @charset（外链注入面）。
 * 2. 禁止 url() 携带 http:// / https:// / //（协议相对）；禁止 javascript: 任何形式
 *    （检测前先去空白归一化，防 "j a v a s c r i p t:" 式混淆）。
 * 3. 禁止 expression(（古董 IE 向量，防呆）。
 * 4. 作用域校验：每条顶层规则（@media/@supports/@layer 内层也算）的选择器必须包含
 *    [data-bp-skin-active="<skinId>"]；@keyframes/@-webkit-keyframes/@-moz-keyframes/
 *    @font-face/@property 豁免（前三者无选择器，@property 只注册自定义属性描述符）；
 *    其余 @-rule 一律拒绝；顶层裸声明（规则块外的孤立语句）视为越界内容拒绝。
 *    @layer 放行块形式但**递归校验内层作用域**（防它成为作用域红线后门）；语句形式
 *    （`@layer a, b;`，无 body）自动放过——它只声明层序，不注入任何规则。
 *    按顶层块切分 + 正则检查，不做完整 CSS AST（保持零依赖）。
 * 5. 大小上限：单皮肤 CSS ≤ 512 KB（UTF-8 字节）。
 */

export const SKIN_CSS_MAX_BYTES = 512 * 1024;

export type SkinCssSanitizeResult =
  | { ok: true; css: string }
  | { ok: false; errors: string[] };

const EXEMPT_AT_RULES = new Set(['@keyframes', '@-webkit-keyframes', '@-moz-keyframes', '@font-face', '@property']);
const RECURSIVE_AT_RULES = new Set(['@media', '@supports', '@layer']);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 去注释（/* ... *\/），保留字符串内容（含转义）。 */
const stripComments = (css: string): string => {
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < css.length) { out += css[i + 1]; i += 1; }
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; out += ch; continue; }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
};

interface CssBlock { prelude: string; body: string }

/**
 * 单遍扫描切顶层块（字符串/转义感知）：
 * - 规则块：{ prelude: 选择器段, body: 块内文本 }
 * - 顶层裸声明（; 结束）与尾部残留：{ prelude: 语句, body: '' }
 */
const topLevelBlocks = (css: string): CssBlock[] => {
  const blocks: CssBlock[] = [];
  let depth = 0;
  let inString: string | null = null;
  let preludeStart = 0;
  let braceIdx = -1;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '{') {
      if (depth === 0) braceIdx = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ prelude: css.slice(preludeStart, braceIdx), body: css.slice(braceIdx + 1, i) });
        preludeStart = i + 1;
      }
    } else if (depth === 0 && ch === ';') {
      const segment = css.slice(preludeStart, i + 1);
      if (segment.trim().length > 0) blocks.push({ prelude: segment, body: '' });
      preludeStart = i + 1;
    }
  }
  const trailing = css.slice(preludeStart);
  if (trailing.trim().length > 0) blocks.push({ prelude: trailing, body: '' });
  return blocks;
};

const scanBlocks = (css: string, scopeRe: RegExp, errors: string[], depth: number): void => {
  if (depth > 4) return; // 防畸形嵌套
  for (const block of topLevelBlocks(css)) {
    const prelude = block.prelude.trim();
    if (prelude.length === 0) continue;
    if (prelude.startsWith('@')) {
      const atRuleName = `@${/@([a-zA-Z-]+)/.exec(prelude.toLowerCase())?.[1] ?? ''}`;
      if (EXEMPT_AT_RULES.has(atRuleName)) continue;
      if (RECURSIVE_AT_RULES.has(atRuleName)) {
        if (block.body.length > 0) scanBlocks(block.body, scopeRe, errors, depth + 1);
        continue;
      }
      errors.push(`unsupported at-rule: ${atRuleName}`);
      continue;
    }
    if (block.body.length === 0) {
      errors.push(`top-level statement outside a rule: ${prelude.slice(0, 80)}`);
      continue;
    }
    if (!scopeRe.test(prelude)) {
      errors.push(`rule lacks scope prefix [data-bp-skin-active="<skinId>"]: ${prelude.slice(0, 80)}`);
    }
  }
};

export function sanitizeSkinCss(skinId: string, cssText: string): SkinCssSanitizeResult {
  const errors: string[] = [];

  // —— 5. 大小上限 ——
  const byteLength = new TextEncoder().encode(cssText).length;
  if (byteLength > SKIN_CSS_MAX_BYTES) {
    return { ok: false, errors: [`css exceeds ${SKIN_CSS_MAX_BYTES} bytes (got ${byteLength})`] };
  }

  const withoutComments = stripComments(cssText);

  // —— 1. @import / @charset ——
  if (/@import\b/i.test(withoutComments)) errors.push('@import is forbidden in skin css');
  if (/@charset\b/i.test(withoutComments)) errors.push('@charset is forbidden in skin css');

  // —— 2/3. 归一化（去全部空白 + 小写）后检测 javascript: 与 expression( ——
  const normalized = withoutComments.replace(/\s+/g, '').toLowerCase();
  if (normalized.includes('javascript:')) errors.push('javascript: is forbidden in skin css');
  if (normalized.includes('expression(')) errors.push('expression() is forbidden in skin css');

  // —— 2. url() 外链检测（data: 与构建期相对/绝对路径放行）——
  const urlRe = /url\(\s*([^)]*)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(withoutComments)) !== null) {
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const lower = value.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//') || lower.startsWith('javascript:')) {
      errors.push(`external url() is forbidden: ${value.slice(0, 80)}`);
    }
  }

  // —— 4. 作用域校验（属性名大小写不敏感，skinId 值精确匹配）——
  const scopeRe = new RegExp(
    `\\[\\s*data-bp-skin-active\\s*=\\s*["']${escapeRegExp(skinId)}["']\\s*\\]`,
    'i',
  );
  scanBlocks(withoutComments, scopeRe, errors, 0);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, css: cssText };
}
