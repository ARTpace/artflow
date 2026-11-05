# ADR-007：FormatHandler 契约与分发边界

- **状态**：accepted（已实现并验证）
- **日期**：2026-09-22
- **关联**：`FDD-007-PluginP0格式处理器注册表迁移.md`、`../插件系统设计.md`

## 背景

插件内核已有 `format_handlers` slot，但 importer 仍按中心 `if/else` 调用具体 parser。若继续直接接漫画、小说或新媒体格式，就会破坏「内置即插件」与 contribution consumer 泛化的立基原则。

## 决策

```text
builtin/formats-image-doc manifest
  → loader validates profile / minHostVersion
  → activate registers FormatHandler contributions
  → useFileHandlers asks pure format dispatcher
  → selected trusted handler parses renderer File
  → existing layout / PSD modal / managed-storage path consume normalized result
```

- `plugins/format-handlers.ts` 只定义 format contract、match、stable candidate list 与 selection；它不 import 具体 parser、UI、storage 或 Electron API；
- executable parser functions 通过 builtin activation register；manifest 声明 capability / host / compatibility，不试图在 JSON 中序列化 executable parse code；
- handler overlap 合法：priority 高者优先，priority 相同则 contribution id lexical ascending；`getFormatHandlerCandidates` 保留可见性数据；P4 才加入 user extension→handler binding；
- `minHostVersion` 针对 plugin contract API version（不是 package release version）；不兼容 builtin 被 loader 单独跳过并警告，不能拖垮 host；
- R7 仍只运行 trusted builtin code。external/restricted/unrestricted trust tiers、permissions、lockfile 与 sandbox 维持 P4。

## 后果与边界

- 添加同类格式不再要求编辑 `useFileHandlers` 的 parser branch；只需新的 manifest + activate 注册；
- 当前 browser parser 仍在 renderer，故它不是大媒体 Worker 化的替代；后续 handler 可在不更改 dispatcher contract 的情况下把 parse 交给 R6+ durable job infrastructure；
- generic fallback 只作为尚未迁移类别的兼容面，不能成为新增 image/document handler 的新入口；
- FormatHandler 只返回 normalized parse result，不得到 `ProjectRepository`、path、filesystem 或 raw IPC capability；R4-R6 ownership 未改变。

## 实现记录

- dispatcher 未取得 filesystem、SQLite、path、IPC 或 R6 Worker capability；它仅接收 renderer `File` descriptor 并选出 trusted builtin parser。
- `loadBuiltinPlugins` 只对 `PluginCompatibilityError` 做单插件 skip；malformed manifest 和 trusted builtin activation exception 仍显式失败，避免掩盖开发错误。
- 2026-09-22：远端 `npm --prefix artflow run check` exit 0，覆盖 dispatcher / compatibility / fallback boundary；Vite build 编译 actual builtin image/document module。
