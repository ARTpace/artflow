// Run from project root: node scripts/check-renderer-ssr.cjs
//
// 渲染入口冒烟：把 App 在 Node 里整树渲染一次，用来兜住"只有运行时才炸"的错误——
// 变量先用后声明（TDZ）、hook 顺序、props 接线、useSyncExternalStore 快照缺失等。
// 同时锁定 P1-B' 的渲染契约：React 不再拥有相机 transform，背景底板不再依赖相机值。
// 这不是浏览器行为测试，不替代实际手势与帧率验证。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 渲染期间会有模块读取 localStorage（useSettings 等），这里给一个最小垫片。
const localStorageBacking = new Map();
globalThis.localStorage = {
  get length() { return localStorageBacking.size; },
  key: index => Array.from(localStorageBacking.keys())[index] ?? null,
  getItem: key => (localStorageBacking.has(String(key)) ? localStorageBacking.get(String(key)) : null),
  setItem: (key, value) => { localStorageBacking.set(String(key), String(value)); },
  removeItem: key => { localStorageBacking.delete(String(key)); },
  clear: () => { localStorageBacking.clear(); },
};

const { createKernel } = require('../plugin-runtime/kernel.ts');
const { setKernel } = require('../plugin-runtime/instance.ts');
setKernel(createKernel());

const App = require('../App.tsx').default;

const html = renderToStaticMarkup(React.createElement(App));
const compact = html.replace(/\s+/g, '');

// 插件界面不在这个空内核里，输出只包含 App 自己的画布壳。结构断言负责确认它没有中途停掉。
assert.ok(html.length > 500, 'App 渲染输出异常偏小，可能整棵子树提前 bail out');

// 1. 相机图层必须存在，并且由 imperative 层独占 transform。
assert.match(compact, /will-change:transform/, '相机图层缺少 will-change:transform');
assert.doesNotMatch(
  compact,
  /translate3d\(/,
  'React 仍在渲染 translate3d：App 必须把相机的 imperative 通道传给 MainCanvas',
);
// 2. 点阵在视口 CSS 层，不在相机 <g> 里画 40 万像素的 pattern 矩形。
assert.match(compact, /data-canvas-backdrop/, '视口点阵层丢失');
assert.doesNotMatch(compact, /width="400000"/, '相机层不得再包含 400000 世界跨度的底板');

console.log('renderer ssr checks: ok (App全树渲染、相机图层 imperative 契约、视口点阵层独立于相机层)');
