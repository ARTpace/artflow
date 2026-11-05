# ADR-006：后台 Derivative Worker 与 Job 状态边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-006-Phase2c后台PreviewDerivativeJobContract.md`

## 背景

R5 已让 renderer 安全写入 managed original 并读取 `artflow-asset`，但 importer、preview 和 metadata 仍缺乏可观察的后台 lifecycle。直接把缩略图/预览工作放回 renderer 或让 Worker 自己持有 SQLite 会破坏既有边界。

## 决策

```text
renderer fixed API
  → ProjectStorageController
  → AssetDerivativeController (FIFO, one worker)
  → worker_threads preview worker (bytes in, SVG bytes out)
  → ProjectRepository (only metadata/blob writer)
```

- derivatives 使用独立 content-addressed tree：`.artflow/derivatives/sha256/<prefix>/<hash>`；
- SQLite 以 `(asset_id, recipe)` 映射 derivative hash、MIME、size、timestamps；
- Worker 只产生 deterministic SVG preview-card bytes；不触碰 SQLite、path 或 renderer；
- job status 仅为 in-memory transient state；derivative 成品才持久化；
- 默认单并发和 bounded input，保证最小实现不耗尽 memory；
- R6 在 R5 preload capability 之上仅增添 request/get/cancel preview 三个 task-specific method。

## 后果与边界

- 这是 worker contract，不是完整 import/thumbnail system；
- job 在 app restart 后不恢复，已完成 derivative 可通过 repository 读取；
- SVG preview-card 是可靠降级，不等同真实 image/video/3D thumbnail；
- range streaming、multi-worker、utilityProcess 和 durable job queue 留给后续 FDD；
- Worker / controller 复用 R4/R5 ownership，不能出现第二套 metadata/blob path。

## 实现记录

- `storage/projectRepository.cjs` 是 originals 与 derivatives 的唯一 persistent owner；`main/assetDerivativeController.cjs` 只安排 lifecycle，worker 不持有 database/path capability。
- `preload.cjs` / `main.cjs` 在既有 five storage operations 之外，仅增加三个指定 preview job operation；不存在 generic IPC、Worker、filesystem、SQLite 或 raw byte exposure。
- 2026-09-22：远端 `npm --prefix artflow run check` exit 0，包含 typecheck、production build、v1→v2 migration 与 lifecycle/reopen foundation proof。
