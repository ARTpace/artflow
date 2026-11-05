# FDD-032：Phase Perf2 图层与画板面板虚拟化

- 状态：verified
- 日期：2026-09-22
- 轮次：R32
- ADR：`ADR-032-图层面板线性模型与有界DOM窗口边界.md`

## 1. 问题

打开图层侧栏后，现有递归渲染会为每个节点再次扫描完整 `Element[]`，并同时挂载全部 layer/frame DOM。海量资产项目因此出现明显卡顿，且会放大 R31 已收敛的每帧更新成本。

## 2. 实现范围

- `utils/layerPanelModel.ts`
  - O(n) parent bucket；
  - stable reverse-source flatten；
  - duplicate/cycle/orphan guard；
  - pure bounded virtual range math。
- `components/LayerPanel.tsx`
  - Layer tab 固定行高 virtual window；
  - Frame tab 固定行高 virtual window；
  - ResizeObserver 测量 viewport；
  - 仅渲染可视区 + overscan；
  - 保留既有 action callbacks 与 drag/drop。
- `scripts/benchmark-layer-panel.cjs`
  - 10k synthetic hierarchy 对比 legacy recursive scan 与 linear flatten；
  - 验证 id/level/order equality；
  - 证明 DOM window 行数有固定上界。

## 3. 验收条件

- 10k normal hierarchy 的 flattened order/level 与 legacy 结果一致；
- malformed cycle/duplicate 不递归失控；
- 无论总节点数多少，默认可挂载行数由 viewport + overscan 决定；
- select/rename/visibility/lock/reorder/frame actions 保持既有 callback；
- `typecheck`、`check:foundations`、production `check`、新 benchmark 全部 exit 0；
- 无 schema、IPC、dependency 或 capability 变化。

## 4. 验证结果

2026-09-22 远端：

- `npm --prefix artflow run typecheck`：exit 0；
- `npm --prefix artflow run check:foundations`：exit 0；
- `npm --prefix artflow run benchmark:layer-panel`：10k exact equality，`329.85 ms → 2.98 ms`，本次观测 `110.74x`；
- 768px viewport mounted 39 / budget 40，DOM projection 减少 `99.61%`；
- production full `check`：exit 0。

## 5. 非目标

不更改 Element 数据结构、parenting、z-order、画布 renderer、operation journal 或持久化；不实现 tree collapse/search，也不宣称完成 Hybrid renderer 或 normalized entity store。
