/**
 * builtin/cutout/matting.ts —— 本地抠图算法核心。
 *
 * 设计约束：
 * 1. 纯函数 + 显式缓冲区（Uint8Array/Uint8ClampedArray），不依赖 DOM / React，可被 Node self-check 直接 require；
 * 2. 掩码语义统一：MASK_CUT=1 表示"抠掉（变透明）"，MASK_KEEP=0 表示"保留"；
 * 3. 所有距离/容差量纲都是 0..255（与容差滑杆同量纲），避免 UI 层换算；
 * 4. 视图缩放与分辨率缩放不属于这里 —— 编辑器在"工作分辨率"上调用本模块，应用时再整体缩放回原尺寸。
 */

export const MASK_KEEP = 0 as const;
export const MASK_CUT = 1 as const;

/** 矩形（左闭右开语义按 max 闭包处理，统一用 x0..x1 含端点 + 1 的写法见 clampRect）。 */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const createMask = (width: number, height: number): Uint8Array => new Uint8Array(width * height);

export const countCut = (mask: Uint8Array): number => {
  let cut = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] === MASK_CUT) cut += 1;
  return cut;
};

export const invertMask = (mask: Uint8Array): Uint8Array => {
  for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] === MASK_CUT ? MASK_KEEP : MASK_CUT;
  return mask;
};

export const fillMask = (mask: Uint8Array, value: number): Uint8Array => {
  mask.fill(value === MASK_CUT ? MASK_CUT : MASK_KEEP);
  return mask;
};

export const sampleColor = (rgba: Uint8ClampedArray, width: number, x: number, y: number): Rgb => {
  const index = (y * width + x) * 4;
  return { r: rgba[index], g: rgba[index + 1], b: rgba[index + 2] };
};

/** 欧氏距离按 √3 归一化：三通道满差 = 255，与容差滑杆的 0..255 同尺度。 */
export const colorDistance = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number => {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
};

export interface ColorSelectOptions {
  /** 0..255；0 = 只选完全同色，255 = 全选。 */
  tolerance: number;
  /** true = 只选与种子连通的区域（魔术棒）；false = 全图同色像素（按颜色选择）。 */
  contiguous: boolean;
}

/**
 * 按颜色生成选区掩码（不修改既有掩码，由调用方决定并集/差集）。
 * 连续模式使用扫描线 flood fill：每个像素最多入栈一次，O(n) 且不递归。
 */
export const selectByColor = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  color: Rgb,
  options: ColorSelectOptions,
  seed?: { x: number; y: number },
): Uint8Array => {
  const mask = createMask(width, height);
  const tolerance = Math.max(0, options.tolerance);
  const within = (index: number): boolean =>
    colorDistance(rgba[index * 4], rgba[index * 4 + 1], rgba[index * 4 + 2], color.r, color.g, color.b) <= tolerance;

  if (!options.contiguous) {
    for (let i = 0; i < mask.length; i += 1) if (within(i)) mask[i] = MASK_CUT;
    return mask;
  }

  if (!seed) throw new Error('contiguous selection requires a seed point');
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask;

  const visited = new Uint8Array(width * height);
  const seedIndex = sy * width + sx;
  if (!within(seedIndex)) return mask;

  /** 跨度栈：每个元素是 [行号, 起始列, 结束列]，入栈即落盘（visited + mask）。 */
  const stack: Array<[number, number, number]> = [];
  const pushSpan = (y: number, x: number): void => {
    const base = y * width;
    let left = x;
    while (left > 0 && !visited[base + left - 1] && within(base + left - 1)) left -= 1;
    let right = x;
    while (right < width - 1 && !visited[base + right + 1] && within(base + right + 1)) right += 1;
    for (let k = left; k <= right; k += 1) {
      visited[base + k] = MASK_CUT;
      mask[base + k] = MASK_CUT;
    }
    stack.push([y, left, right]);
  };

  pushSpan(sy, sx);

  while (stack.length > 0) {
    const [y, left, right] = stack.pop() as [number, number, number];
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const base = ny * width;
      let x = left;
      while (x <= right) {
        const candidate = base + x;
        if (within(candidate) && !visited[candidate]) {
          // 找到一段新的连通区：先向两侧扩到位，再整段入栈。
          let runLeft = x;
          while (runLeft > 0 && !visited[base + runLeft - 1] && within(base + runLeft - 1)) runLeft -= 1;
          let runRight = x;
          while (runRight < width - 1 && !visited[base + runRight + 1] && within(base + runRight + 1)) runRight += 1;
          for (let k = runLeft; k <= runRight; k += 1) {
            visited[base + k] = MASK_CUT;
            mask[base + k] = MASK_CUT;
          }
          stack.push([ny, runLeft, runRight]);
          x = runRight + 1;
        } else {
          x += 1;
        }
      }
    }
  }

  return mask;
};

