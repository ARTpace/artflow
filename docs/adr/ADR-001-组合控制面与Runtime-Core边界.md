# ADR-001：组合控制面与 Runtime Core 的边界

- **状态**：accepted（Phase 0 / 0.5 最小实现）
- **日期**：2026-09-22
- **范围**：`artflow/`

## 背景

Artflow 已有 micro-kernel、builtin skin 与 canvas card contribution，但此前没有 profile、patch、依赖图、配置字段或启动期 materialization。若将画布渲染、空间索引、存储和 Electron 权限也变成可任意 patch 的插件，会让每帧成本和数据正确性不可控。

## 决策

采用：**Harness for composition，Runtime for performance**。

### 可组合的 Capability Plugin

- format handler；
- canvas card；
- command、panel、skin；
- AI provider 与 exporter。

它们以 manifest 描述 `id`、`host`、`capabilities`、`requires`、受限 `configSchema` 与可声明的 `resourceBudget`。启动期将 `base → mode → workspace → user → temporary` 的层按顺序解析，产出 immutable resolved profile。

### 固定的 Runtime Core

以下不属于 plugin manifest，也不是 profile patch target：

- camera、viewport virtualization、spatial index、renderer、LOD；
- operation dispatcher / undo journal；
- storage protocol、Worker lifecycle；
- IPC schema、Electron security boundary 与 resource scheduler。

Profile patch 只能改已知 capability plugin 的 enabled 状态或该 plugin 已声明的简单配置字段；不能注入代码、替换 Core、使用 generic IPC 或授予 filesystem / SQLite 权限。

### 热路径规则

profile merge、manifest validation、Kernel contribution registry 查询只在 bootstrap 或明确的 profile reload 执行。renderer 使用已 materialize 的 card lookup；camera / viewport query 不动态 dispatch plugin。

## 后果

- **正面**：builtin capability 可组合、配置可复现、错误可诊断；Core 仍能维持稳定的性能与安全边界。
- **成本**：新增 manifest / profile validation 与启动期 diagnostics；引入 profile reload 时需要明确 restart 或受控重新 materialize 的语义。
- **不做的事**：当前不引入 Cordis、不接纳任意 npm plugin、不声称 resource budget 已由富媒体 scheduler 强制执行。

## 验证

- `npm run check:foundations`：profile dependency / config / Core guard 与 viewport index 的行为自检；
- `npm run benchmark:viewport`：同一 10k synthetic fixture 比较 naive viewport scan 和 renderer-local grid query；
- `npm run check`：TypeScript check + Vite production build + foundation self-check。
