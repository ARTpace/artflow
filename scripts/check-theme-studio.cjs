#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
require('./register-typescript.cjs');
const {
  applyWholeTheme, groupThemeFamilies, isSameAppearance,
  readFavorites, readThemeMixes, restoreAppearance,
  saveFavorites, saveThemeMixes, snapshotAppearance,
} = require('../builtin-plugins/ui-skin-picker/theme-studio-model.ts');
const { SkinEngine } = require('../plugin-runtime/skin-engine.ts');
const { DEFAULT_UI_THEME_SETTINGS, normalizeUiThemeSettings, resolveUiChrome, DEFAULT_FONT_UI_STACK, DEFAULT_FONT_CONTENT_STACK, DEFAULT_CANVAS_GRID } = require('../plugin-runtime/ui-theme-settings.ts');
const { validateManifest } = require('../plugin-runtime/manifest.ts');

const check = (name, run) => { run(); console.log('  [ok]', name); };
const store = new Map();
global.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, value); },
  removeItem: key => { store.delete(key); },
};

// 皮肤数据已从 localStorage 搬到偏好卷（无主进程桥时 = localStorage['artflow.prefs.v1']）。
// 这里读的是**迁移后的新位置**，顺带守住"确实写进了偏好卷"这件事。
const prefVolume = () => {
  try { return JSON.parse(store.get('artflow.prefs.v1') ?? '{}'); } catch { return {}; }
};
const readPrefText = preferenceKey => {
  const value = prefVolume()[preferenceKey];
  return value === undefined ? null : JSON.stringify(value);
};
const readSkinState = () => readPrefText('appearance.skinState');
const readSkinConfig = skinId => readPrefText(`appearance.skinConfig.${skinId}`);

