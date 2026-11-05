# FDD-031：Phase Perf1 交互帧合并与启动按需加载

- 状态：verified
- 日期：2026-09-22
- 轮次：R31
- ADR：`ADR-031-交互帧预算与按需重型模块边界.md`

## 1. 问题

用户可感知卡顿集中在两条路径：

- 拖动、缩放、绘制、平移时，pointer event 频率高于刷新率，每个 event 都可能触发全 App render 与 viewport cache update；
- 应用启动静态加载并解析与当前画布无关的 Three.js、模型 loader、PSD/PDF/RAW/TIFF decoder 和全部 builtin cards。

现有 benchmark 还暴露 R11 mutable query 为排序结果扫描全部 `order`，sparse update 对同一 10k 数组进行多次结构遍历。

## 2. 用户故事

1. 作为画布用户，我希望拖动、缩放和绘制不会因为高采样率鼠标而产生额外抖动。
2. 作为普通图片/文本用户，我不应在启动时支付 3D、PSD、PDF 等未使用能力的下载、解析与内存成本。
3. 作为开发者，我需要保留现有插件注册、格式路由、selection/snap/parenting 和保存语义。

## 3. 实现范围

### 3.1 Pointer frame coalescing

文件：`hooks/useCanvasInteractions.ts`

- 新增 latest-sample queue 与单一 RAF token；
- 一帧只执行一次 `processMouseMove`；
- 新 gesture 清理旧 token；unmount 清理 RAF/timeout；
- mouseup 先 flush pending sample，再执行 commit；
- AI rotate、selection box、lasso 使用同步 transient ref，保证 flush 后的最终状态可读取。

### 3.2 R11 hot-path reduction

文件：`utils/viewport-index.ts`

- mutable index 维护 `orderById`；
- query 只排序 candidate ids，再做 exact intersection；
- incremental update 单遍验证 flat structure 并收集 changed object references；
- group、duplicate、length/id/order change 仍进入既有 rebuild。

### 3.3 Visible SVG defs

文件：`components/MainCanvas.tsx`

- `SVGDefs` 输入从所有 elements 改为 `visibleElements`；
- 可见 rounded image 仍生成相同 clip path；离屏未挂载元素不生成无用 defs。

### 3.4 Startup code splitting

文件：

- `builtin/cards/index.tsx`
- `components/CanvasElement.tsx`
- `builtin/formats-image-doc/index.ts`
- `hooks/useFileHandlers.ts`
- `utils/fileUtils.ts`
- `utils/formatDetector.ts`
- `utils/model3dFormats.ts`
- `utils/model3dUtils.ts`

行为：

- builtin card contribution id/type 不变，component 改为 lazy；
- card host 增加局部 Suspense loading placeholder；
- format parser 与 file utility 改为 parse/import 时动态加载；
- 3D extension detection 与 Three.js implementation 分离；
- TIFF/RAW/PSD decoder 二级按格式加载。

## 4. 验收条件

- TypeScript gate exit 0；
- foundation suite exit 0，且检查 RAF scheduling、mouseup flush、R14 exact candidate wiring；
- production build exit 0；
- 10k viewport benchmark exact result equality 保持；
- cached sparse update/query 相比本轮基线显著下降；
- initial entry 不再包含 PSD/PDF/UTIF/Three.js；
- card/handler ids、plugin activation、storage/IPC capability count 不变。

## 5. 验证结果

2026-09-22 远端验证：

- `npm --prefix artflow run typecheck`：exit 0；
- `npm --prefix artflow run check:foundations`：exit 0；
- `npm --prefix artflow run build`：exit 0；
- `npm --prefix artflow run benchmark:viewport`：exact result equality，cache `22.67 ms`、speedup `7.17x`；
- 初始 entry `811.01 kB / 214.27 kB gzip`，重型 parser/card 成为异步 chunk。

对比修改前同一会话证据：cache `99.34 ms / 1.69x`；entry `2788.70 kB / 769.61 kB gzip`。

## 6. 非目标

不实现真正 transient transform overlay / normalized entity state、Hybrid renderer、Worker/tile live viewport service、group incremental invalidation、side-panel virtualization、media concurrency budget、parser Worker 或 import transaction/retry。它们仍是后续独立工作流。
