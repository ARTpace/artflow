# ADR-008：持久 Derivative Job 状态与关闭恢复边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-008-Phase2d持久DerivativeJobJournal与恢复.md`

## 背景

R6 的 completed derivative 已 durable，但 job state 是 in-memory。把 job state 直接留给 renderer、另建 queue database，或把 raw File 放入 job record，都会破坏 R4-R6 ownership/security boundary。

## 决策

```text
fixed preview API
  → ProjectStorageController
  → AssetDerivativeController (ephemeral scheduler)
  → ProjectRepository derivative_job_metadata (durable intent/outcome)
  → R6 worker (registered original bytes → derivative bytes)
```

- `derivative_job_metadata` 属于同一个 `.artflow/metadata.sqlite`，不是第二个 queue database；
- job 只引用已登记 `asset_id` / recipe，绝不持有 renderer File/path/raw bytes；
- queued/running 是 **intent**：运行中进程消失不能证明用户取消，open 时统一 reset 为 queued；
- cancelled 是用户明确 API 的 terminal decision；failed 是已有 registered original / worker 路径实际失败；completed 保存 produced derivative descriptor；
- controller close 终止本进程 Worker，但不改写 non-terminal durable state；下次同项目 open 才恢复；
- scheduler 仍是 single-process, single-concurrency；durable journal 不等于 distributed queue / retry system。

## 后果与边界

- 用户可在 restart 后继续查询旧 job id，completed asset 也可继续 read；
- active worker 的 RAM、transfer buffer、live progress event 不恢复；恢复从 original blob 重跑，content-addressing 将去重相同 output；
- project switch 不跨项目执行旧 queue；旧项目下次打开才 resume；
- raw source staging、persistent import transaction、queue priority / retention / GC 属于后续 FDD；
- R5 fixed IPC 与 trusted sender guard 不变，且不会因此给予 renderer arbitrary queue/database access。


## 实现证据（2026-09-22）

- schema v3 在现有 metadata SQLite 内落地 `derivative_job_metadata`；它不保存 renderer raw File、path 或 bytes。
- `ProjectRepository.recoverDerivativeJobs()` 将 stale `running` 持久化重置为 `queued`；scheduler 仅把 queued records 按创建顺序重新入队。
- 关闭 controller 与显式 cancel 保持不同状态语义：close 不写 terminal cancellation；取消 API 才写 `cancelled`。completed / failed / cancelled 都是 reopen 可读 terminal record。
- `ProjectStorageController` 在新项目 repository 已打开后调用 `restore()`，仍维持 main/repository 的唯一 storage ownership 与 R6 fixed IPC。
- 远端 `npm --prefix artflow run check` 已通过；foundation 覆盖 schema migration、`openProject()` recovery invocation、reopen recovery、terminal read-back 与 close/cancel distinction。
