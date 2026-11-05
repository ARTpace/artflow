# ADR-015：拖拽吸附 Axis Guide Index 与全局语义边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-015

## Context

Existing drag snapping builds global static x/y guide Sets and scans every value on every pointer move. The rendering R11 grid is a viewport AABB index, while snap intentionally compares to any board alignment line; restricting it to a viewport / local AABB would silently change behavior.

Groups are unsafe for a frozen static snapshot because a group bound depends on children, including moving descendants. React drag updates create new arrays, so a snapshot also needs a cheap freshness contract rather than an O(n) validation per pointer move.

## Decision

1. Build a drag-scoped snapshot once after `idsToDrag` is known, from **non-moving** flat unique-id elements in source order; group/duplicate/nonfinite/empty input returns no snapshot.
2. Retain legacy `Set` de-duplication / first insertion rank, then sort a copy by numeric value for lower/upper-bound range querying. Equal distance resolves to lower insertion rank.
3. The hook keeps existing moving point order and global strict comparison. The index returns only a nearest static candidate per moving point; final delta and guide extent remain in the hook.
4. Snapshot expected-array identity begins with drag-start elements. Own `setElements` updater advances it only when its incoming previous array is expected; an observed mismatch invalidates and falls back to the existing per-move full scan. No O(n) freshness scan runs on indexed pointer moves.
5. Do not use R11, R12 or R13 for this path. R11 does not encode global axis guide values; R12/R13 are saved snapshots and may not represent live drag state.

## Consequences

### Positive

- Repeated pointer moves avoid rebuilding all static guide points on supported flat drags.
- Query preserves current global guide semantics and legacy deterministic tie behavior.
- Reference mismatch / unsupported geometry prefer correctness through legacy fallback.

### Negative / accepted limits

- First drag still builds guides O(n); dense threshold neighborhoods may still have many candidates.
- Group-bearing boards remain on legacy scan.
- This is a drag snapshot, not a shared cache, persistent index, or Worker protocol.

## Alternatives rejected

- **Use R11 viewport index**: it supports AABB / camera candidate queries, not global alignment lines; locality changes snap behavior.
- **Build a broad app-level snap cache**: expands ownership and invalidation scope prematurely; drag snapshot has a bounded lifecycle.
- **Validate every static object each move**: preserves freshness but reintroduces the O(n) work being removed.
- **Assume every new `elements` array is safe**: risks stale guides from external immutable edits.

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0; R15 assertions cover direct range-vs-Set equivalence, equal-distance rank, strict boundary, global multi-moving result, own-array advance and unsupported fallback.
- Remote `npm --prefix artflow run benchmark:snap` exit 0; 10k / 1k controlled fixture reports exact result equality. Its timing is confined to the static guide phase and has no hard gate.
- Remote `npm --prefix artflow run check` exit 0 (typecheck + Vite production build + foundation); only the pre-existing chunk-size warning and Node SQLite ExperimentalWarning remain.

## Revisit triggers

A future live normalized entity store / operation-level mutation protocol, group dependency graph, snap baselines, or cross-board alignment requires a new FDD and may supersede this transient flat-list snapshot.


## ADR-016 窄化说明（2026-09-22）

ADR-016 已验证以 one-drag dependency proof 窄化 “all groups reject” 的 implementation policy；它不迁移 R15 ownership、freshness or global axis semantics。任何 static group with moving descendant 继续拒绝 snapshot。
