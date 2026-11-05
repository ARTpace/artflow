# ADR-027：CBZ 漫画阅读器插件与有界归一化边界

- **状态**：accepted（verified）
- **日期**：2026-09-22
- **关联**：FDD-027、FDD-026、插件系统设计 §1 / §3 / §5

## Context

P1 requires an actual comic vertical. Browser APIs do not parse ZIP containers, and treating every `.zip` as a comic would break the existing generic archive FileCard. Persisting blob URLs would not survive normal Project Document Save/load, while unbounded ZIP expansion or full source archive ownership would violate current memory/storage boundaries.

## Decision

1. Add only additive `comic` FormatParseResult / ComicElement data contracts and generic importer materialization. Reuse CanvasElement’s R26 generic card fallback; core receives no CBZ parser, `fflate` import, ComicCard JSX or `case 'comic'`.
2. Add one renderer trusted builtin plugin `builtin.formats-comic` with `format.handler` + `canvas.card`. It owns `fflate@0.8.3`, archive filtering, page sorting, data URI encoding and ComicCard local navigation.
3. Match only `.cbz`, not `.zip`; this preserves generic archive fallback semantics. Accept only browser-displayable raster page extensions and reject, rather than truncate, any archive beyond FDD fixed source/page/count/total limits.
4. Normalize accepted pages to bounded data URIs stored in ordinary ComicElement properties. This gives normal v2 persistence at the explicit cost of excluding large/lazy comics. UI page state stays local.

## Consequences

- Users gain a concrete comic import/read workflow without a host-specific archive service.
- `fflate` is a narrow, auditable plugin dependency; Vite can tree-shake to the decompression path.
- Input guardrails preserve the current renderer and project JSON bounds but deliberately reject many real-world large CBZ files.
- Future generic ZIP or scalable comic support must make its archive/storage/lifecycle policy explicit rather than inheriting accidental behavior.

## Rejected alternatives

- **Put CBZ parsing in `useFileHandlers` or `CanvasElement`**: violates format/card contribution boundaries.
- **Treat all ZIP as comics**: hijacks ordinary archive import and has no user binding/inspection policy.
- **Use blob URLs**: loses page data after save/reload and introduces revoke/lifetime coordination.
- **Hand-write ZIP/decompression code**: unnecessary risk when a small maintained dependency exists.
- **Support CBR/CB7/PDF now**: adds RAR/7Z/PDF resource and dependency constraints outside the minimal vertical.
- **Store original CBZ in SQLite first**: expands durable asset ownership before a scalable comic requirement is validated.

## Revisit triggers

Generic ZIP association, CBR/CB7, PDF comics, large/lazy page extraction, thumbnails, memory backpressure, managed source archives, progress/bookmarks/annotations/search or external comic plugins require a new FDD/ADR.


## Verification record

R27 implementation follows this decision: the actual builtin plugin alone imports `fflate`, matches only `.cbz`, registers/disposes both format/card contributions, and normalizes accepted pages to data URIs. Generic host files do not identify archive mechanics or ComicCard JSX. The real ZIP Foundation fixture proves all frozen archive limits, filter/order behavior, generic ZIP non-match, v2/history behavior and registry teardown. Remote `typecheck`, `check:foundations`, and the full production `check` passed on 2026-09-22.
