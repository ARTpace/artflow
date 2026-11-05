# ADR-029：EPUB 有界纯文本阅读器插件边界

- **状态**：accepted（verified）
- **日期**：2026-09-22
- **关联**：FDD-029、FDD-026、FDD-027、插件系统设计 P1

## Context

EPUB is a ZIP/OCF package rather than a standalone text file. Treating it as generic ZIP breaks reader semantics, while a complete EPUB browser/layout engine would bring CSS, resource, pagination, media, scripting and lifecycle concerns that do not fit the current bounded ReaderCard or Project Document data path. The existing book plugin already owns plain-text normalization and its card; `fflate@0.8.3` is already installed for trusted bounded archive format plugins.

## Decision

1. Extend the existing trusted `builtin.formats-book` plugin, rather than adding a core EPUB pathway or a second competing reader plugin.
2. Match `.epub` by extension only. Use async `fflate` filtering with fixed source/directory/text-entry/text-byte/chapter bounds; ignore non-text resources and reject malformed/encrypted/over-limit inputs.
3. Parse only the narrow common OCF/OPF subset needed for `container.xml` rootfile, manifest and spine. Resolve only safe local paths and normalize the referenced XHTML/HTML into R26-style plain text.
4. Persist only generic bounded `ReaderElement` text plus `sourceFormat: 'epub'`; reuse the plugin-owned ReaderCard. No original archive, URL, blob lifetime, package DOM, rich XHTML or source reference persists.
5. Preserve the existing generic importer/card lookup. Core contracts may add the data union member, but host source must not identify ZIP/EPUB/OPF/fflate behavior.

## Consequences

- Users gain a real small-EPUB import/read workflow without a new dependency, storage owner or Electron capability.
- A common EPUB with conventional OCF/OPF XML and XHTML spine becomes readable, but nonstandard XML, DRM, fixed layout and resource-rich books are deliberately rejected or reduced to plain text.
- `fflate` is now reused by two trusted format plugins; this does not widen its visibility into App/importer/CanvasElement or external plugins.
- R26 ReaderCard's existing 120k-code-point truncation remains explicit UI behavior; archive/package admission itself rejects before unbounded text enters project state.

## Rejected alternatives

- **Use `epub.js` / a full web layout engine now**: adds a new dependency plus unbounded CSS/iframe/resource/page lifecycle policy without a scalable asset store or Worker plan.
- **Treat any `.zip` as an EPUB**: breaks generic archive semantics and has no valid OCF/OPF contract.
- **Persist the original EPUB/blob URL**: does not survive normal project reload and silently creates a second storage owner.
- **Put EPUB parsing in `useFileHandlers` or CanvasElement**: repeats the central business logic migration that format plugins exist to avoid.
- **Implement generic XML infrastructure**: is premature for one bounded OCF/OPF parser; the plugin accepts a documented constrained subset and rejects unsupported inputs.

## Verification record

2026-09-22：remote `typecheck`、`check:foundations` 与 full production `check` 均 exit 0。Foundation executes a binary OCF/OPF fixture through the actual plugin registry and validates bounds, unsafe/archive rejection, text-only persistence, contribution lifecycle and host ownership. Canonical source/governance/package read-back matched the staged SHA-256 set; package and lockfile remain unchanged with `fflate@0.8.3`.
