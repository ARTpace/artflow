# FDD-022：Phase UX4 —— 画布内容查找与安全聚焦

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R22
- **关联**：FDD-014 / ADR-014（interaction candidate reader 边界）、FDD-020 / ADR-020（local canvas navigator）、FDD-021 / ADR-021（board-local views）

## 1. 背景与目标

R20 给出画布概览，R21 让用户回到已命名的相机位置；但当一个 board 有大量卡片时，用户仍缺少一个可见、可操作的方式按卡片名称、文字或类别定位**当前 board**上的具体内容。让用户靠缩放或在 minimap 中猜测 marker，不是可靠的工作流。

本轮在 Canvas Navigator 增加显式 **Find** 入口和 board-local **Canvas Finder** panel。用户可在当前 board 搜索 visible cards，并以 All / Frames / Text / Assets 过滤；点击结果只把当前 camera 居中到目标位置，保持当前 zoom，且不改变选择或画布内容。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。它把 R20 的空间概览和 R21 的手工 bookmark 补成可发现的定位工作流，直接减少大 board 中反复缩放、猜 marker 的操作。
2. **已有能力**：复用 active `elements`、R20 Canvas Navigator、existing main-canvas `svgRef`、`updateActiveBoard` 和 R20 affine `centerCanvasPointInViewport`，不新建 camera authority。
3. **标准库**：仅 React state/input、existing TypeScript / array operations；不引入 fuzzy-search、router、state-store 或 indexing dependency。
4. **平台特性**：不需要 Electron/browser API、IPC 或 native search service。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需要可测试的 bounded matching/model、finite geometry guard、stable result ordering、filter policy、safe camera focus 和 panel interaction boundary。
7. **最小实现**：增加 pure `canvasFinder.ts`、50-result renderer panel、Navigator `Find` entry 和 App camera-only handler；current board only，查询不保存。

## 3. 范围

### 3.1 必须实现

- Canvas Navigator 显示 `Find` action；normal browser/Electron authoring canvas 都可打开 current-board Canvas Finder panel。
- Finder 对 active Board 的 **visible、finite** elements 提供 name/text/type matching；提供 All、Frames、Text、Assets filter，结果保持 source order，最多 **50** 项。空 query 可以浏览 bounded current-board results。
- 每个 result 提供 Focus：复用 existing affine camera math 把目标 stored rectangle center 到 main canvas viewport，保持 current zoom；仅写 active Board `panOffset`，不改变 `zoom`、selection、elements、parenting、CanvasOperation、undo/redo、R20 navigator markers、R21 bookmark metadata、assets 或 import jobs。
- group 只使用 stored rect；不递归 group children。无效/hidden/duplicate-id element 必须安全跳过，model 不可因数据异常 throw。
- Finder query/filter/open state 仅为 renderer ephemeral state；不得保存、autosave、sync、analytics 或读取跨 board / repository / saved snapshot。
- foundation 覆盖 matching/filter/cap/stable order/finite+duplicate+hidden safety、center transform、App camera-only wiring 和 no IPC/capability expansion；remote typecheck/full check/exact read-back 必须通过。

### 3.2 明确不做

- 不做 cross-board/project search、recent search、saved query、full-text index、AI/semantic search、OCR、tagging、sorting/ranking、replace/edit、multi-select、search history 或 result thumbnail generation。
- 不接入 R11 cache、R12/R13 saved snapshot query、SQLite、Worker、Worker index、main/preload/IPC、generic settings/storage、dependency 或 schema migration。
- 不改变 `PROJECT_DOCUMENT_VERSION`，不让 result click 选中元素，也不把查找/聚焦放进 operation history。

## 4. 语义契约

```ts
const model = createCanvasFinderModel(elements, { query, filter }); // active board only, <= 50

// Focus preserves current zoom and changes only active-board camera pan.
const panOffset = focusCanvasFinderResult(result, viewportSize, zoom);
updateActiveBoard(board => ({ ...board, panOffset }));
```

- Finder 不是 persistent query 和 scene snapshot；关闭或切换 board 后的搜索词没有项目意义。
- `Focus` 以 stored rect center 为准。一个 group / malformed element 不会触发递归 geometry；无有限 rect 的结果不会进入 list。
- Search is intentionally local and bounded. It does not promise database-scale indexing, global coverage or fuzzy/semantic ranking.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Navigator exposes visible Find action; users can query/filter current-board visible items and focus a result. |
| AC-2 | Model caps at 50, keeps deterministic source order, safely ignores hidden/non-finite/duplicate records and preserves current zoom when focusing. |
| AC-3 | Focus changes only active board `panOffset`; no selection/content/history/R20 marker/R21 bookmark/asset/import mutation occurs. |
| AC-4 | No persisted query, IPC/schema/dependency/R11/R12/R13 consumer/capability change occurs. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/doc read-back pass. |

## 6. 风险与回退

- Search is a user-triggered O(n) current-board read and result rendering is capped at 50; it is not claimed to solve massive persistent search. If a measured workload needs an index, a new FDD must define lifecycle/ownership.
- A result can center an empty-looking stored rectangle after unrelated content changes; no scene snapshot is implied.
- If main viewport geometry is unavailable, Focus safely does nothing rather than guessing a camera transform.

## 7. 完成边界

R22 is an ephemeral, current-board finder and camera jump. A future FDD is required for cross-board/project search, persistent/saved queries, ranking/fuzzy/semantic search, thumbnails, selection/editing actions, R11/R12/R13 consumers, Worker indexes, autosave/sync or collaboration.


## 8. 已实现事实与验证（2026-09-22）

- `utils/canvasFinder.ts` 提供 pure current-board model：stable source order、All / Frames / Text / Assets filter、最多 50 条、name/text/type matching、hidden/non-finite/duplicate-id safe skip，以及重用 R20 `centerCanvasPointInViewport` 的 focus transform。
- `CanvasFinderPanel.tsx` 提供可见 `Find on this board` UI、filter、bounded result list 和 Focus action；它的 query/filter/open state 是 renderer ephemeral state，不写 Board / Project Document。
- R20 Navigator 增加明确 `Find` entry；`App.tsx` 在 result focus 时测量 existing main `svgRef` viewport，调用 `updateActiveBoard` 只写 active Board `panOffset`，保留 zoom 和 selection，并关闭 finder。切换 board 时 transient Finder / Views panels 关闭。
- 没有修改 `types.ts`、Project Document、SQLite、main/preload/IPC、R11/R12/R13 consumer、operation history、dependency 或 capability count。
- 远端验证已通过：`npm --prefix artflow run typecheck`、`npm --prefix artflow run check:foundations`、`npm --prefix artflow run check`（typecheck + production Vite build + foundations）均 exit 0。Foundation 覆盖 matching/filter/cap/stable order/hidden+non-finite+duplicate safety、camera transform、App camera-only wiring 和 13 个 fixed capabilities 不变。
