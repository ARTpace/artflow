# Artflow AI 多模型接入方案（对标 art-canvas）

> 状态：方案稿（待评审）
> 目标读者：Artflow 维护者
> 参考实现：`H:\AI-Tools\art-canvas`（Python / FastAPI）
> 关联文档：`插件化迁移清单.md`（P3 — ai_providers 插件化）、`插件系统设计.md`

---

## 一、背景与目标

Artflow 的 AI 生成能力刚完成 P3 迁移，统一收敛进 `builtin.ai-providers` 插件：

- 云端 Gemini（文生图 / 图生图 / inpaint / 提示词增强 / 文生视频）
- 本机 ComfyUI 抠图

但目前存在两个结构性限制：

1. **provider 是"代码内注册"**：新增一家模型必须写代码、加 provider 定义。
2. **API Key 是"单桶"**：`secrets-store` 里只有一个 `ai.geminiApiKey`，无法承载多家供应商。

`art-canvas` 在这方面积累了一套成熟的**配置化多供应商 + 分桶密钥 + 前端可视化管理**模式。本方案的目标是：**把 art-canvas 的经验裁剪后引入 Artflow 的 `ai-providers` 插件**，让"接一家新模型 = 加一段配置 + 填一个 Key"，尽量不动生成逻辑。

---

## 二、art-canvas 机制详析

### 2.1 双轨配置：provider 元数据 与 密钥分离

`art-canvas/api_providers.json` **只放元数据，不放密钥**：

```jsonc
{
  "id": "modelscope",
  "name": "ModelScope",
  "base_url": "https://api-inference.modelscope.cn/v1",
  "protocol": "openai",
  "image_request_mode": "openai",
  "image_models": ["Tongyi-MAI/Z-Image-Turbo", "Qwen/Qwen-Image-2512", "..."],
  "chat_models": ["Qwen/Qwen3-235B-A22B-Instruct-2507", "..."],
  "video_models": [],
  "ms_loras": [],
  "primary": false,
  "enabled": true
}
```

真实密钥放 `API/.env`，键名规则固定（`main.py`）：

```python
def provider_key_env(provider_id):
    """生成提供商 API Key 的环境变量名"""
    return f"{provider_id.upper()}_API_KEY"      # 如 MODELSCOPE_API_KEY / COMFLY_API_KEY
```

读取时**实时解析 .env 文本**，而非依赖进程启动时的环境变量：

```python
def read_api_env_value(key):
    # 逐行解析 API/.env，遇 key.match 立刻返回；缺文件/缺键返回 ""
def get_provider_api_key(provider_id):
    env_key = provider_key_env(provider_id)
    return read_api_env_value(env_key) or os.getenv(env_key, "")
```

保存时把新 Key 写回 .env，并**立即重载**：

```python
# PUT /api/providers
if item.api_key is not None:
    env_updates[provider_key_env(provider["id"])] = item.api_key.strip()
...
update_env_values(env_updates)
reload_env_globals()      # 立即同步，不用重启
```

### 2.2 密钥脱敏（下发给前端前）

```python
def public_provider(provider):
    env_key = provider_key_env(provider["id"])
    has_key = bool(os.getenv(env_key, "") or read_api_env_value(env_key))
    key_preview = raw[:4] + '••••' + raw[-4:] if len(raw) > 8 else '••••••••'
    return { ..., "has_key": has_key, "key_preview": key_preview, "key_env": env_key }
```

要点：**列表接口永远不下发明文 Key**，前端只拿到 `has_key` + 预览串。

### 2.3 协议适配层（换模型 = 换配置）

生成入口按 `protocol` + `image_request_mode` 分派到不同实现：

| 维度 | 取值 | 落到 |
|------|------|------|
| `protocol` | `openai` / `volcengine` / `jimeng` / … | 鉴权头 + 端点风格 |
| `image_request_mode` | `openai` / `responses` / `async` | 同步 / Responses / 异步轮询 |

对应函数：`_gen_openai_sync`、`_gen_openai_responses`、`_gen_openai_async_submit`、`_gen_modelscope`。
统一由 `_resolve_image_provider(provider_id)` 解析出 `{ base_url, api_key }` 后再分派。

### 2.4 Provider 管理接口 + 前端页

