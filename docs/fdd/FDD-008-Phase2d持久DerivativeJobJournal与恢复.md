# FDD-008：Phase 2d —— 持久 Derivative Job Journal 与恢复

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-008-持久DerivativeJob状态与关闭恢复边界.md`、`FDD-006-Phase2c后台PreviewDerivativeJobContract.md`、`FDD-007-PluginP0格式处理器注册表迁移.md`

## 问题与成功标准

R6 已持久化 completed derivative bytes/metadata，但 job lifecycle 仅存在进程内：重启后无法查询 terminal job，也不能恢复 queued/running work。这是 durable/background import 扩展的最小前置，不应直接跳到 raw File durable queue。

成功标准：已登记 original 的 preview job 在 SQLite 有 durable journal；正常 close / 进程中断留下的 queued/running state 在下次打开项目时可安全 requeue；completed/cancelled/failed job 可 reopen 查询且完成 derivative 仍可 read。

## 决策阶梯

1. **是否需要**：需要。没有 durable lifecycle，R6 worker contract 无法作为下一步 import/derivative queue 的可靠基础。
2. **是否已有能力**：复用 R4 `ProjectRepository` schema migration、R5 `ProjectStorageController`、R6 `AssetDerivativeController` / Worker / fixed preview IPC；不得新建 queue database 或 blob owner。
3. **标准库**：复用 Node `node:sqlite`、`worker_threads`、现有 `crypto`；不新增 job/queue dependency。
4. **平台特性**：Electron main 生命周期只关闭 worker；renderer 继续调用 R6 三个 fixed job API，不新增 capability。
5. **已有依赖**：无新增 dependency。
6. **一行方案**：内存 `Map` 无法在 process restart 后保存 job id、terminal outcome 或正确区分 cancel 和 interrupted running。
7. **最小实现**：schema v3 `derivative_job_metadata` + repository journal methods + controller startup recovery；running→queued，明确 cancel 才写 cancelled。

## 范围

- schema v3 新增 durable job record：job id、asset/recipe、status、progress、error code、completed derivative descriptor、timestamps；
- `ProjectRepository` 是 journal 的唯一 SQLite writer，提供 create/read/list/update/recover methods；
- `AssetDerivativeController` 在 queued/running/progress/completed/cancelled/failed transition 写 journal，并在 open/first-use rehydrate records；
- restart recovery 将 stale `running` 变为 `queued`，再按单并发 FIFO 继续；queued 也会恢复；
- controller close 停止 active Worker，但不把非 terminal job 假写为 cancelled；显式 `cancelPreviewJob` 仍是唯一 cancelled transition；
- 复用原有 request/get/cancel preview IPC，不添加新 renderer/main raw byte/path/filesystem API。

## 非目标

- 不实现 renderer raw File durable upload/source staging、batch import、retry policy、priority、multi-worker、cross-window locking、job GC/history cap、UI progress panel 或 notification；
- 不实现 real thumbnail/video/PDF/3D decode、utilityProcess、range streaming 或 parser Worker；
- 不修改 R7 FormatHandler contract、R3 project document、R4 blob/derivative tree ownership 或 R5 security boundary；
- 不承诺 crash 后恢复 worker memory；只恢复已持久化 job intent，重新从 registered original bytes 计算。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | R6 schema v2 database 可无损迁移至 schema v3 job journal |
| AC-2 | queued/running job 在 reopen 后恢复为 queued 并可完成；仍保持单并发 FIFO |
| AC-3 | completed/cancelled/failed durable snapshot 在 reopen 后可查询；completed derivative 可 integrity read-back |
| AC-4 | explicit cancel 与 controller close/recovery 语义可区分，不错误持久化 cancellation |
| AC-5 | 无新增 preload/main generic capability；repository 是 SQLite/blob 唯一 owner |
| AC-6 | foundation、typecheck、production build 通过 |


## 实现与验证（2026-09-22）

- `ProjectRepository` 已由 schema v2 原地迁移至 schema v3；`derivative_job_metadata` 与既有 asset / derivative metadata 共用 `.artflow/metadata.sqlite`，不新增 queue database。
- repository 已作为唯一 journal writer 提供 create/read/list/update/recover；completed job 仅保存 derivative descriptor，bytes 仍由既有 derivative content-addressed tree 管理。
- `AssetDerivativeController` 已在 request、running、progress、completed、failed、explicit cancel 时写 journal；first use / project open 会 rehydrate，stale `running` reset 为 `queued` 后以既有 single-worker FIFO 重跑。
- `ProjectStorageController.openProject()` 已显式调用 controller `restore()`；controller close 仅终止本进程 Worker，不伪造 `cancelled`，明确 `cancelPreviewJob` 才是 cancellation transition。
- 远端执行 `npm --prefix artflow run check` exit 0（`tsc -p tsconfig.json`、`vite build`、`node scripts/check-core-foundations.cjs`）。foundation 实测 v1→v3、v2→v3、`openProject()` restore invocation、queued/running close + repository reopen recovery、completed/cancelled/failed reopen query 与 completed derivative read-back；未新增 preload / generic IPC / renderer DB、blob、raw path capability。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：foundation 直接构造 v2 / v1 metadata 后原地打开并验证 schema v3 journal API。 |
| AC-2 | 通过：single-concurrency 中断的 running 与后续 queued job 在 repository reopen 后均变为 queued；journal read-back 保持 durable insertion FIFO，并由 controller 完成。 |
| AC-3 | 通过：completed / cancelled / failed 在重新打开 controller 后可按 job id 查询；completed derivative hash-validated read-back 成功。 |
| AC-4 | 通过：close 后 journal 不为 cancelled；显式 cancel 保持 cancelled。 |
| AC-5 | 通过：沿用 R6 三个 fixed preview API；无新 preload/main generic capability。 |
| AC-6 | 通过：远端完整 `npm --prefix artflow run check` exit 0。 |

## 完成边界 / 后续入口

本轮只让**已登记 original asset** 的 preview derivative intent/outcome 可恢复。仍未实现 renderer raw `File` durable staging、batch import transaction、retry / priority / multi-worker、queue retention / GC / UI、真实媒体 decode、range streaming 或跨窗口 locking；这些必须以新的 FDD 进入 durable raw import 或后续硬化工作流。
