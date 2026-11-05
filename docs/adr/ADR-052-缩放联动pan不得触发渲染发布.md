# ADR-052：缩放联动 pan 不得触发渲染发布；连续缩放的频率由专用时间下限管辖

日期：2026-09-24（等宽网格 ~150 张卡单屏铺满，滚动缩放卡顿；ADR-041~051 之后仍卡）

## 现象与归因（真实应用 trace，RTX 5080 硬件光栅）

- 纯渲染管线探针（`scratch/probe-tier-churn.*`）：150 张同步换档 / dataURL 换源 / imageRendering 全屏翻转，帧分布全部 p50≈7ms、零超 32ms 帧 —— **渲染管线与 DOM 换档不是瓶颈**。
- 真实应用 trace（`scratch/probe-app-zoom-trace.mjs`，走真实导入 + 滚轮手势 + Tracing + cpu profiler）：
  - React workLoop 调用 **311 次 / 12s 手势 ≈ 14 次/秒**（设计值 4 次/秒）；
  - 每次 React 提交 15-22ms（dev），主帧热点 `commitMutationEffects`/`recursivelyTraverseMutationEffects`/`jsxDEV`；
  - 相机 imperative 通道（applyLiveTransform/stepSmooth）全程仅 ~30ms —— 相机本身很顺。
- 结论：**每次缩放发布都引发 MainCanvas + CanvasNavigator（150 marker）全量 React 重渲**，发布频率被放大 3.5 倍。

## 根因

`scheduleRender` 的"位移 ≥120px 立即发布"判据被**缩放联动 pan**绕过：
滚轮围绕视口中心缩放时 pan 随 zoom 联动（zoom=2 时一格 ×1.25 的 Δpan≈280px），
那批内容只是换了比例、没有平移进来，但位移判据把它当成"看了新内容"→ 每格立即发布。

进一步：**比例阈值管不住连续缩放**。平滑追随在 40ms 内完成一格变化量的 ~64%，
任何低于 64% 的阈值都会顶着 40ms 下限顶格发布（缩小阈值 6% → 实测 14-25 次/秒）。
能管住频率的只有时间下限本身。

## 决策

1. **位移判据仅在 zoom 不变（平移）时生效**（`zoomUnchanged` 守卫）。
2. 新增 `RENDER_PUBLISH_ZOOM_MIN_MS = 250`：缩放手势（live.zoom 已偏离基准）的发布下限，
   把 React 提交频率钉在 ~4 次/秒。平移保持 40ms 下限（低延迟语义不变）。
3. 缩小阈值 0.06 → **0.22**（= overscan 富余 26.7% 与"两次发布间可见半径最多扩大 ~25%"的匹配值）。
4. overscan 系数 1.25 → **1.6**（120×1.6=192px ≈ 屏幕半径 720 的 26.7% > 25%），兜住缩小的露白。

## 效果（同一 trace 复测）

- React workLoop：311 → **113 次**（-64%），workLoop 总 JS 928ms → 295ms。
- 剩余单次提交 15-22ms 为 **dev 模式 React 开销**（jsxDEV 校验 ~6-10% 热点、prepareFreshStack）；
  打包版（无 jsxDEV）单次提交应显著下降。93ms 级长帧为手势首帧冷启动，非稳态问题。

## 教训

1. **"每次手势都会变化的量"不得成为发布判据**——缩放联动 pan 与 ADR-042/043 的"手势标记进渲染依赖"是同一类错误的新变体。
2. **探针测不出 React 层的卡顿**：DOM/渲染管线探针全绿 ≠ 应用不卡。必须用真实应用 + 真实事件路径 trace（本批搭建的 `probe-app-zoom-trace.mjs` 走真实导入 → 滚轮注入 → profiler，可复用）。
3. 频率控制不要指望"比例阈值"，连续渐变输入下阈值必然被 40ms 下限顶格；用专用时间下限。
