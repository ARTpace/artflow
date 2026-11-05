# ADR-046：文档几何 SDK 与单一状态提交边界

- 日期：2026-09-23
- 状态：V2 首批实现与自动/独立浏览器验证通过；完整 V2 与 Electron 真机待续。证据见《插件平台V2首批实施记录》
- 范围：插件平台 V2 首批最小闭环，不代表完整节点/文档 SDK 或 V7 provider 替换

## 决策

1. 新增 `canvas.document@1` / `canvas.operations@1`，唯一 provider 为 `core.canvas-document`。复用原 profile layers，显式解析 serviceBindings；未知服务、未知 provider 或不兼容 major 拒绝。目录不允许最后注册者覆盖；binding 固定于启动，不开放热替换。
2. `useCanvasState` 的 Board[]/activeBoardId 改由小型同步状态容器唯一持有，React 使用 useSyncExternalStore 订阅；不是复制一份插件文档，也不是新历史系统。原 setBoards/setElements/undo/redo/loadBoardData API 保留，history 仍调用 operationHistory.ts。采用同步所有者，是为了在同一个事件循环内也能确定 revision 与提交结果，不在可重放的 React updater 里兑现 Promise 或执行插件副作用。
3. session 在 loadBoardData 成功替换项目时重建；board revision 随 elements 引用或历史游标变化递增。相机与选区不推进节点 revision；删除再创建同 ID 画板不复活旧 token。旧客户端必须按 immutable 更新约定修改 Element。
4. 文档 API 首批只投影节点几何/边界，不暴露共享 Element、资产 locator、任意属性或 React setter。查询分页上限 500，事务与选择上限 1000，点几何上限 4096。超过限制报错，不静默截断后执行部分排列。
5. 操作仅支持 node.patchGeometry：已有 x/y、正数 width/height、保持点数的 points；拒绝 identity/type/asset/parent 或未知属性。session/board/revision、全批 schema、节点存在性及 busy 状态在提交前检查。普通插件请求不接受 actor，actor 来自 loader-created scoped context；这仍是可信同进程门面，不是对恶意 JS 的认证沙箱。
6. 一批操作复用 commitCanvasOperation，产生一条现有撤销记录。noop 不增加记录；校验失败不提交；冲突不重放旧快照覆盖用户编辑。requestId 在当前 provider/session 的 256 项窗口内去重；淘汰后旧 revision 仍不能再次提交过期写入。
7. 操作同步返回 applied/noop/rejected/conflict、revision、actor、受影响 IDs；读取错误使用带 code 的 DocumentServiceError。卸载插件或 App provider lifetime 结束后拒绝使用旧 facade；订阅随 signal 清理。无网络或跨进程 Promise API，不伪装已有取消消息桥。
8. App 仅新增通用 provider 接线，排列插件通过公共 SDK 调用，不再读取 canvas.export-source 或调用 canvas.mutation。其他 legacy 插件暂留兼容服务；本批不扩大为全插件迁移。
9. renderer drag session 或旧 pending interaction 期间拒绝 SDK 写入，避免把未提交手势吞并进插件历史。

## 明确后续

- create/delete/reparent、更多属性、授权与审计持久化、跨进程 request/cancel、未知节点保留归 V2 后续/V4。
- 可替换第三方核心 provider、运行中服务切换、持久化 provider 迁移归 V7。本批目录只有实际可用的核心 provider，不把允许配置 ID 当替换能力已完成。
- 不修改 Project Document v2、资产所有权、staging、IPC/main/preload 或 jobs 调度器。
- 1000 节点以上的排列、复杂 group 几何须后续受控操作；不绕开事务上限，也不声称本批支持任意规模的原子批次。
- 真机 Electron、保存恢复和长时压力另验收；自动测试与独立浏览器 fixture 不替代真实桌面体验。
