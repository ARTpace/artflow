# ADR-016：静态 Group 拖拽吸附依赖安全边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-016
- **补充 / 窄化**：ADR-015 对 “any group fallback” 的 blanket rule

## Context

R15 correctly declines group-bearing boards because group bounds depend on children. During a normal selected-group drag, however, `idsToDrag` includes the group and its descendants; any other static group whose descendant closure is entirely non-moving has unchanged bounds over that gesture. Rebuilding those static group bounds on every pointer move is avoidable.

Treating all groups safe would be wrong: a static parent group with a moving child changes its bounds. A broad hierarchy cache also creates ownership/invalidation work outside R15’s gesture scope.

## Decision

1. At drag start, construct a direct `parentId → children` map as part of the one-shot snapshot build.
2. Reject the snapshot if IDs duplicate, geometry is non-finite, or a group DFS sees a cycle.
3. For every non-moving group, reject if any direct/recursive descendant is in the moving-id set. If all static groups prove safe, allow the existing R15 snapshot construction.
4. Continue to call existing `getElementBounds` once at capture for each static item, preserving legacy group geometry and source-order guide Set behavior.
5. Keep R15’s expected elements identity protocol exactly: hook-owned static-preserving movement may advance; any observed different array invalidates and uses legacy scan.

## Consequences

### Positive

- Group-containing boards with independent static groups can use the same one-drag guide snapshot.
- Dynamic group dependency is conservative: a single moving descendant disables the optimization.
- No new ownership, IPC, schema or long-lived hierarchy cache is introduced.

### Negative / accepted limits

- Drag start can still perform recursive group bounds work.
- Cyclic / malformed graph input gets no optimization; existing legacy behavior remains fallback authority.
- This does not make group bounds incrementally maintained between interactions.

## Alternatives rejected

- **Keep universal group fallback forever**: correct but rejects a provably stable and frequent static sibling group case.
- **Incremental group bounds cache**: requires child→ancestor invalidation and structural operations design; out of scope.
- **Use R11 viewport cache**: viewport bounds cache is not a global axis guide or a group dependency proof.
- **Assume selection closure always protects groups**: custom/invalid state can violate it; explicit DFS proof is required.

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0; R16 fixtures cover static nested group equality, direct/nested dynamic-descendant rejection, cycle/duplicate/nonfinite rejection and expected-array advance/mismatch.
- Remote `npm --prefix artflow run benchmark:snap` exit 0; R15 flat 10k / 1k exact-result regression stays green, but no group timing threshold is inferred.
- Remote `npm --prefix artflow run check` exit 0 (typecheck + Vite production build + foundation); only the pre-existing chunk-size warning and Node SQLite ExperimentalWarning remain.

## Revisit triggers

A normalized scene graph, operation-level hierarchy mutation stream, constraints/baselines, or cross-board snap requires a dedicated hierarchy/interaction FDD rather than extending this gesture snapshot further.
