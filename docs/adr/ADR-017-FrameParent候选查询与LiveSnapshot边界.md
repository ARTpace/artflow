# ADR-017：Frame Parent 候选查询与 Live Snapshot 边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-017
- **补充**：ADR-014 的 interaction reader consumer 范围

## Context

Frame parenting at drag commit scans every frame for every moved non-frame element. The R11 index already holds live bounds, and ADR-014 defines a same-elements identity-safe reader that fails closed to full elements. Saved R12/R13 query is unsuitable: drag commit can use renderer transient state not yet saved.

## Decision

1. Implement one pure helper that invokes R14 `queryInteractionCandidates` with the moved element bounds and current `elements` reference.
2. Filter candidate elements to frames and run the unchanged inclusive containment predicate and existing frame comparator sort.
3. Pass the interaction reader only as an optional optimization. If it is null/stale, helper observes current full list and reproduces legacy behavior.
4. Keep this inside existing `commitAction` updater. Do not lift frame parent state to MainCanvas, cache candidate frames across moves, or create an IPC query.

## Consequences

### Positive

- Current R11 snapshot can avoid unrelated frame scanning in frame-heavy commit paths.
- Reader freshness guarantees no missed container due to a stale MainCanvas ref.
- Existing parent comparator semantics remain independently testable in a pure function.

### Negative / accepted limits

- First/mismatched snapshots retain full scan.
- Each moving element still invokes one candidate query; batch planning is not introduced.
- This does not solve group bounds propagation or frame hierarchy constraints.

## Alternatives rejected

- **Saved R12/R13 viewport query**: may omit unsaved live state and crosses IPC for a local commit.
- **Second FrameIndex**: duplicates R11 lifecycle/memory without need.
- **Mutate parent during pointermove**: changes existing commit-only transaction semantics.

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0；current/stale/null reader、group bounds、padding false positive、edge and comparator/source-order tie all compare to the exact legacy resolution.
- Remote `npm --prefix artflow run benchmark:frame-parenting` exit 0；10k nodes / 1k queries had `exactResultEqual: true` and an observed candidate-phase ratio only, with no hard threshold or FPS claim.
- Remote `benchmark:viewport`、`benchmark:snap` and full `check` exit 0；full check retains only the existing Vite chunk-size and Node SQLite experimental warnings。
- Final remote exact read-back matched local text/SHA for the 11 R17 source and governance files.

## Revisit triggers

If profiling shows multi-selection frame parenting dominates commits, or frame semantics evolve to nested constraints, build a dedicated operation-level hierarchy plan under a new FDD.