| 接口 | 作用 |
|------|------|
| `GET /api/providers` | 列表（脱敏） |
| `PUT /api/providers` | 批量保存 provider + 写入密钥（强制唯一 `primary`） |
| `POST /api/providers/test-connection` | 调上游 `/v1/models` 测试连通 |
| `POST /api/providers/probe-async` | 异步协议探测 |
| `POST /api/providers/fetch-models` | 拉取上游模型列表同步到 `image_models` |

前端：`static/setting/api-settings.html` + `api-settings.js`。

### 2.5 特殊通道

即梦（Dreamina）走 **CLI + 本机登录态**，完全不需要 API Key（`is_jimeng_provider` 特判）。

---

## 三、Artflow 现状（迁移后）

| 模块 | 现状 |
|------|------|
| `ai_providers` 槽 | 支持多 provider 注册；当前静态注册 2 个（`gemini.image-generator`、`comfyui.local-engine`） |
| `AIProviderDefinition` | `title / description / providerType / capabilities[] / run(request, kernel) / checkHealth()` |
| 密钥 | `secrets-store` 单键 `ai.geminiApiKey`，有旧键一次性采纳机制 |
| 调用 | 本体 `App.tsx` → `invokeAIProvider(kernel, providerId, request)`；cutout 插件消费 comfy provider |
| MCP | `agent-orchestration.ts` 自动把 provider 投影成 agent 工具 |
| 设置 UI | 有 `settings-contributions` / `panel-contributions`（浮动面板）机制可复用 |

**结论**：Artflow 的槽结构本身支持多 provider，缺的是「**配置化**」和「**分桶密钥**」这两层。

---

## 四、对比

| 能力 | art-canvas | Artflow 现状 | 差距 |
|------|-----------|-------------|------|
| provider 定义 | 配置驱动（JSON） | 代码内注册 | ✗ |
| 多供应商 | 5 家内置 + 可增 | 2 个（含 1 本地） | ✗ |
| 密钥存储 | 按 provider 分桶（`{ID}_API_KEY`） | 单桶 `ai.geminiApiKey` | ✗ |
| 密钥脱敏下发 | ✅ `has_key` + 预览 | 无对外通道 | ~ |
| 连通性测试 | ✅ test-connection | 仅 provider 自带 `checkHealth` | ~ |
| 模型列表同步 | ✅ fetch-models | 无 | ✗ |
| 协议适配 | 多协议分派 | 单一 Gemini SDK | ✗ |
| 生成分派 | `run(request)` 内 op 分派 | 同左（已就绪） | ✓ |

---

## 五、Artflow 多模型接入设计

### 5.1 总体架构

```
配置源（config-volume / 偏好卷）
   │  AIProviderProfile[]（元数据，无密钥）
   ▼
provider-factory（插件内新模块）
   │  为每个 enabled 的 profile 造一个 AIProviderDefinition
   ▼
ai_providers 槽（kernel.contributions.register）
   │
   ├─ builtin.gemini       （保留：原生 Gemini SDK provider）
   ├─ builtin.comfyui      （保留：本机抠图）
   └─ config.openai.<id>   （新增：OpenAI 兼容 provider × N）
             │
             ▼
        invokeAIProvider(kernel, id, request)  ← 本体 / cutout / MCP 统一入口
             │
             ▼
        secrets-store.readSecret(`ai.provider.<id>.apiKey`)
```

### 5.2 数据模型：`AIProviderProfile`

```ts
interface AIProviderProfile {
  id: string;                       // 'openai-compatible.volcengine'
  name: string;                     // 展示名（可 i18n）
  protocol: 'openai' | 'gemini';    // v1 先支持 openai 兼容 + 原生 gemini
  baseUrl: string;                  // 上游根地址（不含 /v1 时自动补）
  imageModels: string[];            // 文生图/图生图模型 id
  videoModels?: string[];
  capabilities: AIProviderCapability[];   // text-to-image / image-to-image / video …
  requestMode?: 'openai' | 'async'; // 同步 / 异步轮询
  enabled: boolean;
  isDefault?: boolean;              // 唯一默认（对标 primary）
  /** 本地凭据引用键名，如 'ai.provider.volcengine.apiKey'（不含密钥本体） */
  secretKey: string;
}
```

**存储位置**：放 Artflow 的配置卷（`config-volume` / 偏好卷），与"密钥卷"分离——与 art-canvas 的「元数据 / 密钥」分离原则一致。

### 5.3 密钥分桶

在 `secrets-store` 采用统一命名：

