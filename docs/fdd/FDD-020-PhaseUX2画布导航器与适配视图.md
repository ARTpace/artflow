# FDD-020：Phase UX2 —— 画布导航器与适配视图

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R20
- **关联**：FDD-011 / ADR-011（R11 renderer-local viewport index）、FDD-014（interaction candidate read port）、FDD-019 / ADR-019（visible workspace UI）

## 1. 背景与目标

R19 已使项目状态与存储模式在 UI 中可见，但用户仍缺少一个直观的空间入口：当画布内容散落在大坐标范围时，看不到自己当前处于哪里，也不能一键回到所有卡片。现有 pan/zoom 已在 `useCanvasInteractions` 中工作，`MainCanvas` 已定义 canonical `translate3d(panOffset) scale(zoom)` viewport formula；本轮应把这一既有能力做成一个可见、可点击的导航 surface，而不是重写相机或接入 SQLite query。

本轮新增一直可见的 **Canvas Navigator**：显示受限数量的画布概览 marker 与当前 viewport 框；点击概览可将该 world point 置于主画布中心，`Fit canvas` 可将所有有限卡片 bounds 适配到当前 viewport。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。用户持续要求能在 UI 中感知开发成果；navigator 同时解决大画布空间定位这一真实交互问题。
2. **已有能力**：复用 `MainCanvas` 的 pan/zoom transform、`svgRef` viewport size、`updateActiveBoard`、`getElementBounds`、已存在的 non-presentation overlay layout；不重建 camera state。
3. **标准库**：使用 React memo/effect 和 SVG；不引入图形或 minimap dependency。
4. **平台特性**：使用浏览器/Electron 原生 `ResizeObserver` 读取主 SVG viewport；不可用时保留一次性尺寸测量。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。overview projection、inverse click mapping、fit transform、finite-bounds filtering 和 marker cap 都是需测试的非平凡几何。
7. **最小实现**：一个 pure `utils/canvasNavigator.ts` geometry/model helper + 一个 renderer-only `CanvasNavigator.tsx`；App 只把已有 viewport state 和 `updateActiveBoard` 传入。

## 3. 范围

### 3.1 必须实现

- 非 presentation canvas 的右下角显示 Canvas Navigator，含 canvas marker overview、当前 world viewport outline、当前 marker count 和说明；无元素时给出 empty state，不能制造卡片。
- navigator 读取主 SVG 实际 `getBoundingClientRect()`；以 `x = -panOffset.x / zoom`、`y = -panOffset.y / zoom`、`width = viewportWidth / zoom`、`height = viewportHeight / zoom` 映射当前 world viewport，必须与 existing MainCanvas transform 一致。
- click/tap overview 把点击到的 world point 居中到当前主 viewport，保持当前 zoom；只能通过 existing `updateActiveBoard` 更新 `panOffset` / `zoom`，不能修改 elements、operation history、storage 或 IPC。
- `Fit canvas` 基于所有 finite content bounds，保留固定 screen padding，并将 zoom clamp 到 existing 0.1–10 range；无可用 content bounds 时 disabled。
- content model 复用 `getElementBounds` 对非-group element 的现有 bounds authority；group marker 只读自身 stored rect，children 仍参与 content union，避免递归/cyclic group scan。任何 non-finite / negative bounds 不得污染 projection。
- 为避免又向大画布增加无界 SVG 负担，overview 最多渲染 **240** marker：frame 优先，其余按 stable source order evenly sample；content union 仍基于所有 finite cards，UI 明示 `showing 240 of N`。
- foundation 覆盖 pure viewport/projection/click/fit/math、finite filtering、marker cap/frame priority、R20 App wiring 与 no new IPC/capability count change；remote typecheck/build/full check 和 exact read-back 必须通过。

### 3.2 明确不做

- 不接入 R12/R13 saved snapshot query、R11 index ownership、Worker/tile service、live subscriptions、database/IPC/path/raw bytes。
- 不新增 pan inertia、dragging viewport rectangle、pinch gesture、multi-board overview、saved bookmarks、collaboration presence 或 minimap thumbnail rasterization。
- 不改变 MainCanvas exact selection/hit-test/parenting、undo/redo、BoardPanel、presentation behavior 或 project save schema。

## 4. 语义契约

