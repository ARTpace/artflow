# ADR-018：持久导入任务可观测与有界 UI 边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联 FDD**：FDD-018
- **补充**：ADR-009 / ADR-010

## Context

Durable import jobs already safely stage bytes, recover queued/running intent and expose request/get/cancel. Their only renderer consumer is currently R10’s hidden save-time polling. A renderer-visible queue must not receive raw staging details, turn journal history into an unbounded IPC payload, or falsely imply that cancellation interrupts an irreversible promotion.

## Decision

1. Keep `ProjectRepository` as sole journal/staging owner. `AssetImportController` derives a presentation-safe snapshot and exposes at most 25 jobs: active FIFO entries have priority, then most recently updated terminal jobs fill remaining capacity.
2. Add exactly one fixed `listImportJobs` task alongside the existing named import tasks. It has no renderer-supplied query/filter/path argument and remains behind `assertTrustedRenderer`.
3. Extend R10 materialization with an optional observer callback rather than a second importer. Existing callers retain exact result/fallback semantics when no observer is supplied.
4. Let `useFileSystem` own renderer polling lifecycle and render a compact Import Jobs panel only when managed Electron storage is available/open.
5. Reuse existing cancellation as a request. The UI reports server snapshots and does not promise a running job will become cancelled.

## Consequences

### Positive

- Recovered work, progress and terminal failures become visible without breaking the raw-byte ownership boundary.
- Renderer has no access to staging file names, hashes, native paths, SQLite, arbitrary job queries or IPC.
- The save flow remains one source of truth for asset materialization, while UI gets lifecycle observations.

### Negative / accepted limits

- Polling is bounded/periodic, not push-based progress.
- Recent terminal history is intentionally truncated; retention/GC stays a repository policy problem.
- A completed import can still precede a failed/unwritten document save because this is not a cross-boundary transaction.
- Capability count increases from 12 to 13, but the new capability is narrow, fixed and sender-checked.

## Alternatives rejected

- **Expose repository list/query or staging directory**: breaks R9 ownership/security and allows unbounded data access.
- **Make the panel read journal SQLite directly**: gives renderer privileged storage access and duplicates lifecycle rules.
- **Add a generic event channel**: expands IPC surface and requires lifecycle/backpressure design before there is a demonstrated need.
- **Implement retry/batch/transaction together**: conflates independent failure and commit semantics; each needs a separate FDD.

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0；fixtures prove the 25-summary bound, active/recent ordering, basename/path redaction, safe fixed bridge, 13-channel count and R10 observer sequence.
- Remote `npm --prefix artflow run check` exit 0（typecheck + Vite production build + foundation）；only existing Vite chunk-size and Node SQLite experimental warnings remain. Final 19/19 source/governance exact read-back SHA-256 matched.

## Revisit triggers

Create a new FDD if job volume needs pagination/retention, if true progress events are required, or if retry, batch import, document transaction recovery, Worker parsing or multi-window coordination is introduced.
