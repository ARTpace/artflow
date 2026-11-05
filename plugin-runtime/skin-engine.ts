/**
 * skin-engine.ts —— 皮肤引擎：插槽里的皮肤补丁 → 解析 → CSS 自定义变量写到 DOM。
 * 对齐 AssetLibrary ThemeEngine：只写 CSS 变量，从不重建样式表；
 * 消费端（卡片组件）读 var(--bp-*)，换肤 = 换一组变量值。
 * 每次应用前先移除上一次写入的全部变量，避免换肤后残留旧 accent 键。
 *
 * 皮肤系统升级（《皮肤系统升级开发文档》M1/M2）新增两通道，均与 token 通道独立叠加：
 * - CSS 层（M1）：registerSkinCss 静态校验（skin-css-sanitize）后登记；setCssSkin 激活时
 *   写 data-bp-skin-active 属性 + 挂单一 <style id="bp-skin-css-<skinId>">（互斥，绝不并存）；
 *   皮肤 CSS 永不注入 script/事件——sanitizer 整份拒收，红线。
 * - 配置层（M2）：manifest customization 自声明 → 存储 bp-skin-config.<skinId>，
 *   读取逐键校验（坏键丢弃回落 defaultValue）；变更经 kernel 'skin:config-changed' 广播，
 *   皮肤在 activate 里 onSkinConfig 并自管自清自己的投影属性（dsh 所有权规则）。
 *
 * 持久化：bp-skin-state = { skinId, composite, cssSkinId, uiSettings }；旧数据向后兼容。
 */

import type { Kernel, Effect } from './kernel';
import { resolveSkinTokens, flattenSkinTokens, type SkinTokens, type ResolvedSkinTokens } from './contributions';
import { sanitizeSkinCss } from './skin-css-sanitize';
import {
  DEFAULT_UI_THEME_SETTINGS, DEFAULT_CANVAS_BACKGROUND, normalizeUiThemeSettings, resolveUiChrome, systemUiMode,
  type UiThemeSettings,
} from './ui-theme-settings';
import {
  readSkinConfig,
  mergeSkinConfig,
  skinConfigStorageKey,
  resolveSkinConfigBindings,
  resolveSkinAttributeBindings,
  resolveSkinClassBindings,
  type SkinCustomizationDecl,
} from './skin-customization';
import { createPreferenceStorage, createPrefixedPreferenceStorage } from './preference-storage';

/** Public renderer service name consumed by trusted builtin UI plugins. */
export const SKIN_ENGINE_SERVICE = 'ui.skin-engine';

/** kernel 事件：皮肤自声明配置变更（M2）。payload = { skinId, config }。 */
export const SKIN_CONFIG_CHANGED = 'skin:config-changed';

export interface SkinInfo {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  /** token 补丁（空对象 = 纯装饰皮肤，无 token 覆盖）。 */
  tokens: SkinTokens;
  /** v1 扩展元数据（manifest 透传，全部可选）。 */
  preview?: { dark?: string; light?: string };
  gallery?: SkinGalleryMetadata;
  tags?: string[];
  order?: number;
  customization?: SkinCustomizationDecl;
}

/** Gallery metadata is optional. Unlabelled skins remain standalone themes. */
export interface SkinGalleryMetadata {
  family: string;
  title: string;
  titleEn?: string;
  description?: string;
  descriptionEn?: string;
  poster?: string;
  credit?: string;
}

/** 'skins' 插槽贡献值的运行时形状（loader.stageSkins 透传）。 */
interface SkinContributionValue {
  name: string;
  mode: 'dark' | 'light';
  tokens: SkinTokens;
  css?: string;
  preview?: { dark?: string; light?: string };
  gallery?: SkinGalleryMetadata;
  tags?: string[];
  order?: number;
  customization?: SkinCustomizationDecl;
}

export interface SkinTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  /** M4 属性投影挂点（documentElement）；属性型皮肤开关写入/移除都走这里。 */
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /** M5 class 投影挂点（documentElement）；class 型皮肤开关（.is-compact 等）写入/移除都走这里。 */
  classList: { toggle(name: string, force?: boolean): void };
}

// —— 混搭（手机主题语义）：以一个整主题为底座，五个维度各自指定来源皮肤 ——
export type SkinCompositePart = 'card' | 'chrome' | 'canvas' | 'typography' | 'icons';

export interface SkinCompositeSelection {
  baseSkinId: string;
  overrides: Partial<Record<SkinCompositePart, string>>;
}

/** A live preview changes rendered chrome but never writes the persisted appearance. */
export interface SkinAppearanceSnapshot {
  skinId: string;
  composite: SkinCompositeSelection | null;
  cssSkinId: string | null;
  uiSettings: UiThemeSettings;
}

export interface SkinLivePreview {
  previewSkin(skinId: string): void;
  previewMix(selection: SkinCompositeSelection, keepExistingStyle?: boolean): void;
  previewStyleLayer(skinId: string | null): void;
  previewConfig(skinId: string, patch: Record<string, unknown>): void;
  previewUiSettings(patch: Partial<UiThemeSettings>): void;
  isDirty(): boolean;
  isActive(): boolean;
  commit(): boolean;
  cancel(): void;
}

interface SkinPreviewState {
  baseline: SkinAppearanceSnapshot;
  configs: Map<string, Record<string, unknown>>;
}

const COMPOSITE_ID = '__composite__';

const SKIN_STATE_KEY = 'bp-skin-state';

