// builtin.cutout 算法核心的行为断言。纯函数，无浏览器/无图片文件需求。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const {
  MASK_CUT,
  MASK_KEEP,
  alphaToRgba,
  binaryFromAlpha,
  colorDistance,
  composeAiAlpha,
  countCut,
  createMask,
  distanceToCut,
  fillMask,
  invertMask,
  mergeMask,
  paintBrush,
  paintStroke,
  refineAlpha,
  sampleColor,
  selectByColor,
} = require('../builtin-plugins/cutout/matting.ts');

const W = 12;
const H = 8;

/** 生成 RGBA：colorOf(x,y) 返回 [r,g,b]。 */
function makeImage(width, height, colorOf) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorOf(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return data;
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

// —— 1. 颜色距离量纲：黑↔白 = 255 ——
assert.equal(Math.round(colorDistance(0, 0, 0, 255, 255, 255)), 255, 'black↔white distance must normalize to 255');
assert.equal(colorDistance(10, 20, 30, 10, 20, 30), 0, 'identical colors have zero distance');

// —— 2. 魔术棒（连续）：左半黑 / 右半白，点黑只吃掉左半 ——
{
  const pixels = makeImage(W, H, x => (x < W / 2 ? BLACK : WHITE));
  const mask = selectByColor(pixels, W, H, sampleColor(pixels, W, 0, 0), { tolerance: 0, contiguous: true }, { x: 0, y: 0 });
  assert.equal(countCut(mask), (W / 2) * H, 'contiguous wand must select exactly the connected black half');
  assert.equal(mask[0], MASK_CUT, 'seed pixel selected');
  assert.equal(mask[W - 1], MASK_KEEP, 'opposite half untouched');
}

// —— 3. 容差：0 只吃同色，≥255 吃全图 ——
{
  const pixels = makeImage(W, H, x => (x < W / 2 ? BLACK : WHITE));
  const wide = selectByColor(pixels, W, H, { r: 0, g: 0, b: 0 }, { tolerance: 255, contiguous: true }, { x: 0, y: 0 });
  assert.equal(countCut(wide), W * H, 'tolerance 255 must swallow the whole image');
  const narrow = selectByColor(pixels, W, H, { r: 0, g: 0, b: 0 }, { tolerance: 1, contiguous: true }, { x: 0, y: 0 });
  assert.equal(countCut(narrow), (W / 2) * H, 'small tolerance keeps the selection tight');
}

// —— 4. 连续 vs 全图：三块互不相连的黑块 ——
{
  const isBlack = (x, y) => {
    const inBlock = (x0, x1) => x >= x0 && x <= x1;
    return inBlock(0, 1) || inBlock(5, 6) || inBlock(10, 11);
  };
  const pixels = makeImage(W, H, (x) => (isBlack(x, 0) ? BLACK : WHITE));
  const contiguous = selectByColor(pixels, W, H, { r: 0, g: 0, b: 0 }, { tolerance: 0, contiguous: true }, { x: 0, y: 0 });
  assert.equal(countCut(contiguous), 2 * H, 'contiguous wand stops at the first block');
  const global = selectByColor(pixels, W, H, { r: 0, g: 0, b: 0 }, { tolerance: 0, contiguous: false });
  assert.equal(countCut(global), 6 * H, 'non-contiguous selection collects every matching block');
}

// —— 5. 并集/差集与脏矩形 ——
{
  const target = createMask(10, 10);
  const region = createMask(10, 10);
  region[3 * 10 + 2] = MASK_CUT;
  region[4 * 10 + 4] = MASK_CUT;
  const added = mergeMask(target, region, 10, 'add');
  assert.equal(countCut(target), 2, 'add merge writes both pixels');
  assert.deepEqual(added, { x0: 2, y0: 3, x1: 5, y1: 5 }, 'dirty rect must bound the changed pixels');
  assert.deepEqual(
    mergeMask(target, region, 10, 'add'),
    { x0: 0, y0: 0, x1: 0, y1: 0 },
    're-adding an already-cut region changes nothing',
  );

  const removed = mergeMask(target, region, 10, 'subtract');
  assert.equal(countCut(target), 0, 'subtract merge clears the same pixels');
  assert.deepEqual(removed, { x0: 2, y0: 3, x1: 5, y1: 5 }, 'subtract reports the same rect');
  assert.deepEqual(
    mergeMask(target, region, 10, 'subtract'),
    { x0: 0, y0: 0, x1: 0, y1: 0 },
    'subtracting an already-kept region changes nothing',
  );
}

// —— 6. 笔刷：圆形盖印 + 拖拽连线 ——
{
  const mask = createMask(20, 20);
  const rect = paintBrush(mask, 20, 20, 10, 10, 3, MASK_CUT);
  assert.equal(mask[10 * 20 + 10], MASK_CUT, 'brush center painted');
  assert.equal(mask[10 * 20 + 12], MASK_CUT, 'inside radius painted (pixel-center offset 2.55 ≤ 3)');
  assert.equal(mask[10 * 20 + 13], MASK_KEEP, 'outside radius untouched (pixel-center offset 3.54 > 3)');
  assert.deepEqual(rect, { x0: 6, y0: 6, x1: 14, y1: 14 }, 'brush dirty rect covers the disc');

  const stroke = createMask(40, 12);
  paintStroke(stroke, 40, 12, { x: 2, y: 6 }, { x: 36, y: 6 }, 2, MASK_CUT);
  assert.equal(stroke[6 * 40 + 19], MASK_CUT, 'stroke is continuous (no gaps between stamps)');
  assert.equal(stroke[0 * 40 + 19], MASK_KEEP, 'stroke stays within its radius');

  // 擦除/恢复走同一入口，只是写入值不同
  paintBrush(stroke, 40, 12, 19, 6, 2, MASK_KEEP);
  assert.equal(stroke[6 * 40 + 19], MASK_KEEP, 'restore brush clears the mask');
}

// —— 7. 收缩 / 羽化 ——
{
  const size = 9;
  const mask = createMask(size, size);
  const center = 4 * size + 4;
  mask[center] = MASK_CUT;

  const hard = refineAlpha(mask, size, size, { shrink: 0, feather: 0 });
  assert.equal(hard[center], 0, 'cut pixel is fully transparent');
  assert.equal(hard[4 * size + 3], 255, 'hard edge: neighbour stays opaque');

  const shrunk = refineAlpha(mask, size, size, { shrink: 1, feather: 0 });
  assert.equal(shrunk[4 * size + 3], 0, 'shrink 1 eats the orthogonal ring');
  assert.equal(shrunk[3 * size + 3], 255, 'diagonal ring (≈1.41px) survives shrink 1');

  const soft = refineAlpha(mask, size, size, { shrink: 0, feather: 2 });
  assert.equal(soft[center], 0, 'cut pixel stays 0 under feather');
  assert.ok(soft[4 * size + 3] > 0 && soft[4 * size + 3] < 255, 'feather produces a partial alpha ramp');
  assert.equal(soft[4 * size + 2], 255, 'ramp saturates at 255 past the feather width');

  const untouched = refineAlpha(createMask(size, size), size, size, { shrink: 2, feather: 2 });
  assert.ok(untouched.every(value => value === 255), 'nothing cut ⇒ every pixel fully opaque');

  const distance = distanceToCut(mask, size, size);
  assert.equal(distance[center], 0, 'distance to nearest cut pixel is 0 at the cut pixel');
  assert.equal(distance[4 * size + 3], 1, 'orthogonal neighbour distance is 1');
  assert.ok(Math.abs(distance[3 * size + 3] - Math.SQRT2) < 0.01, 'diagonal neighbour distance is √2');
}

// —— 8. 反相 / 清空 / tint ——
{
  const mask = createMask(4, 4);
  assert.equal(countCut(mask), 0);
  invertMask(mask);
  assert.equal(countCut(mask), 16, 'invert turns an empty mask into a full selection');
  invertMask(mask);
  assert.equal(countCut(mask), 0, 'invert is its own inverse');
  fillMask(mask, MASK_CUT);
  assert.equal(countCut(mask), 16);
  fillMask(mask, MASK_KEEP);
  assert.equal(countCut(mask), 0);

  const rgba = alphaToRgba(new Uint8Array([0, 128, 255]));
  assert.deepEqual([rgba[0], rgba[1], rgba[2], rgba[3]], [255, 72, 72, 0], 'tint rgb + alpha 0');
  assert.equal(rgba[7], 128, 'alpha value carried through');
  assert.equal(rgba[11], 255);
}

// —— 9. 非法种子点不炸 ——
{
  const pixels = makeImage(4, 4, () => WHITE);
  assert.equal(countCut(selectByColor(pixels, 4, 4, WHITE, { tolerance: 0, contiguous: true }, { x: -1, y: 0 })), 0, 'out-of-range seed selects nothing');
  assert.throws(() => selectByColor(pixels, 4, 4, WHITE, { tolerance: 0, contiguous: true }), /seed/, 'contiguous selection without a seed throws');
}

// —— 10. AI 软边基底：二进制化阈值 + 取严合成 ——
{
  // 阈值语义：>= threshold 视为保留。
  const alpha = new Uint8Array([0, 1, 127, 128, 200, 255]);
  assert.deepEqual(
    Array.from(binaryFromAlpha(alpha)),
    [MASK_CUT, MASK_CUT, MASK_CUT, MASK_KEEP, MASK_KEEP, MASK_KEEP],
    'binaryFromAlpha keeps pixels at or above the threshold',
  );
  assert.deepEqual(
    Array.from(binaryFromAlpha(alpha, 1)),
    [MASK_CUT, MASK_KEEP, MASK_KEEP, MASK_KEEP, MASK_KEEP, MASK_KEEP],
    'threshold is inclusive and configurable',
  );

  // 取严规则：二进制判抠掉压过 AI；保留处让 AI 的软值透出来。
  const refined = new Uint8Array([0, 0, 255, 255]);
  const aiBase = new Uint8Array([255, 128, 0, 200]);
  assert.deepEqual(
    Array.from(composeAiAlpha(refined, aiBase)),
    [0, 0, 0, 200],
    'compose takes the stricter value: binary cut wins, kept pixels inherit AI soft alpha',
  );

  // 无基底时原样返回（纯本地路径行为不变）。
  const passthrough = composeAiAlpha(refined, null);
  assert.equal(passthrough, refined, 'null AI base returns the refined array untouched');

  // 长度不一致视为无基底，避免错位合成出鬼影边缘。
  assert.equal(composeAiAlpha(refined, new Uint8Array(2)), refined, 'length mismatch is treated as no AI base');

  // 全保留的二进制层 + AI 软边 ⇒ 结果就是 AI 软边（软边不会被"什么都不做"抹平）。
  const keepAll = createMask(4, 1);
  fillMask(keepAll, MASK_KEEP);
  const hard = refineAlpha(keepAll, 4, 1, { shrink: 0, feather: 0 });
  assert.deepEqual(
    Array.from(composeAiAlpha(hard, new Uint8Array([0, 64, 192, 255]))),
    [0, 64, 192, 255],
    'AI soft edge survives composition when the binary layer keeps everything',
  );
}

console.log('check-cutout-matting: all assertions passed');