```
ai.provider.<profileId>.apiKey      # 新增，按 provider 分桶
ai.geminiApiKey                     # 保留（内置 Gemini），并作为 legacy 来源
```

- 兼容：现有 `ai.geminiApiKey` 不动，内置 Gemini provider 继续读它。
- 脱敏：新增 `maskSecret(key)` 助手，返回 `{ hasKey, preview: '前4••••后4' }`，仅供设置面板。
- 安全：密钥只在主进程/密钥卷落盘，渲染层通过 IPC 读写（沿用现有 `window.artflowConfig` 桥）。

### 5.4 协议适配层（新增 `openai-compatible-provider.ts`）

新增一个把「OpenAI 兼容协议」封装成 `AIProviderDefinition` 的工厂：

```ts
createOpenAICompatibleProvider(profile, transport): AIProviderDefinition
```

- `run(request)` 按 `request.parameters.op` 分派：
  - `text-to-image` → `POST {baseUrl}/v1/images/generations`（或 `responses` / `async`）
  - `image-to-image` / `inpainting` → 参考图走对应字段（各家兼容差异用 `requestMode` 兜底）
  - `video` → 上游视频端点（若有）
- 网络走注入的 `transport`（沿用 comfy/gemini 的"纯逻辑 + 可注入 transport"自检风格）。

**收益**：接入新家模型时，若其兼容 OpenAI 协议，**只需加一条 profile**，无需新代码。

### 5.5 与现有 `ai_providers` 槽融合

- `builtin.ai-providers` 插件 `activate` 时：
  1. 注册内置 `gemini` / `comfyui`（不变）；
  2. 读取 `AIProviderProfile[]`，对每个 `enabled` 的 profile 调 `createOpenAICompatibleProvider` 并 register；
  3. 监听配置变更 → `dispose` 旧注册 + 重新 register（沿用现有 Effect 组合式注册）。
- 槽内 id 唯一性由 `register({ id, pluginId, priority, value })` 保证；配置 provider 用 `config.<profileId>` 前缀避免与内置冲突。
- MCP 工具面（`agent-orchestration`）**零改动**即自动获得新 provider 的工具投影。

### 5.6 设置面板（复用浮动面板机制）

新增「AI 模型」设置节 / 浮动面板，能力对齐 art-canvas：

| 功能 | 说明 | Artflow 现有可复用 |
|------|------|------------------|
| provider 列表 | 增删改、启停、默认项 | `settings-contributions` |
| 密钥录入 | 脱敏展示 `前4••••后4`，仅本地落盘 | `secrets-store` + `maskSecret` |
| 连通性测试 | 调上游 `/v1/models` | 网络走 transport |
| 模型列表同步 | 拉取上游模型填 `imageModels` | 同左 |
| 默认 provider | 唯一默认，供 PromptBar 无选区时使用 | 偏好卷 |

### 5.7 本体去耦：provider 决议抽离

**问题**：迁移后，「生成时用哪个 provider」被写死在本体 —— `App.tsx`：

```ts
const invokeProvider = useCallback(
  (request) => invokeAIProvider(pluginKernel, GEMINI_PROVIDER_ID, request),  // ← 硬编码
  [pluginKernel],
);
```

结果是：无论插件里注册多少 provider，本体永远只调 Gemini。**「多 provider 可用」与「多 provider 可被选用」是两回事** —— 前者靠插件，后者卡在本体这一行。

**目标**：把「选哪个 provider」从一行代码变成一次运行时决议，本体不再出现任何具体 provider id。

**设计**：
- 新增一个决议入口（放**运行时层**，不放 App 本体），例如：
  ```ts
  // plugin-runtime/ai-provider-resolution.ts
  resolveProviderId(kernel, request): string
  ```
  决议优先级：
  1. 请求显式指定的 provider（`request.parameters.providerId`，供高级用法 / 同参重生成）
  2. 用户当前选中的 provider（偏好卷）
  3. 配置里标记 `isDefault` 的 provider
  4. **回退：内置 `gemini.image-generator`**（保证零配置行为不变）
- 决议需做**能力匹配**：若选中的 provider 不支持该 `op`（如视频），用现有 `filterAIProvidersByCapability` 回退到支持该能力的 provider。
- 本体 `App.tsx` 改为：
  ```ts
  const invokeProvider: InvokeAIProvider = useCallback(
    (request) => invokeAIProvider(pluginKernel, resolveProviderId(pluginKernel, request), request),
    [pluginKernel],
  );
  ```
  → 之后插件侧增删 provider，**本体不再改动**（这正是「插件自治」的最后一块拼图）。