/**
 * 外观数据的存储后端：从 localStorage（按 origin 隔离）搬到主进程 config/preferences.json。
 * 皮肤系统是"读多写少 + 有内存态"，所以这里只换后端，**不动任何既有语义**
 * （预览草稿、暂存/提交、所有权规则全部原样）。旧键由适配器一次性采纳。
 */
const skinStateStorage = createPreferenceStorage({
  namespace: 'appearance',
  toPreferenceKey: () => 'appearance.skinState',
});
/** 逐皮肤配置：`bp-skin-config.<skinId>` → `appearance.skinConfig.<skinId>`。 */
const skinConfigStorage = createPrefixedPreferenceStorage('bp-skin-config.', 'appearance.skinConfig');

interface SkinPersistedState {
  skinId: string;
  composite: SkinCompositeSelection | null;
  /** 当前激活的 CSS 皮肤（M1）；旧数据无此字段 → null。 */
  cssSkinId: string | null;
  /** UI-only controls travel with the skin state, never compete with a second settings writer. */
  uiSettings?: UiThemeSettings;
}

function persistSkinState(state: SkinPersistedState): void {
  try { skinStateStorage.setItem(SKIN_STATE_KEY, JSON.stringify(state)); } catch { /* 存储不可用则仅会话级 */ }
}

export function loadSkinState(): SkinPersistedState | null {
  try {
    const raw = skinStateStorage.getItem(SKIN_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.skinId !== 'string') return null;
    const composite = parsed.composite && typeof parsed.composite.baseSkinId === 'string'
      ? { baseSkinId: parsed.composite.baseSkinId, overrides: parsed.composite.overrides ?? {} }
      : null;
    const cssSkinId = typeof parsed.cssSkinId === 'string' && parsed.cssSkinId.length > 0
      ? parsed.cssSkinId
      : null; // 缺失/空串/非串：一律容错为 null
    return { skinId: parsed.skinId, composite, cssSkinId, uiSettings: normalizeUiThemeSettings(parsed.uiSettings) };
  } catch { return null; }
}

export class SkinEngine {
  private currentId = '';
  private appliedVars: string[] = [];
  private appliedUiVars: string[] = [];
  /** 皮肤 binding 注入的 CSS 变量名（P0-2）；切皮肤/卸载时按此清理，避免跨皮肤泄漏。 */
  private appliedBindingVars: string[] = [];
  /** 皮肤 attributeBindings 写入的属性名（M4）；切皮肤/卸载时按此清理，避免跨皮肤残留。 */
  private appliedBindingAttrs: string[] = [];
  /** 皮肤 classBindings 写入的 class 名（M5）；切皮肤/卸载时按此清理，避免跨皮肤残留。 */
  private appliedBindingClasses: string[] = [];
  private baseTokens: ResolvedSkinTokens | null = null;
  private uiSettings: UiThemeSettings = { ...DEFAULT_UI_THEME_SETTINGS };
  /** 主题插件登记的「基座 CSS」（应用级 UI 主题映射，非皮肤专属）。ownerId → cssText。 */
  private readonly baseThemeCss = new Map<string, string>();
  private readonly uiListeners = new Set<(settings: UiThemeSettings) => void>();
  private composite: SkinCompositeSelection | null = null;
  private readonly listeners = new Set<(tokens: ResolvedSkinTokens) => void>();

  // —— CSS 层（M1）：skinId → css 文本；ownerId → skinId（重复注册覆盖旧值）——
  private readonly cssLayers = new Map<string, string>();
  private readonly cssOwners = new Map<string, string>();
  private readonly cssSkinListeners = new Set<(id: string | null) => void>();
  private cssSkinId: string | null = null;
  private livePreview: SkinPreviewState | null = null;