/** 把选区按 add/subtract 合并进目标掩码，返回受影响矩形（供增量重绘）。 */
export const mergeMask = (
  target: Uint8Array,
  source: Uint8Array,
  width: number,
  mode: 'add' | 'subtract',
): Rect => {
  const union: Rect = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1, y1: -1 };
  const next = mode === 'add' ? MASK_CUT : MASK_KEEP;
  for (let i = 0; i < target.length; i += 1) {
    if (source[i] !== MASK_CUT || target[i] === next) continue;
    target[i] = next;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < union.x0) union.x0 = x;
    if (y < union.y0) union.y0 = y;
    if (x + 1 > union.x1) union.x1 = x + 1;
    if (y + 1 > union.y1) union.y1 = y + 1;
  }
  return isEmptyRect(union) ? { x0: 0, y0: 0, x1: 0, y1: 0 } : union;
};

const clampRect = (rect: Rect, width: number, height: number): Rect => ({
  x0: Math.max(0, Math.min(width, Math.floor(rect.x0))),
  y0: Math.max(0, Math.min(height, Math.floor(rect.y0))),
  x1: Math.max(0, Math.min(width, Math.ceil(rect.x1))),
  y1: Math.max(0, Math.min(height, Math.ceil(rect.y1))),
});

export const isEmptyRect = (rect: Rect): boolean => rect.x1 <= rect.x0 || rect.y1 <= rect.y0;

/** 圆形笔刷盖印；返回脏矩形（已按画布裁剪）。 */
export const paintBrush = (
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): Rect => {
  const v = value === MASK_CUT ? MASK_CUT : MASK_KEEP;
  const r = Math.max(0.5, radius);
  const rect = clampRect({ x0: cx - r - 1, y0: cy - r - 1, x1: cx + r + 1, y1: cy + r + 1 }, width, height);
  const r2 = r * r;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const dy = y + 0.5 - cy;
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = v;
    }
  }
  return rect;
};

/** 沿线段连续盖印（步长 ≤ 半径/2，保证快速拖动不断线）；返回合并脏矩形。 */
export const paintStroke = (
  mask: Uint8Array,
  width: number,
  height: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  value: number,
): Rect => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const step = Math.max(1, Math.max(0.5, radius) / 2);
  const steps = Math.max(1, Math.ceil(distance / step));
  const union: Rect = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1, y1: -1 };
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const rect = paintBrush(mask, width, height, from.x + dx * t, from.y + dy * t, radius, value);
    union.x0 = Math.min(union.x0, rect.x0);
    union.y0 = Math.min(union.y0, rect.y0);
    union.x1 = Math.max(union.x1, rect.x1);
    union.y1 = Math.max(union.y1, rect.y1);
  }
  return isEmptyRect(union) ? { x0: 0, y0: 0, x1: 0, y1: 0 } : union;
};

const INFINITE_DISTANCE = 1e9;

/**
 * 到最近"被抠除像素"的倒角距离变换（3-4/对角线 √2），单位 = 工作分辨率像素。
 * 用于收缩与羽化：被抠除区域距离 0，主体内部距离为正。
 */
export const distanceToCut = (mask: Uint8Array, width: number, height: number): Float32Array => {
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i += 1) dist[i] = mask[i] === MASK_CUT ? 0 : INFINITE_DISTANCE;
  const diagonal = Math.SQRT2;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      let best = dist[i];
      if (best === 0) continue;
      if (y > 0) {
        best = Math.min(best, dist[i - width] + 1);
        if (x > 0) best = Math.min(best, dist[i - width - 1] + diagonal);
        if (x < width - 1) best = Math.min(best, dist[i - width + 1] + diagonal);
      }
      if (x > 0) best = Math.min(best, dist[i - 1] + 1);
      dist[i] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = row + x;
      let best = dist[i];
      if (best === 0) continue;
      if (y < height - 1) {
        best = Math.min(best, dist[i + width] + 1);
        if (x > 0) best = Math.min(best, dist[i + width - 1] + diagonal);
        if (x < width - 1) best = Math.min(best, dist[i + width + 1] + diagonal);
      }
      if (x < width - 1) best = Math.min(best, dist[i + 1] + 1);
      dist[i] = best;
    }
  }

  return dist;
};

