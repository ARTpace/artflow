/**
 * check-i18n-keys.cjs —— `t('key')` 调用面 vs 文案表 的离线一致性自检。
 *
 * 背景：t() 的兜底语义是 `result || key`，即**查不到就原样返回 key**。所以任何漏配/拼错的
 * key 会直接漏到界面上（显示成 "fileCard.download"），而这在 typecheck 里查不出来
 * （t 的入参是 string，不是 key 字面量联合类型）。
 *
 * 覆盖三件事：
 *   1. 扫描面里所有静态 t('a.b.c') 都能在 en / zho 两档解析出**非 undefined** 的值；
 *   2. 走 utils/language-store 的**真实**查表路径（底座 + locales 补丁合并后）再验证一遍 ——
 *      语言包插件一旦覆盖坏整段，这里会立刻失败；
 *   3. 语言包声明的语言码必须出现在设置页语言切换器的候选里（listAvailableLanguages）。
 *
 * 用法： node scripts/check-i18n-keys.cjs
 * 退出码：0 = 全部命中；1 = 有缺失。
 */
require('./register-typescript.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { translations } = require('../translations.ts');
const { validateManifest } = require('../plugin-runtime/manifest.ts');
const { resolveLocaleTable } = require('../plugin-runtime/i18n.ts');
const { setLocalePatches, listAvailableLanguages, translateFor } = require('../utils/language-store.ts');
// 声明式插件（examples/ 里的示例语言包）用主进程那份解析器，保证与运行时同一套判定。
const { listDeclarativePlugins } = require('../main/declarativePlugins.cjs');

const ROOT = path.join(__dirname, '..');
/** 本体 + 内置插件的全部 UI 源码面（hooks/services 目前 0 命中，留着防将来新增）。 */
const SCAN_DIRS = ['components', 'builtin-plugins', 'capabilities', 'plugins', 'utils', 'hooks', 'services'];
const SCAN_ROOT_FILES = ['App.tsx', 'index.tsx'];

/** 递归收集 .ts/.tsx（跳过 node_modules 与点目录）。 */
function walkDir(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkDir(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 按 'a.b.c' 路径查表。返回 undefined 表示缺失。 */
function lookup(table, key) {
  let node = table;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * 收集仓库内声明式语言包：
 *   1. builtin/<id>/manifest.json 的 contributes.locales（走 renderer 校验器，与运行时同一套）；
 *   2. examples/ 下的声明式插件（走主进程解析器，分片在这里被读掉）。
 * 两路都用**运行时那个解析器**而不是裸 JSON.parse，避免自检与真实加载语义漂移。
 */
function collectDeclaredBundles() {
  const bundles = [];
  const builtinRoot = path.join(ROOT, 'builtin-plugins');
  const builtinDirs = fs.readdirSync(builtinRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const dir of builtinDirs) {
    const manifestPath = path.join(builtinRoot, dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    for (const bundle of manifest.contributes?.locales ?? []) {
      bundles.push({ origin: `builtin/${dir}`, language: bundle.language, table: bundle.table });
    }
  }
  for (const plugin of listDeclarativePlugins(path.join(ROOT, 'examples')).plugins) {
    for (const bundle of plugin.locales ?? []) {
      bundles.push({ origin: `examples/${plugin.id}`, language: bundle.language, table: bundle.table });
    }
  }
  return bundles;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 语言包**逐键命中底座**校验。
 *
 * 为什么必须做：语言包是补丁层，补丁的键写错时**不会报任何错** —— 只是永远不生效，
 * 且 `t()` 的 `result || key` 兜底会把 key 原文印到界面上。两类问题都要当场抓住：
 *   - 键在底座不存在（拼错 / 底座改过名 / 死条目）
 *   - 形状与底座不符（形状闸会静默忽略该条，写了等于没写）
 * 底座是**函数**的键单列报告而不判失败：JSON 结构上表达不了插值，这属于通道的固有边界。
 */
function verifyBundlesAgainstBase(bundles) {
  const broken = [];
  const interpolationBound = [];
  const walk = (node, base, trail) => {
    for (const [key, value] of Object.entries(node)) {
      const keyPath = trail ? `${trail}.${key}` : key;
      const baseValue = isRecord(base) ? base[key] : undefined;
      if (baseValue === undefined) {
        broken.push({ key: keyPath, reason: '键在 en 底座不存在（拼错 / 底座已改名？）' });
        continue;
      }
      if (typeof baseValue === 'function') {
        interpolationBound.push(keyPath);
        continue;
      }
      if (Array.isArray(baseValue) !== Array.isArray(value)) {
        broken.push({ key: keyPath, reason: '形状不符（数组 vs 非数组），形状闸会忽略该条' });
        continue;
      }
      if (Array.isArray(baseValue)) continue;
      if (isRecord(baseValue) !== isRecord(value)) {
        broken.push({ key: keyPath, reason: '形状不符（对象 vs 叶子），形状闸会忽略该条' });
        continue;
      }
      if (isRecord(baseValue)) walk(value, baseValue, keyPath);
    }
  };
  for (const bundle of bundles) walk(bundle.table, translations.en, '');
  return { broken, interpolationBound: [...new Set(interpolationBound)] };
}

const files = [
  ...SCAN_DIRS.flatMap(dir => walkDir(path.join(ROOT, dir))),
  ...SCAN_ROOT_FILES.map(f => path.join(ROOT, f)),
];

/** 匹配 t('...') / t("...")；\b 保证不误伤 uiText(/bi(/resolveCommandText( 等。 */
const CALL_RE = /\bt\(\s*(['"])([^'"\n]+)\1/g;
/** 模板串调用 t(`a.b.${x}`) —— 记录下来单独人工核对，不做自动展开。 */
const TEMPLATE_RE = /\bt\(\s*`([^`\n]*)`/g;

/**
 * `t` 这个名字在本仓库有两种绑定，语义完全不同，必须分开：
 *   - `const { t } = useTranslation()`  → t 是**键查表**（本脚本的检查对象）；
 *   - `import { uiText as t }` / `const t = useUiText()` → t 是**双语简写** t('中文','English')，
 *     第一个参数本来就是文案而不是 key，拿它查表必然是 MISSING（上一版误报 15 条的根因）。
 */
const UI_TEXT_BINDINGS = [
  /\buiText\s+as\s+t\b/,
  /\b(?:const|let|var)\s+t\s*=\s*useUiText\s*\(/,
];

const isKeyLookupBinding = src => !UI_TEXT_BINDINGS.some(pattern => pattern.test(src));

/** 剥离块注释与整行行注释：注释里的示例调用（如 language-store 文档里的 t('已启用','Active')）不该被当成调用面。 */
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const staticHits = new Map();
const templateHits = new Map();
const skippedFiles = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  if (!isKeyLookupBinding(raw)) {
    skippedFiles.push(rel);
    continue;
  }
  const src = stripComments(raw);

  for (const m of src.matchAll(new RegExp(CALL_RE.source, 'g'))) {
    const key = m[2];
    if (!staticHits.has(key)) staticHits.set(key, []);
    staticHits.get(key).push(rel);
  }
  for (const m of src.matchAll(new RegExp(TEMPLATE_RE.source, 'g'))) {
    const key = m[1];
    if (!templateHits.has(key)) templateHits.set(key, []);
    templateHits.get(key).push(rel);
  }
}

const declaredBundles = collectDeclaredBundles();
setLocalePatches(declaredBundles.map(entry => ({ language: entry.language, table: entry.table })));
const { broken: brokenBundleKeys, interpolationBound } = verifyBundlesAgainstBase(declaredBundles);
/** 内置两档 + 语言包声明的档（示例包会让这里多一个 jpn）。 */
const availableLanguages = listAvailableLanguages();

const missing = [];
const nonText = [];
for (const [key, where] of staticHits) {
  const en = lookup(translations.en, key);
  const zho = lookup(translations.zho, key);
  // t() 是通用查表器：值可以是文案串/文案函数，也可以是数组等结构
  // （如 t('quickPrompts') 取的是内置提示词列表）。只有 undefined/null 才算真缺失。
  const okEn = en !== undefined && en !== null;
  const okZho = zho !== undefined && zho !== null;
  const textLike = v => typeof v === 'string' || typeof v === 'function';
  if (!okEn || !okZho) {
    missing.push({ key, en: okEn ? 'ok' : 'MISSING', zho: okZho ? 'ok' : 'MISSING', where: [...new Set(where)] });
    continue;
  }
  // 合并表（底座 + 语言包补丁）必须仍然解析得到 —— 语言包不能把某段整体删掉/覆盖成空。
  // 遍历**全部可用语言**而不仅是内置两档：语言包新增的档同样不得漏出 key 原文。
  for (const language of availableLanguages) {
    const merged = translateFor(language, key);
    if (merged === key && typeof en === 'string') {
      missing.push({
        key,
        en: 'ok',
        zho: `${language} 合并后丢失`,
        where: [...new Set(where)],
      });
      break;
    }
  }
  if (!textLike(en) || !textLike(zho)) {
    nonText.push({ key, kind: Array.isArray(en) ? 'array' : typeof en, where: [...new Set(where)] });
  }
}

/**
 * 模板串 key（`finder.filters.${option}`）无法枚举出具体键，但可以做**前缀父节点**断言：
 * 取首个 ${ 之前的点分路径，该节点必须在两档里都存在、非空、且键集完全一致 ——
 * 这样「加了 en 档选项却漏了 zho 档」这类半残会被抓住。
 */
const templateParents = [];
for (const [key, where] of templateHits) {
  const prefix = key.slice(0, key.indexOf('${')).replace(/\.$/, '');
  if (!prefix) continue;
  const enNode = lookup(translations.en, prefix);
  const zhoNode = lookup(translations.zho, prefix);
  const problems = [];
  if (!enNode || typeof enNode !== 'object') problems.push(`en 档缺少节点 ${prefix}`);
  if (!zhoNode || typeof zhoNode !== 'object') problems.push(`zho 档缺少节点 ${prefix}`);
  if (problems.length === 0) {
    const enKeys = Object.keys(enNode).sort();
    const zhoKeys = Object.keys(zhoNode).sort();
    if (enKeys.length === 0) problems.push(`${prefix} 是空节点，模板串永远查不到值`);
    if (JSON.stringify(enKeys) !== JSON.stringify(zhoKeys)) {
      problems.push(`${prefix} 两档键集不一致：en=[${enKeys}] zho=[${zhoKeys}]`);
    }
  }
  templateParents.push({ key, prefix, where: [...new Set(where)], problems });
}

// 语言包声明的语言码必须出现在设置页语言切换器候选里（否则注册了也切不过去）
const available = availableLanguages;
const declaredLanguages = [...new Set(declaredBundles.map(entry => entry.language))];
const unlisted = declaredLanguages.filter(language => !available.includes(language));
assert.deepEqual(unlisted, [], `语言包声明的语言未出现在 listAvailableLanguages()：${unlisted.join(', ')}`);

// listAvailableLanguages 必须以内置两档开头（切换器默认顺序）
assert.deepEqual(available.slice(0, Object.keys(translations).length), Object.keys(translations));

console.log('scanned files      :', files.length, skippedFiles.length ? `(跳过 ${skippedFiles.length} 个 uiText 双语绑定的文件)` : '');
console.log('static t() keys    :', staticHits.size);
console.log('template t() keys  :', templateHits.size);
console.log(
  'locale bundles     :',
  declaredBundles.length,
  declaredBundles.map(entry => `${entry.origin}:${entry.language}`).join(', ') || '(none)',
);
console.log('available languages:', available.join(', '));

if (skippedFiles.length) {
  console.log('\n-- 跳过（该文件里 t 是 uiText/useUiText 双语简写，不是键查表）--');
  for (const rel of skippedFiles) console.log(`  ${rel}`);
}

if (templateParents.length) {
  console.log('\n-- 模板串调用（键名运行时拼接，改查前缀父节点）--');
  for (const row of templateParents) {
    const mark = row.problems.length ? 'FAIL' : 'ok  ';
    console.log(`  [${mark}] ${row.key}  -> ${row.prefix}  <- ${row.where.join(', ')}`);
    for (const problem of row.problems) console.log(`         ${problem}`);
  }
}
const templateProblems = templateParents.filter(row => row.problems.length);
if (templateProblems.length) process.exitCode = 1;

if (nonText.length) {
  console.log(`\n-- 非文案型 key（${nonText.length} 个：数组/对象，属特例用法，需人工确认）--`);
  for (const row of nonText) {
    console.log(`  ${row.key}  (${row.kind})  <- ${row.where.join(', ')}`);
  }
}

if (brokenBundleKeys.length) {
  console.log(`\n-- 语言包有 ${brokenBundleKeys.length} 条写了但不生效（键不存在或形状不符）--`);
  for (const row of brokenBundleKeys) console.log(`  ${row.key}  —— ${row.reason}`);
  process.exitCode = 1;
} else if (declaredBundles.length) {
  console.log(`\nOK: ${declaredBundles.length} 个语言包的每一条都命中了底座且形状相符。`);
}

// B2 端到端：语言包真的能让新语言出文案，未覆盖的键回落 en 档（不出 key 原文）。
// 期望值与"—未覆盖键"都从包里算出来，而不是写死 key/文案 —— 否则改示例就会让断言失真。
const findUncoveredStringKey = (base, bundle, trail) => {
  for (const [key, value] of Object.entries(base)) {
    const keyPath = trail ? `${trail}.${key}` : key;
    const patched = isRecord(bundle) ? bundle[key] : undefined;
    if (typeof value === 'string') {
      if (patched === undefined) return keyPath;
      continue;
    }
    if (isRecord(value)) {
      const found = findUncoveredStringKey(value, patched, keyPath);
      if (found) return found;
    }
  }
  return null;
};
for (const declared of declaredBundles) {
  const sample = declared.table.toolbar?.undo;
  if (typeof sample === 'string') {
    assert.equal(
      translateFor(declared.language, 'toolbar.undo'),
      sample,
      `${declared.origin} 的 ${declared.language} 覆盖率未生效`,
    );
    assert.notEqual(translateFor(declared.language, 'toolbar.undo'), translations.en.toolbar.undo);
  }
  const uncoveredKey = findUncoveredStringKey(translations.en, declared.table, '');
  assert.ok(uncoveredKey, `${declared.origin} 竟然覆盖了底座全部字符串叶子，无法验证回落`);
  const uncovered = translateFor(declared.language, uncoveredKey);
  assert.equal(uncovered, lookup(translations.en, uncoveredKey), `未覆盖的 ${uncoveredKey} 必须回落 en 档文案`);
  assert.notEqual(uncovered, uncoveredKey, `未覆盖的 ${uncoveredKey} 漏成了 key 原文`);
  console.log(`[ok] ${declared.origin}:${declared.language} 覆盖生效，未覆盖键 ${uncoveredKey} 回落 en 档`);
}

if (interpolationBound.length) {
  console.log(`\n-- 无法由语言包覆盖的 ${interpolationBound.length} 条插值文案（底座是函数，JSON 表达不了）--`);
  console.log('   ' + interpolationBound.join(', '));
}

if (missing.length) {
  console.log(`\n-- 缺失 ${missing.length} 个 key --`);
  for (const row of missing) {
    console.log(`  MISSING en=${row.en} zho=${row.zho}  ${row.key}`);
    console.log(`      <- ${row.where.join(', ')}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nOK: 所有静态 t() key 在 en/zho 两档（含语言包合并后）都能解析。');
}
