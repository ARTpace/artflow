# ADR-024：Element 标签元数据与现有 v2 操作持久化边界

- **状态**：accepted（verified）
- **日期**：2026-09-22
- **关联**：ADR-002、ADR-003、ADR-022

## Context

Element properties already flow through immutable commit operations and v2 node `properties`, while R22 Finder offers a bounded live current-board lookup. Tags should provide user organization without creating a second saved-query or tag-storage owner. Any free-form label must be bounded/sanitized before it enters operation history or persisted JSON.

## Decision

1. Add optional `tags?: string[]` to Element base and one pure normalizer (`elementTags.ts`): at most 12 canonical lowercase tags, each trim/collapsed, leading-# stripped, max 24 Unicode characters, unique and nonempty.
2. Tag editor is a renderer selection surface opened by TopBar. It maps tags through existing `commitAction`; add/remove is a regular element operation, while editor/query/selection UI state is ephemeral.
3. Project Document v2 generic node property conversion sanitizes tags on serialization and v2/legacy ingress. Version stays 2; no SQLite table/migration is created.
4. R22 Finder reads normalized element tags into its bounded result projection/search and renders no more than three chips per result. It does not become a global tag index.

## Verification

- 2026-09-22 remote `typecheck`、`check:foundations` and production full `check` all exited 0.
- Foundations cover bounded canonical tags, operation redo/undo, v2/legacy sanitization, Finder projection/search, and static renderer-only/no-capability-widening wiring.
- Closing remote read-back matched the R24 source and governance set exactly.

## Consequences

- Users can classify and retrieve selected cards using portable project metadata and existing undo/redo.
- Old projects without tags and malformed tags remain safe; tag data cannot create unbounded payloads.
- The fixed renderer-only implementation deliberately does not provide global query or shared taxonomy semantics.

## Rejected alternatives

- **SQLite/global tag registry**：would create storage ownership and vocabulary lifecycle beyond local card metadata.
- **Tag edits outside operation history**：would violate normal content undo/redo expectations.
- **Use R12/R13 saved spatial query as tag search**：those readers target managed saved snapshot viewport geometry, not live Element metadata.
- **On-canvas tag chips immediately**：risks hot-path DOM/budget expansion; Finder/editor prove the metadata workflow first.

## Revisit triggers

Need global catalog/search, hierarchy/color, rename/merge, full-text index/Worker, card chip rendering, analytics, collaboration or sync only under a new FDD/ADR defining storage and performance ownership.