```ts
const worldViewport = getCanvasWorldViewport({ viewportSize, panOffset, zoom });
const worldPoint = unprojectNavigatorPoint(pointer, projection);

// Same board/camera state as existing wheel panning; no Element operation is committed.
updateActiveBoard(board => ({
  ...board,
  panOffset: centerCanvasPointInViewport(worldPoint, viewportSize, board.zoom),
}));
```

- Navigator content is a current renderer-state overview, not a saved snapshot or persistent index result.
- Markers may be sampled; viewport outline and Fit bounds remain derived from all valid current content.
- `Fit canvas` does not select, mutate, reparent or persist elements by itself. Pan/zoom are existing Board state and will be saved only through normal project save.
- The navigator is hidden in presentation mode along with other authoring overlays.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | Browser and Electron authoring canvas visibly show a navigator with truthful empty/content states, bounded marker count and current viewport outline. |
| AC-2 | Overview click recenters the existing camera without changing zoom/elements/history; Fit canvas returns finite content into view with 0.1–10 zoom clamp. |
| AC-3 | Group / invalid geometry cannot recurse or poison navigator bounds; all-content union remains correct for finite non-group children, and frames retain marker priority. |
| AC-4 | No new IPC, schema, dependency, R11/R12/R13 consumer or storage boundary occurs; fixed capability count stays 13. |
| AC-5 | Foundation, remote typecheck, production full check and exact source/doc read-back pass. |

## 6. 风险与回退

- The navigator samples markers above 240; this is a deliberate visual budget, not a loss of content for Fit bounds.
- If `ResizeObserver` is unavailable, the current SVG size is measured once; clicking remains safe.
- Very small or degenerate bounds are stabilized for projection/fit only; no source element is altered.

## 7. 实现与验证证据（2026-09-22）

### 7.1 实现

- 新增 pure `utils/canvasNavigator.ts`：把 existing affine camera 的 viewport inverse、world-rect union、overview projection / inverse click、center-pan 和 fit transform 固定为可测函数。fit 使用 existing `0.1–10` zoom range；all finite bounds 参与 union。
- `createCanvasNavigatorModel` 对 non-group 复用 `getElementBounds`；group 只读 stored rect，以免 nested / malformed cyclic parent graph 在 overview 中递归。任何 non-finite 或 negative rect 被过滤。overview 固定 `NAVIGATOR_MAX_MARKERS = 240`，frame first，non-frame stable-order evenly sample；Fit content bounds 不因 sampling 缩小。
- 新增 `components/CanvasNavigator.tsx`：non-presentation canvas 的右下角可见 SVG navigator，用 native `ResizeObserver` 测主 SVG size（缺失时保留初次量测）；显示 marker、selection tone、current viewport outline、empty state、sample count 和 `Fit canvas`。pointer click 只 re-center camera。
- `App.tsx` 将 existing `svgRef` / elements / selection / panOffset / zoom 传入，唯一更新路径是 `updateActiveBoard(board => ({ ...board, panOffset, zoom }))`。它不修改 elements、operation history、R11 ownership、R12/R13 IPC 或 storage。

### 7.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 / AC-2 | 通过：foundation 运行 canonical world viewport inverse、projection round trip、center pan、fit padding/clamp fixture；production build 纳入 Canvas Navigator，App 在 non-presentation overlay 中 wire existing camera update。 |
| AC-3 | 通过：foundation 以 2 个 cyclic parent groups、242 cards 和 1 个 NaN rect 验证 group 不递归、invalid 被过滤、all-content union 仍含 finite cards、240 cap 和 frame-first order；overview does not mutate elements/history。 |
| AC-4 | 通过：foundation 验证 component / utility 没有 `queryViewport`、bridge 或 import-job symbols；main/preload fixed capability count 仍均为 13。无 schema / dependency / main/preload 改动。 |
| AC-5 | 通过：remote `npm --prefix artflow run typecheck`、`check:foundations` 与 full `check` 均 exit 0；final R20 source/governance exact read-back matched。Vite production build 处理 2,090 modules；仅保留既有 >500 kB chunk warning 与 Node SQLite ExperimentalWarning。 |

## 8. 完成边界

R20 is a local camera-navigation surface. Future FDDs are required for minimap dragging, pan animation/inertia, saved views, multi-board overview, live persistent spatial query consumption, tile/Worker rendering or rich thumbnail previews.
