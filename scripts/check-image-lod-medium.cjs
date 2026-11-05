// Run from project root: node scripts/check-image-lod-medium.cjs
//
// 本批（ADR-049：512px 中档纹理预算）的自检。覆盖四件事：
// 1. 中档按"屏幕像素需求"选档：≤512 用中档、513 回标准档、无中档源时保持旧行为；
// 2. memo 与 hook 逐点同源（中档进 render requirement 后，两边判定仍必须一致）；
// 3. 代理生成链路：generateProxyDataUrls → fileUtils → useFileHandlers → 元素 mediumHref；
// 4. 文档 v2 持久化：mediumRef 在 locator 与元素字段之间无损往返。
// 运行：node scripts/check-image-lod-medium.cjs
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  IMAGE_LOD_CONSTANTS,
  resolveImageLODTier,
  resolveImageLODSource,
  resolveImageRenderRequirement,
} = require('../utils/imageProxy.ts');
const {
  serializeProjectDocument,
  deserializeProjectDocument,
} = require('../utils/projectDocument.ts');

const MEDIUM = IMAGE_LOD_CONSTANTS.MEDIUM_PROXY_MAX_DIMENSION;
assert.equal(MEDIUM, 512, '中档代理长边必须是 512px');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------- 1. 选档边界
console.log('\n[1] 中档按屏幕像素需求选档（够用且最小）');

const tierWithMedium = screenLongest => resolveImageLODTier({
  screenLongest,
  hasThumbnail: true,
  hasMedium: true,
  hasOriginal: true,
  isHighResAdmitted: true,
});
const tierWithoutMedium = screenLongest => resolveImageLODTier({
  screenLongest,
  hasThumbnail: true,
  hasOriginal: true,
  isHighResAdmitted: true,
});

assert.equal(tierWithMedium(200), 'thumbnail', '≤256 仍是缩略图档');
assert.equal(tierWithMedium(256), 'thumbnail', '正好 256 仍是缩略图档');
assert.equal(tierWithMedium(300), 'medium', '257~512 用中档');
assert.equal(tierWithMedium(MEDIUM), 'medium', `正好 ${MEDIUM} 仍是中档（门槛是"超过才升"）`);
assert.equal(tierWithMedium(MEDIUM + 1), 'standard', `超过 ${MEDIUM} 回到标准档`);
assert.equal(tierWithMedium(900), 'standard', '513~1023 用标准档');
assert.equal(tierWithMedium(1024), 'original', '≥1024 且已准入用原图');

// 没有中档源：行为与引入中档前完全一致（绝不返回不存在的 href 档）。
assert.equal(tierWithoutMedium(300), 'standard', '无中档源时 300px 仍是标准档（旧行为）');
assert.equal(tierWithoutMedium(900), 'standard');
assert.equal(tierWithMedium(0), 'thumbnail', '尺寸未知退回可用档');

// 缺图源的安全回退（中档缺失但有缩略图/原图）。
assert.equal(
  resolveImageLODTier({ screenLongest: 400, hasThumbnail: true, hasMedium: false, hasOriginal: false, isHighResAdmitted: false }),
  'standard',
  '没有中档源就不要选中档',
);
assert.equal(
  resolveImageLODTier({ screenLongest: 400, hasThumbnail: true, hasMedium: true, hasOriginal: false, isHighResAdmitted: false }),
  'medium',
  '有中档源就选中档（不依赖原图是否存在）',
);

// ---------------------------------------------------------------- 2. memo 与 hook 同源
console.log('\n[2] memo 口径与 hook 口径逐点一致（含中档）');

const sampleImages = Array.from({ length: 60 }, (_, i) => ({
  width: 320 + (i % 11) * 280,
  height: 240 + (i % 7) * 210,
}));
const sampleZooms = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1, 1.2, 1.6, 2.2, 3.4];

let mismatches = 0;
for (const image of sampleImages) {
  for (const zoom of sampleZooms) {
    const fromHook = resolveImageLODSource({
      zoom,
      width: image.width,
      height: image.height,
      href: 'standard',
      thumbnailHref: 'thumb',
      mediumHref: 'medium',
      originalHref: 'original',
      isHighResAdmitted: true,
    }).tier;
    const fromMemo = resolveImageRenderRequirement({
      width: image.width,
      height: image.height,
      zoom,
      hasThumbnail: true,
      hasMedium: true,
      hasOriginal: true,
    }).desiredTier;
    if (fromHook !== fromMemo) mismatches += 1;
  }
}
assert.equal(mismatches, 0, `memo 与 hook 档位判定必须逐点一致（实测 ${mismatches} 处不一致）`);
console.log(`    ${sampleImages.length} 张图 × ${sampleZooms.length} 个缩放级别，判定全部一致 ✓`);

// 交互中：中档不受"不升原图"限制（中档比标准档省，手势中降级有收益）；原图仍被禁止。
{
  const r = resolveImageLODSource({
    zoom: 0.5, width: 700, height: 500, // 屏幕 350px
    isInteracting: true,
    href: 'standard',
    thumbnailHref: 'thumb',
    mediumHref: 'medium',
    originalHref: 'original',
    isHighResAdmitted: true,
  });
  assert.equal(r.tier, 'medium', '交互中屏幕 350px 仍用中档（比 1024 标准档省纹理）');

  const big = resolveImageLODSource({
    zoom: 3, width: 700, height: 500, // 屏幕 2100px
    isInteracting: true,
    href: 'standard',
    thumbnailHref: 'thumb',
    mediumHref: 'medium',
    originalHref: 'original',
    isHighResAdmitted: true,
  });
  assert.equal(big.tier, 'standard', '交互中仍不升原图');
}

