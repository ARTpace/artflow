# FDD-014：Phase 3d 交互候选查询复用（框选 / 套索）

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R14
- **关联**：FDD-011 / ADR-011（renderer-local incremental cache），FDD-012 / FDD-013（saved snapshot query，不作为 live UI source）

## 1. 背景与目标

R11 已让 `MainCanvas` 相机 culling 使用 mount-scoped incremental `ViewportIndexCache`，但 `useCanvasInteractions` 在框选结束和套索结束仍对完整 `elements` 做 AABB/center 扫描。它们不在每帧运行，却在大画布选择操作中仍会触发 O(n) final candidate work。

本轮将 **已有 R11 index 的只读 query port** 安全发布给 interaction hook，用它缩小 box selection 和 lasso 的候选集；最终 AABB / polygon / selectable-parent 判断保持原有代码，故不改变 selection semantics。R12/R13 saved snapshot IPC 不参与 live interaction，避免未保存 state stale。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。架构已明确 selection/lasso 应先查候选；当前 hook 的 final full scan 是可测且独立的热路径缺口。
2. **已有能力**：复用 R11 `ViewportIndexCache` / `ViewportIndex.query`，不创建第二空间算法或 persistent query consumer。
3. **标准库**：不需要新标准库能力。
4. **原生平台**：不需要 Electron/Worker/IPC；这是 renderer local interaction。
5. **依赖**：无新依赖。
6. **一行方案**：不成立。必须处理 MainCanvas→App→hook 的 mount-scoped ownership、elements reference freshness、lasso AABB 和 conservative fallback。
7. **最小实现**：一个 typed shared snapshot ref + pure candidate/lasso-bounds utility；仅替换 box/lasso final candidate source，不改变 snap/frame parenting/point hit-test。

## 3. 范围

### 3.1 必须实现

- `MainCanvas` 保持 R11 自己拥有的 mount-scoped cache；每次 update 后把 `{ elements, index }` 的 read-only interaction snapshot 写入可选 ref。
- `App` 只创建/传递 ref，不创建第二 viewport index，也不把 cache 放进 React state。
- `useCanvasInteractions` 在 select-box mouseup 时用 shared index query 获取 candidate，再执行现有 exact rectangle intersection + `getSelectableElement`。
- lasso mouseup 先以 polygon AABB query candidates，再执行现有 element bounds center + `isPointInPolygon` + selectable-parent logic。
- utility 必须在 snapshot 的 `elements` reference 与 hook 当前 `elements` 相同才使用 index；未初始化/过期时保守返回 full elements，不能使用 stale index。
- `ViewportIndex.query` padding 的 extra candidates 必须由最终 exact geometry 过滤；不得把 padding candidate 当作 selected result。
- groups/structural input 继续由 R11 existing immutable fallback 处理；不实现 group-local invalidation。
- foundation 覆盖 flat/group box/lasso candidate result 与 full-scan exact result equivalence、stale-ref fallback、MainCanvas/App/hook port wiring；viewport benchmark 扩展 box-candidate vs naive comparison，输出 result equality/candidate count，不设环境相关阈值。

### 3.2 明确不做

- 不改 drag snapping（其现有全局 alignment 语义不等价局部 AABB query）、frame parenting、single-point hit-test、rotation precision、selection transaction、R12/R13 IPC UI consumer。
- 不新建 cache、persistent schema、Worker、Electron channel、Node capability 或 npm dependency。
- 不把 candidate query 宣称为完整 selection/snap spatial service。

## 4. 语义契约

```ts
const candidates = queryInteractionCandidates(snapshotRef.current, elements, region);
// Candidate list may contain padded false positives.
const selected = candidates.filter(existingExactGeometryPredicate);
```

