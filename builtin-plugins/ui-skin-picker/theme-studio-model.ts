import type { SkinCompositePart, SkinCompositeSelection, SkinEngine, SkinInfo } from '../../plugin-runtime/skin-engine';
import type { UiThemeSettings } from '../../plugin-runtime/ui-theme-settings';
import { peekPreference, setPreference, type PrefValue } from '../../plugin-runtime/preferences-store';

/** An explicit family key, never a guess based on names; legacy entries stay as one-card themes. */
export interface ThemeFamily {
  id: string;
  name: string;
  nameEn?: string;
  description?: string;
  descriptionEn?: string;
  credit?: string;
  variants: SkinInfo[];
  order: number;
}

export function groupThemeFamilies(skins: readonly SkinInfo[]): ThemeFamily[] {
  const groups = new Map<string, ThemeFamily>();
  for (const skin of skins) {
    const id = skin.gallery?.family ?? skin.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: skin.gallery?.title ?? skin.name,
        nameEn: skin.gallery?.titleEn,
        description: skin.gallery?.description,
        descriptionEn: skin.gallery?.descriptionEn,
        credit: skin.gallery?.credit,
        variants: [],
        order: skin.order ?? 100,
      };
      groups.set(id, group);
    }
    group.variants.push(skin);
    group.order = Math.min(group.order, skin.order ?? 100);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export interface AppearanceSnapshot {
  skinId: string;
  composite: SkinCompositeSelection | null;
  cssSkinId: string | null;
  uiSettings: UiThemeSettings;
}

export function snapshotAppearance(engine: SkinEngine): AppearanceSnapshot {
  const selection = engine.getComposite();
  return {
    skinId: engine.currentId_(),
    composite: selection ? { baseSkinId: selection.baseSkinId, overrides: { ...selection.overrides } } : null,
    cssSkinId: engine.getCssSkin(),
    uiSettings: engine.getUiSettings(),
  };
}

export function isSameAppearance(a: AppearanceSnapshot, b: AppearanceSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Apply the whole theme, not a toggle: remove an unrelated old CSS layer. */
export function applyWholeTheme(engine: SkinEngine, skin: SkinInfo): void {
  if (Object.keys(skin.tokens).length > 0 || !engine.hasCssSkin(skin.id)) engine.setSkin(skin.id);
  engine.setCssSkin(engine.hasCssSkin(skin.id) ? skin.id : null);
}

export function restoreAppearance(engine: SkinEngine, previous: AppearanceSnapshot): void {
  const available = new Set(engine.listSkins().map(skin => skin.id));
  if (previous.composite && available.has(previous.composite.baseSkinId)) {
    engine.setComposite(previous.composite);
  } else if (available.has(previous.skinId)) {
    engine.setSkin(previous.skinId);
  } else if (engine.listSkins()[0]) {
    engine.setSkin(engine.listSkins()[0].id);
  }
  engine.setCssSkin(previous.cssSkinId && engine.hasCssSkin(previous.cssSkinId) ? previous.cssSkinId : null);
  engine.setUiSettings(previous.uiSettings);
}

const FAVORITES_KEY = 'appearance.themeStudio.favorites';
const MIXES_KEY = 'appearance.themeStudio.mixes';
const PARTS: SkinCompositePart[] = ['card', 'chrome', 'canvas', 'typography', 'icons'];

export interface SavedThemeMix {
  id: string;
  name: string;
  selection: SkinCompositeSelection;
}

// 收藏 / 混色方案的持久化从 localStorage 搬到主进程 config/preferences.json
// （旧键 bp-theme-studio-*.v1 由 preferences-store 一次性采纳）。校验逻辑一行未改。
export function readFavorites(validFamilyIds: Set<string>): string[] {
  const raw = peekPreference(FAVORITES_KEY);
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string =>
    typeof id === 'string' && validFamilyIds.has(id)))].slice(0, 50) : [];
}

export function saveFavorites(ids: string[]): void {
  try { setPreference(FAVORITES_KEY, ids.slice(0, 50)); } catch { /* 存储不可用：仅会话级 */ }
}

export function readThemeMixes(validSkinIds: Set<string>): SavedThemeMix[] {
  const raw = peekPreference(MIXES_KEY);
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((mix): mix is SavedThemeMix => {
    if (!mix || typeof mix !== 'object') return false;
    const value = mix as Partial<SavedThemeMix>;
    const selection = value.selection;
    return typeof value.id === 'string' && value.id.length <= 80
      && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 32
      && !!selection && validSkinIds.has(selection.baseSkinId)
      && !!selection.overrides && typeof selection.overrides === 'object'
      && Object.entries(selection.overrides).every(([part, id]) =>
        PARTS.includes(part as SkinCompositePart) && typeof id === 'string' && validSkinIds.has(id));
  }).slice(0, 12);
}

export function saveThemeMixes(mixes: SavedThemeMix[]): void {
  try {
    setPreference(MIXES_KEY, mixes.slice(0, 12) as unknown as PrefValue);
  } catch { /* 存储不可用：仅会话级 */ }
}
