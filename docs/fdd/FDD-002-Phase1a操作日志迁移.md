# FDD-002：Phase 1a —— Element Operation Journal 与 Legacy History Migration

- **状态**：verified
- **日期**：2026-09-22
- **关联**：`ADR-002-操作日志替代全量历史快照.md`

## 决策阶梯

1. **是否需要**：需要。全量 `Element[][]` 是已确认的内存与保存瓶颈。
2. **是否已有能力**：现有 `commitAction` / `setElements(..., false)` 已清楚区分最终与交互临时更新，可复用作为 operation commit 边界。
3. **标准库**：使用 `structuredClone`；为 JSON-compatible canvas elements 提供 fallback。
4. **平台特性**：不需要 Electron / Worker / SQLite 才能先完成 runtime journal。
5. **已有依赖**：无需增加依赖。
6. **一行方案**：无法安全地以一行实现可逆 diff、顺序重放和旧 history migration。
7. **最小实现**：只记录 Element 状态 delta；不扩张到 assets、board settings 或持久化数据库。

## 范围

### 已实现

- `CanvasOperation`、`CanvasElementChange` contract；
- 纯函数：创建 delta、应用 undo/redo、legacy snapshot history migration；
- `useCanvasState` 改用 `operationHistory` / `operationHistoryIndex`；
- transient interaction 只更新当前 `elements`，仅在 commit 创建一条 operation；
- 新项目与复制 board 不再创建 `Element[][]`；
- 旧 JSON 加载后迁移并在下次 save 输出新字段；
- 无依赖 self-check 覆盖 delta、reorder、undo/redo、legacy migration。

### 不实现

- AssetRecord / BoardNodeRecord / blob store；
- SQLite、Worker、IPC、CRDT；
- hit-test / snap 的 persistent spatial index；
- 对 board property、camera 或 UI preference 的 undo。

## 冻结接口

```ts
createCanvasOperation(before: readonly Element[], after: readonly Element[]): CanvasOperation | null
applyCanvasOperation(elements: readonly Element[], operation: CanvasOperation, direction: 'undo' | 'redo'): Element[]
migrateLegacyBoardHistory(board: Board): Board
```

`operationHistory` 的每条 operation 必须是 JSON-compatible、可逆、按元素 id 重放；只有新增、删除或重排时才保留 before / after order。

## 验收结果

| 编号 | 标准 | 证据 |
|---|---|---|
| AC-1 | 新增、删除、更新、reorder 都可被单条 operation undo / redo | `npm run check:foundations` |
| AC-2 | 连续 transient 更新只在最终 commit 生成一条 operation | `useCanvasState.ts` 的 pending interaction baseline + self-check operation contract |
| AC-3 | redo branch 在新的 commit 后被截断 | `commitElementUpdate` |
| AC-4 | 旧 `history` / `historyIndex` 可迁移；新对象不再写 legacy snapshots | `migrateLegacyBoardHistory` + self-check |
| AC-5 | TypeScript、production build 与 foundation self-check 全部通过 | `npm run check` |
| AC-6 | property-only operation 不重复保留全量 id order，且可量化对比 legacy snapshot | `npm run benchmark:history` |

2026-09-22：AC-1 至 AC-6 已验证。下一条 FDD 才处理 Asset / BoardNode / project document 迁移。
