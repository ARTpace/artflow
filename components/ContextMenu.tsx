
import React from 'react';
import type { Element } from '../types';
import type { Kernel } from '../plugin-runtime/kernel';
import { listContextMenuContributions, type ContextMenuContext, type ContextMenuItem } from '../plugin-runtime/menu-contributions';
import { PluginErrorBoundary, reportPluginFailure } from '../plugin-runtime/plugin-error-boundary';

/**
 * 右键菜单通用宿主：只负责弹出定位、按 ui_menus 贡献项渲染、分组分隔线与关闭时机。
 * 菜单项内容全部来自 `ui_menus` 贡献（builtin.canvas-menus 提供原内置项，第三方可追加）。
 */
interface ContextMenuProps {
    kernel: Kernel;
    x: number;
    y: number;
    language: 'en' | 'zho';
    elementId: string | null;
    elements: Element[];
    selectedElementIds: string[];
    actions: ContextMenuContext['actions'];
    onClose: () => void;
}

const GROUP_ORDER = ['layer', 'group', 'clipboard', 'destructive'];

export const ContextMenu: React.FC<ContextMenuProps> = ({
    kernel,
    x,
    y,
    language,
    elementId,
    elements,
    selectedElementIds,
    actions,
    onClose,
}) => {
    const element = elementId ? elements.find(el => el.id === elementId) : null;
    const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
    const isMultiSelection = selectedElementIds.length > 1;

    const ctx: ContextMenuContext = { element, selectedElements, isMultiSelection, actions };

    // 组序按 GROUP_ORDER，未知名组排最后（保持字母序），组内注册表已按 priority DESC。
    const visibleItems = listContextMenuContributions(kernel)
        .map(entry => ({ entry, item: entry.value as ContextMenuItem }))
        .filter(({ item }) => {
            try { return item.visible(ctx); } catch { return false; }
        })
        .sort((a, b) => {
            const ga = GROUP_ORDER.indexOf(a.item.group);
            const gb = GROUP_ORDER.indexOf(b.item.group);
            const ra = ga === -1 ? GROUP_ORDER.length : ga;
            const rb = gb === -1 ? GROUP_ORDER.length : gb;
            if (ra !== rb) return ra - rb;
            return b.entry.priority - a.entry.priority;
        });

    if (visibleItems.length === 0) return null;

    // 菜单项的 label() 是插件函数（render 期调用）、run() 也是（点击时调用）——错误边界抓不到事件回调，
    // 所以这两个调用各自 try/catch：抛错只影响这一条菜单项，不连累整张菜单，更不冒泡到根边界整页报错。
    const readItemLabel = (item: ContextMenuItem, pluginId: string | undefined, id: string): string => {
        try {
            return item.label(language);
        } catch (error) {
            reportPluginFailure('ui_menus', pluginId, 'label', error);
            return id;
        }
    };
    const runItem = (item: ContextMenuItem, pluginId: string | undefined): void => {
        try {
            item.run(ctx);
        } catch (error) {
            reportPluginFailure('ui_menus', pluginId, 'run', error);
        }
    };

    let lastGroup: string | null = null;

    return (
        <div
            data-bp-ui-surface="" className="fixed z-50 p-1 bg-[var(--ui-bg-color)] backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl flex flex-col gap-1 text-sm text-white"
            style={{ top: y, left: x }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
        >
            {visibleItems.map(({ entry, item }) => {
                const showDivider = lastGroup !== null && lastGroup !== item.group;
                lastGroup = item.group;
                return (
                    <React.Fragment key={entry.id}>
                        {showDivider && <div className="border-t border-white/20 -mx-1 my-1"></div>}
                        {/* 局部错误边界：这一项渲染抛错只降级为一行占位（含 pluginId），菜单其余项照常可用。 */}
                        <PluginErrorBoundary slot="ui_menus" pluginId={entry.pluginId} label={entry.id}>
                            <button
                                onClick={() => { runItem(item, entry.pluginId); onClose(); }}
                                className={`w-full text-left px-3 py-1.5 hover:bg-white/10 rounded-md ${item.danger ? 'text-red-300 hover:bg-red-500/20' : ''}`}
                            >
                                {readItemLabel(item, entry.pluginId, entry.id)}
                            </button>
                        </PluginErrorBoundary>
                    </React.Fragment>
                );
            })}
        </div>
    );
};
