# FDD-027：Phase P1 —— 内置 CBZ 漫画阅读器插件

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R27
- **关联**：FDD-007（format handler）、FDD-026（Reader vertical）、插件系统设计 §1 / §3 / §5、插件化迁移清单 P1 漫画/小说格式

## 1. 背景与目标

R26 已把文本小说的 parser → normalized content → plugin card 走通，但 P1 漫画格式仍没有用户可直接导入、翻页阅读的纵切。现有 PDF handler 会铺开每页图像，而普通 `.zip` 是未知档案 FileCard；二者都不是漫画阅读工作流。`CBZ` 是 ZIP 容器的漫画约定，适合作为无需 RAR/7Z/WASM 的最小、真实 P1 漫画入口。

R27 交付 `builtin/formats-comic`：同一个 manifest trusted builtin 注册 `.cbz` format handler 与 `comic` canvas card。用户拖入小型 CBZ 后，即可在画布中看封面、前后翻页和页码。解析、排序、页面 data URL 编码与 ComicCard 都属于 plugin；本体只添加 additive `comic` result/data materialization seam，复用 R26 已验证的 generic card lookup。

## 2. Ponytail 七步决策

1. **需要性**：需要。漫画/图片序列是 P1 路线明确、与 R26 文本阅读互补的用户可见格式能力。
2. **已有能力**：复用 `format_handlers`、manifest/loader/profile、`canvas_node_types`、generic importer、Canvas materialization、operation history、Project Document v2；不复用 PDF 的“拆成图片”语义。
3. **标准库**：浏览器无 ZIP container parser；`CompressionStream` 也不支持 ZIP directory/container。
4. **平台特性**：renderer 的 `File.arrayBuffer()`、TypedArray、`btoa`；无 Electron/main/preload/IPC。
5. **依赖**：加入 MIT `fflate@0.8.3`，仅使用 tree-shakeable async `unzip` + ZIP filter。它避免手写压缩格式，并能只解压允许的页面文件。
6. **一行方案**：不成立。CBZ 需要 archive bounds、allowed image filter、natural page order、data URI normalization、generic importer bridge 与 plugin UI。
7. **最小实现**：只支持 `.cbz`，只接受 JPG/JPEG/PNG/WEBP/GIF/AVIF 页面；一个有界 ComicCard；不支持 generic ZIP、CBR/CB7/PDF/EPUB。

## 3. 用户工作流

1. 用户从现有 file picker 或拖放路径放入一个 `.cbz`。
2. `builtin.formats-comic` 检查 archive byte size，并异步解压受支持的图像页；页名按 numeric-aware natural order 排序。
3. handler 输出 generic `comic` result；importer 只创建 `ComicElement`、布局并选中，不知道 plugin id、ZIP 或 `fflate`。
4. materialized `ComicCanvasCard` 显示当前页，用户点击 Previous / Next 或页码按钮翻页；每次翻页仅为 card-local UI state，不写 Element。
5. 已归一化的 page data URLs 和普通 element metadata 通过 existing operation history / Project Document v2 / Save 路径保存并恢复。

## 4. 契约与资源上限

```ts
interface FormatComicResult {
  kind: 'comic';
  title: string;
  pages: readonly string[]; // bounded image data URLs only
  sourceFormat: 'cbz';
}
```

| Guard | Frozen limit | 行为 |
|---|---:|---|
| CBZ compressed source | 16 MiB | 拒绝，不读取/解压 |
| archive entries | 96 | 超出拒绝，避免 metadata-entry CPU/目录爆炸 |
| supported image pages | 24 | 超出拒绝，不导入部分漫画 |
| one page declared/extracted bytes | 2 MiB | 拒绝 |
| total extracted supported page bytes | 12 MiB | 拒绝 |
| archive page types | jpg/jpeg/png/webp/gif/avif | 其余 entry 不解压；没有支持页则拒绝 |
| manifest resource budget | 1 concurrent job / 96 MiB | declared renderer budget; bounds remain the primary admission gate |

