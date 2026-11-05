/**
 * gesture-transform.ts —— 手势"几何变换"的纯逻辑（P1-1）。
 *
 * 三件事，都是纯函数（无 React、无 store、无副作用），方便被 self-check 直接调用：
 * 1) resolveRotatedElement / resolveResizedElement：把"起始元素 + 本次手势参数"
 *    算成"预览元素"。**帧预览与松手提交共用同一份**，所以绝不出现"松手跳一下"。
 * 2) applyGesturePreview：把预览元素替换进一个元素数组（可见集/呈现集），
 *    没命中就原样返回同一引用 —— 上层用引用相等判断"在不在预览态"。
 * 3) ResizeGestureGeometry：缩放那次数学运算的结果快照，供上面的构造复用。
 *
 * 注意：这里**不修改原数组、也不修改原元素**；返回的都是新对象，文档状态零污染。
 */
import type { ArrowElement, Element, LineElement, PathElement, Point, Rect } from '../types';
import { isBoxElement } from './canvasUtils';

/** 缩放几何：一次缩放手势算出来的最终外框与各向缩放比。 */
export interface ResizeGestureGeometry {
    /** 起始外框（局部坐标下的原始 bounds），用于折算点集等"相对几何"。 */
    readonly bounds: Rect;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scaleX: number;
    readonly scaleY: number;
}

/** 取元素当前旋转角（不是所有元素类型都有 rotation）。 */
const readRotation = (element: Element): number =>
    'rotation' in element && typeof (element as { rotation?: unknown }).rotation === 'number'
        ? (element as { rotation: number }).rotation
        : 0;

/**
 * 旋转预览：角度没变（指针还在原处）时返回原元素**同一引用**，
 * 调用方据此跳过预览发布与降档，避免"点了手柄没动也一次写入"。
 */
export const resolveRotatedElement = (original: Element, rotation: number): Element => {
    if (readRotation(original) === rotation) return original;
    return { ...original, rotation } as Element;
};

/**
 * 缩放预览：与旧逐帧写法逐字等价的几何构造，只是**不落文档**。
 * - path：按起始 bounds 折算每个点；
 * - arrow / line：折算两个端点；
 * - 其余盒模型（image / shape / text / frame / …）：直接换外框。
 * 组元素与无盒模型信息的元素原样返回（旧代码同样跳过）。
 */
export const resolveResizedElement = (original: Element, geometry: ResizeGestureGeometry): Element => {
    const { bounds, x, y, width, height, scaleX, scaleY } = geometry;
    switch (original.type) {
        case 'path': {
            const newPoints = (original as PathElement).points.map(point => ({
                x: x + (point.x - bounds.x) * scaleX,
                y: y + (point.y - bounds.y) * scaleY,
            }));
            return { ...original, points: newPoints };
        }
        case 'arrow':
        case 'line': {
            const source = original as ArrowElement | LineElement;
            const newEndpoints: [Point, Point] = [
                {
                    x: x + (source.points[0].x - bounds.x) * scaleX,
                    y: y + (source.points[0].y - bounds.y) * scaleY,
                },
                {
                    x: x + (source.points[1].x - bounds.x) * scaleX,
                    y: y + (source.points[1].y - bounds.y) * scaleY,
                },
            ];
            return { ...original, points: newEndpoints };
        }
        default: {
            if (original.type === 'group' || !isBoxElement(original)) return original;
            return { ...original, x, y, width, height };
        }
    }
};

/**
 * 把预览元素替换进元素数组（id 相同则整条替换）。
 * 没有命中（元素不在这个可见集里）时返回**入参同一引用**：
 * 上层（visiblePresentElements / presentElements）依赖这个引用相等做零成本判断。
 */
export const applyGesturePreview = (elements: Element[], preview: Element | null): Element[] => {
    if (!preview) return elements;
    let replaced = false;
    const next = elements.map(element => {
        if (element.id !== preview.id || element === preview) return element;
        replaced = true;
        return preview;
    });
    return replaced ? next : elements;
};
