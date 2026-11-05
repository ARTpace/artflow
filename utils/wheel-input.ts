/**
 * wheel-input.ts —— 滚轮输入的归一化与缩放换算。
 *
 * 抽成纯函数是因为这里的两个数都容易"改错却不报错"：
 * - deltaMode 不折算：行模式（deltaY 只有 2~3 个单位）下滚轮几乎推不动相机；
 * - 倍率取错：一格 5% 与一格 25% 的手感差距，就是"滚到怀疑人生"和"一点就到"。
 * 两者都能被自检直接验证，不需要真机。
 */

/** 一格传统鼠标滚轮对应的 deltaY（Chromium/Windows 上的常见值）。 */
export const WHEEL_NOTCH_DELTA_PX = 100;

/**
 * 一格滚轮的缩放倍率。
 * 1.05 是"每格微调"的档位：从适应全图滚到看清细节要 4~6 格，手感发黏；
 * 这里对齐 PureRef 的量级（约 1.25/格）。
 */
export const WHEEL_ZOOM_RATIO_PER_NOTCH = 1.25;

/**
 * 把不同 deltaMode 的滚动量归一化成像素。
 * - DOM_DELTA_PIXEL(0)：原样；
 * - DOM_DELTA_LINE(1)：一行 ≈ 16px（部分鼠标驱动/触控板会给出行模式）；
 * - DOM_DELTA_PAGE(2)：保守按 100px —— 调用方拿不到视口尺寸，**取小不取大**，
 *   宁可一格只放大 25%，也不要一页直接 ×4.5 冲出缩放边界。
 */
export const normalizeWheelDelta = (delta: number, deltaMode: number): number => {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 100;
  return delta;
};

/**
 * 归一化后的 deltaY → 缩放倍率。
 *
 * 指数模型让"整格滚轮"与"触控板连续小 delta"共用同一条曲线：
 * 滚轮向上（deltaY < 0）放大，向下缩小；`resolveWheelZoomFactor(-100) === 1.25`。
 */
export const resolveWheelZoomFactor = (deltaY: number): number =>
  Math.exp(-deltaY * Math.log(WHEEL_ZOOM_RATIO_PER_NOTCH) / WHEEL_NOTCH_DELTA_PX);
