/**
 * 守卫：tailwind.config.js 的 content 必须覆盖所有现役源码目录。
 *
 * 背景（2026-10-11，v0.1.5 修）：
 * 插件目录四分类重构把 builtin/ 改名 builtin-plugins/、把 plugins/(loader) 改名
 * plugin-runtime/、并新增 capabilities/，但 content 数组没跟着改 —— 这三个目录里的
 * Tailwind 工具类**全部不生成**，构建产物 CSS 从 78KB 掉到 62KB。
 *
 * 最致命的后果是 panel-host.tsx 的 `pointer-events-auto`：悬浮面板的父容器是
 * `pointer-events-none fixed inset-0`，面板自身靠这个类把点击"接回来"。类一缺失，
 * 面板渲染正常但整块不可点 —— 表现为「主题工作台什么都点击不了」。
 *
 * 注意：其他缺失的类大多在 components/ 等仍被扫描的目录里也出现过，视觉上看不出来，
 * 所以这个 bug 只会以「某处莫名点不动」的形态暴露，极难定位 —— 必须靠守卫拦。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const configPath = path.join(ROOT, 'tailwind.config.js');
const config = fs.readFileSync(configPath, 'utf8');

const arrayMatch = config.match(/content\s*:\s*\[([\s\S]*?)\]/);
assert.ok(arrayMatch, 'tailwind.config.js 必须声明 content 数组');
const content = arrayMatch[1];

/** 每个现役源码目录都必须有对应 glob。新增/改名目录时同步维护这里。 */
const REQUIRED = [
  './components/**/*.{ts,tsx}',
  './hooks/**/*.{ts,tsx}',
  './services/**/*.{ts,tsx}',
  './utils/**/*.{ts,tsx}',
  './workers/**/*.{ts,tsx}',
  './main/**/*.{ts,tsx}',
  './extensions/**/*.{ts,tsx}',
  './builtin-plugins/**/*.{ts,tsx}',
  './capabilities/**/*.{ts,tsx}',
  './plugin-runtime/**/*.{ts,tsx}',
  './plugins/**/*.{ts,tsx,js}',
];
for (const glob of REQUIRED) {
  assert.ok(content.includes(glob), `tailwind content 缺少现役目录：${glob}`);
}

/** 历史目录名不得再出现（只会造成"看着配了其实没扫到"的假安全）。 */
for (const dead of ['./builtin/**', './src/**', './dev/**']) {
  assert.ok(!content.includes(`'${dead}'`), `tailwind content 仍含已废弃路径：${dead}`);
}

/** 每个 glob 指向的顶层目录必须真实存在 —— 防"配了但目录名写错"。 */
const tops = new Set();
for (const glob of REQUIRED) {
  const top = glob.split('/')[1];
  if (top) tops.add(top);
}
for (const top of tops) {
  assert.ok(fs.existsSync(path.join(ROOT, top)), `tailwind content 指向不存在的目录：${top}/`);
}

/** 最要命的那个类：源码必须先有引用，它才有理由被生成。 */
const panelHost = fs.readFileSync(path.join(ROOT, 'plugin-runtime', 'panel-host.tsx'), 'utf8');
assert.match(panelHost, /pointer-events-auto/, 'panel-host.tsx 应保留 pointer-events-auto（浮层穿透父层的关键）');
assert.match(panelHost, /pointer-events-none/, 'panel-host.tsx 的浮层容器应为 pointer-events-none');

console.log(`[check-tailwind-content] OK — content 覆盖 ${REQUIRED.length} 个现役目录，无废弃路径，浮层穿透类引用完整。`);
