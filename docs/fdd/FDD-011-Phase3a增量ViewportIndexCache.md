# FDD-011：Phase 3a —— 增量 Viewport Index Cache

- **状态**：verified
- **开始日期**：2026-09-22
- **关联**：`ADR-011-增量ViewportIndexCache与保守回退边界.md`、`FDD-001-Phase0-0.5组合控制面与视口查询.md`

## 问题与成功标准

R1 已让相机移动通过 uniform-grid 查询候选，而不是每帧 `elements.filter`；但 `useCanvasState` 的拖拽/绘制会创建新的 `elements` array，`MainCanvas` 目前每次 array reference 改变都重新建立全量 grid。对大量 flat node，单个元素移动仍可能重新计算所有 bounds/cells，抵消部分 viewport query 收益。

成功标准：在 stable id/order、无 group 的 renderer-local element list 中，cache 只重索引 object reference 改变的 entries，query 结果与新建 immutable `createViewportIndex` 一致；element add/remove/reorder/duplicate id 或任何 group dependency 时保守 full rebuild，绝不返回 stale bounds。`MainCanvas` 持有 cache，而相机更新仍只 query。

## 决策阶梯

1. **是否需要**：需要。R1 已证明 grid query，但 interaction path 的全量 rebuild 是可核验瓶颈，且不能靠更多 memo 解决。
2. **是否已有能力**：复用 `createViewportIndex`、`getElementBounds`、React `useRef/useMemo`；保留 immutable index 作为 correctness oracle，不重写 spatial port。
3. **标准库**：使用 TypeScript `Map` / `Set`；不引入 spatial index dependency。
4. **平台特性**：使用 renderer React ref 保存 cache；不新增 Electron/Node/Worker capability。
5. **已有依赖**：无新增 dependency。
6. **一行方案**：不能。必须维护 cell membership、render order 和 strict fallback，不能仅凭 array reference 假定 bounds 未变。
7. **最小实现**：增加 local `ViewportIndexCache.update(elements)`；flat stable list 逐条更新，复杂结构回退既有 full index；仅替换 MainCanvas index lifecycle 并扩展 foundation/benchmark。

## 范围

- `utils/viewport-index.ts` 新增 renderer-local incremental cache 和诊断；
- stable unique flat list 中，仅 changed element reference 重新计算 bounds/cell membership；all-same new array 可复用；
- group、duplicate id、add/remove/reorder 或 unsupported layout 时 full rebuild；query output 保持 current element order、padding、selected offscreen inclusion 语义；
- `MainCanvas` 使用 mount-scoped cache，而不是每个 `elements` reference 重建 immutable index；
- foundation 和 viewport benchmark 增加 immutable-vs-cache equivalence 与 incremental/rebuild evidence。

## 非目标

- 不实现 SQLite R-tree、persistent board/node index、Worker/IPC viewport query、hit-test/snap/lasso/selection index、LOD/Canvas/WebGL 或 DOM virtualization；
- 不尝试 group hierarchy 的增量 bounds propagation；presence of group 必须保守 full rebuild；
- 不修改 R1 query port、R2/R3 operation/document model、R4–R10 storage/import contracts、plugin contracts 或 renderer-visible security boundary。

## 验收

| 编号 | 标准 |
|---|---|
| AC-1 | flat stable list 的 incremental query 与 fresh `createViewportIndex` 在 candidate/order/selected-offscreen semantics 上等价 |
| AC-2 | 单 element immutable update 只更新该 entry；same-entry new array 可 reuse；add/remove/reorder/duplicate/group 均明确 full rebuild |
| AC-3 | MainCanvas mount-scoped cache 只随 elements lifecycle update；camera path 仍只 query，无全量 filter fallback |
| AC-4 | benchmark 证明 repeated sparse updates 能比较 fresh rebuild 与 cache update，并保持 query result 一致 |
| AC-5 | foundation、typecheck、production build 通过 |


## 实现与验证（2026-09-22）

- `utils/viewport-index.ts` 已新增 mount-scoped `ViewportIndexCache`：flat unique-id/stable-order immutable list 首次 build 后只 detach/attach reference 改变的 entry；same-entry new array 无重索引。
- cache 保持既有 padding、candidate order 与 selected-offscreen inclusion；add/remove/reorder/duplicate id 或任何 group presence 都立即回退到 existing immutable `createViewportIndex` full rebuild，不产生 stale bounds。
- `components/MainCanvas.tsx` 已用 `useRef` 持有 cache，`elements` lifecycle 调用 `update(elements)`；camera 更新仍仅查询返回的 index，没有恢复 `elements.filter`。
- `benchmark:viewport` 已增加 10k flat fixture 的 100 次 sparse immutable update 比较；本次远端 run 中 fresh rebuild 为 178.57 ms，cache update 为 104.61 ms，查询返回数一致（7485），即该受控 fixture 的 1.71x 比较值，非跨机器性能承诺。
- 远端执行 `npm --prefix artflow run check` exit 0（`tsc -p tsconfig.json`、`vite build`、`node scripts/check-core-foundations.cjs`）。foundation 覆盖 cache/fresh equivalence、one-entry incremental update、reuse、add/remove/reorder/duplicate/group full rebuild 与 MainCanvas cache lifecycle static proof。

| 验收 | 结果 |
|---|---|
| AC-1 | 通过：flat initial / moved entry / selected-offscreen 与 fresh immutable index query 输出一致。 |
| AC-2 | 通过：单 entry update 计为 incremental；same-entry array reuse；add/remove/reorder/duplicate/group 均计为 rebuild。 |
| AC-3 | 通过：foundation 检查 MainCanvas 使用 `viewportIndexCacheRef.current.update(elements)`，无 `createViewportIndex(elements)` lifecycle 调用。 |
| AC-4 | 通过：远端 10k / 100 sparse update benchmark query result 一致并输出 rebuild/cache 对比诊断。 |
| AC-5 | 通过：远端完整 `npm --prefix artflow run check` exit 0。 |

## 完成边界 / 后续入口

R11 只优化 flat renderer-local grid 的 rebuild lifecycle。它不实现 SQLite R-tree、persistent board/node spatial mutation、Worker viewport page/cursor API、group incremental propagation、hit-test/snap/lasso index、LOD/Canvas/WebGL 或 DOM virtualization。group/structural board 仍完整 rebuild；这些不是遗漏，必须由后续 persistent spatial query / Hybrid renderer FDD 处理。
