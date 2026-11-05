# PureRef 功能对齐清单

> 目标：以 PureRef 2.1（2026-02，当前 2.1.3）为基准，逐项补齐 Artflow 作为参考图工具的核心体验。
> 原则：能用插件实现的用插件（commands / node_actions / canvas_widgets / settings_sections），只有窗口层、画布渲染层、工程格式层允许动本体。
> 状态标记：✅ 完成 / 🔧 进行中 / ✅ 未开始。

## 对齐总表

| # | PureRef 能力 | PureRef 行为 | Artflow 现状 | 归属 | 状态 |
|---|---|---|---|---|---|
| 1 | 置顶悬浮 Always on Top | 窗口置顶，可只对特定应用置顶 | 无 | 本体（main IPC）+ window-tools 插件（命令） | ✅ |
| 2 | 窗口透明度 | 画布半透明叠加在 DCC 软件上 | 无 | 本体（main IPC）+ window-tools 插件 | ✅ |
| 3 | 鼠标穿透 Click-through | 参考窗不挡底层软件操作 | 无 | 本体（main IPC）+ window-tools 插件 | ✅ |
| 4 | 画布/选区导出 PNG | 导出所选或全部内容为图片，复制到剪贴板（可设尺寸上限） | 无 | canvas-export 插件 + 本体保存对话框 IPC | ✅ |
| 5 | 背景网格+吸附 | 实线/点状网格，G 键开关，元素吸附网格 | 有拖拽对齐参考线，无网格 | 本体（MainCanvas 渲染 + 拖拽取整） | ✅ |
| 6 | 排列命令 | Distribute / Arrange Randomly / Normalize Area 等 | 仅 6 向对齐 | arrange-tools 插件（commands） | ✅ |
| 7 | 一键去色 / 暗化非选中 | Desaturate、Shade 非选中项 | 无（image 有 opacity 字段） | 本体（视图状态+CSS）+ view-tools 插件（命令） | ✅ |
| 8 | 单文件工程 | .pur 单文件轻量分享 | 文件夹工程（SQLite+资产目录） | 本体（主进程对话框 + fflate zip） | ✅ |
| 9 | Manage Images 批处理 | 批量降分辨率/转格式/嵌入↔链接 | 无 | image-tools 插件（commands + node_actions） | ✅ |
| 10 | Replace image | 替换图像保留位置尺寸 | 无 | image-tools 插件（node_actions） | ✅ |

## 实现方案

### ① 置顶悬浮 + 窗口透明度 + 鼠标穿透（#1 #2 #3）
- main.cjs：新增三个 IPC：`artflow-app:set-always-on-top`（`setAlwaysOnTop(enabled,'screen-saver')`）、`artflow-app:set-opacity`（0.1–1）、`artflow-app:set-ignore-mouse-events`（穿透，`{forward:true}` 保留移动事件）。
- preload.cjs：新增 `window.artflowApp` 桥（只暴露这三个任务化调用，不漏 ipcRenderer）。
- plugins/host-platform.ts：HostPlatformService 扩展 `setAlwaysOnTop / setWindowOpacity / setIgnoreMouseEvents` + `canWindowControls` 能力位（治理规则：插件不摸 window.，一律走服务）。
- builtin/window-tools 插件：commands 组 "Window"：
  - `window.toggle-always-on-top`（Alt+Shift+T）
  - `window.opacity-up / opacity-down`（步进 10%）
  - `window.toggle-click-through`（Alt+Shift+X；注意穿透开启后键盘仍有效，同快捷键关闭）
- 验收：命令面板/快捷键可切换；置顶后叠在 DCC 上可见；透明度实时变化；穿透后鼠标事件透过窗口。

### ② 画布/选区导出 PNG + 复制剪贴板（#4）
- plugins/canvas-export-source.ts：`CANVAS_EXPORT_SOURCE_SERVICE`，App 每帧 ref 同步（沿用 workspace-command-actions 的 ref 模式）：`getExportSnapshot()` 返回活动板元素+背景色+选区 id。
- builtin/canvas-export 插件：
  - 合成器：按 zIndex 绘制 image（含旋转/透明度，href 显示版）、shape、line/arrow、path、text、frame；其余卡类型画占位圆角块+名称。
  - 范围：全部内容包围盒 / 当前选区包围盒，2x 像素密度。
  - `canvas.export-png`（Ctrl+Alt+E）：主进程 `artflow-app:save-bytes` 保存对话框写文件。
  - `canvas.copy-image`（Ctrl+Alt+C）：web Clipboard API `ClipboardItem('image/png')`。
