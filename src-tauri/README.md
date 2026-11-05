# Artflow Tauri Preview

独立 Tauri 2 桌面实验入口。只新增此目录；Electron 启动、打包和原数据保持不变。
应用 identifier 为 `com.artflow.tauri.preview`，标题为 `Artflow Tauri Preview`。

## 与前端的接口

通过 `window.__TAURI__.core.invoke`（或 `@tauri-apps/api/core`）调用：

| 命令 | 参数 | 成功返回 |
| --- | --- | --- |
| `tauri_save_bytes` | `{ request: { defaultName: string, title?: string, bytes: number[] } }` | `{ ok: true, path: string }` |
| `tauri_open_artflow` | 无 | `{ ok: true, name: string, bytes: number[] }` |
| `tauri_open_video_link` | `{ url: string }` | `{ ok: true }` |

失败返回 `{ ok: false, message: string }`，用户取消的 message 固定为 `cancelled`。
文件内容使用 JSON 数字数组；调用方需将 `Uint8Array` 转成 `Array.from(bytes)`，读取后重建 `Uint8Array`。
不存在路径读取、通用写盘、Node 侧车或 `artflowStorage`。前端继续使用 IndexedDB，保存与导出可通过上述命令实现。

## 启动与构建约定

- 前端开发地址固定为 `http://localhost:4002`；开发服务器由主项目 npm 脚本负责，不从 Rust 额外启动。
- 发布前端目录为 `../dist`，先构建 Vite，再由项目安装的 Tauri 2 CLI 启动/打包。
- `withGlobalTauri: true`；原生窗口 decorations 为 true；`dragDropEnabled: false` 保留 HTML drop 行为。
- 可在本目录运行 `cargo check --tests` 检查 Rust 和测试编译，`cargo test` 执行纯逻辑测试。发布嵌入前端需要 Tauri CLI 启用 `custom-protocol`。
- Windows 需要 Rust MSVC 工具链、Visual C++ Build Tools、WebView2；缺少时由用户自行安装，代码不会安装系统软件。

## 实际验证

本机 Rust/Cargo 1.99.0；`cargo fmt` 已执行，最终 `cargo test --locked` 编译并通过 3 项测试（URL 协议/凭据、扩展名/默认名、可信来源）。首次 `cargo check --tests` 暴露导航 API 位置错误，修正导航插件及其显式泛型后由最终测试编译覆盖。未启动桌面 UI、未交互验证对话框或 WebView2、未制作安装包；这些不能由纯逻辑测试替代。

## 安全边界与限制

能力 `main-local` 仅向本地 main 窗口/Webview 授予三个自定义命令，不授予通用 core/fs/shell/opener 插件权限；build.rs 显式登记命令以启用应用命令 ACL。没有 remote capability。
每个命令另校验真实窗口标签和当前页面 URL。开发仅允许上述 localhost 地址，发布仅允许 Tauri 内部来源；页面导航也使用此白名单。
保存路径必须由原生 rfd 对话框选择，默认文件名去除目录部分；打开仅接受用户选择的 `.artflow` 文件，并在过滤器之外再次检查扩展名。
外链必须为无用户名/密码的 HTTP(S) URL，由系统默认浏览器打开；不嵌入第三方网页、不解析视频、不执行外部命令字符串。

ponytail: 本预览不迁移 Electron 数据、不桥接 Electron 插件/MCP/任意文件访问。CSP 暂未强制，以兼容现有画布及资源加载；本地前端 XSS 仍处于应用信任边界内，发布前应单独收紧 CSP。文件以整块 Vec<u8> 经 JSON IPC 传输，超大文件会产生额外内存复制，未实现流式读写。文件写入沿用对话框确认后直接写盘，不提供原子替换/自动备份。