// ---------------------------------------------------------------- 3. 代理生成链路（源码守卫）
console.log('\n[3] 代理生成 → 元素字段 → memo 接线');

const proxySource = read('utils/imageProxy.ts');
assert.match(proxySource, /MEDIUM_PROXY_MAX_DIMENSION: 512/);
assert.match(proxySource, /result\.mediumDataUrl = drawTier\(/, 'generateProxyDataUrls 必须生成 512px 中档');
assert.match(proxySource, /mediumDataUrl\?: string; proxyDataUrl\?: string/, 'generateProxyDataUrls 返回值必须带 mediumDataUrl');

const fileUtilsSource = read('utils/fileUtils.ts');
assert.match(fileUtilsSource, /mediumDataUrl\?: string; \/\/ 512px/, 'ImageReadResult 必须声明 mediumDataUrl');
assert.match(fileUtilsSource, /mediumDataUrl: proxies\.mediumDataUrl/, 'fileUtils 必须把中档透传给调用方');

// The registered builtin image handler is the normal JPG/PNG drop path. It
// previously dropped both proxy fields even though fileUtils and the fallback
// importer were correct; all ordinary cards rendered at 1024px as a result.
// formats-image-doc 已迁到 editable channel：imageFrom 现由 editable-loader 注入（宿主同源），
// plugin.js 经 Artflow.host.imageFrom 调用。断言改为验证注入源 + 播种源码透传字段。
const { imageFrom } = require('../plugin-runtime/editable-loader.ts');
const pluginSource = fs.readFileSync(path.join(__dirname, '../plugins/builtin.formats-image-doc/plugin.js'), 'utf8');
assert.match(pluginSource, /host\.imageFrom/, 'editable 图像插件必须经宿主注入的 imageFrom 映射');
const parsedImage = imageFrom('actual-drop.jpg', {
  width: 2400, height: 1600, mimeType: 'image/jpeg',
  dataUrl: 'standard', thumbnailDataUrl: 'thumb', mediumDataUrl: 'medium', originalDataUrl: 'original',
});
assert.equal(parsedImage.thumbnailDataUrl, 'thumb', '格式处理器不得丢 256px 缩略图');
assert.equal(parsedImage.mediumDataUrl, 'medium', '格式处理器不得丢 512px 中档');
assert.equal(resolveImageLODSource({
  width: 400, height: 300, zoom: 1,
  href: parsedImage.dataUrl,
  thumbnailHref: parsedImage.thumbnailDataUrl,
  mediumHref: parsedImage.mediumDataUrl,
  originalHref: parsedImage.originalDataUrl,
}).tier, 'medium', '普通文件导入后 400px 卡片必须使用中档而非 1024px');

const fileHandlersSource = read('hooks/useFileHandlers.ts');
assert.match(fileHandlersSource, /mediumDataUrl: res\.mediumDataUrl/, '导入流程必须把中档带进 LoadedItem');
assert.match(fileHandlersSource, /mediumHref: asset\.mediumDataUrl/, '元素构造必须写 mediumHref');

const canvasElementSource = read('components/CanvasElement.tsx');
assert.match(canvasElementSource, /mediumHref: element\.mediumHref/, 'useImageLOD 必须拿到 mediumHref');
assert.match(canvasElementSource, /hasMedium: Boolean\(element\.mediumHref\)/, '渲染需求判定必须含 hasMedium（否则 memo 拦掉换档）');

const typesSource = read('types.ts');
assert.match(typesSource, /mediumHref\?: string;/, 'ImageElement 必须声明 mediumHref');
assert.match(typesSource, /mediumRef\?: string;/, 'AssetLocator 必须声明 mediumRef');

// ---------------------------------------------------------------- 4. 文档 v2 往返
console.log('\n[4] 文档 v2 持久化：mediumRef 无损往返');

const imageElement = {
  id: 'medium-test-image',
  type: 'image',
  x: 10,
  y: 20,
  width: 400,
  height: 300,
  href: 'data:image/jpeg;base64,proxy1024',
  thumbnailHref: 'data:image/jpeg;base64,thumb256',
  mediumHref: 'data:image/jpeg;base64,medium512',
  originalHref: 'data:image/png;base64,origFull',
  mimeType: 'image/png',
};
const board = {
  id: 'board-medium-test',
  name: 'Medium Test',
  elements: [imageElement],
  panOffset: { x: 0, y: 0 },
  zoom: 1,
  canvasBackgroundColor: '#111827',
};
const doc = serializeProjectDocument([board]);
const node = doc.nodes.find(n => n.id === 'medium-test-image');
assert.ok(node, 'image 节点必须存在');
assert.equal('mediumHref' in node.properties, false, '资产字段不得留在节点 properties（进 locator）');
const asset = doc.assets.find(a => a.id === node.assetId);
assert.ok(asset, 'image 资产必须存在');
assert.equal(asset.locator.mediumRef, 'data:image/jpeg;base64,medium512', 'mediumRef 必须进 locator');

const rehydrated = deserializeProjectDocument(doc);
const rehydratedImg = rehydrated[0].elements.find(e => e.id === 'medium-test-image');
assert.equal(rehydratedImg.mediumHref, 'data:image/jpeg;base64,medium512', 'mediumHref 必须无损还原');
assert.equal(rehydratedImg.thumbnailHref, 'data:image/jpeg;base64,thumb256');
assert.equal(rehydratedImg.originalHref, 'data:image/png;base64,origFull');

console.log('\nchecks: image-lod-medium ok\n');
