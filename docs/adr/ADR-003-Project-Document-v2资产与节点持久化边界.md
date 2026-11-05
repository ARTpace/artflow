# ADR-003：Project Document v2 的 Asset / BoardNode 持久化边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-003-Phase1b项目文档v2.md`

## 背景

原保存格式直接 JSON 化 `Board[]`；每一个 `Element` 同时携带布局、媒体 locator、预览和卡片属性。R2 已消除全量历史快照，但保存文件仍没有 Asset 与 Node 的独立边界。

## 决策

新增 `artflow-project` v2 document：

```text
ProjectDocumentV2
  ├─ format: 'artflow-project'
  ├─ version: 2
  ├─ assets: AssetRecord[]
  ├─ boards: ProjectBoardRecord[]
  └─ nodes: BoardNodeRecord[]
```

- `AssetRecord` 保存媒体 locator、MIME、extension、大小和派生 / 原始引用；
- `BoardNodeRecord` 保存 board layout、node type、parent、z order、properties 与 `assetId`；
- 现有 `Element[]` 仅作为 renderer compatibility projection；
- `CanvasOperation` 在持久化时映射为 Node operation，operation node 不能重新把资产 locator 装回 property；
- 打开时识别 legacy `Board[]` 与 v2 document；legacy 先复用 R2 history migration，然后作为 runtime board 投影；
- 保存时一律输出 v2。

## 已落地的位置

- `types.ts`：persisted contracts 与可选 runtime `assetId`；
- `utils/projectDocument.ts`：纯 serialize / deserialize、asset registry 与 renderer hydration；
- `hooks/useFileSystem.ts`：所有 write path 输出 v2；
- `hooks/useCanvasState.ts`：唯一 renderer ingress 接受 v2 或 legacy；
- `scripts/check-core-foundations.cjs`：v2 / legacy / operation boundary assertions。

## 边界与非目标

- locator 仍是现有 data URL / blob URL / 外部 URL 的 schema bridge，不是 blob store；
- 不在本轮引入 SQLite、hash、content-addressed store、Worker、IPC 或运行时 Asset cache；
- 不改变 React renderer 的 `Element[]` 输入，避免把持久化迁移和 renderer rewrite 混在一次变更中；
- asset dedupe 只限同次 serialize 的相同 locator，不承诺跨项目内容哈希去重。

## 后果

下一轮可在不重写 save/load format 或 renderer projection 的前提下，把 `AssetRecord` 接到 SQLite / blob repository。Renderer 再在独立 FDD 中逐步改为按 `assetId` 解析，而不是从 element 读取 data URL。

## 验证

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run check              # exit 0
```

self-check 已覆盖 top-level v2 contract、六种 asset-backed node 的 locator boundary、node operation boundary、v2 round-trip 与 legacy `Board[]` re-save。
