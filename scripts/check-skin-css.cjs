#!/usr/bin/env node
/**
 * check-skin-css.cjs —— 皮肤 CSS 通道门禁（接入 npm run check）。
 * 1) 纯函数单测：skin-css-sanitize（M1 红线）与 skin-customization（M2 协议）；
 * 2) 部署接线断言：aurora 示范皮肤的 manifest/css/activate 与启动顺序必须真实接上，
 *    防止"改了 after 树但远程没落盘"这类部署漂移。
 * 用法：node scripts/check-skin-css.cjs（在 web-app 根下，esbuild 来自 vite 依赖）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = ROOT; // 项目根布局：plugins/ builtin/ index.tsx 均在根下

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  [FAIL] ${name}: ${error.message}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const assertEq = (actual, expected, msg) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// —— 把两个纯模块 bundle 成临时 cjs 直跑 ——
const esbuild = require('esbuild');
const tmpOut = path.join(os.tmpdir(), `bp-skin-css-check-${process.pid}.cjs`);
// esbuild 的 import 说明符用正斜杠（Windows 反斜杠会被 JS 字符串当转义吃掉）
const toSlash = (p) => p.split('\\').join('/');
const sanitizeTs = toSlash(path.join(SRC, 'plugin-runtime', 'skin-css-sanitize.ts'));
const customizationTs = toSlash(path.join(SRC, 'plugin-runtime', 'skin-customization.ts'));
esbuild.buildSync({
  // 单 stdin 入口重导出两个纯模块（esbuild 多入口要求 outdir）
  stdin: {
    contents: `
      export * from '${sanitizeTs}';
      export * from '${customizationTs}';
    `,
    resolveDir: SRC,
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: tmpOut,
});
const {
  sanitizeSkinCss,
  SKIN_CSS_MAX_BYTES,
  validateSkinCustomizationDecl,
  readSkinConfig,
  mergeSkinConfig,
  skinConfigStorageKey,
  resolveSkinConfigBindings,
  resolveSkinAttributeBindings,
  resolveSkinClassBindings,
} = require(tmpOut);
fs.unlinkSync(tmpOut);

const SCOPE = 'builtin.skin-aurora';

console.log('sanitizeSkinCss:');
check('scoped css + @keyframes + @media + data: url 通过', () => {
  const css = [
    `[data-bp-skin-active="${SCOPE}"] .card { color: #2dd4bf; }`,
    `@media (min-width: 640px) { [data-bp-skin-active="${SCOPE}"] .big { width: 100px; } }`,
    '@keyframes bp-aurora-float { 0% { transform: none; } 100% { transform: translateY(2px); } }',
    `@font-face { font-family: 'bp-x'; src: url(data:font/woff2;base64,d09GMg==); }`,
    `[data-bp-skin-active="${SCOPE}"] img { background: url(data:image/svg+xml;utf8,<svg/>) , url(/src/assets/glow.svg); }`,
  ].join('\n');
  const r = sanitizeSkinCss(SCOPE, css);
  assert(r.ok, `should pass, got: ${JSON.stringify(r.errors)}`);
});
check('未加作用域前缀的规则 → 整份拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { color: red; } .leak { color: blue; }`);
  assert(!r.ok, 'should reject');
  assert(r.errors.some(e => e.includes('lacks scope prefix')), 'scope error expected');
});
check('@media 内层未加作用域 → 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `@media (max-width: 480px) { .leak { color: red; } }`);
  assert(!r.ok, 'should reject');
});
check('@import 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `@import "extra.css"; [data-bp-skin-active="${SCOPE}"] a { color: red; }`);
  assert(!r.ok && r.errors.some(e => e.includes('@import')), 'should reject @import');
});
check('@charset 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `@charset "utf-8"; [data-bp-skin-active="${SCOPE}"] a { color: red; }`);
  assert(!r.ok && r.errors.some(e => e.includes('@charset')), 'should reject @charset');
});
check('javascript: 大小写/空白混淆 → 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { content: "J  aVaScRip t:alert(1)"; }`);
  assert(!r.ok && r.errors.some(e => e.includes('javascript:')), 'should reject obfuscated javascript:');
});
check('url() 外链 http(s)/协议相对 → 拒收；data:/相对/单斜杠 → 放行', () => {
  const bad1 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url("http://evil/x.png"); }`);
  const bad2 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url(https://evil/x.png); }`);
  const bad3 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url(//evil/x.png); }`);
  assert(!bad1.ok && !bad2.ok && !bad3.ok, 'external urls must be rejected');
  const ok1 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url(data:image/png;base64,iVBORw0KGgo=); }`);
  const ok2 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url(./assets/glow.svg); }`);
  const ok3 = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { background: url(/src/assets/glow.svg); }`);
  assert(ok1.ok && ok2.ok && ok3.ok, `data/relative/absolute-local urls must pass: ${JSON.stringify([ok1, ok2, ok3])}`);
});
check('expression( 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { width: expression(alert(1)); }`);
  assert(!r.ok && r.errors.some(e => e.includes('expression')), 'should reject expression()');
});
check('顶层裸声明 → 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `color: red; [data-bp-skin-active="${SCOPE}"] a { color: blue; }`);
  assert(!r.ok && r.errors.some(e => e.includes('top-level statement')), 'should reject top-level statement');
});
check('未知 @-rule 拒收', () => {
  const r = sanitizeSkinCss(SCOPE, `@counter-reset x { a: 1; } [data-bp-skin-active="${SCOPE}"] b { color: red; }`);
  assert(!r.ok && r.errors.some(e => e.includes('unsupported at-rule')), 'should reject unknown at-rule');
});
check('@property 注册与 @layer 放行；@layer 块内层仍受作用域约束', () => {
  const ok = sanitizeSkinCss(SCOPE, [
    `@property --bp-glow { syntax: '<color>'; inherits: false; initial-value: #000; }`,
    `@layer base { [data-bp-skin-active="${SCOPE}"] a { color: red; } }`,
    '@layer utilities, overrides;',
    `[data-bp-skin-active="${SCOPE}"] b { --bp-x: 1; transition: --bp-x .3s; }`,
  ].join('\n'));
  assert(ok.ok, `@property/@layer must pass, got: ${JSON.stringify(ok.errors)}`);
  // 安全关键：@layer 不能成为作用域红线的后门——块内层缺前缀照样拒
  const leak = sanitizeSkinCss(SCOPE, `@layer base { .leak { color: red; } }`);
  assert(!leak.ok && leak.errors.some(e => e.includes('lacks scope prefix')), 'unscoped rule inside @layer must be rejected');
  const nested = sanitizeSkinCss(SCOPE, `@media (min-width: 640px) { @layer base { .leak { color: red; } } }`);
  assert(!nested.ok && nested.errors.some(e => e.includes('lacks scope prefix')), 'unscoped rule inside nested @layer must be rejected');
});
check('作用域属性名大小写不敏感、skinId 值精确匹配', () => {
  const caseOk = sanitizeSkinCss(SCOPE, `[DATA-BP-SKIN-ACTIVE="${SCOPE}"] a { color: red; }`);
  const otherSkin = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="builtin.skin-other"] a { color: red; }`);
  assert(caseOk.ok, 'case-insensitive attr name must pass');
  assert(!otherSkin.ok, 'different skinId must be rejected');
});
check('超过 512KB 拒收', () => {
  const filler = 'x'.repeat(SKIN_CSS_MAX_BYTES);
  const r = sanitizeSkinCss(SCOPE, `[data-bp-skin-active="${SCOPE}"] a { content: "${filler}"; }`);
  assert(!r.ok && r.errors.some(e => e.includes('exceeds')), 'should reject oversized css');
});
check('注释里的 @import 不误伤（strip 后检测）', () => {
  const r = sanitizeSkinCss(SCOPE, `/* @import "evil.css" — just a comment */ [data-bp-skin-active="${SCOPE}"] a { color: red; }`);
  assert(r.ok, `commented @import should pass, got: ${JSON.stringify(r.errors)}`);
});

console.log('skin-customization:');
const makeDecl = (overrides = {}) => validateSkinCustomizationDecl({
  title: '测试设置',
  settings: [
    { key: 'showGlow', type: 'boolean', label: '辉光', defaultValue: true },
    { key: 'glowIntensity', type: 'number', label: '强度', defaultValue: 0.6, min: 0, max: 1, step: 0.05 },
    { key: 'fontHint', type: 'string', label: '字体', defaultValue: 'ui', maxLength: 8 },
    { key: 'tone', type: 'select', label: '色调', defaultValue: 'teal', options: [{ value: 'teal', label: '青' }, { value: 'violet', label: '紫' }] },
  ],
}, SCOPE, []);
check('合法声明（4 类型）通过', () => {
  const decl = makeDecl();
  assert(decl && decl.settings.length === 4, 'decl expected');
});
check('重复 key / 非法 key 模式 / 超 12 项 → 拒收', () => {
  const reasons = [];
  const dup = validateSkinCustomizationDecl({
    title: 't',
    settings: [{ key: 'a', type: 'boolean', label: 'a', defaultValue: true }, { key: 'a', type: 'boolean', label: 'b', defaultValue: false }],
  }, SCOPE, reasons);
  assert(dup === null && reasons.length > 0, 'duplicate key must fail');
  reasons.length = 0;
  const badKey = validateSkinCustomizationDecl({
    title: 't',
    settings: [{ key: '9bad', type: 'boolean', label: 'a', defaultValue: true }],
  }, SCOPE, reasons);
  assert(badKey === null && reasons.length > 0, 'bad key pattern must fail');
  reasons.length = 0;
  const tooMany = validateSkinCustomizationDecl({
    title: 't',
    settings: Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, type: 'boolean', label: 'l', defaultValue: true })),
  }, SCOPE, reasons);
  assert(tooMany === null && reasons.length > 0, '>12 settings must fail');
});
check('select defaultValue 不在选项内 / number min>max → 拒收', () => {
  const reasons = [];
  const badSelect = validateSkinCustomizationDecl({
    title: 't',
    settings: [{ key: 'tone', type: 'select', label: 't', defaultValue: 'nope', options: [{ value: 'a', label: 'A' }] }],
  }, SCOPE, reasons);
  assert(badSelect === null, 'select default not in options must fail');
  reasons.length = 0;
  const badRange = validateSkinCustomizationDecl({
    title: 't',
    settings: [{ key: 'n', type: 'number', label: 't', defaultValue: 0.5, min: 1, max: 0 }],
  }, SCOPE, reasons);
  assert(badRange === null, 'min>max must fail');
});
check('readSkinConfig：坏键丢弃、好键保留、损坏 JSON 回落默认', () => {
  const decl = makeDecl();
  const storage = (obj) => ({
    getItem: (k) => (k in obj ? obj[k] : null),
    setItem: () => {},
  });
  const good = readSkinConfig(storage({ 'bp-skin-config.x': JSON.stringify({ showGlow: false, glowIntensity: 0.2 }) }), 'x', decl);
  assertEq(good.showGlow, false, 'good boolean kept');
  assertEq(good.glowIntensity, 0.2, 'good number kept');
  const bad = readSkinConfig(storage({ 'bp-skin-config.x': JSON.stringify({ showGlow: 'yes', glowIntensity: 3, tone: 'nope', extraKey: 1 }) }), 'x', decl);
  assertEq(bad.showGlow, true, 'invalid boolean dropped → default');
  assertEq(bad.glowIntensity, 0.6, 'out-of-range number dropped → default');
  assertEq(bad.tone, 'teal', 'select value not in options dropped → default');
  assert(!('extraKey' in bad), 'unknown key never leaks');
  const corrupt = readSkinConfig(storage({ 'bp-skin-config.x': '{not json' }), 'x', decl);
  assertEq(corrupt.showGlow, true, 'corrupt storage → defaults');
});
check('mergeSkinConfig：未知键丢弃、changed 语义正确', () => {
  const decl = makeDecl();
  const current = { showGlow: true, glowIntensity: 0.6, fontHint: 'ui', tone: 'teal' };
  const noChange = mergeSkinConfig(current, { showGlow: true, bogus: 1 }, decl);
  assertEq(noChange.changed, false, 'no-op patch');
  const changed = mergeSkinConfig(current, { glowIntensity: 0.9, bogus: 1 }, decl);
  assertEq(changed.changed, true, 'valid patch');
  assertEq(changed.config.glowIntensity, 0.9, 'patched value applied');
  assert(!('bogus' in changed.config), 'unknown key dropped');
  assertEq(skinConfigStorageKey(SCOPE), `bp-skin-config.${SCOPE}`, 'storage key namespaced by skinId');
});
check('attributeBindings（M4）：合法声明通过；坏属性名/未知键/非 boolean 键/重名/缺 on/空数组 → 拒收', () => {
  const base = () => ({
    title: 't',
    settings: [
      { key: 'showGlow', type: 'boolean', label: '辉光', defaultValue: true },
      { key: 'tone', type: 'select', label: '色调', defaultValue: 'teal', options: [{ value: 'teal', label: '青' }] },
    ],
  });
  const ok = validateSkinCustomizationDecl({
    ...base(),
    attributeBindings: [{ name: 'data-bp-glow', key: 'showGlow', on: 'on', off: 'off' }],
  }, SCOPE, []);
  assert(ok && ok.attributeBindings?.length === 1, 'valid attributeBindings must pass');
  const cases = [
    { attributeBindings: [{ name: '9bad', key: 'showGlow', on: 'on' }] },
    { attributeBindings: [{ name: 'data-x', key: 'nope', on: 'on' }] },
    { attributeBindings: [{ name: 'data-x', key: 'tone', on: 'on' }] },
    { attributeBindings: [{ name: 'data-x', key: 'showGlow', on: 'on' }, { name: 'data-x', key: 'showGlow', on: 'off' }] },
    { attributeBindings: [{ name: 'data-x', key: 'showGlow' }] },
    { attributeBindings: [{ name: 'data-x', key: 'showGlow', on: '' }] },
    { attributeBindings: [] },
    { attributeBindings: 'nope' },
  ];
  cases.forEach((patch, i) => {
    const reasons = [];
    const decl = validateSkinCustomizationDecl({ ...base(), ...patch }, SCOPE, reasons);
    assert(decl === null && reasons.length > 0, `case ${i} must be rejected`);
  });
});
check('resolveSkinAttributeBindings：true→on、false→off、false 无 off→不出结果（引擎按移除处理）', () => {
  const bindings = [
    { name: 'data-a', key: 'a', on: 'on', off: 'off' },
    { name: 'data-b', key: 'b', on: 'on' },
  ];
  assertEq(resolveSkinAttributeBindings(bindings, { a: true, b: true }), { 'data-a': 'on', 'data-b': 'on' }, 'both on');
  assertEq(resolveSkinAttributeBindings(bindings, { a: false, b: true }), { 'data-a': 'off', 'data-b': 'on' }, 'a off');
  assertEq(resolveSkinAttributeBindings(bindings, { a: false, b: false }), { 'data-a': 'off' }, 'b removed');
  assertEq(resolveSkinAttributeBindings(bindings, { a: 'yes', b: true }), { 'data-b': 'on' }, 'non-boolean ignored');
  assertEq(resolveSkinAttributeBindings(undefined, { a: true }), {}, 'no bindings → empty');
});
check('classBindings（M5）：合法声明通过；坏类名/未知键/非 boolean 键/on 与 off 互撞/缺 on/空数组 → 拒收', () => {
  const base = () => ({
    title: 't',
    settings: [
      { key: 'compact', type: 'boolean', label: '紧凑', defaultValue: true },
      { key: 'cinema', type: 'boolean', label: '影院', defaultValue: false },
      { key: 'tone', type: 'select', label: '色调', defaultValue: 'teal', options: [{ value: 'teal', label: '青' }] },
    ],
  });
  const ok = validateSkinCustomizationDecl({
    ...base(),
    classBindings: [{ key: 'compact', on: 'is-compact', off: 'is-roomy' }],
  }, SCOPE, []);
  assert(ok && ok.classBindings?.length === 1, 'valid classBindings must pass');
  const cases = [
    { classBindings: [{ key: 'compact', on: '9bad' }] },
    { classBindings: [{ key: 'compact', on: 'is x' }] },
    { classBindings: [{ key: 'nope', on: 'is-x' }] },
    { classBindings: [{ key: 'tone', on: 'is-x' }] },
    { classBindings: [{ key: 'compact', on: 'is-x' }, { key: 'cinema', on: 'is-x' }] },
    { classBindings: [{ key: 'compact', on: 'is-x', off: 'is-x' }] },
    { classBindings: [{ key: 'compact' }] },
    { classBindings: [] },
    { classBindings: 'nope' },
  ];
  cases.forEach((patch, i) => {
    const reasons = [];
    const decl = validateSkinCustomizationDecl({ ...base(), ...patch }, SCOPE, reasons);
    assert(decl === null && reasons.length > 0, `case ${i} must be rejected`);
  });
});
check('resolveSkinClassBindings：true→on 加/off 移除、false 反之、非 boolean→不动', () => {
  const bindings = [
    { key: 'a', on: 'is-a-on', off: 'is-a-off' },
    { key: 'b', on: 'is-b-on' },
  ];
  assertEq(resolveSkinClassBindings(bindings, { a: true, b: true }), { 'is-a-on': true, 'is-a-off': false, 'is-b-on': true }, 'both on');
  assertEq(resolveSkinClassBindings(bindings, { a: false, b: true }), { 'is-a-on': false, 'is-a-off': true, 'is-b-on': true }, 'a off with off-class');
  assertEq(resolveSkinClassBindings(bindings, { a: false, b: false }), { 'is-a-on': false, 'is-a-off': true, 'is-b-on': false }, 'both off');
  assertEq(resolveSkinClassBindings(bindings, { a: 'yes', b: true }), { 'is-b-on': true }, 'non-boolean ignored');
  assertEq(resolveSkinClassBindings(undefined, { a: true }), {}, 'no bindings → empty');
});

check('branding（M6）：合法声明通过；appLogo 非空字符串 / splash.background·accent 非空字符串 / 非法类型 → 拒收', () => {
  const base = () => ({ title: 't', settings: [{ key: 'showGlow', type: 'boolean', label: '辉光', defaultValue: true }] });
  const ok = validateSkinCustomizationDecl({ ...base(), branding: { appLogo: 'data:image/png;base64,AAA', splash: { background: '#10131c', accent: '#22d3ee' } } }, SCOPE, []);
  assert(ok && ok.branding && ok.branding.appLogo === 'data:image/png;base64,AAA', 'valid branding must pass');
  assertEq(ok.branding.splash, { background: '#10131c', accent: '#22d3ee' }, 'splash shape');
  // splash 两字段相互独立可选：只给 background（无 accent）也应接受。
  const partial = validateSkinCustomizationDecl({ ...base(), branding: { splash: { background: '#10131c' } } }, SCOPE, []);
  assert(partial && partial.branding && partial.branding.splash && partial.branding.splash.background === '#10131c' && !('accent' in partial.branding.splash), 'partial splash (background only) accepted');
  const cases = [
    { branding: { appLogo: '' } },
    { branding: { appLogo: 123 } },
    { branding: { splash: { background: '', accent: '#22d3ee' } } },
    { branding: { splash: { background: '#10131c', accent: 5 } } },
    { branding: { appLogo: 'data:x', splash: 'nope' } },
    { branding: [] },
    { branding: 'nope' },
  ];
  cases.forEach((patch, i) => {
    const reasons = [];
    const decl = validateSkinCustomizationDecl({ ...base(), ...patch }, SCOPE, reasons);
    assert(decl === null && reasons.length > 0, `case ${i} must be rejected`);
  });
});

// —— 部署接线断言：远程必须真实落盘以下文件/接线 ——
console.log('deployment wiring:');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('aurora 声明式清单：plugins 落地且含 inlined css/preview/customization', () => {
  const manifest = JSON.parse(read('plugins/builtin.skins-aurora/manifest.json'));
  assertEq(manifest.id, 'builtin.skins-aurora', 'plugin id');
  assertEq(manifest.runtime?.mode, 'declarative', 'must be declarative external skin');
  const skin = manifest.contributes.skins[0];
  assertEq(skin.id, SCOPE, 'skin id');
  assertEq(skin.order, 50, 'order');
  assert(typeof skin.css === 'string' && skin.css.length > 0, 'css must be inlined');
  assert(skin.css.includes('data:image/svg+xml;base64,'), 'glow asset must be inlined as dataURI');
  assert(Array.isArray(skin.tags) && skin.tags.length >= 1 && skin.tags.every(t => typeof t === 'string' && t.length <= 16), 'tags shape');
  assert(typeof skin.preview?.dark === 'string' && typeof skin.preview?.light === 'string', 'preview {dark,light} required');
  assert(skin.customization && skin.customization.settings.length >= 2, 'customization with >=2 settings');
});
check('aurora 皮肤 CSS 通过自己的 sanitizer', () => {
  const manifest = JSON.parse(read('plugins/builtin.skins-aurora/manifest.json'));
  const r = sanitizeSkinCss(SCOPE, manifest.contributes.skins[0].css);
  assert(r.ok, `aurora skin.css must pass sanitizer: ${JSON.stringify(r.errors)}`);
});
check('aurora 辉光开关由声明式 attributeBindings 承载（引擎属性投影，无运行时底座）', () => {
  const manifest = JSON.parse(read('plugins/builtin.skins-aurora/manifest.json'));
  const decl = manifest.contributes.skins[0].customization;
  const glow = (decl.attributeBindings ?? []).find(b => b.name === 'data-bp-aurora-glow');
  assert(glow && glow.key === 'showGlow' && glow.on === 'on' && glow.off === 'off', 'aurora glow attributeBinding missing');
  assertEq(decl.binding?.glowIntensity, '--bp-aurora-glow-opacity', 'glow intensity css binding missing');
  const engine = read('plugin-runtime/skin-engine.ts');
  assert(engine.includes('resolveSkinAttributeBindings'), 'engine attribute projection wiring missing');
  assert(engine.includes('appliedBindingAttrs'), 'engine applied-attribute tracking missing');
  assert(!fs.existsSync(path.join(SRC, 'builtin-plugins', 'skins-ambient')),
    'skins-ambient retired: the runtime projection base must not come back');
});
check('skins-ambient 已退役：注册表不得残留 import 与登记项', () => {
  const code = read('builtin-plugins/index.ts');
  assert(!code.includes('skins-ambient'), 'retired import must not come back');
  assert(!code.includes('skinsAmbientPlugin'), 'retired registry entry must not come back');
});
check('index.tsx 启动顺序：create → provide → loadBuiltinPlugins → materialize → bootstrap(existing)', () => {
  const code = read('index.tsx');
  const iCreate = code.indexOf('createSkinEngine(kernel)');
  const iProvide = code.indexOf('kernel.provide(SKIN_ENGINE_SERVICE, skinEngine)');
  const iLoad = code.indexOf('loadBuiltinPlugins(kernel');
  const iMat = code.indexOf('materializeRendererContributions(kernel)');
  const iBoot = code.indexOf('bootstrapSkinEngine(kernel, skinEngine)');
  assert(iCreate >= 0 && iProvide > iCreate && iLoad > iProvide && iMat > iLoad && iBoot > iMat,
    `order broken: create=${iCreate} provide=${iProvide} load=${iLoad} materialize=${iMat} bootstrap=${iBoot}`);
});
check('skin-engine 关键接线：data-bp-skin-active / 单 style 元素 / 持久化 cssSkinId', () => {
  const code = read('plugin-runtime/skin-engine.ts');
  assert(code.includes('data-bp-skin-active'), 'scope attribute wiring missing');
  assert(code.includes('bp-skin-css-'), 'style element id wiring missing');
  assert(code.includes('cssSkinId'), 'cssSkinId persistence missing');
  assert(code.includes('setCssSkin(null)'), 'css fallback path missing');
});

console.log('abyssal skin integration:');
check('明暗皮肤的声明式清单、原图与内联 CSS 均可被宿主接收', () => {
  const manifest = JSON.parse(read('plugins/builtin.skins-abyssal-serenade/manifest.json'));
  assertEq(manifest.id, 'builtin.skins-abyssal-serenade', 'plugin id');
  assertEq(manifest.runtime?.mode, 'declarative', 'must be declarative external skin');
  for (const mode of ['light', 'dark']) {
    const id = `builtin.skin-abyssal-${mode}`;
    const entry = manifest.contributes.skins.find(skin => skin.id === id);
    assert(entry && entry.mode === mode && entry.tokens.mode === mode, `${mode} variant missing`);
    assert(entry.preview[mode].startsWith('data:image/jpeg;base64,'), `${mode} screenshot must be inlined`);
    assert(entry.gallery?.family === 'builtin.abyssal-serenade', `${mode} gallery family missing`);
    assert(entry.gallery?.poster?.startsWith('data:image/webp;base64,'), `${mode} unbranded wallpaper poster must be inlined`);
    assert(entry.gallery?.credit?.includes('CC-BY-NC-SA-4.0'), `${mode} original art credit missing`);
    assert(entry.customization.settings.some(field => field.key === 'showWallpaper'), 'wallpaper setting missing');
    const css = entry.css;
    const result = sanitizeSkinCss(id, css);
    assert(result.ok, `${mode} CSS rejected: ${JSON.stringify(result.errors)}`);
    assert(css.includes('data:image/webp;base64,'), `${mode} wallpaper must be inlined`);
    assert(css.includes('prefers-reduced-motion'), `${mode} reduced motion missing`);
    assert(!/__([A-Z_]+)__/.test(css), `${mode} unresolved CSS placeholder`);
  }
  for (const mode of ['light', 'dark']) {
    const entry = manifest.contributes.skins.find(skin => skin.id === `builtin.skin-abyssal-${mode}`);
    const bubbles = (entry.customization.attributeBindings ?? []).find(b => b.name === 'data-bp-abyssal-bubbles');
    assert(bubbles && bubbles.key === 'showBubbles' && bubbles.on === 'on' && bubbles.off === 'off',
      `${mode} bubbles attributeBinding missing`);
    assert(!entry.css.includes('data-bp-abyssal-bubbles] > i'), `${mode} bubbles must be pure css (no widget dom)`);
    assert(!('bubbleCount' in Object.fromEntries(entry.customization.settings.map(f => [f.key, true]))),
      `${mode} bubbleCount setting must be retired with the widget`);
  }
});

console.log('M6 branding wiring:');
check('main.cjs：品牌取数 + 托盘 + splash + skinChanged 通道齐备', () => {
  const main = read('main.cjs');
  assert(main.includes('readActiveSkinBranding'), 'readActiveSkinBranding missing');
  assert(main.includes('createTray'), 'createTray missing');
  assert(main.includes('updateTrayImage'), 'updateTrayImage missing');
  assert(main.includes('buildSplashCss'), 'buildSplashCss missing');
  assert(main.includes("skinChanged: 'artflow-app:skin-changed'"), 'skinChanged channel missing');
  assert(main.includes('reportSplashProgress'), 'reportSplashProgress missing');
});
check('preload.cjs + skin-engine.ts：skinChanged 通知链路闭合', () => {
  const preload = read('preload.cjs');
  assert(preload.includes('notifySkinChanged'), 'preload bridge notifySkinChanged missing');
  const engine = read('plugin-runtime/skin-engine.ts');
  assert(engine.includes('notifyHostSkinChanged'), 'skin-engine notifyHostSkinChanged missing');
});
check('splash.html：主题化配色变量 + 真实进度钩子', () => {
  const splash = read('branding/splash.html');
  assert(splash.includes('--bp-splash-bg'), 'splash bg var missing');
  assert(splash.includes('--bp-splash-accent'), 'splash accent var missing');
  assert(splash.includes('window.__splashProgress'), 'splash progress hook missing');
  assert(splash.includes('var(--bp-splash-bg)'), 'card must consume splash bg var');
  assert(splash.includes('var(--bp-splash-accent)'), 'bar must consume splash accent var');
});

console.log('native select dropdown:');
check('原生 select 下拉可读：option 显式声明皮肤底色与字色', () => {
  // 弹出列表由 Chromium 自绘，默认浅色底；option 继承浅色文字会造成白底白字。
  const css = read('index.css');
  assert(/select option[\s\S]{0,200}?background-color:\s*var\(--bp-ui-surface-strong/.test(css),
    'option background-color must follow the skin surface');
  assert(/select option[\s\S]{0,200}?color:\s*var\(--bp-ui-text/.test(css),
    'option color must follow the skin text color');
});

if (failures > 0) {
  console.error(`check-skin-css: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('check-skin-css: OK');
