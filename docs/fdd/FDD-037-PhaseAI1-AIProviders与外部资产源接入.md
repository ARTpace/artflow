# FDD-037：Phase AI1 AI Providers 与外部资产源接入

- 状态：verified
- 日期：2026-09-22
- 轮次：R37 (REQ-004)
- ADR：`ADR-037-AI与外部工具接入契约与Agent编排.md`

## 1. 问题与目标

实现《需求文档.md》REQ-004“AI 与外部工具接入”，打通：
1. 出站生成：统一 `ai_providers` 插槽；
2. 外部工具：以 ComfyUI 为样板的 `asset_sources` 插槽，生成带 `<comfyui.>` 命名空间元数据标准资产；
3. AI 编排：内核注册表自省投影为 LLM Agent 工具面。

## 2. 详细设计与实现清单

### 2.1 内核插槽与清单能力扩展 (`kernel.ts` & `manifest.ts`)
- `SLOTS`：新增 `'asset_sources'`（外部工具/资产源）与 `'node_actions'`（卡片上下文操作）；
- `PLUGIN_CAPABILITIES`：新增 `'asset.source'` 与 `'node.action'`。

### 2.2 核心契约与适配层
- `plugins/ai-providers.ts`：
  - `AIProviderCapability`：`text-to-image` / `image-to-image` / `inpainting` / `prompt-enhancement` / `text-generation`；
  - `AIProviderRequest` / `AIProviderArtifact` / `AIProviderResponse` / `AIProviderDefinition`；
  - 纯函数分发器 `invokeAIProvider(kernel, providerId, request)`。
- `plugins/asset-sources.ts`：
  - `AssetSourceDefinition`：`endpoint`、`namespacePrefix`、`probeStatus()`、`submitWorkflow()`；
  - `validateNamespaceMetadata(prefix, metadata)` 确保元数据命名空间隔离。
- `plugins/node-actions.ts`：
  - `NodeActionDefinition`：上下文过滤器 `isApplicable(ctx)` 与执行器 `run(ctx, kernel)`。
- `plugins/agent-orchestration.ts`：
  - `projectRegistryAsAgentTools(kernel)`：将当前内核中的 commands、ai_providers、asset_sources 反射为标准的 Agent Tool 描述（JSON Schema），带输入参数校验与执行闭包；
  - 内置工具名防注入校验（拒绝 `eval/shell/sql/fs/exec`）。

### 2.3 内置参考插件 (`builtin/ai-providers/`)
- `manifest.json`：注册 `ai.provider`、`asset.source`、`command`、`node.action` 能力；
- `index.ts`：
  - 注册 `gemini.image-generator`（文生图 + 提示词扩写）；
  - 注册 `comfyui.local-engine`（连接 127.0.0.1:8188，状态探测，工作流产出带 `<comfyui.>` 元数据）；
  - 注册 `image.ai-repaint`（针对图片卡片的 AI 重绘）；
  - 注册 `ai.generate-image` 工作区命令。
- `builtin/index.ts`：装载 `aiProvidersPlugin`。

## 3. 验收标准执行情况

1. [x] 任选一个第三方 provider 插件（如 ComfyUI / Gemini）安装后，无需改内核即可在卡片操作中出现并完成生成；
2. [x] ComfyUI 产物自动入库并带 `<comfyui.>` 命名空间元数据，可通过纯契约查询并同参重生成；
3. [x] 纯契约与抽象隔离，renderer 无直连不安全网络依赖；
4. [x] AI 编排支持：内核注册表经 `projectRegistryAsAgentTools` 动态投影为标准 Agent 工具；
5. [x] 自动化测试 `runAIProviderChecks` 100% 通过；生产构建与 5 项性能基准测试 100% 通过。
