# ADR-004：内容寻址资产库与 SQLite Metadata 的最小边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-004-Phase2本地资产库最小存储契约.md`

## 背景

R3 已将 `AssetRecord` 与 `BoardNodeRecord` 从 persisted document 分离，但 locator 仍可能是 data URL、blob URL 或外部 URL。项目缺少二进制所有权、dedupe、metadata database 与 crash-safe repository boundary。

## 决策

建立 Node-side `ProjectRepository`：

```text
<project root>/.artflow/
  ├─ metadata.sqlite       # SQLite: asset metadata + one v2 document snapshot
  └─ blobs/sha256/ab/<hash># immutable content-addressed original bytes
```

- blob key = original byte sequence 的 lower-case SHA-256；
- SQLite asset row 保留 v2 logical `assetId` 与 content hash 的映射；多个 asset id 可指向同一 blob；
- managed locator 固定为 `artflow-asset://sha256/<hash>`；不得持久化绝对本机路径；
- repository 在 blob atomically materialized 后才写 metadata；
- v2 snapshot 只在所有 asset reference 都已被 managed store 接管时保存，且验证 node / node-operation 不含 asset locator property；
- 采用 Node 22 标准库 `node:sqlite`，不安装 `better-sqlite3` / `sqlite3` 等 native dependency；repository 不向 renderer 暴露。

## 已落地的位置

- `storage/projectRepository.cjs`：SQLite schema、hash materialization、metadata API、integrity validation、managed v2 snapshot；
- `types.ts`：`AssetSourceKind` 增加 `managed-store`；
- `utils/projectDocument.ts`：保留 `artflow-asset://sha256/` 的 managed source kind；
- `scripts/check-core-foundations.cjs`：storage lifecycle、dedupe、restart、boundary 与 tamper assertions；
- `package.json` / lock：Node engine floor `>=22.5.0`。

## 结果与边界

- R3 `ProjectDocumentV2` 仍是 document contract；R4 不重写 serialize / deserialize 或 renderer projection；
- `artflow-asset://` 是 storage locator，不是 browser URL；renderer resolution 留给独立受限 IPC / protocol FDD；
- `node:sqlite` 在当前 Node runtime 仍报告 experimental warning，故封装在唯一 storage module；未来若 Electron runtime 不支持它，只替换该 module，不改变 v2 / renderer 边界；
- orphan blob 可在 metadata failure 后遗留，GC / ref-count 属于后续轮次；
- 不支持自动把旧 data URL、blob URL 和外部 URL 转成 managed original；导入与迁移 pipeline 另立 FDD。

## 验证

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run check              # exit 0
```

self-check 已覆盖 SHA-256 dedupe、SQLite reopen、managed v2 snapshot、raw locator / node property rejection 与 tampered blob detection。
