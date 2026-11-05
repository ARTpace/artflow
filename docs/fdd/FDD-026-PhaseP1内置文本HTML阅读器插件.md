# FDD-026：Phase P1 —— 内置文本 / HTML 阅读器插件

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R26
- **关联**：插件系统设计 §1 原则 1/2/7、§3 `format_handlers` / `canvas_node_types`、P1 格式路线；FDD-007（format handler）、FDD-025（PanelHost）

## 1. 背景与目标

当前 `.txt` 会落为本体 Markdown 卡片，`.html` 会被当作 code；用户不能把轻量文本资料作为阅读内容导入，也没有一个真实插件同时验证 **format handler → normalized data → plugin card** 的端到端链路。插件迁移清单的 P1 已规划 `builtin/formats-book/` 与 ReaderCard，但 EPUB/MOBI/AZW3 需要额外依赖、解析器和内存治理，不能与首个纵切混为一轮。

R26 交付 `builtin/formats-book`：它以同一个 manifest builtin plugin 注册 `.txt` / `.text` / `.html` / `.htm` format handler 和 `reader` canvas card。用户拖入这些文件即可得到可滚动、可调字体大小的 Reader card；HTML 只提取受限纯文本，绝不执行 markup/script。功能主体（parser、card、registration）属于 plugin；本体只扩展稳定的 generic result/data/card dispatch seam。

## 2. Ponytail 七步决策

1. **需要性**：需要。文本资料是无限参考画布的直接内容形态，且是 P1 book plugin 最小可用、用户可发现入口。
2. **已有能力**：复用 `format_handlers` priority dispatch、builtin manifest/loader/profile、`canvas_node_types` materialization、existing import layout、operation history、Project Document v2 generic properties。
3. **标准库**：使用 `File.text()`、React、现有 CSS tokens；不引入 EPUB/archive/WASM/parser dependency。
4. **平台特性**：只在 renderer；无 Electron/main/preload/IPC。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要安全、可测的 text/HTML normalization、bounded input/result、format result contract、generic importer bridge 和 plugin-owned card。
7. **最小实现**：新增 `reader` result/Element contract、generic materialized-card fallback、`builtin/formats-book` parser + card + manifest；只支持 TXT/TEXT/HTML/HTM。

## 3. 用户工作流

1. 用户拖入或选择 `.txt`、`.text`、`.html`、`.htm` 文件。
2. `builtin.formats-book` handler 优先匹配，拒绝超过 **1 MiB** 的 source；HTML 删除 script/style/markup 后变成纯文本。
3. existing importer 仅依据 generic `reader` result 创建 `reader` Element、正常选择和布局；它不检查 plugin id。
4. `ReaderCanvasCard` 由 `canvas_node_types` registry materialize，显示标题、来源、字符数、截断提示、滚动阅读区和本地字体大小控制。
5. Reader content 通过 existing operation history / Project Document v2 / normal Save 持久化；UI scroll/font state 不进入 document、selection、undo/redo 或 Save。

## 4. 契约与约束

```ts
interface FormatReaderResult {
  kind: 'reader';
  title: string;
  content: string;
  sourceFormat: 'text' | 'html';
  characterCount: number;
  isTruncated: boolean;
}

// Trusted builtin contributes both types under one manifest.
ctx.contributions.register('format_handlers', { id: 'builtin.format-book-reader', ... });
ctx.contributions.register('canvas_node_types', { id: 'builtin.card-reader', value: { nodeType: 'reader', component } });
```

- Source size cap: **1 MiB**; normalized persisted content cap: **120,000 Unicode code points**. Truncation must be visible on the card.
- HTML is treated as untrusted source text: no `dangerouslySetInnerHTML`, no embedded resource loading, no script/style/content execution, no iframe/link navigation.
- Existing `.md` stays Markdown card; existing code extensions stay Code card; unsupported book formats remain existing File fallback.
- CanvasElement must use generic materialized-card fallback for plugin-owned card types; it must not add a `case 'reader'` business branch.
- `reader` is plain Element metadata, non-asset-backed, Project Document stays version 2. No reader registry, per-book persistence, reading-progress sync or storage ownership is added.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | TXT/TEXT/HTML/HTM import produces plugin-owned Reader card through format handler and card slots; MD/Code legacy paths remain unchanged. |
| AC-2 | Parser handles whitespace/entity/HTML sanitization safely, has 1 MiB / 120k bounds and visible truncation, and has no executable HTML surface. |
| AC-3 | Reader content round-trips through normal operation/v2 Save/load; local scrolling/font controls do not mutate Element content. |
| AC-4 | App/importer/CanvasElement contain only generic `reader` contract/card dispatch, not `builtin.formats-book` or reader component business; plugin has a manifest with `format.handler` + `canvas.card`. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/governance read-back pass; no dependency/IPC/schema-version/capability widening. |

## 6. 明确不做

- 不做 EPUB, MOBI, AZW3, PDF book reader, CBZ/CBR/RAR/7Z, archive/WASM parser, chapters/index/TOC, page turns, full-text search, annotations/highlights, bookmarks/reading progress, edit/save back to source, OCR/AI summaries or network fetching.
- 不做 reader-specific panel, commands, toolbar, dock layout, external/restricted plugin, config/profile persistence or new storage.
- 不迁移 existing Markdown/Code card implementation、不改 asset import/storage、Project Document version、SQLite/main/preload/IPC/Worker。

## 7. 风险与回退

- Reader content is intentionally bounded plain metadata; large/complex ebooks stay File cards until a dedicated parser/storage decision.
- HTML fidelity is deliberately plain text for safety; a future rich reader needs a separate sanitized rendering security ADR.
- Disabling `builtin.formats-book` through a future profile path removes both handler/card contributions together; no core business becomes orphaned.

## 8. 完成边界

R26 establishes only the TXT/HTML ReaderCard vertical plugin. Comic/book archive parsing, ebook formats, annotations, reader persistence, commands and broader UI migration require separate FDD/ADR scopes.


## 9. R26 实施与验证记录（verified）

- 新增 `builtin/formats-book/manifest.json`、`bookParser.ts`、`ReaderCanvasCard.tsx`、`index.ts`。同一 trusted builtin 在 activation 时注册 `builtin.format-book-reader` 和 `builtin.card-reader`；dispose 逆序清理二者。
- 本体新增的是 generic `FormatReaderResult` / `ReaderElement`、generic importer translation 与 CanvasElement materialized-card fallback；`CanvasCardContribution` 迁至 `plugins/` shared contract，renderer no longer imports `builtin/cards` just for a type. Canvas Finder labels unknown/plugin node types generically, so Reader title remains discoverable without a core type-label case.
- Parser verification covers script/style/markup stripping、entity decode、empty content、Unicode code-point cap、1 MiB rejection；card source has no `dangerouslySetInnerHTML`、content mutation、storage/IPC path。Reader data round-trips normal v2 serialization and immutable operation redo/undo.
- 2026-09-22 remote commands (all exit 0): `npm --prefix artflow run typecheck`; `npm --prefix artflow run check:foundations`; `npm --prefix artflow run check` (includes production Vite build). Build only reports the pre-existing >500 kB chunk-size advisory and Node `node:sqlite` experimental warning.
