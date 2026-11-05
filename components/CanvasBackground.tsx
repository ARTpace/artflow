import React from 'react';

/**
 * 点阵与对齐网格画在视口大小的 CSS 层上，不进相机 `<g>`。
 *
 * 以前它们是相机层里 400000×400000 的 SVG pattern 矩形。那一层带
 * will-change:transform，缩放时合成器按整层重栅格，点阵和全部图片被画进同一次
 * 光栅（日志里的突然掉帧：脚本 0ms、渲染管线 50–190ms）。
 * 屏幕层只覆盖视口，位置由 MainCanvas 的 live 相机通道直接写，不经过 React。
 */

/**
 * 点阵整条背景图由主题提供：皮肤用 canvas.dotColor / dotSize / dotOpacity / dots
 * 声明，用户可在主题工作台覆盖，关闭时引擎写入 none。
 *
 * 变量未写入时的回落值 = 迁移前写死的点阵（半径 5%、硬边 5.6%、灰 400 @ 50%），
 * 因此默认视觉与 token 化之前完全一致。
 *
 * 圆点用格子的百分比，不用固定 1px。
 * background-size 跟着缩放变小时，点本身也变小（和以前 SVG pattern 的 r=1 / 间距 20 一样）。
 * 固定 1px 时缩得越小点越挤，整屏会变成密点。
 * 5% = 1/20：点半径 1 个世界单位，格子 20 个世界单位，点心在格子左上角。
 */
const DOTS_FALLBACK =
  'radial-gradient(circle at 5% 5%, rgb(156 163 175 / 0.5) 0 5%, transparent 5.6%)';
const GRID_WIDTH = 'var(--bp-canvas-grid-width, 1px)';
const LINES = [
  `linear-gradient(to right, var(--bp-canvas-grid, rgba(255,255,255,0.09)) ${GRID_WIDTH}, transparent ${GRID_WIDTH})`,
  `linear-gradient(to bottom, var(--bp-canvas-grid, rgba(255,255,255,0.09)) ${GRID_WIDTH}, transparent ${GRID_WIDTH})`,
].join(',');

export const CanvasBackdrop = React.forwardRef<HTMLDivElement, { active: boolean }>(
  function CanvasBackdrop({ active }, ref) {
    if (!active) return null;
    return (
      <div
        ref={ref}
        data-canvas-backdrop=""
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: `var(--bp-canvas-dot-image, ${DOTS_FALLBACK})`, backgroundRepeat: 'repeat' }}
      />
    );
  },
);

export const CanvasScreenGrid = React.forwardRef<HTMLDivElement, { active: boolean }>(
  function CanvasScreenGrid({ active }, ref) {
    if (!active) return null;
    return (
      <div
        ref={ref}
        data-canvas-screen-grid=""
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: LINES, backgroundRepeat: 'repeat' }}
      />
    );
  },
);
