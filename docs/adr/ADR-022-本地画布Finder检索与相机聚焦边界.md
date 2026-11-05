# ADR-022：本地 Canvas Finder 检索与相机聚焦边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联**：ADR-014、ADR-020、ADR-021

## Context

R20 Navigator 的 marker 是 bounded geometry overview，R21 bookmark 是用户手工保存的 camera position。两者都不能按内容识别 current-board element。需要一个用户可发现的查找路径，但不应把 renderer-local read 误建为 persistent full-text store、R12/R13 saved spatial query consumer 或 generic global search。

## Decision

1. 新增 pure `utils/canvasFinder.ts`，从 active `Element[]` 构建 bounded result model。它只读取 visible finite stored rect，stable source order、unique id、All/Frames/Text/Assets filter、最多 50 result。
2. `CanvasFinderPanel` 是 R20 Navigator 的 renderer overlay sibling。query/filter/open state 留在 React，不写 Board、Project Document、settings 或 storage。
3. `App.tsx` 是唯一 orchestration point：focus action 使用 existing `svgRef` current viewport 和 R20 `centerCanvasPointInViewport` transform，调用 `updateActiveBoard` 只修改 `panOffset`，保持 zoom 与 selection。
4. 不递归 group bounds、不接 R11/R12/R13、不新增 index。大规模 persistent/indexed search 属于独立未来决策。

## Consequences

- 用户可在当前 board 可见 UI 中按内容快速回到目标，而不需要猜 minimap marker。
- Scan 仅在 panel render/query/filter change 中发生，output bounded；它不承诺 repository/project-scale query performance。
- 查找语义是 transient UI，不会污染 portable project data、operation history 或 desktop security boundary。

## Rejected alternatives

- **SQLite full-text / schema migration**：当前当前 board 的 ephemeral query 不需要 storage ownership，也不应让 renderer 查询 raw project database。
- **Reuse R12/R13 saved viewport query**：它们是 managed saved snapshot reader，不是 live current Board content/name matching authority。
- **Select result on focus**：会意外改变用户 selection 语义；本轮只改变 camera。
- **Fuzzy/semantic/AI search**：会引入 ranking/latency/privacy/product policy，超出 deterministic minimal scope。

## Revisit triggers

需要 cross-board/project query、persistent search state、full-text/semantic ranking、thumbnail/preview、result selection/editing、live index/Worker、query analytics 或 collaboration 时，必须新建 FDD/ADR。


## Implementation evidence（2026-09-22）

- Finder implementation is strictly renderer-local: `utils/canvasFinder.ts`, `components/CanvasFinderPanel.tsx`, R20 `CanvasNavigator`, and `App.tsx`; no main/preload/repository/schema/dependency diff exists.
- Model accepts only active `Element[]`, uses stored finite geometry without group traversal, has a hard 50-result maximum, and does not persist query/filter state.
- App reuses existing camera affine math and writes only `panOffset` through `updateActiveBoard`; focus neither selects an element nor creates a CanvasOperation.
- Remote `typecheck`, `check:foundations`, and full `check` all exited 0; foundation retains the fixed 13-capability assertion.
