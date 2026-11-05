# ADR-035：画布远缩星系视图 LOD 边界（已废弃）

- 状态：**deprecated（2026-09-27 移除）**
- 日期：2026-09-22
- 轮次：R35 / Phase LOD1 (REQ-002)
- 关联：`FDD-035-PhaseLOD1-画布星系视图.md`

## 废弃说明（2026-09-27）

主人实测"星系视图切换瞬间会卡顿，还不如去掉"，决定整体移除。以下全文作为**历史决策记录**保留，不再代表当前实现：

- 已删除文件：`utils/galaxyView.ts`、`components/GalaxyStarLayer.tsx`
- 已删除接线：`MainCanvas.tsx` 的星系渲染分支与 `onFocusElement` 契约、`App.tsx` 的 `handleFocusElement`、`check-core-foundations.cjs` 的 `runGalaxyViewChecks`、`check-bulk-image-safety.cjs` 的星系预热断言
- 代码副本：`.galaxy-backups/2026-09-27-galaxy-removal/`（注意这两个文件在 git 中为**未跟踪**状态，删除前已另行备份）
- **未解决的后果**：下方决策 1 中"机制归内核"的 LOD0 落地实例取消；《无限画布与海量资产架构优化方案》§9.2 的极远轻量表示、以及十万元素级画布的远缩视图，目前**没有替代实现**，仅靠 REQ-003 的多级图片代理缓解

## 背景

在无限画布场景中，用户将视角大幅缩远进行宏观鸟瞰时，若依然挂载成百上千个包含完整 HTML、富文本、3D 渲染器、音频控制器的卡片 DOM（foreignObject），会导致极其严重的布局重排开销与显存/内存浪费，出现“远缩糊且卡”的可用性瓶颈。

《需求文档.md》REQ-002 提出了“画布星系视图（远缩 LOD：卡片变星星）”，要求在极远缩放比下将重型卡片卸载，并降级为轻量、优美的星空与星座图形，同时兼顾性能跃升与星系美学。

## 决策

1. **分权边界：机制归内核，美学归 Descriptor**：
   - 遵从《无限画布与海量资产架构优化方案》§6.2 / §6.4，LOD 切换机制归属于内核渲染管线（`MainCanvas.tsx`），避免第三方插件篡改渲染循环。
   - 星系美学参数（星点类型颜色、光晕规格、星座连线样式）抽象为纯数据形态的 `GalaxyStarTheme` 契约（`utils/galaxyView.ts`），内核提供默认星系主题（`DEFAULT_GALAXY_THEME`），后续可被皮肤插件覆盖。

2. **LOD0 阈值与 DOM 卸载**：
   - 设定缩放阈值 `GALAXY_ZOOM_THRESHOLD = 0.08`。
   - 当 `zoom < 0.08` 时激活星系模式（`inGalaxyMode = true`）：
     - 彻底卸载所有 `CanvasElement` 及其包含的 foreignObject；
     - 挂载轻量级纯矢量星点图层 `GalaxyStarLayer`；
     - 每个元素以中心点和动态面积计算星点半径，并映射专属类型光色（图片-青、文本-金、代码-绿、音频-红等）；
     - 同属一个 Frame 或 Group 的子元素自动生成星座连线（Constellation Links）；
     - 隐藏不必要的悬浮工具栏与调节手柄，但保留外层选中光环、框选盒与套索遮罩。

3. **连续交互与 Fly-To 聚焦**：
   - 星系模式下画布平移、滚轮缩放与框选连续生效，不发生状态跳跃或阻断；
   - 支持双击星点触发平滑动画飞入（`zoomToBounds(element, { animated: true })`），自动将视角聚焦放大至该卡片；
   - 滚轮放大超过 0.08 阈值时平滑恢复为完整卡片渲染。

4. **安全与能力隔离**：
   - fixed preload/main capability 保持严格为 **13**，不触及后端存储与 IPC。

## 验证结果

- `typecheck`、`build`、`check:foundations` 全部通过（exit 0）。
- `runGalaxyViewChecks` 验证了：
  - 缩放阈值谓词 `isGalaxyMode`；
  - 类型到颜色的确定性映射；
  - 星点半径动态缩放与上下界钳制（14~72px）；
  - 树形父子关系的星座连线生成算法；
  - Fly-to 目标坐标居中计算；
  - `MainCanvas.tsx` 与 `App.tsx` 的关键源码接线。
