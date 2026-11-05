# ADR-005：受限 Storage IPC 与 `artflow-asset` 协议边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-005-Phase2b受限StorageIPC与ManagedImportBridge.md`

## 背景

R4 建立了 Node-side `ProjectRepository` 和 `artflow-asset://sha256/<hash>` storage locator，但 renderer 仍无法安全写入 bytes 或读取 managed binary。直接暴露 Node、filesystem、SQLite、path 或 generic `ipcRenderer.invoke` 会破坏 Electron security boundary。

## 决策

- preload 通过 `contextBridge` 暴露固定、无 channel 参数的 `window.artflowStorage` API；
- 每个 privileged IPC handler 在 main 验证调用者是可信 main frame；renderer 不提交 native path，选择目录只经 `dialog.showOpenDialog`；
- Node-side `ProjectStorageController` 只持有当前单窗口 project repository，最大单次 import 限制为 128 MiB；
- renderer 在 managed save 前仅可 `fetch` data/blob locator 并发送 `ArrayBuffer`；external URL 不会被自动 fetch；
- `protocol.handle('artflow-asset', ...)` 只允许 GET/HEAD canonical hash URI，查到 metadata 后读取/验证 blob；错误统一转为 protocol 404 / 405，不泄漏 filesystem path；
- `artflow-asset` 声明为 secure / standard / fetch-capable custom scheme，使用 immutable cache header；
- protocol MIME 从 registered metadata 取得并 sanitize，同 hash 多 record 时优先非 `application/octet-stream` mapping。

## 已落地的位置

- `main.cjs`：scheme、IPC、trusted sender、navigation / popup restriction、protocol response；
- `preload.cjs`：five fixed APIs；
- `main/projectStorageController.cjs`：transfer cap、document cap、URI / MIME validation；
- `main/rendererTrust.cjs`：可测试的 packaged/dev origin trust policy；
- `utils/managedProjectStorage.ts`：renderer-managed data/blob materialization；
- `storage/projectRepository.cjs`：registered content hash metadata lookup。

## 后果与边界

- R4 database/blob ownership 不变，R5 只是其受控 transport / renderer resolver；
- protocol 当前为 full-buffer response；大媒体 range streaming 与 background import 必须由后续 Worker FDD 解决；
- controller 是单窗口最小实现，多窗口 session/project partition 留待真实需求；
- 现有 browser File System/download fallback 仍用于非-Electron 或 iframe；
- external-reference asset 在 managed save 时会得到明确错误而非 SSRF / 隐式网络访问。

## 验证

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run check              # exit 0
```

foundation self-check 覆盖 trusted URL policy、ArrayBuffer transfer cap、canonical resolver、MIME fallback、managed document lifecycle、data/blob bridge 与 external rejection。
