# ADR-011：增量 Viewport Index Cache 与保守回退边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-011-Phase3a增量ViewportIndexCache.md`

## 背景

R1 的 `createViewportIndex(elements)` 是正确的 immutable query port，但 React interaction 经常生成“new array + mostly same element object”的数据形态。每次完整 rebuild 对 flat 大画布浪费，而 group bounds 又依赖 children，错误的局部更新会导致画布漏渲染。

## 决策

```text
MainCanvas elements lifecycle
  → mount-scoped ViewportIndexCache.update(elements)
    ├─ flat unique stable id/order: update changed entry cells only
    └─ group / duplicate / structural change: fresh createViewportIndex rebuild
  → existing query(viewport, selected ids, padding)
```

- cache 只信任 immutable element reference：same object 视为 bounds 未变；有 reference change 才重算该 entry；
- cache 保持 current element render order；selected id 仍可强制包含离屏 item；
- group 是依赖 graph，R11 不预测 child→parent invalidation，任何 group presence 直接完整 rebuild；
- add/remove/reorder/duplicate id 同样完整 rebuild，正确性优先于局部优化；
- existing `createViewportIndex` 保留为 immutable baseline、fallback 与 benchmark oracle；cache 不替代未来 SQLite R-tree / Worker port。

## 后果与边界

- flat drag/draw/property update 可避免重建所有 grid cells；相机移动既有 query fast path 不变；
- mutating Element object in place 违反现有 React immutable update convention，会导致 cache 无法观察 bounds 变化；R11 不支持这种模式；
- group-heavy board、structural edits仍是 full rebuild，避免 silently stale viewport；
- 没有新增持久化、权限、plugin hot path 或 Electron capability；持久 R-tree / spatial mutation transaction 必须另立 FDD。


## 实现证据（2026-09-22）

- cache 已落在 `viewport-index.ts`，并由 MainCanvas mount-scoped ref 消费；immutable `createViewportIndex` 保持为 fallback/correctness oracle。
- foundation 验证 flat changed entry 的 query equivalence/reuse，并明确验证 group、add/remove/reorder/duplicate id 的 rebuild policy。
- 10k sparse benchmark 的一次受控运行显示 fresh rebuild 178.57 ms、cache update 104.61 ms，result count 相同；数值已记录为环境相关 benchmark，不作为产品 FPS 承诺。
- 远端 `npm --prefix artflow run check` 已通过；没有新增持久化、IPC、worker、plugin 或 Electron capability。