  constructor(
    private readonly ctx: Kernel,
    private readonly target: SkinTarget = document.documentElement,
  ) {
    // The appearance engine owns the only OS-mode listener. Do not poll or save a draft
    // merely because the operating system flips its preference.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const query = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => {
        // An applied "follow system" selection can change while Studio is open.
        // Advance the cancel baseline too; an OS event is not a user edit and
        // must not make an untouched preview dirty or restore the wrong variant.
        if (this.livePreview && this.livePreview.baseline.uiSettings.mode === 'system') {
          this.livePreview.baseline = this.systemVariant(this.livePreview.baseline);
        }
        if (this.uiSettings.mode !== 'system') {
          if (this.livePreview) this.updatePreviewMarker(this.livePreview);
          return;
        }
        if (this.baseTokens) this.applyUiSettings(this.baseTokens);
        this.syncSystemMode();
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else query.addListener?.(onChange);
    }
    // 配置变更（M2）→ 若命中当前激活皮肤，自动重投影其 binding CSS 变量（含 live preview 草稿）。
    this.ctx.on(SKIN_CONFIG_CHANGED, payload => {
      const event = payload as { skinId?: unknown } | undefined;
      if (event && event.skinId === this.currentId) this.applySkinConfigBindings(this.currentId);
    });
  }

  /** Map the same authored family to the current OS mood without touching storage. */
  private systemVariant(selection: SkinAppearanceSnapshot): SkinAppearanceSnapshot {
    if (selection.uiSettings.mode !== 'system' || selection.composite) return selection;
    const skins = this.listSkins();
    const sourceId = selection.cssSkinId ?? selection.skinId;
    const source = skins.find(skin => skin.id === sourceId);
    const family = source?.gallery?.family;
    if (!family) return selection;
    const variant = skins.find(skin => skin.gallery?.family === family && skin.mode === systemUiMode());
    if (!variant || variant.id === sourceId) return selection;
    return {
      ...selection,
      skinId: selection.skinId === sourceId ? variant.id : selection.skinId,
      cssSkinId: selection.cssSkinId === sourceId ? this.hasCssSkin(variant.id) ? variant.id : null : selection.cssSkinId,
    };
  }

  /** Follow an authored light/dark skin pair without bypassing the studio transaction. */
  syncSystemMode(): void {
    if (this.uiSettings.mode !== 'system' || !this.currentId) return;
    const current = this.captureAppearance();
    const next = this.systemVariant(current);
    if (next === current) return;
    if (this.livePreview) this.applyPreviewAppearance(this.livePreview, next);
    else { this.applyPreviewAppearanceRestored(next); this.persistState(); }
  }

  listSkins(): SkinInfo[] {
    const skins = this.ctx.contributions.list<SkinContributionValue>('skins')
      .map(c => ({
        id: c.id,
        name: c.value.name,
        mode: c.value.mode,
        tokens: c.value.tokens,
        preview: c.value.preview,
        gallery: c.value.gallery,
        tags: c.value.tags,
        order: c.value.order,
        customization: c.value.customization,
      }));
    // 主题库排序：manifest order（小者在前，缺省 100），同权按 id 稳定
    return skins.sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || a.id.localeCompare(b.id));
  }

  /** Resolve a registered skin without mutating DOM state; panel plugins use this for preview swatches. */
  resolveSkin(id: string): ResolvedSkinTokens {
    const contrib = this.ctx.contributions.get<SkinContributionValue>('skins', id);
    if (!contrib) throw new Error(`unknown skin: ${id}`);
    return resolveSkinTokens(contrib.value.tokens);
  }

  /** Isolated mix preview; never touches the DOM, listeners or persisted theme state. */
  previewComposite(selection: SkinCompositeSelection): ResolvedSkinTokens {
    return this.buildComposite(selection);
  }

  getUiSettings(): UiThemeSettings { return { ...this.uiSettings }; }

  subscribeUiSettings(listener: (settings: UiThemeSettings) => void): Effect {
    this.uiListeners.add(listener);
    return () => { this.uiListeners.delete(listener); };
  }

  /** Persistent API for other trusted extensions. External writes cancel a live studio draft. */
  setUiSettings(patch: Partial<UiThemeSettings>): void {
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    const next = normalizeUiThemeSettings(patch, this.uiSettings);
    if (JSON.stringify(next) === JSON.stringify(this.uiSettings)) return;
    this.uiSettings = next;
    if (this.baseTokens) this.applyUiSettings(this.baseTokens);
    if (this.currentId) { this.syncSystemMode(); this.persistState(); }
  }

  /** Preview session: token vars, CSS layer and skin settings respond on real UI surfaces.
   * All writes remain in memory until commit(); cancel() fully restores the baseline.
   * A persistent call from elsewhere first cancels this draft, so it can never swallow that call.
   */
  startLivePreview(): SkinLivePreview {
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    const session: SkinPreviewState = { baseline: this.captureAppearance(), configs: new Map() };
    this.livePreview = session;
    const active = () => this.livePreview === session;
    return {
      previewSkin: (id) => {
        if (!active()) return;
        const skin = this.ctx.contributions.get<SkinContributionValue>('skins', id)?.value;
        if (!skin) throw new Error(`unknown skin: ${id}`);
        const css = this.hasCssSkin(id);
        const cssOnly = css && Object.keys(skin.tokens ?? {}).length === 0;
        this.applyPreviewAppearance(session, cssOnly
          ? { ...session.baseline, uiSettings: this.getUiSettings(), cssSkinId: id }
          : { skinId: id, composite: null, cssSkinId: css ? id : null, uiSettings: this.getUiSettings() });
      },
      previewMix: (selection, keepExistingStyle = false) => {
        if (!active()) return;
        const overrides = Object.fromEntries(Object.entries(selection.overrides ?? {})
          .filter(([, source]) => typeof source === 'string' && source !== selection.baseSkinId)) as SkinCompositeSelection['overrides'];
        this.applyPreviewAppearance(session, {
          skinId: Object.keys(overrides).length ? COMPOSITE_ID : selection.baseSkinId,
          composite: Object.keys(overrides).length ? { baseSkinId: selection.baseSkinId, overrides } : null,
          cssSkinId: keepExistingStyle ? session.baseline.cssSkinId : null,
          uiSettings: this.getUiSettings(),
        });
      },
      previewStyleLayer: (id) => {
        if (!active()) return;
        this.applyPreviewAppearance(session, { ...this.captureAppearance(), cssSkinId: id });
      },
      previewConfig: (id, patch) => {
        if (!active()) return;
        const decl = this.skinCustomization(id);
        if (!decl) return;
        const persisted = readSkinConfig(skinConfigStorage, id, decl);
        const { config, changed } = mergeSkinConfig(session.configs.get(id) ?? persisted, patch, decl);
        if (!changed) return;
        if (JSON.stringify(config) === JSON.stringify(persisted)) session.configs.delete(id);
        else session.configs.set(id, config);
        this.ctx.emit(SKIN_CONFIG_CHANGED, { skinId: id, config });
        this.updatePreviewMarker(session);
      },
      previewUiSettings: (patch) => {
        if (!active()) return;
        this.applyPreviewAppearance(session, {
          ...this.captureAppearance(),
          uiSettings: normalizeUiThemeSettings(patch, this.uiSettings),
        });
        this.syncSystemMode();
      },
      isDirty: () => active() && this.isPreviewDirty(session),
      isActive: active,
      commit: () => this.commitLivePreview(session),
      cancel: () => this.cancelLivePreview(session),
    };
  }

  private captureAppearance(): SkinAppearanceSnapshot {
    return {
      skinId: this.currentId,
      composite: this.composite ? { baseSkinId: this.composite.baseSkinId, overrides: { ...this.composite.overrides } } : null,
      cssSkinId: this.cssSkinId,
      uiSettings: this.getUiSettings(),
    };
  }

  private isPreviewDirty(session: SkinPreviewState): boolean {
    return JSON.stringify(this.captureAppearance()) !== JSON.stringify(session.baseline) || session.configs.size > 0;
  }

  private updatePreviewMarker(session: SkinPreviewState): void {
    if (this.isPreviewDirty(session)) document.documentElement.setAttribute('data-bp-appearance-preview', 'true');
    else document.documentElement.removeAttribute('data-bp-appearance-preview');
  }

  private applyPreviewAppearance(session: SkinPreviewState, selection: SkinAppearanceSnapshot): void {
    if (this.livePreview !== session) return;
    const has = (id: string) => !!this.ctx.contributions.get<SkinContributionValue>('skins', id);
    const validComposite = selection.composite && has(selection.composite.baseSkinId) ? selection.composite : null;
    const fallback = [selection.skinId, session.baseline.composite?.baseSkinId, session.baseline.skinId, this.listSkins()[0]?.id]
      .find((id): id is string => typeof id === 'string' && has(id));
    if (!validComposite && !fallback) return; // all contributors were unloaded
    const tokenId = validComposite ? COMPOSITE_ID : fallback!;
    const tokenChanged = this.currentId !== tokenId || JSON.stringify(this.composite) !== JSON.stringify(validComposite);
    // Resolve before touching live state so a bad source cannot leave a half-applied preview.
    const tokens = tokenChanged || !this.baseTokens
      ? validComposite ? this.buildComposite(validComposite) : this.resolveSkin(tokenId)
      : this.baseTokens;
    const uiSettings = normalizeUiThemeSettings(selection.uiSettings);
    const uiChanged = JSON.stringify(this.uiSettings) !== JSON.stringify(uiSettings);
    this.uiSettings = uiSettings;
    if (tokenChanged) {
      this.currentId = tokenId;
      this.composite = validComposite ? { baseSkinId: validComposite.baseSkinId, overrides: { ...validComposite.overrides } } : null;
      this.apply(tokens);
    } else if (uiChanged) this.applyUiSettings(tokens); // controls update without re-rendering every icon
    const cssId = selection.cssSkinId && this.hasCssSkin(selection.cssSkinId) ? selection.cssSkinId : null;
    if (this.cssSkinId !== cssId) this.updateCssSkin(cssId, false);
    this.updatePreviewMarker(session);
  }

  private cancelLivePreview(session: SkinPreviewState): void {
    if (this.livePreview !== session) return;
    this.livePreview = null;
    // If a contributing skin was disabled while previewing, fall back safely to an available one.
    const available = this.listSkins();
    const baseline = session.baseline;
    const base = baseline.composite && available.some(s => s.id === baseline.composite!.baseSkinId)
      ? baseline.composite.baseSkinId : null;
    const skinId = base ?? (available.some(s => s.id === baseline.skinId) ? baseline.skinId : available[0]?.id);
    if (skinId) {
      this.applyPreviewAppearanceRestored({
        skinId: base ? COMPOSITE_ID : skinId,
        composite: base ? baseline.composite : null,
        cssSkinId: baseline.cssSkinId,
        uiSettings: baseline.uiSettings,
      });
    } else {
      this.uiSettings = { ...baseline.uiSettings };
      if (this.baseTokens) this.applyUiSettings(this.baseTokens);
      if (this.cssSkinId !== null) this.updateCssSkin(null, false);
    }
    document.documentElement.removeAttribute('data-bp-appearance-preview');
    for (const id of session.configs.keys()) {
      this.ctx.emit(SKIN_CONFIG_CHANGED, { skinId: id, config: this.getSkinConfig(id) });
    }
  }

  private applyPreviewAppearanceRestored(selection: SkinAppearanceSnapshot): void {
    const id = selection.composite ? COMPOSITE_ID : selection.skinId;
    const tokenChanged = this.currentId !== id || JSON.stringify(this.composite) !== JSON.stringify(selection.composite);
    const tokens = tokenChanged || !this.baseTokens
      ? selection.composite ? this.buildComposite(selection.composite) : this.resolveSkin(selection.skinId)
      : this.baseTokens;
    const uiChanged = JSON.stringify(this.uiSettings) !== JSON.stringify(selection.uiSettings);
    this.uiSettings = { ...selection.uiSettings };
    if (tokenChanged) {
      this.currentId = id;
      this.composite = selection.composite ? { baseSkinId: selection.composite.baseSkinId, overrides: { ...selection.composite.overrides } } : null;
      this.apply(tokens);
    } else if (uiChanged) this.applyUiSettings(tokens);
    const css = selection.cssSkinId && this.hasCssSkin(selection.cssSkinId) ? selection.cssSkinId : null;
    if (this.cssSkinId !== css) this.updateCssSkin(css, false);
  }

  private commitLivePreview(session: SkinPreviewState): boolean {
    if (this.livePreview !== session) return false;
    const changed = this.isPreviewDirty(session);
    this.livePreview = null;
    document.documentElement.removeAttribute('data-bp-appearance-preview');
    if (!changed) return false;
    for (const [id, config] of session.configs) {
      try { skinConfigStorage.setItem(skinConfigStorageKey(id), JSON.stringify(config)); }
      catch { /* session-only if storage is unavailable */ }
    }
    this.persistState();
    return true;
  }

  /** 切换皮肤：补丁合并底座 → CSS 变量生效。未知 id 抛错。清除混搭组合。 */
  /** M6：皮肤（含混搭底座）应用后通知主进程，使其实时更新托盘图标。 */
  private notifyHostSkinChanged(effectiveId: string): void {
    try {
      const bridge = (window as unknown as { artflowApp?: { notifySkinChanged?: (id: string) => void } }).artflowApp;
      bridge?.notifySkinChanged?.(effectiveId);
    } catch { /* 桥不可用（如测试环境）则跳过 */ }
  }

  setSkin(id: string): ResolvedSkinTokens {
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    const resolved = this.resolveSkin(id);
    this.currentId = id;
    this.composite = null;
    this.apply(resolved);
    this.persistState();
    this.notifyHostSkinChanged(id);
    return resolved;
  }

  /**
   * 混搭组合：baseSkinId 整主题打底，overrides 里每个维度取自指定来源皮肤的对应组。
   * 来源皮肤未知/解析失败 → 忽略该维度（保持底座值，隔离语义）。
   * baseSkinId 未知 → 抛错。
   */
  setComposite(selection: SkinCompositeSelection): ResolvedSkinTokens {
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    const resolved = this.buildComposite(selection); // baseSkinId 未知在此抛错
    this.currentId = COMPOSITE_ID;
    this.composite = selection;
    this.apply(resolved);
    this.persistState();
    this.notifyHostSkinChanged(selection.baseSkinId);
    return resolved;
  }

  getComposite(): SkinCompositeSelection | null { return this.composite; }

  /** 退出混搭：回到指定整主题（缺省回落底座皮肤或默认）。 */
  clearComposite(): ResolvedSkinTokens {
    const back = this.composite?.baseSkinId
      ?? (this.ctx.contributions.get('skins', 'builtin.skin-default') ? 'builtin.skin-default' : this.listSkins()[0]?.id);
    if (!back) return this.resolveSkin(this.currentId);
    return this.setSkin(back);
  }

  currentId_(): string { return this.currentId; }
  currentTokens(): ResolvedSkinTokens { return this.baseTokens ?? resolveSkinTokens(this.peekPatch(this.currentId)); }

  subscribe(listener: (tokens: ResolvedSkinTokens) => void): Effect {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** CSS 层激活状态订阅（主题库状态栏用；token 变更走 subscribe）。 */
  subscribeCssSkin(listener: (id: string | null) => void): Effect {
    this.cssSkinListeners.add(listener);
    return () => { this.cssSkinListeners.delete(listener); };
  }

  // —— CSS 覆盖层（M1）：注册与激活分离 ——

  /**
   * 注册皮肤 CSS（纯文本）。sanitizer 不过 → 整份拒收 + console.error，返回 no-op disposer。
   * ownerId 重复注册覆盖旧值。返回 disposer：移除登记 + <style>；若该皮肤正激活则回落
   * setCssSkin(null) 并 console.error（不允许留下无主 style 元素）。
   */
  registerSkinCss(ownerId: string, skinId: string, cssText: string): () => void {
    const result = sanitizeSkinCss(skinId, cssText);
    if (result.ok === false) {
      console.error(`[skin-engine] registerSkinCss(${ownerId}) rejected skinId=${skinId} — css not applied:`, result.errors);
      return () => {};
    }
    // ownerId 重复注册：先撤旧的（若旧的正在激活，按卸载语义回落 + 记录）
    const previous = this.cssOwners.get(ownerId);
    if (previous !== undefined && previous !== skinId) {
      if (this.cssSkinId === previous) {
        console.error(`[skin-engine] owner ${ownerId} re-registered css skin; previous "${previous}" was active, falling back to none`);
        this.setCssSkin(null);
      }
      this.dropCssLayer(previous);
      if (this.cssOwners.get(ownerId) === previous) this.cssOwners.delete(ownerId);
    }
    this.cssLayers.set(skinId, result.css);
    this.cssOwners.set(ownerId, skinId);
    if (this.cssSkinId === skinId) this.applyCssStyle(); // 已激活时热替换内容
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.cssOwners.get(ownerId) === skinId) this.cssOwners.delete(ownerId);
      // 同 skinId 可能被多个 owner 登记（v1 罕见）：还有 owner 持有则不动
      if (Array.from(this.cssOwners.values()).includes(skinId)) return;
      if (this.cssSkinId === skinId) {
        this.dropCssLayer(skinId);
        console.error(`[skin-engine] active css skin "${skinId}" unregistered by owner ${ownerId}; falling back to none`);
        this.setCssSkin(null);
      } else {
        this.dropCssLayer(skinId);
      }
    };
  }

  /**
   * 主题插件登记的「基座 CSS」：应用级 UI 主题映射（工具界面映射层），与具体皮肤是否激活无关——
   * 默认皮肤也需要。常驻 <head> 首位，保证它先于任何皮肤/组件样式层生效并被后续层覆盖。
   * 同一 owner 重复登记会热替换内容；卸载时移除无主层。
   */
  registerBaseThemeCss(ownerId: string, cssText: string): () => void {
    const render = () => {
      let style = document.getElementById('bp-ui-theme-map') as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = 'bp-ui-theme-map';
        const head = document.head;
        head.insertBefore(style, head.firstChild);
      }
      style.setAttribute('data-bp-ui-theme-map', [...this.baseThemeCss.keys()].join(',') || ownerId);
      style.textContent = cssText;
    };
    this.baseThemeCss.set(ownerId, cssText);
    render();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.baseThemeCss.delete(ownerId);
      if (this.baseThemeCss.size === 0) {
        const style = document.getElementById('bp-ui-theme-map');
        if (style) style.remove();
        return;
      }
      // 还有其它 owner 持有基座层：重渲染为剩余登记者（本引擎单文件，取最后一个登记者）。
      const remaining = [...this.baseThemeCss.values()].pop() ?? '';
      const style = document.getElementById('bp-ui-theme-map');
      if (style) {
        style.setAttribute('data-bp-ui-theme-map', [...this.baseThemeCss.keys()].join(','));
        style.textContent = remaining;
      }
    };
  }

  /** 激活 CSS 皮肤：写 data-bp-skin-active（documentElement，作用域契约的挂点）+ 挂单一 <style>；传 null 关闭。落盘。未注册的 id 拒激活并记录。 */
  setCssSkin(skinId: string | null): void {
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    this.updateCssSkin(skinId, true);
  }

  private updateCssSkin(skinId: string | null, persist: boolean): void {
    if (skinId !== null && !this.cssLayers.has(skinId)) {
      console.error(`[skin-engine] setCssSkin ignored: no css registered for "${skinId}"`);
      return;
    }
    const old = document.getElementById(`bp-skin-css-${this.cssSkinId ?? ''}`);
    if (old) old.remove();
    if (skinId !== null) {
      const style = document.createElement('style');
      style.id = `bp-skin-css-${skinId}`;
      style.setAttribute('data-bp-skin-css', skinId);
      style.textContent = this.cssLayers.get(skinId) ?? '';
      document.head.appendChild(style);
      document.documentElement.setAttribute('data-bp-skin-active', skinId);
    } else {
      document.documentElement.removeAttribute('data-bp-skin-active');
    }
    this.cssSkinId = skinId;
    // CSS 通道激活后重投影该皮肤的声明式 binding / attributeBindings（P0-2 / M4）：
    // 纯 CSS 皮肤没有 token 通道可走；该皮肤无 customization 时回落当前 token 皮肤，保持既有语义。
    this.applySkinConfigBindings(skinId !== null && this.skinCustomization(skinId) ? skinId : this.currentId);
    if (persist) this.persistState();
    for (const l of [...this.cssSkinListeners]) {
      try { l(this.cssSkinId); } catch (e) { console.error('[skin-engine] css-skin listener error:', e); }
    }
  }

  /** 当前激活的 CSS 皮肤 id；无则 null。 */
  getCssSkin(): string | null { return this.cssSkinId; }

  /** 该皮肤是否已登记 CSS 层（主题库徽标/点击行为用）。 */
  hasCssSkin(skinId: string): boolean { return this.cssLayers.has(skinId); }

  // —— 皮肤自声明配置（M2）——

  /** 读取皮肤配置：defaults + 存储值（逐键校验，坏键丢弃）。无声明皮肤返回 {}。 */
  getSkinConfig(skinId: string): Record<string, unknown> {
    const draft = this.livePreview?.configs.get(skinId);
    if (draft) return { ...draft };
    const decl = this.skinCustomization(skinId);
    return readSkinConfig(skinConfigStorage, skinId, decl);
  }

  /** 合并 + 落盘（仅已校验值）+ emit('skin:config-changed', { skinId, config })。无声明皮肤 = no-op。 */
  setSkinConfig(skinId: string, patch: Record<string, unknown>): void {
    const decl = this.skinCustomization(skinId);
    if (!decl) return; // 该皮肤未自声明配置（或已卸载）：不产生任何存储/事件
    if (this.livePreview) this.cancelLivePreview(this.livePreview);
    const { config, changed } = mergeSkinConfig(this.getSkinConfig(skinId), patch, decl);
    if (!changed) return;
    try {
      skinConfigStorage.setItem(skinConfigStorageKey(skinId), JSON.stringify(config));
    } catch { /* 存储不可用：本次变更仅广播，不落盘 */ }
    this.ctx.emit(SKIN_CONFIG_CHANGED, { skinId, config });
  }

  /** 订阅指定皮肤的配置变更；返回 disposer。 */
  onSkinConfig(skinId: string, cb: (cfg: Record<string, unknown>) => void): () => void {
    return this.ctx.on(SKIN_CONFIG_CHANGED, payload => {
      const event = payload as { skinId?: unknown; config?: unknown } | undefined;
      if (event && event.skinId === skinId && event.config && typeof event.config === 'object') {
        cb(event.config as Record<string, unknown>);
      }
    });
  }

  private skinCustomization(skinId: string): SkinCustomizationDecl | null {
    return this.ctx.contributions.get<SkinContributionValue>('skins', skinId)?.value.customization ?? null;
  }

  private dropCssLayer(skinId: string): void {
    if (!this.cssLayers.delete(skinId)) return;
    document.getElementById(`bp-skin-css-${skinId}`)?.remove();
  }

  private applyCssStyle(): void {
    if (this.cssSkinId === null) return;
    const style = document.getElementById(`bp-skin-css-${this.cssSkinId}`);
    if (style) style.textContent = this.cssLayers.get(this.cssSkinId) ?? '';
  }

  /** 统一落盘：token 选择（含混搭）+ CSS 皮肤，一次写全，避免两通道互相洗掉。 */
  private persistState(): void {
    const tokenSkinId = this.composite ? this.composite.baseSkinId : this.currentId;
    persistSkinState({ skinId: tokenSkinId, composite: this.composite, cssSkinId: this.cssSkinId, uiSettings: this.uiSettings });
  }

  private peekPatch(id: string): SkinTokens {
    if (id === COMPOSITE_ID) return this.composite ? this.compositeTokensPatch() : {};
    return this.ctx.contributions.get<SkinContributionValue>('skins', id)?.value.tokens ?? {};
  }

  /** 混搭组合 → 等价 tokens 补丁（供 currentTokens 精确还原，不过度声明）。 */
  private compositeTokensPatch(): SkinTokens {
    if (!this.composite) return {};
    const resolved = this.buildComposite(this.composite);
    const base = (() => { try { return this.resolveSkin(this.composite!.baseSkinId); } catch { return null; } })();
    const patch: SkinTokens = { mode: resolved.mode };
    if (base) {
      if (JSON.stringify(resolved.color) !== JSON.stringify(base.color)) patch.color = resolved.color;
      if (JSON.stringify(resolved.chrome) !== JSON.stringify(base.chrome)) patch.chrome = resolved.chrome;
      if (JSON.stringify(resolved.radius) !== JSON.stringify(base.radius)) patch.radius = resolved.radius;
      if (JSON.stringify(resolved.accents) !== JSON.stringify(base.accents)) patch.accents = resolved.accents;
      if (JSON.stringify(resolved.canvas) !== JSON.stringify(base.canvas)) patch.canvas = resolved.canvas;
      if (JSON.stringify(resolved.typography) !== JSON.stringify(base.typography)) patch.typography = resolved.typography;
      if (JSON.stringify(resolved.icons) !== JSON.stringify(base.icons)) patch.icons = resolved.icons;
    } else {
      patch.color = resolved.color;
      patch.chrome = resolved.chrome;
      patch.radius = resolved.radius;
      patch.accents = resolved.accents;
      patch.canvas = resolved.canvas;
      patch.typography = resolved.typography;
      patch.icons = resolved.icons;
    }
    return patch;
  }

  private buildComposite(selection: SkinCompositeSelection): ResolvedSkinTokens {
    const base = this.resolveSkin(selection.baseSkinId);
    const resolved: ResolvedSkinTokens = {
      mode: base.mode,
      color: { ...base.color },
      chrome: { ...base.chrome },
      radius: { ...base.radius },
      accents: { ...base.accents },
      canvas: { ...base.canvas },
      typography: { ...base.typography },
      icons: { ...base.icons },
    };
    for (const [part, skinId] of Object.entries(selection.overrides ?? {})) {
      if (typeof skinId !== 'string' || skinId === selection.baseSkinId) continue;
      try {
        const src = this.resolveSkin(skinId);
        if (part === 'card') {
          resolved.color = { ...src.color };
          resolved.radius = { ...src.radius };
          resolved.accents = { ...src.accents };
        } else if (part === 'chrome') {
          resolved.chrome = { ...src.chrome };
        } else if (part === 'canvas') {
          resolved.canvas = { ...src.canvas };
        } else if (part === 'typography') {
          resolved.typography = { ...src.typography };
        } else if (part === 'icons') {
          resolved.icons = { ...src.icons };
        }
      } catch { /* 未知来源皮肤：该维度回落底座 */ }
    }
    return resolved;
  }

  private apply(tokens: ResolvedSkinTokens): void {
    for (const name of this.appliedVars) this.target.style.removeProperty(name);
    const vars = flattenSkinTokens(tokens);
    for (const [name, value] of Object.entries(vars)) this.target.style.setProperty(name, value);
    this.appliedVars = Object.keys(vars);
    this.baseTokens = tokens;
    this.applyUiSettings(tokens);
    this.applySkinConfigBindings(this.currentId); // P0-2：皮肤激活即投影其声明式 binding 变量
    for (const l of [...this.listeners]) {
      try { l(tokens); } catch (e) { console.error('[skin-engine] listener error:', e); }
    }
  }

  /**
   * P0-2 声明式桥接：把当前激活皮肤的 customization.binding 投影成 CSS 变量注入 documentElement。
   * M4 属性桥接：把 attributeBindings 映射的 boolean 开关投影成 HTML 属性（属性选择器型皮肤开关）。
   * M5 class 桥接：把 classBindings 映射的 boolean 开关投影成 documentElement class（组合态型皮肤开关）。
   * 切皮肤/卸载时先清掉上一批变量、属性与 class，避免跨皮肤泄漏/残留。无声明或当前为混搭组合（COMPOSITE_ID）则不注入。
   */
  private applySkinConfigBindings(skinId: string): void {
    for (const name of this.appliedBindingVars) this.target.style.removeProperty(name);
    this.appliedBindingVars = [];
    for (const name of this.appliedBindingAttrs) this.target.removeAttribute(name);
    this.appliedBindingAttrs = [];
    for (const name of this.appliedBindingClasses) this.target.classList.toggle(name, false);
    this.appliedBindingClasses = [];
    const decl = this.skinCustomization(skinId);
    if (!decl) return;
    const config = this.getSkinConfig(skinId); // 尊重 live preview 草稿
    if (decl.binding) {
      const vars = resolveSkinConfigBindings(decl.binding, config);
      for (const [name, value] of Object.entries(vars)) this.target.style.setProperty(name, value);
      this.appliedBindingVars = Object.keys(vars);
    }
    if (decl.attributeBindings) {
      const attrs = resolveSkinAttributeBindings(decl.attributeBindings, config);
      for (const [name, value] of Object.entries(attrs)) this.target.setAttribute(name, value);
      this.appliedBindingAttrs = Object.keys(attrs);
    }
    if (decl.classBindings) {
      const classes = resolveSkinClassBindings(decl.classBindings, config);
      for (const [name, on] of Object.entries(classes)) this.target.classList.toggle(name, on);
      this.appliedBindingClasses = Object.keys(classes);
    }
  }

  private applyUiSettings(tokens: ResolvedSkinTokens): void {
    const { mode, vars } = resolveUiChrome(tokens, this.uiSettings);
    for (const name of this.appliedUiVars) this.target.style.removeProperty(name);
    for (const [name, value] of Object.entries(vars)) this.target.style.setProperty(name, value);
    this.appliedUiVars = Object.keys(vars);
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.setAttribute('data-bp-ui-mode', mode);
      root.setAttribute('data-bp-ui-button-style', this.uiSettings.buttonStyle);
      // Theme CSS keeps its authored detail until an explicit global knob changes
      // that dimension. These flags let the user's overrides win without flattening
      // every theme's original presentation or touching any canvas/card content.
      const remap = mode !== tokens.mode;
      for (const [attribute, enabled] of Object.entries({
        'data-bp-ui-surface-override': remap || this.uiSettings.surface !== null || this.uiSettings.surfaceOpacity !== null,
        'data-bp-ui-contrast-override': remap || this.uiSettings.surface !== null || this.uiSettings.contrast === 'high',
        'data-bp-ui-button-override': this.uiSettings.buttonColor !== null || this.uiSettings.buttonOpacity !== null || this.uiSettings.buttonStyle !== 'soft',
        'data-bp-ui-radius-override': this.uiSettings.radius !== null,
      })) {
        if (enabled) root.setAttribute(attribute, '');
        else root.removeAttribute(attribute);
      }
    }
    for (const listener of [...this.uiListeners]) {
      try { listener(this.getUiSettings()); } catch (error) { console.error('[skin-engine] ui listener error:', error); }
    }
    // 主窗口底色跟随画布底色：纯色生效，渐变/url 回落默认暗底，避免切浅色皮肤时白闪。
    if (typeof window !== 'undefined') {
      const bg = vars['--bp-canvas-bg'] ?? DEFAULT_CANVAS_BACKGROUND;
      const solid = /^#[0-9a-f]{6}$/i.test(bg) ? bg : DEFAULT_CANVAS_BACKGROUND;
      try { window.artflowApp?.setWindowBackground?.(solid); } catch { /* 非 Electron 或通道不可用 */ }
    }
  }
}

