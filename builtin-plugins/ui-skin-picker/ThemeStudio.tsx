import React, { useEffect, useRef, useState } from 'react';
import type { PluginPanelProps } from '../../plugin-runtime/panel-contributions';
import {
  SKIN_ENGINE_SERVICE,
  type SkinCompositePart, type SkinCompositeSelection, type SkinEngine, type SkinInfo, type SkinLivePreview,
} from '../../plugin-runtime/skin-engine';
import type { SkinSettingField } from '../../plugin-runtime/skin-customization';
import { useLanguage } from '../../utils/language-store';
import { ThemeArtwork } from './ThemePreview';
import { UiThemeControls } from './UiThemeControls';
import { WallpaperControls } from './WallpaperControls';
import { Panel } from './Panel';
import { BpIcon } from '../../components/BpIcon';
import { themeWallpaperStore, type WallpaperEntry } from '../../plugin-runtime/theme-wallpaper';
import { resolveUiChrome, systemUiMode, type UiThemeMode, type UiThemeSettings } from '../../plugin-runtime/ui-theme-settings';
import {
  groupThemeFamilies, isSameAppearance, readFavorites, readThemeMixes,
  restoreAppearance, saveFavorites, saveThemeMixes, snapshotAppearance,
  type AppearanceSnapshot, type ThemeFamily,
} from './theme-studio-model';

type Section = 'gallery' | 'controls' | 'wallpaper' | 'mix' | 'mine';
type Filter = 'all' | 'dark' | 'light' | 'styled';
type UndoApplication = {
  before: AppearanceSnapshot;
  after: AppearanceSnapshot;
  configBefore: Record<string, Record<string, unknown>>;
  configAfter: Record<string, Record<string, unknown>>;
  importedWallpapers: string[];
};
const recentApplications = new WeakMap<SkinEngine, UndoApplication>();
const PARTS: SkinCompositePart[] = ['card', 'chrome', 'canvas', 'typography', 'icons'];
const PART_LABELS: Record<SkinCompositePart, [string, string]> = {
  card: ['卡片', 'Cards'], chrome: ['外壳', 'Chrome'], canvas: ['画布', 'Canvas'],
  typography: ['字体', 'Type'], icons: ['图标', 'Icons'],
};
const text = (zh: boolean, cn: string, en: string) => zh ? cn : en;
const themeName = (family: ThemeFamily, zh: boolean) => zh ? family.name : family.nameEn ?? family.name;
const cover = (skin: SkinInfo) => skin.gallery?.poster ?? skin.preview?.[skin.mode];
const selectionFrom = (baseId: string, overrides: Partial<Record<SkinCompositePart, string>>): SkinCompositeSelection => ({
  baseSkinId: baseId,
  overrides: Object.fromEntries(Object.entries(overrides).filter(([, id]) => id && id !== baseId)) as SkinCompositeSelection['overrides'],
});

