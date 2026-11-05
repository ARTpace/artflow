/**
 * icon-registry.ts —— 内置图标表 + 皮肤图标覆盖解析。
 * 值统一为 SVG inner markup（stroke="currentColor" 跟随文字色）；
 * 皮肤可用 data:image URI 覆盖任意键（BpIcon 检测前缀渲染 <img>）。
 * 皮肤未覆盖的键回落此表，此表缺键 = 图标缺失（消费端自行兜底）。
 */

export const BUILTIN_ICONS: Record<string, string> = {
  // —— TopBar ——
  'topbar.boards':
    '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
  'topbar.search':
    '<circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" />',
  'topbar.open':
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  'topbar.save':
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  'topbar.import':
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  'topbar.present':
    '<polygon points="5 3 19 12 5 21 5 3"></polygon>',
  'topbar.layers':
    '<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>',
  'topbar.frames':
    '<line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="9" y1="4" x2="9" y2="20"></line><line x1="15" y1="4" x2="15" y2="20"></line>',
  'topbar.tags':
    '<path d="M20.6 13.3 12.7 21a2 2 0 0 1-2.8 0L3 14.1V3h11.1l6.5 6.5a2.7 2.7 0 0 1 0 3.8Z" /><circle cx="8" cy="8" r="1.25" />',
  'topbar.extensions':
    '<rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" />',
  'topbar.settings':
    '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
  // —— Toolbar 工具 ——
  'tool.select':
    '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>',
  'tool.pan':
    '<polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line>',
  'tool.shapes':
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line>',
  'tool.rectangle':
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />',
  'tool.circle':
    '<circle cx="12" cy="12" r="10" />',
  'tool.triangle':
    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  'tool.line':
    '<line x1="5" y1="19" x2="19" y2="5"></line>',
  'tool.arrow':
    '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>',
  'tool.pen':
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  'tool.pen-group':
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  'tool.highlighter':
    '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>',
  'tool.lasso':
    '<ellipse cx="12" cy="12" rx="8" ry="5" strokeDasharray="3 3" transform="rotate(-30 12 12)"/>',
  'tool.erase':
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21H7Z"/><path d="M22 21H7"/><path d="m5 12 5 5"/>',
  'tool.frame':
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>',
  'tool.text':
    '<polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line>',
  'tool.upload':
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  'tool.undo':
    '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  'tool.redo':
    '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>',
  // —— Panel 通用（插件面板消费的规范图形，插件一律引用这里，不内联 SVG）——
  'ui.chevron-right':
    '<path d="M9 5.5 15.5 12 9 18.5"/>',
  'ui.check':
    '<path d="M5 12.5 10 17.5 19 6.5"/>',
  'ui.folder':
    '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};

/** 皮肤覆盖值 → 渲染负载。data:/url( 视为图片资源，其余视为 SVG inner markup。 */
export function isImageIconValue(value: string): boolean {
  return value.startsWith('data:') || value.startsWith('url(');
}

// —— 运行时图标注册（插件扩展规范图标集的唯一入口）——
// 规则：BUILTIN_ICONS 是应用规范的权威表，插件注册**不得遮蔽**内置键；
// 解析优先级：皮肤覆盖 > 插件注册 > 内置表。注册返回 disposer，随插件卸载回收。

const registeredIcons = new Map<string, Record<string, string>>();
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function notifyRegistryListeners(): void {
  registryVersion++;
  for (const l of [...registryListeners]) {
    try { l(); } catch (e) { console.error('[icon-registry] listener error:', e); }
  }
}

/**
 * 插件运行时注册图标（SVG inner markup 或 data:/url( 图片）。
 * 与内置键同名的条目被拒绝并告警（规范集本体不可被插件改写）。
 * 返回 disposer：插件卸载时调用以回收图标。
 */
export function registerIcons(ownerId: string, icons: Record<string, string>): () => void {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(icons ?? {})) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(BUILTIN_ICONS, key)) {
      console.warn(`[icon-registry] ${ownerId}: builtin icon "${key}" cannot be shadowed, entry ignored`);
      continue;
    }
    clean[key] = value;
  }
  registeredIcons.set(ownerId, clean);
  notifyRegistryListeners();
  return () => {
    if (registeredIcons.get(ownerId) === clean) {
      registeredIcons.delete(ownerId);
      notifyRegistryListeners();
    }
  };
}

/** 全部已注册图标按注册顺序合并（后注册者覆盖同名键）。 */
export function getRegisteredIcons(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const icons of registeredIcons.values()) Object.assign(merged, icons);
  return merged;
}

/** 订阅注册表变更（注册/注销均触发），返回退订函数。 */
export function subscribeIcons(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => { registryListeners.delete(listener); };
}

/** 解析图标：皮肤覆盖 > 插件注册 > 内置表；都没有返回 null（消费端自行兜底）。 */
export function resolveIcon(name: string, skinIcons: Record<string, string>): string | null {
  const override = skinIcons[name];
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const registered = getRegisteredIcons()[name];
  if (typeof registered === 'string' && registered.length > 0) return registered;
  return BUILTIN_ICONS[name] ?? null;
}