- `.zip` 继续走 existing archive FileCard；R27 不抢占泛用 archive 语义。
- Archive is never written to disk; pages use bounded `data:` URLs so v2 Save can persist them. No object URL lifetime, source-file reference or hidden second storage owner is introduced.
- `fflate` filter and async unzip are plugin-local. The host does not import `fflate` or identify a comic archive.
- Card renders the selected page only, via `<img>` data URI. No arbitrary HTML/SVG, remote fetch, PDF renderer, archive extract path or filesystem write occurs.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Drop/select a valid bounded `.cbz` creates plugin-owned ComicCard with natural page order and direct previous/next navigation. |
| AC-2 | Parser rejects oversize archives/pages/count/total, ignores non-image metadata entries, rejects missing pages and malformed archive; no partial comic import. |
| AC-3 | Comic normalized data has normal immutable history + v2 Save/load behavior; page navigation does not mutate Element data. |
| AC-4 | `builtin.formats-comic` owns `fflate`, archive parsing and JSX; App/importer/CanvasElement do not mention CBZ/fflate/ComicCanvasCard or add `case 'comic'`. Generic `.zip` fallback remains unchanged. |
| AC-5 | Exact dependency lock, Foundation binary fixture, remote typecheck, production full check and exact read-back pass; no IPC, schema version, new plugin capability, Worker host, generic ZIP or durable asset-store widening. |

## 6. 明确不做

- 不做 `.zip` generic import、CBR/RAR、CB7/7Z、PDF comic conversion、EPUB/MOBI/AZW3、folder/multi-file sequence import、nested archives、encrypted archives、SVG/TIFF/RAW pages、archive password、chapter/reading progress/bookmarks/annotations/search/thumbnails/OCR。
- 不做 streaming/lazy page extraction、page asset deduplication、managed original archive storage、page image resampling/optimization、background Worker host、external/restricted plugin or plugin settings.
- 不改 existing PDF/image handlers、generic archive FileCard、R26 ReaderCard、Project Document version、SQLite/main/preload/IPC。

## 7. 风险与回退

- This is intentionally a bounded small-CBZ reader; ordinary large comics may be rejected rather than silently exhausting memory or producing an incomplete project.
- Page data URLs favor normal Save/load over source archive retention. A scalable/lazy comic pipeline needs a separate asset-store/Worker ADR.
- `fflate` is the sole new MIT dependency and is confined to this plugin. Removing the plugin removes both handler/card; no core comic business persists.

## 8. 完成边界

R27 delivers only a bounded CBZ page reader. Generic ZIP, CBR/CB7, large/lazy archive pipelines, comic metadata/chapters, annotations/progress, thumbnails and all other book/comic formats remain separately scoped.


## 9. R27 实施与验证记录（verified）

- 新增 `builtin/formats-comic/manifest.json`、`comicParser.ts`、`ComicCanvasCard.tsx`、`index.ts`。同一个 trusted builtin activates `builtin.format-cbz-comic` and `builtin.card-comic`, and reverse-disposes both contributions.
- `fflate` is locked as the single new MIT runtime dependency at **0.8.3** (`package.json` + `package-lock.json` integrity record). The parser uses its async `unzip` filter only; `.cbz` extension matching intentionally has no MIME fallback, so every generic `.zip` stays on the existing FileCard path.
- Core changes are additive generic `FormatComicResult` / `ComicElement` and generic importer materialization. The importer and CanvasElement do not name CBZ, `fflate`, parser or card JSX; R26 materialized-card fallback renders the contribution.
- Foundation uses a real binary ZIP fixture (`zipSync`) to validate natural page ordering, metadata filtering, no-page/malformed archive rejection, source cap, entry cap, page-count cap, per-page and total-page caps, real plugin activation/disposal, generic ZIP non-match, card materialization, v2 persistence and immutable operation redo/undo.
- 2026-09-22 remote commands (all exit 0): `npm --prefix artflow run typecheck`; `npm --prefix artflow run check:foundations`; `npm --prefix artflow run check` (production Vite build included). Build reports only the pre-existing >500 kB chunk-size advisory and Node `node:sqlite` experimental warning.
