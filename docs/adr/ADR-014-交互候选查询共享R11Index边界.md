# ADR-014：交互候选查询共享 R11 Index 的边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-014

## Context

`MainCanvas` 已拥有 R11 cache，但 interaction hook 位于 App，无法直接读取其 index；直接在 App/hook 再 build index 会重复 CPU/memory，并可能与 MainCanvas lifecycle 不同。R12/R13 保存快照查询有 cursor/revision correctness，但不能代表尚未保存的 renderer state。

## Decision

1. MainCanvas 仍是 cache owner；它仅向一个 caller-provided mutable ref 发布 `{ elements, index }` snapshot，不转移 cache ownership。
2. App 传递 ref；interaction hook 按 `snapshot.elements === currentElements` identity gate 读取 index，否则使用 current full list。
3. box/lasso 只将 query 用作 candidate generator，保留现有 `getElementBounds`、strict overlap、polygon center 和 `getSelectableElement` final predicates。
4. snap 与 frame parenting 不接入此轮，因为现有规则分别需要 global alignment / post-commit elements consistency，不是同一个局部 region query 问题。
5. 不跨 IPC 调用 R12/R13，因为 live state freshness 优先于 persisted snapshot.

## Consequences

### Positive

- 没有第二 index，cache diagnostics/lifecycle 仍集中在 R11。
- interaction final semantics 不变，padding/grid false positives 安全过滤。
- stale ref fail-safe 到 current list，而非返回 stale candidates。

### Negative / accepted limits

- 首次 mount 或 identity mismatch 仍可能 full scan。
- snap、frame parenting、rotation/hit-test 和 pointer-move heavy paths 保持后续 scope。
- shared ref 不等于 general renderer spatial service，也不提供 Worker/cache eviction.

## Alternatives rejected

- **hook 内新建 index**：重复 build 与 ownership，且有不同 freshness 生命周期。
- **App 接管 R11 cache**：破坏已验证 MainCanvas mount-scoped boundary，且扩大 R11 scope。
- **R12/R13 IPC query**：saved snapshot 对 live selection 可能陈旧，并把 interaction hot path 送过 IPC。
- **同时优化 snap**：局部 AABB query 会改变当前 cross-canvas alignment 语义。

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0；其 R14 fixtures prove group/padding/stale fallback and exact final result equivalence.
- Remote `npm --prefix artflow run benchmark:viewport` exit 0；10k synthetic box result equality recorded without a hard timing gate.
- Remote `npm --prefix artflow run check` exit 0（typecheck + Vite production build + foundation）；only the pre-existing chunk-size warning and Node SQLite ExperimentalWarning remain.

## Revisit triggers

当 snap/hit-test/box/lasso 的 profiling 证明需要不同索引维度，或 live operation mutation/Worker contract 已成立时，另建 FDD 设计 dedicated interaction spatial service。


## ADR-017 窄化说明（2026-09-22）

ADR-017 已验证在 R14’s same-elements reader boundary 内增加 commit-time frame candidate consumer；candidate query 仍需 current-reference gate，exact containment and the pre-existing frame comparator remain hook/helper authority。
