# FDD-004：Phase 2a —— SQLite Metadata + Content-addressed Asset Store

- **状态**：verified
- **完成日期**：2026-09-22
- **关联**：`ADR-004-内容寻址资产库与SQLite元数据边界.md`、`FDD-003-Phase1b项目文档v2.md`、`docs/实施迭代台账.md`

## 决策阶梯

1. **是否需要**：需要。R3 已分离 persisted Asset / Node，但 asset locator 仍可携带 data URL、blob URL 或外部 URL，尚无二进制所有权、dedupe 与可恢复 metadata。
2. **是否已有能力**：R3 的 `ProjectDocumentV2` / `AssetRecord` 是唯一 document seam，已复用；没有重复实现 schema split 或 renderer hydration。
3. **标准库**：使用 Node 22 `node:sqlite`、`node:crypto`、`node:fs/promises`；未引入 native SQLite npm dependency。
4. **平台特性**：实现仅为 Node-side repository；没有向 renderer 暴露 filesystem 或 generic IPC。
5. **已有依赖**：现有 Electron / Node runtime 足够；`package.json` 现声明 Node `>=22.5.0`。
6. **一行方案**：无法安全地在 JSON / React state 中实现 SHA-256 blob dedupe、SQLite metadata 与原子写入。
7. **最小实现**：一个 CJS `ProjectRepository`、一个受控 managed locator、既有 foundation self-check；暂不接入 UI。

## 已实现

- 新增 `storage/projectRepository.cjs`，在 `<project>/.artflow/` 创建：
  - `metadata.sqlite`：asset logical id → content hash、kind、字节数、MIME、extension、font format、original name、metadata、timestamps，及一个 v2 document snapshot；
  - `blobs/sha256/<前两位>/<hash>`：不可变 original byte sequence。
- `putAsset()` 对 `Buffer` / `Uint8Array` / `ArrayBuffer` 计算 lower-case SHA-256，原子 materialize blob，再写 SQLite metadata；相同 bytes、不同 asset id 共享一个 blob。
- `getAsset()`、`readAssetBytes()`、`readBlob()` 在读取时验证 sha256；损坏或丢失 blob 会抛出 `StorageIntegrityError`。
- Managed asset 统一返回 `artflow-asset://sha256/<64-hex>`，并将 `sourceKind` 扩展为 `managed-store`；`projectDocument` 重新 serialize hydrated managed locator 时会保持该 source kind。
- `saveProjectDocument()` 只接受全量由 repository 接管的 v2 document：asset metadata、canonical locator、byte size、node / node-operation 的 `assetId` 与无 locator property 均会被校验。
- 增加 Node engine floor `>=22.5.0`，并同步 `package-lock.json`；无新增 dependency。
- 在既有 `scripts/check-core-foundations.cjs` 中加入临时目录集成 self-check。

## 非目标 / 刻意保留的边界

- 不接入 React renderer、`useFileSystem`、preload、main IPC、utility process 或 Worker；
- `artflow-asset://` 不是浏览器可直接加载的 URL；未来必须通过受限 Electron protocol / IPC resolver 解析；
- 不建立 file picker / import queue / progress / cancellation / thumbnail / derivative pipeline；
- 不自动把旧 data URL、blob URL 或外部 URL 抽取为 managed original；
- 不实现 ref-count、GC、backup、external-reference mode、R-tree 或 runtime asset cache；metadata 失败后可能保留 orphan immutable blob，清理策略后置。

## 验收结果

| 编号 | 标准 | 实际证据 |
|---|---|---|
| AC-1 | 新目录创建 SQLite schema 与 blob root，无新增 npm dependency | foundation self-check 以 temp project root open repository；`package.json` 仅增加 Node engine |
| AC-2 | 同字节不同 asset id 只保存一个 SHA-256 blob，metadata 保留 logical id | self-check 断言首写 `blobCreated === true`、次写 `false` 且 hash 相同 |
| AC-3 | canonical managed reference 与 read-back hash verification | self-check 断言 `artflow-asset://sha256/<64-hex>`、read-back bytes、tamper 后 `StorageIntegrityError` |
| AC-4 | 只保存 fully managed v2 snapshot，reopen 后仍可 load | self-check 覆盖 raw source rejection、node property leakage rejection、close/reopen load |
| AC-5 | foundation、TypeScript、production build 通过 | `npm --prefix artflow run check` 于 2026-09-22 退出码 0 |

## 验证记录

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run typecheck          # exit 0
npm --prefix artflow run check              # exit 0
```

`node:sqlite` 在当前 Node 22 runtime 会输出 experimental warning；该风险已通过唯一 storage module 封装，不是验证失败。Vite 仍有既有约 2.68 MB minified chunk 的 >500 kB warning；也不是 R4 gate 失败。

## 下轮入口

R5 只能实现 **受限 Electron IPC / protocol resolver 与 managed-import bridge**：将 renderer bytes 受控交给 `ProjectRepository`、将 `artflow-asset://` 转成 renderer 可消费资源。不得重写 R3 v2 adapter 或 R4 SQLite/blob schema；开始前需建立新的 FDD / ADR。
