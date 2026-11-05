# ADR-010：受管保存与 Durable Import Job 消费边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-010-Phase2f受管保存路径消费DurableImportJob.md`

## 背景

现有 `materializeManagedProjectDocument` 是 renderer data/blob locator 转受管 asset 的唯一 save-time adapter。R9 新增的 job API 如果由另一个 UI 或隐式分支消费，会造成同一 asset 在“direct import”与“durable staging”之间无理由分裂，并让普通保存失去 R9 的恢复证据。

## 决策

```text
serializeProjectDocument
  → materializeManagedProjectDocument
    → requestImport(asset bytes)
    → getImportJob(job id) until terminal
    → completed result.asset
  → saveProject(managed document)
```

- R9 job API 存在时，materializer 优先消费它；completed result 是唯一可写入 managed project document 的结果；
- queued/running 只在 renderer 等待 fixed `getImportJob`，renderer 不读取 staging bytes、hash、path，也不自己写 metadata；
- cancelled/failed/missing/invalid completed result 是 materialization error，不能降级成 direct import 或写一份猜测的 document；
- R9 capability 不存在时才使用 R5 `importAsset` fallback，以保留旧 preload/mock/compatibility 情况；
- job 和 project save 仍不是跨 renderer crash 的 atomic transaction：asset job 可恢复，不代表未提交 renderer document 会自动保存。

## 后果与边界

- 正常 Electron managed save 已实际经过 R9 staging/journal，而不再只保留一个未消费的 API；
- save await job terminal，因此本轮不提供 UI progress/cancel，也不承诺大批量导入不等待；
- crash 在 job complete 与 `saveProject` 前仍可能留下可查询 managed asset 但没有新的 project document，这由后续 transaction/recovery UX 解决；
- 没有新增 privilege、IPC、schema 或 storage owner；所有 raw bytes 仍只从 renderer 经 existing fixed request 到 main/repository。


## 实现证据（2026-09-22）

- `materializeManagedProjectDocument` 已是 R9 job API 的唯一 save-time consumer；它使用 request/get fixed capability，不接触 staging hash、path 或 raw filesystem。
- active status 只 poll；terminal error/missing result 会 reject，legacy bridge 才 fallback 到 direct import。真实 controller bridge 与 mock state machine 都经 foundation 验证。
- `useFileSystem.saveProject` 无需新 UI/API 即通过 materializer 接到该路径；同时仍明确保留“job complete 不等于 project document 已提交”的 transaction boundary。
- 远端 `npm --prefix artflow run check` 已通过；没有新增 schema、preload/main privilege 或 renderer Node capability。

## ADR-018 窄化说明（2026-09-22）

ADR-018 已验证把 R10 polling transition 作为 optional renderer observer 传递给 UI；它不会改变 completed-result authority、direct-import compatibility fallback 或 document transaction boundary。