- 验收：导出 PNG 内容与画布所见一致（图片/形状/文字/透明度/旋转）；剪贴板可直接粘贴进微信/PS。

### ③ 背景网格 + 网格吸附（#5）
- App 视图状态：`gridVisible / gridSize / gridSnap`（localStorage 持久化，设置面板"画布"区新 section）。
- MainCanvas：容器底纹层（repeating-linear-gradient 实线网格，pointer-events:none，位于元素之下）。
- 拖拽提交点：useCanvasInteractions 位置落点处，snap 开启时对 x/y 取整到 gridSize（含缩放无关，网格用世界坐标）。
- 验收：网格随缩放平移（世界坐标感）；开启吸附后拖拽元素落点对齐网格；设置可调格距。

### ④ 排列命令插件（#6）
- plugins/canvas-mutation.ts：`CANVAS_MUTATION_SERVICE`，App 提供 `patchElements(patches: {id, patch}[])`（走 updateActiveBoard + 撤销历史）。
- builtin/arrange-tools 插件 commands 组 "Arrange"：
  - `arrange.distribute-h / distribute-v`：选区等间距分布（按包围盒中心）。
  - `arrange.random`：选区（无选区则全部）随机位置（当前视口范围）。
  - `arrange.normalize-area`：选区图片等显示面积（保持宽高比，面积取中位数）。
- 验收：多选后命令生效且可撤销（Ctrl+Z 一步回退）。

### ⑤ 一键去色 / 暗化非选中（#7）
- App 视图状态：`viewDesaturate / viewDimUnselected`。
- MainCanvas：元素容器 CSS `filter: grayscale(1)`；暗化模式给非选中元素 wrapper 加 `filter: brightness(.55) saturate(.8)`（选中项不动）。
- builtin/view-tools 插件 commands：`view.toggle-desaturate`（Alt+Shift+D）、`view.toggle-dim-unselected`（Alt+Shift+H）；设置面板外观区加入口。
- 验收：去色全局生效可逆；暗化只压非选中，选区始终原色。

### ⑥ 单文件工程 .artflow（#8）
- 格式：zip（fflate，已有依赖）= `document.json`（v2 文档）+ `assets/<sha256>`（原始字节，扩展名写在 `assets.json` 索引）。
- 导出：`artflow-app:export-artflow` → loadProject 拿文档 → 渲染层 fetch `artflow-asset://sha256/<hash>` 收字节 → zip → 主进程保存对话框。
- 打开：`artflow-app:open-artflow` → 主进程打开对话框读 buffer → 渲染层解包 → 逐资产 importAsset 入托管库（复用 materialize 管道）→ saveProject。
- 验收：导出的 .artflow 在另一台/另一工程打开后画布一致；资产以内容寻址入库不重复。

### ⑦ 图像批处理 + 替换图像（#9 #10）
- host.platform 扩展 `importAsset(request)` 通道（插件禁摸 window.artflowStorage）。
- builtin/image-tools 插件：
  - node_actions：图片卡"替换图像…"（文件选择 → importAsset → patch 元素 href/originalHref/assetId）。
  - commands 组 "Image Tools"：`image-tools.downscale-selection`（选区批量降分辨率：原图解码→最长边限制重编码→导入→替换 locator，记录到 metadata）。
- 验收：替换后位置尺寸不变仅换图；批处理后视觉尺寸不变、托管库字节数下降。

## 开发顺序与依赖
①（纯增量）→ ②（引入 export-source 服务与 save-bytes 通道，⑥复用）→ ④（引入 mutation 服务，⑦复用）→ ⑤（视图状态）→ ③（网格，动拖拽热路径，单独验证）→ ⑥（格式层）→ ⑦（依赖②的导入通道+④的 mutation）。

## 明确不对齐的
- 多平台打包（mac/linux 构建流水）、云同步、JPEG XL——与当前产品定位无关，需要时再立项。
- PureRef 的快捷键自定义弱项恰是 Artflow 强项（commands+keybinding），不需对齐。
