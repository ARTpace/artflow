# FDD-029：Phase P1 —— 内置 EPUB 纯文本阅读器插件

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R29
- **关联**：FDD-026（TXT/HTML ReaderCard）、FDD-027（bounded archive normalization）、插件系统设计 §3 / §11、插件化迁移清单 P1 漫画/小说格式

## 1. 背景与目标

R26 已交付 bounded TXT/HTML ReaderCard，R27 已证明受限 ZIP 容器可以由 format plugin 独立处理，但用户仍不能直接拖入常见电子书 `.epub` 文件阅读。EPUB 是 ZIP/OCF 容器；把它直接当作普通 ZIP 会失去书脊顺序和正文，直接引入完整 web-layout engine 又会超出当前 renderer、存储与资源边界。

R29 将 `builtin.formats-book` 扩展为真实、受限的 EPUB 文本阅读纵切：用户拖入一个小型、未加密 EPUB，插件读取 OCF `container.xml`、OPF manifest/spine 与受支持 XHTML/HTML 章节，按 spine 顺序归一化为 React-text-safe plain text，并复用该插件已经拥有的 ReaderCard。用户可在画布中滚动阅读整本小书；内容不会执行原始 HTML、访问网络或保留 archive。

## 2. Ponytail 七步决策

1. **需要性**：需要。EPUB 是 P1 既定小说格式路线中最具用户价值且可在现有 reader/archive 机制上完成的下一条真实阅读路径。
2. **现有能力**：已有 `builtin.formats-book`、generic `reader` result/data materialization、plugin-owned ReaderCard、`fflate@0.8.3`、`TextDecoder`，以及 R26 的 safe plain-text normalization。无需新增 card host、storage、IPC 或 package。
3. **标准库**：TypeScript/JavaScript 无 ZIP/EPUB parser；不能手写 DEFLATE。沿用已锁定的 `fflate`，并复用 R26 的 text normalization，而不是引入 `epub.js` 或完整 layout engine。
4. **平台特性**：renderer `File.arrayBuffer()`、TypedArray、`TextDecoder`；不渲染 source HTML，不需要 webview、Electron/main/preload/IPC 或 Worker host。
5. **已安装依赖**：使用已存在且锁定的 MIT `fflate@0.8.3` async `unzip` + filter；不改变 package.json/lockfile。
6. **一行方案**：不成立。安全处理至少需要 archive admission、OCF rootfile/OPF spine parsing、安全 href resolution、XHTML→plain text normalization、total output bound 和 existing Reader result bridge。
7. **最小实现**：只支持普通、未加密 EPUB 的 common OCF/OPF spine；只输出一个 bounded plain-text ReaderCard。不做 CSS/layout、字体/图片/音频、interactive HTML、TOC UI、章节页签、DRM、progress/annotation/search 或 generic ZIP。

## 3. 用户路径

1. 用户从现有 file picker、drag/drop 或 clipboard file 路径导入 `.epub`。
2. `builtin.formats-book` extension-only handler 接管 `.epub`，拒绝超限 archive，并只解压 EPUB 的 text/package entries。
3. parser 在 `META-INF/container.xml` 找 OPF rootfile，读取 manifest + spine，按 spine 顺序提取受支持 XHTML/HTML，清除 markup/script/style 后拼成 bounded plain text。
4. generic importer 只创建现有 `ReaderElement`，正常布局/选中；它不知道 EPUB、ZIP、OPF、`fflate` 或 ReaderCard JSX。
5. 已有 ReaderCard 显示 `EPUB → text`、书籍 metadata title 和可滚动正文。项目普通 v2 Save/load、操作历史继续保存纯文本，不保存原 EPUB。

## 4. 冻结边界与资源契约

| Guard | Bound | Behavior |
|---|---:|---|
| EPUB compressed source | 16 MiB | reject before/after ArrayBuffer read |
| archive entries | 160 | reject; includes metadata/assets to bound directory work |
| accepted package/text entries | 64 | reject |
| accepted entry uncompressed bytes | 512 KiB | reject |
| accepted text/package total | 4 MiB | reject |
| OPF spine chapters | 32 | reject |
| normalized Reader output | 120,000 Unicode code points | existing ReaderCard truncation flag; never unbounded project text |
| manifest declared budget | 1 concurrent job / 32 MiB | renderer declaration; admission bounds are primary guard |

- `.epub` matches by **extension only**; generic `.zip` retains the existing FileCard route even if a browser gives it an EPUB-looking MIME type.
- Accepted archive files are limited to `META-INF/container.xml`, OPF package documents and XHTML/HTML chapter candidates. Images, fonts, audio, CSS, scripts and every other entry remain compressed/unread.
- Archive path normalization rejects absolute paths, `.` / `..` traversal, duplicate normalized package paths and unsafe/non-local manifest hrefs.
- Missing/malformed container, OPF, manifest, spine, referenced chapter, encrypted/unsupported ZIP data or no readable chapter is a rejection, not a fallback to arbitrary archive contents.
- Source markup is stripped to text before it enters an Element. It is never assigned to `innerHTML`, rendered as rich XHTML, fetched remotely or written as an archive/file reference.

