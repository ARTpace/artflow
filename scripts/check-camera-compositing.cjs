// Run from project root: node scripts/check-camera-compositing.cjs
//
// 本自检最初为 ADR-049（相机 transform 挂 <svg> 根元素）而写；该方案已被真机证伪，
// 由 ADR-051 回退：transform 回到内层 <g>，<svg> 根不得携带相机变换。
// （真机症状：滚动缩放很闪、图片消失、滚动和拖动突然失效 —— 合成层栅格比例失配，
// 详见 docs/adr/ADR-051；命中测试假说已被 scratch/probe-svg-root-hit-test.html 排除。）
//
// 现在覆盖两件事：
// 1) SSR 渲染契约：相机 transform 挂在内层 <g>（will-change:transform），
//    <svg> 根元素不携带 transform / transform-origin / overflow / will-change。
// 2) 源码守卫：所有"屏幕 ↔ 世界"坐标换算统一走 getCanvasScreenRect（外层未变换容器）。
//    注意：无论相机挂在 <g> 还是 <svg> 上，<svg> 自身的 rect 在 <g> 方案下虽是稳定的，
//    统一量"外层容器"对两种方案都正确且只量一次布局，故保留该契约。
// 注意：这是逻辑与源码检查，真机帧率仍需实测。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// ---------------------------------------------------------------- SSR 渲染契约
const localStorageBacking = new Map();
globalThis.localStorage = {
  get length() { return localStorageBacking.size; },
  key: index => Array.from(localStorageBacking.keys())[index] ?? null,
  getItem: key => (localStorageBacking.has(String(key)) ? localStorageBacking.get(String(key)) : null),
  setItem: (key, value) => { localStorageBacking.set(String(key), String(value)); },
  removeItem: key => { localStorageBacking.delete(String(key)); },
  clear: () => localStorageBacking.clear(),
};

const { createKernel } = require('../plugin-runtime/kernel.ts');
const { setKernel } = require('../plugin-runtime/instance.ts');
setKernel(createKernel());

const App = require('../App.tsx').default;
const html = renderToStaticMarkup(React.createElement(App));
const compact = html.replace(/\s+/g, '');

// 相机载体必须是内层 <g>：SSR 走 store 分支（imperative 层独占 transform），
// React markup 里 <g> 携带 will-change 而没有 translate3d。
assert.match(compact, /<gstyle="will-change:transform"/, '相机载体必须是内层 <g>（will-change:transform）');
assert.doesNotMatch(compact, /translate3d\(/, 'React 不得渲染 translate3d：store 模式下 transform 由 imperative 层独占');
assert.match(compact, /will-change:transform/, '相机载体缺少 will-change:transform');
// <svg> 根元素禁止携带相机变换（ADR-049 已被真机证伪，ADR-051 回退）。
assert.doesNotMatch(
  html,
  /<svg[^>]*style="[^"]*(will-change|transform-origin|overflow|transform\s*:)/i,
  '<svg> 根元素不得携带相机 transform / will-change / overflow:visible（ADR-051）',
);

// ---------------------------------------------------------------- 源码守卫
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
/** 源码守卫只针对代码本身：注释里出现旧写法名不该让守卫误判。 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const readCode = rel => stripComments(read(rel));

// 1. 统一换算基准：helper 必须量外层容器（未变换；对 <g>/<svg> 两种载体都正确）。
const canvasUtilsSource = readCode('utils/canvasUtils.ts');
assert.match(canvasUtilsSource, /export const getCanvasScreenRect/);
assert.match(canvasUtilsSource, /svg\?\.parentElement/);

// 2. MainCanvas：transform 写在内层 <g> 上；<svg> 根不得承担相机变换。
const mainCanvasSource = readCode('components/MainCanvas.tsx');
assert.match(mainCanvasSource, /group\.style\.transform = `translate3d\(/, 'store 模式下 live transform 必须写内层 <g>');
assert.match(
  mainCanvasSource,
  /transform: canvasTransform, willChange: 'transform'/,
  '无 store 兼容路径也必须把相机挂在内层 <g> 上',
);
assert.doesNotMatch(mainCanvasSource, /svg\.style\.transform/, '相机 transform 不得写 <svg> 根元素（ADR-051）');
assert.doesNotMatch(mainCanvasSource, /svg\.style\.willChange/, '<svg> 根不得设置 will-change（合成层豪赌已被真机证伪）');
assert.doesNotMatch(
  mainCanvasSource,
  /transformOrigin: '0 0', overflow: 'visible'/,
  '<svg> 根不得携带 transform-origin/overflow 相机配套样式（ADR-051）',
);
assert.equal(
  (mainCanvasSource.match(/getBoundingClientRect/g) || []).length,
  1,
  'MainCanvas 只允许在尺寸测量处量一次布局（且量的是外层容器）',
);

// 3. 旧写法清零：任何文件都不允许再用 <svg> 自己的 rect 做世界坐标换算。
//    （<g> 方案下 svg rect 恰好稳定，但统一容器基准对将来任何载体变化都稳健。）
const legacyCallers = [
  'App.tsx',
  'hooks/useCanvasInteractions.ts',
  'hooks/useAIHandlers.ts',
  'hooks/useFileHandlers.ts',
  'hooks/usePresentation.ts',
  'hooks/useSmartToolbar.ts',
];
for (const rel of legacyCallers) {
  assert.doesNotMatch(
    readCode(rel),
    /svgRef\.current(\.current)?(\?\.|\.)getBoundingClientRect\(\)/,
    `${rel} 仍直接用 <svg> 的 rect 换算坐标（统一走 getCanvasScreenRect）`,
  );
}

// 4. 关键换算点必须已切到统一 helper。
assert.match(readCode('App.tsx'), /const rect = getCanvasScreenRect\(element\)/, 'getCanvasPoint 热路径（readCanvasRect）必须走容器盒子');
assert.match(readCode('hooks/useCanvasInteractions.ts'), /const rect = getCanvasScreenRect\(element\)/, '滚轮手势的 rect 缓存必须走容器盒子');

console.log('camera compositing checks: ok (transform on inner <g>, svg root carries no camera transform, rect measured from untransformed container)');
