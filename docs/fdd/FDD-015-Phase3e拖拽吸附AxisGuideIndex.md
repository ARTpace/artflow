# FDD-015：Phase 3e —— 拖拽吸附 Axis Guide Index

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R15
- **关联**：FDD-011 / ADR-011（R11 renderer-local cache）、FDD-014 / ADR-014（live interaction freshness boundary）

## 1. 背景与目标

`useCanvasInteractions` 的 `dragElements` 每一个 pointer move 都会：

1. 遍历所有 non-moving elements；
2. 为每个元素重新计算 bounds 和 left/center/right、top/middle/bottom guide `Set`；
3. 对每个 moving guide point 扫描全部 static guide values。

R14 已处理 box/lasso 的 region candidate narrowing；drag snapping 仍是明确的 hot path。R11 viewport grid 不能直接替代它：现有 snap 语义是**全画布 global alignment**，而非局部 AABB overlap query。

本轮为一次 drag 建立只属于该 drag 的 renderer-local axis guide snapshot。对 flat、unique-id、immutable list，它把 static guide build 移到 drag start，并以 sorted unique guide values + binary range search 只查询 `SNAP_THRESHOLD / zoom` 邻域。最终 `finalDx/finalDy`、guide 位置/extent、strict threshold 和 tie behavior 保持旧实现。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。当前 drag 每个 pointer move 都对 all `otherElements` 生成并扫描 alignment points；这是 R14 后剩余的直接 interaction hotspot。
2. **已有能力**：复用现有 `getElementBounds`、immutable `elements` convention、`dragStartElementPositions`、`SNAP_THRESHOLD` 和 final movement/guide rendering；不挪用 R11 grid，因为全局 axis alignment 不是 viewport AABB 查询。
3. **标准库**：使用 TypeScript arrays、`Set`、binary search；无新标准库/外部 spatial dependency。
4. **平台特性**：仅 renderer-local `useRef`；不使用 Electron、IPC、Worker 或 Node capability。
5. **依赖**：无新 npm dependency。
6. **一行方案**：不成立。必须保存 legacy Set insertion tie order、moving/static exclusion、zoom-dependent strict threshold、group dependency fallback，以及 React transient-array freshness。
7. **最小实现**：一个 pure drag snapshot/index utility；hook 在 drag start capture、在 expected own transient update 中 O(1) advance，flat path range-query，group/duplicate/invalid/external-ref mismatch 继续调用 legacy scan。

## 3. 范围

### 3.1 必须实现

- 新建 pure `drag-snap-guide-index` utility：
  - 从 non-moving flat elements 依 source order 建立 x/y edge-center guide `Set` equivalent；
  - 每个 distinct value 保存 first insertion rank；排序仅供 binary range query；
  - 对 target 与 threshold 返回 nearest value；same distance 按 legacy first Set insertion rank 选择；strict `< threshold` 保持不变。
- Snapshot 仅在 drag start 的 `elements` 无 group、id unique、bounds finite、moving id non-empty 时创建；否则返回 `null` 并完整保留 legacy scan。
- Snapshot 绑定 expected elements array reference。hook 每次 own transient movement 的 updater 仅当 previous reference 仍 expected 时 advance 到 resulting array；在 render/event observation 到不同 reference 时立即失效并使用 legacy scan。该 O(1) guard 不在 pointermove 新增 full-list validation。
- `useCanvasInteractions` 的 existing moving-point order、guide extent、`finalDx/finalDy` update、`Set` de-dup and movement commit all retain behavior；只有 static guide candidate lookup 换成 snapshot range query when current。
- `handleMouseDown` / `handleMouseUp` clear drag snapshot lifecycle；不能泄漏到下一次 drag。
- foundation 覆盖 source-order ties、duplicate guide values、strict threshold edge、x/y result equivalence、multi-moving exclusion、snapshot own-movement advance、external reference mismatch、group/duplicate/invalid fallback 及 hook wiring。
- 新增 `benchmark:snap`：10k flat synthetic static guides 对 legacy full scan 与 index range query 逐 target 断言 exact matched value，记录 build/query timing 与 candidate diagnostics；不设机器相关硬阈值。

### 3.2 明确不做

- 不把 snap 改成 viewport-local / nearest-object-only 语义；不使用 R11/R12/R13 query 替代 global guide source。
- 不优化 group hierarchy、frame parenting、resize/rotate snapping、point hit-test、box/lasso（R14 已完成）、selection transaction、RAF batching 或 normalized state。
- 不引入 Worker、persistent index/schema、IPC channel、Node capability、dependency 或 MainCanvas cache ownership change。

## 4. 语义契约

```ts
// Legacy semantic baseline: first minimal distance encountered wins.
for (const movingPoint of movingPointsInExistingOrder) {
  const staticValue = axisIndex.findNearest(movingPoint + rawDelta, threshold);
  if (staticValue && distance < globalBest.distance) keepExistingGuideShape();
}
```

