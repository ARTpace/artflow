# Artflow AI 配置面板 · 界面复刻规格

> 状态：规格稿（待评审）
> 目标读者：Artflow 维护者
> 来源参照：`H:\AI-Tools\art-canvas\static\setting\api-settings.html` + `api-settings.js`（≈ 主题 2772 行 + 逻辑 2366 行，原生 HTML/JS）
> 推翻目标：**功能对齐 + 交互一致 + 视觉适配 Artflow**（不做像素级照搬）
> 关联文档：`AI多模型接入方案.md`（后端能力 P0–P2）

---

## 一、目标与原则

把 art-canvas 的「API 设置」页，按 Artflow 的技术栈与设计系统重做成一个**「AI 模型」配置面板**。

四条原则：

1. **功能对齐**：art-canvas 里与「多供应商 / 密钥 / 模型」直接相关的功能，逐项复刻。
2. **交互一致**：保留「左侧选平台 + 右侧编辑」「Key 脱敏」「即改即用」的操作手感。
3. **视觉适配 Artflow**：沿用 Artflow 的主题变量与组件规范，**不照搬** art-canvas 的霓虹暗色皮。
4. **脱业务**：art-canvas 里深度绑定它自家后端的特化面板（RunningHub 工作流编辑器、即梦 CLI 登录、MS LoRA 等）**不搬**。

### 必须遵守的 Artflow 界面约定（来自项目既有规范）

- **布局**：设置类界面 = 顶栏标题 + **左侧分类导航** + **右侧配置区**。
- **面板形态**：管理类功能做成**独立、非模态、可拖拽的悬浮窗**（`ui_panels` + `presentation: 'floating'`），不嵌在设置弹窗里。
- **顶部**：整块收成**单行紧凑工具栏**（标题 + 筛选/搜索 + 操作按钮一行），次要信息进 tooltip / 下拉。
- **详情**：偏好**行内折叠 accordion 原地展开**，不用弹层遮挡。
- **主题**：新 UI 必须放入 `data-bp-ui-*` 作用域，并补齐 `index.css` 的类映射，浅色/深色全套适配。
- **契约**：改动的 DOM 结构要同步更新对应 UI 断言检查脚本。

---

## 二、总体信息架构（art-canvas → Artflow）

art-canvas 该页的分区与「复刻决定」：

| art-canvas 分区 | 复刻 | Artflow 落法 |
|-----------------|:---:|--------------|
| 页面头（标题 + 副标题 + 状态） | 🟡 改造 | 收进**单行工具栏**（标题 + 状态点 + 操作） |
| 左侧「平台列表」+ 新增平台 | ✅ | 左侧导航 `ProviderList` |
| 左侧「推荐API」 | 🟡 简化 | 一张引导卡 / 下拉里的「快速添加」 |
| 左侧「CLI 设置」（即梦/GPT/Antigravity） | ❌ | 不搬（无对应后端） |
| 左侧「翻译设置」 | ❌ | 不搬 |
| 右侧「基本信息」（名称/ID/请求地址） | ✅ | `ProviderEditor` 基础字段 |
| 右侧「API Key」（输入 + 保存 + 清除） | ✅ | `ApiKeyField` + `secrets-store` |
| 右侧「各家 key stack」（RH 双 Key / 火山 AK·SK·项目） | 🟡 待定 | 视接入的家而定，**多凭据**用可折叠区承载 |
| 右侧 CLI 面板（即梦/Codex/Gemini） | ❌ | 不搬 |
| 右侧「验证操作行」（验证地址/验证协议 + 协议 + 图片模式） | ✅ | `VerifyRow`（单行） |
| 右侧「RunningHub 应用与工作流」+ 工作流编辑器浮层 | ❌ | 不搬 |
| 右侧「模型列表」（image/chat/video） | ✅ | `ModelLists` |
| 「拉取模型」「选择模型」按钮 | ✅ | `ModelToolbar` |
| 模型选择器浮层（搜索 + 分类 + 勾选） | ✅ | `ModelPickerOverlay` |
| MS LoRA 编辑 | ❌ | 不搬（除非接 ModelScope） |
| 推荐 API 浮层 | 🟡 简化 | 精简引导卡 |

---

## 三、面板形态与宿主

- **贡献方式**：作为 `ui_panels` 贡献一个面板，`presentation: 'floating'`、`floatingWidth: 'md'`（≈ 38rem）或 `'lg'`（≈ 46rem，模型列表较宽时）。
  → 复用现有 `PluginPanelHost`，自动获得**非模态、可拖拽、可折叠**的悬浮窗（与「插件管理」「appearance studio」同机制）。
- **入口**：TopBar 快捷入口（现有 `quickEntry` 机制）或设置里的跳转。
- **主题作用域**：面板根节点挂 `data-bp-ui-*`，样式走主题变量。

---

## 四、逐区规格

### 4.1 顶部：单行紧凑工具栏（`PanelToolbar`）

把 art-canvas 的「页面头 + content-head（标题 + 删除/保存）」合并为**一行**：