const SettingRow: React.FC<{ field: SkinSettingField; value: unknown; onChange: (patch: Record<string, unknown>) => void }> = ({ field, value, onChange }) => {
  const control = 'mt-1 w-full rounded-lg border border-white/15 bg-[#23272b] px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-white/45';
  if (field.type === 'boolean') return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-xs text-slate-300">
      <span>{field.label}</span>
      <input type="checkbox" checked={value === true} onChange={event => onChange({ [field.key]: event.target.checked })}
        className="h-4 w-4 shrink-0 accent-slate-200" />
    </label>
  );
  if (field.type === 'number') return (
    <label className="block text-xs text-slate-300">{field.label}
      <input type="number" className={control} value={String(value ?? '')} min={field.min} max={field.max} step={field.step}
        onChange={event => { if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) onChange({ [field.key]: Number(event.target.value) }); }} />
    </label>
  );
  if (field.type === 'select') return (
    <label className="block text-xs text-slate-300">{field.label}
      <select className={control} value={String(value ?? '')} onChange={event => onChange({ [field.key]: event.target.value })}>
        {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
  return (
    <label className="block text-xs text-slate-300">{field.label}
      <input type="text" className={control} value={String(value ?? '')} maxLength={field.maxLength}
        onChange={event => onChange({ [field.key]: event.target.value })} />
    </label>
  );
};

/** The floating studio previews on the REAL host chrome, without storing drafts or blocking the canvas. */
export const ThemeStudio: React.FC<PluginPanelProps> = ({ kernel, chromeless = false }) => {
  const zh = useLanguage() === 'zho';
  const engine = kernel.use(SKIN_ENGINE_SERVICE) as SkinEngine;
  const skins = engine.listSkins();
  const families = groupThemeFamilies(skins);
  const validIds = new Set(skins.map(skin => skin.id));
  const initial = snapshotAppearance(engine);
  const [applied, setApplied] = useState<AppearanceSnapshot>(initial);
  const [effective, setEffective] = useState<AppearanceSnapshot>(initial);
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState<Section>('gallery');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [section]);
  const [selectedId, setSelectedId] = useState(() => engine.getCssSkin() ?? engine.getComposite()?.baseSkinId ?? engine.currentId_());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [favorites, setFavorites] = useState(() => readFavorites(new Set(families.map(family => family.id))));
  const [savedMixes, setSavedMixes] = useState(() => readThemeMixes(validIds));
  const [baseId, setBaseId] = useState(() => engine.getComposite()?.baseSkinId ?? (validIds.has(engine.currentId_()) ? engine.currentId_() : skins[0]?.id ?? ''));
  const [overrides, setOverrides] = useState<Partial<Record<SkinCompositePart, string>>>(() => ({ ...engine.getComposite()?.overrides }));
  const [part, setPart] = useState<SkinCompositePart>('card');
  const [keepCss, setKeepCss] = useState(false);
  const [mixName, setMixName] = useState(text(zh, '我的混搭', 'My mix'));
  const [undo, setUndo] = useState<UndoApplication | null>(() => recentApplications.get(engine) ?? null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiSettings, setUiSettings] = useState<UiThemeSettings>(() => engine.getUiSettings());
  const sessionRef = useRef<SkinLivePreview | null>(null);
  const configBeforeRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const stagedWallpaperIdsRef = useRef<string[]>([]);
  const applyingRef = useRef(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');

  const selected = skins.find(skin => skin.id === selectedId) ?? skins[0];
  const selectedFamily = families.find(family => family.variants.some(skin => skin.id === selected?.id));
  const draft = skins.find(skin => skin.id === baseId) ? selectionFrom(baseId, overrides) : null;
  const currentFamily = families.find(family => family.variants.some(skin => skin.id === (applied.cssSkinId ?? applied.composite?.baseSkinId ?? applied.skinId)));
  const configSkin = section === 'gallery' && selected?.customization ? selected : null;
  // An applied System-mode pair may flip from dark to light after Apply. That is
  // still the same user choice, so the recent Undo remains available.
  const sameApplied = (actual: AppearanceSnapshot, recorded: AppearanceSnapshot): boolean => {
    if (isSameAppearance(actual, recorded)) return true;
    if (actual.uiSettings.mode !== 'system' || recorded.uiSettings.mode !== 'system'
      || actual.composite || recorded.composite
      || JSON.stringify(actual.uiSettings) !== JSON.stringify(recorded.uiSettings)) return false;
    const family = (id: string | null) => skins.find(skin => skin.id === id)?.gallery?.family;
    const tokenMatches = actual.skinId === recorded.skinId ||
      (!!family(actual.skinId) && family(actual.skinId) === family(recorded.skinId));
    const cssMatches = actual.cssSkinId === recorded.cssSkinId ||
      (!!actual.cssSkinId && !!recorded.cssSkinId && !!family(actual.cssSkinId)
        && family(actual.cssSkinId) === family(recorded.cssSkinId));
    return tokenMatches && cssMatches;
  };
  const canUndo = !!undo && sameApplied(applied, undo.after);

  useEffect(() => {
    sessionRef.current = engine.startLivePreview();
    const sync = () => {
      const snapshot = snapshotAppearance(engine);
      setEffective(snapshot);
      const active = sessionRef.current;
      if (!active?.isActive()) { setApplied(snapshot); setDirty(false); }
      else {
        const hasDraft = active.isDirty();
        setDirty(hasDraft);
        if (!hasDraft) setApplied(snapshot);
      }
    };
    const offTokens = engine.subscribe(sync);
    const offCss = engine.subscribeCssSkin(sync);
    const offUi = engine.subscribeUiSettings(settings => { setUiSettings(settings); sync(); });
    return () => {
      offTokens(); offCss(); offUi();
      sessionRef.current?.cancel();
      sessionRef.current = null;
      for (const id of stagedWallpaperIdsRef.current) themeWallpaperStore.forgetDraft(id);
      stagedWallpaperIdsRef.current = [];
    };
  }, [engine]);

  useEffect(() => {
    if (!configSkin) { setConfig({}); return; }
    setConfig(engine.getSkinConfig(configSkin.id));
    return engine.onSkinConfig(configSkin.id, setConfig);
  }, [engine, configSkin?.id]);

  const session = () => {
    if (!sessionRef.current?.isActive()) sessionRef.current = engine.startLivePreview();
    return sessionRef.current;
  };
  const syncDraft = () => { setEffective(snapshotAppearance(engine)); setDirty(session().isDirty()); };
  const showSkin = (id: string, explicitMode = false) => {
    const choice = skins.find(skin => skin.id === id);
    if (!choice) return;
    const family = families.find(group => group.variants.some(skin => skin.id === id));
    const requested = uiSettings.mode === 'system' ? systemUiMode() : uiSettings.mode;
    const target = !explicitMode && requested !== 'theme'
      ? family?.variants.find(variant => variant.mode === requested) ?? choice : choice;
    session().previewSkin(target.id);
    // Clicking a particular light/dark variant is an explicit global mode choice.
    if (explicitMode) session().previewUiSettings({ mode: target.mode });
    setSelectedId(target.id);
    syncDraft();
  };
  const previewMode = (mode: UiThemeMode) => {
    const current = effective.cssSkinId ?? effective.composite?.baseSkinId ?? effective.skinId;
    const family = families.find(group => group.variants.some(skin => skin.id === current));
    const requested = mode === 'system' ? systemUiMode() : mode;
    const variant = requested !== 'theme' && !effective.composite
      ? family?.variants.find(skin => skin.mode === requested) : null;
    if (variant && variant.id !== current) {
      session().previewSkin(variant.id);
      setSelectedId(variant.id);
    }
    session().previewUiSettings({ mode });
    syncDraft();
  };
  const previewUiSettings = (patch: Partial<UiThemeSettings>) => {
    session().previewUiSettings(patch);
    syncDraft();
  };
  const showMix = (nextBase: string, nextOverrides: Partial<Record<SkinCompositePart, string>>, keep = keepCss) => {
    if (!validIds.has(nextBase)) return;
    session().previewMix(selectionFrom(nextBase, nextOverrides), keep);
    syncDraft();
  };
  const stageWallpaper = async (file: File): Promise<WallpaperEntry> => {
    const entry = await themeWallpaperStore.stage(file);
    if (!sessionRef.current?.isActive()) { themeWallpaperStore.forgetDraft(entry.id); throw new Error('Preview closed'); }
    stagedWallpaperIdsRef.current.push(entry.id);
    const settings = engine.getUiSettings();
    const paired = settings.wallpaperAuto === 'system' || settings.wallpaperAuto === 'both';
    const key = resolveUiChrome(engine.currentTokens(), settings).mode === 'light' ? 'wallpaperLightId' : 'wallpaperDarkId';
    session().previewUiSettings(paired ? { wallpaperId: entry.id, [key]: entry.id } : { wallpaperId: entry.id });
    syncDraft();
    return entry;
  };
  const forgetWallpaper = (id: string) => {
    stagedWallpaperIdsRef.current = stagedWallpaperIdsRef.current.filter(item => item !== id);
    const patch: Partial<UiThemeSettings> = {};
    for (const key of ['wallpaperId', 'wallpaperLightId', 'wallpaperDarkId'] as const) {
      if (uiSettings[key] === id) patch[key] = null;
    }
    if (Object.keys(patch).length) previewUiSettings(patch);
    themeWallpaperStore.forgetDraft(id);
  };
  const resetDraft = () => {
    if (applyingRef.current) return;
    sessionRef.current?.cancel();
    for (const id of stagedWallpaperIdsRef.current) themeWallpaperStore.forgetDraft(id);
    stagedWallpaperIdsRef.current = [];
    setApplyError('');
    configBeforeRef.current.clear();
    sessionRef.current = engine.startLivePreview();
    const current = snapshotAppearance(engine);
    setApplied(current); setEffective(current); setDirty(false);
    setSelectedId(current.cssSkinId ?? current.composite?.baseSkinId ?? current.skinId);
    setBaseId(current.composite?.baseSkinId ?? current.skinId);
    setOverrides({ ...current.composite?.overrides });
    setKeepCss(false);
    setUiSettings(engine.getUiSettings());
  };
  const applyDraft = async () => {
    const active = sessionRef.current;
    if (applyingRef.current || !active?.isActive() || !active.isDirty()) return;
    applyingRef.current = true; setApplying(true); setApplyError('');
    const before = applied;
    const beforeConfigs = Object.fromEntries(configBeforeRef.current);
    const importedWallpapers = [...stagedWallpaperIdsRef.current];
    let saved = false;
    try {
      await themeWallpaperStore.commitDrafts(importedWallpapers);
      saved = importedWallpapers.length > 0;
      if (!active.isActive() || !active.commit()) {
        if (saved) await themeWallpaperStore.removeCommitted(importedWallpapers);
        return;
      }
      stagedWallpaperIdsRef.current = [];
      const after = snapshotAppearance(engine);
      const afterConfigs = Object.fromEntries([...configBeforeRef.current.keys()].map(id => [id, engine.getSkinConfig(id)]));
      const changedConfigs = Object.keys(beforeConfigs).some(id => JSON.stringify(beforeConfigs[id]) !== JSON.stringify(afterConfigs[id]));
      const record = !isSameAppearance(before, after) || changedConfigs || saved ? {
        before, after, configBefore: beforeConfigs, configAfter: afterConfigs, importedWallpapers,
      } : null;
      if (record) recentApplications.set(engine, record);
      else recentApplications.delete(engine);
      setUndo(record);
      configBeforeRef.current.clear();
      setApplied(after); setEffective(after); setDirty(false);
      sessionRef.current = engine.startLivePreview();
    } catch (error) {
      if (saved) await themeWallpaperStore.removeCommitted(importedWallpapers).catch(() => {});
      setApplyError(text(zh, `壁纸保存失败，外观未应用：${(error as Error).message}`, `Wallpaper storage failed; appearance not applied: ${(error as Error).message}`));
    } finally { applyingRef.current = false; setApplying(false); }
  };
  const undoApply = () => {
    if (!undo || applyingRef.current) return;
    sessionRef.current?.cancel();
    for (const id of stagedWallpaperIdsRef.current) themeWallpaperStore.forgetDraft(id);
    stagedWallpaperIdsRef.current = [];
    if (sameApplied(snapshotAppearance(engine), undo.after)) {
      void themeWallpaperStore.removeCommitted(undo.importedWallpapers ?? []).catch(error => console.warn('[wallpapers] undo cleanup failed:', error));
      restoreAppearance(engine, undo.before);
      for (const id of Object.keys(undo.configBefore)) {
        if (JSON.stringify(engine.getSkinConfig(id)) === JSON.stringify(undo.configAfter[id])) {
          engine.setSkinConfig(id, undo.configBefore[id]);
        }
      }
    }
    recentApplications.delete(engine);
    setUndo(null);
    configBeforeRef.current.clear();
    const current = snapshotAppearance(engine);
    setApplied(current); setEffective(current); setDirty(false);
    setSelectedId(current.cssSkinId ?? current.composite?.baseSkinId ?? current.skinId);
    setBaseId(current.composite?.baseSkinId ?? current.skinId);
    setOverrides({ ...current.composite?.overrides });
    setUiSettings(engine.getUiSettings());
    sessionRef.current = engine.startLivePreview();
  };
  const previewConfig = (id: string, patch: Record<string, unknown>) => {
    if (!configBeforeRef.current.has(id)) configBeforeRef.current.set(id, engine.getSkinConfig(id));
    session().previewConfig(id, patch);
    setConfig(engine.getSkinConfig(id));
    syncDraft();
  };
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];
    setFavorites(next); saveFavorites(next);
  };
  // Navigation is not a selection: keep the last real-world trial until a control changes it.
  const selectSection = (next: Section) => setSection(next);
  const applyPart = (nextPart: SkinCompositePart, source: string | null) => {
    const next = { ...overrides };
    if (source && source !== baseId) next[nextPart] = source;
    else delete next[nextPart];
    setOverrides(next); showMix(baseId, next);
  };
  const saveMix = () => {
    if (!draft || savedMixes.length >= 12) return;
    const name = mixName.trim().slice(0, 32) || text(zh, '我的混搭', 'My mix');
    const next = [{ id: `mix-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, selection: draft }, ...savedMixes];
    setSavedMixes(next); saveThemeMixes(next);
    setSection('mine');
  };
  const loadMix = (selection: SkinCompositeSelection) => {
    setBaseId(selection.baseSkinId); setOverrides({ ...selection.overrides }); setSection('mix');
    showMix(selection.baseSkinId, selection.overrides);
  };
  const modeName = (mode: 'dark' | 'light') => mode === 'dark' ? text(zh, '深色', 'Dark') : text(zh, '浅色', 'Light');
  const filtered = families.filter(family => {
    if (filter === 'styled' && !family.variants.some(skin => engine.hasCssSkin(skin.id))) return false;
    if ((filter === 'dark' || filter === 'light') && !family.variants.some(skin => skin.mode === filter)) return false;
    const query = [family.name, family.nameEn, ...family.variants.flatMap(skin => [skin.name, ...(skin.tags ?? [])])].join(' ').toLowerCase();
    return query.includes(search.trim().toLowerCase());
  });

  return (
    <div data-bp-theme-studio="" data-bp-ui-themed="" data-bp-preview-state={dirty ? 'draft' : 'applied'} className={`flex min-h-0 flex-col h-[min(38rem,calc(100dvh-10rem))] ${chromeless ? 'flex-1' : 'text-slate-100'}`}>
      {!chromeless && <div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="flex items-center gap-2.5">
          {/* M6：主题化应用 Logo（皮肤声明 tokens.icons.appLogo；缺省回退到内置标记）。 */}
          <BpIcon name="appLogo" size={26} className="shrink-0 opacity-90" fallback={<span className="text-sm font-semibold tracking-[0.2em] text-slate-200">AR</span>} />
        <div>
          <p className="text-[10px] font-medium tracking-[0.14em] text-slate-400">{text(zh, '外观设置 / APPEARANCE', 'WORKSPACE / APPEARANCE')}</p>
          <p className="mt-0.5 text-xs text-slate-300">{text(zh, '边选边看，真实工具面板即时更新', 'See the real tools change as you explore')}</p>
        </div>
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${dirty ? 'border-white/25 text-slate-100' : 'border-white/10 text-slate-400'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-cyan-500' : 'bg-slate-500'}`} />
          {dirty ? text(zh, '试用中', 'Previewing') : text(zh, '已同步', 'Applied')}
        </span>
      </div>}
      <nav aria-label={text(zh, '外观分类', 'Appearance sections')} className="mb-3 flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-white/[0.045] p-1">
        {([['gallery', '主题', 'Themes'], ['controls', '界面调节', 'Interface'], ['wallpaper', '壁纸', 'Wallpaper'], ['mix', '高级混搭', 'Mix'], ['mine', '收藏与配方', 'Saved']] as const).map(([key, cn, en]) => (
          <button key={key} type="button" aria-current={section === key ? 'page' : undefined} onClick={() => selectSection(key)}
            className={`min-w-max flex-1 whitespace-nowrap rounded-md px-2 py-2 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-100 ${section === key ? 'bg-white/15 text-slate-50' : 'text-slate-400 hover:bg-white/[0.08] hover:text-slate-200'}`}>{text(zh, cn, en)}</button>
        ))}
      </nav>

      <div ref={scrollRef} data-bp-theme-scroll="" className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1.5 [scrollbar-width:thin] [scrollbar-color:#555_transparent]">
        {section === 'controls' && <UiThemeControls zh={zh} settings={uiSettings}
          tokens={engine.currentTokens()} onChange={previewUiSettings} onMode={previewMode} />}
        {section === 'wallpaper' && <WallpaperControls zh={zh} kernel={kernel} engine={engine} settings={uiSettings}
          onChange={previewUiSettings} onStage={stageWallpaper} onForget={forgetWallpaper} />}
        {section === 'gallery' && <div data-bp-theme-gallery-layout="" className="grid min-w-0 gap-3 min-[800px]:grid-cols-[minmax(0,1fr)_15rem]">
          <aside className="order-1 min-w-0 space-y-3 min-[800px]:order-2">
          {selected && selectedFamily && (
            <section data-bp-theme-detail="" aria-label={text(zh, '所选主题', 'Selected theme')}
              className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="hidden min-[800px]:block"><ThemeArtwork title={themeName(selectedFamily, zh)} tokens={engine.resolveSkin(selected.id)} poster={cover(selected)} compact /></div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h3 className="truncate text-[13px] font-semibold">{themeName(selectedFamily, zh)}</h3>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-slate-400">{zh ? selectedFamily.description : selectedFamily.descriptionEn ?? selectedFamily.description ?? selected.name}</p></div>
                <span className="shrink-0 rounded-md bg-white/[0.07] px-2 py-1 text-[10px] text-slate-300">{selectedFamily.variants.length > 1 ? text(zh, '明暗双版', '2 modes') : modeName(selected.mode)}</span>
              </div>
              {selectedFamily.variants.length > 1 && <div role="group" aria-label={text(zh, '选择明暗模式', 'Choose light or dark variant')} className="grid grid-cols-2 gap-2">
                {selectedFamily.variants.map(variant => <button key={variant.id} type="button" aria-pressed={selected.id === variant.id} onClick={() => showSkin(variant.id, true)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${selected.id === variant.id ? 'border-white/45 bg-white/[0.10] text-slate-50' : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'}`}>
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/25" style={{ background: engine.resolveSkin(variant.id).color.cardBg }} />
                  <span>{modeName(variant.mode)}</span>
                  {selected.id === variant.id && <span className="ml-auto text-[10px]">✓</span>}
                </button>)}
              </div>}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[10px] text-slate-400">
                {engine.hasCssSkin(selected.id) && <span className="rounded bg-white/[0.07] px-1.5 py-0.5">{text(zh, '含样式层', 'Style layer')}</span>}
                {selected.tags?.slice(0, 3).map(tag => <span key={tag} className="rounded bg-white/[0.05] px-1.5 py-0.5">{tag}</span>)}
              </div>
              {selectedFamily.credit && <p className="text-[10px] leading-4 text-slate-500">{selectedFamily.credit}</p>}
            </section>
          )}
          {configSkin && <Panel title={`${text(zh, '主题细节', 'Theme details')} · ${configSkin.customization!.title}`} ariaLabel={text(zh, '主题细节', 'Theme details')}>
            <details data-bp-theme-settings="" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)} className="space-y-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-200">{text(zh, '调整会立即预览，应用前不会保存。', 'Changes preview instantly and are not saved until applied.')}</summary>
              <div className="space-y-2 border-t border-white/10 pt-2">{configSkin.customization!.settings.map(field =>
                <SettingRow key={field.key} field={field} value={config[field.key]} onChange={patch => previewConfig(configSkin.id, patch)} />)}
              </div>
            </details>
          </Panel>}
          </aside>
          <div className="order-2 min-w-0 min-[800px]:order-1">
          <Panel title={text(zh, '主题库', 'Library')} badge={<span className="text-[10px] text-slate-400">{families.length}</span>} ariaLabel={text(zh, '主题列表', 'Theme list')}>
            <div className="space-y-2.5">
              <input type="search" aria-label={text(zh, '搜索主题', 'Search themes')} value={search} onChange={event => setSearch(event.target.value)}
                placeholder={text(zh, '查找主题…', 'Find a theme…')} className="w-full rounded-lg border border-white/10 bg-[#22262a] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-white/40" />
              <div className="flex gap-1.5">{([['all', '全部', 'All'], ['dark', '深色', 'Dark'], ['light', '浅色', 'Light'], ['styled', '样式', 'Effects']] as const).map(([key, cn, en]) =>
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}
                  className={`rounded-md px-2 py-1 text-[10px] transition-colors ${filter === key ? 'bg-white/15 text-slate-50' : 'text-slate-400 hover:bg-white/[0.07]'}`}>{text(zh, cn, en)}</button>)}</div>
              <ul data-bp-theme-library="" className="grid max-h-[24rem] grid-cols-1 gap-2 overflow-y-auto overscroll-contain pr-1 min-[480px]:grid-cols-2 min-[800px]:grid-cols-1">{filtered.map(family => {
                const variant = family.variants.find(skin => skin.id === selected?.id) ?? family.variants[0];
                const highlighted = selectedFamily?.id === family.id;
                const favorite = favorites.includes(family.id);
                const tokens = engine.resolveSkin(variant.id);
                return <li key={family.id} className={`relative rounded-lg border transition-colors ${highlighted ? 'border-white/50 bg-white/[0.085]' : 'border-white/10 bg-white/[0.025] hover:border-white/25'}`}>
                  <button type="button" data-bp-theme-tile={family.id} aria-pressed={highlighted}
                    onClick={() => { const preferred = filter === 'light' || filter === 'dark' ? family.variants.find(s => s.mode === filter) : null; showSkin(preferred?.id ?? variant.id, !!preferred); }}
                    className="flex w-full items-center gap-2 p-2 pr-8 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60">
                    <span className="relative h-12 w-14 shrink-0 overflow-hidden rounded-md border border-white/10" style={{ background: tokens.canvas.background ?? tokens.color.cardBgAlt }}>
                      {cover(variant) && <img src={cover(variant)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />}
                    </span>
                    <span className="min-w-0"><span className="block truncate text-[11px] font-medium text-slate-100">{themeName(family, zh)}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-slate-500">{family.variants.length > 1 ? text(zh, '浅色 / 深色', 'Light / Dark') : modeName(variant.mode)}</span>
                      <span className="mt-1.5 flex gap-1" aria-hidden="true"><i className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.color.accent }} /><i className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.color.cardBgAlt }} /><i className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.color.textMuted }} /></span>
                    </span>
                  </button>
                  <button type="button" aria-pressed={favorite} aria-label={favorite ? text(zh, `取消收藏${themeName(family, zh)}`, `Remove ${themeName(family, zh)} from favorites`) : text(zh, `收藏${themeName(family, zh)}`, `Favorite ${themeName(family, zh)}`)}
                    onClick={() => toggleFavorite(family.id)} className={`absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md hover:bg-white/10 ${favorite ? 'text-amber-200' : 'text-slate-500'}`}>
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4"><path d="m10 2.5 2.3 4.65 5.14.75-3.72 3.63.88 5.12L10 14.23l-4.6 2.42.88-5.12L2.56 7.9l5.14-.75L10 2.5Z" /></svg>
                  </button>
                </li>;
              })}</ul>
              {filtered.length === 0 && <p className="py-5 text-center text-xs text-slate-400">{text(zh, '没有匹配的主题', 'No matching themes')}</p>}
            </div>
          </Panel>
          </div>
        </div>}

        {section === 'mix' && <div className="space-y-4">
          <p className="text-[11px] leading-5 text-slate-400">{text(zh, '选择来源，工具栏和面板会立即预览。未应用的混搭可随时还原。', 'Choose a source to preview it on real toolbars and panels. Unapplied changes can be reset.')}</p>
          <Panel title={<><span className="font-mono text-slate-400">01</span> {text(zh, '底座主题', 'Base')}</>} ariaLabel={text(zh, '底座主题', 'Base theme')}>
            <div className="grid max-h-32 grid-cols-2 gap-1.5 overflow-y-auto pr-1">{skins.map(skin =>
              <button key={skin.id} type="button" aria-pressed={baseId === skin.id} onClick={() => { setBaseId(skin.id); showMix(skin.id, overrides); }}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors ${baseId === skin.id ? 'border-white/40 bg-white/10 text-slate-50' : 'border-white/10 text-slate-300 hover:bg-white/[0.07]'}`}>
                <span className="h-4 w-4 shrink-0 rounded-md" style={{ background: engine.resolveSkin(skin.id).color.accent }} /><span className="truncate">{skin.name}</span>
              </button>)}</div>
          </Panel>
          <Panel title={<><span className="font-mono text-slate-400">02</span> {text(zh, '选择要更换的部分', 'Pick a part')}</>} ariaLabel={text(zh, '自定义维度', 'Customize parts')}>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">{PARTS.map(key => <button key={key} type="button" aria-pressed={part === key} onClick={() => setPart(key)}
                className={`rounded-md border px-2 py-1.5 text-[11px] transition-colors ${part === key ? 'border-white/40 bg-white/10 text-slate-50' : 'border-white/10 text-slate-400 hover:border-white/25'}`}>{text(zh, ...PART_LABELS[key])}{overrides[key] && overrides[key] !== baseId ? <i className="ml-1.5 inline-block h-1 w-1 rounded-full bg-amber-200" /> : null}</button>)}</div>
              <p className="text-[10px] text-slate-400">{text(zh, `从以下主题选择${PART_LABELS[part][0]}，或沿用底座`, `Choose ${PART_LABELS[part][1].toLowerCase()} from a theme, or keep the base`)}</p>
              <div className="grid max-h-36 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                <button type="button" aria-pressed={!overrides[part] || overrides[part] === baseId} onClick={() => applyPart(part, null)}
                  className={`rounded-lg border px-2.5 py-2 text-left text-[11px] ${!overrides[part] || overrides[part] === baseId ? 'border-white/40 bg-white/10 text-slate-50' : 'border-white/10 text-slate-300 hover:bg-white/[0.07]'}`}>{text(zh, '沿用底座', 'Use base')}</button>
                {skins.filter(s => s.id !== baseId).map(skin => <button key={skin.id} type="button" aria-pressed={overrides[part] === skin.id} onClick={() => applyPart(part, skin.id)}
                  className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] ${overrides[part] === skin.id ? 'border-white/40 bg-white/10 text-slate-50' : 'border-white/10 text-slate-300 hover:bg-white/[0.07]'}`}>
                    <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: engine.resolveSkin(skin.id).color.accent }} /><span className="truncate">{skin.name}</span>
                  </button>)}
              </div>
            </div>
          </Panel>
          <Panel ariaLabel={text(zh, '保存混搭', 'Save mix')}>
            <div className="space-y-2.5">
              <label className="flex items-center gap-2 text-[11px] text-slate-300">
                <input type="checkbox" checked={keepCss} onChange={event => { setKeepCss(event.target.checked); if (draft) showMix(draft.baseSkinId, draft.overrides, event.target.checked); }} className="accent-slate-200" />
                {text(zh, '保留当前样式层', 'Keep current style layer')}
              </label>
              <div className="flex items-center gap-2">
                <input type="text" aria-label={text(zh, '混搭名称', 'Mix name')} maxLength={32} value={mixName} onChange={event => setMixName(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#23272b] px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-white/45" />
                <button type="button" disabled={!draft || savedMixes.length >= 12} onClick={saveMix}
                  className="rounded-lg border border-white/20 px-2.5 py-2 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-35">{text(zh, '保存配方', 'Save recipe')}</button>
              </div>
              <p className="text-[10px] text-slate-500">{text(zh, '保存配方不等于应用。', 'Saving a recipe does not apply it.')}</p>
            </div>
          </Panel>
        </div>}

        {section === 'mine' && <div className="space-y-4">
          <Panel title={text(zh, '收藏主题', 'Favorites')} badge={<span className="text-slate-500">{favorites.length}</span>} ariaLabel={text(zh, '收藏主题', 'Favorites')}>
            {favorites.length === 0 ? <p className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center text-xs text-slate-400">{text(zh, '在主题库点星标，即可放在这里。', 'Star a theme to keep it here.')}</p> :
              <ul className="space-y-1.5">{families.filter(family => favorites.includes(family.id)).map(family => <li key={family.id}>
                <button type="button" onClick={() => { setSection('gallery'); showSkin(family.variants[0].id); }}
                  className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-slate-200 hover:border-white/30 hover:bg-white/[0.05]">
                  <span className="h-3 w-3 rounded-full" style={{ background: engine.resolveSkin(family.variants[0].id).color.accent }} /><span className="min-w-0 flex-1 truncate">{themeName(family, zh)}</span><span className="text-slate-500">↗</span>
                </button>
              </li>)}</ul>}
          </Panel>
          <Panel title={text(zh, '已存的混搭配方', 'Saved mixes')} badge={<span className="text-slate-500">{savedMixes.length}</span>} ariaLabel={text(zh, '已存的混搭配方', 'Saved mixes')}>
            {savedMixes.length === 0 ? <p className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center text-xs text-slate-400">{text(zh, '在混搭页保存自己的配方。', 'Save a recipe from the Mix tab.')}</p> :
              <ul className="space-y-1.5">{savedMixes.map(mix => <li key={mix.id} className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{mix.name}</span>
                <button type="button" onClick={() => loadMix(mix.selection)} className="rounded-md px-2 py-1 text-slate-200 hover:bg-white/10">{text(zh, '预览', 'Preview')}</button>
                <button type="button" aria-label={text(zh, `删除${mix.name}`, `Delete ${mix.name}`)} onClick={() => {
                  const next = savedMixes.filter(item => item.id !== mix.id); setSavedMixes(next); saveThemeMixes(next);
                }} className="rounded-md px-1.5 py-1 text-slate-500 hover:bg-white/10 hover:text-slate-200">×</button>
              </li>)}</ul>}
          </Panel>
        </div>}
      </div>

      <footer className="mt-3 shrink-0 border-t border-white/10 pt-3">
        <div className="mb-2 flex items-center gap-2 text-[10px] text-slate-400">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dirty ? 'bg-cyan-500' : 'bg-slate-500'}`} />
          <span className="min-w-0 flex-1 truncate">{dirty
            ? text(zh, '整套工具界面正在试用新外观 · 关闭即还原', 'Live across the whole interface · close to restore')
            : text(zh, `当前：${currentFamily ? themeName(currentFamily, zh) : '—'}`, `Current: ${currentFamily ? themeName(currentFamily, zh) : '—'}`)}</span>
          {effective.cssSkinId && <button type="button" onClick={() => { session().previewStyleLayer(null); syncDraft(); }}
            className="shrink-0 text-slate-400 underline-offset-2 hover:text-slate-100 hover:underline">{text(zh, '关样式', 'No style')}</button>}
        </div>
        {applyError && <p role="alert" className="mb-2 rounded-lg border border-white/15 bg-white/[0.05] px-2 py-1.5 text-[11px] text-slate-100">{applyError}</p>}
        <div className="flex items-center gap-2">
          <button type="button" disabled={!dirty || applying} onClick={resetDraft} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200 transition-colors hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-35">{text(zh, '还原', 'Reset')}</button>
          <button type="button" data-bp-ui-action="primary" disabled={!dirty || applying} onClick={() => void applyDraft()} className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-default disabled:opacity-45">{applying ? text(zh, '正在保存…', 'Saving…') : text(zh, '应用外观', 'Apply appearance')}</button>
          {canUndo && <button type="button" disabled={applying} onClick={undoApply} className="shrink-0 rounded-lg px-2 py-2 text-xs text-slate-300 hover:bg-white/[0.08]">{text(zh, '撤回', 'Undo')}</button>}
        </div>
      </footer>
    </div>
  );
};