/** 工厂（index.tsx 用）：只创建，不恢复状态、不 provide——先 provide 后 activate，插件 activate 才能 ctx.use 到本服务。 */
export function createSkinEngine(ctx: Kernel): SkinEngine {
  return new SkinEngine(ctx);
}

/**
 * 启动即应用默认皮肤（值 = 现有视觉，故零视觉变化）；有持久化状态则恢复上次选择（含混搭 + CSS 皮肤）。
 * 顺序红线：先 loadSkinState 再应用（setSkin/setCssSkin 都会落盘，顺序颠倒会自我覆盖）。
 * M3 启动兜底：持久化指向未注册的皮肤（插件被禁用/移除）→ 自动回落 + console.warn，绝不抛错。
 * 传 existing（index.tsx 已提前 provide 的实例）则复用；缺省自建。
 */
export function bootstrapSkinEngine(ctx: Kernel, existing?: SkinEngine): SkinEngine {
  const engine = existing ?? new SkinEngine(ctx);
  // 先读持久化状态再应用初始皮肤：setSkin 会写状态，顺序颠倒会自我覆盖
  const saved = loadSkinState();
  const hasSkin = (id: string) => engine.listSkins().some(s => s.id === id);
  try {
    // Restore the sole visual-preferences source before projecting tokens/CSS.
    if (saved?.uiSettings) engine.setUiSettings(saved.uiSettings);
    // CSS 层恢复（M1）：cssSkinId 存在且该皮肤已注册 CSS 才激活；否则忽略并清掉悬挂指针（隔离语义，不得抛错）
    if (saved?.cssSkinId) {
      if (engine.hasCssSkin(saved.cssSkinId)) {
        engine.setCssSkin(saved.cssSkinId);
      } else {
        console.warn(`[skin-engine] persisted css skin "${saved.cssSkinId}" has no registered css (plugin disabled/removed?); falling back to none`);
        engine.setCssSkin(null);
      }
    }
    // token 层恢复（含混搭）：持久化皮肤不在注册表 → 回落 + 告警（M3 启动兜底）
    if (saved?.composite && hasSkin(saved.composite.baseSkinId)) {
      engine.setComposite(saved.composite);
    } else if (saved?.skinId && hasSkin(saved.skinId)) {
      engine.setSkin(saved.skinId);
    } else {
      if (saved?.composite || saved?.skinId) {
        console.warn(`[skin-engine] persisted skin "${saved?.composite?.baseSkinId ?? saved?.skinId ?? '?'}" not registered (plugin disabled/removed?); falling back to default`);
      }
      if (ctx.contributions.get('skins', 'builtin.skin-default')) {
        engine.setSkin('builtin.skin-default');
      } else {
        const first = ctx.contributions.list('skins')[0]?.id;
        if (first) engine.setSkin(first);
      }
    }
  } catch (e) { console.error('[skin-engine] restore state failed:', e); }
  engine.syncSystemMode();
  setActiveSkinEngine(engine);
  return engine;
}

// —— 模块级活跃引擎引用：供 BpIcon 等无法走 kernel 注入的本体组件订阅换肤 ——
let activeSkinEngine: SkinEngine | null = null;

export function setActiveSkinEngine(engine: SkinEngine | null): void {
  activeSkinEngine = engine;
}

export function trySkinEngine(): SkinEngine | null {
  return activeSkinEngine;
}
