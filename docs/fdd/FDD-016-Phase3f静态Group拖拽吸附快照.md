# FDD-016：Phase 3f —— 静态 Group 拖拽吸附快照

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R16
- **关联**：FDD-015 / ADR-015（drag-scoped axis guide index），FDD-011 / ADR-011（group dependency conservative boundary）

## 1. 背景与目标

R15 只为完全 flat list 启用 drag-scoped static axis guide snapshot；任意 `group` 都回退 legacy scan，因为 group bounds 由 descendants 决定。这个 blanket fallback 正确但过于保守：在一次 drag 中，**static group** 若其所有 reachable descendants 都不在 moving set，则其 bounds 不会因 hook-owned movement updater 改变。其 group guide 和 child guide 可在 drag start 安全冻结，避免每个 pointer move 重新递归计算。

本轮把 R15 的 “any group → fallback” 窄化为 dependency-safe rule：仅当一个 non-moving group 的任一直接或递归 descendant 正在移动，或 group graph 无法安全分析时，才回退 legacy scan。它不是 general group incremental index，也不缓存跨 gesture 的 bounds。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。R15 已减少 flat drag 的重复 static guide build，但实际分组画布仍落回最昂贵的 legacy path；现有 `getElementBounds(group, elements)` 会递归/filter descendants。
2. **已有能力**：复用 R15 drag lifetime snapshot、expected-array guard、legacy fallback、`getElementBounds` 与 existing ids-to-drag descendant closure；不另建 general hierarchy service。
3. **标准库**：使用 `Map` / `Set` / explicit DFS；无新依赖。
4. **平台特性**：renderer-local pure utility；不使用 Electron / IPC / Worker / Node。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。必须区分 static group 与其 moving descendants、nested group dependency、duplicate/cycle graph、source-order guide semantics 和 external array freshness。
7. **最小实现**：在 R15 snapshot builder 中一次性建立 direct-children map；允许 groups 仅在每个 static group 无 moving reachable descendant 且 hierarchy acyclic 时进入 one-drag frozen guide set，其余继续返回 `null` 走 legacy path。

## 3. 范围

### 3.1 必须实现

- `createDragSnapGuideSnapshot` 新增 group safety analysis：
  - ids must stay unique, bounds finite;
  - build a direct-children graph once at drag start;
  - for every static group, recursively inspect descendants; if any moving id is reachable, return `null`;
  - cycle / malformed reachable group traversal returns `null` before using snapshot;
  - static nested groups with only static descendants are accepted.
- Accepted group snapshot still obtains each static element’s guide points through existing `getElementBounds`, preserving source order, duplicate Set semantics, rank tie resolution and global x/y alignment.
- R15 expected-array advance / mismatch invalidation stays unchanged. It is valid because hook’s own movement updater changes only moving entries; verified static group dependency excludes those entries.
- Foundation covers static group + static child exact guide equivalence, nested static group, static group with moving child fallback, cycle fallback, accepted snapshot own advance, and preserves all R15 flat regressions.
- `benchmark:snap` remains the flat 10k exactness/performance observation; no group timing target is claimed until representative hierarchy fixtures exist.

### 3.2 明确不做

- No group incremental mutation, cross-drag group bounds cache, parent/child map shared service, frame layout semantics change, resize/rotate snap, hit-test, R11/MainCanvas cache change, R12/R13 consumption, Worker / IPC / schema / dependency.
- No attempt to repair invalid/cyclic project hierarchy; it only refuses optimization and lets existing legacy behavior remain the fallback authority.

## 4. 语义契约

```ts
staticGroupSafe(group) =
  group.id not in movingIds
  && every reachable descendant.id not in movingIds
  && traversal has no cycle

if (!everyStaticGroupIsSafe) return null; // exact legacy scan remains authoritative
```

- A static group’s frozen bounds are safe only over the active gesture while current `elements` equals the snapshot’s expected reference.
- Moving group bounds are not indexed as static guides. A static group with even one moving descendant is never frozen.
- Once accepted, guide generation is still legacy `elements` source order and `getElementBounds` semantics at drag start; only repeat work is removed.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | static group / nested static group fixture produces x/y guide values and global nearest result exactly equal to legacy scan. |
| AC-2 | static group with direct/nested moving descendant, duplicate id, nonfinite bound and cyclic reachable group graph return null snapshot; hook continues legacy scan. |
| AC-3 | own moving-array advance remains current for accepted group snapshot; observed external array reference mismatch still invalidates in O(1). |
| AC-4 | all R15 tie/threshold/multi-moving flat checks and `benchmark:snap` exact-result equality remain green; no new machine-independent group timing claim. |
| AC-5 | remote foundation, typecheck, full production check and exact source read-back pass; capability count stays 12. |

## 6. 实现与验证证据（2026-09-22）

### 6.1 实现

- `drag-snap-guide-index.ts` 在 capture-time 建立 `parentId → children` map，并先验证 group-to-group traversal 无 cycle。
- 对每一个 non-moving group，`staticGroupHasMovingDescendant` 遍历与现有 `getElementBounds` 相同的 group-reachable closure；发现 direct 或 nested moving descendant 就返回 `null`，让 hook 保留 legacy scan。
- 当所有 static group 被证明 stable 时，沿用 R15 的 existing `getElementBounds` 逐 source-order element 生成 guide Set、rank-preserving range query、expected-array advance 和 O(1) mismatch invalidation；没有改变 hook ownership 或 final snapping semantics。
- 这会让 independent static sibling groups / nested static groups 进入 one-drag snapshot。包含 dynamic group dependency、duplicate id、nonfinite geometry 或 group cycle 的 input 不优化。

### 6.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 | 通过：foundation 的 static root + nested static group + leaf fixture 验证 x/y guide values 与 legacy full scan 一致，并验证 global nearest result。 |
| AC-2 | 通过：foundation 验证 direct moving child、nested moving child、cycle、duplicate id、Infinity bounds 与 R15 dynamic group fixture均返回 null snapshot。 |
| AC-3 | 通过：accepted static-group snapshot 可在 own moving-array `advance` 后保持 current；copy/external reference mismatch 返回 false，R15 O(1) lifecycle contract 未变。 |
| AC-4 | 通过：R15 flat tie/strict/multi-moving 回归继续通过；远端 `benchmark:snap` exit 0，10k/1k flat fixture `exactResultEqual=true` / 2000 axes matched。R16 不把该 flat observation 扩张成 group timing claim。 |
| AC-5 | 通过：远端 `typecheck`、`check:foundations`、`benchmark:snap`、full `check` 均 exit 0；fixed capability 仍为 12。Vite 仅有既有 >500 kB chunk warning，SQLite 仅有 ExperimentalWarning。 |

## 7. 风险与回退

- A hidden descendant edge omitted from `parentId` graph cannot be inferred; it is outside current `getElementBounds` behavior too. The code only authorizes what the existing graph can prove.
- A malformed/cyclic group graph is refused rather than optimized.
- Group bounds can still be costly at drag start; this scope only removes per-pointer repetition.
- In-place mutation is unsupported as under R11/R15.

## 8. 完成边界

R16 has verified a dependency-safe relaxation of R15’s group fallback for one drag snapshot. It is not group bounds incremental propagation, a persistent hierarchy index, or an interaction service for resize/rotate/hit-test.