auto();
function auto() {
  check('pair grouping uses explicit family metadata, leaves older skins independent', () => {
    const pair = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/builtin.skins-abyssal-serenade/manifest.json'), 'utf8')).contributes.skins;
    const groups = groupThemeFamilies([...pair, { id: 'builtin.skin-classic', name: 'Classic', mode: 'dark', tokens: {} }]);
    assert.equal(groups.length, 2);
    const family = groups.find(group => group.id === 'builtin.abyssal-serenade');
    assert.equal(family.variants.length, 2);
    assert.deepEqual(new Set(family.variants.map(skin => skin.mode)), new Set(['dark', 'light']));
  });

  check('gallery metadata is validated and untrusted external poster is isolated', () => {
    // 外部声明式清单（plugins）刻意保持最小键集（被主进程 declarativePlugins 严格白名单约束），
    // 故这里用真实皮肤数据拼一个完整 PluginManifest 来验证 validateManifest 的 gallery 隔离逻辑。
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/builtin.skins-abyssal-serenade/manifest.json'), 'utf8'));
    const manifest = {
      manifestVersion: 1,
      id: real.id,
      version: real.version,
      name: real.name,
      author: 'Artflow',
      license: 'MIT',
      host: 'renderer',
      capabilities: ['ui.skin'],
      runtime: { mode: 'builtin', entry: 'index.tsx' },
      contributes: { skins: real.contributes.skins },
    };
    const valid = validateManifest(manifest);
    assert.equal(valid.contributes.skins.length, 2);
    assert.equal(valid.contributes.skins[0].gallery.family, 'builtin.abyssal-serenade');
    manifest.contributes.skins[0].gallery.poster = 'https://external.example/track.jpg';
    const warn = console.warn;
    console.warn = () => {};
    try { assert.equal(validateManifest(manifest).contributes.skins.length, 1); }
    finally { console.warn = warn; }
  });

  check('isolated mix preview does not write DOM vars, change selection, or persist state', () => {
    const values = [
      { id: 'skin.dark', value: { name: 'Dark', mode: 'dark', tokens: { color: { accent: '#111111' } } } },
      { id: 'skin.light', value: { name: 'Light', mode: 'light', tokens: { color: { accent: '#eeeeee' } } } },
    ];
    const ctx = { contributions: {
      get: (slot, id) => values.find(entry => entry.id === id),
      list: () => values,
    }, on: () => () => {} };
    let writes = 0;
    const target = { style: { setProperty: () => { writes++; }, removeProperty: () => { writes++; } } };
    const engine = new SkinEngine(ctx, target);
    engine.setSkin('skin.dark');
    const before = readSkinState();
    const appliedWrites = writes;
    const preview = engine.previewComposite({ baseSkinId: 'skin.dark', overrides: { card: 'skin.light' } });
    assert.equal(preview.color.accent, '#eeeeee');
    assert.equal(engine.currentId_(), 'skin.dark');
    assert.equal(engine.getComposite(), null);
    assert.equal(writes, appliedWrites);
    assert.equal(readSkinState(), before);
  });

  check('global UI settings sanitize input and derive legible light/dark chrome', () => {
    const defaults = normalizeUiThemeSettings(null);
    assert.deepEqual(defaults, DEFAULT_UI_THEME_SETTINGS);
    assert.deepEqual(normalizeUiThemeSettings({ mode: '<script>', accent: 'javascript:...', radius: -8,
      buttonOpacity: Infinity, toolbarSide: 'somewhere' }), defaults);
    const valid = normalizeUiThemeSettings({ mode: 'light', accent: '#Aa22Bb', surface: '#ffffff',
      surfaceOpacity: 0.9, buttonColor: '#123456', buttonStyle: 'solid', radius: 13,
      contrast: 'high', toolbarSide: 'right' });
    assert.equal(valid.accent, '#aa22bb'); assert.equal(valid.surfaceOpacity, 0.9);
    assert.equal(valid.toolbarSide, 'right');
    const { resolveSkinTokens } = require('../plugin-runtime/contributions.ts');
    const token = resolveSkinTokens({ mode: 'dark' });
    const original = resolveUiChrome(token, defaults);
    assert.equal(original.mode, 'dark');
    assert.equal(original.vars['--ui-bg-color'], token.chrome.panelBg);
    const light = resolveUiChrome(token, valid);
    assert.equal(light.mode, 'light');
    assert.equal(light.vars['--ui-text'], '#111e29');
    assert.equal(light.vars['--bp-ui-surface-strong'], 'rgba(255, 255, 255, 0.9)');
    assert.equal(light.vars['--bp-accent'], '#aa22bb');
    assert.equal(light.vars['--bp-ui-radius'], '13px');
    assert.equal(light.vars['--bp-ui-button-bg'], 'rgba(18, 52, 86, 1)');
    assert.equal(light.vars['--bp-ui-prompt-action'], 'rgba(18, 52, 86, 1)');
    assert.equal(resolveUiChrome(token, { ...valid, surface: '#111111' }).vars['--ui-text'], '#f9fcff');
  });

  check('live preview updates real token/CSS surfaces without saving; cancel restores CSS and settings', () => {
    const previousDocument = global.document;
    const previousWindow = global.window;
    const attrs = new Map(), css = new Map(), vars = new Map(), events = [];
    const listeners = new Map();
    const classes = new Set();
    const root = {
      style: { setProperty: (name, value) => vars.set(name, value), removeProperty: name => vars.delete(name) },
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
      getAttribute: name => attrs.get(name) ?? null,
      classList: { toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); return on; } },
    };
    global.document = {
      documentElement: root,
      head: { appendChild: element => { css.set(element.id, element); element.remove = () => css.delete(element.id); } },
      createElement: () => ({ id: '', setAttribute() {}, textContent: '' }),
      getElementById: id => css.get(id) ?? null,
    };
    global.window = { localStorage };
    try {
      const settings = { title: 'Settings', settings: [
        { key: 'showGlow', label: 'Glow', type: 'boolean', defaultValue: true },
      ], attributeBindings: [{ name: 'data-bp-test-glow', key: 'showGlow', on: 'on', off: 'off' }],
      classBindings: [{ key: 'showGlow', on: 'is-glow', off: 'is-dim' }] };
      const values = [
        { id: 'test.dark', value: { name: 'Dark', mode: 'dark', tokens: { color: { accent: '#111111' } } } },
        { id: 'test.light', value: { name: 'Light', mode: 'light', tokens: { color: { accent: '#eeeeee' } }, customization: settings } },
        { id: 'test.style-only', value: { name: 'Only CSS', mode: 'dark', tokens: {} } },
      ];
      const ctx = {
        contributions: { get: (_, id) => values.find(item => item.id === id), list: () => values },
        emit: (name, data) => {
          events.push([name, data]);
          // 真实内核语义：emit 必须投递给 on 注册的监听器（引擎的属性/binding 重投影挂在这上面）
          for (const cb of listeners.get(name) ?? []) cb(data);
        },
        on: (name, cb) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name).add(cb);
          return () => { listeners.get(name)?.delete(cb); };
        },
      };
      const engine = new SkinEngine(ctx, root);
      for (const id of ['test.dark', 'test.light', 'test.style-only']) {
        engine.registerSkinCss(id, id, `[data-bp-skin-active="${id}"] .widget { color: red; }`);
        assert(engine.hasCssSkin(id));
      }
      engine.setSkin('test.dark'); engine.setCssSkin('test.dark');
      const original = readSkinState();
      const beforeConfig = readSkinConfig('test.light');
      const draft = engine.startLivePreview();
      draft.previewSkin('test.light');
      assert.equal(vars.get('--bp-accent'), '#eeeeee');
      assert.equal(attrs.get('data-bp-skin-active'), 'test.light');
      assert.equal(attrs.get('data-bp-appearance-preview'), 'true');
      // M4 属性投影：激活即写入、live 配置变更即时更新、还原即恢复
      assert.equal(attrs.get('data-bp-test-glow'), 'on', 'attributeBindings project on skin activation');
      // M5 class 投影：激活即添加 on 类；配置变更时 on/off 互换；切走整体清理
      assert.equal(classes.has('is-glow'), true, 'classBindings project on skin activation');
      draft.previewConfig('test.light', { showGlow: false });
      assert.equal(attrs.get('data-bp-test-glow'), 'off', 'live config change re-projects the attribute');
      assert.equal(classes.has('is-glow'), false, 'live config change removes the on class');
      assert.equal(classes.has('is-dim'), true, 'live config change adds the off class');
      draft.previewConfig('test.light', { showGlow: true });
      assert.equal(attrs.get('data-bp-test-glow'), 'on', 'restoring config restores the attribute');
      assert.equal(classes.has('is-glow'), true, 'restoring config restores the on class');
      draft.previewConfig('test.light', { showGlow: false });
      draft.previewUiSettings({ mode: 'dark', accent: '#aabbcc', surface: '#123456',
        surfaceOpacity: 0.94, buttonStyle: 'outline', toolbarSide: 'right', radius: 14 });
      assert.equal(vars.get('--bp-accent'), '#aabbcc');
      assert.equal(attrs.get('data-bp-ui-mode'), 'dark');
      assert.equal(attrs.get('data-bp-ui-surface-override'), '');
      assert.equal(attrs.get('data-bp-ui-button-override'), '');
      assert.equal(attrs.get('data-bp-ui-radius-override'), '');
      assert.equal(vars.get('--bp-ui-radius'), '14px');
      assert.equal(engine.getUiSettings().toolbarSide, 'right');
      assert.equal(engine.getSkinConfig('test.light').showGlow, false);
      assert.equal(readSkinConfig('test.light'), beforeConfig);
      assert.equal(readSkinState(), original);
      draft.cancel();
      assert.equal(vars.get('--bp-accent'), '#111111');
      assert.equal(attrs.get('data-bp-ui-mode'), 'dark');
      assert.equal(engine.getUiSettings().toolbarSide, 'left');
      assert(!attrs.has('data-bp-ui-surface-override'));
      assert(!attrs.has('data-bp-ui-button-override'));
      assert(!attrs.has('data-bp-ui-radius-override'));
      assert.equal(attrs.get('data-bp-skin-active'), 'test.dark');
      assert.equal(attrs.has('data-bp-appearance-preview'), false);
      assert.equal(attrs.has('data-bp-test-glow'), false, 'switching away clears projected attributes');
      assert.equal(classes.has('is-glow'), false, 'switching away clears projected classes');
      assert.equal(classes.has('is-dim'), false, 'switching away clears projected off classes');
      assert.equal(engine.getSkinConfig('test.light').showGlow, true);
      assert.equal(readSkinState(), original);
      assert(events.some(([name, data]) => name === 'skin:config-changed' && data.config.showGlow === true));

      const cssOnly = engine.startLivePreview();
      cssOnly.previewSkin('test.style-only');
      assert.equal(engine.currentId_(), 'test.dark', 'CSS-only preview retains token base');
      assert.equal(engine.getCssSkin(), 'test.style-only');
      cssOnly.cancel();
      assert.equal(engine.getCssSkin(), 'test.dark');

      const mix = engine.startLivePreview();
      mix.previewMix({ baseSkinId: 'test.dark', overrides: { card: 'test.light' } });
      assert.equal(vars.get('--bp-accent'), '#eeeeee');
      assert.equal(engine.getCssSkin(), null, 'mix drops style unless opted in');
      assert.equal(readSkinState(), original);
      assert.equal(mix.commit(), true);
      assert.equal(engine.currentId_(), '__composite__');
      assert.equal(JSON.parse(readSkinState()).composite.overrides.card, 'test.light');
      assert.equal(attrs.has('data-bp-appearance-preview'), false);
      const retained = engine.startLivePreview();
      retained.previewSkin('test.light');
      retained.previewConfig('test.light', { showGlow: false });
      assert.equal(retained.commit(), true);
      assert.equal(JSON.parse(readSkinConfig('test.light')).showGlow, false);
      const external = engine.startLivePreview();
      external.previewSkin('test.dark');
      engine.setSkin('test.light'); // persistent external action interrupts the draft safely
      assert.equal(external.isActive(), false);
      assert.equal(engine.currentId_(), 'test.light');
      assert.equal(attrs.has('data-bp-appearance-preview'), false);
      assert.equal(JSON.parse(readSkinState()).skinId, 'test.light');
      const prefsOnly = engine.startLivePreview();
      const stable = readSkinState();
      prefsOnly.previewUiSettings({ mode: 'light', buttonColor: '#2860aa', buttonStyle: 'solid',
        contrast: 'high', toolbarSide: 'right' });
      assert.equal(attrs.get('data-bp-ui-mode'), 'light');
      assert.equal(vars.get('--bp-ui-button-bg'), 'rgba(40, 96, 170, 1)');
      assert.equal(readSkinState(), stable);
      assert.equal(prefsOnly.commit(), true);
      assert.equal(JSON.parse(readSkinState()).uiSettings.toolbarSide, 'right');
      const rewind = engine.startLivePreview();
      rewind.previewUiSettings({ toolbarSide: 'left', mode: 'dark' });
      const persisted = readSkinState();
      assert.equal(JSON.parse(persisted).uiSettings.mode, 'light');
      rewind.cancel();
      assert.equal(engine.getUiSettings().mode, 'light');
      assert.equal(engine.getUiSettings().toolbarSide, 'right');
    } finally {
      global.document = previousDocument;
      global.window = previousWindow;
    }
  });

  check('whole theme replaces both channels; second apply never toggles style off', () => {
    const skins = [
      { id: 'dark', tokens: { color: { accent: '#000' } } },
      { id: 'light', tokens: { color: { accent: '#fff' } } },
      { id: 'plain', tokens: {} },
      { id: 'css-only', tokens: {} },
    ];
    let id = 'dark', css = 'dark', mix = null;
    const engine = {
      listSkins: () => skins,
      currentId_: () => id,
      getCssSkin: () => css,
      getComposite: () => mix,
      hasCssSkin: key => ['dark', 'light', 'css-only'].includes(key),
      setSkin: key => { id = key; mix = null; },
      setCssSkin: key => { css = key; },
      setComposite: selection => { id = '__composite__'; mix = selection; },
    };
    applyWholeTheme(engine, skins[1]);
    assert.equal(id, 'light'); assert.equal(css, 'light');
    applyWholeTheme(engine, skins[1]);
    assert.equal(css, 'light');
    applyWholeTheme(engine, skins[2]);
    assert.equal(id, 'plain'); assert.equal(css, null);
    applyWholeTheme(engine, skins[3]);
    assert.equal(id, 'plain'); assert.equal(css, 'css-only'); // CSS-only leaves token base in place
  });

  check('undo restores prior mix + CSS layer without retaining an unrelated new layer', () => {
    const skins = [
      { id: 'dark', tokens: { color: { accent: '#000' } } },
      { id: 'light', tokens: { color: { accent: '#fff' } } },
    ];
    let id = '__composite__', css = 'dark', mix = { baseSkinId: 'dark', overrides: { card: 'light' } };
    let ui = { ...DEFAULT_UI_THEME_SETTINGS };
    const engine = {
      listSkins: () => skins,
      currentId_: () => id,
      getCssSkin: () => css,
      getComposite: () => mix,
      getUiSettings: () => ui,
      setUiSettings: settings => { ui = { ...settings }; },
      hasCssSkin: () => true,
      setSkin: key => { id = key; mix = null; },
      setCssSkin: key => { css = key; },
      setComposite: selection => { id = '__composite__'; mix = selection; },
    };
    const before = snapshotAppearance(engine);
    applyWholeTheme(engine, skins[1]);
    ui = { ...ui, surface: '#badcfe', toolbarSide: 'right' };
    const after = snapshotAppearance(engine);
    assert(!isSameAppearance(before, after));
    restoreAppearance(engine, before);
    assert(isSameAppearance(snapshotAppearance(engine), before));
  });

  check('favorites and user-created mix recipes are filtered and round-trip', () => {
    const ids = new Set(['family.one']);
    saveFavorites(['family.one', 'gone']);
    assert.deepEqual(readFavorites(ids), ['family.one']);
    // 存量值不是数组（手改过配置文件 / 旧格式）→ 回落空集，而不是抛错。
    require('../plugin-runtime/preferences-store.ts').setPreference('appearance.themeStudio.favorites', 'bad JSON');
    assert.deepEqual(readFavorites(ids), []);
    const valid = { id: 'mix-a', name: 'My ocean', selection: { baseSkinId: 'dark', overrides: { canvas: 'light' } } };
    saveThemeMixes([valid, { id: 'mix-b', name: 'Invalid', selection: { baseSkinId: 'missing', overrides: {} } }]);
    assert.deepEqual(readThemeMixes(new Set(['dark', 'light'])), [valid]);
  });

  check('floating host opts in without blocking canvas; studio applies only on request', () => {
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const host = read('plugin-runtime/panel-host.tsx');
    const studio = read('builtin-plugins/ui-skin-picker/ThemeStudio.tsx');
    assert(read('builtin-plugins/ui-skin-picker/index.tsx').includes("presentation: 'floating'"));
    assert(read('builtin-plugins/ui-skin-picker/index.tsx').includes("quickEntry: 'appearance'"));
    assert(host.includes("activePanel?.value.presentation === 'floating'"));
    assert(host.includes('pointer-events-none fixed inset-0'));
    assert(host.includes('setPointerCapture'));
    assert(host.includes('aria-modal={!floating}'));
    assert(studio.includes('engine.startLivePreview()'));
    assert(studio.includes('session().previewSkin(target.id)'));
    assert(studio.includes('session().previewUiSettings({ mode })'));
    assert(studio.includes('UiThemeControls'));
    assert(read('builtin-plugins/ui-skin-picker/index.tsx').includes("floatingWidth: 'lg'"));
    assert(studio.includes('data-bp-theme-gallery-layout'));
    assert(studio.includes('data-bp-theme-library'));
    assert(!studio.includes('sticky top-0 z-20'), 'selected theme must not obscure the library');
    assert(studio.includes('[settingsOpen, setSettingsOpen] = useState(false)'), 'advanced theme details start collapsed');
    assert(studio.includes('h-[min(38rem,calc(100dvh-10rem))]'), 'studio height stays bounded in floating and standalone hosts');
    assert(read('builtin-plugins/ui-skin-picker/UiThemeControls.tsx').includes('data-bp-ui-controls'));
    const wallpaper = read('builtin-plugins/ui-skin-picker/WallpaperControls.tsx');
    assert(wallpaper.includes('relative h-36 max-h-36'), 'wallpaper preview keeps its height without a selected image');
    assert(wallpaper.includes('max-h-56 grid-cols-[repeat(auto-fill,minmax(110px,1fr))]'), 'wallpaper library stays compact');
    assert(wallpaper.includes('<details') && !wallpaper.includes('<details open'), 'wallpaper advanced controls start collapsed');
    const baseMapCss = read('builtin-plugins/ui-skin-picker/ui-theme-map.css');
    assert(baseMapCss.includes('UNIFIED UI THEME:'), '工具界面主题映射应由主题插件持有');
    assert(baseMapCss.includes('data-bp-ui-surface-override'));
    assert(!read('index.css').includes('UNIFIED UI THEME:'), '本体样式表不再承载主题映射');
    assert(read('builtin-plugins/ui-skin-picker/index.tsx').includes("from './ui-theme-map.css?raw'"));
    assert(read('builtin-plugins/ui-skin-picker/index.tsx').includes('registerBaseThemeCss'));
    assert(read('plugin-runtime/skin-engine.ts').includes('registerBaseThemeCss'));
    assert(read('components/CanvasBackground.tsx').includes('--bp-canvas-dot-image'));
    assert(read('plugin-runtime/ui-theme-settings.ts').includes('--bp-canvas-dot-image'));
    assert(read('plugin-runtime/skin-engine.ts').includes("'data-bp-ui-button-override'"));
    assert(!read('hooks/useSettings.ts').includes("root.style.setProperty('--ui-bg-color'"));
    assert(!read('builtin-plugins/core-settings/index.tsx').includes('setUiTheme'));
    assert(read('components/CanvasSettings.tsx').includes('openThemeStudio')); 
    assert(studio.includes('session().previewMix('));
    assert(studio.includes('sessionRef.current?.cancel()'));
    assert(studio.includes('active.commit()'));
    assert(!studio.includes('<ThemeScene'));
    assert(read('components/TopBar.tsx').includes('data-bp-appearance-shortcut'));
    assert(read('App.tsx').includes("panel.value.quickEntry === 'appearance'"));
    assert(!host.includes('builtin.panel-skin-picker'));
  });
  check('canvas dot grid is theme-owned, adjustable and can be switched off', () => {
    const { resolveSkinTokens } = require('../plugin-runtime/contributions.ts');
    const token = resolveSkinTokens({ mode: 'dark' });
    const defaults = normalizeUiThemeSettings(null);
    // 默认值必须与迁移前写死的点阵等价（零视觉回退）。
    assert.equal(resolveUiChrome(token, defaults).vars['--bp-canvas-dot-image'],
      'radial-gradient(circle at 5% 5%, rgba(156, 163, 175, 0.5) 0 5%, transparent 5.6%)');
    const off = normalizeUiThemeSettings({ canvasDots: false, dotColor: '#ff0000', dotSize: 8, dotOpacity: 0.8 });
    assert.equal(resolveUiChrome(token, off).vars['--bp-canvas-dot-image'], 'none');
    const on = normalizeUiThemeSettings({ canvasDots: true, dotColor: '#ff0000', dotSize: 8, dotOpacity: 0.8 });
    assert.equal(resolveUiChrome(token, on).vars['--bp-canvas-dot-image'],
      'radial-gradient(circle at 5% 5%, rgba(255, 0, 0, 0.8) 0 8%, transparent 8.6%)');
    // 皮肤也能声明点阵；未声明的键回落默认。
    const skinned = resolveSkinTokens({ mode: 'dark', canvas: { dotColor: '#00ff00', dotSize: '10', dotOpacity: '0.35' } });
    assert.equal(resolveUiChrome(skinned, defaults).vars['--bp-canvas-dot-image'],
      'radial-gradient(circle at 5% 5%, rgba(0, 255, 0, 0.35) 0 10%, transparent 10.6%)');
    assert.equal(resolveUiChrome(resolveSkinTokens({ mode: 'dark', canvas: { dots: 'off' } }), defaults)
      .vars['--bp-canvas-dot-image'], 'none');
    // 非法输入一律回落，不写坏变量。
    assert.deepEqual(normalizeUiThemeSettings({ canvasDots: 'yes', dotColor: 'javascript:alert(1)', dotSize: 999, dotOpacity: 5 }), defaults);
  });

  check('card corners, grid color and fonts are theme-owned and adjustable', () => {
    const { resolveSkinTokens } = require('../plugin-runtime/contributions.ts');
    const token = resolveSkinTokens({ mode: 'dark' });
    const defaults = normalizeUiThemeSettings(null);
    const base = resolveUiChrome(token, defaults);
    // 默认值回落皮肤/系统栈（零视觉回退）。
    assert.equal(base.vars['--bp-radius-card'], token.radius.card);
    assert.equal(base.vars['--bp-canvas-grid'], DEFAULT_CANVAS_GRID);
    assert.equal(base.vars['--bp-canvas-grid-width'], '1px');
    assert.equal(base.vars['--bp-font-ui'], DEFAULT_FONT_UI_STACK);
    assert.equal(base.vars['--bp-font-content'], DEFAULT_FONT_CONTENT_STACK);
    // 用户旋钮覆盖。
    const edited = normalizeUiThemeSettings({ cardRadius: 20, gridColor: '#ff0000', gridWidth: 3, fontUi: 'Georgia, serif', fontContent: '"Noto Sans", sans-serif' });
    const ev = resolveUiChrome(token, edited).vars;
    assert.equal(ev['--bp-radius-card'], '20px');
    assert.equal(ev['--bp-canvas-grid'], '#ff0000');
    assert.equal(ev['--bp-canvas-grid-width'], '3px');
    assert.equal(ev['--bp-font-ui'], 'Georgia, serif');
    assert.equal(ev['--bp-font-content'], '"Noto Sans", sans-serif');
    // 皮肤可声明覆盖，用户回落皮肤值。
    const skinned = resolveSkinTokens({ mode: 'dark', radius: { card: '22px' }, canvas: { grid: '#123456' }, typography: { ui: 'Tahoma' } });
    assert.equal(resolveUiChrome(skinned, defaults).vars['--bp-radius-card'], '22px');
    assert.equal(resolveUiChrome(skinned, defaults).vars['--bp-canvas-grid'], '#123456');
    assert.equal(resolveUiChrome(skinned, defaults).vars['--bp-font-ui'], 'Tahoma');
    // 非法字体（含破坏 CSS 的字符）一律回落，不写坏变量。
    assert.deepEqual(normalizeUiThemeSettings({ fontUi: 'a;<b>', fontContent: 'x{}y', gridColor: 'rgb(1,2,3)' }), defaults);
  });

  check('theme plugin owns the app-chrome mapping as an always-on base style layer', () => {
    const previousDocument = global.document;
    const css = new Map();
    const head = {
      firstChild: null,
      insertBefore: element => { css.set(element.id, element); head.firstChild = element; },
      appendChild: element => { css.set(element.id, element); },
    };
    global.document = {
      documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
      head,
      createElement: () => ({ id: '', setAttribute() {}, textContent: '', remove() { css.delete(this.id); } }),
      getElementById: id => css.get(id) ?? null,
    };
    try {
      const values = [{ id: 'base.skin', value: { name: 'Base', mode: 'dark', tokens: {} } }];
      const ctx = { contributions: { get: (_, id) => values.find(item => item.id === id), list: () => values }, emit: () => {}, on: () => () => {} };
      const engine = new SkinEngine(ctx, { style: { setProperty() {}, removeProperty() {} } });
      const dispose = engine.registerBaseThemeCss('builtin.ui-skin-picker', '[data-bp-ui-themed] { color: var(--bp-ui-text); }');
      const style = css.get('bp-ui-theme-map');
      assert(style, '基座 <style> 应被注入');
      assert(style.textContent.includes('--bp-ui-text'));
      assert.equal(head.firstChild, style, '基座 CSS 必须是 head 里第一个样式表');
      dispose();
      assert.equal(css.get('bp-ui-theme-map'), undefined, '卸载后不留无主 style');
    } finally {
      global.document = previousDocument;
    }
  });

  check('declarative skin binding injects CSS variables on activation and clears on switch', () => {
    const previousDocument = global.document;
    const previousWindow = global.window;
    const attrs = new Map(), css = new Map(), vars = new Map();
    const root = {
      style: { setProperty: (name, value) => vars.set(name, value), removeProperty: name => vars.delete(name) },
      setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null,
    };
    global.document = {
      documentElement: root,
      head: { appendChild: () => {}, createElement: () => ({ setAttribute() {}, textContent: '', remove() {} }), getElementById: () => null },
    };
    global.window = { localStorage };
    try {
      const values = [
        { id: 'bind.dark', value: { name: 'Dark', mode: 'dark', tokens: { color: { accent: '#111111' } } } },
        { id: 'bind.skin', value: {
          name: 'Bindable', mode: 'dark', tokens: {},
          customization: {
            title: 'Tune',
            settings: [
              { key: 'accent', label: 'Accent', type: 'string', defaultValue: '#a855f7' },
              { key: 'glow', label: 'Glow', type: 'boolean', defaultValue: true },
            ],
            binding: { accent: '--bp-skin-accent', glow: '--bp-skin-glow' },
          },
        } },
      ];
      const listeners = new Map();
      const ctx = {
        contributions: { get: (_, id) => values.find(item => item.id === id), list: () => values },
        emit: (name, data) => { for (const cb of listeners.get(name) ?? []) cb(data); },
        on: (name, cb) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(cb); return () => {}; },
      };
      const engine = new SkinEngine(ctx, root);
      engine.setSkin('bind.dark');
      assert.equal(vars.get('--bp-skin-accent'), undefined, '无声明皮肤不应注入 binding 变量');
      engine.setSkin('bind.skin');
      assert.equal(vars.get('--bp-skin-accent'), '#a855f7', '默认 config 经 binding 注入 documentElement');
      assert.equal(vars.get('--bp-skin-glow'), '1', 'boolean 真 → 1');
      // live preview 草稿实时重投影，cancel 回落持久值（不落盘）。
      const draft = engine.startLivePreview();
      draft.previewSkin('bind.skin');
      draft.previewConfig('bind.skin', { accent: '#00ff00' });
      assert.equal(vars.get('--bp-skin-accent'), '#00ff00', 'previewConfig 实时重投影草稿');
      draft.cancel();
      assert.equal(vars.get('--bp-skin-accent'), '#a855f7', 'cancel 回落持久默认，binding 同步回落');
      assert.equal(engine.getSkinConfig('bind.skin').accent, '#a855f7', 'cancel 不落盘草稿');
      // 持久化配置变更实时重投影（零代码旋钮）。
      engine.setSkinConfig('bind.skin', { accent: '#ff0000', glow: false });
      assert.equal(vars.get('--bp-skin-accent'), '#ff0000', 'setSkinConfig 实时重投影');
      assert.equal(vars.get('--bp-skin-glow'), '0', 'boolean 假 → 0');
      assert.equal(JSON.parse(readSkinConfig('bind.skin')).accent, '#ff0000');
      engine.setSkin('bind.dark');
      assert.equal(vars.get('--bp-skin-accent'), undefined, '切走后清除 binding 变量，无跨皮肤泄漏');
      assert.equal(vars.get('--bp-skin-glow'), undefined);
    } finally {
      global.document = previousDocument;
      global.window = previousWindow;
    }
  });

  check('content cards expose per-type accent tokens (audio/3d) for full customization', () => {
    const { flattenSkinTokens, DEFAULT_SKIN, resolveSkinTokens } = require('../plugin-runtime/contributions.ts');
    const vars = flattenSkinTokens(DEFAULT_SKIN);
    assert.equal(vars['--bp-card-accent-audio'], '#ec4899', 'audio 卡默认强调色已登记');
    assert.equal(vars['--bp-card-accent-3d'], '#818cf8', '3D 卡默认强调色已登记');
    // 开放约定：皮肤可覆盖任意内容类型的强调色（键即类型，引擎自动写 --bp-card-accent-<kebab>）。
    const skinned = flattenSkinTokens(resolveSkinTokens({ mode: 'dark', accents: { audio: '#00ff00', '3d': '#0000ff' } }));
    assert.equal(skinned['--bp-card-accent-audio'], '#00ff00', '皮肤覆盖 audio 强调色');
    assert.equal(skinned['--bp-card-accent-3d'], '#0000ff', '皮肤覆盖 3D 强调色');
    // 卡片实际消费这些变量（零代码接入点，未定义回落全局 --bp-accent）。
    assert(fs.readFileSync(path.join(ROOT, 'components/AudioCanvasPlayer.tsx'), 'utf8').includes('--bp-card-accent-audio'));
    assert(fs.readFileSync(path.join(ROOT, 'components/cards/Model3DCanvasCard.tsx'), 'utf8').includes('--bp-card-accent-3d'));
  });

  console.log('check-theme-studio: OK');
}
