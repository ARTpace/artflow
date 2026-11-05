# FDD-024：Phase UX6 —— 画布卡片标签与查找

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R24
- **关联**：FDD-002 / ADR-002（operation journal）、FDD-003 / ADR-003（Project Document v2）、FDD-022 / ADR-022（current-board Canvas Finder）

## 1. 背景与目标

R22 Finder 可以按名称、文字和类型定位卡片，但用户无法给一批参考图、任务卡或素材赋予短的可重用分类。名称并不总适合承载“reference / approved / client-a”这类横切语义，且仅用 Finder 的类型 filter 无法表达用户的组织方式。

本轮提供 **persistent card tags**：用户选中一个或多个画布卡片后，从 TopBar 可见 Tags action 打开 Tag selected cards panel，添加或从所选卡片移除 bounded canonical tags；标签作为 Element metadata 经 existing operation history 与 Project Document v2 normal Save 持久化。R22 Finder 将标签纳入搜索并在结果中显示有限 tag chips。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。它为现有 visible Finder 增加用户自己的分类语义，能直接组织与重访大 Board 中的混合卡片。
2. **已有能力**：复用 `selectedElementIds`、existing `commitAction` / immutable element update / undo-redo、TopBar action、R22 Finder、Project Document v2 generic node properties 与 ordinary Save。
3. **标准库**：仅 React input/state、existing operation journal 和 pure TypeScript normalizer；不引入 tag service、database、router/state-store 或 search dependency。
4. **平台特性**：不需要 Electron/browser API。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要 bounded canonical normalization、multi-selection semantics、operation history, v2/legacy hydrate safety, finder projection 及 visible editor。
7. **最小实现**：增加 optional `Element.tags`、pure tags helper、TopBar selection action + editor、existing `commitAction` mutation、Project Document ingress/egress sanitation、Finder tag projection/search；不做 global taxonomy。

## 3. 范围

### 3.1 必须实现

- normal browser/Electron authoring UI 的 TopBar 显示 Tags action；没有 selection 时 disabled。选择一或多个 cards 后可打开 **Tag selected cards** panel。
- 用户可添加一个 tag 到 selected cards，或从 selected cards 删除一个已有 tag。操作保留 selection，且通过 existing `commitAction` 成为普通 Element operation，可 undo/redo。
- Each Element has at most **12** tags；tag trim/collapse whitespace、remove leading `#`、canonical lowercase、max **24** Unicode characters、unique；invalid/empty values skip。Editor 显示 selection 中 tag 的 `count / selected`，删除动作只影响 target selection。
- `Element` / Project Document v2 generic node properties backward-compatibly preserve sanitized tags；new/legacy/malformed tags hydrate safely，项目版本仍为 2。Tags are durable only through existing ordinary project Save/JSON flow.
- R22 Finder matches tag terms and renders at most 3 tag chips per result, while retaining its 50-result / current-board bounds.
- Foundation 覆盖 tag bounds/canonicalization/multi add-remove/idempotence、v2/legacy malformed round-trip, finder tag search/projection, operation-only App wiring/no selection change, no IPC/capability expansion；remote validation/exact read-back required.

### 3.2 明确不做

- 不做 global/project tag catalog、autocomplete/recent tags、cross-board tag search、tag hierarchy/color/permissions、bulk rename/merge, tag analytics, AI/OCR/semantic tags, collaboration, cloud/sync。
- 不做 custom SQLite table/full-text index、R11/R12/R13 query consumer、Worker、main/preload/IPC、generic settings/storage、autosave 或 dependency。
- 不在本轮给每个 card 添加 visible on-canvas tag chrome；tag display is bounded editor/Finder UI only.

## 4. 语义契约

```ts
const nextTags = addElementTag(element.tags, '#Reference'); // ['reference']
commitAction(previous => previous.map(element =>
  selectedIds.has(element.id) ? { ...element, tags: addElementTag(element.tags, draft) } : element,
));

// Existing v2 node properties carry the optional sanitized tags field.
serializeProjectDocument(boards); // no version or schema change
```

- Tags belong to an Element, not a Board/global taxonomy. They describe current card metadata and do not create a snapshot or query record.
- A tag mutation is content mutation: it deliberately enters existing undo/redo. Opening/closing editor, searching Finder, changing selection or cancelling input is not a mutation.
- Persisted bad tags are sanitized or discarded; they cannot break project open.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Selection-aware TopBar Tags action opens editor; user can add/remove bounded tags on one or many selected cards. |
| AC-2 | Tags are canonical and round-trip through v2/legacy safely; tag mutations use existing operation history and normal Save only. |
| AC-3 | Finder matches/renders bounded tag chips while retaining R22 current-board / 50-result behavior. |
| AC-4 | No global catalog/index/schema/IPC/dependency/R11/R12/R13 consumer/capability change occurs. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/doc read-back pass. |

## 6. 验证记录（2026-09-22）

- 远端 `npm --prefix artflow run typecheck` exit 0。
- 远端 `npm --prefix artflow run check:foundations` exit 0：覆盖 canonicalization / 12×24 bounded normalization / idempotence、multi-card operation redo/undo、v2/legacy malformed ingress、Finder tag search/projection、最多 3 个 chips、TopBar/App `commitAction` wiring 和无 IPC/capability widening。
- 远端 `npm --prefix artflow run check` exit 0（typecheck、Vite production build、foundations）；只出现既有 large-chunk advisory 与 Node SQLite experimental warning。
- Closing exact remote read-back matches the 9 R24 application/foundation sources and 4 R24 governance documents.

## 7. 风险与回退

- Tags are deliberately small per-card metadata; a taxonomy or project-wide tag query needs a new ownership/index decision.
- Multi-selection add/remove can create one normal operation containing many element deltas; this is expected existing journal behavior, not a separate bulk job.
- Finder shows only three chips per result to preserve bounded result rendering; all tags remain editable on selection.

## 8. 完成边界

R24 is bounded Element tag metadata and current-board Finder projection. A future FDD is required for global catalog/search, hierarchy/color, tag merge/rename, cross-board query, full-text index, AI/OCR tag extraction, on-card chip rendering, collaboration, sync or analytics.
