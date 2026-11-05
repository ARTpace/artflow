# ADR-009：Raw Import Staging 所有权与恢复边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-009-Phase2e持久RawImportStaging与恢复.md`

## 背景

renderer `File` / data/blob URL 是短生命周期浏览器能力；R4 managed store 只能从已收到的 bytes 创建 asset。若在 raw bytes 已离开 renderer 后才记录 job，崩溃会留下不可恢复的 intent；若保存 renderer URL/path，又会突破 R5 security boundary 或把重复 Base64 写入 metadata SQLite。

## 决策

```text
fixed import task API (ArrayBuffer + asset draft)
  → ProjectStorageController
  → AssetImportController (ephemeral FIFO scheduler)
  → ProjectRepository import-staging bytes + import_job_metadata
  → R4 putAsset original blob + asset metadata
```

- staged bytes 是 project-private content-addressed recovery artifact，路径仅由 repository 解析；renderer 不接收或选择路径；
- job draft 会剥离 `data:` / `blob:` / file references，只保留 id、kind、MIME/extension/format 与 metadata；raw bytes 仅存在 staging file，不塞 SQLite JSON；
- `queued` / `running` 是 durable intent；open 时 stale `running` reset 为 `queued`；completed 通过 staged input 重放 R4 `putAsset`，保持 content-addressing 去重；
- `cancelled` 只来自明确 cancel API；controller/project close 只中断当前 process，不改写 non-terminal durable state；
- staging 先于 queued job response 完成。stage 成功但 SQLite insert 前中断可留下无引用 staging file，留待后续 safe GC；反过来不得写一个没有 staged bytes 的 queued job；
- R5 `importAsset` 继续是兼容的 immediate materialization API；R9 另加三个 fixed job API，绝不改成 generic import/IPC/filesystem channel。

## 后果与边界

- 单文件 raw import 可跨 process reopen 查询与恢复，但不会自动创建 board node 或更新尚未保存的 renderer document；
- 当前 scheduler 单进程、单并发、无 retry/priority。active I/O 已越过不可中断 commit point 时，明确 cancel 可能自然完成而不是伪造 cancelled；
- parser/thumbnail/metadata extraction 仍是下一层 worker 工作；R9 仅解决 bytes 与 intent 的 durability；
- terminal staged files 需要日后在有 retention/reference contract 后安全回收，R9 不做容易删错恢复证据的 GC；
- main/repository 仍是唯一 filesystem/SQLite owner，preload 不泄露 `ipcRenderer`、path、staging hash 或 database access。


## 实现证据（2026-09-22）

- schema v4 已在既有 project-private storage 下建立 `import_job_metadata` 与 `import-staging/sha256`；不存在第二个 queue database，也没有 renderer-selected staging path。
- journal draft 会剥离 runtime locator reference，result 从 safe draft + content hash 重建 managed asset；raw bytes 仅保留在 staging file 与最终 R4 blob tree。
- `AssetImportController` 把 stale running 转 queued 并以 insertion FIFO 恢复；close 是 interruption，explicit queued cancel 才是 `cancelled`。commit 已越过安全中断点时保留 completed，而不伪造 cancellation。
- `ProjectStorageController` 在项目打开时 restore 两类 scheduler；main/preload 只增加三个固定 import task API，并沿用 trusted renderer guard。
- 远端 `npm --prefix artflow run check` 已通过；foundation 覆盖 schema migration、staging redaction、reopen recovery、terminal read-back、close/cancel distinction 与 legacy direct import compatibility。

## ADR-018 窄化说明（2026-09-22）

ADR-018 已验证让 trusted renderer 读取 bounded safe snapshots；其不包含 `stagingHash`、staging path、draft/raw locator 或 raw bytes，R9 main/repository ownership 不变。