**兼容**：不配置任何 profile 时，决议恒为 `gemini.image-generator`，行为与迁移前完全一致。

**边界**：决议**只决定 id**，不构造请求、不落画布 —— 那些仍是本体职责（见第四节三层划分）。cutout / MCP 等消费方本就用显式 id 调用，不受影响。

---

## 六、分阶段实施路线

| 阶段 | 范围 | 交付物 | 验证 |
|------|------|--------|------|
| **P0** | 数据模型 + 分桶密钥 + OpenAI 兼容 provider（同步模式） | `openai-compatible-provider.ts`、`secrets-store` 分桶 + `maskSecret` | 隔离自检（fake transport）：配置 1 家 → 文生图/图生图成功；无 Key 优雅失败 |
| **P0.5** | **本体去耦：provider 决议抽离**（本体不再硬编码 provider id） | `ai-provider-resolution.ts` + `App.tsx` 改一行 | 决议回退正确；零配置行为不变；`grep GEMINI_PROVIDER_ID App.tsx` 无命中 |
| **P1** | 配置卷持久化 + 设置面板（列表/录入/测试） | 新设置节 + `provider-factory` 接线 | 面板增删改后重载生效；脱敏正确 |
| **P2** | 异步协议 + 模型列表同步 + 原生 Gemini 也纳入统一配置（可选） | `requestMode: 'async'`、`fetch-models` | 异步轮询自检；模型同步后可选 |
| **P3** | （可选）本地通道统一：ComfyUI 通用工作流 provider 化 | 参考 art-canvas 的 `comfyui-registry.js` | 工作流 JSON 驱动 |

> 建议：P0 独立可验证、风险最低；P1/P2 再动 UI 与持久化。

---

## 七、风险与权衡

1. **协议差异**：不同家"OpenAI 兼容"在参考图字段、异步语义上仍有差异。对策：`protocol` + `requestMode` 双维度，先覆盖 openai-sync，差异大的单独适配。
2. **密钥安全**：分桶后仍需保证只有主进程读明文；渲染层只经 IPC + 脱敏。沿用现有 `secrets-store` 安全模式与旧键采纳纪律。
3. **provider 生命周期**：运行时 register/dispose 要避免泄漏（沿用现有 `disposers.reverse()` 纪律）。
4. **配置冲突**：默认 provider 唯一；内置 id 与配置 id 命名空间隔离（`builtin.*` vs `config.*`）。
5. **决议回退**：provider 决议必须有确定性兜底（无配置 → gemini；能力不匹配 → 挑一个支持的），否则会出现「选到不支持的 provider 静默失败」。
6. **不做的部分**：账号系统、用户级文件隔离、历史记录等 art-canvas 特性**不属于本方案范围**（Artflow 已有自己的项目/资产体系）。

---

## 八、验收标准

- [ ] 新增一家 OpenAI 兼容供应商，**只改配置 + 填 Key**，不改生成代码即可出图。
- [ ] 密钥按 provider 分桶，列表/设置面板**不下发明文**（仅 `has_key` + 预览）。
- [ ] 内置 Gemini / ComfyUI 行为不回归（原 provider id 与能力不变）。
- [ ] **本体不再出现任何具体 provider id**（`App.tsx` 只调 `resolveProviderId`），增删 provider 无需改本体。
- [ ] MCP 工具面自动出现新 provider 的工具，无需额外接线。
- [ ] 隔离自检覆盖：配置解析 → provider 注册 → op 分派 → 无 Key 降级。
- [ ] `typecheck + build` 通过（不引入新的类型错误）。

---

## 附：art-canvas 参考坐标

| 主题 | 文件 / 位置 |
|------|------------|
| provider 元数据 | `art-canvas/api_providers.json` |
| 密钥命名 | `main.py` `provider_key_env()` |
| .env 实时读取 | `main.py` `read_api_env_value()` |
| 脱敏下发 | `main.py` `public_provider()` |
| 保存 + 立即重载 | `main.py` `PUT /api/providers` + `reload_env_globals()` |
| 协议分派 | `main.py` `_gen_openai_sync/_responses/_async_submit/_gen_modelscope` |
| 管理接口 | `main.py` `/api/providers*` |
| 前端页 | `art-canvas/static/setting/api-settings.html` |
