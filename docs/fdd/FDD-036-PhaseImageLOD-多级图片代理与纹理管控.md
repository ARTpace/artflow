# FDD-036：Phase Image LOD 多级图片代理与纹理管控

- 状态：verified
- 日期：2026-09-22
- 轮次：R36 (REQ-003)
- ADR：`ADR-036-多级图片LOD与LRU代理系统.md`

## 1. 问题与目标

用户在将大量高分辨率大图（数码相机 RAW/JPG、4K/8K 概念设计原图、多图层 PSD）导入无限画布时，面临以下痛点：
1. 显存膨胀与崩溃：浏览器无法承受同时解码渲染数十张乃至数百张原始尺寸巨图；
2. 拖拽缩放严重卡顿：大图重绘耗时远超 16.6ms 帧预算；
3. 视口外持续霸占显存。

本特性严格遵循 PureRef 标杆体验，建立纯前端多级代理生成、分级动态加载、视口剔除与 50 张 LRU 原图硬限制。

## 2. 详细设计与实现清单

### 2.1 契约层扩展 (`types.ts` & `plugins/format-handlers.ts`)
- `ImageElement`：新增 `thumbnailHref?: string`（256px 缩略图代理）；
- `AssetLocator`：新增 `thumbnailRef?: string`（支持 Project Document v2 持久化）；
- `FormatImageResult`：新增 `thumbnailDataUrl?: string`，与现有插件完全向后兼容。

### 2.2 核心算法与管道 (`utils/imageProxy.ts`)
- **常量定义**：
  - `THUMBNAIL_MAX_DIMENSION = 256`
  - `STANDARD_PROXY_MAX_DIMENSION = 1024`
  - `FULL_RES_LRU_CAPACITY = 50`
  - `FAR_ZOOM_THRESHOLD = 0.25`
  - `DETAIL_ZOOM_THRESHOLD = 1.0`
- **尺寸计算器**：`computeScaledDimensions(origWidth, origHeight, maxDim)`，安全计算等比缩放且不放大；
- **LOD 决断器**：`resolveImageLODSource(options)`：
  - `isInteracting === true` -> `standard` 代理；
  - `zoom < 0.25` -> `thumbnail` 代理（如无则回退 `standard`）；
  - `zoom > 1.0 && originalHref && isHighResAdmitted` -> `original` 原图；
  - 其他场景 -> `standard` 代理。
- **LRU 缓存管理器**：`ImageLRUCache` 具备 `request`, `release`, `evict`, `subscribe`, `size`, `getCapacity` 等标准操作，淘汰策略严格按最久未访问（LRU）原则触发降级；
- **React Hook**：`useImageLOD(elementId, options)`，自动绑定 `globalImageLRUCache` 并在组件挂载、缩放跨界、视口离开卸载时自动同步配额；
- **前端生成器**：`generateProxyDataUrls(img, width, height, mimeType)`，纯离线通过 Canvas 导出 1024px 标准图与 256px 缩略图。

### 2.3 资产导入与格式扩展 (`utils/fileUtils.ts` & `hooks/useFileHandlers.ts`)
- `fileUtils.ts` 中的 `readAndCompressImage`：
  - 通用格式（PNG/JPG/WebP/BMP 等）：统一产生 1024px 代理、256px 缩略图并保留大图原数据；
  - 特殊专业格式（PSD/TIFF/TGA/EXR/RAW）：解析后同样接入代理生成管线；
  - SVG 格式：自适应无损缩放，安全映射；
- `useFileHandlers.ts`：图片导入及 Masonry 排版时完整填入 `href`, `thumbnailHref`, `originalHref`。

### 2.4 渲染器深度集成 (`components/CanvasElement.tsx`)
- 提取专职 `ImageCanvasElement` 组件，消除原本在 `switch` 中违规使用 Hook 的隐患；
- 对接 `useImageLOD`，将计算后的 `currentSrc` 与 `data-lod-tier` 赋予 `<image>` SVG 节点；
- 优化 `React.memo` 比较器：在 0.25 与 1.0 之间无视中间微弱 zoom 变化，仅在跨越 LOD 阶梯或交互启停时重绘。

### 2.5 文档持久化桥接 (`utils/projectDocument.ts`)
- 将 `thumbnailHref` 登记入 `assetFieldsByNodeType.image`；
- 在 `locatorForElement` 和 `assetFieldsForNode` 中完成 `thumbnailRef` 的保存与反序列化复原。

## 3. 验收标准执行情况

1. [x] 导入时除原图外，自动生成 256px 缩略图代理与 1024px 标准显示代理；
2. [x] 画布缩放级别动态分级加载（远景小图用 256px，正常视图用 1024px，放大查看细节时加载原图）；
3. [x] 超出视口的离屏图片自动释放 GPU 纹理/DOM 占用（结合 SpatialIndex 动态挂载/卸载与 Hook 清理）；
4. [x] 建立 LRU 缓存池限制内存中同时保留的原图数量（上限 50 张），超出自动降级为代理图；
5. [x] 纯前端离线可用，不依赖服务端处理；
6. [x] 自动化测试 `runImageLODChecks` 100% 通过；生产构建与 5 项性能基准测试 100% 通过。