- Box 的 exact predicate 仍是 strict overlap（仅边界接触不选择），保持原行为。
- Lasso 的 region 是 path AABB；如果 polygon invalid/empty 或 shared snapshot stale，回退 full list，最终 polygon predicate 仍为唯一选择决定。
- Query 返回 source order，最终 `Set` de-duplicate 与 parent selectable resolution 保持原行为。

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | MainCanvas 保持 mount-scoped R11 cache，并安全发布 same-elements snapshot；App/hook 不创建第二 index。 |
| AC-2 | flat/group fixture 的 box/lasso final selected IDs 与 legacy full scan 完全一致；padding false positives 不进入结果。 |
| AC-3 | stale/missing snapshot 只回退 current elements，不能读 stale index；group/add/remove/reorder correctness 仍由 R11 conservative fallback。 |
| AC-4 | benchmark 对 10k fixture 输出 naive/indexed exact-result equality、candidate count 和 timing；无硬性能阈值。 |
| AC-5 | foundation、typecheck、production build、full remote check、source read-back 全部通过。 |

## 6. 实现与验证证据（2026-09-22）

### 6.1 实现

- 新增 `utils/interaction-spatial-query.ts`：`InteractionViewportIndexSnapshot` 将 index 与其 immutable `elements` reference 绑定；hook 只接收 `InteractionViewportIndexReader`，没有发布或清除 MainCanvas-owned ref 的权限。
- `components/MainCanvas.tsx` 仍在 mount-scoped `createViewportIndexCache()` 上调用 `update(elements)`；通过 `useLayoutEffect` 在该 index 已与当前 elements 对齐后发布 snapshot，并在同一 snapshot 的 unmount/update cleanup 中清空。cache ownership 没有迁出 MainCanvas。
- `App.tsx` 创建 non-reactive ref 并同时传给 producer / consumer；没有 state、memo 或第二 index。
- `hooks/useCanvasInteractions.ts` 的 select-box 用 `queryInteractionCandidates` 取候选后保留原 strict AABB 与 `getSelectableElement`；lasso 先算 finite polygon AABB，再保留原 center / `isPointInPolygon` / parent resolution。snapshot 缺失、array reference 不同或 lasso bounds 无效时返回 current full list。
- `scripts/check-core-foundations.cjs` 覆盖 group child、padding false positive、box/lasso full-scan equality、stale/missing snapshot fallback、invalid lasso bounds 与 producer/consumer wiring。`scripts/benchmark-viewport-index.cjs` 新增 candidate + exact box result equality 检查。

### 6.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 | 通过：source contract 断言 MainCanvas 保持 `createViewportIndexCache` / `update(elements)`，并以 layout effect 发布 `{ elements, index }`；App 只转运 ref。 |
| AC-2 | 通过：foundation group fixture 验证 box/lasso indexed final IDs 与 legacy full scan 一致，且 deliberately padded false positive 不进入结果。 |
| AC-3 | 通过：foundation 断言 stale snapshot 和 null snapshot 返回 current elements reference；R11 group cache 的 `initial` conservative rebuild 路径仍被覆盖。 |
| AC-4 | 通过：远端 `npm --prefix artflow run benchmark:viewport` exit 0；10k/100 synthetic fixture 中 box exact result equal，16 selected、36 candidates，记录 timing 仅作当前运行观测，不构成通用性能承诺。 |
| AC-5 | 通过：远端 `typecheck`、`check:foundations`、`benchmark:viewport`、full `check` 均 exit 0；production build 只有既有 >500 kB chunk warning，SQLite 只有现有 ExperimentalWarning。 |

## 7. 风险与回退

- React render order 或 conditional mount 可能使 ref 短暂过期；reference identity gate 令其回退 full list，优先正确性。
- padding / uniform grid 可产生多余 candidates；最终已有 exact checks 保证选择结果不扩张。
- group bounds 依赖 graph；R11 fallback 仍全量 immutable build，不将 R14 误扩展为 group incremental cache。

## 8. 完成边界

R14 已验证只为 box/lasso final candidate narrowing 复用 R11 index。它不是 persistent query consumer、snap optimization、pointer hit-test acceleration、live Worker/tile system 或 Hybrid renderer；不会改变 selection exact geometry、selectable-parent、frame parenting 或 R11 group/structural fallback。


## R17 窄化说明（2026-09-22）

FDD-017 已验证将同一 identity-safe reader 用于 drag-commit frame parent **candidate source**。它不改变 R14 box/lasso exact geometry contract，也不允许 R12/R13 saved query 成为 live interaction state；R17 current/stale/null fallback remains governed by this same reference gate.
