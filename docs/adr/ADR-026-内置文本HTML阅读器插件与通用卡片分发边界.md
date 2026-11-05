# ADR-026：内置文本 / HTML 阅读器插件与通用卡片分发边界

- **状态**：accepted（verified）
- **日期**：2026-09-22
- **关联**：插件系统设计 §1/§3、FDD-007、ADR-025、FDD-026

## Context

The format handler contract already allows trusted builtin parsers, and canvas cards already materialize from `canvas_node_types`; however, CanvasElement still enumerates known card types. A book import that hardcodes a ReaderCard import/case into App or CanvasElement would contradict the plugin architecture. Existing text and HTML fallbacks do not provide a safe reader workflow.

## Decision

1. Add only an additive generic `reader` parse result and `ReaderElement` data type. The generic importer maps this result into ordinary Element/operation/v2 data without referring to a plugin id.
2. Change CanvasElement’s card rendering to use generic materialized-card fallback after its SVG/media primitives. No `reader` case and no ReaderCard import is permitted in core renderer code.
3. Create one trusted renderer builtin `builtin.formats-book`, with a v1 manifest declaring `format.handler` and `canvas.card`. Its activation registers both the TXT/HTML handler and ReaderCard contribution; disposer reverses both.
4. Parser and card own reader-specific behavior. Source is capped at 1 MiB, output at 120k Unicode code points; HTML is converted to plain text and rendered only as React text.

## Consequences

- The first P1 book vertical validates two contribution slots through one optional builtin plugin.
- Reader content behaves like normal project content and needs no second persistence owner.
- Future plugin card types no longer require a CanvasElement switch expansion, while primitives keep their existing optimized paths.
- Reader capability remains intentionally modest and safe; format fidelity/progress/search are not implied.

## Rejected alternatives

- **Put TXT/HTML logic into existing MarkdownCard/import fallback**: duplicates core business and cannot prove a plugin-owned card path.
- **Render source HTML**: creates an execution/sanitization surface inappropriate for the current trusted parser scope.
- **Implement EPUB/MOBI/CBZ now**: needs dependency, archive/DRM/memory and chapter lifecycle decisions beyond a minimum vertical slice.
- **Add a reader database/table/progress store**: creates storage ownership without evidence that project metadata is insufficient.

## Revisit triggers

Rich HTML, EPUB/MOBI/AZW3, comic archives, chapters/TOC, annotations/progress, full-text indexing, reading commands, external reader plugins or archival asset storage require a new FDD/ADR.


## Verification record

R26 implementation follows this decision: actual `builtin.formats-book` registers and disposes both slots, generic host files do not mention the plugin/card/parser, and its raw HTML is converted to text before React renders it. Remote `typecheck`, `check:foundations`, and the full production `check` passed on 2026-09-22. The Foundation fixture verifies bounded parser behavior, real plugin activation/disposal, generic renderer materialization, normal v2 persistence/operation history, and generic Finder labels.
