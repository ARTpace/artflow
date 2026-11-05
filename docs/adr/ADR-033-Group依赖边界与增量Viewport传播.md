# ADR-033：Group 依赖边界与增量 Viewport 传播

- 状态：verified
- 日期：2026-09-22
- 轮次：R33 / Phase Perf3
- 关联：`FDD-033-PhasePerf3Group增量ViewportIndex.md`

## 背景

R11 的 mutable viewport cache 只支持无 Group 的 flat element list。画布中只要存在一个 Group，任何拖动或属性更新都会退回完整 index rebuild；而 `getElementBounds(group, elements)` 会递归扫描全数组查找 children，多个或嵌套 Group 会放大为接近 O(n²) 的热点。

R31 优化了 flat sparse path，R32 优化了 side panel，但 grouped canvas 仍是未完成的明确性能入口。

## 决策

1. Viewport runtime 建立 mount-scoped、唯一 id、无环的 parent→children 依赖快照；只服务 bounds propagation，不成为持久 scene graph。
2. 初次 build 以 memoized dependency traversal 计算 Group union bounds，避免每个 Group 重复扫描完整数组。
3. immutable sparse update 在 id/type/parentId/source-order 不变时，更新 changed node，并沿 parent chain 只重算受影响 Group；grid detach/attach 只覆盖受影响 entries。
4. add/remove/reorder/type change/reparent、duplicate id 或 cyclic Group graph 必须保守 rebuild/fallback，不能以 stale bounds 缩小候选。
5. query、source order、padding、selected include、exact intersection、R14/R17 identity gate 保持不变。

## 验证结果

10k / 100 sparse grouped fixture 保持 fresh/cached query equality：fresh rebuild `427.41 ms`，dependency-aware cached update `26.08 ms`，本次观测 `16.39x`。100 次 child edit 只记录 100 次 direct update + 100 次 Group propagation，`buildCount` 保持 1。

nested Group foundation 证明 child move 会同步移动两级 ancestor bounds；reparent 与 cyclic graph 保守 rebuild/fail closed。`typecheck`、`check:foundations`、`benchmark:viewport` 与 full `check` 均 exit 0。

## 边界

- 这是 renderer-local viewport bounds cache，不写 Board/Element，不进入 operation、save、SQLite、IPC 或 plugin profile。
- 不接管 hit-test、snap geometry、frame parenting exact predicate、selection exact predicate。
- 不实现 generic scene graph、layout engine、Worker/tile service 或 Hybrid renderer。
- fixed preload/main capability 保持 13；无 schema、dependency、IPC 变化。
