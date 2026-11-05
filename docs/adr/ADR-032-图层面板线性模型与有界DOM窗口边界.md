# ADR-032：图层面板线性模型与有界 DOM 窗口边界

- 状态：verified
- 日期：2026-09-22
- 轮次：R32 / Phase Perf2
- 关联：`FDD-032-PhasePerf2图层与画板面板虚拟化.md`

## 背景

R31 收敛了画布 pointer、viewport index 与启动 bundle，但 `LayerPanel` 打开时仍存在独立热点：

- 现有递归 `renderOrderedLayers` 在每个节点上重新 `filter(allElements)`，最坏接近 O(n²)；
- React 为所有 layer/frame 同时创建 DOM，即使侧栏只显示几十行；
- 拖动画布元素会更换 `elements` 引用，打开的侧栏会重复执行上述工作。

该问题属于 UI projection，不应通过修改 Project Document、Element history、viewport index 或 plugin/runtime ownership 解决。

## 决策

1. 新增 pure `layerPanelModel`，一次遍历建立 parent → children，再以稳定 source order 投影为线性 `{ element, level }[]`；复杂度 O(n)。
2. duplicate id、cycle、orphan 必须有界处理，不能因异常项目导致无限递归。与旧面板一致，正常树按 reverse source order 显示；orphan/cyclic unreachable record 不伪造 parent 语义。
3. Layer 与 Frame tab 使用固定行高 windowing，只挂载 viewport 行及少量 overscan；spacer 保留完整滚动高度。
4. scroll window 只是 renderer UI local state，不进入 Board、operation、save、undo/redo、storage 或 analytics。
5. drag/drop、rename、select、visibility、lock、frame focus/delete 继续委派既有 callbacks；virtualization 不复制业务动作。

## 不变量

- 元素 z-order、parentId、selection 与 frame semantics 不变；
- 不改变画布 renderer、R11–R17 index、R20 navigator 或 Finder；
- 当前 fixed preload/main capability 仍为 13；无 schema、IPC、Node capability、npm dependency变化。

## 验证结果

10k synthetic hierarchy 保持 id/level/order equality：legacy recursive scan `329.85 ms`，linear flatten `2.98 ms`，本次观测约 `110.74x`。768px viewport 只挂载 39 行（预算 40），相对 10k 全量 DOM 减少 `99.61%`。

`typecheck`、`check:foundations`、production `check` 与 `benchmark:layer-panel` 均 exit 0。

## 非目标

不实现 canvas transient entity store、group incremental bounds、tree collapse persistence、多列列表、搜索、跨层拖动新语义或 generic virtualization framework。
