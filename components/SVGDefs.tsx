import React from 'react';
import { Element, ImageElement } from '../types';

interface SVGDefsProps {
  elements: Element[];
}

/** defs 真正关心的只有"带圆角的图片"：其余元素在这里都不产出任何节点。 */
const isRoundedImage = (element: Element): element is ImageElement => (
  element.type === 'image'
  && typeof element.borderRadius === 'number'
  && element.borderRadius > 0
);

/**
 * clipPath 是绝对坐标：圆角图片一动，裁剪区留在原地就会把图片裁掉，
 * 所以 memo 必须按"圆角图片的几何"判断，而不是按数组引用。
 * 这同时解决了拖动时的浪费：拖一张非圆角图片，不该重建整个 defs 子树。
 */
export const hasSameRoundedImageGeometry = (
  prev: readonly Element[],
  next: readonly Element[],
): boolean => {
  let prevIndex = 0;
  let nextIndex = 0;
  for (;;) {
    while (prevIndex < prev.length && !isRoundedImage(prev[prevIndex])) prevIndex += 1;
    while (nextIndex < next.length && !isRoundedImage(next[nextIndex])) nextIndex += 1;
    const previous = prev[prevIndex];
    const current = next[nextIndex];
    if (!previous && !current) return true;
    if (!previous || !current) return false;
    // while 已经保证走到这里的都是圆角图片；这两条同时完成类型收窄与兜底。
    if (!isRoundedImage(previous) || !isRoundedImage(current)) return false;
    if (
      previous.id !== current.id
      || previous.x !== current.x
      || previous.y !== current.y
      || previous.width !== current.width
      || previous.height !== current.height
      || previous.borderRadius !== current.borderRadius
    ) {
      return false;
    }
    prevIndex += 1;
    nextIndex += 1;
  }
};

export const SVGDefs = React.memo(({ elements }: SVGDefsProps) => {
  return (
    <defs>
      {elements.map(el => {
        // 只有带有圆角的图片才需要 clipPath
        if (isRoundedImage(el)) {
          return (
            <clipPath key={`clip-${el.id}`} id={`clip-${el.id}`}>
              <rect
                x={el.x}
                y={el.y}
                width={el.width}
                height={el.height}
                rx={el.borderRadius}
                ry={el.borderRadius}
              />
            </clipPath>
          );
        }
        return null;
      })}
    </defs>
  );
}, (prev, next) => {
  if (prev.elements === next.elements) return true;
  return hasSameRoundedImageGeometry(prev.elements, next.elements);
});