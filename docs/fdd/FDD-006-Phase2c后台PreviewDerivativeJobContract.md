# FDD-006：Phase 2c —— Background Preview Derivative Job Contract

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-006-后台Derivative-Worker与Job状态边界.md`、`FDD-005-Phase2b受限StorageIPC与ManagedImportBridge.md`

## 决策阶梯

1. **是否需要**：需要。R5 的 managed import / protocol 仍在 renderer/main full-buffer path 上；没有 job lifecycle、进度、取消或 preview derivative。
2. **是否已有能力**：复用 R4 `ProjectRepository`、R5 `ProjectStorageController` 与 fixed preload IPC；不得重建 blob/database ownership。
3. **标准库**：使用 Node / Electron runtime 已有 `node:worker_threads`、`crypto`、`fs`；不增加 image/native worker package。
4. **平台特性**：Worker 不向 renderer 暴露；main 仍为 repository 的唯一 metadata writer。
5. **已有依赖**：无新增 dependency。
6. **一行方案**：不能在 renderer 或 main synchronous call 中安全表达 queue、progress、cancel 和 failure lifecycle。
7. **最小实现**：单并发 Worker-thread preview-card derivative、in-memory job state、SQLite derivative metadata 和三个 fixed job IPC methods。

## 范围

- 增加 content-addressed derivative storage tree 与 SQLite derivative metadata；
- 增加 `AssetDerivativeController`：FIFO 单 worker、queued/running/completed/cancelled/failed 状态、进度、取消；
- Worker 只接收 registered original bytes 的 transfer，不直接写 SQLite；main 写 derivative metadata/blob；
- 生成无需第三方图像库的 deterministic SVG preview-card derivative；
- 为 renderer 增加 request preview / get job / cancel job 三个 fixed capability；
- 覆盖 completed、cancelled、failure / cap、reopen derivative read-back。

## 非目标

- 不实现 image raster thumbnail、video poster、PDF/3D preview、format handler、multi-worker pool 或 Electron utilityProcess；
- 不实现 durable queue、job restart、priority、batch import、cancel propagation to native decoder、UI progress panel；
- 不改写 R3 v2 contract、R4 blob schema、R5 storage IPC/protocol security boundary；
- 不让 Worker 直接打开 SQLite 或让 renderer 取得 blob path。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | SQLite 可记录/read derivative metadata，derivative bytes 使用 SHA-256 immutable storage |
| AC-2 | 单并发 controller 报告 queued/running/completed/cancelled/failed，并支持 queued/running cancellation |
| AC-3 | Worker produces deterministic SVG preview derivative；main 写入 metadata，reopen 后可 read |
| AC-4 | Worker 输入有明确 cap；错误不破坏原 asset / document |
| AC-5 | preload / main 只增加三个 fixed job methods，不增加 generic IPC / filesystem capability |
| AC-6 | foundation、typecheck、production build 通过 |

## 实现与验证记录

- `ProjectRepository` storage schema 已升级为 v2：`.artflow/derivatives/sha256/<prefix>/<hash>` 保存 immutable SHA-256 derivative bytes，`derivative_metadata` 按 `(asset_id, recipe)` 保存 hash、MIME、size 与 timestamps；v1 metadata database 可原位迁移。
- `AssetDerivativeController` 只经 `ProjectStorageController` 持有 repository：单并发 FIFO、in-memory `queued` / `running` / `completed` / `cancelled` / `failed`、进度与 queued/running cancellation。
- `workers/assetPreviewWorker.cjs` 只取得已登记 original 的 bounded transferred bytes 和安全 asset descriptor，回传 deterministic SVG preview-card bytes；不打开 SQLite、不写 path 或 metadata。
- renderer capability 只新增 `requestPreview`、`getPreviewJob`、`cancelPreviewJob` 三个 named invoke；main 每个 handler 仍做 trusted main-frame sender check。
- 2026-09-22 远端验证：`npm --prefix artflow run check` exit 0。foundation 覆盖 R4 schema v1→v2 derivative migration、completed、queued/running cancellation、input-cap failure、deterministic repeat、derivative reopen read-back 与 Worker/preload boundary；typecheck 与 Vite production build 同时通过。

## 保留边界

这不是 real raster/media thumbnail、durable queue、restart/retry、multi-worker、utilityProcess、batch import、renderer progress UI、range streaming 或 derivative GC 的实现。job state 仅存在当前 app process；仅已完成 derivative metadata/blob 持久化。