- Axis index is only a static candidate oracle. The hook remains the authority for movement delta and guide rendering.
- `findNearest` returns same result as iterating legacy `Set` for a single moving point: minimum distance under strict threshold; equal distance -> lower Set insertion rank.
- Global loop retains the legacy strict `dist < globalBest.dist`, so equal best distances across moving points preserve their existing encounter order.
- Snapshot currentness relies on immutable arrays and hook-owned movement updater. An observed external array reference mismatches and fails closed to legacy full scan; in-place mutation remains unsupported just as R11.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | flat unique fixture 的 vertical/horizontal match、tie、duplicate guide、strict threshold 和 multi-moving global result 与 legacy scan 完全相同。 |
| AC-2 | group, duplicate id, non-finite bounds, empty moving ids 或 observed non-expected array reference 均不用 snapshot，返回 existing legacy full scan path。 |
| AC-3 | hook 仅在 drag start / own movement / mouseup 管理 snapshot；每个 index-backed pointer move 没有重建 static guide set 或 O(n) freshness validation。 |
| AC-4 | 10k benchmark 必须 exact-result equality；只输出 timing / guide diagnostics，不给设备无关性能承诺。 |
| AC-5 | remote foundation、typecheck、production build、full check 和 source read-back 均通过；fixed capability count仍为12。 |

## 6. 实现与验证证据（2026-09-22）

### 6.1 实现

- 新增 `utils/drag-snap-guide-index.ts`。它将 legacy static x/y `Set` 的 first insertion rank 与 numeric-sorted copy 分开保存；`findNearest` 以 lower-bound range search 找最小 strict-distance value，等距时按原 Set rank 选择。
- `createDragSnapGuideSnapshot(elements, movingIds)` 仅接受 non-empty moving ids、flat unique-id、finite-bound input；任一 group、duplicate id 或 non-finite bound 都返回 `null`，因此 hook 保留旧 full scan。
- Snapshot 以 expected immutable elements array reference 管理 freshness。`useCanvasInteractions` 只在 drag start 创建它；own movement updater 从 expected previous array 得到 next array 后才 `advance`，观察到不同 ref 时立即 invalidate + legacy fallback。currentness 检查为 O(1)。
- hook 同时冻结 moving source order 到 gesture ref；snapshot current 的 pointer move 不再 filter complete `elements` 或重建 static Sets。existing movement point order、strict global best comparison、guide extent、final delta 和 commit path 未改。
- 新增 `benchmark:snap`；没有增加 npm dependency、schema、IPC / preload / main channel、Worker 或 Node capability。

### 6.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 | 通过：foundation 覆盖 x/y nearest、source-order tie、duplicate guide、strict threshold、多个 moving element 的 global best；indexed result 与 legacy Set scan 一致。 |
| AC-2 | 通过：foundation 验证 group、duplicate id、Infinity bounds、empty/mismatch lifecycle 不使用 snapshot；own transient array `advance` 后才 current。 |
| AC-3 | 通过：source contract 断言 drag start 创建 snapshot、O(1) `isCurrent(elements)` guard、x/y `findNearest` 与 fallback `otherElements` scan；fast path 使用 captured moving source order。 |
| AC-4 | 通过：远端 `npm --prefix artflow run benchmark:snap` exit 0。10k flat / 1k target / threshold 10 fixture exactResultEqual=true、2000 axis matches；本次观测 build 4.20 ms、legacy static-guide-build+query 266.22 ms、range-query 0.15 ms。仅衡量该静态 guide phase，不含 React state map/render，也不构成通用性能承诺。 |
| AC-5 | 通过：远端 `typecheck`、`check:foundations`、`benchmark:snap`、full `check` 均 exit 0；fixed capability 保持 12。Vite 仅保留既有 >500 kB chunk warning，SQLite 仅保留 ExperimentalWarning。 |

## 7. 风险与回退

- Group bounds may depend on moving descendants; any group disables snapshot and retains current full scan.
- A concurrent external immutable edit may make snapshot stale; reference mismatch falls back immediately rather than omit/reuse invalid static points.
- Dense guides can still produce many values in a threshold range; no asymptotic guarantee is claimed for adversarial distributions.
- Existing state updates must stay immutable; in-place mutation is outside R11/R15 contracts.

## 8. 完成边界

R15 has verified only flat, drag-scoped static alignment-guide candidate lookup. It does not make snapping local, persistent, worker-owned, frame-aware beyond current behavior, or a general interaction spatial service; group snap, resize/rotate snap, hit-test and live mutation remain separate work.


## R16 窄化说明（2026-09-22）

FDD-016 已验证仅在能证明 static group 没有 moving reachable descendant 且 graph 无 cycle 时，窄化本 FDD 的 “any group fallback” 实现边界。R15 的 flat semantics、expected-array protocol、legacy fallback 与 non-goals 均保持；动态 group dependency 仍必须 fallback。
