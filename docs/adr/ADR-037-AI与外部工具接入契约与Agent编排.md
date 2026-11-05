# ADR-037：AI 与外部工具接入契约与 Agent 编排

- 状态：verified
- 日期：2026-09-22
- 轮次：R37 / Phase AI1 (REQ-004)
- 关联：`FDD-037-PhaseAI1-AIProviders与外部资产源接入.md`

## 背景

无限画布需要支持多元 AI 能力与外部创作工具（如 ComfyUI、Gemini、本地模型、SD-WebUI）。《需求文档.md》REQ-004 要求建立三条通道：
1. 通道一：出站生成 — `ai_providers` 统一契约（文生图、图生图、扩图、Prompt 扩写）；
2. 通道二：外部工具连接 — `asset_sources` 资产源插槽（以 ComfyUI 为样板，端点探测、工作流提交、带 `<comfyui.>` 命名空间元数据入库并支持同参重生成）；
3. 通道三：AI 编排 — 内核注册表动态投影为 Agent 可调用的工具面（JSON Schema Tools），无手写清单。

## 决策

1. **通道一：出站生成（`plugins/ai-providers.ts`）**：
   - 抽象 `AIProviderDefinition` 与 `AIProviderRequest` 统一契约；
   - 支持产物输出 `AIProviderArtifact`（image/text/video），带耗时与执行状态；
   - 派发辅助函数：`listAIProviderContributions`、`resolveAIProvider`、`filterAIProvidersByCapability`、`invokeAIProvider`；
   - 内核或插件可通过上下文动作（`node_actions`）针对选中元素触发 AI 处理。

2. **通道二：外部工具连接（`plugins/asset-sources.ts`）**：
   - 抽象 `AssetSourceDefinition`：支持 `endpoint` 配置、`probeStatus` 状态探测与 `submitWorkflow` 工作流产物提交；
   - 规定命名空间元数据前缀（如 `comfyui.`），强制验证产物元数据（如 `comfyui.seed`、`comfyui.prompt`、`comfyui.workflowId`），支持一键同参重生成；
   - 产物进入画布元素与 Project Document v2 资产流。

3. **通道三：AI 编排与工具投影（`plugins/agent-orchestration.ts`）**：
   - 实现 `projectRegistryAsAgentTools(kernel)`：自省内核注册表，将当前已启用的 `commands`、`ai_providers`、`asset_sources` 动态反射为标准 Agent 工具声明（JSON Schema）；
   - 工具命名卫生：正则拒绝 `eval / shell / sql / fs / exec / net / process` 等高危字样；
   - Agent 与客户端无需硬编码工具清单，随插件增减自动自适应。

4. **安全与进程边界**：
   - 遵从《插件系统设计》§12 互操作规范与 §8 信任三档原则；
   - 保持 13 项固定 IPC capability 严格不变；
   - 契约只增不改不删：`SLOTS` 新增 `asset_sources` 与 `node_actions`；`PLUGIN_CAPABILITIES` 新增 `asset.source` 与 `node.action`。

## 效果与影响

- **无侵入接入**：任何第三方 AI/工具插件只需通过内置或外部 loader 声明贡献，即可瞬间在画布命令、卡片右键与 Agent 工具面生效，无需修改内核代码。
- **可测试与确定性**：`runAIProviderChecks` 测试套件全面覆盖云端/本地 Provider、ComfyUI 状态探测、元数据前缀约束、工具投影与插件卸载清理。