```
[ AI 模型 ]   [平台 ▾ / 搜索]        [＋新增] [测试] [保存] [⋯] [✕]
```

- 左：面板标题（`bi()` 双语）
- 中：平台快速切换 / 搜索（也可省，由左列表承担）
- 右：新增、测试连接、保存（主按钮）；「删除」「清除 Key」等收进 `⋯` 下拉
- 状态（已保存 / 测试中 / 失败）以**小状态点 + tooltip** 呈现，不占一行文字

> 依据：用户明确反对多行堆叠头部，次要动作收进 tooltip / 下拉。

### 4.2 左侧：平台列表（`ProviderList`）

```
平台列表
─────────────
● Gemini            Cloud
○ 火山引擎           OpenAI
○ ModelScope        OpenAI
─────────────
＋ 新增平台
```

- 每项：状态点（启用/停用）、名称、协议药丸、`has_key` 指示（无 Key 时灰点）
- 选中态高亮，`active` 样式
- 底部「＋ 新增平台」虚线按钮
- 列表行高紧凑（信息密度优先）

### 4.3 右侧：配置区（`ProviderEditor`）

按「基本信息 → 凭据 → 验证 → 模型」自上而下：

**① 基本信息**
| 字段 | 控件 | 说明 |
|------|------|------|
| 平台名称 | text | `name` |
| 平台 ID | 只读预览 | 由 name 派生 slug（对标 art-canvas `idPreview`） |
| 协议 | select | `openai` / `gemini`（v1 范围，见方案 §5.2） |
| 请求地址 | text | `baseUrl`；下方 hint 给常见地址示例 |
| 图片请求模式 | select | `openai` / `async`（v1 先这两档） |

**② 凭据（`ApiKeyField`）**
- 单凭据（多数家）：一个输入框 + 「保存」「清除」两个图标按钮
- 多凭据（如某家需要 AK/SK 或双 Key）：用**行内折叠区**承载，不弹层
- **脱敏**：输入框留空时占位显示 `已配置 · 前4••••后4`；不配置则在 hint 显示「未配置」
- 保存/清除后即时反馈（状态点 + 文案），**不重载整个面板**

**③ 验证行（`VerifyRow`）** — 收成一行
```
[✓ 测试连接]  [⟳ 拉取模型]                    [协议 ▾]  [图片模式 ▾]
```
- 测试连接：调上游 `/v1/models`，结果用行内小徽章（成功/失败 + 状态码 + 延时）
- 拉取模型：拉到后填充模型列表（见 ④）

**④ 模型列表（`ModelLists`）**
- 三个分区：`图像` / `对话` / `视频`（空分区可折叠收起）
- 每分区：模型行列表（等宽字体）+ 「选择模型」按钮打开选择器浮层
- 支持手动添加 / 删除行（对标 art-canvas 的 `model-row`）
- 模型选择器浮层（`ModelPickerOverlay`）：搜索框 + 分类 tab（image/chat/video）+ 多选 + 底部「已选 N」汇总条

### 4.4 明确不搬的模块

| 模块 | 原因 |
|------|------|
| RunningHub 应用/工作流 + 工作流编辑器浮层（SVG 图编辑） | Artflow 无此后端 |
| 即梦 / GPT / Antigravity CLI 面板（登录、二维码、积分） | 无对应 CLI 后端 |
| MS LoRA 编辑器 | 未接 ModelScope 前不需要 |
| 翻译配置 | 与 AI 生图无关 |
| 火山引擎 AK/SK + 素材库项目 | 未接火山前不需要 |

> 这些占 art-canvas 该页约 **2/3** 的代码量——**不搬它们，是这次复刻能不能收敛的关键**。

---

## 五、数据与状态映射

### 5.1 前端状态（React）
```ts
providers: AIProviderProfile[];   // 来自配置卷（无密钥）
selectedId: string;               // 当前选中的 profile
dirty: boolean;                   // 是否有未保存改动
modelPicker: { open: boolean; tab: 'image'|'chat'|'video'; query: string; selected: Set<string> };
```

### 5.2 与 Artflow 机制对接

| 动作 | art-canvas 做法 | Artflow 落法 |
|------|----------------|--------------|
| 读平台列表 | `GET /api/providers`（脱敏） | 读配置卷 `AIProviderProfile[]` |
| 读 Key 状态 | `public_provider().has_key/preview` | `maskSecret(key)` → `{ hasKey, preview }` |
| 保存平台 | `PUT /api/providers` + 写 .env | 写配置卷 + `secrets-store.writeSecret` |
| 保存 Key | `saveKeyOnly()` | `secrets-store.writeSecret('ai.provider.<id>.apiKey', v)` |
| 清除 Key | `clearKeyOnly()` | `secrets-store.clearSecret(...)` |
| 测试连接 | `POST /api/providers/test-connection` | 走注入 transport 调上游 `/v1/models` |
| 拉取模型 | `POST /api/providers/fetch-models` | 同左，结果回填 `imageModels` 等 |

