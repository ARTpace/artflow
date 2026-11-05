# FDD-003：Phase 1b —— Asset / BoardNode / Project Document v2

- **状态**：verified
- **完成日期**：2026-09-22
- **关联**：`ADR-003-Project-Document-v2资产与节点持久化边界.md`、`docs/实施迭代台账.md`

## 决策阶梯

1. **是否需要**：需要。保存格式仍把资产 locator 与画布布局混在 `Element` 内，阻碍后续 SQLite/blob store 迁移。
2. **是否已有能力**：R2 已有 JSON-compatible operation contract；`useFileSystem` 是唯一 save/open 边界，可复用。
3. **标准库**：使用原生 `JSON`、`Map` 与 TypeScript；不引入 schema / database package。
4. **平台特性**：继续使用现有 File System Access API 与 download fallback。
5. **已有依赖**：无需新增依赖。
6. **一行方案**：无法安全地同时保持 operation、asset reference、node layout 与 legacy load 兼容。
7. **最小实现**：只增加纯 document adapter 并在 `useFileSystem` / `useCanvasState` 接线；Renderer 继续接收 hydrated `Element[]`。

## 范围与已实现内容

- 在 `types.ts` 定义 `AssetRecord`、`BoardNodeRecord`、`NodeOperation`、`ProjectDocumentV2`；
- 在 `utils/projectDocument.ts` 定义纯 `serializeProjectDocument(boards)` / `deserializeProjectDocument(input)` 转换层；
- 对 image / video / audio / font / model3d / file，把 persisted locator、MIME、extension、file size、image original reference 从 node `properties` 移入 `AssetRecord`；node 只保留 `assetId`、layout、parent、z order 和非资产属性；
- 将 `CanvasOperation` 映射为 node operation，确保 operation node 也不会重新内嵌 asset locator；
- save 一律写出 `{ format: 'artflow-project', version: 2, assets, boards, nodes }`；
- open 可接受 legacy `Board[]` 与 v2；legacy history 仍由 R2 的 `migrateLegacyBoardHistory` 归一化；
- 只在 `useFileSystem`（write）和 `useCanvasState`（renderer ingress）接线；`App` 对无法解析的有效 JSON project 显示可读错误；
- 扩展既有 foundation self-check，覆盖六类 asset、v2 node/operation asset boundary、v2 hydration、undo index 与 legacy re-save。

## 非目标 / 刻意保留的边界

- 不迁移实际二进制到 blob store，不引入 content hash、SQLite、Worker、Electron IPC 或 runtime Asset cache；
- `AssetRecord.locator` 仍可能是 data URL、blob URL 或外部 URL，故本轮是 schema bridge，**不是** content-addressed blob store；
- 不重写 renderer runtime store 或 `Element[]` 消费面；
- 同次 serialize 的相同 locator 可复用 AssetRecord，但不承诺跨项目内容哈希去重；
- 既有 blob URL 的跨重启可恢复性不因本轮改变。

## 验收结果

| 编号 | 标准 | 实际证据 |
|---|---|---|
| AC-1 | save 输出 `format: 'artflow-project'`、`version: 2`、assets / boards / nodes | foundation self-check 断言 v2 top-level contract；`npm run check` 通过 |
| AC-2 | asset-backed node 与 node operation 不在 `properties` 中持有 locator / MIME / file size 等 asset payload | self-check 覆盖 image、video、audio、font、model3d、file 以及 operation image change |
| AC-3 | v2 serialize → deserialize 后元素、assetId、operation history 和 undo index 可恢复 | self-check 覆盖六类 asset projection、operation locator hydration、`operationHistoryIndex` |
| AC-4 | legacy `Board[]` 仍可打开，并在下一次 save 输出 v2 | self-check 调用 legacy deserialize 后重新 serialize 并断言 v2 version |
| AC-5 | TypeScript、production build 与 foundation self-check 通过 | `npm --prefix artflow run check` 于 2026-09-22 退出码 0 |

## 验证记录

```text
npm --prefix artflow run check:foundations  # exit 0
npm --prefix artflow run typecheck          # exit 0
npm --prefix artflow run check              # exit 0
```

`npm run check` 的 Vite production build 仍报告现有 2.68 MB minified chunk 大于 500 kB 的 warning；它不是本轮 gate 失败，也未在 R3 无边界拆包。下一轮从 `docs/实施迭代台账.md` 的 R4 storage contract 入口开始，不得重复实现 v2 adapter。
