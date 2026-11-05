/** @type {import('tailwindcss').Config} */
// 替代 cdn.tailwindcss.com Play CDN（2026-09-24，CDN 连接被断导致界面样式全崩）。
// 保持与 Play CDN 相同的默认行为（preflight/dark:media），无自定义 theme。
module.exports = {
  content: [
    './index.html',
    './*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    './workers/**/*.{ts,tsx}',
    './main/**/*.{ts,tsx}',
    './extensions/**/*.{ts,tsx}',
    // —— 2026-10-11 插件目录四分类重构后的现役路径 ——
    // 历史名 ./builtin/** 已改名 ./builtin-plugins/**；原 ./plugins/(loader) 已改名 ./plugin-runtime/**。
    // 漏掉这三条会让 builtin-plugins/ 与 plugin-runtime/ 里的工具类（如 pointer-events-auto）
    // 根本不生成 —— 悬浮面板会因父层 pointer-events-none 而整块点不动。
    './builtin-plugins/**/*.{ts,tsx}',
    './capabilities/**/*.{ts,tsx}',
    './plugin-runtime/**/*.{ts,tsx}',
    // 第三方 editable 插件是纯 JS（plugin.js），其 UI 类名同样需要被扫描。
    './plugins/**/*.{ts,tsx,js}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
