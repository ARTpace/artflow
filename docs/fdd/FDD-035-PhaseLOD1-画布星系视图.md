# FDD-035：Phase LOD1 画布星系视图（已废弃）

- 状态：**deprecated（2026-09-27 移除）**
- 日期：2026-09-22
- 轮次：R35 (REQ-002)
- ADR：`ADR-035-画布远缩星系视图LOD边界.md`

## 废弃说明（2026-09-27）

主人实测"切换瞬间会卡顿，还不如去掉"，决定整体移除。本文件保留为历史实现规格，**其中描述的模块与接线均已不存在**：

- `utils/galaxyView.ts`、`components/GalaxyStarLayer.tsx` 已删除
- `MainCanvas.tsx` / `App.tsx` 的对应接线已清理（含 `onFocusElement` / `handleFocusElement`）
- 代码副本见 `.galaxy-backups/2026-09-27-galaxy-removal/`

⚠️ 注意第 1 节"问题"描述的现象 —— **极远缩放时全量渲染卡片 DOM 与 foreignObject 造成重绘卡顿 —— 随本次移除重新成立**。目前由 REQ-003 的多级图片 LOD 代理（按屏幕像素选档）与视口裁剪缓解，但已没有 LOD0 级别的轻量降级层。

## 1. 问题

在极远缩放时，Artflow 原先依然全量渲染所有卡片的 DOM 与 foreignObject，造成明显的重绘卡顿与渲染浪费（《需求文档.md》REQ-002）。

## 2. 实现范围

1. **纯算法与 Descriptor 层（`utils/galaxyView.ts`）**：
   - `GALAXY_ZOOM_THRESHOLD = 0.08`；
   - `isGalaxyMode(zoom: number): boolean`；
   - `getGalaxyStarColor(type, theme)`；
   - `getGalaxyStarRadius(bounds, zoom)` 兼顾元素真实尺寸与屏幕像素可见性；
   - `buildConstellationLinks` 自动构建 Frame/Group 成员之间的星座虚线网；
   - `calculateFlyToTarget` 计算定位飞入参数。

2. **星系渲染层（`components/GalaxyStarLayer.tsx`）**：
   - 渲染星座虚线连线；
   - 渲染星点多重光辉（选中的双环高亮、外圈氛围光、高透明核心球与纯白星光爆点）；
   - 缩放适度时渲染低对比度阴影名称标签；
   - 双击星点触发 `onFocusElement`。

3. **内核管线集成（`components/MainCanvas.tsx` + `App.tsx`）**：
   - `MainCanvas` 依据 `zoom < 0.08` 自动切换，卸载 `CanvasElement` foreignObject；
   - `App.tsx` 响应星点双击，调用既有 `zoomToBounds` 执行丝滑飞入过渡；
   - 框选、套索与平移滚轮在两种视图间平滑衔接。

4. **单测防护（`scripts/check-core-foundations.cjs`）**：
   - `runGalaxyViewChecks` 覆盖纯计算、星座连线、视口居中与源码静态断言。

## 3. 验收条件达成情况

- [x] 远缩至 0.08 以下时卡片全部降级为星点，foreignObject 完全卸载；
- [x] 阈值往返平滑自然，无状态闪烁或数据丢失；
- [x] 双击星星平滑飞入定位到卡片（fly-to）；
- [x] 同组/画板聚成清晰优美的星座连线；
- [x] 类型颜色映射清晰直观（图青、文金、码绿、音红等）；
- [x] Preload 与主进程 IPC capability 保持为 13。

## 4. 验证命令与结果

- `npm --prefix artflow run typecheck`：exit 0
- `npm --prefix artflow run build`：exit 0
- `npm --prefix artflow run check:foundations`：exit 0 (`foundation checks: ok`)
- `npm --prefix artflow run check`：exit 0
