/**
 * renderer-materialization.ts —— 将启动时已验证的 renderer contribution 固化为只读查找表。
 * CanvasElement 只读这个表；不会在每次 render 中查询 Kernel registry 或合并 profile patch。
 */

import type { Kernel } from './kernel';
import type { CanvasCardContribution } from './card-contributions';

/**
 * 固化项：组件 + 归属插件 ID。
 * 保留 pluginId 的原因：CanvasElement 的卡片渲染点要挂局部错误边界，
 * 失败占位必须能点出"哪个插件"（Contribution.pluginId 在物化时是已知的，
 * 渲染路径上再回头查 Kernel registry 会破坏"render 期零 registry 查询"的约定）。
 */
interface MaterializedCard {
  component: CanvasCardContribution['component'];
  pluginId: string;
}

let materializedCards: ReadonlyMap<string, MaterializedCard> = new Map();

export interface RendererContributionSnapshot {
  canvasNodeTypes: readonly string[];
}

/** 仅在 bootstrap / 显式 profile reload 时调用。 */
export function materializeRendererContributions(kernel: Kernel): RendererContributionSnapshot {
  const cards = new Map<string, MaterializedCard>();
  // contributions.list 已按 priority 降序 + id tie-break 排序：
  // 高优先级贡献先到，同 nodeType 冲突时自然由它接管（第三方覆盖内置即走这条）。
  for (const contribution of kernel.contributions.list<CanvasCardContribution>('canvas_node_types')) {
    const { nodeType, component, replaces } = contribution.value;
    if (cards.has(nodeType)) {
      // 隔离原则：重复 node type 只丢弃后来者并报错（附接管语义），不炸启动。
      console.error(
        `[materialize] duplicate canvas node type skipped: ${nodeType} ` +
        `(from ${contribution.pluginId}, priority=${contribution.priority ?? 0}` +
        `${replaces ? `, replaces=${replaces}` : ''}) — node type already owned by an earlier (higher-priority) contribution`,
      );
      continue;
    }
    cards.set(nodeType, { component, pluginId: contribution.pluginId });
  }
  materializedCards = cards;
  return Object.freeze({ canvasNodeTypes: Object.freeze([...cards.keys()]) });
}

/** render-path lookup against a startup snapshot; no Kernel / plugin dispatch here. */
export function getMaterializedCardComponent(nodeType: string): CanvasCardContribution['component'] | undefined {
  return materializedCards.get(nodeType)?.component;
}

/**
 * 同一张表的"归属插件"投影：只给局部错误边界的占位文案用。
 * 与 getMaterializedCardComponent 同为纯查找，同样不查 Kernel。
 */
export function getMaterializedCardPluginId(nodeType: string): string | undefined {
  return materializedCards.get(nodeType)?.pluginId;
}