### 5.3 密钥安全
- **列表与详情都不下发明文**：只用 `maskSecret` 的 `{ hasKey, preview }`。
- 明文只在「用户输入 → 写密钥卷」这一个瞬间出现，回读永远脱敏。

---

## 六、视觉适配规则

| art-canvas | Artflow 适配 |
|-----------|-------------|
| 霓虹青 + 发光标题（`--neon-cyan` / `text-shadow`） | 用 Artflow 主题的强调色，**去掉发光** |
| 独立 `:root` 色板（`--bg/--panel/--soft/--line`） | 映射到 `--bp-ui-*` 变量，深浅自动推导 |
| Tailwind CDN 类名 | Artflow 既有 Tailwind + `data-bp-ui-*` 重映射 |
| 大圆角卡片（16px）+ 分隔线 | 沿用 Artflow 卡片规范（与插件管理面板一致） |
| 每行独立 styling | 收敛为 Artflow 的统一输入框 / 按钮 / 药丸样式 |

**目标观感**：信息架构与 art-canvas 一致（左列表右配置、药丸标签、脱敏 Key 行），但**看起来就是 Artflow 自己的面板**。

---

## 七、交互细节

1. **即改即用**：保存后不需要重启；provider 列表与槽注册同步刷新（对接方案 §5.5 的 register/dispose）。
2. **脱敏**：Key 输入框永不回填明文；占位显示 `已配置 · 前4••••后4`。
3. **反馈轻量**：测试结果、保存结果用**行内小徽章**，不弹 alert。
4. **行内折叠**：多凭据、高级端点等次要字段默认折叠，点击原地展开。
5. **防误触**：删除平台 / 清除 Key 需二次确认（行内确认或下拉里的红色项）。
6. **键盘**：搜索框 `/` 聚焦、`Esc` 关浮层（可选，P2）。

---

## 八、组件清单与实施顺序

### 组件树（建议）
```
AiModelsPanel                 (floating, ui_panels)
├── PanelToolbar              单行：标题 · 平台切换 · 新增 · 测试 · 保存 · ⋯ · 关闭
├── PanelBody
│   ├── ProviderList          左：平台列表 + 新增
│   └── ProviderEditor        右：配置区
│       ├── BasicFields       名称/ID/协议/地址/图片模式
│       ├── ApiKeyField       脱敏输入 + 保存/清除（多凭据时行内折叠）
│       ├── VerifyRow         测试连接 · 拉取模型 · 协议 · 模式
│       └── ModelLists        图像/对话/视频 三分区 + 选择按钮
├── ModelPickerOverlay        模型选择器浮层（搜索 + 分类 + 多选）
└── (可选) OnboardingCard     精简引导卡
```

### 实施顺序

| 步 | 交付 | 依赖 | 验证 |
|----|------|------|------|
| 1 | `ProviderList` + `BasicFields`（只读渲染配置卷） | P0（profile 数据模型） | 列表能显示配置的 provider |
| 2 | `ApiKeyField` + `maskSecret` | P0（分桶密钥） | 存/清除后脱敏正确 |
| 3 | `VerifyRow`（测试连接 + 拉取模型） | P0（transport） | 连通成功/失败有反馈 |
| 4 | `ModelLists` + `ModelPickerOverlay` | 步 3 | 拉取后可多选回填 |
| 5 | 单行工具栏 + 视觉适配 `data-bp-ui-*` | — | 深浅色都正常；检查脚本契约更新 |

> 前 4 步都建立在方案的 **P0（后端能力）**之上——没有后端，界面是空壳。

---

## 九、验收标准

- [ ] 布局为「左平台列表 + 右配置区」，顶部是**单行**工具栏（无多行堆叠）。
- [ ] 面板为**非模态可拖拽悬浮窗**（`presentation: 'floating'`），非设置弹窗内嵌。
- [ ] 全部工作于 `data-bp-ui-*` 作用域，**浅色 + 深色**均正常。
- [ ] Key 全程脱敏（列表 + 详情无明文），存/清除即时生效。
- [ ] 测试连接 / 拉取模型有行内反馈，模型可多选回填。
- [ ] art-canvas 的特化面板（RunningHub / CLI / LoRA）**未出现**。
- [ ] DOM 结构变更已同步对应 UI 检查脚本契约；`typecheck + build` 通过。

---

## 附：art-canvas 参考坐标

| 主题 | 位置 |
|------|------|
| 页面结构（侧栏 + 内容） | `api-settings.html` `#providerList` / `.content` |
| 基本信息 block | `api-settings.html` `.block`（name/base/key） |
| Key 行 + 保存/清除 | `api-settings.html` `.key-row` + `saveKeyOnly/clearKeyOnly` |
| 验证行 + 协议/模式 | `api-settings.html` `.verify-action-row` |
| 模型列表 + 拉取/选择 | `api-settings.html` `#modelsHead` + `fetchModels/openModelPicker` |
| 模型选择器浮层 | `api-settings.html` `.picker-overlay` |
| 状态与渲染逻辑 | `api-settings.js` `renderProviderList/syncEditor/updateIdPreview` |
