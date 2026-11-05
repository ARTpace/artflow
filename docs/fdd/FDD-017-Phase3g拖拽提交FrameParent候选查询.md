# FDD-017：Phase 3g —— 拖拽提交 Frame Parent 候选查询

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R17
- **关联**：FDD-011 / ADR-011（R11 renderer-local index）、FDD-014 / ADR-014（identity-safe interaction reader）、FDD-015/016（drag semantics）

## 1. 背景与目标

在 `dragElements` mouseup 的 commit 中，现有代码对每个 moving non-frame element 都扫描 `els.filter(type === 'frame')`，再做 containment / existing comparator sort 决定 `parentId`。这不是 pointermove hot path，但在 frame-heavy boards 和多选 commit 中仍是重复全量 frame scan。

R14 已建立 `InteractionViewportIndexReader`：MainCanvas-owned R11 index 在 exact same `elements` reference 才可给 hook 作 conservative candidate source，否则 full-list fallback。Frame parent selection 是适合该边界的 commit-only consumer：任何 containing frame 的 AABB 必然与 moved element bounds overlap，因此可以先 query bounds candidates，再保留 existing exact containment / frame comparator rule。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。拖拽提交的 frame parenting 按 moving node 重复扫描所有 frames；现有 R11 live index 和 R14 reader 已具备安全 candidate seam。
2. **已有能力**：复用 `queryInteractionCandidates`、MainCanvas snapshot identity guard、`getElementBounds` 和 current exact frame predicate；不创建 FrameIndex。
3. **标准库**：不需新增能力。
4. **平台特性**：renderer-local commit path；不需 Electron / IPC / Worker。
5. **依赖**：无新增依赖。
6. **一行方案**：不成立。需冻结 exact same-array snapshot usage、zero-size / group bounds、padded false positives、nested/comparator/source-order tie behavior 和 stale fallback。
7. **最小实现**：pure `resolveContainingFrame` helper 用 reader candidate query；hook commit 仅替换 candidate source，不改 `parentId` 语义；新增 equality fixtures 与 small benchmark。

## 3. 范围

### 3.1 必须实现

- 新建 pure frame-parenting utility：输入 `element`、current `elements` 和 optional R14 snapshot，先用 `queryInteractionCandidates(snapshot, elements, elementBounds)`，再 exact filter containing frames。
- exact frame predicate、inclusive edge semantics、existing comparator `(a.width * a.height) - (b.width * a.height)` 和 source-order ties 必须与 legacy code 完全一致。
- snapshot missing/stale (`snapshot.elements !== elements`) 时 query helper 返回 whole current list，因此结果与 original `els.filter(frame)` 一致；R11 padding false positives 必须被 exact containment filter 排除。
- `useCanvasInteractions` 的 drag commit 改为按 moving non-frame element 调 helper；moving frame itself 保持原有 skip；没有 snapshot 时不改变 commit behavior。
- foundation 覆盖 nested/comparator/tie/edge/no-container/group bounds/padding/stale/missing reader equality；new `benchmark:frame-parenting` tests 10k synthetic query results equality and candidate counts without hard threshold.

### 3.2 明确不做

- 不改变 frame parenting policy、frame draw/resize behavior、group hierarchy, drag snap, R15/16 snapshots, selection/hit-test, persistent R-tree / IPC consumer / Worker / schema / dependency。
- 不把 saved R12/R13 viewport query 带入 live commit path。

## 4. 语义契约

```ts
const candidates = queryInteractionCandidates(snapshot, elements, movedBounds);
const frame = candidates
  .filter(isFrameAndExactlyContainsMovedBounds)
  .sort(existingLegacyFrameComparator)[0] ?? null;
```

