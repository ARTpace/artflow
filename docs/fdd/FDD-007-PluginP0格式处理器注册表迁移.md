# FDD-007：Plugin P0 —— `format_handlers` 注册表迁移

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-007-FormatHandler契约与分发边界.md`、`../插件系统设计.md`、`../插件化迁移清单.md`、`FDD-006-Phase2c后台PreviewDerivativeJobContract.md`

## 问题与成功标准

当前 `format_handlers` 插槽已存在，但 `hooks/useFileHandlers.ts` 仍直接 import / branch PSD、PDF、audio 与 image 解析；新格式若沿现状接入，会形成「一部分注册表、一部分中心 if/else」双轨。用户提供的插件设计明确要求内置格式走同一 manifest + contribution 通道。

本轮成功标准：builtin `formats-image-doc` 经 manifest/activate 注册 handler；renderer importer 按 registry 分发既有 PSD、PDF、audio 与 image family；同一扩展名的多个 handler 有确定顺序并可枚举候选；现有 fallback 不被移除。

## 决策阶梯

1. **是否需要**：需要。它是漫画/小说等新格式在不继续扩大中心 importer 前的前置契约。
2. **是否已有能力**：已有 `Kernel.contributions`、`format_handlers` slot、builtin loader、manifest、profile 与现有 parser utilities；本轮复用，不建第二套插件系统。
3. **标准库**：无可替代的浏览器格式解析标准库；只使用现有 TypeScript/JS 能力。
4. **平台特性**：继续在 renderer 接收用户选择的 `File`；不新开 filesystem/IPC/Worker capability。
5. **已有依赖**：复用已安装的 `ag-psd`、`pdfjs-dist`、`utif` 和现有 parser utilities；不新增包。
6. **一行方案**：仅把名称表放进常量无法替代 parse result、优先级分发与 disposer lifecycle。
7. **最小实现**：新增 typed `FormatHandler` contract + pure dispatcher + 一个 trusted builtin image/document plugin；把现有 handler-family 接入，保留尚未迁移类别的旧 fallback。

## 范围

- `plugins/format-handlers.ts` 作为 FormatHandler / ParseResult / PSD shared contract 和 registry dispatch 的唯一机制入口；
- `builtin/formats-image-doc/`（manifest + activate）注册 PSD、PDF、audio 与 image handler；image handler 覆盖现有 SVG、TIFF、TGA、EXR、RAW 及 browser-native image extension；
- `useFileHandlers` 先从 registry parse，再保留 video/text/font/model/file 等未迁移 fallback；PSD 的 existing modal / merged import 行为保持；
- contribution list 以 `priority DESC, id ASC` 稳定排序；暴露 candidate enumeration，供后续 settings 的冲突可见性使用；
- manifest 可选 `minHostVersion` 与最小 `definePlugin()` DX helper。

## 经核验的事实修正

附件迁移清单中称 TIFF/RAW/EXR/TGA「从未接线」。实际代码已通过 `formatDetector` + `readAndCompressImage` 的 generic image path 可达；R7 不重复造解析器，而是把这一已有行为正式收口到 handler registry，并保留 background-image fallback。

## 非目标

- 不实现漫画/小说、EPUB/CBZ、PanelHost、commands、AI provider、外部插件、用户 handler binding UI 或 sandbox；
- 不把 parser 移入 R6 worker、不实现 durable import queue、真实 media derivative 或 range streaming；
- 不删除未迁移的 legacy fallback，也不改变 R3 project document / R4-R6 storage ownership；
- 不增加 third-party dependency、动态 plugin directory 或 generic renderer capability。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | `formats-image-doc` 是 builtin manifest module，且 activate/dispose 后 `format_handlers` contribution 可逆 |
| AC-2 | PSD/PDF/audio/image family 经 registry dispatch；PSD modal/merged route 与 existing result shape 保持 |
| AC-3 | 多 handler 同扩展名按 priority DESC、id ASC 确定选择，候选可查询 |
| AC-4 | `PsdParseResult` 已从 parser implementation 移到 shared plugin contract；`minHostVersion` 非兼容时不会激活 plugin |
| AC-5 | video/text/font/model/file fallback 仍存在；没有新依赖、filesystem、IPC 或 Worker exposure |
| AC-6 | foundation、typecheck、production build 通过 |

## 实现与验证记录

- 新增 `plugins/format-handlers.ts`：shared `FormatHandler` / `FormatParseResult` / `PsdParseResult`、extension/MIME matching、candidate enumeration 与 pure selection；registry 的顺序为 `priority DESC, id ASC`。
- 新增 `builtin/formats-image-doc/` trusted builtin：PSD、PDF、audio 和 image family（含 SVG、TIFF、TGA、EXR、RAW 与 browser-native image extension）统一通过 `format_handlers` activation 注册；其 manifest 声明 `format.handler` 与 `minHostVersion: 1.0.0`。
- `useFileHandlers` 已先向 dispatcher 查询；单 PSD 保持现有 modal / merged import，multi-file PSD 保持 composite fallback；video/text/font/model/file 保留 legacy fallback。`formatDetector` 降为不 import parser 的 fallback classifier。
- `PsdParseResult` / layer shape 已定义在 shared plugin contract；`App.tsx` 与 `PsdImportModal` 改从契约 import，parser util 仅保留兼容 re-export。
- manifest v1 已接受可选 `minHostVersion`，loader 对不兼容 builtin 单独 skip + warning；同时新增最小 `definePlugin()` authoring helper。
- 2026-09-22 远端验证：`npm --prefix artflow run check` exit 0。foundation 覆盖 actual manifest registration static proof、generic activation/disposal、parser dispatch、priority/id tie-break、candidate visibility、incompatible-host skip、legacy import branch removal、type/build gate。

## 保留边界

本轮不是 parser Worker 化或 durable import。没有 user extension→handler binding UI、conflict settings panel、comic/book、PanelHost、external plugin、sandbox、permissions、template directory 或 dynamic parser chunk；这些仍按 Plugin P1–P4 与 durable import FDD 分段推进。
