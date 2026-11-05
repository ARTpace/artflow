# Sample Asset Inspector（声明式扩展验收样例）

源码树外开发与安装的最终验收插件。它**不是**可执行代码：整个扩展是一个数据
包（manifest + 数据文件），由宿主 `builtin.core-extensions` 的通用消费面解析、
迁移、渲染和提交节点。宿主核心没有为它新增任何特判、switch case 或静态 import。

## 内容
- `package.json` — declarative-v1 扩展包（manifestVersion 2）：
  - 节点 `ext.sample-inspector.inspection`，v2，含 v1→v2 字段重命名迁移（`titleText` → `title`）。
  - 格式 `.insp`（json-lines，≤2 MiB，≤1000 条记录）。
  - 两个工具：`bump-count`（number）、`set-passed`（boolean），经守卫链投影为命令/Agent 工具。
- `sample.insp` — 3 条示例记录（含一条使用默认字段的记录）。

## 安装（应用内）
设置 → Extension packages → 粘贴 `package.json` 内容 → Validate & install。
或把 `package.json` 内容交给宿主 `install` API（测试脚本即走此路径）。

## 验收对应
| 规格条目 | 实现位置 |
|---|---|
| 新文件格式 | `formats` + Worker 后台解析（进度/取消） |
| 受控后台任务 | `extensions/` 运行时 batch（`ExtensionImportPanel` 观察） |
| 自定义节点拖/缩/复制/删除 | 通用画布交互 + `ExtensionNodeCard` |
| 静态预览与编辑面板 | schema 驱动的卡片与 `ExtensionNodeProperties` |
| 保存/重开恢复 | v2 文档 `properties` 往返（check-plugin-extensions 覆盖） |
| 缺失插件保留数据 | 卸载/停用后占位卡，数据不删 |
| 命令/Agent 批量更新可撤销 | 守卫链 + 文档事务（单条历史） |
| 停用后清理 | 命令/守卫随包状态同步移除，资产不删 |

## 安全边界
- 包体不含入口、URL、脚本字段；校验器拒收任何可执行结构。
- 权限显式声明（`document.read/write`、`imports.parse`、`agent.invoke`），替换版本时授权只减不增。
- 同进程可信环境：这不是沙箱，隔离性由"数据-only + 显式权限 + 最终守卫"约束。
