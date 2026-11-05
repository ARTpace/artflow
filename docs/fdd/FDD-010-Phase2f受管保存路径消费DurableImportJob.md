# FDD-010：Phase 2f —— 受管保存路径消费 Durable Import Job

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-010-受管保存与DurableImportJob消费边界.md`、`FDD-009-Phase2e持久RawImportStaging与恢复.md`、`FDD-005-Phase2b受限ElectronStoragePath.md`

## 问题与成功标准

R9 已建立 `requestImport/getImportJob/cancelImportJob` 和 durable staging，但当前实际 managed save path 仍在 `utils/managedProjectStorage.ts` 直接调用旧 R5 `importAsset`。如果不消费 R9 contract，普通 Electron 保存不会从 staged import recovery 获益，且新 capability 容易成为未接线的孤立实现。

成功标准：既有 data/blob-backed asset 在 managed save materialization 中优先 request durable import job，等待 terminal completed 后使用其 managed asset result 组成 project document；cancelled/failed/missing job 使 materialization 明确失败；不支持 R9 job capability 的兼容 storage 仍走原 `importAsset`。本轮只连接受管保存的 asset materializer，不声称实现完整 save transaction recovery 或导入 UI。

## 决策阶梯

1. **是否需要**：需要。R9 的最小 job contract 应由现有唯一 managed-document materializer 消费，避免“有 durable queue、正常保存仍绕过”的双路径。
2. **是否已有能力**：复用 `materializeManagedProjectDocument`、R9 named import API 和 R5 direct `importAsset` fallback；不重写 `useFileSystem` / renderer file parsing。
3. **标准库**：复用 Promise / `setTimeout` 小间隔 polling；不新增 dependency。
4. **平台特性**：沿用 contextBridge 暴露的 fixed capability；不新增 IPC channel、schema 或 Electron privilege。
5. **已有依赖**：无新增 dependency。
6. **一行方案**：不能。必须区分 completed、cancelled、failed、missing job 与 legacy fallback，避免把 terminal error 误写成 save success。
7. **最小实现**：只在 `utils/managedProjectStorage.ts` 增加 request→poll→completed-result bridge；保留 direct import fallback，增加 foundation proof。

## 范围

- managed project save 中，对非 `managed-store` data/blob asset 优先调用 `requestImport`，以 R9 durable staging 作为 asset materialization path；
- polling 仅调用 fixed `getImportJob`，terminal completed 才接纳 `result.asset`；
- cancelled、failed、unknown/missing job 或 completed-without-result 均 reject materialization；
- R9 capability 不存在时保留 R5 `importAsset` compatibility fallback；
- 不增加 renderer UI、preload/main API、SQLite schema、controller method、path / filesystem / raw staging access。

## 非目标

- 不实现 project document + import job 的原子 transaction、crash 后自动恢复并提交尚未保存的 renderer document、job panel/progress/cancel UI、automatic board/node insertion；
- 不实现 batch/retry/priority、parser/thumbnail Worker、real media derivative、multi-window coordination、staging GC、range/streaming；
- 不改变 `useFileHandlers` parser flow、R3 document format、R4/R8/R9 repository ownership 或 R7 FormatHandler contract。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | 支持 R9 request/get capability 时，materializer 通过 durable job 的 completed result 生成 managed asset，而非调用 direct import |
| AC-2 | queued/running polling、completed、cancelled、failed 与 missing result 的状态均有明确行为；失败不会返回 partial managed document |
| AC-3 | 无 R9 job capability 的 legacy storage 仍调用原 `importAsset` 并保持现有 managed document 结果 |
| AC-4 | 无新增 IPC/preload capability、schema、filesystem/path/raw staging access 或 UI；只消费既有 fixed API |
| AC-5 | foundation、typecheck、production build 通过 |


## 实现与验证（2026-09-22）

- `utils/managedProjectStorage.ts` 已让唯一的 `materializeManagedProjectDocument` adapter 在 R9 `requestImport` + `getImportJob` 同时存在时优先走 durable request→terminal poll→completed result path；normal Electron `useFileSystem.saveProject` 已通过该 adapter 实际消费 R9 contract。
- queued/running 仅通过 fixed `getImportJob` 轮询；completed 必须有与原 asset id 匹配的 managed result，cancelled/failed/missing/unknown job 均 throw，不会返回 partial managed document。
- 对缺少任一 R9 job method 的 compatibility storage，保持原 R5 `importAsset` path；没有增加 IPC/preload API、schema、controller、renderer UI 或 privileged access。
- 远端执行 `npm --prefix artflow run check` exit 0（`tsc -p tsconfig.json`、`vite build`、`node scripts/check-core-foundations.cjs`）。foundation 用 legacy mock、queued→running→completed mock、真实 `ProjectStorageController` + R9 import controller bridge、failed/cancelled/missing/completed-without-result proof 验证 materializer 行为。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：durable-capable storage 不调用 direct import；completed result 被用于 materialized asset，并由真实 controller bridge read-back。 |
| AC-2 | 通过：queued/running poll、completed、cancelled、failed、missing job 和 missing result 均有明确成功/失败结果。 |
| AC-3 | 通过：无 R9 capability 的 legacy mock 仍调用原 `importAsset` 并生成 managed document。 |
| AC-4 | 通过：只修改 renderer-side adapter 与 foundation；不新增 IPC、schema、filesystem/path/staging capability 或 UI。 |
| AC-5 | 通过：远端完整 `npm --prefix artflow run check` exit 0。 |

## 完成边界 / 后续入口

R10 让正常 managed save 使用 durable import job，但 job 与 project document 仍不是 atomic transaction：crash 在 job complete 和 `saveProject` 前可留下可查询 asset，却不会自动保存 renderer document。仍未实现 transaction recovery、batch/retry/priority、progress/cancel UI、automatic board insertion、parser/thumbnail Worker、multi-window coordination、staging GC 或 streaming；这些必须以新的 FDD 进入 raw import 后续或恢复硬化。

## R18 窄化说明（2026-09-22）

FDD-018 已验证为 R10 的 existing request/get terminal poll 增加 optional observer 和 user-visible safe status；completed result 仍是唯一可写入 document 的 authority，不引入 transaction or retry。
