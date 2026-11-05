# ADR-036：多级图片 LOD 与 LRU 代理系统

- 状态：verified
- 日期：2026-09-22
- 轮次：R36 / Phase Image LOD (REQ-003)
- 关联：`FDD-036-PhaseImageLOD-多级图片代理与纹理管控.md`

## 背景

无限画布中海量高分辨率参考图（PureRef 级海量资产工作流）常导致浏览器显存（GPU VRAM）爆仓与主线程掉帧。《需求文档.md》REQ-003 要求实现：
1. 导入时除原图外，自动生成 256px 缩略图代理与 1024px 标准显示代理；
2. 画布缩放级别动态分级加载（远景小图用 256px，正常视图用 1024px，放大查看细节时加载原图）；
3. 超出视口的离屏图片自动释放 GPU 纹理/DOM 占用（通过占位或卸载）；
4. 建立 LRU 缓存池限制内存中同时保留的原图数量（上限 50 张），超出自动降级为代理图；
5. 纯前端离线可用，不依赖服务端处理。

## 决策

1. **三级 LOD 缩放阶梯与纯函数裁决**：
   - 远景级（`zoom < 0.25`）：激活 256px 缩略图代理（`thumbnailHref`），极致轻量；
   - 标准级（`0.25 <= zoom <= 1.0` 或交互拖拽缩放中）：锁定 1024px 标准显示代理（`href`），确保 60fps 交互丝滑；
   - 细节级（`zoom > 1.0` 且静止）：在获准 LRU 配额下激活原始高清大图（`originalHref`）。
   - 将裁决逻辑抽象为纯函数 `resolveImageLODSource`，脱离 DOM，确保跨环境 100% 可测。

2. **双代理自动离线生成（Pure-client Canvas Pipeline）**：
   - 在 `utils/imageProxy.ts` 与 `utils/fileUtils.ts` 内构建纯前端双代理生成管道：
     - 若图片最大边长超过 1024px，绘制 Canvas 压缩输出 1024px 显示代理；
     - 若图片最大边长超过 256px，绘制 Canvas 压缩输出 256px 缩略图代理；
     - 原图数据无损保存在 `originalHref` / `originalDataUrl`；
     - 全格式覆盖：通用图片（PNG/JPG/WebP）、PSD（复合图层）、SVG（矢量自适应）、TIFF、TGA、EXR、RAW 等全部自动就绪。

3. **50 张高清原图 LRU 纹理预算池（Bounded High-Res Cache）**：
   - 设计单例 `ImageLRUCache`（默认上限 `FULL_RES_LRU_CAPACITY = 50`）：
   - 当画面缩放到 `zoom > 1.0` 时，视口内可见的高清图片通过 `useImageLOD` Hook 申请高清席位；
   - 若超出 50 张上限，最早查看的高清图片被 LRU 驱逐并立即降级回 1024px 显示代理；
   - 元素滑出视口或组件卸载时立即 `release(elementId)`，主动归还配额。

4. **视口裁剪与离屏 GPU 纹理自动释放**：
   - 依赖内核 `MainCanvas` 的 R-Tree/SpatialIndex 空间查询，视口范围外的元素不进入 DOM 树；
   - 离屏图片由于从 React 虚拟 DOM 和 SVG 树中卸载，浏览器底层图形引擎自动释放 GPU 纹理显存；
   - 同时触发 `useImageLOD` 卸载清理钩子，释放 LRU 引用。

5. **数据契约与持久化兼容（Zero-breaking Contract Evolution）**：
   - `ImageElement` 新增可选字段 `thumbnailHref?: string`；
   - `FormatImageResult` 新增可选字段 `thumbnailDataUrl?: string`；
   - `AssetLocator` 新增可选字段 `thumbnailRef?: string`；
   - `projectDocument.ts` 将 `thumbnailHref` 纳入 Asset 独立持久化管道，与 `href`、`originalHref` 并列管理；
   - 保持严格向后兼容性，旧版本文档反序列化不受影响，无缝降级。

## 效果与影响

- **显存与内存暴降**：在画布加载数百张数千万像素单反/设计图时，视口内仅维持极少量的 1024px 标准图与至多 50 张高清图，远景时内存占用仅为原本的 1/16 甚至更低。
- **60fps 恒定交互**：用户拖动画布或快速缩放时，强制使用 1024px 或 256px 代理，杜绝多兆大图重排丢帧。
- **构建与测试**：新增 `runImageLODChecks` 自动化测试集，全量基准测试与内核基础测试 100% 通过。