export interface RefineOptions {
  /** 收缩像素数：主体边缘向内收，用来吃掉残留的背景描边/白边。 */
  shrink: number;
  /** 羽化像素数：边缘过渡带宽（0 = 硬边）。 */
  feather: number;
}

/**
 * 掩码 → alpha（0..255）。
 * 规则：被抠除处恒 0；主体内距边缘 d 的像素在 d ≤ shrink 时 0，之后按 feather 线性升到 255。
 */
export const refineAlpha = (
  mask: Uint8Array,
  width: number,
  height: number,
  options: RefineOptions,
): Uint8Array => {
  const shrink = Math.max(0, options.shrink);
  const feather = Math.max(0, options.feather);
  const alpha = new Uint8Array(width * height);

  if (shrink === 0 && feather === 0) {
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = mask[i] === MASK_CUT ? 0 : 255;
    return alpha;
  }

  const dist = distanceToCut(mask, width, height);
  for (let i = 0; i < alpha.length; i += 1) {
    if (mask[i] === MASK_CUT) {
      alpha[i] = 0;
      continue;
    }
    const d = dist[i];
    if (d >= INFINITE_DISTANCE) {
      // 全图无抠除像素（或本像素离得无穷远）：完全不透明。
      alpha[i] = 255;
      continue;
    }
    if (d <= shrink) {
      alpha[i] = 0;
      continue;
    }
    if (feather <= 0) {
      alpha[i] = 255;
      continue;
    }
    const t = (d - shrink) / feather;
    alpha[i] = t >= 1 ? 255 : Math.round(255 * t);
  }
  return alpha;
};

/** 取源像素子集（脏矩形）以便 putImageData 增量更新。 */
export const readRgbaRect = (
  rgba: Uint8ClampedArray,
  width: number,
  rect: Rect,
): Uint8ClampedArray => {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcStart = ((rect.y0 + y) * width + rect.x0) * 4;
    out.set(rgba.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return out;
};

/** alpha → 画布像素（RGB 固定 tint，A = alpha），供遮罩可视化与 preview 的 destination-in 复用。 */
export const alphaToRgba = (
  alpha: Uint8Array,
  tint: Rgb = { r: 255, g: 72, b: 72 },
): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i += 1) {
    const p = i * 4;
    out[p] = tint.r;
    out[p + 1] = tint.g;
    out[p + 2] = tint.b;
    out[p + 3] = alpha[i];
  }
  return out;
};

/**
 * AI 软边 alpha（0..255 连续值）→ 二进制掩码。
 * 只用于「让用户看得见、能继续用笔刷编辑」与统计口径；真实软边留在 aiAlpha 基底里，
 * 由 composeAiAlpha 在导出时合成，所以这里的阈值不会毁掉半透明过渡。
 */
export const binaryFromAlpha = (alpha: Uint8Array, threshold = 128): Uint8Array => {
  const mask = new Uint8Array(alpha.length);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = alpha[i] >= threshold ? MASK_KEEP : MASK_CUT;
  }
  return mask;
};

/**
 * 二进制编辑层与 AI 软边基底的合成（取严）。
 *
 * - mask 判定抠掉 → refined 为 0 → 结果 0（笔刷"擦除/抠掉"即时生效，压得住 AI）；
 * - mask 判定保留 → refined 为 255（或收缩/羽化值）→ 结果取 min(255, aiAlpha) = aiAlpha，
 *   即软边过渡完整保留。
 *
 * 这样「哪里抠掉」由二进制主导、「保留处多透明」由 AI 主导，两层不互相覆盖。
 * aiAlpha 为 null 时退化为纯本地语义（等同旧行为）。
 */
export const composeAiAlpha = (refined: Uint8Array, aiAlpha: Uint8Array | null): Uint8Array => {
  if (!aiAlpha || aiAlpha.length !== refined.length) return refined;
  const out = new Uint8Array(refined.length);
  for (let i = 0; i < out.length; i += 1) {
    const binary = refined[i];
    const ai = aiAlpha[i];
    out[i] = binary < ai ? binary : ai;
  }
  return out;
};
