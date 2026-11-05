/**
 * element-transform-session.ts —— 元素"几何变换"会话的瞬时通道（P1-1）。
 *
 * 背景：缩放/旋转/绘制（resize / rotate / draw*）原先逐帧 `setElements(..., false)`。
 * 虽然 commit=false 不写历史，但它**每一帧都换掉 `elements` 引用**，等于每一帧都告诉
 * 整个应用"文档变了"：视口空间索引重建、可见集重算、卡片几何与 memo 依赖全部换新、
 * 画板被逐帧标脏。代价与"整个工作区"成正比，而与"拖了几像素"无关 —— 手感发涩的根因。
 *
 * 分工（与拖动通道 P1-B 完全一致）：
 * - 会话内（setPreview → end）：几何只存在这里，只通知订阅者（MainCanvas）。
 *   文档状态一个字节都不动，所以索引不重建、全量重渲染不发生。
 * - 会话结束（end）：调用方拿最终几何**一次性**写 elements（一条撤销记录）。
 *
 * 这里刻意不持有 elements：本模块只知道"某一个元素现在长什么样"。
 * 呈现由 `applyGesturePreview`（见 utils/gesture-transform）负责，
 * 保证预览与提交用的是同一份几何。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Element } from '../types';

export interface ElementTransformSnapshot {
    /** 正在变换的元素预览；无会话时为 null。 */
    readonly element: Element | null;
}

/** 没有变换会话时的稳定快照。必须是模块级常量：useSyncExternalStore 会比较引用。 */
export const NO_ELEMENT_TRANSFORM_SESSION: ElementTransformSnapshot = { element: null };

export interface ElementTransformSessionStore {
    /** React 渲染用快照。预览引用不变时返回同一引用。 */
    getSnapshot(): ElementTransformSnapshot;
    subscribe(listener: () => void): () => void;
    isActive(): boolean;
    /**
     * 逐帧写入预览几何；未开始会话时自动开始。**不触发任何文档写入**。
     * 传进来的元素必须是与文档同 id 的"改过几何的副本"，订阅者直接用它渲染。
     */
    setPreview(element: Element): void;
    /**
     * 结束会话并复位预览；返回最终预览供调用方一次性提交。
     * 没有会话时返回 null（调用方据此回落到旧的 `commitAction(els => els)`）。
     */
    end(): Element | null;
    /** 放弃会话：只复位预览，不产生任何待提交值。 */
    cancel(): void;
    dispose(): void;
}

export const createElementTransformSessionStore = (): ElementTransformSessionStore => {
    let element: Element | null = null;
    let snapshot: ElementTransformSnapshot = NO_ELEMENT_TRANSFORM_SESSION;
    const listeners = new Set<() => void>();

    const publish = () => {
        if (element === null) {
            if (snapshot === NO_ELEMENT_TRANSFORM_SESSION) return;
            snapshot = NO_ELEMENT_TRANSFORM_SESSION;
        } else {
            if (snapshot.element === element) return;
            snapshot = { element };
        }
        for (const listener of Array.from(listeners)) listener();
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: listener => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        isActive: () => element !== null,
        setPreview: next => {
            if (element !== null && element.id !== next.id) {
                // 同一个会话里换元素等于换了手势对象：先复位，避免上一段预览残留。
                element = null;
                publish();
            }
            if (element === next) return;
            element = next;
            publish();
        },
        end: () => {
            if (element === null) return null;
            const finalElement = element;
            element = null;
            publish();
            return finalElement;
        },
        cancel: () => {
            if (element === null) return;
            element = null;
            publish();
        },
        dispose: () => {
            element = null;
            snapshot = NO_ELEMENT_TRANSFORM_SESSION;
            listeners.clear();
        },
    };
};

const subscribeNoop = () => () => {};

/**
 * 变换会话订阅：MainCanvas 用它拿"哪一个元素现在呈现什么几何"。
 * store 缺省时返回稳定空快照（向后兼容无 store 的旧路径）。
 */
export const useElementTransformSessionSnapshot = (
    store: ElementTransformSessionStore | undefined,
): ElementTransformSnapshot => {
    const subscribe = useCallback(
        (listener: () => void) => (store ? store.subscribe(listener) : subscribeNoop()),
        [store],
    );
    const getSnapshot = useCallback(
        () => (store ? store.getSnapshot() : NO_ELEMENT_TRANSFORM_SESSION),
        [store],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