- Candidate query is a conservative optimization only. `parentId` still comes from existing exact containment logic.
- A containing frame must overlap the moved bounds; R11 query cannot omit it when snapshot is current. Oversized frames stay candidates in R11.
- Padded / unrelated frames may be candidates but cannot become parent without exact containment.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Current snapshot produces exactly the legacy parent frame for nested frames, source-order comparator tie, edge containment, no frame and group-bounded element fixtures. |
| AC-2 | stale/null snapshot and padding false positives produce exactly legacy result; no stale index may influence parentId. |
| AC-3 | hook only changes candidate source at drag commit; moving frames, existing frame comparator, parentId mutation and transaction behavior remain unchanged. |
| AC-4 | 10k synthetic frame-parenting benchmark asserts exact result equality and reports candidate count/timing without a machine-independent threshold. |
| AC-5 | remote foundation, typecheck, production full check and source read-back pass; fixed capability count remains 12. |

## 6. 风险与回退

- Snapshot may not have published by mouseup or may be stale after a transient update; identity gate intentionally full-scans current `els`.
- A frame could be oversized/padded candidate; exact containment remains the authority.
- Multiple moving elements can each query separately; this scope does not introduce batch frame-parenting planning.

## 7. 实现与验证证据（2026-09-22）

### 6.1 实现

- 新增 `utils/frame-parenting.ts`。`resolveContainingFrame(element, elements, snapshot)` 先以 `getElementBounds` 取得既有 bounds 定义，再调用 R14 `queryInteractionCandidates`；只有 snapshot 与当前 `elements` 为同一引用时才读 R11 index，否则 helper 返回 current full list。
- helper 只把 candidate 缩到 frame，再保留 inclusive containment 判断与原 hook 的 comparator **逐字语义**：`(a.width * a.height) - (b.width * a.height)`。该 comparator 不是本轮可纠正的“真实面积”规则，故没有将其归一化；稳定 source order tie 也保留。
- `useCanvasInteractions.ts` 只在 `dragElements` mouseup 的既有 `commitAction` updater 中用 helper 替换 frame candidate source。moving frame skip、`parentId` mutation、transaction timing 均未迁到 pointermove。
- `check-core-foundations.cjs` 新增 nested/comparator tie/edge/zero-size/no-container/group bounds/padding false-positive/stale/null fixtures，并静态断言 helper 使用 R14 query、保留 legacy comparator 和 hook 仅在 commit 调用 helper。新增 `benchmark:frame-parenting`；无 schema、IPC、preload capability、dependency 或第二 index。

### 6.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 / AC-2 / AC-3 | 通过：remote `npm --prefix artflow run check:foundations` exit 0；fixtures 对 current、stale、null reader 与 padded false positive 比较 legacy result，涵盖 group bounds、edge 和 comparator/source-order tie。 |
| AC-4 | 通过：remote `npm --prefix artflow run benchmark:frame-parenting` exit 0；10,000 nodes / 1,000 queries，`exactResultEqual: true`、`averageFrameCandidates: 1`、本次运行 `legacyResolveMs: 140.04`、`indexedResolveMs: 3.86`。`observedCommitCandidatePhaseRatio: 36.26` 仅为该 synthetic candidate phase 的当次观察，不代表端到端 drag latency 或 FPS。 |
| R11/R15/R16 regressions | 通过：remote `benchmark:viewport` exit 0（box exact result equal）；`benchmark:snap` exit 0（10k/1k `exactResultEqual: true`、`matchedAxes: 2000`）。 |
| AC-5 | 通过：remote `typecheck` 与 full `check` 均 exit 0；full check 含 Vite production build 和 foundation。仅保留既有 Vite >500 kB chunk warning 与 Node SQLite ExperimentalWarning。fixed capability count 仍为 12。final remote exact read-back matched local text/SHA for 11/11 R17 source and governance files。 |

## 8. 完成边界

R17 only narrows live drag-commit frame-parent candidates using R11/R14’s existing reader. It is not a new hierarchy index, an R12/R13 UI consumer, a frame semantic rewrite, or a replacement for group/hit-test/live mutation architecture. Future work must not silently “fix” the legacy comparator, move parent mutation into pointermove, cache candidates across moves, or treat this benchmark as a general interaction-performance promise.