## 5. Plugin/core ownership

| Layer | Owns | Must not own |
|---|---|---|
| `builtin/formats-book/epubParser.ts` | `fflate`, OCF/OPF parsing, safe local href/path resolution, bounds, spine assembly | App/importer/CanvasElement JSX, storage/IPC |
| `builtin/formats-book/index.ts` + ReaderCard | `.epub` handler registration, source-format dispatch and `EPUB → text` presentation | generic ZIP, unrelated host business |
| core contracts/importer | additive generic `reader.sourceFormat` data value and pre-existing reader materialization/layout | ZIP/EPUB/OPF/fflate/parser/card-specific cases |

`fflate` remains a trusted format-plugin dependency. R29 reuses the already exact-locked dependency in `formats-book`; no new package is admitted.

## 6. Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-1 | A valid small EPUB imports through existing normal UI paths into a ReaderCard whose title comes from metadata when present and whose chapter text follows OPF spine order. |
| AC-2 | XHTML/HTML becomes plain React text; scripts/styles/comments/markup do not execute or survive as renderable markup. `.zip` remains generic FileCard. |
| AC-3 | Source/entry/text/chapter/output bounds, malformed/missing OCF/OPF/spine/reference and unsafe path cases are deterministic and fail closed; output is normal v2/history-safe ReaderElement data. |
| AC-4 | ZIP/EPUB/OPF/fflate and ReaderCard business stay in `builtin.formats-book`; generic host files do not name EPUB parser, OCF/OPF or `fflate`, and CanvasElement gets no reader case. |
| AC-5 | No new dependency, Project Document/schema, storage/IPC/preload capability, Worker host, generic ZIP route or runtime profile expansion. Foundation binary archive fixture, remote typecheck, production full check and exact read-back pass. |

## 7. Validation plan

1. Build a binary EPUB fixture with `container.xml`, OPF metadata/manifest/spine, chapters deliberately named out of order, ignored assets and unsafe markup. Assert spine order, title, text safety and source format.
2. Assert reject behavior for no container/rootfile/spine/chapter, source size, archive entry count, accepted entry count/per-entry/total bytes, chapter count, duplicate/path traversal and generic ZIP non-match.
3. Load the actual formats-book plugin, parse the fixture through registry dispatch, confirm ReaderCard materialization and reverse disposal; persist an EPUB reader through normal v2/history fixture.
4. Static source checks confirm parser/card/plugin ownership, no EPUB/fflate/OPF leaking into generic host, no new package/IPC/schema/Worker path, and `ReaderCanvasCard` labels EPUB text.
5. Run remote `typecheck`, `check:foundations`, full `check`, then exact read-back source/governance/package files.

## 8. Non-goals

- No visual EPUB layout/CSS/fonts/images/fixed-layout pages, TOC/chapter chooser, pagination, external links, JavaScript, media overlays, DRM, EPUB 3 scripting or arbitrary XML support.
- No CBR/CB7/EPUB archive store, lazy extraction/cache, progress/annotation/bookmark/search/index or durable original file ownership.
- No MIME-only claim, generic ZIP handling, new native capability, npm package, generic XML framework or ReaderCard host rewrite.

## 9. Remaining boundary

R29 is a bounded plain-text EPUB reader, not an ebook engine. Rich/paginated/lazy EPUB and all durable/larger archive requirements must first receive their own asset-store/resource lifecycle ADR.

## 10. 实现与验证记录（2026-09-22）

- 已在同一个 manifest-loaded `builtin.formats-book` 中新增 `epubParser.ts`：只读取 OCF `container.xml`、OPF 与 XHTML/HTML candidates；`fflate@0.8.3` 的 async filter 在解压前限制 package entry，并对实际解压字节再次核验。
- `.epub` 保持 extension-only dispatch；OPF metadata title、spine order、unsafe markup stripping、path/href / duplicate-path / missing-reference fail-closed behavior 都由插件本地拥有。普通 `.zip`（包括 EPUB-looking MIME）仍无 book handler。
- core 只将 `ReaderElement` / `FormatReaderResult` 的 `sourceFormat` 扩为 `'epub'`，`useFileHandlers` 改为引用 generic result type；ReaderCard、ZIP/OCF/OPF/fflate 业务未进入 importer 或 CanvasElement。持久化验证确认只保存 bounded text，未保存 archive / source URL。
- `check:foundations` 动态构造真实二进制 EPUB fixture，覆盖 metadata、out-of-order filename 与 spine order、asset ignore、unsafe markup、archive/path/entry/text/chapter bounds、duplicate package path、registry activation/materialization/disposal、v2/history round-trip 和 host ownership assertions。
- 远端 `npm --prefix artflow run typecheck`、`npm --prefix artflow run check:foundations`、`npm --prefix artflow run check` 均 exit 0；production build 仅保留既有大 chunk 提示。`package.json` / lockfile 无变化，`fflate` 仍为唯一锁定的 `0.8.3`。
- selected source、Foundation、FDD/ADR 和四份治理文档已由 MCP canonical read-back 逐字节 SHA-256 比对确认。
