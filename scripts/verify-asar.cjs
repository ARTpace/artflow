#!/usr/bin/env node
/**
 * 校验「已经打包好的 app.asar」里的关键产物，避免只看 dist/ 就宣称打包正确。
 * 用法：node scripts/verify-asar.cjs [app.asar 路径]
 * 默认：release/win-unpacked/resources/app.asar
 *
 * 注意：@electron/asar 的 extractFile 在 Windows 上要求 **本机分隔符（反斜杠）且不带前导分隔符**
 * 的条目名 —— 它内部用 path.parse + path.sep 拆目录，'dist/assets/x.css' 或
 * '\dist\assets\x.css' 都会报 `was not found in this archive`。所以 listPackage 的结果
 * 必须先剥前导分隔符再按 path.sep 归一。
 */
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');

const archive = path.resolve(process.argv[2] || path.join('release', 'win-unpacked', 'resources', 'app.asar'));
if (!fs.existsSync(archive)) {
  console.error(`verify-asar: 找不到 ${archive}`);
  process.exit(1);
}

const entries = asar.listPackage(archive);
const toAsarPath = entry => {
  const trimmed = entry.replace(/^[\\/]+/, '');
  return path.sep === '\\' ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/');
};
const readText = entry => asar.extractFile(archive, toAsarPath(entry)).toString();
const firstMatch = pattern => entries.find(entry => pattern.test(entry));

const results = [];
const expect = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
};

const distCss = firstMatch(/dist[\\/]assets[\\/]index-[^\\/]+\.css$/);
expect('dist 主样式表存在', Boolean(distCss), distCss || '');
if (distCss) {
  const css = readText(distCss);
  expect('CSS 含原生 select 下拉配色（skin 变量）',
    css.includes('select option,select optgroup{background-color:var(--bp-ui-surface-strong'),
    `${css.length}B`);
  expect('CSS 含 .pointer-events-auto（悬浮面板可点）', css.includes('.pointer-events-auto'));
}

const distJs = firstMatch(/dist[\\/]assets[\\/]index-[^\\/]+\.js$/);
if (distJs) {
  const js = readText(distJs);
  expect('JS 含插件通道字段 runtimeMode', js.includes('runtimeMode'));
  // 来源下拉只保留两档（2026-10-11 产品决定）。
  expect('JS 内含两档来源文案（内置插件 / 外部插件）',
    js.includes('内置插件') && js.includes('外部插件'));
}

const bundled = entries.filter(entry => /bundled-plugins[\\/][^\\/]+[\\/]manifest\.json$/.test(entry));
expect('内置 bundled-plugins 清单齐全（11）', bundled.length === 11, `实际 ${bundled.length}`);

let failed = 0;
for (const { label, ok, detail } of results) {
  if (!ok) failed += 1;
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
console.log(`verify-asar: ${failed === 0 ? 'OK' : `${failed} 项失败`} (${archive})`);
process.exit(failed === 0 ? 0 : 1);
