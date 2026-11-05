# FDD-009：Phase 2e —— 持久 Raw Import Staging 与单文件恢复

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-009-RawImportStaging所有权与恢复边界.md`、`FDD-008-Phase2d持久DerivativeJobJournal与恢复.md`、`FDD-005-Phase2b受限ElectronStoragePath.md`

## 问题与成功标准

R8 只恢复已经登记 original asset 的 derivative job。现有 R5 `importAsset` 是 renderer 在保存时把 data/blob-backed bytes 直接交给 main 的同步 materialization；raw input 本身没有 durable intent/staging，进程关闭或崩溃时不能查询或恢复尚未完成的导入。

成功标准：单个 renderer-owned raw byte payload 先被 main/repository 原子 stage，再登记 durable import job；queued/running import 在 reopen 后可继续把 staged bytes 变为既有 R4 managed asset；terminal result 可 reopen 查询且 completed original 可 integrity read-back。该轮为未来 batch import/UI 的最小基础，不把现有 renderer 文件解析或 board insertion 伪装成已后台化。

## 决策阶梯

1. **是否需要**：需要。R8 的 derivative journal 不能覆盖 asset 尚未登记前的 raw input 生命周期。
2. **是否已有能力**：复用 R4 `ProjectRepository` content-addressed materialization、R5 fixed/trusted IPC、R8 durable FIFO/close semantics；保留旧 `importAsset` compatibility path，不重写其 consumer。
3. **标准库**：复用 Node `node:fs/promises`、`crypto`、`node:sqlite`；不引入 queue/upload dependency。
4. **平台特性**：复用 Electron contextBridge / `ipcMain.handle` 的 named task API；renderer 只提交 `ArrayBuffer`，不暴露 native path 或 filesystem capability。
5. **已有依赖**：无新增 dependency。
6. **一行方案**：不能。原子 staged bytes、SQLite intent/outcome、close/reopen recovery 必须保持同一 ownership boundary。
7. **最小实现**：schema v4 `import_job_metadata` + private content-addressed staging tree + one FIFO `AssetImportController` + request/get/cancel three fixed APIs；单文件、无 parser Worker、无 batch/retry/UI。

## 范围

- schema v4 在同一个 `.artflow/metadata.sqlite` 新增 import job journal，并在 `.artflow/import-staging/sha256/` 原子保存 raw staged bytes；
- request 成功返回前必须已完成 staging 与 queued job journal 写入；job draft 只保存 asset id/kind、safe locator metadata 和 JSON metadata，绝不持久化 renderer `File`、native path、data/blob locator；
- `ProjectRepository` 是 staging、job metadata、最终 original blob/asset metadata 的唯一 writer；completed result 复用 R4 `putAsset` managed store；
- `AssetImportController` 保持 single-process/single-concurrency FIFO，持久化 queued/running/progress/completed/cancelled/failed；stale `running` 在 reopen 时变为 queued；
- `ProjectStorageController` project open/close 管理 import controller；新增三个 named IPC/preload API：request / get / cancel import job；
- 旧 R5 `importAsset` 和现有 save/materialize renderer flow 保持兼容，不在本轮改写 UI。

## 非目标

- 不实现 renderer/native raw path import、directory picker bulk enumeration、batch transaction、retry/priority、multi-worker、cross-window locking、job retention/GC、progress UI/notification、automatic board/node insertion；
- 不实现 PSD/PDF/video/RAW parser Worker、real thumbnail、MIME sniff、streaming/range 或 staging encryption；
- 不改变 R3 document format、R4 original/derivative ownership、R6/R8 preview journal、R7 FormatHandler contract 或 generic IPC/security boundary；
- 不承诺 terminal staged-byte cleanup；安全 GC/retention 属于后续独立工作。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | R8 schema v3 database 可无损迁移至 schema v4 import journal/staging contract |
| AC-2 | request 返回前 staged bytes 与 queued intent 都已 durable；queued/running close + reopen 后可按 FIFO 完成 managed asset import |
| AC-3 | completed/cancelled/failed job 可 reopen 查询；completed asset original 可 integrity read-back |
| AC-4 | explicit cancel 与 controller/project close/recovery 语义可区分，不错误持久化 cancellation |
| AC-5 | 仅新增三个 named import task API；无 generic IPC/path/filesystem/DB/raw staging access 给 renderer；旧 `importAsset` 不回归 |
| AC-6 | foundation、typecheck、production build 通过 |


## 实现与验证（2026-09-22）

- `ProjectRepository` 已升级为 schema v4：`import_job_metadata` 与 R4/R8 metadata 复用同一个 `.artflow/metadata.sqlite`，staged bytes 由 `.artflow/import-staging/sha256/` 的 content-addressed tree 原子保存。
- raw import draft 在写 journal 前会剥离 `data:` / `blob:` / `fileRef` 等 renderer reference，只持久 asset id/kind、MIME/extension/format 与 JSON metadata；staging hash/path 不会通过 preload job snapshot 返回 renderer。
- 新增 `AssetImportController`，对 queued/running/progress/completed/cancelled/failed 进行 durable lifecycle 管理；stale running 在 reopen 时 reset queued，durable insertion FIFO 恢复；close 不写 cancellation。
- `ProjectStorageController.openProject()` 同时 restore derivative/import controller；新增 `requestImport` / `getImportJob` / `cancelImportJob` 三个 trusted fixed IPC/preload operation，旧 R5 `importAsset` 和现有 save/materialize flow 保持不变。
- 远端执行 `npm --prefix artflow run check` exit 0（`tsc -p tsconfig.json`、`vite build`、`node scripts/check-core-foundations.cjs`）。foundation 实测 v3→v4、stage-before-job、draft reference stripping、queued/running close + repository reopen FIFO recovery、completed/cancelled/failed reopen query、completed original hash-validated read-back、openProject restore、legacy immediate import compatibility 与 fixed API static proof。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：foundation 构造 R8 v3 metadata 后原地打开，验证 schema v4 import journal API。 |
| AC-2 | 通过：stageImport 返回 queued record 前已 materialize bytes；一个 running 与后续 queued job 在 repository reopen 后均 queued、保持 durable insertion FIFO，并完成 managed import。 |
| AC-3 | 通过：completed / cancelled / failed 在重新打开 controller 后可按 job id 查询；completed original read-back 成功。 |
| AC-4 | 通过：controller close 后 running record 不为 cancelled；explicit queued cancel 保持 cancelled。 |
| AC-5 | 通过：仅新增 request/get/cancel 三个 named API，保留 trusted sender check 与 R5 `importAsset`；未暴露 generic IPC、path、filesystem、SQLite 或 staging access。 |
| AC-6 | 通过：远端完整 `npm --prefix artflow run check` exit 0。 |

## 完成边界 / 后续入口

本轮只提供 single-file raw byte staging 与 asset materialization recovery。仍未实现 renderer UI 接线、automatic board/node insertion、batch transaction、retry/priority、parser/thumbnail Worker、real media derivative、多窗口 coordination、retention/GC、streaming/range 或 staging encryption；这些必须以新的 FDD 进入 raw import 后续或恢复硬化工作流。

## R18 窄化说明（2026-09-22）

FDD-018 已验证仅暴露 R9 journal 的有界、脱敏 observation summary 与既有 cancel request UI；不会暴露 staging path/hash/raw bytes，也不改变 R9 FIFO、recovery 或 ownership。
