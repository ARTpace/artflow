# Artflow

基于 React、TypeScript、Vite 和 Electron 的无限画布创作工具，包含素材管理、媒体导入、插件扩展和主题系统。当前版本 `0.1.8`，另提供 Tauri 2 实验入口。

## 安装与启动

需要 Node.js 22.5 或更高版本及 npm。

```sh
npm ci
npm run dev
```

浏览器访问 `http://localhost:4002`，端口统一配置在 `dev-server.config.json`。

保持开发服务器运行，在另一个终端启动桌面应用：

```sh
npm run electron:dev
```

Windows 也可运行 `start-electron.cmd`（显示日志）或 `start-electron.vbs`（隐藏控制台），脚本会复用或启动开发服务器。

如需环境变量配置的 Gemini 功能，将 `.env.example` 复制为 `.env.local` 并填入密钥。Vite 会将此配置注入前端构建，请勿公开分发包含个人密钥的构建。

## 检查与打包

```sh
npm run typecheck    # TypeScript 静态检查
npm run build        # 前端构建至 dist/
npm run check        # 完整项目检查
npm run dist:win     # Windows Electron 安装包
```

Electron 打包目录由 `package.json` 配置，当前为 `release-v018b/`。

Tauri 预览需额外安装 Rust MSVC、Visual C++ Build Tools 和 WebView2。先启动前端，再运行 `npm run tauri:dev`；打包运行 `npm run tauri:build`。详见 [Tauri 说明](src-tauri/README.md)。

## 目录说明

| 路径 | 内容 |
| --- | --- |
| `App.tsx`、`components/`、`hooks/` | 画布界面与交互 |
| `main.cjs`、`preload.cjs`、`main/` | Electron 主进程与桥接 |
| `storage/`、`core-modules/`、`utils/` | 数据存储、核心模块与工具 |
| `plugins/`、`builtin-plugins/`、`plugin-runtime/` | 插件与运行时 |
| `types/`、`examples/`、`extensions/` | 插件类型、示例与扩展 |
| `branding/` | 图标与品牌资源 |
| `docs/` | 架构、需求与实施记录 |
| `scripts/` | 启动、回归检查与性能基准 |
| `src-tauri/` | Tauri 桌面实验入口 |

依赖、构建产物、日志、历史打包目录、本机快捷方式和环境密钥不纳入版本控制；保留依赖锁文件以便复现安装。
