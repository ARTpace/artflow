import type { Element } from '../types';

export interface FlattenedLayerRow {
    element: Element;
    level: number;
}

export interface VirtualRowWindow {
    start: number;
    end: number;
    offsetTop: number;
    totalHeight: number;
}

/**
 * Projects the persisted parentId relation into the layer panel's legacy reverse-source order.
 * Invalid duplicate/cyclic/orphan records fail closed instead of creating recursive UI work.
 */
export const flattenLayerElements = (elements: readonly Element[]): FlattenedLayerRow[] => {
    const childrenByParentId = new Map<string | null, Element[]>();
    for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index];
        const parentId = element.parentId ?? null;
        const siblings = childrenByParentId.get(parentId);
        if (siblings) siblings.push(element);
        else childrenByParentId.set(parentId, [element]);
    }

    const rows: FlattenedLayerRow[] = [];
    const visitedIds = new Set<string>();
    const stack: FlattenedLayerRow[] = [];
    const roots = childrenByParentId.get(null) ?? [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
        stack.push({ element: roots[index], level: 0 });
    }
    while (stack.length > 0) {
        const row = stack.pop()!;
        if (visitedIds.has(row.element.id)) continue;
        visitedIds.add(row.element.id);
        rows.push(row);
        const children = childrenByParentId.get(row.element.id) ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ element: children[index], level: row.level + 1 });
        }
    }
    return rows;
};

export const getVirtualRowWindow = (
    itemCount: number,
    scrollTop: number,
    viewportHeight: number,
    rowHeight: number,
    overscan = 6,
): VirtualRowWindow => {
    const count = Number.isInteger(itemCount) && itemCount > 0 ? itemCount : 0;
    const height = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
    const scroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
    const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : height;
    const extra = Number.isInteger(overscan) && overscan > 0 ? overscan : 0;
    const rawStart = Math.max(0, Math.floor(scroll / height) - extra);
    const start = Math.min(count, rawStart);
    const rawEnd = Math.ceil((scroll + viewport) / height) + extra;
    const end = Math.max(start, Math.min(count, rawEnd));
    return {
        start,
        end,
        offsetTop: start * height,
        totalHeight: count * height,
    };
};
