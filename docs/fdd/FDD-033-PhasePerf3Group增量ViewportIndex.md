# FDD-033：Phase Perf3 Group 增量 Viewport Index

- 状态：verified
- 日期：2026-09-22
- 轮次：R33
- ADR：`ADR-033-Group依赖边界与增量Viewport传播.md`

## 1. 问题

当前 `createViewportIndexCache` 遇到任意 Group 即禁用 mutable mode。Grouped canvas 的每个 pointer frame 都可能重建完整 grid，并由 recursive `getElementBounds` 重复扫描 `Element[]`。

## 2. 实现范围

- 在 `utils/viewport-index.ts` 增加安全 Group bounds dependency snapshot；
- 初次 build 对每个 node/group bounds 最多计算一次；
- stable immutable update 收集 changed ids，并向上收集 Group ancestors；
- child-first 重算受影响 bounds，只 detach/attach impacted grid entries；
- structure/reparent/type/duplicate/cycle 保守 rebuild；
- diagnostics 区分 incremental entry updates 与 rebuild；
- foundation 覆盖 single/nested Group、ancestor cell move、stale/structural fallback 与 fresh-index result equality；
- viewport benchmark 增加 10k grouped sparse fixture。

## 3. 验收条件

- Group child move 后，旧 viewport 不再返回 Group，新 viewport 返回 Group；
- nested Group ancestor bounds 同步传播；
- cached query 与 fresh `createViewportIndex` 结果完全一致；
- stable grouped sparse updates 不增加 buildCount；
- reparent/type/order/duplicate/cycle 不走不安全 incremental path；
- `typecheck`、`check:foundations`、`benchmark:viewport`、full `check` 全部 exit 0。

## 4. 验证结果

2026-09-22 远端：

- `typecheck`、`check:foundations`、full production `check`：exit 0；
- `benchmark:viewport` grouped 10k / 100 sparse：fresh `427.41 ms`，cache `26.08 ms`，`16.39x`；
- exact query result equality；`buildCount: 1`；direct update 100、dependency propagation 100；
- foundation 覆盖 nested ancestor move、old/new viewport equality、reparent rebuild、cyclic graph fail closed。

## 5. 非目标

不改变 `getElementBounds` 的全局业务 authority，不实现 hit-test/snap/group layout/Worker/Hybrid renderer，也不新增 persistence 或 IPC。
