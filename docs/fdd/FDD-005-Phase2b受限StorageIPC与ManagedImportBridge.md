# FDD-005：Phase 2b —— Restricted Electron Storage IPC + Managed Import Bridge

- **状态**：verified
- **完成日期**：2026-09-22
- **关联**：`ADR-005-受限Storage-IPC与artflow-asset协议边界.md`、`FDD-004-Phase2本地资产库最小存储契约.md`、`docs/实施迭代台账.md`

## 决策阶梯

1. **是否需要**：需要。R4 repository 只在 Node side；renderer 既不能安全写入 bytes，也不能消费 `artflow-asset://` managed locator。
2. **是否已有能力**：复用 R4 `ProjectRepository` 与 R3 v2 adapter；没有创建平行 database/blob access 或 document schema。
3. **标准库**：使用现有 Electron `protocol.handle`、`ipcMain.handle`、`contextBridge` 与浏览器 `fetch`。
4. **平台特性**：custom scheme privilege 在 `app.ready` 前声明，handler 在 ready 后注册。
5. **已有依赖**：不新增 npm dependency；已验证 Electron 44 bundled Node 24.21.0 具备 `node:sqlite` 与 `Response`。
6. **一行方案**：contextBridge 不能直接暴露 generic `ipcRenderer`、filesystem 或 Node modules。
7. **最小实现**：task-specific preload API、Node controller、custom asset protocol、renderer data/blob → managed bytes adapter。

## 已实现

- 新增 `main/projectStorageController.cjs`：单个当前 project repository、128 MiB 单 asset transfer cap、32 MiB document IPC cap、canonical URI resolution 和 MIME sanitization。
- 扩展 R4 repository 的 metadata lookup：protocol 仅从已登记 content hash 读取 blob；同 hash 多 metadata 时优先非 generic MIME。
- 新增 `main/rendererTrust.cjs`：只信任 packaged `dist/` file URL 或 configured Vite dev origin；foundation self-check 覆盖 production / development allow/deny。
- `main.cjs`：
  - 保持 `nodeIntegration: false` / `contextIsolation: true`；
  - 声明 secure / standard / fetch-capable `artflow-asset` scheme；
  - 仅注册 five fixed IPC handlers；directory 只能由 `dialog.showOpenDialog` 选择，renderer 不传 native path；
  - handler 验证 trusted main-frame sender，阻止不可信 navigation / popup；
  - protocol 只接受 GET/HEAD canonical URI、返回 verified bytes 与 sanitized MIME，不泄漏 filesystem path。
- `preload.cjs` 仅暴露 `chooseProject`、`getStatus`、`importAsset`、`saveProject`、`loadProject`；不泄露 `ipcRenderer`、channel、Node 或 path。
- 新增 `utils/managedProjectStorage.ts`：顺序读取 renderer-owned data/blob locator，作为 ArrayBuffer 交给 fixed import API；external locator 明确报错，不进行隐式网络 fetch。
- `useFileSystem` 在 Electron 中优先使用 managed project storage；网页 / iframe 保持原 File System Access API / download fallback。保存错误已通过 App overlay 可见。
- foundation self-check 现覆盖 controller import cap、canonical resolver、MIME sanitization、managed document save/load、trust guard、data URL bridge 与 external rejection。

## 非目标 / 刻意保留的边界

- 不暴露 generic invoke、native path、filesystem、SQLite 或 raw read IPC；
- 不支持 renderer arbitrary local path 或 external http(s) asset auto-fetch；
- protocol 当前返回 full-buffer response，未实现 range/streaming media；
- 不实现 import queue、progress、cancel、utility process、Worker、thumbnail / derivative、GC、backup 或多窗口 repository ownership；
- 不重写 R3 document schema、R4 SQLite/blob layout 或 browser fallback。

## 验收结果

| 编号 | 标准 | 实际证据 |
|---|---|---|
| AC-1 | preload 仅暴露 fixed task API | `preload.cjs` 无 raw ipcRenderer / channel capability；code review + `node --check` exit 0 |
| AC-2 | trusted main frame + native dialog selection | `rendererTrust.cjs` foundation allow/deny assertions；main handler 仅调用 `dialog.showOpenDialog` |
| AC-3 | controller import / save / load 与 oversize rejection | foundation self-check 使用 temp R4 repository，断言 64-byte test cap rejection |
| AC-4 | canonical URI、registered metadata/blob、MIME-safe descriptor | foundation self-check 覆盖 resolver bytes、bad hash rejection、unsafe MIME fallback |
| AC-5 | data/blob bridge 与 external explicit failure | foundation self-check 使用 data URL mock import，断言 external reference rejection |
| AC-6 | foundation、TypeScript、production build 通过 | `npm --prefix artflow run check` 于 2026-09-22 退出码 0 |

## 验证记录

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run typecheck          # exit 0
npm --prefix artflow run check              # exit 0
node --check main.cjs                            # exit 0
node --check preload.cjs                         # exit 0
node --check main/projectStorageController.cjs   # exit 0
```

Electron runtime probe（`ELECTRON_RUN_AS_NODE=1`）确认 Electron 44.4.3 bundled Node `24.21.0`，`node:sqlite` 可用且 global `Response` 为 function。`node:sqlite` 仍会发出 experimental warning；Vite 仍有约 2.68 MB minified chunk 的 >500 kB warning，均不是 gate failure。

## 下轮入口

R6 应只处理 **background import / derivative job 的最小 worker contract**：受限 job request、进度 / 取消 / failure state、thumbnail/preview derivatives。不得重写 R3 v2 adapter、R4 repository 或 R5 IPC / protocol boundary；开始前需建立新的 FDD / ADR。
