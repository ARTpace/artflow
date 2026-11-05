
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// 端口唯一来源：根目录 dev-server.config.json（main.cjs 与 launch-desktop.cjs 读的是同一份）。
// 以前这里写死 4001、启动脚本写死 4002 —— 直接 `npm run dev` 就会落到另一个 origin，
// 渲染层读不到 :4002 下的插件偏好，表现为"插件关了又被打开"。
import devServerConfig from './dev-server.config.json';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // Electron loads dist/index.html via file://; absolute /assets URLs leave the app blank.
      base: './',
      server: {
        port: devServerConfig.port,
        // 端口被占用时直接失败退出，而不是静默换到下一个端口 —— 换端口等于换 localStorage
        // origin，插件开关会看起来被重置，这种"静默漂移"必须变成显式报错。
        strictPort: true,
        host: '0.0.0.0',
        // 启动预热：dev server 起来后先把入口依赖图预转换好，避免"首屏 240+ 个模块请求"
        // 全压在那一次加载上。热态（服务已跑过一轮）与不预热无差别，收益只在
        // "服务刚启动 → 马上加载"这一段。
        warmup: { clientFiles: ['./index.tsx'] },
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: [
          // production 换 React profiling 构建：保留 <Profiler> 实测计时（actualDuration），
          // 供 builtin/perf-monitor 控件级渲染排行使用。dev 模式自带计时，无需替换。
          // 注意必须精确匹配 react-dom/client（裸 'react-dom' 前缀匹配会误伤 react-dom/client）。
          ...(mode === 'production'
            ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }]
            : []),
          { find: '@', replacement: path.resolve('.') },
        ]
      }
    };
});
