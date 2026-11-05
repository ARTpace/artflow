# FDD-001：Phase 0 / 0.5 —— 组合控制面与视口查询基线

- **状态**：verified（最小实现；后续 Phase 1+ 仍未开始）
- **日期**：2026-09-22
- **关联**：`ADR-001-组合控制面与Runtime-Core边界.md`

## 目标

在不重写 SVG renderer、数据模型或 Electron 存储层的前提下，先冻结两条后续迁移必须遵守的边界：

1. product capability 可由 manifest/profile/patch 组合，Runtime Core 不可被普通 patch 关闭；
2. 相机平移不再每次对全量元素执行 viewport filter，而是通过可替换的 `ViewportIndex` 查询边界获取候选集。

## 范围

### 已实现

- 严格 builtin manifest 校验：host、capability、requires、optionalRequires、受限 config schema、resource budget declaration；
- 启动期 base + desktop + localStorage user patch resolver；
- resolved profile immutable snapshot 与 dump；
- 启动期 materialized canvas-card lookup；
- renderer-local uniform-grid viewport query，并保留选中对象的离屏渲染语义；
- 无额外依赖的 Node self-check 和 10k fixture benchmark。

### 冻结边界

- `Runtime Core` 不得放入 manifest 或 user patch；
- `CanvasElement` 不得在 render path 调 Kernel registry；
- `ViewportIndex` 是 renderer query port，不得在调用方重新回退为 `elements.filter(...)`；
- 本阶段不新增第三方 package，不暴露 Electron / Node / SQLite 权限给 renderer。

## 非目标

- 不实现 SQLite/blob store、Worker、operation journal 或 persistent R-tree；
- 不将 SVG/foreignObject 改为 Canvas2D/WebGL；
- 不接受第三方 package plugin；
- 不承诺拖拽更新已经具备持久索引级的 O(log n) 性能。

## 验收

| 编号 | 标准 | 证据 |
|---|---|---|
| AC-1 | 未知 manifest 字段、依赖错误、未知 config、Runtime Core patch 必须失败 | `npm run check:foundations` |
| AC-2 | 默认 builtin profile 可被解析为不可变 resolved snapshot | `npm run check:foundations` |
| AC-3 | canvas card renderer lookup 不在 render path 调 Kernel | `plugins/renderer-materialization.ts` + `CanvasElement.tsx` |
| AC-4 | indexed query 与 naive query 在 fixture 上返回相同结果 | `npm run benchmark:viewport` |
| AC-5 | TypeScript 检查、生产 bundle 与 foundation self-check 全部通过 | `npm run check` |

## 结果

2026-09-22 已通过 AC-1 至 AC-5。此状态只验证当前最小切片；后续 Phase 1 的 Asset / BoardNode / operation contract 需新建 FDD 后再改数据模型。
