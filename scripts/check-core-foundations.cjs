const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { zipSync } = require('fflate');

const {
  BASE_PROFILE,
  PROFILE_PATCH_STORAGE_KEY,
  resolvePluginProfile,
} = require('../plugin-runtime/profile.ts');
const {
  createPluginProfileManager,
  PLUGIN_PROFILE_MANAGER_SERVICE,
  resolveStartupPluginProfile,
} = require('../plugin-runtime/plugin-profile-manager.ts');
const { createViewportIndex, createViewportIndexCache } = require('../utils/viewport-index.ts');
const { flattenLayerElements, getVirtualRowWindow } = require('../utils/layerPanelModel.ts');
const { getLassoBounds, queryInteractionCandidates } = require('../utils/interaction-spatial-query.ts');
const { createDragSnapGuideSnapshot, createSnapAxisGuideIndex } = require('../utils/drag-snap-guide-index.ts');
const { resolveContainingFrame } = require('../utils/frame-parenting.ts');
const {
  NAVIGATOR_MAX_MARKERS,
  centerCanvasPointInViewport,
  createCanvasNavigatorModel,
  createNavigatorProjection,
  fitCanvasViewport,
  getCanvasWorldViewport,
  projectNavigatorRect,
  unprojectNavigatorPoint,
  unionCanvasRects,
} = require('../utils/canvasNavigator.ts');
const {
  CANVAS_FINDER_MAX_RESULTS,
  createCanvasFinderModel,
  focusCanvasFinderResult,
} = require('../utils/canvasFinder.ts');
const {
  ELEMENT_TAG_MAX_LENGTH,
  MAX_ELEMENT_TAGS,
  addElementTag,
  normalizeElementTag,
  normalizeElementTags,
  removeElementTag,
} = require('../utils/elementTags.ts');
const {
  acceptLoadedProjectBoards,
  completeProjectSave,
  createProjectChangeState,
  observeProjectBoards,
} = require('../utils/projectChangeTracker.ts');
const {
  MAX_VIEW_BOOKMARKS,
  VIEW_BOOKMARK_NAME_MAX_LENGTH,
  appendCanvasViewBookmark,
  createCanvasViewBookmark,
  normalizeViewBookmarks,
  removeCanvasViewBookmark,
  renameCanvasViewBookmark,
} = require('../utils/viewBookmarks.ts');
const { getElementBounds, getSelectableElement, isPointInPolygon } = require('../utils/canvasUtils.ts');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const {
  formatCommandShortcut,
  invokeCommandContribution,
  isCommandEnabled,
  listCommandContributions,
  matchesCommandKeybinding,
  resolveCommandShortcut,
  searchCommandContributions,
} = require('../plugin-runtime/commands.ts');
const { WORKSPACE_COMMAND_ACTIONS_SERVICE } = require('../plugin-runtime/workspace-command-actions.ts');
const { readEditablePlugins } = require('../main/editablePlugins.cjs');
const { evaluateEditableSource } = require('../plugin-runtime/editable-loader.ts');
const workspaceCommandsPlugin = evaluateEditableSource(
  readEditablePlugins(require('node:path').join(__dirname, '../plugins')).plugins
    .find(plugin => plugin.id === 'builtin.commands-core'),
);
const { activatePluginManager } = require('../builtin-plugins/ui-plugin-manager/index.tsx');
const { listPanelContributions } = require('../plugin-runtime/panel-contributions.ts');
const { listSettingsSectionContributions } = require('../plugin-runtime/settings-contributions.tsx');
const { SKIN_ENGINE_SERVICE, SkinEngine } = require('../plugin-runtime/skin-engine.ts');
const { loadBuiltinPlugin, loadBuiltinPlugins } = require('../plugin-runtime/loader.ts');
const {
  assertManifestHostCompatibility,
  PluginCompatibilityError,
  validateManifest,
} = require('../plugin-runtime/manifest.ts');
const {
  getFormatHandlerCandidates,
  parseWithFormatHandler,
  resolveFormatHandler,
} = require('../plugin-runtime/format-handlers.ts');
const {
  BookFormatError,
  MAX_READER_CHARACTERS,
  htmlToPlainText,
  normalizeBookContent,
  parseBookFile,
} = require('../capabilities/formats-book/bookParser.ts');
// 源文件上限已外置为插件参数（ADR-057），断言从契约读取默认字节数，
// 不再从解析器 import 常量 —— 那个常量已随「阈值可配置」一起删掉了。
const {
  FORMAT_LIMITS,
  limitBytes,
  limitKeysForPlugin,
  resolveLimitBytes,
  setFormatLimitConfigProvider,
} = require('../plugin-runtime/format-limits.ts');
const MIB = 1024 * 1024;
const {
  MAX_EPUB_ARCHIVE_ENTRIES,
  MAX_EPUB_CHAPTERS,
  MAX_EPUB_TEXT_ENTRIES,
  MAX_EPUB_TEXT_ENTRY_BYTES,
  MAX_EPUB_TEXT_BYTES,
  extractEpubTextEntries,
  normalizeEpubPath,
  parseEpubArchive,
  parseEpubFile,
} = require('../capabilities/formats-book/epubParser.ts');
const { formatsBookPlugin } = require('../capabilities/formats-book/index.ts');
const {
  ComicArchiveController,
  ComicArchiveError,
  MAX_COMIC_ARCHIVE_BYTES,
  MAX_COMIC_PAGE_COUNT,
  MAX_COMIC_PAGE_BYTES,
  MAX_COMIC_ARCHIVE_ENTRIES,
  findEOCD,
  parseCentralDirectory,
  listComicPages,
  inflateComicEntry,
} = require('../main/comicArchiveController.cjs');
const {
  PluginStoreController,
  PluginStoreError,
} = require('../main/pluginStoreController.cjs');
const { ComicFormatError, parseComicFile } = require('../capabilities/formats-comic/comicParser.ts');
const { formatsComicPlugin } = require('../capabilities/formats-comic/index.ts');
const {
  getMaterializedCardComponent,
  materializeRendererContributions,
} = require('../plugin-runtime/renderer-materialization.ts');
const {
  applyCanvasOperation,
  commitCanvasOperation,
  createCanvasOperation,
  migrateLegacyBoardHistory,
} = require('../utils/operationHistory.ts');
const {
  PROJECT_DOCUMENT_FORMAT,
  deserializeProjectDocument,
  serializeProjectDocument,
} = require('../utils/projectDocument.ts');
const fs = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  ProjectRepository,
  ProjectStorageError,
  StorageIntegrityError,
} = require('../storage/projectRepository.cjs');
const {
  ProjectStorageController,
  normalizeMimeType,
} = require('../main/projectStorageController.cjs');
const { materializeManagedProjectDocument } = require('../utils/managedProjectStorage.ts');
const { createTrustedRendererUrlChecker } = require('../main/rendererTrust.cjs');
const {
  AssetDerivativeController,
  PREVIEW_RECIPE,
} = require('../main/assetDerivativeController.cjs');
const { AssetImportController, MAX_LISTED_IMPORT_JOBS } = require('../main/assetImportController.cjs');

// R20: Canvas Navigator math is renderer-local and must preserve the existing affine camera transform.
const navigatorWorldViewport = getCanvasWorldViewport({
  viewportSize: { width: 800, height: 600 },
  panOffset: { x: -200, y: 100 },
  zoom: 2,
});
assert.deepEqual(navigatorWorldViewport, { x: 100, y: -50, width: 400, height: 300 });
assert.deepEqual(centerCanvasPointInViewport({ x: 300, y: 200 }, { width: 800, height: 600 }, 2), { x: -200, y: -100 });
const navigatorUnion = unionCanvasRects([
  { x: 0, y: 0, width: 20, height: 20 },
  { x: 100, y: -20, width: 10, height: 40 },
]);
assert.deepEqual(navigatorUnion, { x: 0, y: -20, width: 110, height: 40 });
const navigatorProjection = createNavigatorProjection(navigatorUnion, { width: 240, height: 160 });
assert.ok(navigatorProjection);
const navigatorProjectedPoint = projectNavigatorRect({ x: 55, y: 0, width: 0, height: 0 }, navigatorProjection);
const navigatorRoundTrip = unprojectNavigatorPoint({ x: navigatorProjectedPoint.x, y: navigatorProjectedPoint.y }, navigatorProjection);
assert.ok(Math.abs(navigatorRoundTrip.x - 55) < 0.000001);
assert.ok(Math.abs(navigatorRoundTrip.y) < 0.000001);
assert.deepEqual(
  fitCanvasViewport({ x: 0, y: 0, width: 1000, height: 500 }, { width: 800, height: 600 }, 100),
  { zoom: 0.6, panOffset: { x: 100, y: 150 } },
);
assert.equal(fitCanvasViewport({ x: 0, y: 0, width: 1, height: 1 }, { width: 800, height: 600 }, 100).zoom, 10);
assert.equal(fitCanvasViewport({ x: Number.NaN, y: 0, width: 1, height: 1 }, { width: 800, height: 600 }), null);
const navigatorFixture = [
  { id: 'navigator-frame-a', type: 'frame', x: -100, y: -50, width: 20, height: 20 },
  { id: 'navigator-frame-b', type: 'frame', x: -50, y: -25, width: 20, height: 20 },
  // These deliberately cyclic groups prove the navigator avoids recursive group bounds traversal.
  { id: 'navigator-group-a', type: 'group', x: 50, y: 50, width: 30, height: 30, parentId: 'navigator-group-b' },
  { id: 'navigator-group-b', type: 'group', x: 90, y: 50, width: 30, height: 30, parentId: 'navigator-group-a' },
  ...Array.from({ length: 242 }, (_, index) => ({ id: `navigator-shape-${index}`, type: 'shape', x: index * 10, y: 100, width: 5, height: 5 })),
  { id: 'navigator-invalid', type: 'shape', x: Number.NaN, y: 0, width: 10, height: 10 },
];
const navigatorModel = createCanvasNavigatorModel(navigatorFixture);
assert.equal(navigatorModel.totalCount, 246);
assert.equal(navigatorModel.markers.length, NAVIGATOR_MAX_MARKERS);
assert.equal(navigatorModel.isTruncated, true);
assert.deepEqual(navigatorModel.markers.slice(0, 2).map(marker => marker.id), ['navigator-frame-a', 'navigator-frame-b']);
assert.equal(navigatorModel.contentBounds.x, -100);
assert.ok(navigatorModel.contentBounds.width >= 2515);

// R21: Board-local views accept only small, finite camera metadata and preserve no scene state.
const rawViewBookmarks = [
  { id: 'wide', name: '  Wide   view  ', panOffset: { x: 12, y: -24 }, zoom: 14 },
  null,
  { id: 'invalid-point', name: 'Broken', panOffset: { x: Number.NaN, y: 0 }, zoom: 1 },
  { id: 'wide', name: 'Duplicate', panOffset: { x: 4, y: 4 }, zoom: 1 },
  { id: 'close', name: '   ', panOffset: { x: -4, y: 8 }, zoom: 0.01 },
  { id: 'invalid-zoom', name: 'Broken zoom', panOffset: { x: 0, y: 0 }, zoom: Infinity },
];
const rawViewBookmarksJson = JSON.stringify(rawViewBookmarks, (_, value) => Number.isNaN(value) ? 'NaN' : value);
const normalizedViewBookmarks = normalizeViewBookmarks(rawViewBookmarks);
assert.deepEqual(normalizedViewBookmarks, [
  { id: 'wide', name: 'Wide view', panOffset: { x: 12, y: -24 }, zoom: 10 },
  { id: 'close', name: 'View 2', panOffset: { x: -4, y: 8 }, zoom: 0.02 },
]);
assert.equal(JSON.stringify(rawViewBookmarks, (_, value) => Number.isNaN(value) ? 'NaN' : value), rawViewBookmarksJson);
const tooManyViewBookmarks = normalizeViewBookmarks(Array.from({ length: MAX_VIEW_BOOKMARKS + 3 }, (_, index) => ({
  id: `view-${index}`,
  name: `View ${index}`,
  panOffset: { x: index, y: index },
  zoom: 1,
})));
assert.equal(tooManyViewBookmarks.length, MAX_VIEW_BOOKMARKS);
const createdFallbackView = createCanvasViewBookmark({ id: 'fallback', name: ' ', panOffset: { x: 0, y: 0 }, zoom: 1 }, 'View 3');
assert.deepEqual(createdFallbackView, { id: 'fallback', name: 'View 3', panOffset: { x: 0, y: 0 }, zoom: 1 });
const longViewName = createCanvasViewBookmark({ id: 'long', name: 'x'.repeat(VIEW_BOOKMARK_NAME_MAX_LENGTH + 5), panOffset: { x: 0, y: 0 }, zoom: 1 });
assert.equal(longViewName?.name.length, VIEW_BOOKMARK_NAME_MAX_LENGTH);
const appendedViewBookmarks = appendCanvasViewBookmark(normalizedViewBookmarks, { id: 'detail', name: 'Detail', panOffset: { x: 40, y: 50 }, zoom: 2 });
assert.equal(appendedViewBookmarks.length, 3);
assert.equal(appendCanvasViewBookmark(appendedViewBookmarks, { id: 'detail', name: 'Again', panOffset: { x: 1, y: 1 }, zoom: 1 }).length, 3);
assert.equal(renameCanvasViewBookmark(appendedViewBookmarks, 'detail', '  ').find(view => view.id === 'detail')?.name, 'View 3');
assert.deepEqual(removeCanvasViewBookmark(appendedViewBookmarks, 'wide').map(view => view.id), ['close', 'detail']);

// R22: Finder is bounded local current-board lookup; it skips unsafe cards and focuses with the existing affine transform.
const finderFixture = [
  { id: 'finder-frame', type: 'frame', name: 'Release overview', x: 0, y: 0, width: 120, height: 80 },
  { id: 'finder-text', type: 'text', text: 'Needle phrase for the launch brief', x: 200, y: 40, width: 160, height: 32 },
  { id: 'finder-image', type: 'image', name: 'Sunset reference', tags: [' #Reference ', 'mood-board', 'reference'], x: 420, y: 60, width: 100, height: 70 },
  { id: 'finder-group', type: 'group', name: 'Stored group bounds', x: 600, y: 20, width: 80, height: 60, parentId: 'finder-frame' },
  { id: 'finder-hidden', type: 'text', text: 'Needle hidden', isVisible: false, x: 10, y: 10, width: 20, height: 20 },
  { id: 'finder-invalid', type: 'frame', name: 'Invalid', x: Number.NaN, y: 0, width: 30, height: 20 },
  { id: 'finder-frame', type: 'frame', name: 'Duplicate should not win', x: 900, y: 0, width: 30, height: 20 },
];
const finderFixtureJson = JSON.stringify(finderFixture, (_, value) => Number.isNaN(value) ? 'NaN' : value);
const finderAll = createCanvasFinderModel(finderFixture);
assert.deepEqual(finderAll.results.map(result => result.id), ['finder-frame', 'finder-text', 'finder-image', 'finder-group']);
assert.equal(finderAll.totalMatches, 4);
assert.equal(finderAll.isTruncated, false);
const readerFinder = createCanvasFinderModel([...finderFixture, {
  id: 'finder-reader', type: 'reader', name: 'Reader field notes', content: 'Hidden body stays out of full-text lookup',
  sourceFormat: 'text', characterCount: 42, isTruncated: false, x: 720, y: 20, width: 420, height: 520,
}]).results.find(result => result.id === 'finder-reader');
assert.deepEqual(readerFinder, {
  id: 'finder-reader', label: 'Reader field notes', type: 'reader', typeLabel: 'Reader', tags: [],
  bounds: { x: 720, y: 20, width: 420, height: 520 },
});
assert.deepEqual(createCanvasFinderModel(finderFixture, { query: 'needle phrase' }).results.map(result => result.id), ['finder-text']);
assert.deepEqual(createCanvasFinderModel(finderFixture, { filter: 'frames' }).results.map(result => result.id), ['finder-frame']);
assert.deepEqual(createCanvasFinderModel(finderFixture, { filter: 'text' }).results.map(result => result.id), ['finder-text']);
assert.deepEqual(createCanvasFinderModel(finderFixture, { filter: 'assets' }).results.map(result => result.id), ['finder-image']);
assert.equal(JSON.stringify(finderFixture, (_, value) => Number.isNaN(value) ? 'NaN' : value), finderFixtureJson);
const manyFinderElements = Array.from({ length: CANVAS_FINDER_MAX_RESULTS + 4 }, (_, index) => ({
  id: `finder-cap-${index}`,
  type: 'frame',
  name: `Finder cap ${index}`,
  x: index,
  y: 0,
  width: 10,
  height: 10,
}));
const cappedFinder = createCanvasFinderModel(manyFinderElements);
assert.equal(cappedFinder.results.length, CANVAS_FINDER_MAX_RESULTS);
assert.equal(cappedFinder.totalMatches, CANVAS_FINDER_MAX_RESULTS + 4);
assert.equal(cappedFinder.isTruncated, true);
assert.equal(createCanvasFinderModel(manyFinderElements, { limit: 2 }).results.length, 2);
assert.deepEqual(
  focusCanvasFinderResult({ bounds: { x: 200, y: 100, width: 40, height: 20 } }, { width: 1000, height: 600 }, 2),
  { x: 60, y: 80 },
);
assert.equal(focusCanvasFinderResult({ bounds: { x: Number.NaN, y: 0, width: 1, height: 1 } }, { width: 100, height: 100 }, 1), null);
assert.equal(focusCanvasFinderResult({ bounds: { x: 0, y: 0, width: 1, height: 1 } }, { width: 0, height: 100 }, 1), null);

// R24: Element tags have one portable spelling, bounded cardinality, and no mutation while Finder scans them.
assert.equal(normalizeElementTag('  #  Product   Shot  '), 'product shot');
assert.equal(normalizeElementTag('###'), null);
assert.equal(normalizeElementTag(42), null);
assert.equal(normalizeElementTag('𐐷'.repeat(ELEMENT_TAG_MAX_LENGTH + 3)), '𐐷'.repeat(ELEMENT_TAG_MAX_LENGTH));
const rawElementTags = [' #Reference ', 'reference', '', '  mood   board  ', null, '###', 'A'.repeat(ELEMENT_TAG_MAX_LENGTH + 4)];
const rawElementTagsJson = JSON.stringify(rawElementTags);
const canonicalElementTags = normalizeElementTags(rawElementTags);
assert.deepEqual(canonicalElementTags, ['reference', 'mood board', 'a'.repeat(ELEMENT_TAG_MAX_LENGTH)]);
assert.equal(JSON.stringify(rawElementTags), rawElementTagsJson);
const cappedElementTags = normalizeElementTags(Array.from({ length: MAX_ELEMENT_TAGS + 3 }, (_, index) => `tag-${index}`));
assert.equal(cappedElementTags.length, MAX_ELEMENT_TAGS);
assert.deepEqual(addElementTag(cappedElementTags, 'extra'), cappedElementTags);
assert.deepEqual(addElementTag(['Reference'], ' #new '), ['reference', 'new']);
assert.deepEqual(removeElementTag(['Reference', 'new'], '###'), ['reference', 'new']);
assert.deepEqual(removeElementTag(['Reference', 'new'], '#REFERENCE'), ['new']);
assert.deepEqual(createCanvasFinderModel(finderFixture, { query: '#reference' }).results.map(result => result.id), ['finder-image']);
assert.deepEqual(createCanvasFinderModel(finderFixture, { query: 'mood board' }).results[0].tags, ['reference', 'mood-board']);

// R23: session-only change awareness uses immutable Board[] references and never clears a later edit with a stale save.
const initialBoardReference = [{ id: 'initial-board' }];
const changedBoardReference = [...initialBoardReference, { id: 'changed-board' }];
const laterBoardReference = [...changedBoardReference, { id: 'later-board' }];
const initialProjectChangeState = createProjectChangeState(initialBoardReference);
assert.deepEqual(initialProjectChangeState, { baseline: initialBoardReference, isDirty: false });
assert.equal(observeProjectBoards(initialProjectChangeState, initialBoardReference).isDirty, false);
const dirtyProjectChangeState = observeProjectBoards(initialProjectChangeState, changedBoardReference);
assert.equal(dirtyProjectChangeState.isDirty, true);
assert.equal(initialProjectChangeState.isDirty, false);
const cleanAfterCurrentSave = completeProjectSave(dirtyProjectChangeState, changedBoardReference, changedBoardReference);
assert.equal(cleanAfterCurrentSave.isDirty, false);
assert.equal(cleanAfterCurrentSave.baseline, changedBoardReference);
const dirtyAfterStaleSave = completeProjectSave(dirtyProjectChangeState, changedBoardReference, laterBoardReference);
assert.equal(dirtyAfterStaleSave.isDirty, true);
assert.equal(dirtyAfterStaleSave.baseline, initialBoardReference);
const loadedProjectChangeState = acceptLoadedProjectBoards(laterBoardReference);
assert.deepEqual(loadedProjectChangeState, { baseline: laterBoardReference, isDirty: false });

const manifest = (id, overrides = {}) => ({
  manifestVersion: 1,
  id,
  version: '1.0.0',
  name: id,
  author: 'Artflow',
  license: 'MIT',
  host: 'renderer',
  runtime: { mode: 'builtin', entry: 'index.ts' },
  capabilities: ['ui.panel'],
  ...overrides,
});

const profile = resolvePluginProfile([
  manifest('builtin.base', { configSchema: { enabledLabel: 'string' } }),
  manifest('builtin.child', { requires: ['builtin.base'] }),
], [
  BASE_PROFILE,
  { id: 'workspace', source: 'workspace', patches: [{ id: 'builtin.base', config: { enabledLabel: 'Canvas' } }] },
]);
assert.deepEqual(profile.enabledPluginIds, ['builtin.base', 'builtin.child']);
assert.equal(profile.plugins.find(plugin => plugin.id === 'builtin.base').config.enabledLabel, 'Canvas');
assert.equal(Object.isFrozen(profile), true);
// Isolation semantics (Blender-style): broken plugins are rejected with a recorded
// reason; the host profile always resolves and the app never goes down with a plugin.
const isolated = resolvePluginProfile([
  manifest('builtin.base'),
  manifest('builtin.child', { requires: ['builtin.base'] }),
], [{ id: 'user', source: 'user', patches: [{ id: 'builtin.base', enabled: false }] }]);
assert.deepEqual(isolated.enabledPluginIds, []);
assert.equal(isolated.plugins.find(plugin => plugin.id === 'builtin.child').enabled, false);
assert.ok(isolated.rejected.some(
  rejection => rejection.id === 'builtin.child' && rejection.reason.includes('requires disabled plugin builtin.base'),
));

const corePatched = resolvePluginProfile([manifest('builtin.base')], [
  { id: 'user', source: 'user', patches: [{ id: 'runtime.renderer', enabled: false }] },
]);
assert.ok(corePatched.rejected.some(rejection => rejection.reason.includes('Runtime Core')));
assert.deepEqual(corePatched.enabledPluginIds, ['builtin.base']);

const badConfig = resolvePluginProfile([manifest('builtin.base', { configSchema: { enabledLabel: 'string' } })], [
  { id: 'user', source: 'user', patches: [{ id: 'builtin.base', config: { unknown: true } }] },
]);
assert.ok(badConfig.rejected.some(rejection => rejection.reason.includes('undeclared config')));
assert.deepEqual(badConfig.plugins.find(plugin => plugin.id === 'builtin.base').config, {});

// R30: Settings stages validated user enable overrides; startup remains the only activation boundary.
const profileStorageValues = new Map();
const profileStorage = {
  getItem: key => profileStorageValues.has(key) ? profileStorageValues.get(key) : null,
  setItem: (key, value) => profileStorageValues.set(key, value),
  removeItem: key => profileStorageValues.delete(key),
};
const managedProfileManifests = [
  manifest('builtin.profile-base', { configSchema: { density: 'string' } }),
  manifest('builtin.profile-dependent', { requires: ['builtin.profile-base'] }),
  manifest('builtin.profile-manager', { capabilities: ['ui.settings'] }),
];
const managedActiveProfile = resolvePluginProfile(managedProfileManifests, [BASE_PROFILE]);
let profileReloads = 0;
const profileManager = createPluginProfileManager({
  manifests: managedProfileManifests,
  activeProfile: managedActiveProfile,
  storage: profileStorage,
  reload: () => { profileReloads += 1; },
  protectedPluginIds: ['builtin.profile-manager'],
});
assert.equal(profileManager.getSnapshot().restartRequired, false);
const rejectedDependencyDisable = profileManager.setPluginEnabled('builtin.profile-base', false);
assert.equal(rejectedDependencyDisable.ok, false);
assert.equal(profileStorage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
const stagedDependentDisable = profileManager.setPluginEnabled('builtin.profile-dependent', false);
assert.equal(stagedDependentDisable.ok, true);
assert.equal(stagedDependentDisable.snapshot.activeProfile.plugins.find(plugin => plugin.id === 'builtin.profile-dependent').enabled, true);
assert.equal(stagedDependentDisable.snapshot.pendingProfile.plugins.find(plugin => plugin.id === 'builtin.profile-dependent').enabled, false);
assert.equal(stagedDependentDisable.snapshot.restartRequired, true);
assert.deepEqual(JSON.parse(profileStorage.getItem(PROFILE_PATCH_STORAGE_KEY)), {
  patches: [{ id: 'builtin.profile-dependent', enabled: false }],
});
const protectedDisable = profileManager.setPluginEnabled('builtin.profile-manager', false);
assert.equal(protectedDisable.ok, false);
// i18n: 该拒绝文案经 uiText 跟随界面语言（离线环境下默认 zho），断言同时接受中英两档。
  assert.match(protectedDisable.message, /cannot be disabled|不能在此处停用/);
profileManager.reload();
assert.equal(profileReloads, 1);
const clearedOverrides = profileManager.clearEnabledOverrides();
assert.equal(clearedOverrides.ok, true);
assert.equal(clearedOverrides.snapshot.restartRequired, false);
assert.equal(profileStorage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
profileStorage.setItem(PROFILE_PATCH_STORAGE_KEY, JSON.stringify({
  patches: [
    { id: 'builtin.profile-base', enabled: false, config: { density: 'compact' } },
    { id: 'builtin.profile-dependent', enabled: false },
  ],
}));
const preservedConfig = profileManager.clearEnabledOverrides();
assert.equal(preservedConfig.ok, true);
assert.equal(preservedConfig.snapshot.pendingProfile.plugins.find(plugin => plugin.id === 'builtin.profile-base').config.density, 'compact');
assert.deepEqual(JSON.parse(profileStorage.getItem(PROFILE_PATCH_STORAGE_KEY)), {
  patches: [{ id: 'builtin.profile-base', config: { density: 'compact' } }],
});
profileStorage.setItem(PROFILE_PATCH_STORAGE_KEY, JSON.stringify({
  patches: [{ id: 'builtin.profile-manager', enabled: false }],
}));
const recoveredStartupProfile = resolveStartupPluginProfile(managedProfileManifests, profileStorage, ['builtin.profile-manager']);
assert.equal(recoveredStartupProfile.profile.plugins.find(plugin => plugin.id === 'builtin.profile-manager').enabled, true);
const failingStorageManager = createPluginProfileManager({
  manifests: managedProfileManifests,
  activeProfile: managedActiveProfile,
  storage: { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } },
  reload: () => {},
});
const failedWrite = failingStorageManager.setPluginEnabled('builtin.profile-dependent', false);
assert.equal(failedWrite.ok, false);
assert.equal(failedWrite.snapshot.restartRequired, false);

const pluginManagerKernel = createKernel();
const pluginManagerProfile = resolvePluginProfile([], [BASE_PROFILE]);
pluginManagerKernel.provide(PLUGIN_PROFILE_MANAGER_SERVICE, createPluginProfileManager({
  manifests: [],
  activeProfile: pluginManagerProfile,
  storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  reload: () => {},
}));
const loadedPluginManager = activatePluginManager(pluginManagerKernel);
// The plugin manager floats: contributed into ui_panels (non-modal, draggable), not settings_sections.
assert.deepEqual(listPanelContributions(pluginManagerKernel).map(panel => panel.id), ['builtin.panel-plugin-manager']);
assert.equal(listPanelContributions(pluginManagerKernel)[0].value.presentation, 'floating');
assert.equal(listPanelContributions(pluginManagerKernel)[0].value.floatingWidth, 'lg');
loadedPluginManager();
assert.deepEqual(listPanelContributions(pluginManagerKernel), []);

const kernel = createKernel();
const cardComponent = () => null;
kernel.contributions.register('canvas_node_types', {
  id: 'builtin.card-fixture',
  pluginId: 'builtin.cards',
  value: { nodeType: 'fixture', component: cardComponent },
});
assert.deepEqual(materializeRendererContributions(kernel).canvasNodeTypes, ['fixture']);
assert.equal(getMaterializedCardComponent('fixture'), cardComponent);

// R25: generic ui_panels entries are ordered/disposable; the skin service exposes previews without project ownership.
const panelKernel = createKernel();
const panelComponent = () => null;
const panelFixture = loadBuiltinPlugin(panelKernel, {
  manifest: manifest('builtin.panel-fixture'),
  activate: ctx => ctx.contributions.register('ui_panels', {
    id: 'fixture.panel-zeta', pluginId: 'builtin.panel-fixture', priority: 1,
    value: { title: 'Zeta', component: panelComponent },
  }),
});
const panelAlphaDispose = panelKernel.contributions.register('ui_panels', {
  id: 'fixture.panel-alpha', pluginId: 'fixture.panel-alpha', priority: 1,
  value: { title: 'Alpha', description: 'Fixture panel', component: panelComponent },
});
assert.deepEqual(listPanelContributions(panelKernel).map(panel => panel.id), ['fixture.panel-alpha', 'fixture.panel-zeta']);
panelAlphaDispose();
panelFixture.dispose();
assert.deepEqual(listPanelContributions(panelKernel), []);

const appliedSkinVars = new Map();
const skinTarget = {
  style: {
    setProperty: (name, value) => appliedSkinVars.set(name, value),
    removeProperty: name => appliedSkinVars.delete(name),
  },
};
panelKernel.contributions.register('skins', {
  id: 'fixture.skin-default', pluginId: 'fixture.skins',
  value: { name: 'Fixture default', mode: 'dark', tokens: {} },
});
panelKernel.contributions.register('skins', {
  id: 'fixture.skin-paper', pluginId: 'fixture.skins',
  value: { name: 'Fixture paper', mode: 'light', tokens: { color: { cardBg: '#faf6ee', accent: '#b45309' } } },
});
const panelSkinEngine = new SkinEngine(panelKernel, skinTarget);
const disposeSkinService = panelKernel.provide(SKIN_ENGINE_SERVICE, panelSkinEngine);
assert.strictEqual(panelKernel.use(SKIN_ENGINE_SERVICE), panelSkinEngine);
assert.deepEqual(panelSkinEngine.listSkins().map(skin => skin.id), ['fixture.skin-default', 'fixture.skin-paper']);
assert.equal(panelSkinEngine.resolveSkin('fixture.skin-paper').color.cardBg, '#faf6ee');
let skinNotifications = 0;
const unsubscribeSkin = panelSkinEngine.subscribe(() => { skinNotifications += 1; });
panelSkinEngine.setSkin('fixture.skin-paper');
assert.equal(panelSkinEngine.currentId_(), 'fixture.skin-paper');
assert.equal(appliedSkinVars.get('--bp-card-bg'), '#faf6ee');
assert.equal(skinNotifications, 1);
unsubscribeSkin();
disposeSkinService();
assert.throws(() => panelKernel.use(SKIN_ENGINE_SERVICE), /service not provided/);

const image = (id, x, y, width = 40, height = 40) => ({
  id,
  type: 'image',
  x,
  y,
  width,
  height,
  href: 'preview://fixture',
  mimeType: 'image/png',
});
const layerTreeFixture = [
  image('layer-root-a', 0, 0),
  { ...image('layer-child-a1', 0, 0), parentId: 'layer-root-a' },
  image('layer-root-b', 0, 0),
  { ...image('layer-child-b1', 0, 0), parentId: 'layer-root-b' },
  { ...image('layer-child-a2', 0, 0), parentId: 'layer-root-a' },
];
assert.deepEqual(
  flattenLayerElements(layerTreeFixture).map(row => [row.element.id, row.level]),
  [
    ['layer-root-b', 0],
    ['layer-child-b1', 1],
    ['layer-root-a', 0],
    ['layer-child-a2', 1],
    ['layer-child-a1', 1],
  ],
);
const malformedLayerRows = flattenLayerElements([
  image('layer-root-safe', 0, 0),
  image('layer-root-safe', 1, 1),
  { ...image('layer-cycle-a', 0, 0), parentId: 'layer-cycle-b' },
  { ...image('layer-cycle-b', 0, 0), parentId: 'layer-cycle-a' },
  { ...image('layer-orphan', 0, 0), parentId: 'missing-parent' },
]);
assert.deepEqual(malformedLayerRows.map(row => row.element.id), ['layer-root-safe']);
const virtualLayerWindow = getVirtualRowWindow(10000, 17000, 480, 34, 8);
assert.equal(virtualLayerWindow.totalHeight, 340000);
assert.ok(virtualLayerWindow.end - virtualLayerWindow.start <= Math.ceil(480 / 34) + 17);
assert.ok(virtualLayerWindow.start > 0 && virtualLayerWindow.end < 10000);

const elements = [
  image('near', 10, 10),
  image('edge', 140, 10), // included by the default 50px viewport padding
  image('far', 5000, 5000),
  image('large', -1000, -1000, 5000, 5000),
];
const index = createViewportIndex(elements, { cellSize: 100, maxCellsPerElement: 4 });
assert.deepEqual(index.query({ x: 0, y: 0, width: 100, height: 100 }).map(element => element.id), ['near', 'edge', 'large']);
assert.deepEqual(
  index.query({ x: 0, y: 0, width: 100, height: 100 }, { includeElementIds: new Set(['far']) }).map(element => element.id),
  ['near', 'edge', 'far', 'large'],
);
assert.equal(index.diagnostics().oversizedElementCount, 1);

const flatElements = [image('cache-near', 10, 10), image('cache-edge', 180, 20), image('cache-far', 5000, 5000)];
const cacheViewport = { x: 0, y: 0, width: 320, height: 180 };
const viewportCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
const cachedInitial = viewportCache.update(flatElements);
assert.deepEqual(
  cachedInitial.query(cacheViewport, { includeElementIds: new Set(['cache-far']) }).map(element => element.id),
  createViewportIndex(flatElements, { cellSize: 100, maxCellsPerElement: 4 }).query(cacheViewport, { includeElementIds: new Set(['cache-far']) }).map(element => element.id),
);
const movedFlatElements = [{ ...flatElements[0], x: 420 }, flatElements[1], flatElements[2]];
const cachedIncremental = viewportCache.update(movedFlatElements);
assert.deepEqual(
  cachedIncremental.query(cacheViewport, { includeElementIds: new Set(['cache-far']) }).map(element => element.id),
  createViewportIndex(movedFlatElements, { cellSize: 100, maxCellsPerElement: 4 }).query(cacheViewport, { includeElementIds: new Set(['cache-far']) }).map(element => element.id),
);
assert.equal(viewportCache.diagnostics().buildCount, 1);
assert.equal(viewportCache.diagnostics().incrementalUpdateCount, 1);
assert.equal(viewportCache.diagnostics().lastUpdate, 'incremental');
viewportCache.update([...movedFlatElements]);
assert.equal(viewportCache.diagnostics().lastUpdate, 'reused');
assert.equal(viewportCache.diagnostics().reusedUpdateCount, 1);
viewportCache.update([...movedFlatElements, image('cache-added', 660, 20)]);
assert.equal(viewportCache.diagnostics().buildCount, 2);
assert.equal(viewportCache.diagnostics().lastUpdate, 'rebuild');
const groupedElements = [
  { id: 'cache-group', type: 'group', name: 'Group', x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  { ...image('cache-group-child', 25, 25), parentId: 'cache-group' },
];
const groupedCached = viewportCache.update(groupedElements);
assert.deepEqual(
  groupedCached.query(cacheViewport).map(element => element.id),
  createViewportIndex(groupedElements, { cellSize: 100, maxCellsPerElement: 4 }).query(cacheViewport).map(element => element.id),
);
assert.equal(viewportCache.diagnostics().buildCount, 3);
assert.equal(viewportCache.diagnostics().lastUpdate, 'rebuild');

const nestedGroupElements = [
  { id: 'viewport-root-group', type: 'group', name: 'Root Group', x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  { id: 'viewport-nested-group', parentId: 'viewport-root-group', type: 'group', name: 'Nested Group', x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  { ...image('viewport-group-child', 20, 20), parentId: 'viewport-nested-group' },
];
const groupIncrementalCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
const groupInitialIndex = groupIncrementalCache.update(nestedGroupElements);
assert.deepEqual(
  groupInitialIndex.query(cacheViewport).map(element => element.id),
  createViewportIndex(nestedGroupElements, { cellSize: 100, maxCellsPerElement: 4 }).query(cacheViewport).map(element => element.id),
);
const movedNestedGroupElements = [
  nestedGroupElements[0],
  nestedGroupElements[1],
  { ...nestedGroupElements[2], x: 600, y: 600 },
];
const groupIncrementalIndex = groupIncrementalCache.update(movedNestedGroupElements);
assert.deepEqual(
  groupIncrementalIndex.query(cacheViewport).map(element => element.id),
  createViewportIndex(movedNestedGroupElements, { cellSize: 100, maxCellsPerElement: 4 }).query(cacheViewport).map(element => element.id),
);
assert.deepEqual(groupIncrementalIndex.query(cacheViewport).map(element => element.id), []);
assert.deepEqual(
  groupIncrementalIndex.query({ x: 550, y: 550, width: 160, height: 160 }).map(element => element.id),
  ['viewport-root-group', 'viewport-nested-group', 'viewport-group-child'],
);
assert.equal(groupIncrementalCache.diagnostics().buildCount, 1);
assert.equal(groupIncrementalCache.diagnostics().incrementalUpdateCount, 1);
assert.equal(groupIncrementalCache.diagnostics().dependencyPropagationCount, 2);
assert.equal(groupIncrementalCache.diagnostics().lastUpdate, 'incremental');
const reparentedNestedGroupElements = [
  movedNestedGroupElements[0],
  movedNestedGroupElements[1],
  { ...movedNestedGroupElements[2], parentId: 'viewport-root-group' },
];
groupIncrementalCache.update(reparentedNestedGroupElements);
assert.equal(groupIncrementalCache.diagnostics().buildCount, 2);
assert.equal(groupIncrementalCache.diagnostics().lastUpdate, 'rebuild');

const cyclicGroupElements = [
  { id: 'viewport-cycle-a', parentId: 'viewport-cycle-b', type: 'group', name: 'Cycle A', x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  { id: 'viewport-cycle-b', parentId: 'viewport-cycle-a', type: 'group', name: 'Cycle B', x: 20, y: 20, width: 10, height: 10, rotation: 0 },
];
const cyclicGroupCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
assert.deepEqual(cyclicGroupCache.update(cyclicGroupElements).query(cacheViewport), []);
cyclicGroupCache.update(cyclicGroupElements.map(element => ({ ...element })));
assert.equal(cyclicGroupCache.diagnostics().buildCount, 2);
assert.equal(cyclicGroupCache.diagnostics().lastUpdate, 'rebuild');

const structuralCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
const structuralFlat = [image('structural-one', 0, 0), image('structural-two', 100, 0), image('structural-three', 200, 0)];
structuralCache.update(structuralFlat);
structuralCache.update(structuralFlat.slice(1));
assert.equal(structuralCache.diagnostics().buildCount, 2); // removal
structuralCache.update(structuralFlat);
assert.equal(structuralCache.diagnostics().buildCount, 3); // addition
structuralCache.update([structuralFlat[2], structuralFlat[1], structuralFlat[0]]);
assert.equal(structuralCache.diagnostics().buildCount, 4); // reorder
structuralCache.update([structuralFlat[0], { ...structuralFlat[1], id: 'structural-one' }]);
assert.equal(structuralCache.diagnostics().buildCount, 5); // duplicate id
assert.equal(structuralCache.diagnostics().lastUpdate, 'rebuild');
const typeChangeCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
typeChangeCache.update([structuralFlat[0]]);
typeChangeCache.update([{ ...structuralFlat[0], type: 'text', content: 'type changed', fontSize: 16, color: '#000000' }]);
assert.equal(typeChangeCache.diagnostics().buildCount, 2);
assert.equal(typeChangeCache.diagnostics().lastUpdate, 'rebuild');

// R14: interaction only narrows candidates from the MainCanvas-owned R11 index.
// Exact geometry and selectable-parent resolution must remain identical to a full scan.
const interactionElements = [
  { id: 'selection-group', type: 'group', name: 'Selection group', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { ...image('selection-child', 20, 20, 30, 30), parentId: 'selection-group' },
  image('selection-direct', 55, 20, 20, 20),
  // R11 query padding deliberately returns this false positive; exact predicates exclude it.
  image('selection-padding-only', 125, 20, 20, 20),
  image('selection-far', 1000, 1000, 20, 20),
];
const interactionCache = createViewportIndexCache({ cellSize: 100, maxCellsPerElement: 4 });
const interactionSnapshot = { elements: interactionElements, index: interactionCache.update(interactionElements) };
const selectionRegion = { x: 0, y: 0, width: 100, height: 100 };
const exactBoxIds = candidates => {
  const selectedIds = [];
  candidates.forEach(element => {
    const bounds = getElementBounds(element, interactionElements);
    if (
      selectionRegion.x < bounds.x + bounds.width
      && selectionRegion.x + selectionRegion.width > bounds.x
      && selectionRegion.y < bounds.y + bounds.height
      && selectionRegion.y + selectionRegion.height > bounds.y
    ) {
      const selectable = getSelectableElement(element.id, interactionElements);
      if (selectable) selectedIds.push(selectable.id);
    }
  });
  return [...new Set(selectedIds)];
};
const indexedBoxCandidates = queryInteractionCandidates(interactionSnapshot, interactionElements, selectionRegion);
assert.ok(indexedBoxCandidates.some(element => element.id === 'selection-padding-only'));
assert.deepEqual(exactBoxIds(indexedBoxCandidates), exactBoxIds(interactionElements));
assert.deepEqual(exactBoxIds(indexedBoxCandidates), ['selection-group', 'selection-direct']);

const lassoFixture = [{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 0, y: 110 }];
const lassoRegion = getLassoBounds(lassoFixture);
assert.deepEqual(lassoRegion, { x: 0, y: 0, width: 110, height: 110 });
const exactLassoIds = candidates => [...new Set(candidates.filter(element => {
  const bounds = getElementBounds(element, interactionElements);
  return isPointInPolygon({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, lassoFixture);
}).map(element => {
  const selectable = getSelectableElement(element.id, interactionElements);
  return selectable ? selectable.id : element.id;
}))];
const indexedLassoCandidates = queryInteractionCandidates(interactionSnapshot, interactionElements, lassoRegion);
assert.ok(indexedLassoCandidates.some(element => element.id === 'selection-padding-only'));
assert.deepEqual(exactLassoIds(indexedLassoCandidates), exactLassoIds(interactionElements));
assert.deepEqual(exactLassoIds(indexedLassoCandidates), ['selection-group', 'selection-direct']);
assert.equal(getLassoBounds([{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }]), null);

// A MainCanvas snapshot built for an older immutable array must not omit current elements.
const staleInteractionElements = [...interactionElements, image('selection-current-only', 10, 10)];
assert.strictEqual(
  queryInteractionCandidates(interactionSnapshot, staleInteractionElements, selectionRegion),
  staleInteractionElements,
);
assert.strictEqual(queryInteractionCandidates(null, interactionElements, selectionRegion), interactionElements);
assert.equal(interactionCache.diagnostics().lastUpdate, 'initial'); // R33 supports valid groups without changing initial snapshot semantics

// R15: a sorted axis index must reproduce legacy static Set order, ties and strict threshold behavior.
const legacyNearestGuide = (values, target, threshold) => {
  let best = null;
  let rank = 0;
  for (const value of new Set(values)) {
    const distance = Math.abs(target - value);
    if (distance < threshold && (!best || distance < best.distance)) best = { value, distance, rank };
    rank += 1;
  }
  return best;
};
const tieAxis = createSnapAxisGuideIndex([105, 95, 105, 80]);
assert.deepEqual(tieAxis.findNearest(100, 10), { value: 105, distance: 5, rank: 0 }); // 105 was first in legacy Set order
assert.equal(tieAxis.findNearest(100, 5), null); // exact threshold is intentionally excluded
assert.equal(createSnapAxisGuideIndex([0, Number.NaN]), null);
const axisEquivalenceValues = [210, 30, 160, 90, 30, 120, 60, 180, 0];
const axisEquivalence = createSnapAxisGuideIndex(axisEquivalenceValues);
for (const threshold of [1, 5, 15, 60]) {
  for (let target = -10; target <= 230; target += 7) {
    assert.deepEqual(axisEquivalence.findNearest(target, threshold), legacyNearestGuide(axisEquivalenceValues, target, threshold));
  }
}

const snapElements = [
  image('snap-moving-one', 0, 0, 20, 20),
  image('snap-moving-two', 35, 30, 20, 20),
  image('snap-static-first', 100, 80, 20, 20),
  image('snap-static-second', 160, 120, 40, 40),
  image('snap-static-duplicate-guide', 90, 70, 20, 20),
];
const snapMovingIds = new Set(['snap-moving-one', 'snap-moving-two']);
const snapSnapshot = createDragSnapGuideSnapshot(snapElements, snapMovingIds);
assert.ok(snapSnapshot);
assert.deepEqual(snapSnapshot.diagnostics(), { staticElementCount: 3, verticalGuideCount: 7, horizontalGuideCount: 7 });
const legacyAxisGuidesFor = (sourceElements, movingIds, axis) => {
  const values = new Set();
  sourceElements.filter(element => !movingIds.has(element.id)).forEach(element => {
    const bounds = getElementBounds(element, sourceElements);
    const points = axis === 'v'
      ? [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width]
      : [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
    points.forEach(value => values.add(value));
  });
  return [...values];
};
const legacyAxisGuides = axis => legacyAxisGuidesFor(snapElements, snapMovingIds, axis);
for (const axis of ['v', 'h']) {
  const index = axis === 'v' ? snapSnapshot.vertical : snapSnapshot.horizontal;
  const guides = legacyAxisGuides(axis);
  for (const [target, threshold] of [[100, 30], [110, 10], [75, 5], [180, 60]]) {
    assert.deepEqual(index.findNearest(target, threshold), legacyNearestGuide(guides, target, threshold));
  }
}
const movingAxisPoints = axis => snapElements
  .filter(element => snapMovingIds.has(element.id))
  .map(element => {
    const bounds = getElementBounds(element, snapElements);
    return axis === 'v'
      ? [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width]
      : [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
  });
const legacyGlobalAxisBest = (pointGroups, guides, rawDelta, threshold) => {
  let best = { distance: Infinity, value: rawDelta, position: null };
  pointGroups.forEach(points => points.forEach(point => guides.forEach(value => {
    const distance = Math.abs(point + rawDelta - value);
    if (distance < threshold && distance < best.distance) best = { distance, value: value - point, position: value };
  })));
  return best;
};
const indexedGlobalAxisBest = (pointGroups, index, rawDelta, threshold) => {
  let best = { distance: Infinity, value: rawDelta, position: null };
  pointGroups.forEach(points => points.forEach(point => {
    const match = index.findNearest(point + rawDelta, threshold);
    if (match && match.distance < best.distance) best = { distance: match.distance, value: match.value - point, position: match.value };
  }));
  return best;
};
for (const [axis, rawDelta, threshold] of [['v', 82, 25], ['h', 53, 20]]) {
  const guides = legacyAxisGuides(axis);
  const index = axis === 'v' ? snapSnapshot.vertical : snapSnapshot.horizontal;
  assert.deepEqual(
    indexedGlobalAxisBest(movingAxisPoints(axis), index, rawDelta, threshold),
    legacyGlobalAxisBest(movingAxisPoints(axis), guides, rawDelta, threshold),
  );
}
assert.equal(snapSnapshot.isCurrent(snapElements), true);
const ownMovedSnapElements = snapElements.map(element => snapMovingIds.has(element.id) ? { ...element, x: element.x + 10 } : element);
snapSnapshot.advance(ownMovedSnapElements);
assert.equal(snapSnapshot.isCurrent(ownMovedSnapElements), true);
assert.equal(snapSnapshot.isCurrent([...ownMovedSnapElements]), false); // observed external ref mismatch must not reuse guides
snapSnapshot.invalidate();
assert.equal(snapSnapshot.isCurrent(ownMovedSnapElements), false);
assert.equal(createDragSnapGuideSnapshot(snapElements, new Set()), null);
assert.equal(createDragSnapGuideSnapshot(groupedElements, new Set(['cache-group-child'])), null);
assert.equal(createDragSnapGuideSnapshot([image('dup-snap', 0, 0), image('dup-snap', 40, 0)], new Set(['dup-snap'])), null);
assert.equal(createDragSnapGuideSnapshot([{ ...image('bad-snap', Number.POSITIVE_INFINITY, 0) }, image('moving-snap', 0, 0)], new Set(['moving-snap'])), null);

// R16: a static group may be frozen only when its complete group-reachable closure is static.
const staticGroupSnapElements = [
  image('group-moving', 0, 0, 20, 20),
  { id: 'group-static-root', type: 'group', name: 'Root', x: 999, y: 999, width: 1, height: 1, rotation: 0 },
  { id: 'group-static-nested', type: 'group', name: 'Nested', parentId: 'group-static-root', x: 999, y: 999, width: 1, height: 1, rotation: 0 },
  { ...image('group-static-leaf', 100, 80, 20, 20), parentId: 'group-static-nested' },
  image('group-static-peer', 160, 20, 20, 20),
];
const staticGroupMovingIds = new Set(['group-moving']);
const staticGroupSnapshot = createDragSnapGuideSnapshot(staticGroupSnapElements, staticGroupMovingIds);
assert.ok(staticGroupSnapshot);
assert.deepEqual(staticGroupSnapshot.diagnostics(), { staticElementCount: 4, verticalGuideCount: 6, horizontalGuideCount: 6 });
for (const axis of ['v', 'h']) {
  const index = axis === 'v' ? staticGroupSnapshot.vertical : staticGroupSnapshot.horizontal;
  const guides = legacyAxisGuidesFor(staticGroupSnapElements, staticGroupMovingIds, axis);
  for (const [target, threshold] of [[90, 20], [110, 10], [170, 15], [30, 12]]) {
    assert.deepEqual(index.findNearest(target, threshold), legacyNearestGuide(guides, target, threshold));
  }
}
const staticGroupMovingPoints = axis => {
  const bounds = getElementBounds(staticGroupSnapElements[0], staticGroupSnapElements);
  return [axis === 'v'
    ? [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width]
    : [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height]];
};
for (const [axis, rawDelta, threshold] of [['v', 88, 20], ['h', 65, 20]]) {
  const guides = legacyAxisGuidesFor(staticGroupSnapElements, staticGroupMovingIds, axis);
  const index = axis === 'v' ? staticGroupSnapshot.vertical : staticGroupSnapshot.horizontal;
  assert.deepEqual(
    indexedGlobalAxisBest(staticGroupMovingPoints(axis), index, rawDelta, threshold),
    legacyGlobalAxisBest(staticGroupMovingPoints(axis), guides, rawDelta, threshold),
  );
}
const ownMovedStaticGroupElements = staticGroupSnapElements.map(element => element.id === 'group-moving' ? { ...element, x: 15 } : element);
staticGroupSnapshot.advance(ownMovedStaticGroupElements);
assert.equal(staticGroupSnapshot.isCurrent(ownMovedStaticGroupElements), true);
assert.equal(staticGroupSnapshot.isCurrent([...ownMovedStaticGroupElements]), false);
assert.equal(createDragSnapGuideSnapshot([
  { id: 'dynamic-static-parent', type: 'group', name: 'Dynamic', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { ...image('dynamic-moving-child', 40, 40), parentId: 'dynamic-static-parent' },
  image('dynamic-peer', 120, 40),
], new Set(['dynamic-moving-child'])), null);
assert.equal(createDragSnapGuideSnapshot([
  { id: 'dynamic-root', type: 'group', name: 'Root', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { id: 'dynamic-nested', type: 'group', name: 'Nested', parentId: 'dynamic-root', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { ...image('dynamic-nested-moving-child', 40, 40), parentId: 'dynamic-nested' },
], new Set(['dynamic-nested-moving-child'])), null);
assert.equal(createDragSnapGuideSnapshot([
  { id: 'cycle-a', type: 'group', name: 'A', parentId: 'cycle-b', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { id: 'cycle-b', type: 'group', name: 'B', parentId: 'cycle-a', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  image('cycle-moving', 20, 20),
], new Set(['cycle-moving'])), null);

// R17: frame candidate narrowing must leave the legacy containment/comparator result unchanged.
const frame = (id, x, y, width, height) => ({ id, type: 'frame', name: id, x, y, width, height });
const frameParentElements = [
  image('frame-child', 30, 30, 20, 20),
  frame('frame-outer', 0, 0, 240, 240),
  frame('frame-inner', 20, 20, 100, 100),
  frame('frame-padding-only', 95, 20, 40, 40),
  frame('frame-tie-first', 20, 20, 100, 100),
  frame('frame-tie-second', 20, 20, 100, 100),
  { id: 'frame-group', type: 'group', name: 'Frame group', x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { ...image('frame-group-child', 40, 40, 10, 10), parentId: 'frame-group' },
];
const legacyFrameParent = (element, elementsForParent) => {
  const bounds = getElementBounds(element, elementsForParent);
  return elementsForParent
    .filter(candidate => candidate.type === 'frame')
    .filter(candidate => (
      bounds.x >= candidate.x
      && bounds.y >= candidate.y
      && bounds.x + bounds.width <= candidate.x + candidate.width
      && bounds.y + bounds.height <= candidate.y + candidate.height
    ))
    // Preserve the actual legacy comparator, including its a.height reference on the RHS.
    .sort((a, b) => (a.width * a.height) - (b.width * a.height))[0] ?? null;
};
const frameParentIndex = createViewportIndex(frameParentElements, { cellSize: 100, maxCellsPerElement: 4 });
const currentFrameSnapshot = { elements: frameParentElements, index: frameParentIndex };
for (const elementId of ['frame-child', 'frame-group']) {
  const target = frameParentElements.find(element => element.id === elementId);
  assert.equal(
    resolveContainingFrame(target, frameParentElements, currentFrameSnapshot)?.id,
    legacyFrameParent(target, frameParentElements)?.id,
  );
}
// Same-size frame ties retain source order after the existing stable comparator.
assert.equal(resolveContainingFrame(frameParentElements[0], frameParentElements, currentFrameSnapshot)?.id, 'frame-inner');
const tieElements = [image('tie-child', 30, 30, 10, 10), frame('tie-first', 20, 20, 100, 100), frame('tie-second', 20, 20, 100, 100)];
const tieSnapshot = { elements: tieElements, index: createViewportIndex(tieElements, { cellSize: 100, maxCellsPerElement: 4 }) };
assert.equal(resolveContainingFrame(tieElements[0], tieElements, tieSnapshot)?.id, 'tie-first');
const edgeElements = [image('edge-child', 0, 0, 20, 20), frame('edge-frame', 0, 0, 20, 20)];
const edgeSnapshot = { elements: edgeElements, index: createViewportIndex(edgeElements, { cellSize: 100, maxCellsPerElement: 4 }) };
assert.equal(resolveContainingFrame(edgeElements[0], edgeElements, edgeSnapshot)?.id, 'edge-frame');
const zeroElements = [image('zero-child', 10, 10, 0, 0), frame('zero-frame', 10, 10, 0, 0)];
const zeroSnapshot = { elements: zeroElements, index: createViewportIndex(zeroElements, { cellSize: 100, maxCellsPerElement: 4 }) };
assert.equal(resolveContainingFrame(zeroElements[0], zeroElements, zeroSnapshot)?.id, 'zero-frame');
const noFrameElements = [image('no-frame-child', 0, 0, 20, 20), frame('near-but-not-containing', 60, 0, 20, 20)];
const noFrameSnapshot = { elements: noFrameElements, index: createViewportIndex(noFrameElements, { cellSize: 100, maxCellsPerElement: 4 }) };
assert.ok(noFrameSnapshot.index.query(getElementBounds(noFrameElements[0], noFrameElements)).some(element => element.id === 'near-but-not-containing'));
assert.equal(resolveContainingFrame(noFrameElements[0], noFrameElements, noFrameSnapshot), null);
const staleFrameElements = [...frameParentElements];
assert.equal(
  resolveContainingFrame(staleFrameElements[0], staleFrameElements, currentFrameSnapshot)?.id,
  legacyFrameParent(staleFrameElements[0], staleFrameElements)?.id,
);
assert.equal(
  resolveContainingFrame(frameParentElements[0], frameParentElements, null)?.id,
  legacyFrameParent(frameParentElements[0], frameParentElements)?.id,
);

const before = [image('one', 0, 0), image('two', 100, 0)];
const after = [{ ...before[1], x: 120 }, image('three', 240, 0), before[0]];
const operation = createCanvasOperation(before, after);
assert.ok(operation);
assert.deepEqual(applyCanvasOperation(before, operation, 'redo'), after);
assert.deepEqual(applyCanvasOperation(after, operation, 'undo'), before);
const propertyOnly = createCanvasOperation(before, [{ ...before[0], x: 8 }, before[1]]);
assert.ok(propertyOnly);
assert.equal(propertyOnly.beforeOrder, undefined);
assert.equal(propertyOnly.afterOrder, undefined);
const deleted = [before[0]];
const deleteOperation = createCanvasOperation(before, deleted);
assert.ok(deleteOperation);
assert.deepEqual(applyCanvasOperation(before, deleteOperation, 'redo'), deleted);
assert.deepEqual(applyCanvasOperation(deleted, deleteOperation, 'undo'), before);
const tagOperationBefore = [
  { ...image('tag-operation-one', 0, 80), tags: ['alpha'] },
  { ...image('tag-operation-two', 100, 80) },
];
const tagOperationAfter = tagOperationBefore.map(element => ({
  ...element,
  tags: addElementTag(element.tags, '#review'),
}));
const tagOperation = createCanvasOperation(tagOperationBefore, tagOperationAfter);
assert.ok(tagOperation);
assert.deepEqual(applyCanvasOperation(tagOperationBefore, tagOperation, 'redo'), tagOperationAfter);
assert.deepEqual(applyCanvasOperation(tagOperationAfter, tagOperation, 'undo'), tagOperationBefore);
const reordered = [before[1], before[0]];
const reorderOperation = createCanvasOperation(before, reordered);
assert.ok(reorderOperation);
assert.deepEqual(applyCanvasOperation(before, reorderOperation, 'redo'), reordered);
assert.deepEqual(applyCanvasOperation(reordered, reorderOperation, 'undo'), before);
const firstJournal = commitCanvasOperation([], -1, before, after);
assert.equal(firstJournal.operationHistory.length, 1);
const replacedRedoBranch = commitCanvasOperation(firstJournal.operationHistory, -1, before, deleted);
assert.equal(replacedRedoBranch.operationHistory.length, 1);
assert.equal(replacedRedoBranch.operationHistoryIndex, 0);
const legacyBoard = migrateLegacyBoardHistory({
  id: 'legacy',
  name: 'Legacy',
  elements: after,
  history: [before, after],
  historyIndex: 1,
  panOffset: { x: 0, y: 0 },
  zoom: 1,
  canvasBackgroundColor: '#111827',
});
assert.equal('history' in legacyBoard, false);
assert.equal(legacyBoard.operationHistory.length, 1);
assert.equal(legacyBoard.operationHistoryIndex, 0);

const documentAssetElements = [
  { ...image('persisted-image', 12, 16), tags: [' #Hero ', 'reference', 'hero', null], originalHref: 'data:image/png;base64,original' },
  { id: 'video-node', type: 'video', x: 64, y: 16, width: 80, height: 45, href: 'blob:video-fixture', mimeType: 'video/mp4' },
  { id: 'audio-node', type: 'audio', x: 160, y: 16, width: 80, height: 32, href: 'blob:audio-fixture', mimeType: 'audio/mpeg', duration: 12 },
  { id: 'font-node', type: 'font', name: 'Fixture font', fontFamily: 'Fixture', fontUrl: 'data:font/woff2;base64,fixture', format: 'woff2', fileSize: 23, x: 12, y: 96, width: 80, height: 40 },
  { id: 'model-node', type: 'model3d', name: 'Fixture model', fileUrl: 'blob:model-fixture', fileExtension: 'glb', fileSize: 44, x: 112, y: 96, width: 80, height: 80 },
  { id: 'file-node', type: 'file', name: 'Fixture file', fileUrl: 'https://example.test/fixture.pdf', fileExtension: 'pdf', fileSize: 55, category: 'doc', mimeType: 'application/pdf', x: 212, y: 96, width: 80, height: 48 },
];
const persistedReaderElement = {
  id: 'reader-node', type: 'reader', name: 'Fixture EPUB', content: 'One\n\nTwo',
  sourceFormat: 'epub', characterCount: 8, isTruncated: false,
  x: 260, y: 180, width: 420, height: 520, rotation: 0,
};
const persistedComicElement = {
  id: 'comic-node', type: 'comic', name: 'Fixture comic',
  pages: ['data:image/png;base64,AQID', 'data:image/jpeg;base64,BAUG'], sourceFormat: 'cbz',
  x: 700, y: 180, width: 420, height: 560, rotation: 0,
};
const documentSourceBoard = {
  id: 'board-v2',
  name: 'V2',
  elements: [
    ...documentAssetElements,
    persistedReaderElement,
    persistedComicElement,
    { id: 'shape-node', type: 'shape', shapeType: 'rectangle', x: 64, y: 180, width: 24, height: 24, fillColor: '#fff', strokeColor: '#000', strokeWidth: 1 },
  ],
  operationHistory: [operation, tagOperation],
  operationHistoryIndex: 1,
  panOffset: { x: 4, y: 8 },
  zoom: 1.5,
  viewBookmarks: [{ id: 'document-view', name: 'Inspect assets', panOffset: { x: 44, y: 88 }, zoom: 1.75 }],
  canvasBackgroundColor: '#111827',
};
const projectDocument = serializeProjectDocument([documentSourceBoard]);
assert.equal(projectDocument.format, PROJECT_DOCUMENT_FORMAT);
assert.equal(projectDocument.version, 2);
assert.deepEqual(projectDocument.boards[0].viewBookmarks, documentSourceBoard.viewBookmarks);
assert.ok(projectDocument.assets.length >= documentAssetElements.length);
const persistedAssetFields = {
  image: ['href', 'originalHref', 'mimeType'],
  video: ['href', 'mimeType'],
  audio: ['href', 'mimeType'],
  font: ['fontUrl', 'format', 'fileSize'],
  model3d: ['fileUrl', 'fileExtension', 'fileSize'],
  file: ['fileUrl', 'fileExtension', 'fileSize', 'mimeType'],
};
for (const sourceElement of documentAssetElements) {
  const persistedNode = projectDocument.nodes.find(node => node.id === sourceElement.id);
  assert.ok(persistedNode?.assetId);
  for (const field of persistedAssetFields[sourceElement.type]) assert.equal(field in persistedNode.properties, false);
}
const persistedImageNode = projectDocument.nodes.find(node => node.id === 'persisted-image');
const persistedReaderNode = projectDocument.nodes.find(node => node.id === 'reader-node');
const persistedComicNode = projectDocument.nodes.find(node => node.id === 'comic-node');
assert.equal(persistedReaderNode.assetId, undefined);
assert.deepEqual(persistedReaderNode.properties, {
  name: 'Fixture EPUB', content: 'One\n\nTwo', sourceFormat: 'epub', characterCount: 8, isTruncated: false,
});
assert.equal('archive' in persistedReaderNode.properties, false);
assert.equal('sourceHref' in persistedReaderNode.properties, false);
assert.equal(persistedComicNode.assetId, undefined);
assert.deepEqual(persistedComicNode.properties, {
  name: 'Fixture comic', pages: ['data:image/png;base64,AQID', 'data:image/jpeg;base64,BAUG'], sourceFormat: 'cbz',
});
assert.deepEqual(persistedImageNode.properties.tags, ['hero', 'reference']);
const persistedOperationImage = projectDocument.boards[0].operationHistory[0].changes.find(change => change.before?.nodeType === 'image')?.before;
const persistedTagOperationAfter = projectDocument.boards[0].operationHistory[1].changes.find(change => change.id === 'tag-operation-one')?.after;
assert.deepEqual(persistedTagOperationAfter?.properties.tags, ['alpha', 'review']);
assert.ok(persistedOperationImage?.assetId);
assert.equal('href' in persistedOperationImage.properties, false);
assert.equal('mimeType' in persistedOperationImage.properties, false);
const rehydratedBoards = deserializeProjectDocument(projectDocument);
assert.equal(rehydratedBoards.length, 1);
for (const sourceElement of documentAssetElements) {
  const hydratedElement = rehydratedBoards[0].elements.find(element => element.id === sourceElement.id);
  assert.ok(hydratedElement?.assetId);
  for (const field of persistedAssetFields[sourceElement.type]) assert.equal(hydratedElement[field], sourceElement[field]);
}
assert.equal(rehydratedBoards[0].elements.find(element => element.id === 'persisted-image').assetId, persistedImageNode.assetId);
assert.deepEqual(rehydratedBoards[0].elements.find(element => element.id === 'persisted-image').tags, ['hero', 'reference']);
assert.deepEqual(rehydratedBoards[0].elements.find(element => element.id === 'reader-node'), persistedReaderElement);
assert.deepEqual(rehydratedBoards[0].elements.find(element => element.id === 'comic-node'), persistedComicElement);
assert.equal(rehydratedBoards[0].operationHistory.length, 2);
assert.equal(rehydratedBoards[0].operationHistoryIndex, 1);
assert.deepEqual(rehydratedBoards[0].operationHistory[1].changes.find(change => change.id === 'tag-operation-one')?.after?.tags, ['alpha', 'review']);
assert.deepEqual(rehydratedBoards[0].viewBookmarks, documentSourceBoard.viewBookmarks);
assert.equal(rehydratedBoards[0].operationHistory[0].changes.find(change => change.before?.id === 'two').before.href, 'preview://fixture');
const noBookmarkV2Document = {
  ...projectDocument,
  boards: projectDocument.boards.map(({ viewBookmarks, ...board }) => board),
};
assert.deepEqual(deserializeProjectDocument(noBookmarkV2Document)[0].viewBookmarks, []);
const malformedBookmarkV2Document = {
  ...projectDocument,
  boards: [{
    ...projectDocument.boards[0],
    viewBookmarks: [
      { id: 'valid-bookmark', name: '  ', panOffset: { x: 2, y: 3 }, zoom: 50 },
      { id: 'invalid-bookmark', name: 'Bad', panOffset: { x: Infinity, y: 0 }, zoom: 1 },
    ],
  }],
};
assert.deepEqual(deserializeProjectDocument(malformedBookmarkV2Document)[0].viewBookmarks, [
  { id: 'valid-bookmark', name: 'View 1', panOffset: { x: 2, y: 3 }, zoom: 10 },
]);
const malformedTagV2Document = {
  ...projectDocument,
  nodes: projectDocument.nodes.map(node => node.id === 'persisted-image' ? {
    ...node,
    properties: { ...node.properties, tags: [' #Hero ', null, 'hero', '  mood  board  ', '###'] },
  } : node),
};
assert.deepEqual(deserializeProjectDocument(malformedTagV2Document)[0].elements.find(element => element.id === 'persisted-image').tags, ['hero', 'mood board']);
const resavedWithFreshAsset = serializeProjectDocument([{
  ...rehydratedBoards[0],
  elements: [...rehydratedBoards[0].elements, { id: 'fresh-file', type: 'file', name: 'Fresh file', fileUrl: 'https://example.test/fresh.txt', fileExtension: 'txt', fileSize: 1, category: 'doc', x: 320, y: 96, width: 80, height: 48 }],
}]);
assert.equal(new Set(resavedWithFreshAsset.assets.map(asset => asset.id)).size, resavedWithFreshAsset.assets.length);
assert.ok(resavedWithFreshAsset.nodes.find(node => node.id === 'fresh-file')?.assetId);
const readerBefore = [persistedReaderElement];
const readerAfter = [{ ...persistedReaderElement, content: 'One\n\nTwo\n\nThree', characterCount: 15 }];
const readerOperation = createCanvasOperation(readerBefore, readerAfter);
assert.ok(readerOperation);
assert.deepEqual(applyCanvasOperation(readerBefore, readerOperation, 'redo'), readerAfter);
assert.deepEqual(applyCanvasOperation(readerAfter, readerOperation, 'undo'), readerBefore);
const comicBefore = [persistedComicElement];
const comicAfter = [{ ...persistedComicElement, pages: [...persistedComicElement.pages, 'data:image/webp;base64,BwgJ'] }];
const comicOperation = createCanvasOperation(comicBefore, comicAfter);
assert.ok(comicOperation);
assert.deepEqual(applyCanvasOperation(comicBefore, comicOperation, 'redo'), comicAfter);
assert.deepEqual(applyCanvasOperation(comicAfter, comicOperation, 'undo'), comicBefore);
const legacyReloadedBoards = deserializeProjectDocument([documentSourceBoard]);
assert.equal(legacyReloadedBoards[0].operationHistory.length, 2);
assert.deepEqual(legacyReloadedBoards[0].elements.find(element => element.id === 'persisted-image').tags, ['hero', 'reference']);
assert.deepEqual(legacyReloadedBoards[0].viewBookmarks, documentSourceBoard.viewBookmarks);
const legacyReloadedWithoutViews = deserializeProjectDocument([{ ...documentSourceBoard, viewBookmarks: undefined }]);
assert.deepEqual(legacyReloadedWithoutViews[0].viewBookmarks, []);
assert.equal(serializeProjectDocument(legacyReloadedBoards).version, 2);

const runCommandContributionChecks = async () => {
  // R28: commands are ordered contributions with exact shortcut semantics, not App-owned cases.
  const commandKernel = createKernel();
  const executed = [];
  commandKernel.contributions.register('commands', {
    id: 'fixture.alpha', pluginId: 'fixture.commands', priority: 1,
    value: {
      title: 'Alpha canvas command', description: 'Move the fixture canvas', keywords: ['move', 'fixture'],
      shortcut: { key: 'f', alt: true, shift: true }, run: () => { executed.push('alpha'); },
    },
  });
  commandKernel.contributions.register('commands', {
    id: 'fixture.zeta', pluginId: 'fixture.commands', priority: 1,
    value: { title: 'Zeta command', shortcut: { key: 'z', mod: true }, run: () => { executed.push('zeta'); } },
  });
  assert.deepEqual(listCommandContributions(commandKernel).map(command => command.id), ['fixture.alpha', 'fixture.zeta']);
  assert.deepEqual(searchCommandContributions(listCommandContributions(commandKernel), 'CANVAS move').map(command => command.id), ['fixture.alpha']);
  assert.equal(formatCommandShortcut({ key: 'f', alt: true, shift: true }), 'Alt+Shift+F');
  assert.equal(matchesCommandKeybinding({ key: 'f', alt: true, shift: true }, {
    key: 'F', ctrlKey: false, metaKey: false, altKey: true, shiftKey: true,
  }), true);
  assert.equal(matchesCommandKeybinding({ key: 'f', alt: true, shift: true }, {
    key: 'f', ctrlKey: true, metaKey: false, altKey: true, shiftKey: true,
  }), false);
  const alphaShortcut = resolveCommandShortcut(commandKernel, {
    key: 'f', ctrlKey: false, metaKey: false, altKey: true, shiftKey: true,
  });
  assert.equal(alphaShortcut.id, 'fixture.alpha');
  assert.equal(await invokeCommandContribution(commandKernel, alphaShortcut), true);
  assert.deepEqual(executed, ['alpha']);
  assert.throws(() => commandKernel.contributions.register('commands', {
    id: 'fixture.alpha', pluginId: 'fixture.duplicate', value: { title: 'Duplicate', run: () => {} },
  }), /duplicate contribution/);

  // A disabled higher-priority shortcut intentionally does not fall through to another plugin claimant.
  const conflictKernel = createKernel();
  const conflictRuns = [];
  conflictKernel.contributions.register('commands', {
    id: 'fixture.disabled-winner', pluginId: 'fixture.high', priority: 10,
    value: { title: 'Disabled winner', shortcut: { key: 'x', alt: true }, isEnabled: () => false, run: () => conflictRuns.push('high') },
  });
  conflictKernel.contributions.register('commands', {
    id: 'fixture.lower-claimant', pluginId: 'fixture.low', priority: 1,
    value: { title: 'Lower claimant', shortcut: { key: 'x', alt: true }, run: () => conflictRuns.push('low') },
  });
  const disabledWinner = resolveCommandShortcut(conflictKernel, {
    key: 'x', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false,
  });
  assert.equal(disabledWinner.id, 'fixture.disabled-winner');
  assert.equal(isCommandEnabled(conflictKernel, disabledWinner), false);
  assert.equal(await invokeCommandContribution(conflictKernel, disabledWinner), false);
  assert.deepEqual(conflictRuns, []);

  // The real trusted builtin has no App imports: it uses only the mediated service at execution time.
  const workspaceKernel = createKernel();
  const calls = [];
  let canFit = true;
  let canOpenExtensions = true;
  const disposeActions = workspaceKernel.provide(WORKSPACE_COMMAND_ACTIONS_SERVICE, {
    fitCanvas: () => calls.push('fit'),
    canFitCanvas: () => canFit,
    openCanvasFinder: () => calls.push('finder'),
    openSavedViews: () => calls.push('views'),
    openExtensions: () => calls.push('extensions'),
    canOpenExtensions: () => canOpenExtensions,
  });
  const loadedWorkspaceCommands = loadBuiltinPlugin(workspaceKernel, workspaceCommandsPlugin);
  // commands-core 同时注册 edit.*/presentation.*/workspace.*；此处只校验 workspace.* 子集。
  assert.deepEqual(
    listCommandContributions(workspaceKernel).map(command => command.id).filter(id => id.startsWith('workspace.')),
    [
      'workspace.fit-canvas', 'workspace.open-canvas-finder', 'workspace.open-extensions', 'workspace.open-saved-views',
    ],
  );
  for (const id of ['workspace.fit-canvas', 'workspace.open-canvas-finder', 'workspace.open-saved-views', 'workspace.open-extensions']) {
    const contribution = workspaceKernel.contributions.get('commands', id);
    assert.equal(await invokeCommandContribution(workspaceKernel, contribution), true);
  }
  assert.deepEqual(calls, ['fit', 'finder', 'views', 'extensions']);
  canFit = false;
  canOpenExtensions = false;
  assert.equal(await invokeCommandContribution(workspaceKernel, workspaceKernel.contributions.get('commands', 'workspace.fit-canvas')), false);
  assert.equal(await invokeCommandContribution(workspaceKernel, workspaceKernel.contributions.get('commands', 'workspace.open-extensions')), false);
  loadedWorkspaceCommands.dispose();
  assert.deepEqual(listCommandContributions(workspaceKernel), []);
  disposeActions();
};

const runPluginFormatHandlerChecks = async () => {
  // R27→v0.2: a binary CBZ fixture proves page filtering, natural order and bounds.
  // v0.2 懒加载：解析/解页在主进程档案仓（comicArchiveController），渲染层 parser 是薄 IPC 客户端。
  const pageOne = Uint8Array.from([1, 2, 3]);
  const pageTwo = Uint8Array.from([4, 5, 6]);
  const cbzFixture = zipSync({
    'pages/page-10.png': pageTwo,
    'pages/page-2.png': pageOne,
    '__MACOSX/._page-2.png': Uint8Array.from([99]),
    'metadata/comic-info.txt': Uint8Array.from([88]),
  });

  // —— 主进程纯函数：EOCD 定位 → central directory → 自然排序页清单 ——
  const comicTailStart = Math.max(0, cbzFixture.length - (22 + 65535 + 64));
  const comicEocd = findEOCD(cbzFixture.subarray(comicTailStart), comicTailStart);
  assert.ok(comicEocd.cdOffset > 0);
  const comicDirectoryEntries = parseCentralDirectory(
    cbzFixture.subarray(comicEocd.cdOffset, comicEocd.cdOffset + comicEocd.cdSize), 0,
  );
  assert.ok(comicDirectoryEntries.length >= 2);
  const comicPages = listComicPages(cbzFixture).pages;
  assert.deepEqual(comicPages.map(page => page.name), ['pages/page-2.png', 'pages/page-10.png']);
  assert.throws(() => listComicPages(zipSync({ 'notes.txt': Uint8Array.from([1]) })), ComicArchiveError);
  assert.throws(() => listComicPages(zipSync(Object.fromEntries(
    Array.from({ length: MAX_COMIC_PAGE_COUNT + 1 }, (_, index) => [`page-${index}.png`, Uint8Array.from([index])]),
  ))), ComicArchiveError);
  assert.throws(() => listComicPages(zipSync(Object.fromEntries(
    Array.from({ length: MAX_COMIC_ARCHIVE_ENTRIES + 1 }, (_, index) => [`metadata/${index}.txt`, Uint8Array.from([index])]),
  ))), ComicArchiveError);
  assert.throws(() => listComicPages(zipSync({
    'oversized.png': new Uint8Array(MAX_COMIC_PAGE_BYTES + 1),
  })), ComicArchiveError);
  assert.throws(() => listComicPages(Uint8Array.from([1, 2, 3, 4])), ComicArchiveError);

  // —— 档案仓端到端：内容寻址落盘 → 懒解页 → 引用校验 → 去重 ——
  // （本脚本顶层的 fs 已是 node:fs/promises，直接用 fs.mkdtemp。）
  const comicVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-comic-vault-'));
  const comicVault = new ComicArchiveController({ dir: comicVaultDir });
  const importedComic = await comicVault.importArchive({ bytes: cbzFixture, name: 'fixture.cbz' });
  assert.match(importedComic.ref, /^[0-9a-f]{64}$/);
  assert.deepEqual(importedComic.pageNames, ['pages/page-2.png', 'pages/page-10.png']);
  const comicPage0 = await comicVault.getPage({ ref: importedComic.ref, index: 0 });
  assert.equal(comicPage0.mimeType, 'image/png');
  assert.deepEqual([...comicPage0.bytes], [1, 2, 3]);
  const comicPage1 = await comicVault.getPage({ ref: importedComic.ref, index: 1 });
  assert.deepEqual([...comicPage1.bytes], [4, 5, 6]);
  await assert.rejects(() => comicVault.getPage({ ref: importedComic.ref, index: 9 }), ComicArchiveError);
  await assert.rejects(() => comicVault.getPage({ ref: '../escape', index: 0 }), ComicArchiveError);
  const reimportedComic = await comicVault.importArchive({ bytes: cbzFixture, name: 'again.cbz' });
  assert.equal(reimportedComic.ref, importedComic.ref);
  await comicVault.closeAll();

  // —— unrestricted 插件数据仓：内容寻址落盘 / 按 ref 读回 / 插件隔离与格式守卫 ——
  const pluginVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-plugin-store-'));
  const pluginVault = new PluginStoreController({ dir: pluginVaultDir });
  const storedPayload = Uint8Array.from([9, 8, 7, 6]);
  const stored = await pluginVault.store({ pluginId: 'local.alpha', bytes: storedPayload });
  assert.match(stored.ref, /^[0-9a-f]{64}$/);
  const storedRead = await pluginVault.read({ pluginId: 'local.alpha', ref: stored.ref });
  assert.deepEqual([...storedRead.bytes], [9, 8, 7, 6]);
  const storedAgain = await pluginVault.store({ pluginId: 'local.alpha', bytes: storedPayload });
  assert.equal(storedAgain.ref, stored.ref);
  await assert.rejects(() => pluginVault.read({ pluginId: 'local.alpha', ref: '../escape' }), PluginStoreError);
  await assert.rejects(() => pluginVault.read({ pluginId: 'local.other', ref: stored.ref }), PluginStoreError);
  await assert.rejects(() => pluginVault.store({ pluginId: 'not-local', bytes: storedPayload }), PluginStoreError);
  await assert.rejects(() => pluginVault.store({ pluginId: 'local.alpha', bytes: Uint8Array.from([]) }), PluginStoreError);

  // —— 插件漫画档案通道：plugin-store 的 .bin 经 ZIP 引擎随机访问（openArchivePath + readPage）——
  // 存入真实 CBZ fixture（2 页），模拟 plugin.js 先 storeInput 后 client 组件逐页拉取。
  const archiveStored = await pluginVault.store({ pluginId: 'local.alpha', bytes: cbzFixture });
  const pluginArchivePath = path.join(pluginVaultDir, 'local.alpha', `${archiveStored.ref}.bin`);
  const pluginArchiveStat = await fs.stat(pluginArchivePath);
  assert.ok(pluginArchiveStat.isFile());
  const pluginReader = new ComicArchiveController({ dir: pluginVaultDir });
  const openedPluginArchive = await pluginReader.openArchivePath('local.alpha:open-test', pluginArchivePath);
  assert.equal(openedPluginArchive.pageCount, 2);
  assert.deepEqual(openedPluginArchive.pageNames, ['pages/page-2.png', 'pages/page-10.png']);
  const pluginArchivePage0 = await pluginReader.readPage('local.alpha:open-test', 0);
  assert.equal(pluginArchivePage0.mimeType, 'image/png');
  assert.deepEqual([...pluginArchivePage0.bytes], [1, 2, 3]);
  await pluginReader.closeAll();

  const comicKernel = createKernel();
  loadBuiltinPlugin(comicKernel, { manifest: manifest('builtin.cards-reader', { capabilities: ['canvas.card'] }), activate() {} });
  const loadedComicPlugin = loadBuiltinPlugin(comicKernel, formatsComicPlugin);
  const comicFile = {
    name: 'Fixture Comic.CBZ', type: 'application/vnd.comicbook+zip', size: cbzFixture.byteLength,
    arrayBuffer: async () => cbzFixture.buffer.slice(cbzFixture.byteOffset, cbzFixture.byteOffset + cbzFixture.byteLength),
  };
  // —— 渲染层 parser：注入 mock 桥（Node 环境无 preload），断言懒加载契约 ——
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { artflowComic: {
      importArchive: async ({ bytes }) => ({
        ok: true, ref: 'a'.repeat(64), pageNames: ['pages/page-2.png', 'pages/page-10.png'],
        pageCount: 2, byteSize: bytes.byteLength, originalName: 'fixture.cbz',
      }),
      getPage: async () => ({ ok: true, bytes: new ArrayBuffer(3), mimeType: 'image/png' }),
    } };
    const comicHandler = resolveFormatHandler(comicKernel, comicFile);
    assert.equal(comicHandler.id, 'builtin.format-cbz-comic');
    assert.equal(resolveFormatHandler(comicKernel, { name: 'ordinary.zip', type: 'application/zip' }), undefined);
    assert.equal(resolveFormatHandler(comicKernel, { name: 'ordinary.zip', type: 'application/vnd.comicbook+zip' }), undefined);
    const comicResult = await parseWithFormatHandler(comicKernel, comicFile);
    assert.equal(comicResult.kind, 'comic');
    assert.equal(comicResult.title, 'Fixture Comic');
    assert.equal(comicResult.sourceFormat, 'cbz');
    assert.match(comicResult.archiveRef, /^[0-9a-f]{64}$/);
    assert.deepEqual(comicResult.pageNames, ['pages/page-2.png', 'pages/page-10.png']);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.deepEqual(materializeRendererContributions(comicKernel).canvasNodeTypes, []);
  assert.equal(getMaterializedCardComponent('comic'), undefined);
  loadedComicPlugin.dispose();
  assert.equal(resolveFormatHandler(comicKernel, comicFile), undefined);

  // R29: a binary OCF/OPF EPUB fixture proves spine order, metadata, safe text-only extraction and package bounds.
  const utf8 = value => new TextEncoder().encode(value);
  const epubContainer = `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const epubOpf = `<?xml version="1.0"?><package version="3.0"><metadata><dc:title>Fixture &amp; EPUB</dc:title></metadata><manifest><item id="first" href="Text/chapter-2.xhtml" media-type="application/xhtml+xml"/><item id="second" href="Text/chapter-10.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="images/cover.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>`;
  const epubFixture = zipSync({
    mimetype: utf8('application/epub+zip'),
    'META-INF/container.xml': utf8(epubContainer),
    'OPS/package.opf': utf8(epubOpf),
    'OPS/Text/chapter-10.xhtml': utf8('<html><body><h1>Tenth filename, second spine</h1><p>Safe second chapter.</p></body></html>'),
    'OPS/Text/chapter-2.xhtml': utf8('<html><head><style>.bad{display:none}</style><script>window.evil = true</script></head><body><h1>Second filename, first spine</h1><p>Safe <strong>first</strong> chapter.</p><img src=x onerror=alert(1)></body></html>'),
    'OPS/images/cover.jpg': Uint8Array.from([255, 216, 255]),
  });
  const makeEpub = (opf, chapters = {}) => zipSync({
    'META-INF/container.xml': utf8(epubContainer),
    'OPS/package.opf': utf8(opf),
    ...chapters,
  });
  const oneChapterOpf = '<package><manifest><item id="chapter" href="Text/chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>';
  const epubEntries = await extractEpubTextEntries(epubFixture);
  assert.deepEqual(epubEntries.map(entry => entry.path).sort(), [
    'META-INF/container.xml', 'OPS/Text/chapter-10.xhtml', 'OPS/Text/chapter-2.xhtml', 'OPS/package.opf',
  ].sort());
  const parsedEpub = await parseEpubArchive(epubFixture);
  assert.equal(parsedEpub.title, 'Fixture & EPUB');
  assert.ok(parsedEpub.content.indexOf('Second filename, first spine') < parsedEpub.content.indexOf('Tenth filename, second spine'));
  assert.match(parsedEpub.content, /Safe first chapter\./);
  assert.doesNotMatch(parsedEpub.content, /<|window\.evil|display:none|onerror|alert\(1\)/i);
  assert.equal(parsedEpub.isTruncated, false);
  assert.equal(parsedEpub.characterCount, Array.from(parsedEpub.content).length);
  const fallbackTitleEpub = makeEpub(oneChapterOpf, { 'OPS/Text/chapter.xhtml': utf8('<p>Fallback body</p>') });
  const fallbackTitleResult = await parseEpubFile({
    name: 'Fallback title.epub', type: 'application/epub+zip', size: fallbackTitleEpub.byteLength,
    arrayBuffer: async () => fallbackTitleEpub.buffer.slice(fallbackTitleEpub.byteOffset, fallbackTitleEpub.byteOffset + fallbackTitleEpub.byteLength),
  });
  assert.equal(fallbackTitleResult.title, 'Fallback title');
  const outputBoundEpub = makeEpub(oneChapterOpf, { 'OPS/Text/chapter.xhtml': utf8(`<p>${'😀'.repeat(MAX_READER_CHARACTERS + 1)}</p>`) });
  const outputBoundResult = await parseEpubArchive(outputBoundEpub);
  assert.equal(outputBoundResult.characterCount, MAX_READER_CHARACTERS);
  assert.equal(outputBoundResult.isTruncated, true);
  assert.equal(normalizeEpubPath('OPS/Text/chapter.xhtml'), 'OPS/Text/chapter.xhtml');
  assert.equal(normalizeEpubPath('../chapter.xhtml'), null);
  assert.equal(normalizeEpubPath('/OPS/chapter.xhtml'), null);
  assert.equal(normalizeEpubPath('https://example.test/chapter.xhtml'), null);
  assert.equal(normalizeEpubPath('OPS\\\\chapter.xhtml'), null);
  await assert.rejects(() => parseEpubArchive(Uint8Array.from([1, 2, 3, 4])), BookFormatError);
  await assert.rejects(() => parseEpubArchive(zipSync({ 'OPS/package.opf': utf8(oneChapterOpf) })), BookFormatError);
  await assert.rejects(() => parseEpubArchive(zipSync({
    'META-INF/container.xml': utf8('<container><rootfiles></rootfiles></container>'),
  })), BookFormatError);
  await assert.rejects(() => parseEpubArchive(makeEpub('<package><manifest></manifest></package>')), BookFormatError);
  await assert.rejects(() => parseEpubArchive(makeEpub(oneChapterOpf)), BookFormatError);
  await assert.rejects(() => parseEpubArchive(zipSync({
    'META-INF/container.xml': utf8('<container><rootfiles><rootfile full-path="../package.opf"/></rootfiles></container>'),
  })), BookFormatError);
  await assert.rejects(() => parseEpubArchive(zipSync({
    'META-INF/container.xml': utf8(epubContainer),
    'OPS/package.opf': utf8('<package><manifest><item id="unsafe" href="../Text/chapter.xhtml"/></manifest><spine><itemref idref="unsafe"/></spine></package>'),
  })), BookFormatError);
  await assert.rejects(() => extractEpubTextEntries(zipSync({
    '../unsafe.xhtml': utf8('<p>unsafe</p>'),
  })), BookFormatError);
  await assert.rejects(() => extractEpubTextEntries(zipSync(Object.fromEntries(
    Array.from({ length: MAX_EPUB_ARCHIVE_ENTRIES + 1 }, (_, index) => [`assets/${index}.bin`, Uint8Array.from([index])]),
  ))), BookFormatError);
  await assert.rejects(() => extractEpubTextEntries(zipSync(Object.fromEntries(
    Array.from({ length: MAX_EPUB_TEXT_ENTRIES + 1 }, (_, index) => [`Text/${index}.xhtml`, utf8('<p>x</p>')]),
  ))), BookFormatError);
  await assert.rejects(() => extractEpubTextEntries(zipSync({
    'Text/oversized.xhtml': new Uint8Array(MAX_EPUB_TEXT_ENTRY_BYTES + 1),
  })), BookFormatError);
  const entryAtLimit = new Uint8Array(MAX_EPUB_TEXT_ENTRY_BYTES).fill(7);
  await assert.rejects(() => extractEpubTextEntries(zipSync(Object.fromEntries(
    Array.from({ length: Math.floor(MAX_EPUB_TEXT_BYTES / MAX_EPUB_TEXT_ENTRY_BYTES) + 1 }, (_, index) => [`Text/total-${index}.xhtml`, entryAtLimit]),
  ))), BookFormatError);
  const oversizedSpineOpf = `<package><manifest>${Array.from({ length: MAX_EPUB_CHAPTERS + 1 }, (_, index) => `<item id="chapter-${index}" href="Text/${index}.xhtml"/>`).join('')}</manifest><spine>${Array.from({ length: MAX_EPUB_CHAPTERS + 1 }, (_, index) => `<itemref idref="chapter-${index}"/>`).join('')}</spine></package>`;
  await assert.rejects(() => parseEpubArchive(zipSync({
    'META-INF/container.xml': utf8(epubContainer),
    'OPS/package.opf': utf8(oversizedSpineOpf),
    ...Object.fromEntries(Array.from({ length: MAX_EPUB_CHAPTERS + 1 }, (_, index) => [`OPS/Text/${index}.xhtml`, utf8(`<p>${index}</p>`)])),
  })), BookFormatError);
  const duplicatePathFixture = zipSync({
    'OPS/A.xhtml': utf8('<p>A</p>'),
    'OPS/B.xhtml': utf8('<p>B</p>'),
  });
  const duplicateFrom = utf8('OPS/B.xhtml');
  const duplicateTo = utf8('OPS/A.xhtml');
  let duplicateReplacements = 0;
  for (let offset = 0; offset <= duplicatePathFixture.length - duplicateFrom.length; offset += 1) {
    if (duplicateFrom.every((byte, index) => duplicatePathFixture[offset + index] === byte)) {
      duplicatePathFixture.set(duplicateTo, offset);
      duplicateReplacements += 1;
    }
  }
  assert.ok(duplicateReplacements >= 2);
  await assert.rejects(() => extractEpubTextEntries(duplicatePathFixture), BookFormatError);
  await assert.rejects(
    () => parseEpubFile({
      name: 'too-large.epub', type: 'application/epub+zip', size: limitBytes(FORMAT_LIMITS.epubSourceMiB) + 1,
      arrayBuffer: async () => epubFixture.buffer.slice(epubFixture.byteOffset, epubFixture.byteOffset + epubFixture.byteLength),
    }),
    BookFormatError,
  );

  // R26: the parser has no browser DOM dependency and emits bounded plain text only.
  const normalizedHtml = normalizeBookContent(
    '<h1>Field &amp; guide</h1><p>Read <strong>this</strong>.</p><script>alert(1)</script><style>body{display:none}</style><li>safe item</li><img src=x onerror=alert(2)>',
    'html',
  );
  assert.match(normalizedHtml.content, /Field & guide/);
  assert.match(normalizedHtml.content, /safe item/);
  assert.doesNotMatch(normalizedHtml.content, /<|alert\(1\)|display:none|onerror/i);
  assert.equal(htmlToPlainText('<p>A</p><p>B</p>'), '\nA\n\nB\n');
  const boundedReader = normalizeBookContent('😀'.repeat(MAX_READER_CHARACTERS + 1), 'text');
  assert.equal(Array.from(boundedReader.content).length, MAX_READER_CHARACTERS);
  assert.equal(boundedReader.characterCount, MAX_READER_CHARACTERS);
  assert.equal(boundedReader.isTruncated, true);
  await assert.rejects(
    () => parseBookFile({ name: 'too-large.txt', type: 'text/plain', size: limitBytes(FORMAT_LIMITS.bookTextMiB) + 1, text: async () => 'unread' }),
    BookFormatError,
  );

  // Format plugin teardown removes the parser only. The reader card belongs to builtin.cards.
  const bookKernel = createKernel();
  loadBuiltinPlugin(bookKernel, { manifest: manifest('builtin.cards-reader', { capabilities: ['canvas.card'] }), activate() {} });
  const loadedBookPlugin = loadBuiltinPlugin(bookKernel, formatsBookPlugin);
  const bookFile = {
    name: 'Field Guide.HTML', type: 'text/html', size: 128,
    text: async () => '<h1>Field &amp; guide</h1><p>Safe reading.</p><script>window.bad = true</script>',
  };
  const bookHandler = resolveFormatHandler(bookKernel, bookFile);
  assert.equal(bookHandler.id, 'builtin.format-book-reader');
  const bookResult = await parseWithFormatHandler(bookKernel, bookFile);
  assert.deepEqual(bookResult, {
    kind: 'reader', title: 'Field Guide', sourceFormat: 'html',
    content: 'Field & guide\n\nSafe reading.', characterCount: 28, isTruncated: false,
  });
  const epubFile = {
    name: 'Fixture Book.EPUB', type: 'application/epub+zip', size: epubFixture.byteLength,
    arrayBuffer: async () => epubFixture.buffer.slice(epubFixture.byteOffset, epubFixture.byteOffset + epubFixture.byteLength),
  };
  const epubHandler = resolveFormatHandler(bookKernel, epubFile);
  assert.equal(epubHandler.id, 'builtin.format-book-reader');
  assert.equal(resolveFormatHandler(bookKernel, { name: 'ordinary.zip', type: 'application/epub+zip' }), undefined);
  const epubResult = await parseWithFormatHandler(bookKernel, epubFile);
  assert.equal(epubResult.kind, 'reader');
  assert.equal(epubResult.title, 'Fixture & EPUB');
  assert.equal(epubResult.sourceFormat, 'epub');
  assert.match(epubResult.content, /Safe second chapter\./);
  assert.doesNotMatch(epubResult.content, /window\.evil|<|onerror/i);
  assert.deepEqual(materializeRendererContributions(bookKernel).canvasNodeTypes, []);
  assert.equal(getMaterializedCardComponent('reader'), undefined);
  loadedBookPlugin.dispose();
  assert.equal(resolveFormatHandler(bookKernel, bookFile), undefined);

  const { CARD_PLUGINS } = require('../builtin-plugins/cards/index.tsx');
  const cardsKernel = createKernel();
  const loadedCardPlugins = CARD_PLUGINS.map(plugin => loadBuiltinPlugin(cardsKernel, plugin));
  materializeRendererContributions(cardsKernel);
  for (const nodeType of ['comic', 'reader', 'video', 'audio', 'markdown', 'code', 'bookmark', 'font', 'model3d', 'file']) {
    assert.ok(getMaterializedCardComponent(nodeType), nodeType);
  }
  loadedCardPlugins.forEach(plugin => plugin.dispose());
  materializeRendererContributions(cardsKernel);
  assert.equal(getMaterializedCardComponent('comic'), undefined);
  assert.equal(getMaterializedCardComponent('reader'), undefined);

  const formatKernel = createKernel();
  const formatFixture = loadBuiltinPlugin(formatKernel, {
    manifest: manifest('builtin.format-fixture', { capabilities: ['format.handler'] }),
    activate: ctx => ctx.contributions.register('format_handlers', {
      id: 'builtin.format-fixture',
      pluginId: 'builtin.format-fixture',
      value: {
        id: 'builtin.format-fixture', extensions: ['fixture'], outputKind: 'image', category: 'image',
        parse: async file => ({ kind: 'image', name: file.name, width: 1, height: 1, dataUrl: 'data:,fixture', mimeType: 'text/plain' }),
      },
    }),
  });
  assert.equal(resolveFormatHandler(formatKernel, { name: 'sample.fixture', type: '' }).id, 'builtin.format-fixture');
  formatFixture.dispose();
  assert.equal(resolveFormatHandler(formatKernel, { name: 'sample.fixture', type: '' }), undefined);

  const conflictKernel = createKernel();
  const fixtureHandler = id => ({
    id,
    extensions: ['fixture'],
    outputKind: 'image',
    category: 'image',
    parse: async file => ({ kind: 'image', name: file.name, width: 1, height: 1, dataUrl: 'data:,fixture', mimeType: 'text/plain' }),
  });
  conflictKernel.contributions.register('format_handlers', {
    id: 'fixture.zeta', pluginId: 'fixture.zeta', priority: 5, value: fixtureHandler('fixture.zeta'),
  });
  conflictKernel.contributions.register('format_handlers', {
    id: 'fixture.alpha', pluginId: 'fixture.alpha', priority: 5, value: fixtureHandler('fixture.alpha'),
  });
  conflictKernel.contributions.register('format_handlers', {
    id: 'fixture.high', pluginId: 'fixture.high', priority: 6, value: fixtureHandler('fixture.high'),
  });
  const candidates = getFormatHandlerCandidates(conflictKernel, { name: 'sample.fixture', type: '' });
  assert.deepEqual(candidates.map(item => item.id), ['fixture.high', 'fixture.alpha', 'fixture.zeta']);
  assert.equal(resolveFormatHandler(conflictKernel, { name: 'sample.fixture', type: '' }).id, 'fixture.high');
  assert.deepEqual(
    await parseWithFormatHandler(conflictKernel, { name: 'sample.fixture', type: '' }),
    { kind: 'image', name: 'sample.fixture', width: 1, height: 1, dataUrl: 'data:,fixture', mimeType: 'text/plain' },
  );
  assert.throws(
    () => conflictKernel.contributions.register('format_handlers', {
      id: 'fixture.bad-priority', pluginId: 'fixture.bad-priority', priority: 1.5, value: fixtureHandler('fixture.bad-priority'),
    }),
    /finite integer/,
  );

  const compatibleManifest = validateManifest(manifest('builtin.compatible', { minHostVersion: '1.0.0' }));
  assert.doesNotThrow(() => assertManifestHostCompatibility(compatibleManifest));
  const incompatible = manifest('builtin.too-new', { minHostVersion: '1.0.1' });
  assert.throws(() => loadBuiltinPlugin(createKernel(), { manifest: incompatible }), PluginCompatibilityError);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(loadBuiltinPlugins(createKernel(), [{ manifest: incompatible }]), []);
  } finally {
    console.warn = originalWarn;
  }
  assert.throws(() => validateManifest(manifest('builtin.bad-minimum', { minHostVersion: 'not-semver' })), /minHostVersion/);

  const handlerSource = await fs.readFile(path.join(__dirname, '../hooks/useFileHandlers.ts'), 'utf8');
  const detectorSource = await fs.readFile(path.join(__dirname, '../utils/formatDetector.ts'), 'utf8');
  // formats-image-doc 已迁到 editable channel：源码在 plugins，manifest 同目录。
  const formatPluginSource = await fs.readFile(path.join(__dirname, '../plugins/builtin.formats-image-doc/plugin.js'), 'utf8');
  const formatManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../plugins/builtin.formats-image-doc/manifest.json'), 'utf8'));
  const builtinIndexSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/index.ts'), 'utf8');
  assert.match(handlerSource, /resolveFormatHandler/);
  assert.doesNotMatch(handlerSource, /parsePsdFile|parsePdfFile|parseAudioFile|isSvgFile/);
  assert.doesNotMatch(detectorSource, /isPsdFile|isTiffFile|isTgaFile|isExrFile|isRawFile/);
  assert.doesNotThrow(() => assertManifestHostCompatibility(validateManifest(formatManifest)));
  assert.match(formatPluginSource, /builtin\.format-psd/);
  assert.match(formatPluginSource, /builtin\.format-pdf/);
  assert.match(formatPluginSource, /builtin\.format-audio/);
  assert.match(formatPluginSource, /builtin\.format-image/);
  // 迁移后：内置注册表不再直接登记它，改由 editable-loader 经 IPC 读取执行。
  assert.doesNotMatch(builtinIndexSource, /formatsImageDocPlugin/);

  const bookManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../capabilities/formats-book/manifest.json'), 'utf8'));
  const bookPluginSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-book/index.ts'), 'utf8');
  const bookParserSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-book/bookParser.ts'), 'utf8');
  const epubParserSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-book/epubParser.ts'), 'utf8');
  const readerCardSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-book/ReaderCanvasCard.tsx'), 'utf8');
  const canvasElementSource = await fs.readFile(path.join(__dirname, '../components/CanvasElement.tsx'), 'utf8');
  const rendererMaterializationSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/renderer-materialization.ts'), 'utf8');
  const cardContributionsSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/card-contributions.ts'), 'utf8');
  const canvasFinderSource = await fs.readFile(path.join(__dirname, '../utils/canvasFinder.ts'), 'utf8');
  const typesSource = await fs.readFile(path.join(__dirname, '../types.ts'), 'utf8');
  const registerTypeScriptSource = await fs.readFile(path.join(__dirname, '../scripts/register-typescript.cjs'), 'utf8');
  assert.deepEqual(bookManifest.capabilities, ['format.handler']);
  assert.equal(bookManifest.resourceBudget.maxMemoryMB, 32);
  assert.doesNotThrow(() => assertManifestHostCompatibility(validateManifest(bookManifest)));
  assert.match(bookPluginSource, /format_handlers/);
  assert.doesNotMatch(bookPluginSource, /canvas_node_types|ReaderCanvasCard|disposeCard/);
  assert.match(bookPluginSource, /parseEpubFile/);
  assert.match(bookParserSource, /MAX_READER_CHARACTERS = 120_000/);
  assert.doesNotMatch(bookParserSource, /DOMParser|document\.|window\.|localStorage|fetch\(/);
  assert.match(epubParserSource, /import \{ unzip \} from 'fflate'/);
  assert.match(epubParserSource, /MAX_EPUB_ARCHIVE_ENTRIES = 160/);
  assert.match(epubParserSource, /MAX_EPUB_TEXT_ENTRIES = 64/);
  assert.match(epubParserSource, /MAX_EPUB_TEXT_ENTRY_BYTES = 512 \* 1024/);
  assert.match(epubParserSource, /MAX_EPUB_TEXT_BYTES = 4 \* 1024 \* 1024/);
  assert.match(epubParserSource, /MAX_EPUB_CHAPTERS = 32/);

  // ADR-057 回归守卫：源文件上限已外置为插件参数，三条性质必须长期成立。
  // 1) 解析器不再自带写死的源文件上限（否则「可配置」名存实亡）。
  for (const [label, source] of [
    ['bookParser', bookParserSource],
    ['epubParser', epubParserSource],
    ['packedArchive', await fs.readFile(path.join(__dirname, '../capabilities/formats-packaged/packedArchive.ts'), 'utf8')],
    ['palmDoc', await fs.readFile(path.join(__dirname, '../capabilities/formats-packaged/palmDoc.ts'), 'utf8')],
    ['purParser', await fs.readFile(path.join(__dirname, '../capabilities/formats-pureref/purParser.ts'), 'utf8')],
  ]) {
    assert.doesNotMatch(
      source,
      /MAX_(BOOK|EPUB|PALM|COMIC|PUR)_(SOURCE|FILE)_BYTES/,
      `${label} 又把源文件上限写死了 —— 应走 plugins/format-limits.ts 的limitBytes()`,
    );
  }
  // 2) 每个阈值键都必须出现在对应 manifest 的 configSchema 里，否则管理面板渲染不出输入框。
  //    注意：formats-pureref 已迁到 editable channel，manifest 在 plugins；
  //    formats-book / formats-packaged 目录仍保留（作为解析器库 + 历史 manifest）。
  const manifestSchemaByPluginId = {
    [FORMAT_LIMITS.bookTextMiB.pluginId]: JSON.parse(
      await fs.readFile(path.join(__dirname, '../capabilities/formats-book/manifest.json'), 'utf8'),
    ).configSchema,
    [FORMAT_LIMITS.palmSourceMiB.pluginId]: JSON.parse(
      await fs.readFile(path.join(__dirname, '../capabilities/formats-packaged/manifest.json'), 'utf8'),
    ).configSchema,
    [FORMAT_LIMITS.purFileMiB.pluginId]: JSON.parse(
      await fs.readFile(path.join(__dirname, '../plugins/builtin.formats-pureref/manifest.json'), 'utf8'),
    ).configSchema,
  };
  for (const schema of Object.values(manifestSchemaByPluginId)) {
    assert.ok(schema, '格式插件 manifest 缺少 configSchema');
  }
  for (const [pluginId, schema] of Object.entries(manifestSchemaByPluginId)) {
    for (const spec of limitKeysForPlugin(pluginId)) {
      assert.equal(schema[spec.key], 'number', `${pluginId} 的 configSchema 缺少 ${spec.key}`);
    }
  }
  // 3) 契约自身的数值合法性：默认值必须落在 [min, max] 内（否则默认就非法）。
  for (const spec of Object.values(FORMAT_LIMITS)) {
    assert.ok(
      spec.minMiB <= spec.defaultMiB && spec.defaultMiB <= spec.maxMiB,
      `${spec.key} 默认值 ${spec.defaultMiB} 越界 [${spec.minMiB}, ${spec.maxMiB}]`,
    );
    // 非法输入必须回退默认值，绝不能变成 0 / Infinity（那等于关掉准入闸门）。
    assert.equal(resolveLimitBytes(spec, undefined), spec.defaultMiB * MIB);
    assert.equal(resolveLimitBytes(spec, NaN), spec.defaultMiB * MIB);
    assert.equal(resolveLimitBytes(spec, Infinity), spec.defaultMiB * MIB);
    assert.equal(resolveLimitBytes(spec, 'not-a-number'), spec.defaultMiB * MIB);
    // 越界值被钳制，而不是拒绝。
    assert.equal(resolveLimitBytes(spec, 99999), spec.maxMiB * MIB);
    assert.equal(resolveLimitBytes(spec, 0), spec.minMiB * MIB);
    // 正常值原样生效（这是「可配置」的意义所在）。
    assert.equal(resolveLimitBytes(spec, 32), Math.round(32 * MIB));
  }
  // 未注入 provider 时解析器仍可独立工作（单测不依赖宿主）。
  setFormatLimitConfigProvider(null);
  assert.equal(limitBytes(FORMAT_LIMITS.epubSourceMiB), FORMAT_LIMITS.epubSourceMiB.defaultMiB * MIB);
  // 注入后确实读到配置值 —— 这条证明接线不是空转。
  setFormatLimitConfigProvider(pluginId => (pluginId === FORMAT_LIMITS.palmSourceMiB.pluginId ? { maxPalmMiB: 48 } : undefined));
  assert.equal(limitBytes(FORMAT_LIMITS.palmSourceMiB), 48 * MIB);
  setFormatLimitConfigProvider(null);
  assert.equal(limitBytes(FORMAT_LIMITS.palmSourceMiB), FORMAT_LIMITS.palmSourceMiB.defaultMiB * MIB);
  assert.doesNotMatch(epubParserSource, /DOMParser|document\.|window\.|localStorage|fetch\(|URL\.createObjectURL|Worker|innerHTML/);
  assert.match(readerCardSource, /EPUB → text/);
  assert.match(readerCardSource, /whitespace-pre-wrap/);
  assert.doesNotMatch(readerCardSource, /dangerouslySetInnerHTML|element\.content\s*=|localStorage|saveProject|ipcRenderer|artflowStorage/);
  assert.match(handlerSource, /parsed\.kind === 'reader'/);
  assert.doesNotMatch(handlerSource, /formats-book|ReaderCanvasCard|parseBookFile|epub|fflate|OPF|container\.xml/i);
  assert.match(typesSource, /interface ReaderElement/);
  assert.match(typesSource, /sourceFormat: 'text' \| 'html' \| 'epub' \| 'mobi' \| 'azw' \| 'azw3'/);
  assert.match(canvasElementSource, /getMaterializedCardComponent\(element\.type\)/);
  assert.doesNotMatch(canvasElementSource, /case 'reader'|formats-book|ReaderCanvasCard/);
  assert.doesNotMatch(rendererMaterializationSource, /builtin\/cards/);
  assert.match(cardContributionsSource, /interface CanvasCardContribution/);
  assert.match(canvasFinderSource, /Partial<Record<CanvasElement\['type'\], string>>/);
  assert.match(canvasFinderSource, /typeLabelFor\(element\.type\)/);
  assert.match(registerTypeScriptSource, /require\.extensions\['\.tsx'\]/);
  // formats-reader 已迁到 editable channel：不再登记在 builtin 表，源码在 plugins。
  assert.doesNotMatch(builtinIndexSource, /formatsReaderPlugin/);
  const readerPluginSource = await fs.readFile(path.join(__dirname, '../plugins/builtin.formats-reader/plugin.js'), 'utf8');
  assert.match(readerPluginSource, /builtin\.format-book-reader/);
  assert.match(readerPluginSource, /builtin\.format-cbz-comic/);
  assert.match(readerPluginSource, /builtin\.format-palm-reader/);
  assert.match(readerPluginSource, /builtin\.format-packed-comic/);

  const comicManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../capabilities/formats-comic/manifest.json'), 'utf8'));
  const comicPluginSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-comic/index.ts'), 'utf8');
  const comicParserSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-comic/comicParser.ts'), 'utf8');
  const comicCardSource = await fs.readFile(path.join(__dirname, '../capabilities/formats-comic/ComicCanvasCard.tsx'), 'utf8');
  const packageSource = JSON.parse(await fs.readFile(path.join(__dirname, '../package.json'), 'utf8'));
  const packageLockSource = await fs.readFile(path.join(__dirname, '../package-lock.json'), 'utf8');
  assert.deepEqual(comicManifest.capabilities, ['format.handler']);
  assert.deepEqual(comicManifest.requires, ['builtin.cards-reader']);
  assert.doesNotThrow(() => assertManifestHostCompatibility(validateManifest(comicManifest)));
  assert.equal(comicManifest.resourceBudget.maxMemoryMB, 96);
  assert.equal(packageSource.dependencies.fflate, '0.8.3');
  assert.match(packageLockSource, /"node_modules\/fflate"/);
  assert.match(packageLockSource, /"version": "0\.8\.3"/);
  assert.match(comicPluginSource, /format_handlers/);
  assert.doesNotMatch(comicPluginSource, /canvas_node_types|ComicCanvasCard|disposeCard/);
  assert.doesNotMatch(comicPluginSource, /mimeTypes|application\/zip/);
  const cardsPluginSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/cards/index.tsx'), 'utf8');
  assert.match(cardsPluginSource, /canvas_node_types/);
  assert.match(cardsPluginSource, /\['comic', ComicCanvasCard\]/);
  assert.match(cardsPluginSource, /\['reader', ReaderCanvasCard\]/);
  assert.match(cardsPluginSource, /\['video', VideoCanvasCard\]/);
  assert.match(cardsPluginSource, /\['audio', AudioCanvasCard\]/);
  // v0.2 懒加载契约：渲染层是 IPC 客户端（无 fflate），解压/限额真相在主进程档案仓；
  // 卡片双页/RTL/快捷键/capture 键序必须存在。
  const comicControllerSource = await fs.readFile(path.join(__dirname, '../main/comicArchiveController.cjs'), 'utf8');
  const preloadSource = await fs.readFile(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(comicControllerSource, /MAX_COMIC_ARCHIVE_BYTES = 512 \* 1024 \* 1024/);
  assert.match(comicControllerSource, /MAX_COMIC_PAGE_COUNT = 2000/);
  assert.match(comicControllerSource, /MAX_COMIC_PAGE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(comicControllerSource, /MAX_PAGE_CACHE_BYTES = 64 \* 1024 \* 1024/);
  assert.match(comicControllerSource, /inflateRawSync/);
  assert.doesNotMatch(comicParserSource, /fflate|localStorage|ipcRenderer|document\./);
  assert.match(comicParserSource, /artflowComic/);
  assert.match(preloadSource, /exposeInMainWorld\('artflowComic'/);
  assert.match(comicCardSource, /artflowComic/);
  assert.match(comicCardSource, /URL\.createObjectURL/);
  assert.match(comicCardSource, /addEventListener\('keydown', onKeyDown, true\)/);
  assert.match(comicCardSource, /type="range"/);
  assert.doesNotMatch(comicCardSource, /dangerouslySetInnerHTML|localStorage|saveProject|ipcRenderer|artflowStorage/);
  assert.match(handlerSource, /parsed\.kind === 'comic'/);
  assert.doesNotMatch(handlerSource, /formats-comic|fflate|ComicCanvasCard|cbz/);
  assert.match(typesSource, /interface ComicElement/);
  assert.doesNotMatch(canvasElementSource, /case 'comic'|formats-comic|ComicCanvasCard|cbz/);
  // —— unrestricted 信任契约：capabilities 白名单、安装风险确认、parse 上限与数据仓三件套 ——
  const sandboxedPluginsSource = await fs.readFile(path.join(__dirname, '../main/sandboxedPlugins.cjs'), 'utf8');
  const pluginHostSource = await fs.readFile(path.join(__dirname, '../main/pluginSandboxHost.cjs'), 'utf8');
  const pluginStoreSource = await fs.readFile(path.join(__dirname, '../main/pluginStoreController.cjs'), 'utf8');
  assert.match(sandboxedPluginsSource, /CAPABILITIES_PATTERN = new Set\(\['components', 'format', 'commands', 'panels', 'assets'\]\)/);
  assert.match(sandboxedPluginsSource, /needsTrustConfirmation/);
  assert.match(sandboxedPluginsSource, /inspectPluginDirectory/);
  assert.match(sandboxedPluginsSource, /archive-open/);
  assert.match(pluginHostSource, /MAX_PARSE_BYTES = 512 \* 1024 \* 1024/);
  assert.match(pluginHostSource, /pendingParseInputs/);
  assert.match(pluginHostSource, /archiveReader/);
  assert.match(pluginStoreSource, /PLUGIN_ID_PATTERN/);
  assert.match(pluginStoreSource, /REF_PATTERN/);
  const moduleTableSource = await fs.readFile(path.join(__dirname, '../sandbox/module-table.cjs'), 'utf8');
  const clientModuleSource = await fs.readFile(path.join(__dirname, '../sandbox/client-module.ts'), 'utf8');
  assert.match(moduleTableSource, /openArchiveInput/);
  assert.match(moduleTableSource, /storeInput/);
  assert.match(clientModuleSource, /readPage/);
  assert.match(preloadSource, /readPluginPage/);
  assert.match(preloadSource, /readStored/);
  // editable 通道接线：内置注册表不再含 formatsReaderPlugin（已迁往 plugins）。
  assert.doesNotMatch(builtinIndexSource, /formatsReaderPlugin/);
};

const runPluginPanelChecks = async () => {
  const panelContributionsSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/panel-contributions.ts'), 'utf8');
  const panelHostSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/panel-host.tsx'), 'utf8');
  const settingsContributionsSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/settings-contributions.tsx'), 'utf8');
  const profileManagerSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/plugin-profile-manager.ts'), 'utf8');
  const pluginManagerSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/ui-plugin-manager/index.tsx'), 'utf8');
  const pluginManagerManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../builtin-plugins/ui-plugin-manager/manifest.json'), 'utf8'));
  const canvasSettingsSource = await fs.readFile(path.join(__dirname, '../components/CanvasSettings.tsx'), 'utf8');
  const skinEngineSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/skin-engine.ts'), 'utf8');
  const skinPickerSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/ui-skin-picker/index.tsx'), 'utf8');
  const themeStudioSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/ui-skin-picker/ThemeStudio.tsx'), 'utf8');
  const skinPickerManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../builtin-plugins/ui-skin-picker/manifest.json'), 'utf8'));
  const builtinIndexSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/index.ts'), 'utf8');
  const startupSource = await fs.readFile(path.join(__dirname, '../index.tsx'), 'utf8');
  const appSource = await fs.readFile(path.join(__dirname, '../App.tsx'), 'utf8');
  const topBarSource = await fs.readFile(path.join(__dirname, '../components/TopBar.tsx'), 'utf8');

  assert.match(panelContributionsSource, /PluginPanelProps/);
  assert.match(panelContributionsSource, /listPanelContributions/);
  assert.match(panelHostSource, /listPanelContributions\(kernel\)/);
  assert.match(panelHostSource, /event\.key !== 'Escape'/);
  assert.match(panelHostSource, /pointer-events-none fixed inset-0/);
  assert.match(panelHostSource, /aria-modal=\{!floating\}/);
  assert.match(panelHostSource, /setPointerCapture/);
  assert.match(panelHostSource, /No extension panels are enabled/);
  assert.doesNotMatch(panelHostSource, /skin-picker|SkinEngine|builtin\.skin|CanvasSettings|localStorage|ipcRenderer|artflowStorage/);
  assert.match(settingsContributionsSource, /SettingsSectionContribution/);
  assert.match(settingsContributionsSource, /settings_sections/);
  assert.match(profileManagerSource, /PLUGIN_PROFILE_MANAGER_SERVICE = 'plugin\.profile-manager'/);
  assert.match(profileManagerSource, /resolvePluginProfile/);
  assert.doesNotMatch(profileManagerSource, /CanvasSettings|<div|window\.|builtin\.ui-plugin-manager/);
  assert.deepEqual(pluginManagerManifest.capabilities, ['ui.settings']);
  assert.doesNotThrow(() => assertManifestHostCompatibility(validateManifest(pluginManagerManifest)));
  assert.match(pluginManagerSource, /kernel\.use\(PLUGIN_PROFILE_MANAGER_SERVICE\)/);
  assert.doesNotMatch(pluginManagerSource, /localStorage|CanvasSettings|from '\.\.\/\.\.\/App'|resolvePluginProfile|window\./);
  assert.match(canvasSettingsSource, /listSettingsSectionContributions\(kernel\)/);
  assert.match(canvasSettingsSource, /ActiveSettingsSection/);
  assert.doesNotMatch(canvasSettingsSource, /ui-plugin-manager|PLUGIN_PROFILE_MANAGER_SERVICE|localStorage|resolvePluginProfile/);
  assert.match(skinEngineSource, /SKIN_ENGINE_SERVICE = 'ui\.skin-engine'/);
  assert.match(skinEngineSource, /resolveSkin\(id: string\)/);
  assert.match(skinPickerSource, /component: ThemeStudio/);
  assert.match(themeStudioSource, /kernel\.use\(SKIN_ENGINE_SERVICE\)/);
  assert.doesNotMatch(themeStudioSource, /saveProject|commitAction|updateActiveBoard|ipcRenderer|artflowStorage/);
  assert.doesNotMatch(skinPickerSource, /localStorage|saveProject|commitAction|updateActiveBoard|ipcRenderer|artflowStorage/);
  assert.deepEqual(skinPickerManifest.capabilities, ['ui.panel', 'ui.skin']);
  // 默认皮肤包已转为外部声明式插件（不再内置），故 ui-skin-picker 不再以 builtin requires 依赖它；
  // 默认皮肤由运行时播种到 userData/plugins 保证存在，主题工作台只经 SKIN_ENGINE_SERVICE 取引擎。
  assert.deepEqual(skinPickerManifest.requires ?? [], []);
  assert.doesNotThrow(() => assertManifestHostCompatibility(validateManifest(skinPickerManifest)));
  assert.match(builtinIndexSource, /uiSkinPickerPlugin/);
  assert.doesNotMatch(builtinIndexSource, /uiPluginManagerPlugin|coreSettingsPlugin|configManagerPlugin|uiShellPlugin|BOOTSTRAP_PLUGIN_IDS/);
  assert.match(startupSource, /activateCoreModules\(kernel\)/);
  assert.match(startupSource, /PLUGIN_PROFILE_MANAGER_SERVICE/);
  assert.match(startupSource, /createPluginProfileManager/);
  assert.match(startupSource, /resolveStartupPluginProfile/);
  assert.match(startupSource, /kernel\.provide\(SKIN_ENGINE_SERVICE, skinEngine\)/);
  // 悬浮主题工作台宿主（PluginPanelHost）现已挂载进 App 渲染树，由 openAppearanceStudio 触发、非模态无遮罩；
  // 设置/插件入口仍 deep link 到设置的「插件与扩展」section。
  assert.match(appSource, /<PluginPanelHost/);
  assert.match(appSource, /requestedSettingsSectionId/);
  assert.match(appSource, /listPanelContributions\(pluginKernel\)/);
  // App 可合法从 ui-skin-picker 引入壁纸背景组件（WorkspaceWallpaper），但不得直接驱动皮肤引擎/主题工作台。
  assert.doesNotMatch(appSource, /SkinEngine|SKIN_ENGINE_SERVICE|builtin\.skin/);
  assert.doesNotMatch(appSource, /ui-plugin-manager|PLUGIN_PROFILE_MANAGER_SERVICE|resolvePluginProfile/);
  assert.match(topBarSource, /pluginPanelCount/);
  assert.match(topBarSource, /topBar\.extensionsLabel/);
  assert.doesNotMatch(topBarSource, /ui-skin-picker|SkinEngine|builtin\.skin/);
};

const runStorageContractChecks = async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-storage-'));
  let repository;
  let reopened;
  try {
    repository = await ProjectRepository.open(projectRoot);
    assert.equal(repository.loadProjectDocument(), null);

    const bytes = Buffer.from('content-addressed fixture bytes');
    const storedImage = await repository.putAsset({
      asset: {
        id: 'managed-image',
        kind: 'image',
        sourceKind: 'legacy-inline',
        locator: { previewRef: 'data:image/png;base64,fixture', originalRef: 'data:image/png;base64,fixture', mimeType: 'image/png' },
        metadata: { label: 'fixture' },
      },
      bytes,
      originalName: 'fixture.png',
    });
    assert.equal(storedImage.blobCreated, true);
    assert.equal(storedImage.asset.sourceKind, 'managed-store');
    assert.match(storedImage.asset.locator.previewRef, /^artflow-asset:\/\/sha256\/[a-f0-9]{64}$/);
    assert.deepEqual(await repository.readAssetBytes('managed-image'), bytes);

    const storedFile = await repository.putAsset({
      asset: {
        id: 'managed-file',
        kind: 'file',
        sourceKind: 'legacy-inline',
        locator: { fileRef: 'data:application/octet-stream;base64,fixture', mimeType: 'application/octet-stream', extension: 'bin' },
        metadata: { category: 'fixture' },
      },
      bytes,
      originalName: 'fixture.bin',
    });
    assert.equal(storedFile.blobCreated, false);
    assert.equal(storedFile.contentHash, storedImage.contentHash);
    assert.equal(repository.getAsset('managed-file').originalName, 'fixture.bin');
    assert.equal(repository.getAssetByContentHash(storedImage.contentHash).asset.locator.mimeType, 'image/png');

    const managedDocument = {
      format: 'artflow-project',
      version: 2,
      assets: [storedImage.asset, storedFile.asset],
      boards: [{
        id: 'managed-board',
        name: 'Managed',
        panOffset: { x: 0, y: 0 },
        zoom: 1,
        canvasBackgroundColor: '#111827',
        operationHistory: [],
        operationHistoryIndex: -1,
      }],
      nodes: [{
        id: 'managed-node',
        boardId: 'managed-board',
        assetId: 'managed-image',
        nodeType: 'image',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        zIndex: 0,
        properties: {},
      }],
    };
    repository.saveProjectDocument(managedDocument);
    assert.deepEqual(repository.loadProjectDocument(), managedDocument);
    assert.throws(
      () => repository.saveProjectDocument({ ...managedDocument, assets: [{ ...storedImage.asset, sourceKind: 'legacy-inline' }] }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.saveProjectDocument({ ...managedDocument, nodes: [{ ...managedDocument.nodes[0], properties: { href: 'data:image/png;base64,leak' } }] }),
      ProjectStorageError,
    );

    assert.deepEqual(repository.queryViewport({ boardId: 'managed-board', rect: { x: 40, y: 40, width: 0, height: 0 }, limit: 10 }), {
      nodes: [{ id: 'managed-node', boardId: 'managed-board', nodeType: 'image', zIndex: 0, bounds: { x: 0, y: 0, width: 40, height: 40 } }],
      truncated: false,
      snapshotRevision: 1,
      nextCursor: null,
    });

    const spatialDocument = {
      format: 'artflow-project',
      version: 2,
      assets: [storedImage.asset, storedFile.asset],
      boards: [
        { id: 'spatial-board', name: 'Spatial', panOffset: { x: 0, y: 0 }, zoom: 1, canvasBackgroundColor: '#111827', operationHistory: [], operationHistoryIndex: -1 },
        { id: 'other-board', name: 'Other', panOffset: { x: 0, y: 0 }, zoom: 1, canvasBackgroundColor: '#111827', operationHistory: [], operationHistoryIndex: -1 },
      ],
      nodes: [
        { id: 'edge', boardId: 'spatial-board', assetId: 'managed-image', nodeType: 'image', x: 0, y: 0, width: 10, height: 10, zIndex: 0, properties: {} },
        { id: 'outer-group', boardId: 'spatial-board', nodeType: 'group', x: 999, y: 999, width: 1, height: 1, zIndex: 1, properties: {} },
        { id: 'spatial-group', boardId: 'spatial-board', nodeType: 'group', x: 999, y: 999, width: 1, height: 1, zIndex: 2, parentId: 'outer-group', properties: {} },
        { id: 'group-child', boardId: 'spatial-board', assetId: 'managed-image', nodeType: 'image', x: 20, y: 10, width: 30, height: 40, zIndex: 3, parentId: 'spatial-group', properties: {} },
        { id: 'path-node', boardId: 'spatial-board', nodeType: 'path', x: 0, y: 0, zIndex: 4, properties: { points: [{ x: -5, y: -6 }, { x: 7, y: 8 }, { x: 99, y: 8 }] } },
        { id: 'arrow-node', boardId: 'spatial-board', nodeType: 'arrow', x: 0, y: 0, zIndex: 5, properties: { points: [{ x: -4, y: 30 }, { x: 6, y: 45 }] } },
        { id: 'line-node', boardId: 'spatial-board', nodeType: 'line', x: 0, y: 0, zIndex: 6, properties: { points: [{ x: 50, y: -3 }, { x: 55, y: 5 }] } },
        { id: 'empty-group', boardId: 'spatial-board', nodeType: 'group', x: 60, y: 60, width: 5, height: 7, zIndex: 7, properties: {} },
        // Intentionally reverse insertion order: keyset ordering must use zIndex then node id.
        { id: 'tie-b', boardId: 'spatial-board', assetId: 'managed-image', nodeType: 'image', x: 80, y: 0, width: 5, height: 5, zIndex: 8, properties: {} },
        { id: 'tie-a', boardId: 'spatial-board', assetId: 'managed-image', nodeType: 'image', x: 70, y: 0, width: 5, height: 5, zIndex: 8, properties: {} },
        { id: 'far-node', boardId: 'spatial-board', assetId: 'managed-image', nodeType: 'image', x: 1000, y: 1000, width: 10, height: 10, zIndex: 9, properties: {} },
        { id: 'other-node', boardId: 'other-board', assetId: 'managed-file', nodeType: 'file', x: 0, y: 0, width: 5, height: 5, zIndex: 0, properties: { name: 'Other' } },
      ],
    };
    const spatialRect = { x: -10, y: -10, width: 120, height: 120 };
    repository.saveProjectDocument(spatialDocument);
    const spatialPage = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 10 });
    assert.deepEqual(spatialPage, {
      nodes: [
        { id: 'edge', boardId: 'spatial-board', nodeType: 'image', zIndex: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } },
        { id: 'outer-group', boardId: 'spatial-board', nodeType: 'group', zIndex: 1, bounds: { x: 20, y: 10, width: 30, height: 40 } },
        { id: 'spatial-group', boardId: 'spatial-board', nodeType: 'group', parentId: 'outer-group', zIndex: 2, bounds: { x: 20, y: 10, width: 30, height: 40 } },
        { id: 'group-child', boardId: 'spatial-board', nodeType: 'image', parentId: 'spatial-group', zIndex: 3, bounds: { x: 20, y: 10, width: 30, height: 40 } },
        { id: 'path-node', boardId: 'spatial-board', nodeType: 'path', zIndex: 4, bounds: { x: -5, y: -6, width: 104, height: 14 } },
        { id: 'arrow-node', boardId: 'spatial-board', nodeType: 'arrow', zIndex: 5, bounds: { x: -4, y: 30, width: 10, height: 15 } },
        { id: 'line-node', boardId: 'spatial-board', nodeType: 'line', zIndex: 6, bounds: { x: 50, y: -3, width: 5, height: 8 } },
        { id: 'empty-group', boardId: 'spatial-board', nodeType: 'group', zIndex: 7, bounds: { x: 60, y: 60, width: 5, height: 7 } },
        { id: 'tie-a', boardId: 'spatial-board', nodeType: 'image', zIndex: 8, bounds: { x: 70, y: 0, width: 5, height: 5 } },
        { id: 'tie-b', boardId: 'spatial-board', nodeType: 'image', zIndex: 8, bounds: { x: 80, y: 0, width: 5, height: 5 } },
      ],
      truncated: false,
      snapshotRevision: 2,
      nextCursor: null,
    });
    assert.deepEqual(
      repository.queryViewport({ boardId: 'spatial-board', rect: { x: 10, y: 10, width: 0, height: 0 }, limit: 10 }).nodes.map(node => node.id),
      ['edge'],
    );
    assert.deepEqual(
      repository.queryViewport({ boardId: 'other-board', rect: { x: -1, y: -1, width: 10, height: 10 }, limit: 10 }).nodes.map(node => node.id),
      ['other-node'],
    );

    const firstCursorPage = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 3 });
    assert.deepEqual(firstCursorPage.nextCursor, {
      snapshotRevision: 2,
      boardId: 'spatial-board',
      rect: spatialRect,
      after: { zIndex: 2, id: 'spatial-group' },
    });
    const pagedIds = [...firstCursorPage.nodes.map(node => node.id)];
    let cursor = firstCursorPage.nextCursor;
    let finalCursorPage = firstCursorPage;
    while (cursor) {
      finalCursorPage = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 2, cursor });
      assert.equal(finalCursorPage.snapshotRevision, 2);
      pagedIds.push(...finalCursorPage.nodes.map(node => node.id));
      cursor = finalCursorPage.nextCursor;
    }
    assert.equal(finalCursorPage.truncated, false);
    assert.equal(finalCursorPage.nextCursor, null);
    assert.deepEqual(pagedIds, spatialPage.nodes.map(node => node.id));
    assert.equal(new Set(pagedIds).size, pagedIds.length);
    assert.deepEqual(
      repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 1 }),
      {
        nodes: [spatialPage.nodes[0]],
        truncated: true,
        snapshotRevision: 2,
        nextCursor: { snapshotRevision: 2, boardId: 'spatial-board', rect: spatialRect, after: { zIndex: 0, id: 'edge' } },
      },
    );
    assert.throws(
      () => repository.queryViewport({ boardId: 'other-board', rect: spatialRect, limit: 2, cursor: firstCursorPage.nextCursor }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.queryViewport({ boardId: 'spatial-board', rect: { ...spatialRect, width: 121 }, limit: 2, cursor: firstCursorPage.nextCursor }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 2, cursor: {} }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.queryViewport({ boardId: 'spatial-board', rect: { x: 0, y: 0, width: -1, height: 1 } }),
      ProjectStorageError,
    );

    // A successful new save invalidates a prior page sequence rather than mixing two snapshots.
    repository.saveProjectDocument(spatialDocument);
    assert.throws(
      () => repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 2, cursor: firstCursorPage.nextCursor }),
      /snapshot is stale/,
    );
    const stableSpatialPage = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 10 });
    assert.equal(stableSpatialPage.snapshotRevision, 3);
    const stableCursorPage = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 3 });
    const stableContinuation = repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 2, cursor: stableCursorPage.nextCursor });

    assert.throws(
      () => repository.saveProjectDocument({ ...spatialDocument, nodes: spatialDocument.nodes.map(node => node.id === 'edge' ? { ...node, x: Infinity } : node) }),
      ProjectStorageError,
    );
    const cycleNodes = [
      ...spatialDocument.nodes,
      { id: 'cycle-a', boardId: 'spatial-board', nodeType: 'group', x: 0, y: 0, width: 1, height: 1, zIndex: 10, parentId: 'cycle-b', properties: {} },
      { id: 'cycle-b', boardId: 'spatial-board', nodeType: 'group', x: 0, y: 0, width: 1, height: 1, zIndex: 11, parentId: 'cycle-a', properties: {} },
    ];
    assert.throws(() => repository.saveProjectDocument({ ...spatialDocument, nodes: cycleNodes }), ProjectStorageError);
    assert.throws(
      () => repository.saveProjectDocument({ ...spatialDocument, nodes: [...spatialDocument.nodes, { ...spatialDocument.nodes[0] }] }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.saveProjectDocument({ ...spatialDocument, nodes: [...spatialDocument.nodes, { ...spatialDocument.nodes[0], id: 'unknown-board-node', boardId: 'missing-board' }] }),
      ProjectStorageError,
    );
    // Rejected saves do not advance revision or split the durable snapshot from its spatial projection.
    assert.deepEqual(repository.loadProjectDocument(), spatialDocument);
    assert.deepEqual(repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 10 }), stableSpatialPage);
    assert.deepEqual(repository.queryViewport({ boardId: 'spatial-board', rect: spatialRect, limit: 2, cursor: stableCursorPage.nextCursor }), stableContinuation);

    const projectedManagedDocument = serializeProjectDocument(deserializeProjectDocument(managedDocument));
    assert.equal(projectedManagedDocument.assets.find(asset => asset.id === 'managed-image').sourceKind, 'managed-store');

    repository.saveProjectDocument(managedDocument);
    repository.close();
    repository = null;

    // A R12/v5 database already has the R-tree; v6 only seeds snapshot revision metadata.
    const v5Database = new DatabaseSync(path.join(projectRoot, '.artflow', 'metadata.sqlite'));
    v5Database.exec("DROP TABLE spatial_projection_metadata; UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';");
    v5Database.close();
    reopened = await ProjectRepository.open(projectRoot);
    assert.deepEqual(await reopened.readAssetBytes('managed-image'), bytes);
    assert.deepEqual(reopened.loadProjectDocument(), managedDocument);
    const seededV5Page = reopened.queryViewport({ boardId: 'managed-board', rect: { x: 40, y: 40, width: 0, height: 0 }, limit: 10 });
    assert.deepEqual(seededV5Page, {
      nodes: [{ id: 'managed-node', boardId: 'managed-board', nodeType: 'image', zIndex: 0, bounds: { x: 0, y: 0, width: 40, height: 40 } }],
      truncated: false,
      snapshotRevision: 1,
      nextCursor: null,
    });
    reopened.close();
    reopened = null;

    // R4/v4 still gets the R12 projection backfill before v6 seeds its revision.
    const v4Database = new DatabaseSync(path.join(projectRoot, '.artflow', 'metadata.sqlite'));
    v4Database.exec("DROP TABLE spatial_projection_metadata; DROP TABLE board_node_spatial_index; DROP TABLE board_node_spatial_metadata; UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';");
    v4Database.close();
    reopened = await ProjectRepository.open(projectRoot);
    assert.deepEqual(reopened.queryViewport({ boardId: 'managed-board', rect: { x: 40, y: 40, width: 0, height: 0 }, limit: 10 }), seededV5Page);
    const schemaDatabase = new DatabaseSync(path.join(projectRoot, '.artflow', 'metadata.sqlite'));
    assert.equal(schemaDatabase.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, '6');
    schemaDatabase.close();

    await fs.writeFile(reopened.getBlobPath(storedImage.contentHash), Buffer.from('tampered'));
    await assert.rejects(() => reopened.readAssetBytes('managed-image'), StorageIntegrityError);
  } finally {
    reopened?.close();
    repository?.close();
    await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
};

const waitForPreviewJob = async (controller, jobId, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = controller.getPreviewJob ? controller.getPreviewJob(jobId) : controller.getJob(jobId);
    if (job && ['completed', 'cancelled', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for preview job ${jobId}`);
};

const waitForImportJob = async (controller, jobId, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = controller.getImportJob ? controller.getImportJob(jobId) : controller.getJob(jobId);
    if (job && ['completed', 'cancelled', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for import job ${jobId}`);
};

const runStorageBridgeChecks = async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-ipc-'));
  const controller = new ProjectStorageController({ maxImportBytes: 64, maxDocumentBytes: 4096 });
  try {
    const mainCanvasSource = await fs.readFile(path.join(__dirname, '../components/MainCanvas.tsx'), 'utf8');
    assert.match(mainCanvasSource, /createViewportIndexCache/);
    assert.match(mainCanvasSource, /viewportIndexCacheRef\.current!\.update\(elements\)/);
    assert.doesNotMatch(mainCanvasSource, /createViewportIndex\(elements\)/);
    // R14 preserves MainCanvas cache ownership and transmits only an identity-safe live snapshot.
    assert.match(mainCanvasSource, /interactionViewportIndexRef\?: React\.MutableRefObject/);
    assert.match(mainCanvasSource, /useLayoutEffect\(\(\) =>/);
    assert.match(mainCanvasSource, /const snapshot: InteractionViewportIndexSnapshot = \{ elements, index: viewportIndex \}/);
    const appSource = await fs.readFile(path.join(__dirname, '../App.tsx'), 'utf8');
    const interactionSource = await fs.readFile(path.join(__dirname, '../hooks/useCanvasInteractions.ts'), 'utf8');
    const layerPanelSource = await fs.readFile(path.join(__dirname, '../components/LayerPanel.tsx'), 'utf8');
    assert.match(layerPanelSource, /flattenLayerElements\(elements\)/);
    assert.match(layerPanelSource, /getVirtualRowWindow\(/);
    assert.match(layerPanelSource, /visibleLayerRows\.map/);
    assert.match(layerPanelSource, /visibleFrames\.map/);
    assert.doesNotMatch(layerPanelSource, /renderOrderedLayers/);
    assert.doesNotMatch(layerPanelSource, /filter\(el => el\.parentId/);
    assert.match(appSource, /const interactionViewportIndexRef = useRef<InteractionViewportIndexSnapshot \| null>\(null\)/);
    assert.match(appSource, /interactionViewportIndexRef=\{interactionViewportIndexRef\}/);
    assert.match(interactionSource, /queryInteractionCandidates\(interactionViewportIndexRef\?\.current \?\? null, elements, finalSelectionBox\)/);
    assert.match(interactionSource, /const lassoBounds = getLassoBounds\(finalLassoPath\)/);
    assert.match(interactionSource, /pointerMoveFrameRef\.current = requestAnimationFrame/);
    assert.match(interactionSource, /flushPendingPointerMove\(\)/);
    assert.doesNotMatch(interactionSource, /queryViewport\(/);
    // R15 builds only at drag start, uses an O(1) expected-array guard and keeps a legacy fallback.
    assert.match(interactionSource, /createDragSnapGuideSnapshot\(elements, idsToDrag\)/);
    assert.match(interactionSource, /dragSnapGuideSnapshot\.isCurrent\(elements\)/);
    assert.match(interactionSource, /dragSnapGuideSnapshot\.vertical\.findNearest/);
    assert.match(interactionSource, /dragSnapGuideSnapshot\.horizontal\.findNearest/);
    assert.match(interactionSource, /dragMovingElementsRef\.current/);
    assert.match(interactionSource, /const otherElements = elements\.filter/);
    const snapGuideSource = await fs.readFile(path.join(__dirname, '../utils/drag-snap-guide-index.ts'), 'utf8');
    assert.match(snapGuideSource, /buildChildrenByParentId/);
    assert.match(snapGuideSource, /groupGraphIsAcyclic/);
    assert.match(snapGuideSource, /staticGroupHasMovingDescendant/);
    const frameParentSource = await fs.readFile(path.join(__dirname, '../utils/frame-parenting.ts'), 'utf8');
    assert.match(frameParentSource, /queryInteractionCandidates/);
    assert.match(frameParentSource, /b\.width \* a\.height/); // preserve current comparator exactly
    // 无拖动通道时的旧路径仍以保守索引窄化候选；拖动提交（applyDragCommit）另由
    // check-drag-session 守卫，它必须回退全量扫描（详见 utils/drag-commit.ts）。
    assert.match(interactionSource, /resolveContainingFrame\(el, els, interactionViewportIndexRef\?\.current \?\? null\)/);
    assert.match(interactionSource, /!movingElementIds\.has\(el\.id\) \|\| el\.type === 'frame'/);
    const preloadSource = await fs.readFile(path.join(__dirname, '../preload.cjs'), 'utf8');
    const mainSource = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');
    assert.match(preloadSource, /queryViewport: request => ipcRenderer\.invoke\(CHANNELS\.queryViewport, request\)/);
    assert.match(mainSource, /queryViewport: 'artflow-storage:query-viewport'/);
    assert.match(mainSource, /ipcMain\.handle\(CHANNELS\.queryViewport, \(event, request\) => \{\n    assertTrustedRenderer\(event\);/);
    assert.equal((mainSource.match(/artflow-storage:query-viewport/g) || []).length, 1);
    assert.equal((preloadSource.match(/artflow-storage:query-viewport/g) || []).length, 1);
    // R18 adds one bounded, fixed observation capability; it remains sender-checked and does not become a generic bridge.
    assert.match(preloadSource, /listImportJobs: \(\) => ipcRenderer\.invoke\(CHANNELS\.listImportJobs\)/);
    assert.match(mainSource, /listImportJobs: 'artflow-storage:list-import-jobs'/);
    assert.match(mainSource, /ipcMain\.handle\(CHANNELS\.listImportJobs, event => \{\n    assertTrustedRenderer\(event\);/);
    // 18 = 原有 15 + 「最近工程」的 list / open / clear 三条（P3 桌面化能力，均为 sender-checked）。
    assert.equal((mainSource.match(/artflow-storage:/g) || []).length, 18);
    assert.equal((preloadSource.match(/artflow-storage:/g) || []).length, 18);
    const typeSource = await fs.readFile(path.join(__dirname, '../types.ts'), 'utf8');
    assert.match(typeSource, /interface PersistentViewportCursor/);
    assert.match(typeSource, /nextCursor: PersistentViewportCursor \| null/);
    assert.match(typeSource, /listImportJobs\(\): Promise<ManagedImportJob\[\]>/);
    const fileSystemSource = await fs.readFile(path.join(__dirname, '../hooks/useFileSystem.ts'), 'utf8');
    const importJobsPanelSource = await fs.readFile(path.join(__dirname, '../components/ImportJobsPanel.tsx'), 'utf8');
    // R18-R22 债务迁移（原则 #7）：面板组件经 canvas_widgets 插槽由 builtin.workspace-panels 注册，App 只留通用宿主 + 状态桥。
    const workspacePanelsPluginSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/workspace-panels/index.tsx'), 'utf8');
    const workspaceBridgeSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/workspace-bridge.ts'), 'utf8');
    assert.match(appSource, /WorkspaceWidgetHost/);
    assert.match(appSource, /WORKSPACE_UI_BRIDGE_SERVICE/);
    assert.match(appSource, /workspaceUiBridgeRef\.current\.current = \{/);
    assert.match(workspaceBridgeSource, /WORKSPACE_UI_BRIDGE_SERVICE = 'workspace\.ui-bridge'/);
    assert.match(workspacePanelsPluginSource, /'canvas_widgets'/);
    assert.match(workspacePanelsPluginSource, /builtin\.workspace-panels\.dock/);
    assert.match(fileSystemSource, /managedProjectEpochRef/);
    assert.match(fileSystemSource, /listImportJobs/);
    assert.match(fileSystemSource, /requestCancelImportJob/);
    assert.match(importJobsPanelSource, /t\('importJobs\.showingUpTo'\)/);
    assert.match(importJobsPanelSource, /t\('importJobs\.hint'\)/);
    assert.doesNotMatch(importJobsPanelSource, /stagingHash|staging path|raw bytes/);
    assert.match(workspacePanelsPluginSource, /ImportJobsPanel/);
    assert.match(workspacePanelsPluginSource, /bridgeKey: 'importJobs'/);
    // R19 is renderer-only visibility: both runtimes have a workspace dock, while R18 remains the sole gated job UI.
    const workspacePanelSource = await fs.readFile(path.join(__dirname, '../components/ProjectWorkspacePanel.tsx'), 'utf8');
    assert.match(workspacePanelSource, /export const WorkspaceStatusDock/);
    assert.match(workspacePanelSource, /export const ProjectWorkspacePanel/);
    assert.match(workspacePanelSource, /t\('workspace\.mode\.browserLabel'\)/);
    assert.match(workspacePanelSource, /t\('workspace\.mode\.managedLabel'\)/);
    assert.match(workspacePanelSource, /t\('workspace\.openImportJobs'\)/);
    assert.match(workspacePanelSource, /\{canOpenImportJobs && \(/);
    assert.doesNotMatch(workspacePanelSource, /listImportJobs|artflowStorage|requestImport|getImportJob|cancelImportJob|stagingHash|raw bytes/);
    assert.match(fileSystemSource, /isManagedProjectStorageAvailable: hasManagedProjectStorage\(\)/);
    assert.match(fileSystemSource, /if \(!selectedProject\) return false/);
    assert.match(workspacePanelsPluginSource, /WorkspaceStatusDock/);
    assert.match(workspacePanelsPluginSource, /ProjectWorkspacePanel/);
    assert.match(appSource, /storageMode: isManagedProjectStorageAvailable \? 'managed' : 'browser'/);
    assert.match(appSource, /canOpenImportJobs: isManagedImportJobsAvailable/);
    assert.match(appSource, /const didSave = await saveProject\(boardsAtSaveStart\)/); // R23 preserves the existing save path while retaining its snapshot for stale-save safety.
    // R20 has a bounded local overview and changes only the existing renderer camera state.
    const canvasNavigatorSource = await fs.readFile(path.join(__dirname, '../components/CanvasNavigator.tsx'), 'utf8');
    const canvasNavigatorUtilitySource = await fs.readFile(path.join(__dirname, '../utils/canvasNavigator.ts'), 'utf8');
    assert.match(canvasNavigatorSource, /ResizeObserver/);
    assert.match(canvasNavigatorSource, /t\('navigator\.fit'\)/);
    assert.match(canvasNavigatorSource, /t\('navigator\.hint'\)/);
    assert.match(canvasNavigatorUtilitySource, /NAVIGATOR_MAX_MARKERS = 240/);
    assert.match(canvasNavigatorUtilitySource, /element\.type === 'group'/);
    assert.match(canvasNavigatorUtilitySource, /getElementBounds/);
    assert.doesNotMatch(canvasNavigatorSource, /queryViewport|artflowStorage|listImportJobs|requestImport|getImportJob/);
    assert.doesNotMatch(canvasNavigatorUtilitySource, /queryViewport|artflowStorage|listImportJobs|requestImport|getImportJob/);
    assert.match(workspacePanelsPluginSource, /CanvasNavigator/);
    // Navigator surface opacity is a plugin parameter (navigatorOpacity): declared in the
    // workspace-panels manifest configSchema, edited from the plugin details form, and applied
    // live by CanvasNavigator via the plugin:config-changed event (no reload).
    const workspacePanelsManifest = JSON.parse(await fs.readFile(path.join(__dirname, '../builtin-plugins/workspace-panels/manifest.json'), 'utf8'));
    assert.equal(workspacePanelsManifest.configSchema?.navigatorOpacity, 'number');
    assert.match(canvasNavigatorSource, /navigatorOpacity/);
    assert.match(canvasNavigatorSource, /plugin:config-changed/);
    assert.match(appSource, /onViewportChange: next => updateActiveBoard\(board => \(\{/);
    // R21 layers named camera views on R20 without widening IPC, history, or capability boundaries.
    const viewBookmarksPanelSource = await fs.readFile(path.join(__dirname, '../components/ViewBookmarksPanel.tsx'), 'utf8');
    const viewBookmarksSource = await fs.readFile(path.join(__dirname, '../utils/viewBookmarks.ts'), 'utf8');
    const projectDocumentSource = await fs.readFile(path.join(__dirname, '../utils/projectDocument.ts'), 'utf8');
    assert.match(canvasNavigatorSource, /t\('navigator\.views'\)\}\{viewBookmarkCount/);
    assert.match(viewBookmarksPanelSource, /t\('viewBookmarks\.saveCurrent'\)/);
    assert.match(viewBookmarksPanelSource, /t\('viewBookmarks\.subtitle'\)/);
    assert.match(workspacePanelsPluginSource, /ViewBookmarksPanel/);
    assert.match(appSource, /handleRestoreViewBookmark/);
    assert.match(appSource, /viewBookmarks: appendCanvasViewBookmark/);
    assert.match(appSource, /viewBookmarks: renameCanvasViewBookmark/);
    assert.match(appSource, /viewBookmarks: removeCanvasViewBookmark/);
    const viewHandlersSource = appSource.slice(appSource.indexOf('// R21 keeps view edits'), appSource.indexOf('    useEffect(() => {', appSource.indexOf('// R21 keeps view edits')));
    assert.match(viewHandlersSource, /updateActiveBoard/);
    assert.doesNotMatch(viewHandlersSource, /commitAction|setElements|setSelectedElementIds|operationHistory|artflowStorage|ipcRenderer/);
    assert.match(projectDocumentSource, /viewBookmarks: normalizeViewBookmarks\(board\.viewBookmarks\)/);
    assert.match(projectDocumentSource, /viewBookmarks: normalizeViewBookmarks\(projectBoard\.viewBookmarks\)/);
    assert.match(viewBookmarksSource, /MAX_VIEW_BOOKMARKS = 12/);
    assert.match(viewBookmarksSource, /VIEW_BOOKMARK_NAME_MAX_LENGTH = 48/);
    assert.doesNotMatch(viewBookmarksPanelSource, /artflowStorage|listImportJobs|requestImport|getImportJob|ipcRenderer/);
    assert.doesNotMatch(viewBookmarksSource, /artflowStorage|listImportJobs|requestImport|getImportJob|ipcRenderer/);
    // R22 is an ephemeral current-board scan with a camera-only focus action; it is not an R11/R12/R13 consumer.
    const canvasFinderPanelSource = await fs.readFile(path.join(__dirname, '../components/CanvasFinderPanel.tsx'), 'utf8');
    const canvasFinderSource = await fs.readFile(path.join(__dirname, '../utils/canvasFinder.ts'), 'utf8');
    assert.match(canvasNavigatorSource, /t\('navigator\.find'\)/);
    assert.match(canvasFinderPanelSource, /t\('finder\.title'\)/);
    assert.match(canvasFinderPanelSource, /t\('finder\.focusHint'\)/);
    assert.match(workspacePanelsPluginSource, /CanvasFinderPanel/);
    assert.match(appSource, /onOpenFinder/);
    assert.match(canvasFinderSource, /CANVAS_FINDER_MAX_RESULTS = 50/);
    assert.match(canvasFinderSource, /centerCanvasPointInViewport/);
    assert.match(canvasFinderSource, /element\.isVisible === false/);
    const finderHandlerSource = appSource.slice(appSource.indexOf('// R22 finder is read-only'), appSource.indexOf('    useEffect(() => {', appSource.indexOf('// R22 finder is read-only')));
    assert.match(finderHandlerSource, /updateActiveBoard\(board => \(\{ \.\.\.board, panOffset: panOffsetForResult \}\)\)/);
    assert.doesNotMatch(finderHandlerSource, /zoom:|commitAction|setElements|setSelectedElementIds|operationHistory|artflowStorage|ipcRenderer/);
    assert.doesNotMatch(canvasFinderPanelSource, /artflowStorage|listImportJobs|requestImport|getImportJob|queryViewport|ipcRenderer/);
    assert.doesNotMatch(canvasFinderSource, /artflowStorage|listImportJobs|requestImport|getImportJob|queryViewport|ipcRenderer|createViewportIndex/);
    // R28 command surface is generic; the builtin owns command labels/id/actions and uses a narrow renderer-only service.
    const commandsSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/commands.ts'), 'utf8');
    const commandPaletteSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/command-palette.tsx'), 'utf8');
    const workspaceCommandActionsSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/workspace-command-actions.ts'), 'utf8');
    const builtinIndexSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/index.ts'), 'utf8');
    const commandTopBarSource = await fs.readFile(path.join(__dirname, '../components/TopBar.tsx'), 'utf8');
    assert.match(commandsSource, /listCommandContributions/);
    assert.match(commandsSource, /resolveCommandShortcut/);
    assert.match(commandsSource, /Boolean\(binding\.alt\) === Boolean\(event\.altKey\)/);
    assert.match(commandPaletteSource, /Ctrl\/⌘K/);
    assert.match(commandPaletteSource, /arbitrateShortcut/);
    assert.match(commandPaletteSource, /window\.addEventListener\('keydown', onKeyDown, true\)/);
    assert.match(commandPaletteSource, /stopPaletteEvent\(event\);\n      void runContribution\(winner\.contribution\)/);
    assert.doesNotMatch(commandPaletteSource, /workspace\.fit-canvas|Fit canvas|Open extensions|CanvasFinder|CanvasNavigator|App/);
    // commands-workspace 已并入 editable channel 的 builtin.commands-core（下方断言覆盖）。
    assert.match(workspaceCommandActionsSource, /fitCanvas\(\)/);
    assert.match(workspaceCommandActionsSource, /openCanvasFinder\(\)/);
    assert.doesNotMatch(workspaceCommandActionsSource, /ipcRenderer|artflowStorage|localStorage|sqlite|Worker/);
    // commands-core 已迁 editable channel：注册表不再含 commandsCorePlugin，源码在 plugins。
    assert.doesNotMatch(builtinIndexSource, /commandsCorePlugin/);
    const commandsCoreEditableSource = await fs.readFile(
      path.join(__dirname, '../plugins/builtin.commands-core/plugin.js'), 'utf8');
    assert.match(commandsCoreEditableSource, /Artflow\.services\.ELEMENT_COMMAND_ACTIONS/);
    assert.match(commandsCoreEditableSource, /Artflow\.services\.WORKSPACE_COMMAND_ACTIONS/);
    assert.match(commandsCoreEditableSource, /edit\.undo/);
    assert.match(commandsCoreEditableSource, /workspace\.fit-canvas/);
    assert.match(appSource, /CommandPalette/);
    assert.match(appSource, /WORKSPACE_COMMAND_ACTIONS_SERVICE/);
    assert.doesNotMatch(appSource, /workspace\.fit-canvas|Fit canvas|Find on canvas|Open saved views|Open extensions/);
    assert.doesNotMatch(commandTopBarSource, /workspace\.fit-canvas|Fit canvas|Find on canvas|Open saved views|Open extensions/);
    assert.match(commandTopBarSource, /onOpenCommandPalette/);
    // R24 keeps tags as bounded Element metadata: selected-card writes reuse content history, and Finder only projects current-board values.
    const elementTagsSource = await fs.readFile(path.join(__dirname, '../utils/elementTags.ts'), 'utf8');
    const elementTagsPanelSource = await fs.readFile(path.join(__dirname, '../components/ElementTagsPanel.tsx'), 'utf8');
    const topBarSource = await fs.readFile(path.join(__dirname, '../components/TopBar.tsx'), 'utf8');
    const typesSource = await fs.readFile(path.join(__dirname, '../types.ts'), 'utf8');
    assert.match(typesSource, /tags\?: string\[\]/);
    assert.match(elementTagsSource, /MAX_ELEMENT_TAGS = 12/);
    assert.match(elementTagsSource, /ELEMENT_TAG_MAX_LENGTH = 24/);
    assert.match(elementTagsSource, /normalizeElementTag/);
    assert.match(projectDocumentSource, /if \(key === 'tags'\)/);
    assert.match(projectDocumentSource, /normalizeElementTagMetadata/);
    assert.equal(PROJECT_DOCUMENT_FORMAT, 'artflow-project');
    assert.equal(projectDocument.version, 2);
    assert.match(topBarSource, /selectedElementCount/);
    assert.match(topBarSource, /onOpenTags/);
    assert.match(topBarSource, /t\('topBar\.tagSelected'/);
    assert.match(elementTagsPanelSource, /t\('tags\.title'\)/);
    assert.match(elementTagsPanelSource, /t\('tags\.maxHint'\)/);
    const studioChromeSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/studio-chrome/index.tsx'), 'utf8');
    assert.match(studioChromeSource, /ElementTagsPanel/);
    assert.match(appSource, /placement="tags"/);
    const r24TagHandlerSource = appSource.slice(appSource.indexOf('// R24 tag writes deliberately'), appSource.indexOf('    useEffect(() => {', appSource.indexOf('// R24 tag writes deliberately')));
    assert.match(r24TagHandlerSource, /commitAction/);
    assert.match(r24TagHandlerSource, /addElementTag/);
    assert.match(r24TagHandlerSource, /removeElementTag/);
    assert.doesNotMatch(r24TagHandlerSource, /updateActiveBoard|setSelectedElementIds|setElements|operationHistory|artflowStorage|ipcRenderer/);
    assert.match(canvasFinderSource, /normalizeElementTags\(element\.tags\)/);
    assert.match(canvasFinderPanelSource, /result\.tags\.slice\(0, 3\)/);
    assert.doesNotMatch(elementTagsSource, /localStorage|artflowStorage|ipcRenderer|sqlite|registry|autocomplete|Worker/);
    assert.doesNotMatch(elementTagsPanelSource, /artflowStorage|ipcRenderer|autocomplete|history|registry/);
    // R23 exposes only session-local Board[] change state; save/load ownership remains with existing paths.
    const projectChangeTrackerSource = await fs.readFile(path.join(__dirname, '../utils/projectChangeTracker.ts'), 'utf8');
    const canvasStateSource = await fs.readFile(path.join(__dirname, '../hooks/useCanvasState.ts'), 'utf8');
    assert.match(projectChangeTrackerSource, /completeProjectSave/);
    assert.match(projectChangeTrackerSource, /currentBoards === savedBoards/);
    assert.match(projectChangeTrackerSource, /acceptLoadedProjectBoards/);
    assert.doesNotMatch(projectChangeTrackerSource, /serializeProjectDocument|localStorage|ipcRenderer|artflowStorage/);
    assert.match(canvasStateSource, /const loadBoardData = useCallback\(\(serializedProject: unknown\): boolean/);
    assert.match(canvasStateSource, /if \(normalizedBoards\.length === 0\) return false/);
    assert.match(canvasStateSource, /return true/);
    assert.match(workspacePanelSource, /t\('workspace\.saveStatus\.unsavedLabel'\)/);
    assert.match(workspacePanelSource, /t\('workspace\.saveStatus\.cleanLabel'\)/);
    assert.match(workspacePanelSource, /t\('workspace\.saveStatus\.newLabel'\)/);
    assert.match(workspacePanelSource, /t\('workspace\.saveStatus\.cleanDetail'\)/);
    assert.match(appSource, /hasUnsavedChanges/);
    assert.match(appSource, /hasProjectSaveBaseline/);
    const r23OpenHandlerSource = appSource.slice(appSource.indexOf('const handleOpenProjectClick'), appSource.indexOf('const handleSaveProjectClick'));
    const r23SaveHandlerSource = appSource.slice(appSource.indexOf('const handleSaveProjectClick'), appSource.indexOf('const handleOpenImportJobs'));
    assert.match(r23OpenHandlerSource, /data && loadBoardData\(data\)/);
    assert.match(r23OpenHandlerSource, /pendingProjectLoadBaselineRef\.current = true/);
    assert.match(r23SaveHandlerSource, /Array\.isArray\(overrideBoards\) \? overrideBoards : boards/);
    assert.match(r23SaveHandlerSource, /saveProject\(boardsAtSaveStart\)/);
    assert.match(r23SaveHandlerSource, /completeProjectSave\(/);
    assert.doesNotMatch(r23SaveHandlerSource, /serializeProjectDocument|artflowStorage|ipcRenderer|localStorage/);
    assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*ipcRenderer/);
    // 重启应用通道（R45）：唯一会终结本进程的渲染层能力，固定单 op、经可信渲染层校验，
    // 渲染层只能经 host.platform 消费；preload 只暴露 invoke 包装，不得泄露 ipcRenderer。
    const restartMainSource = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');
    assert.match(restartMainSource, /restartApp: 'artflow-app:restart-app'/);
    assert.match(restartMainSource, /ipcMain\.handle\(CHANNELS\.restartApp, event => \{\n    assertTrustedRenderer\(event\);/);
    assert.match(restartMainSource, /app\.relaunch\(\);\n[\s\S]{0,200}?app\.quit\(\);/);
    assert.match(preloadSource, /restartApp: \(\) => ipcRenderer\.invoke\(CHANNELS\.restartApp\)/);
    const restartHostPlatformSource = await fs.readFile(path.join(__dirname, '../plugin-runtime/host-platform.ts'), 'utf8');
    assert.match(restartHostPlatformSource, /canRestartApp: typeof bridge\?\.restartApp === 'function'/);
    assert.match(restartHostPlatformSource, /restartApp: \(\) => bridge\?\.restartApp\?\.\(\)/);
    const restartCoreSettingsSource = await fs.readFile(path.join(__dirname, '../builtin-plugins/core-settings/index.tsx'), 'utf8');
    assert.match(restartCoreSettingsSource, /<AppSessionSection kernel=\{kernel\} language=\{language\} \/>/);
    assert.match(restartCoreSettingsSource, /window\.confirm\(/);
    assert.doesNotMatch(restartCoreSettingsSource, /window\.artflowApp|ipcRenderer|window\.location\.reload/);
    const productionTrust = createTrustedRendererUrlChecker({
      isDev: false,
      devOrigin: 'http://localhost:4002',
      rendererRoot: path.join(projectRoot, 'dist'),
    });
    assert.equal(productionTrust(pathToFileURL(path.join(projectRoot, 'dist', 'index.html')).href), true);
    assert.equal(productionTrust('file:///tmp/untrusted/index.html'), false);
    const developmentTrust = createTrustedRendererUrlChecker({
      isDev: true,
      devOrigin: 'http://localhost:4002',
      rendererRoot: path.join(projectRoot, 'dist'),
    });
    assert.equal(developmentTrust('http://localhost:4002/'), true);
    assert.equal(developmentTrust('https://example.test/'), false);

    assert.deepEqual(controller.status(), { isOpen: false, projectName: null });
    await controller.openProject(projectRoot);
    assert.equal(controller.status().isOpen, true);
    assert.deepEqual(controller.listImportJobs(), []);

    // Project open starts both durable schedulers through the narrow controller, without exposing a generic capability.
    let derivativeRestoreCalls = 0;
    let importRestoreCalls = 0;
    const lifecycleRepository = { projectRoot, close() {} };
    const lifecycleController = new ProjectStorageController({
      openRepository: async () => lifecycleRepository,
      createDerivativeController: () => ({ restore() { derivativeRestoreCalls += 1; }, close() {} }),
      createImportController: () => ({ restore() { importRestoreCalls += 1; }, close() {} }),
    });
    await lifecycleController.openProject(projectRoot);
    assert.equal(derivativeRestoreCalls, 1);
    assert.equal(importRestoreCalls, 1);
    lifecycleController.close();

    const bytes = Uint8Array.from([66, 97, 110, 97, 110, 97]).buffer;
    const stored = await controller.importAsset({
      asset: {
        id: 'ipc-file',
        kind: 'file',
        sourceKind: 'legacy-inline',
        locator: { fileRef: 'data:text/plain;base64,QmFuYW5h', mimeType: 'text/plain', extension: 'txt' },
        metadata: {},
      },
      bytes,
      originalName: 'banana.txt',
    });
    const resolved = await controller.resolveAssetRequest(stored.asset.locator.fileRef);
    assert.equal(resolved.mimeType, 'text/plain');
    assert.deepEqual(resolved.bytes, Buffer.from(bytes));
    assert.equal(normalizeMimeType('text/plain\r\nX-Unsafe: true'), 'application/octet-stream');
    await assert.rejects(
      () => controller.importAsset({ asset: stored.asset, bytes: new ArrayBuffer(65) }),
      ProjectStorageError,
    );
    await assert.rejects(
      () => controller.resolveAssetRequest('artflow-asset://sha256/not-a-hash'),
      ProjectStorageError,
    );

    const controllerDocument = {
      format: 'artflow-project',
      version: 2,
      assets: [stored.asset],
      boards: [{ id: 'ipc-board', name: 'IPC', panOffset: { x: 0, y: 0 }, zoom: 1, canvasBackgroundColor: '#111827', operationHistory: [], operationHistoryIndex: -1 }],
      nodes: [{ id: 'ipc-node', boardId: 'ipc-board', assetId: 'ipc-file', nodeType: 'file', x: 0, y: 0, width: 10, height: 10, zIndex: 0, properties: { name: 'Banana' } }],
    };
    controller.saveProject(controllerDocument);
    assert.deepEqual(controller.loadProject(), controllerDocument);
    assert.deepEqual(controller.queryViewport({ boardId: 'ipc-board', rect: { x: 10, y: 10, width: 0, height: 0 }, limit: 1 }), {
      nodes: [{ id: 'ipc-node', boardId: 'ipc-board', nodeType: 'file', zIndex: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      truncated: false,
      snapshotRevision: 1,
      nextCursor: null,
    });
    assert.throws(() => controller.queryViewport({ boardId: 'ipc-board', rect: { x: 0, y: 0, width: 1, height: 1 }, limit: 0 }), ProjectStorageError);
    assert.throws(() => controller.queryViewport({ boardId: 'ipc-board', rect: { x: 0, y: 0, width: 1, height: 1 }, padding: 'x'.repeat(4096) }), ProjectStorageError);
    const previewJob = controller.requestPreview('ipc-file');
    const completedPreviewJob = await waitForPreviewJob(controller, previewJob.id);
    assert.equal(completedPreviewJob.status, 'completed');
    assert.equal(completedPreviewJob.derivative.recipe, PREVIEW_RECIPE);
    const importJob = await controller.requestImport({
      asset: {
        id: 'ipc-staged-file',
        kind: 'file',
        sourceKind: 'legacy-inline',
        locator: { fileRef: 'data:text/plain;base64,U3RhZ2Vk', mimeType: 'text/plain', extension: 'txt' },
        metadata: {},
      },
      bytes: Uint8Array.from([83, 116, 97, 103, 101, 100]).buffer,
      originalName: 'staged.txt',
    });
    const completedImportJob = await waitForImportJob(controller, importJob.id);
    assert.equal(completedImportJob.status, 'completed');
    assert.equal(completedImportJob.result.asset.sourceKind, 'managed-store');
    assert.equal((await controller.resolveAssetRequest(completedImportJob.result.asset.locator.fileRef)).bytes.toString('utf8'), 'Staged');
    const safeListedImport = controller.listImportJobs().find(job => job.id === importJob.id);
    assert.equal(safeListedImport.displayName, 'staged.txt');
    assert.equal(safeListedImport.status, 'completed');
    assert.ok(Number.isFinite(safeListedImport.createdAt));
    assert.ok(Number.isFinite(safeListedImport.updatedAt));
    assert.equal(Object.hasOwn(safeListedImport, 'draft'), false);
    assert.equal(Object.hasOwn(safeListedImport, 'stagingHash'), false);
    assert.equal(Object.hasOwn(safeListedImport, 'originalName'), false);

    const imports = [];
    const storageMock = {
      importAsset: async request => {
        imports.push(request);
        return {
          asset: {
            ...request.asset,
            sourceKind: 'managed-store',
            locator: {
              previewRef: 'artflow-asset://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              originalRef: 'artflow-asset://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              mimeType: request.asset.locator.mimeType,
              byteSize: request.bytes.byteLength,
            },
          },
          contentHash: 'a'.repeat(64),
          byteSize: request.bytes.byteLength,
          blobCreated: true,
        };
      },
    };
    const rawRendererDocument = {
      format: 'artflow-project',
      version: 2,
      assets: [{ id: 'renderer-image', kind: 'image', sourceKind: 'legacy-inline', locator: { previewRef: 'data:text/plain;base64,QmFuYW5h', mimeType: 'text/plain' }, metadata: {} }],
      boards: [],
      nodes: [],
    };
    const materialized = await materializeManagedProjectDocument(rawRendererDocument, storageMock);
    assert.equal(imports.length, 1);
    assert.equal(new TextDecoder().decode(imports[0].bytes), 'Banana');
    assert.equal(materialized.assets[0].sourceKind, 'managed-store');

    const durableImportRequests = [];
    let durableImportPolls = 0;
    const durableStorageMock = {
      importAsset: async () => { throw new Error('R10 durable path must not fall back to direct import'); },
      requestImport: async request => {
        durableImportRequests.push(request);
        return { id: 'durable-import-job', assetId: request.asset.id, status: 'queued', progress: 0, errorCode: null, result: null };
      },
      getImportJob: async jobId => {
        assert.equal(jobId, 'durable-import-job');
        durableImportPolls += 1;
        if (durableImportPolls === 1) {
          return { id: jobId, assetId: 'renderer-image', status: 'running', progress: 0.5, errorCode: null, result: null };
        }
        return {
          id: jobId,
          assetId: 'renderer-image',
          status: 'completed',
          progress: 1,
          errorCode: null,
          result: {
            asset: {
              id: 'renderer-image',
              kind: 'image',
              sourceKind: 'managed-store',
              locator: {
                previewRef: 'artflow-asset://sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                originalRef: 'artflow-asset://sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                mimeType: 'text/plain',
                byteSize: 6,
              },
              metadata: {},
            },
            contentHash: 'b'.repeat(64),
            byteSize: 6,
          },
        };
      },
    };
    const durableObservations = [];
    const durableMaterialized = await materializeManagedProjectDocument(rawRendererDocument, durableStorageMock, {
      onImportJobUpdate: update => durableObservations.push(update),
    });
    assert.equal(durableImportRequests.length, 1);
    assert.equal(new TextDecoder().decode(durableImportRequests[0].bytes), 'Banana');
    assert.equal(durableImportPolls, 2);
    assert.deepEqual(durableObservations.map(update => update.job.status), ['queued', 'running', 'completed']);
    assert.deepEqual(durableObservations.map(update => [update.assetId, update.assetOrdinal, update.assetCount]), [
      ['renderer-image', 1, 1],
      ['renderer-image', 1, 1],
      ['renderer-image', 1, 1],
    ]);
    assert.equal(durableMaterialized.assets[0].sourceKind, 'managed-store');
    assert.match(durableMaterialized.assets[0].locator.previewRef, /^artflow-asset:/);

    const durableActualDocument = {
      ...rawRendererDocument,
      assets: [{ ...rawRendererDocument.assets[0], id: 'renderer-durable-bridge' }],
    };
    const actualDurableMaterialized = await materializeManagedProjectDocument(durableActualDocument, {
      importAsset: async () => { throw new Error('actual durable bridge must not use direct import'); },
      requestImport: request => controller.requestImport(request),
      getImportJob: async jobId => controller.getImportJob(jobId),
    });
    assert.equal(actualDurableMaterialized.assets[0].sourceKind, 'managed-store');
    assert.equal((await controller.resolveAssetRequest(actualDurableMaterialized.assets[0].locator.previewRef)).bytes.toString('utf8'), 'Banana');

    const terminalImportFailure = status => ({
      importAsset: async () => { throw new Error('unexpected direct import fallback'); },
      requestImport: async request => ({ id: `terminal-${status}`, assetId: request.asset.id, status, progress: status === 'failed' ? 0.5 : 0, errorCode: status === 'failed' ? 'STORAGE_ERROR' : null, result: null }),
      getImportJob: async () => { throw new Error('terminal import should not poll'); },
    });
    await assert.rejects(
      () => materializeManagedProjectDocument(rawRendererDocument, terminalImportFailure('failed')),
      /did not complete: failed \(STORAGE_ERROR\)/,
    );
    await assert.rejects(
      () => materializeManagedProjectDocument(rawRendererDocument, terminalImportFailure('cancelled')),
      /did not complete: cancelled/,
    );
    await assert.rejects(
      () => materializeManagedProjectDocument(rawRendererDocument, {
        importAsset: async () => { throw new Error('unexpected direct import fallback'); },
        requestImport: async request => ({ id: 'missing-job', assetId: request.asset.id, status: 'queued', progress: 0, errorCode: null, result: null }),
        getImportJob: async () => null,
      }),
      /is no longer available/,
    );
    await assert.rejects(
      () => materializeManagedProjectDocument(rawRendererDocument, {
        importAsset: async () => { throw new Error('unexpected direct import fallback'); },
        requestImport: async request => ({ id: 'missing-result', assetId: request.asset.id, status: 'completed', progress: 1, errorCode: null, result: null }),
        getImportJob: async () => { throw new Error('completed import should not poll'); },
      }),
      /completed without a matching managed result/,
    );
    await assert.rejects(
      () => materializeManagedProjectDocument({
        ...rawRendererDocument,
        assets: [{ ...rawRendererDocument.assets[0], locator: { previewRef: 'https://example.test/asset.png', mimeType: 'image/png' }, sourceKind: 'external-reference' }],
      }, storageMock),
      /data\/blob backed/,
    );
  } finally {
    controller.close();
    await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
};

const runImportJobChecks = async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-import-'));
  const migrationProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-import-v3-'));
  let repository;
  let migrationRepository;
  let interruptedController;
  let resumedController;
  let cancellationController;
  let failedController;
  let reopenedController;
  try {
    const preloadSource = await fs.readFile(path.join(__dirname, '../preload.cjs'), 'utf8');
    const mainSource = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');
    assert.match(preloadSource, /requestImport: \(\{ asset, bytes, originalName \}\) => ipcRenderer\.invoke/);
    assert.match(preloadSource, /getImportJob: jobId => ipcRenderer\.invoke/);
    assert.match(preloadSource, /listImportJobs: \(\) => ipcRenderer\.invoke/);
    assert.match(preloadSource, /cancelImportJob: jobId => ipcRenderer\.invoke/);
    assert.match(mainSource, /requestImport: 'artflow-storage:request-import'/);
    assert.match(mainSource, /listImportJobs: 'artflow-storage:list-import-jobs'/);
    assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*ipcRenderer/);

    // R18 summary list is active-first, bounded, and strips private staged-journal implementation details.
    const summaryRecords = [
      ...[1, 2].map(index => ({
        id: `active-summary-${index}`,
        assetId: `active-asset-${index}`,
        draft: { metadata: { originalName: `C:\\private\\active-${index}.txt` } },
        originalName: `C:\\private\\active-${index}.txt`,
        status: 'running',
        progress: 0.05,
        errorCode: null,
        result: null,
        createdAt: index,
        updatedAt: index,
        stagingHash: 'private-hash',
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `terminal-summary-${index}`,
        assetId: `terminal-asset-${index}`,
        draft: { metadata: { originalName: `C:\\private\\terminal-${index}.txt` } },
        originalName: `C:\\private\\terminal-${index}.txt`,
        status: 'completed',
        progress: 1,
        errorCode: null,
        result: null,
        createdAt: index + 10,
        updatedAt: index + 10,
        stagingHash: 'private-hash',
      })),
    ];
    const summaryController = new AssetImportController({ repository: { recoverImportJobs: () => summaryRecords } });
    const boundedSummary = summaryController.listJobs();
    assert.equal(MAX_LISTED_IMPORT_JOBS, 25);
    assert.equal(boundedSummary.length, MAX_LISTED_IMPORT_JOBS);
    assert.deepEqual(boundedSummary.slice(0, 2).map(job => job.id), ['active-summary-1', 'active-summary-2']);
    assert.deepEqual(boundedSummary.slice(2, 5).map(job => job.id), ['terminal-summary-29', 'terminal-summary-28', 'terminal-summary-27']);
    assert.equal(boundedSummary[0].displayName, 'active-1.txt');
    assert.equal(Object.hasOwn(boundedSummary[0], 'draft'), false);
    assert.equal(Object.hasOwn(boundedSummary[0], 'stagingHash'), false);
    assert.equal(Object.hasOwn(boundedSummary[0], 'originalName'), false);
    assert.doesNotMatch(JSON.stringify(boundedSummary), /C:\\private|private-hash/);
    summaryController.close();

    // An R8 v3 project gains import metadata in-place; no parallel staging database is introduced.
    migrationRepository = await ProjectRepository.open(migrationProjectRoot);
    migrationRepository.close();
    migrationRepository = null;
    const v3Database = new DatabaseSync(path.join(migrationProjectRoot, '.artflow', 'metadata.sqlite'));
    v3Database.exec("DROP TABLE import_job_metadata; UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';");
    v3Database.close();
    migrationRepository = await ProjectRepository.open(migrationProjectRoot);
    assert.deepEqual(migrationRepository.listImportJobs(), []);
    migrationRepository.close();
    migrationRepository = null;

    repository = await ProjectRepository.open(projectRoot);
    const draftAsset = (id, name) => ({
      id,
      kind: 'file',
      sourceKind: 'legacy-inline',
      locator: { fileRef: `data:text/plain;base64,${Buffer.from(name).toString('base64')}`, mimeType: 'text/plain', extension: 'txt' },
      metadata: { originalName: name },
    });
    const first = await repository.stageImport({
      id: crypto.randomUUID(),
      asset: draftAsset('raw-import-one', 'first'),
      bytes: Buffer.from('first'),
      originalName: 'first.txt',
    });
    const second = await repository.stageImport({
      id: crypto.randomUUID(),
      asset: draftAsset('raw-import-two', 'second'),
      bytes: Buffer.from('second'),
      originalName: 'second.txt',
    });
    // The durable draft keeps only safe metadata; the renderer data URL never enters the import journal.
    assert.equal(first.status, 'queued');
    assert.equal((await repository.readImportJobBytes(first.id)).toString('utf8'), 'first');
    assert.deepEqual(first.draft.locator, { mimeType: 'text/plain', extension: 'txt' });
    assert.equal(Object.hasOwn(first.draft.locator, 'fileRef'), false);

    let enteredRead;
    const readStarted = new Promise(resolve => { enteredRead = resolve; });
    let releaseRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    let finishedInterruptedRead;
    const interruptedReadFinished = new Promise(resolve => { finishedInterruptedRead = resolve; });
    const blockingRepository = {
      recoverImportJobs: (...args) => repository.recoverImportJobs(...args),
      updateImportJob: (...args) => repository.updateImportJob(...args),
      readImportJobBytes: async id => {
        if (id === first.id) {
          enteredRead();
          await readGate;
        }
        const bytes = await repository.readImportJobBytes(id);
        if (id === first.id) finishedInterruptedRead();
        return bytes;
      },
      putAsset: (...args) => repository.putAsset(...args),
    };
    interruptedController = new AssetImportController({ repository: blockingRepository });
    interruptedController.restore();
    await readStarted;
    assert.equal(repository.getImportJob(first.id).status, 'running');
    assert.equal(repository.getImportJob(second.id).status, 'queued');
    interruptedController.close();
    interruptedController = null;
    releaseRead();
    await interruptedReadFinished;
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(repository.getImportJob(first.id).status, 'cancelled');
    repository.close();
    repository = await ProjectRepository.open(projectRoot);
    const recovered = repository.recoverImportJobs();
    assert.equal(recovered.find(job => job.id === first.id).status, 'queued');
    assert.equal(recovered.find(job => job.id === second.id).status, 'queued');
    assert.deepEqual(
      recovered.filter(job => job.id === first.id || job.id === second.id).map(job => job.id),
      [first.id, second.id],
    );
    resumedController = new AssetImportController({ repository });
    resumedController.restore();
    const firstCompleted = await waitForImportJob(resumedController, first.id);
    const secondCompleted = await waitForImportJob(resumedController, second.id);
    assert.equal(firstCompleted.status, 'completed');
    assert.equal(secondCompleted.status, 'completed');
    assert.equal(Object.hasOwn(firstCompleted, 'stagingHash'), false);
    assert.equal((await repository.readAssetBytes('raw-import-one')).toString('utf8'), 'first');
    assert.equal(firstCompleted.result.asset.sourceKind, 'managed-store');

    // Explicit queued cancellation is terminal and distinct from the close/recovery path above.
    const blocker = await repository.stageImport({
      id: crypto.randomUUID(),
      asset: draftAsset('raw-import-blocker', 'blocker'),
      bytes: Buffer.from('blocker'),
      originalName: 'blocker.txt',
    });
    const cancelled = await repository.stageImport({
      id: crypto.randomUUID(),
      asset: draftAsset('raw-import-cancelled', 'cancelled'),
      bytes: Buffer.from('cancelled'),
      originalName: 'cancelled.txt',
    });
    let enteredCancelRead;
    const cancelReadStarted = new Promise(resolve => { enteredCancelRead = resolve; });
    let releaseCancelRead;
    const cancelReadGate = new Promise(resolve => { releaseCancelRead = resolve; });
    const cancellationRepository = {
      recoverImportJobs: (...args) => repository.recoverImportJobs(...args),
      updateImportJob: (...args) => repository.updateImportJob(...args),
      readImportJobBytes: async id => {
        if (id === blocker.id) {
          enteredCancelRead();
          await cancelReadGate;
        }
        return repository.readImportJobBytes(id);
      },
      putAsset: (...args) => repository.putAsset(...args),
    };
    cancellationController = new AssetImportController({ repository: cancellationRepository });
    cancellationController.restore();
    await cancelReadStarted;
    assert.equal(cancellationController.cancelJob(cancelled.id).status, 'cancelled');
    releaseCancelRead();
    assert.equal((await waitForImportJob(cancellationController, blocker.id)).status, 'completed');
    assert.equal(repository.getImportJob(cancelled.id).status, 'cancelled');
    cancellationController.close();
    cancellationController = null;

    // Missing staged bytes make a durable failed record rather than a fabricated result.
    const failed = await repository.stageImport({
      id: crypto.randomUUID(),
      asset: draftAsset('raw-import-failed', 'failed'),
      bytes: Buffer.from('failed'),
      originalName: 'failed.txt',
    });
    await fs.unlink(repository.getImportStagingPath(failed.stagingHash));
    failedController = new AssetImportController({ repository });
    failedController.restore();
    const failedResult = await waitForImportJob(failedController, failed.id);
    assert.equal(failedResult.status, 'failed');
    assert.equal(failedResult.errorCode, 'STORAGE_ERROR');
    failedController.close();
    failedController = null;

    resumedController.close();
    resumedController = null;
    repository.close();
    repository = await ProjectRepository.open(projectRoot);
    assert.equal(repository.getImportJob(first.id).status, 'completed');
    assert.equal(repository.getImportJob(cancelled.id).status, 'cancelled');
    assert.equal(repository.getImportJob(failed.id).status, 'failed');
    reopenedController = new AssetImportController({ repository });
    assert.equal(reopenedController.getJob(first.id).status, 'completed');
    assert.equal(reopenedController.getJob(cancelled.id).status, 'cancelled');
    assert.equal(reopenedController.getJob(failed.id).status, 'failed');
    reopenedController.close();
    reopenedController = null;
  } finally {
    reopenedController?.close();
    failedController?.close();
    cancellationController?.close();
    resumedController?.close();
    interruptedController?.close();
    repository?.close();
    migrationRepository?.close();
    await Promise.all([
      fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      fs.rm(migrationProjectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ]);
  }
};

const runDerivativeJobChecks = async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-derivative-'));
  const migrationProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-derivative-v1-'));
  let repository;
  let migrationRepository;
  let previewController;
  let cappedController;
  let closingController;
  let resumedController;
  let reopenedController;
  try {
    const workerSource = await fs.readFile(path.join(__dirname, '../workers/assetPreviewWorker.cjs'), 'utf8');
    const preloadSource = await fs.readFile(path.join(__dirname, '../preload.cjs'), 'utf8');
    assert.doesNotMatch(workerSource, /node:sqlite|ProjectRepository|require\('node:fs/);
    assert.match(preloadSource, /requestPreview: assetId => ipcRenderer\.invoke/);
    assert.match(preloadSource, /getPreviewJob: jobId => ipcRenderer\.invoke/);
    assert.match(preloadSource, /cancelPreviewJob: jobId => ipcRenderer\.invoke/);
    assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*ipcRenderer/);

    // Both R4 v1 and R6 v2 databases migrate in-place to the R8 job-journal schema.
    migrationRepository = await ProjectRepository.open(migrationProjectRoot);
    migrationRepository.close();
    migrationRepository = null;
    const migrationDatabase = new DatabaseSync(path.join(migrationProjectRoot, '.artflow', 'metadata.sqlite'));
    migrationDatabase.exec("DROP TABLE derivative_job_metadata; UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';");
    migrationDatabase.close();
    migrationRepository = await ProjectRepository.open(migrationProjectRoot);
    assert.deepEqual(migrationRepository.listDerivativeJobs(), []);
    migrationRepository.close();
    migrationRepository = null;
    const v1Database = new DatabaseSync(path.join(migrationProjectRoot, '.artflow', 'metadata.sqlite'));
    v1Database.exec("DROP TABLE derivative_job_metadata; DROP TABLE derivative_metadata; UPDATE schema_meta SET value = '1' WHERE key = 'schema_version';");
    v1Database.close();
    migrationRepository = await ProjectRepository.open(migrationProjectRoot);
    assert.equal(migrationRepository.getDerivative('missing-asset', PREVIEW_RECIPE), null);
    assert.deepEqual(migrationRepository.listDerivativeJobs(), []);
    migrationRepository.close();
    migrationRepository = null;

    repository = await ProjectRepository.open(projectRoot);
    const stored = await repository.putAsset({
      asset: {
        id: 'derivative-source',
        kind: 'file',
        sourceKind: 'legacy-inline',
        locator: { fileRef: 'data:application/octet-stream;base64,fixture', mimeType: 'application/octet-stream', extension: 'bin' },
        metadata: {},
      },
      bytes: Buffer.alloc(512 * 1024, 7),
      originalName: 'source.bin',
    });
    previewController = new AssetDerivativeController({ repository, maxInputBytes: 1024 * 1024 });
    const runningJob = previewController.requestPreview('derivative-source');
    const queuedJob = previewController.requestPreview('derivative-source');
    assert.equal(previewController.cancelJob(queuedJob.id).status, 'cancelled');
    const completed = await waitForPreviewJob(previewController, runningJob.id);
    const cancelled = await waitForPreviewJob(previewController, queuedJob.id);
    assert.equal(completed.status, 'completed');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(completed.derivative.mimeType, 'image/svg+xml');

    // The controller transitions to running before async original-byte read; cancellation must also work there.
    const runningCancellation = previewController.requestPreview('derivative-source');
    assert.equal(previewController.getJob(runningCancellation.id).status, 'running');
    assert.equal(previewController.cancelJob(runningCancellation.id).status, 'running');
    assert.equal((await waitForPreviewJob(previewController, runningCancellation.id)).status, 'cancelled');

    const repeated = await waitForPreviewJob(previewController, previewController.requestPreview('derivative-source').id);
    assert.equal(repeated.status, 'completed');
    assert.equal(repeated.derivative.contentHash, completed.derivative.contentHash);
    assert.equal(repeated.derivative.blobCreated, false);
    const derivative = repository.getDerivative('derivative-source', PREVIEW_RECIPE);
    assert.equal(derivative.contentHash, completed.derivative.contentHash);
    assert.match((await repository.readDerivative('derivative-source', PREVIEW_RECIPE)).toString('utf8'), /<svg/);

    cappedController = new AssetDerivativeController({ repository, maxInputBytes: 64 });
    const cappedJob = cappedController.requestPreview('derivative-source');
    const failed = await waitForPreviewJob(cappedController, cappedJob.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'STORAGE_ERROR');

    // Closing a scheduler is interruption, not cancellation; queued and stale-running intent survive a repository reopen.
    const durableJobId = crypto.randomUUID();
    const queuedDurableJobId = crypto.randomUUID();
    repository.createDerivativeJob({ id: durableJobId, assetId: 'derivative-source', recipe: PREVIEW_RECIPE });
    repository.createDerivativeJob({ id: queuedDurableJobId, assetId: 'derivative-source', recipe: PREVIEW_RECIPE });
    closingController = new AssetDerivativeController({ repository, maxInputBytes: 1024 * 1024 });
    closingController.restore();
    assert.ok(['queued', 'running'].includes(repository.getDerivativeJob(durableJobId).status));
    assert.equal(repository.getDerivativeJob(queuedDurableJobId).status, 'queued');
    closingController.close();
    closingController = null;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.notEqual(repository.getDerivativeJob(durableJobId).status, 'cancelled');
    repository.close();
    repository = await ProjectRepository.open(projectRoot);
    const recoveredJobs = repository.recoverDerivativeJobs();
    assert.equal(recoveredJobs.find(job => job.id === durableJobId).status, 'queued');
    assert.equal(recoveredJobs.find(job => job.id === queuedDurableJobId).status, 'queued');
    assert.deepEqual(
      recoveredJobs.filter(job => job.id === durableJobId || job.id === queuedDurableJobId).map(job => job.id),
      [durableJobId, queuedDurableJobId],
    );
    resumedController = new AssetDerivativeController({ repository, maxInputBytes: 1024 * 1024 });
    resumedController.restore();
    const durableCompleted = await waitForPreviewJob(resumedController, durableJobId);
    const queuedDurableCompleted = await waitForPreviewJob(resumedController, queuedDurableJobId);
    assert.equal(durableCompleted.status, 'completed');
    assert.equal(queuedDurableCompleted.status, 'completed');
    assert.equal(repository.getDerivativeJob(durableJobId).status, 'completed');

    previewController.close();
    previewController = null;
    cappedController.close();
    cappedController = null;
    resumedController.close();
    resumedController = null;
    repository.close();
    repository = await ProjectRepository.open(projectRoot);
    assert.equal(repository.getDerivativeJob(durableJobId).status, 'completed');
    assert.equal(repository.getDerivativeJob(queuedDurableJobId).status, 'completed');
    assert.equal(repository.getDerivativeJob(queuedJob.id).status, 'cancelled');
    assert.equal(repository.getDerivativeJob(cappedJob.id).status, 'failed');
    reopenedController = new AssetDerivativeController({ repository, maxInputBytes: 1024 * 1024 });
    assert.equal(reopenedController.getJob(durableJobId).status, 'completed');
    assert.equal(reopenedController.getJob(queuedDurableJobId).status, 'completed');
    assert.equal(reopenedController.getJob(queuedJob.id).status, 'cancelled');
    assert.equal(reopenedController.getJob(cappedJob.id).status, 'failed');
    reopenedController.close();
    reopenedController = null;
    assert.match((await repository.readDerivative('derivative-source', PREVIEW_RECIPE)).toString('utf8'), /preview-card-v1|FILE/);
    assert.equal(repository.getDerivative('derivative-source', PREVIEW_RECIPE).mimeType, 'image/svg+xml');
    assert.ok(stored.contentHash);
  } finally {
    reopenedController?.close();
    resumedController?.close();
    closingController?.close();
    cappedController?.close();
    previewController?.close();
    repository?.close();
    migrationRepository?.close();
    await Promise.all([
      fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      fs.rm(migrationProjectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ]);
  }
};


const runAutoSyncChecks = async () => {
  const {
    formatSessionPayload,
    parseSessionPayload,
  } = require('../utils/projectAutoSync.ts');

  // 1. Session serialization
  const payload = formatSessionPayload('/path/to/project');
  assert.equal(parseSessionPayload(payload), '/path/to/project');
  assert.equal(parseSessionPayload('invalid json'), null);
  assert.equal(parseSessionPayload('{}'), null);
  assert.equal(parseSessionPayload(JSON.stringify({ lastProjectRoot: '   ' })), null);

  // 3. ProjectStorageController session persistence
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-session-'));
  const sessionFilePath = path.join(tmpDir, 'test-session.json');
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-proj-'));

  let controller1 = new ProjectStorageController({ sessionFilePath });
  try {
    assert.equal(await controller1.readPersistedSession(), null);
    assert.equal(await controller1.restoreLastSession(), null);

    await controller1.openProject(projectRoot);
    assert.equal(controller1.status().isOpen, true);
    assert.equal(controller1.status().projectName, path.basename(projectRoot));

    const sessionOnDisk = JSON.parse(await fs.readFile(sessionFilePath, 'utf8'));
    assert.equal(sessionOnDisk.lastProjectRoot, projectRoot);

    controller1.close();
    controller1 = null;

    // Second controller simulates application restart
    let controller2 = new ProjectStorageController({ sessionFilePath });
    assert.equal(controller2.status().isOpen, false);
    const restored = await controller2.restoreLastSession();
    assert.ok(restored);
    assert.equal(restored.isOpen, true);
    assert.equal(restored.projectName, path.basename(projectRoot));
    assert.equal(controller2.status().isOpen, true);

    await controller2.clearPersistedSession();
    assert.equal(await controller2.readPersistedSession(), null);
    controller2.close();
    controller2 = null;
  } finally {
    controller1?.close();
    await Promise.all([
      fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ]);
  }

  // 4. Source wiring assertion
  const appSource = await fs.readFile(path.join(__dirname, '../App.tsx'), 'utf8');
  const fileSystemSource = await fs.readFile(path.join(__dirname, '../hooks/useFileSystem.ts'), 'utf8');
  const mainSource = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');

  assert.match(fileSystemSource, /restoreStartupProject/);
  assert.match(appSource, /restoreStartupProject/);
  assert.match(appSource, /attemptStartupRecovery/);
  assert.match(mainSource, /sessionFilePath/);
  assert.match(mainSource, /restoreLastSession/);

  // 5. Manual-save contract: no auto-save may remain; window close must be
  //    gated by the unsaved-changes confirm modal instead of a silent flush.
  assert.doesNotMatch(appSource, /canScheduleAutoSave|AUTOSAVE_DEBOUNCE_MS|Autosaving/);
  assert.match(appSource, /forceCloseRef/);
  assert.match(appSource, /isCloseConfirmOpen/);
  assert.match(appSource, /handleSaveAndClose/);
  assert.match(appSource, /handleDiscardAndClose/);
  assert.match(appSource, /buildClosingSnapshot/);
  assert.match(appSource, /addEventListener\('beforeunload', handleBeforeUnload\)/);
  // 关闭拦截必须保留“瞬时相机补快照”的语义（保存并关闭不得丢最后一次 pan/zoom）。
  assert.match(appSource, /canvasViewportStore\.isTransient\(\)/);
};

const runImageLODChecks = async () => {
  const {
    IMAGE_LOD_CONSTANTS,
    computeScaledDimensions,
    resolveImageLODSource,
    ImageLRUCache,
    globalImageLRUCache,
  } = require('../utils/imageProxy.ts');

  // 1. Constants
  assert.equal(IMAGE_LOD_CONSTANTS.THUMBNAIL_MAX_DIMENSION, 256);
  assert.equal(IMAGE_LOD_CONSTANTS.STANDARD_PROXY_MAX_DIMENSION, 1024);
  assert.equal(IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY, 50);
  assert.equal(IMAGE_LOD_CONSTANTS.FAR_ZOOM_THRESHOLD, 0.25);
  assert.equal(IMAGE_LOD_CONSTANTS.DETAIL_ZOOM_THRESHOLD, 1.0);

  // 2. computeScaledDimensions
  const scaledLarge = computeScaledDimensions(4000, 3000, 1024);
  assert.equal(scaledLarge.width, 1024);
  assert.equal(scaledLarge.height, 768);
  assert.equal(scaledLarge.scaled, true);

  const scaledThumb = computeScaledDimensions(4000, 3000, 256);
  assert.equal(scaledThumb.width, 256);
  assert.equal(scaledThumb.height, 192);
  assert.equal(scaledThumb.scaled, true);

  const scaledSmall = computeScaledDimensions(800, 600, 1024);
  assert.equal(scaledSmall.width, 800);
  assert.equal(scaledSmall.height, 600);
  assert.equal(scaledSmall.scaled, false);

  // 3. resolveImageLODSource
  // Far zoom (< 0.25): uses thumbnailHref if available
  const farWithThumb = resolveImageLODSource({
    zoom: 0.15,
    href: 'http://example.com/proxy1024.jpg',
    thumbnailHref: 'http://example.com/thumb256.jpg',
    originalHref: 'http://example.com/orig.jpg',
  });
  assert.equal(farWithThumb.tier, 'thumbnail');
  assert.equal(farWithThumb.src, 'http://example.com/thumb256.jpg');

  // Far zoom (< 0.25): falls back to href if thumbnailHref missing
  const farWithoutThumb = resolveImageLODSource({
    zoom: 0.15,
    href: 'http://example.com/proxy1024.jpg',
  });
  assert.equal(farWithoutThumb.tier, 'standard');
  assert.equal(farWithoutThumb.src, 'http://example.com/proxy1024.jpg');

  // Standard zoom (0.25 <= zoom <= 1.0): uses standard proxy
  const standardZoom = resolveImageLODSource({
    zoom: 0.75,
    href: 'http://example.com/proxy1024.jpg',
    thumbnailHref: 'http://example.com/thumb256.jpg',
    originalHref: 'http://example.com/orig.jpg',
  });
  assert.equal(standardZoom.tier, 'standard');
  assert.equal(standardZoom.src, 'http://example.com/proxy1024.jpg');

  // Interaction override: locks to standard proxy even at zoom > 1.0
  const interactingZoom = resolveImageLODSource({
    zoom: 2.5,
    isInteracting: true,
    href: 'http://example.com/proxy1024.jpg',
    thumbnailHref: 'http://example.com/thumb256.jpg',
    originalHref: 'http://example.com/orig.jpg',
    isHighResAdmitted: true,
  });
  assert.equal(interactingZoom.tier, 'standard');
  assert.equal(interactingZoom.src, 'http://example.com/proxy1024.jpg');

  // Detail zoom (> 1.0) static + LRU admitted: uses originalHref
  const detailAdmitted = resolveImageLODSource({
    zoom: 1.5,
    isInteracting: false,
    href: 'http://example.com/proxy1024.jpg',
    originalHref: 'http://example.com/orig.jpg',
    isHighResAdmitted: true,
  });
  assert.equal(detailAdmitted.tier, 'original');
  assert.equal(detailAdmitted.src, 'http://example.com/orig.jpg');

  // Detail zoom (> 1.0) static but LRU evicted: downgrades to standard proxy
  const detailEvicted = resolveImageLODSource({
    zoom: 1.5,
    isInteracting: false,
    href: 'http://example.com/proxy1024.jpg',
    originalHref: 'http://example.com/orig.jpg',
    isHighResAdmitted: false,
  });
  assert.equal(detailEvicted.tier, 'standard');
  assert.equal(detailEvicted.src, 'http://example.com/proxy1024.jpg');

  // 4. ImageLRUCache Behavior
  const testCache = new ImageLRUCache(3);
  assert.equal(testCache.getCapacity(), 3);
  assert.equal(testCache.size(), 0);

  let lastEvicted = null;
  const unsub = testCache.subscribe(evictedId => {
    lastEvicted = evictedId;
  });

  testCache.request('imgA');
  testCache.request('imgB');
  testCache.request('imgC');
  assert.equal(testCache.size(), 3);
  assert.ok(testCache.has('imgA'));
  assert.ok(testCache.has('imgB'));
  assert.ok(testCache.has('imgC'));
  assert.equal(lastEvicted, null);

  // Touching imgA marks it as most recently used
  testCache.request('imgA');

  // Adding imgD exceeds capacity (3), should evict imgB (the oldest!)
  testCache.request('imgD');
  assert.equal(testCache.size(), 3);
  assert.equal(lastEvicted, 'imgB');
  assert.equal(testCache.has('imgB'), false);
  assert.ok(testCache.has('imgA'));
  assert.ok(testCache.has('imgC'));
  assert.ok(testCache.has('imgD'));

  // Release imgC
  testCache.release('imgC');
  assert.equal(testCache.size(), 2);
  assert.equal(testCache.has('imgC'), false);
  unsub();

  // Test default capacity
  assert.equal(globalImageLRUCache.getCapacity(), 50);

  // 5. Document v2 serialization roundtrip with thumbnailHref
  const lodImageElement = {
    id: 'lod-test-image',
    type: 'image',
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    href: 'data:image/jpeg;base64,proxy1024',
    thumbnailHref: 'data:image/jpeg;base64,thumb256',
    originalHref: 'data:image/png;base64,origFull',
    mimeType: 'image/png',
  };
  const lodTestBoard = {
    id: 'board-lod-test',
    name: 'LOD Test',
    elements: [lodImageElement],
    panOffset: { x: 0, y: 0 },
    zoom: 1,
    canvasBackgroundColor: '#111827',
  };
  const doc = serializeProjectDocument([lodTestBoard]);
  const imageNode = doc.nodes.find(n => n.id === 'lod-test-image');
  assert.ok(imageNode);
  assert.ok(imageNode.assetId);
  assert.equal('thumbnailHref' in imageNode.properties, false);
  assert.equal('href' in imageNode.properties, false);
  assert.equal('originalHref' in imageNode.properties, false);

  const imageAsset = doc.assets.find(a => a.id === imageNode.assetId);
  assert.ok(imageAsset);
  assert.equal(imageAsset.locator.previewRef, 'data:image/jpeg;base64,proxy1024');
  assert.equal(imageAsset.locator.thumbnailRef, 'data:image/jpeg;base64,thumb256');
  assert.equal(imageAsset.locator.originalRef, 'data:image/png;base64,origFull');

  const rehydrated = deserializeProjectDocument(doc);
  const rehydratedImg = rehydrated[0].elements.find(e => e.id === 'lod-test-image');
  assert.ok(rehydratedImg);
  assert.equal(rehydratedImg.href, 'data:image/jpeg;base64,proxy1024');
  assert.equal(rehydratedImg.thumbnailHref, 'data:image/jpeg;base64,thumb256');
  assert.equal(rehydratedImg.originalHref, 'data:image/png;base64,origFull');

  // 6. Source wiring checks
  const canvasElementSource = await fs.readFile(path.join(__dirname, '../components/CanvasElement.tsx'), 'utf8');
  assert.match(canvasElementSource, /useImageLOD/);
  assert.match(canvasElementSource, /data-lod-tier/);
  assert.match(canvasElementSource, /ImageCanvasElement/);
};

const runAIProviderChecks = async () => {
  const { createKernel } = require('../plugin-runtime/kernel.ts');
  const { loadBuiltinPlugin } = require('../plugin-runtime/loader.ts');
  const {
    listAIProviderContributions,
    resolveAIProvider,
    filterAIProvidersByCapability,
    invokeAIProvider,
  } = require('../plugin-runtime/ai-providers.ts');
  const {
    listAssetSourceContributions,
    resolveAssetSource,
    validateNamespaceMetadata,
  } = require('../plugin-runtime/asset-sources.ts');
  const {
    listNodeActionContributions,
    getApplicableNodeActions,
  } = require('../plugin-runtime/node-actions.ts');
  const { projectRegistryAsAgentTools } = require('../plugin-runtime/agent-orchestration.ts');
  const {
    aiProvidersPlugin,
    createAiProvidersPlugin,
    COMFY_PROVIDER_ID,
    COMFY_ASSET_SOURCE_ID,
    GEMINI_PROVIDER_ID,
  } = require('../builtin-plugins/ai-providers/index.ts');
  const {
    buildMattingWorkflow,
    createComfyClient,
    parseHistoryImages,
    parseHistoryState,
    stripDataUrlPrefix,
  } = require('../builtin-plugins/ai-providers/comfy-client.ts');
  const {
    extractImageFromResponse,
    extractTextFromResponse,
    dataUrlToPart,
    buildEditParts,
  } = require('../builtin-plugins/ai-providers/gemini-client.ts');

  const kernel = createKernel();

  // 1. Builtin AI Provider Plugin Activation & Slot Populating
  // 通道二换成真实现后，自检必须离线安全：注入 fake transport，不依赖本机 ComfyUI 是否在跑。
  const transportCalls = [];
  const fakeTransport = async request => {
    transportCalls.push(request);
    switch (request.op) {
      case 'stats':
        return { ok: true, status: 200, data: { devices: [{ name: 'Fixture GPU', vram_free: 4096 }] } };
      case 'submit':
        return { ok: true, status: 200, data: { prompt_id: 'fixture-prompt' } };
      case 'history':
        return { ok: true, status: 200, data: { 'fixture-prompt': {
          status: { completed: true, status_str: 'success', messages: [] },
          outputs: { '3': { images: [{ filename: 'out.png', subfolder: 'artflow', type: 'output' }] } },
        } } };
      case 'view':
        return { ok: true, status: 200, contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]).buffer };
      default:
        return { ok: false, message: 'unexpected op: ' + request.op };
    }
  };

  // 通道一的 Gemini 也换成真实现后，自检同样必须离线安全：注入 fake transport + fixture key。
  const geminiCalls = [];
  const fakeGeminiTransport = {
    async generateImages(input) {
      geminiCalls.push({ op: 'generateImages', ...input });
      return Array.from({ length: input.numberOfImages }, () => ({
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA==',
        mimeType: 'image/png',
      }));
    },
    async editImage(input) {
      geminiCalls.push({ op: 'editImage', ...input });
      return { image: { base64: 'RURJVEVE', mimeType: 'image/png' } };
    },
    async describeImage(input) {
      geminiCalls.push({ op: 'describeImage', ...input });
      return 'A neon cyberpunk banana on a reflective surface';
    },
    async generateVideo(input) {
      geminiCalls.push({ op: 'generateVideo', ...input });
      input.onProgress('fake video progress');
      return [{ base64: 'VklERU8=', mimeType: 'video/mp4' }];
    },
  };

  const loadedPlugin = loadBuiltinPlugin(kernel, createAiProvidersPlugin({
    comfyTransport: fakeTransport,
    geminiTransport: fakeGeminiTransport,
    getGeminiApiKey: () => 'fixture-gemini-key',
  }));
  assert.equal(loadedPlugin.manifest.id, 'builtin.ai-providers');
  // 生产形态的插件对象也要在（transport 走主进程桥）。
  assert.ok(aiProvidersPlugin.manifest && typeof aiProvidersPlugin.activate === 'function');

  // 2. Outbound AI Provider Checks (Channel 1) —— 真实现，断言走注入的 fake transport。
  const providers = listAIProviderContributions(kernel);
  assert.equal(providers.length, 2);
  assert.equal(resolveAIProvider(kernel, GEMINI_PROVIDER_ID).value.providerType, 'cloud');
  assert.equal(resolveAIProvider(kernel, COMFY_PROVIDER_ID).value.providerType, 'local');

  const resolved = resolveAIProvider(kernel, GEMINI_PROVIDER_ID);
  assert.ok(resolved);
  assert.equal(resolved.id, GEMINI_PROVIDER_ID);

  const t2iProviders = filterAIProvidersByCapability(kernel, 'text-to-image');
  assert.equal(t2iProviders.length, 1);
  assert.equal(t2iProviders[0].id, GEMINI_PROVIDER_ID);
  // 视频能力现在由云端 Gemini provider 声明（Veo）。
  const videoProviders = filterAIProvidersByCapability(kernel, 'video');
  assert.equal(videoProviders.length, 1);
  assert.equal(videoProviders[0].id, GEMINI_PROVIDER_ID);

  // 抠图能力只由本机 ComfyUI provider 声明（抠图插件据此判断按钮可用性）。
  const mattingProviders = filterAIProvidersByCapability(kernel, 'image-matting');
  assert.equal(mattingProviders.length, 1);
  assert.equal(mattingProviders[0].id, COMFY_PROVIDER_ID);

  // Health check：配置了 key 才 available（自检注入 fixture key）。
  const health = await resolved.value.checkHealth();
  assert.equal(health.available, true);

  // 文生图：op=text-to-image → transport.generateImages（不再返回占位 SVG）。
  const imgResp = await invokeAIProvider(kernel, GEMINI_PROVIDER_ID, {
    prompt: 'cyberpunk banana',
    parameters: { op: 'text-to-image', aspectRatio: '16:9', numberOfImages: 2 },
  });
  assert.equal(imgResp.ok, true);
  assert.equal(imgResp.artifacts.length, 2);
  assert.equal(imgResp.artifacts[0].kind, 'image');
  assert.ok(imgResp.artifacts[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(imgResp.artifacts[0].metadata.model, 'imagen-4.0-generate-001');
  assert.ok(typeof imgResp.durationMs === 'number');
  assert.equal(geminiCalls.at(-1).op, 'generateImages');
  assert.equal(geminiCalls.at(-1).numberOfImages, 2);
  assert.equal(geminiCalls.at(-1).aspectRatio, '16:9');

  // 图生图：带参考图 → transport.editImage。
  const editResp = await invokeAIProvider(kernel, GEMINI_PROVIDER_ID, {
    prompt: 'make it snowy',
    referenceImages: ['data:image/png;base64,AAAA'],
    parameters: { op: 'image-to-image' },
  });
  assert.equal(editResp.ok, true);
  assert.equal(editResp.artifacts[0].kind, 'image');
  assert.equal(editResp.artifacts[0].metadata.model, 'gemini-2.5-flash-image');
  assert.equal(geminiCalls.at(-1).op, 'editImage');
  assert.equal(geminiCalls.at(-1).images.length, 1);

  // 抠图重绘：mask 必须透传到 editImage（否则会被当成普通编辑）。
  const inpaintResp = await invokeAIProvider(kernel, GEMINI_PROVIDER_ID, {
    prompt: 'fill the hole',
    referenceImages: ['data:image/png;base64,AAAA'],
    parameters: { op: 'inpainting', mask: 'data:image/png;base64,TUFTS' },
  });
  assert.equal(inpaintResp.ok, true);
  assert.ok(geminiCalls.at(-1).mask && geminiCalls.at(-1).mask.href === 'data:image/png;base64,TUFTS');

  // 提示词增强：图 → 文本。
  const textResp = await invokeAIProvider(kernel, GEMINI_PROVIDER_ID, {
    prompt: 'describe this',
    referenceImages: ['data:image/png;base64,AAAA'],
    parameters: { op: 'prompt-enhancement' },
  });
  assert.equal(textResp.ok, true);
  assert.equal(textResp.artifacts[0].kind, 'text');
  assert.match(textResp.artifacts[0].content, /neon cyberpunk banana/);
  assert.equal(geminiCalls.at(-1).op, 'describeImage');

  // 视频：op=video → transport.generateVideo；进度回调被触发。
  const progress = [];
  const videoResp = await invokeAIProvider(kernel, GEMINI_PROVIDER_ID, {
    prompt: 'a flying cat',
    parameters: { op: 'video', aspectRatio: '9:16', numberOfVideos: 1 },
    onProgress: message => progress.push(message),
  });
  assert.equal(videoResp.ok, true);
  assert.equal(videoResp.artifacts[0].kind, 'video');
  assert.ok(videoResp.artifacts[0].dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(videoResp.artifacts[0].metadata.model, 'veo-2.0-generate-001');
  assert.ok(progress.length > 0);
  assert.equal(geminiCalls.at(-1).op, 'generateVideo');

  // 未配置 key 时优雅失败（ok:false + 可读提示），而不是抛异常。
  const noKeyKernel = createKernel();
  const loadedNoKey = loadBuiltinPlugin(noKeyKernel, createAiProvidersPlugin({
    geminiTransport: fakeGeminiTransport,
    getGeminiApiKey: () => null,
  }));
  const noKeyResp = await invokeAIProvider(noKeyKernel, GEMINI_PROVIDER_ID, { prompt: 'x' });
  assert.equal(noKeyResp.ok, false);
  assert.match(noKeyResp.error, /API Key/);
  loadedNoKey.dispose();

  // Gemini 结果解析纯函数（防止响应口径回归）。
  assert.deepEqual(
    extractImageFromResponse({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAA', mimeType: 'image/png' } }] } }] }),
    { base64: 'AAA', mimeType: 'image/png' },
  );
  assert.equal(extractImageFromResponse({ candidates: [] }), undefined);
  assert.equal(extractTextFromResponse({ text: 'hello' }), 'hello');
  assert.equal(dataUrlToPart('data:image/png;base64,ZZZ', 'image/png').inlineData.data, 'ZZZ');
  assert.equal(buildEditParts({ images: [{ href: 'data:image/png;base64,A', mimeType: 'image/png' }], prompt: 'p' }).length, 2);

  // Missing provider invocation handling
  const missingResp = await invokeAIProvider(kernel, 'nonexistent.provider', { prompt: 'test' });
  assert.equal(missingResp.ok, false);
  assert.match(missingResp.error, /not found/);

  // —— 通道二的抠图链路（工作流构造/解析是纯函数，直接断言，防止退回假占位）——
  const workflow = buildMattingWorkflow('AAAA', 'BiRefNet-portrait');
  assert.equal(workflow['1'].class_type, 'ETN_LoadImageBase64');
  assert.equal(workflow['2'].class_type, 'BiRefNetRMBG');
  assert.equal(workflow['2'].inputs.model, 'BiRefNet-portrait');
  assert.deepEqual(workflow['2'].inputs.image, ['1', 0]);
  assert.equal(workflow['2'].inputs.background, 'Alpha');
  assert.equal(workflow['3'].class_type, 'SaveImage');
  assert.deepEqual(workflow['3'].inputs.images, ['2', 0]);
  // 免上传：ETN_LoadImageBase64 只吃裸 base64，data URL 前缀必须先进工作流前剥掉。
  assert.equal(stripDataUrlPrefix('data:image/png;base64,ZZZ'), 'ZZZ');
  assert.equal(stripDataUrlPrefix('ZZZ'), 'ZZZ');

  // 历史条目还没出现 = pending；条目已创建但没状态 = 正在跑。
  assert.equal(parseHistoryState(null), 'pending');
  assert.equal(parseHistoryState(undefined), 'pending');
  assert.equal(parseHistoryState({}), 'running');
  assert.equal(parseHistoryState({ status: { completed: true } }), 'completed');
  assert.equal(parseHistoryState({ status: { status_str: 'error' } }), 'error');
  assert.deepEqual(
    parseHistoryImages({ outputs: { '3': { images: [{ filename: 'a.png', subfolder: 'x', type: 'output' }] } } }),
    [{ filename: 'a.png', subfolder: 'x', type: 'output' }],
  );
  assert.deepEqual(parseHistoryImages({ outputs: {} }), []);

  const mattingResp = await invokeAIProvider(kernel, COMFY_PROVIDER_ID, {
    prompt: 'matting',
    referenceImages: ['data:image/jpeg;base64,AAAA'],
  });
  assert.equal(mattingResp.ok, true);
  assert.equal(mattingResp.artifacts[0].mimeType, 'image/png');
  assert.ok(mattingResp.artifacts[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(mattingResp.artifacts[0].metadata['comfyui.model'], 'BiRefNet_lite');
  assert.equal(mattingResp.artifacts[0].metadata['comfyui.node'], 'BiRefNetRMBG');
  assert.equal(mattingResp.artifacts[0].metadata['comfyui.promptId'], 'fixture-prompt');
  // 提交 → 轮询 → 取图，三步一步都不能少。
  assert.deepEqual(transportCalls.map(call => call.op), ['submit', 'history', 'view']);

  // 缺原图必须在调用方失败，而不是拿空图去打 ComfyUI。
  const mattingWithoutImage = await invokeAIProvider(kernel, COMFY_PROVIDER_ID, { prompt: 'matting' });
  assert.equal(mattingWithoutImage.ok, false);
  assert.match(mattingWithoutImage.error, /referenceImages/);

  // 离线降级：没有主进程桥时探测返回 offline 且不抛异常（浏览器模式 / ComfyUI 未启动）。
  const offlineClient = createComfyClient(async () => ({ ok: false, message: 'AI 抠图需要在桌面端运行' }));
  const offlineProbe = await offlineClient.probeStatus();
  assert.equal(offlineProbe.online, false);
  assert.match(offlineProbe.message, /桌面端/);

  // 3. Asset Sources Checks (Channel 2)
  const sources = listAssetSourceContributions(kernel);
  assert.equal(sources.length, 1);
  const comfySource = resolveAssetSource(kernel, COMFY_ASSET_SOURCE_ID);
  assert.ok(comfySource);
  assert.equal(comfySource.value.endpoint, 'http://127.0.0.1:8188');
  assert.equal(comfySource.value.namespacePrefix, 'comfyui.');

  // Probe status：设备信息来自真实 /system_stats，不再是硬编码假数据。
  const probe = await comfySource.value.probeStatus();
  assert.equal(probe.online, true);
  assert.equal(probe.device, 'Fixture GPU');
  assert.equal(probe.vramFree, 4096);

  // Submit workflow & validate namespace metadata
  const workflowResult = await comfySource.value.submitWorkflow({ prompt: 'surreal dreamscape', inputImages: ['data:image/png;base64,AAAA'] });
  assert.ok(workflowResult.assetDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(workflowResult.mimeType, 'image/png');
  assert.equal(workflowResult.metadata['comfyui.prompt'], 'surreal dreamscape');
  assert.equal(workflowResult.metadata['comfyui.workflowId'], 'matting-birefnet');
  assert.equal(validateNamespaceMetadata('comfyui.', workflowResult.metadata), true);
  assert.equal(validateNamespaceMetadata('comfyui.', { 'unprefixedKey': 1 }), false);

  // 缺原图必须显式抛错，而不是静默产出占位图。
  await assert.rejects(() => comfySource.value.submitWorkflow({ prompt: 'no image' }), /inputImages/);

  // 4. Node Action Context Checks
  const nodeActions = listNodeActionContributions(kernel);
  assert.equal(nodeActions.length, 1);
  assert.equal(nodeActions[0].id, 'image.ai-repaint');

  const imgActions = getApplicableNodeActions(kernel, {
    element: { id: 'img-1', type: 'image' },
    selectedElements: [],
    allElements: [],
  });
  assert.equal(imgActions.length, 1);

  const audioActions = getApplicableNodeActions(kernel, {
    element: { id: 'audio-1', type: 'audio' },
    selectedElements: [],
    allElements: [],
  });
  assert.equal(audioActions.length, 0);

  // 5. AI Orchestration & Tool Projection (Channel 3)
  const tools = projectRegistryAsAgentTools(kernel);
  assert.ok(tools.length >= 3);

  const aiTool = tools.find(t => t.name === 'ai_gemini_image_generator');
  assert.ok(aiTool);
  assert.equal(aiTool.parameters.required.includes('prompt'), true);

  const toolExecResult = await aiTool.handler({ prompt: 'futuristic city' }, kernel);
  assert.equal(toolExecResult.ok, true);
  assert.equal(toolExecResult.artifacts[0].kind, 'image');

  const probeTool = tools.find(t => t.name === 'source_comfyui_local_engine_probe');
  assert.ok(probeTool);
  const probeResult = await probeTool.handler({}, kernel);
  assert.equal(probeResult.online, true);

  // 6. Clean Plugin Disposer Reversal
  loadedPlugin.dispose();
  assert.equal(listAIProviderContributions(kernel).length, 0);
  assert.equal(listAssetSourceContributions(kernel).length, 0);
  assert.equal(listNodeActionContributions(kernel).length, 0);
};

/**
 * i18n 契约检查（L1-L3 的防回归面）。
 *
 * 这一层此前没有任何断言覆盖：契约从「纯 string」放宽到「string | (language) => string」、
 * manifest 新增 nameI18n/descriptionI18n、translations 表承载全部本体文案 —— 任何一处回退
 * 都会让界面在某一档下漏出 key 原文或退回英文，而这在 typecheck 里查不出来。
 */
const runI18nChecks = async () => {
  const { bi, resolveLocalizedText, resolveManifestText, resolveLocaleTable } = require('../plugin-runtime/i18n.ts');
  const { resolveCommandText } = require('../plugin-runtime/commands.ts');
  const { validateManifest, resolvePluginName, resolvePluginDescription } = require('../plugin-runtime/manifest.ts');
  const { createKernel } = require('../plugin-runtime/kernel.ts');
  const { listLocaleContributions } = require('../plugin-runtime/locale-contributions.ts');
  const { translations } = require('../translations.ts');

  // 1. bi() 两档必须真正分开
  assert.equal(bi('撤销', 'Undo')('zho'), '撤销');
  assert.equal(bi('撤销', 'Undo')('en'), 'Undo');

  // 2. resolveLocalizedText 对纯字符串保持兼容（未迁移的老插件不能因此炸掉）
  assert.equal(resolveLocalizedText('Plain legacy title', 'en'), 'Plain legacy title');
  assert.equal(resolveLocalizedText('Plain legacy title', 'zho'), 'Plain legacy title');
  assert.equal(resolveLocalizedText(bi('中文', 'English'), 'en'), 'English');
  assert.equal(resolveLocalizedText(undefined, 'en'), undefined);
  assert.equal(resolveLocalizedText(undefined, 'zho'), undefined);

  // 3. resolveManifestText：命中覆盖用覆盖，未命中/空覆盖回落基准
  assert.equal(resolveManifestText('Base', { en: 'Override' }, 'en'), 'Override');
  assert.equal(resolveManifestText('Base', { en: 'Override' }, 'zho'), 'Base');
  assert.equal(resolveManifestText('Base', undefined, 'en'), 'Base');
  assert.equal(resolveManifestText('Base', { en: '   ' }, 'en'), 'Base');
  assert.equal(resolveManifestText(undefined, undefined, 'en'), '');

  // 4. 命令契约：既接受 LocalizedText，也接受历史遗留的纯字符串
  assert.equal(resolveCommandText({ title: bi('撤销', 'Undo') }, 'zho').title, '撤销');
  assert.equal(resolveCommandText({ title: bi('撤销', 'Undo') }, 'en').title, 'Undo');
  assert.equal(resolveCommandText({ title: 'Legacy command' }, 'en').title, 'Legacy command');

  // 5. 内置 manifest 两档文案必须真正分离（防「只补 nameI18n 却漏 descriptionI18n」这类半残）
  const cjk = /[\u4e00-\u9fff\u3000-\u303f]/;
  const sampleManifest = validateManifest(JSON.parse(await fs.readFile(
    path.join(__dirname, '../builtin-plugins/canvas-toolbars/manifest.json'), 'utf8')));
  assert.equal(resolvePluginName(sampleManifest, 'zho'), '画布工具栏');
  assert.equal(resolvePluginName(sampleManifest, 'en'), 'Canvas Toolbars');
  assert.ok(cjk.test(resolvePluginDescription(sampleManifest, 'zho')));
  assert.ok(!cjk.test(resolvePluginDescription(sampleManifest, 'en')));

  // 6. translations 两档结构必须完全同构：漏配的 key 会在 UI 上直接漏出 key 原文
  const compareKeys = (enNode, zhoNode, trail) => {
    assert.deepEqual(Object.keys(zhoNode).sort(), Object.keys(enNode).sort(), `translations 结构不一致: ${trail}`);
    for (const key of Object.keys(enNode)) {
      const e = enNode[key];
      const z = zhoNode[key];
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
        assert.ok(z !== null && typeof z === 'object' && !Array.isArray(z), `translations.${trail}${key} 在 zho 档缺失`);
        compareKeys(e, z, `${trail}${key}.`);
      }
    }
  };
  compareKeys(translations.en, translations.zho, '');

  // 7. 语言包槽位（locales）：零补丁必须**逐字等于底座** —— 这是 A 档"界面零变化"的回归保证
  assert.deepEqual(resolveLocaleTable(translations.zho, [], 'zho'), translations.zho);
  const localeBase = { importJobs: { title: 'Import Jobs', refresh: 'Refresh' }, common: { save: 'Save' } };
  assert.deepEqual(
    resolveLocaleTable(localeBase, [{ language: 'jpn', table: { importJobs: { title: 'インポート' } } }], 'jpn'),
    { importJobs: { title: 'インポート', refresh: 'Refresh' }, common: { save: 'Save' } },
    '二级键应浅合并：补丁只覆盖 title，refresh 必须保留底座值',
  );
  // 语言码不匹配的补丁不得生效
  assert.deepEqual(resolveLocaleTable(localeBase, [{ language: 'jpn', table: { common: { save: 'X' } } }], 'zho'), localeBase);
  // 坏语言包（table 非法）忽略而非清空整档
  assert.deepEqual(resolveLocaleTable(localeBase, [{ language: 'zho', table: null }], 'zho'), localeBase);

  // 7b. 形状闸：语言包（尤其外部 JSON 通道）不得把底座的函数叶子/对象段互相覆盖坏。
  //     底座 33 条函数叶子带计数插值，JSON 表达不了 —— 放任覆盖会让界面出现
  //     `[object Object]`，或让 t('x', 3) 静默丢掉那个数字。
  const shapeBase = {
    viewBookmarks: { defaultName: n => `View ${n}`, renameLabel: 'Rename' },
    settings: { title: 'Settings' },
  };
  const shapeFn = resolveLocaleTable(
    shapeBase, [{ language: 'jpn', table: { viewBookmarks: { defaultName: { one: 'ビュー' } } } }], 'jpn');
  assert.equal(typeof shapeFn.viewBookmarks.defaultName, 'function', '函数叶子不得被 JSON 对象覆盖');
  assert.equal(shapeFn.viewBookmarks.defaultName(2), 'View 2');
  assert.equal(shapeFn.viewBookmarks.renameLabel, 'Rename', '同段未覆盖的键必须保留');
  assert.equal(
    resolveLocaleTable(shapeBase, [{ language: 'jpn', table: { viewBookmarks: { defaultName: 'ビュー' } } }], 'jpn')
      .viewBookmarks.defaultName(2),
    'View 2',
    '函数叶子也不得被字符串覆盖（否则 t(key, n) 会静默丢掉计数）',
  );
  assert.equal(
    resolveLocaleTable(shapeBase, [{ language: 'jpn', table: { settings: { title: { a: 'x' } } } }], 'jpn').settings.title,
    'Settings',
    '字符串叶子不得被对象覆盖',
  );
  assert.deepEqual(
    resolveLocaleTable(shapeBase, [{ language: 'jpn', table: { settings: 'セッティング' } }], 'jpn').settings,
    { title: 'Settings' },
    '对象段不得被叶子覆盖（整段会查不到而回落成 key 原文）',
  );
  // 形状相符的覆盖与新增仍必须生效
  assert.equal(
    resolveLocaleTable(shapeBase, [{ language: 'jpn', table: { settings: { title: '設定', added: '追加' } } }], 'jpn')
      .settings.title,
    '設定',
  );
  const shapeNew = resolveLocaleTable(shapeBase, [{ language: 'jpn', table: { extra: { note: 'メモ' } } }], 'jpn');
  assert.equal(shapeNew.extra.note, 'メモ', '底座没有的段必须放行');
  assert.equal(shapeNew.settings.title, 'Settings');
  // 补丁对象不得与调用方共享引用（插件复用同一对象时不该污染已合并的表）
  const sharedSegment = { note: 'メモ' };
  assert.notEqual(resolveLocaleTable({}, [{ language: 'jpn', table: { extra: sharedSegment } }], 'jpn').extra, sharedSegment);
  // 数组：整体替换（按下标合并会产生半截列表），形状不符时保留底座
  const arrayBase = { quickPrompts: [{ name: 'A' }, { name: 'B' }] };
  assert.deepEqual(
    resolveLocaleTable(arrayBase, [{ language: 'jpn', table: { quickPrompts: [{ name: 'あ' }] } }], 'jpn').quickPrompts,
    [{ name: 'あ' }],
    '数组应整体替换而非按下标合并',
  );
  assert.deepEqual(
    resolveLocaleTable(arrayBase, [{ language: 'jpn', table: { quickPrompts: 'not-a-list' } }], 'jpn').quickPrompts,
    [{ name: 'A' }, { name: 'B' }],
    '数组不得被叶子覆盖',
  );
  assert.deepEqual(
    resolveLocaleTable({ settings: { title: 'Settings' } }, [{ language: 'jpn', table: { settings: ['x'] } }], 'jpn').settings,
    { title: 'Settings' },
    '对象不得被数组覆盖',
  );

  // 8. locales 槽位端到端：register → list → 合并
  const localeKernel = createKernel();
  localeKernel.contributions.register('locales', {
    id: 'test.locale-pack',
    pluginId: 'test',
    value: { language: 'jpn', table: { importJobs: { title: 'インポート' } } },
  });
  const localeBundles = listLocaleContributions(localeKernel);
  assert.equal(localeBundles.length, 1);
  assert.equal(resolveLocaleTable(localeBase, localeBundles, 'jpn').importJobs.title, 'インポート');

  // 9. validateManifest 必须**幂等** —— 校验器的输出要能被它自己再接受一遍。
  //    resolvePluginProfile 会对已校验过的 manifest 复验（两遍校验），一旦返回值里出现
  //    校验器不认的键，就会「第一遍通过、第二遍自我拒收」，表现为所有 profile 操作集体报
  //    "unknown contribution slot in manifest: locales"（本轮真实事故：加 locales 插槽时
  //    只改了类型与返回值，漏同步 contributes 的键白名单，导致 check-core-foundations:392 回归）。
  const idempotentSamples = [
    manifest('builtin.idem-plain'),
    manifest('builtin.idem-i18n', {
      nameI18n: { en: 'Idempotent' },
      description: '基准描述',
      descriptionI18n: { en: 'Base description' },
    }),
    manifest('builtin.idem-locales', {
      contributes: { locales: [{ language: 'jpn', table: { importJobs: { title: 'インポート' } } }] },
    }),
  ];
  for (const sample of idempotentSamples) {
    const once = validateManifest(sample);
    assert.deepEqual(validateManifest(once), once, `validateManifest 对 ${sample.id} 不幂等（返回值里含校验器不认的键）`);
  }

  // 10. contributes.locales：合法语言包保留文案、非法结构被拒
  const localeManifest = validateManifest(manifest('builtin.locale-pack', {
    contributes: {
      locales: [{ language: 'jpn', table: { importJobs: { title: 'インポート' }, common: { save: '保存' } } }],
    },
  }));
  assert.deepEqual(localeManifest.contributes.locales, [
    { language: 'jpn', table: { importJobs: { title: 'インポート' }, common: { save: '保存' } } },
  ]);
  // 未声明 locales 时也必须是空数组（合并端据此安全遍历）
  assert.deepEqual(validateManifest(manifest('builtin.no-locales')).contributes, { skins: [], locales: [] });
  assert.throws(() => validateManifest(manifest('builtin.dup-locale', {
    contributes: { locales: [{ language: 'jpn', table: {} }, { language: 'jpn', table: {} }] },
  })), /duplicate language/);
  assert.throws(() => validateManifest(manifest('builtin.bad-locale-tag', {
    contributes: { locales: [{ language: 'NOT A TAG', table: {} }] },
  })), /BCP-47/);
  // 函数式文案（复数等）在 JSON 语言包里表达不了 —— 必须拒收而非静默丢进表里
  assert.throws(() => validateManifest(manifest('builtin.bad-locale-body', {
    contributes: { locales: [{ language: 'jpn', table: { count: () => 1 } }] },
  })), /must be a string, an array, or a nested object/);
  // 数组必须放行：quickPrompts 就是 28 条对象数组，挡掉它等于"完整一档"写不出来
  const arrayLocale = validateManifest(manifest('builtin.array-locale', {
    contributes: { locales: [{ language: 'jpn', table: { quickPrompts: [{ name: '図', value: 'turn into a figure' }] } }] },
  }));
  assert.deepEqual(arrayLocale.contributes.locales, [
    { language: 'jpn', table: { quickPrompts: [{ name: '図', value: 'turn into a figure' }] } },
  ]);
  assert.throws(() => validateManifest(manifest('builtin.bad-locale-array', {
    contributes: { locales: [{ language: 'jpn', table: { quickPrompts: [{ name: () => 'x' }] } }] },
  })), /must be a string, an array, or a nested object/);
  // 顶层必须是对象（段表），数组不能当整张表
  assert.throws(() => validateManifest(manifest('builtin.array-root-locale', {
    contributes: { locales: [{ language: 'jpn', table: ['a'] }] },
  })), /contributes\.locales\[0\]\.table must be an object/);
  // 白名单放行 = 只放行已登记的插槽，不是放开任意插槽
  assert.throws(() => validateManifest(manifest('builtin.bad-slot', {
    contributes: { themes: [] },
  })), /unknown contribution slot/);

  // 11. manifest 内联语言包必须真的进槽位（loader.stageLocales 对标 stageSkins）
  const { loadBuiltinPlugin } = require('../plugin-runtime/loader.ts');
  const inlineTable = { importJobs: { title: 'インポート' }, common: { save: '保存' } };
  const inlineLocaleKernel = createKernel();
  loadBuiltinPlugin(inlineLocaleKernel, {
    manifest: manifest('builtin.locale-inline', { contributes: { locales: [{ language: 'jpn', table: inlineTable }] } }),
    activate() {},
  });
  assert.deepEqual(listLocaleContributions(inlineLocaleKernel), [{ language: 'jpn', table: inlineTable }]);
  assert.equal(resolveLocaleTable(localeBase, listLocaleContributions(inlineLocaleKernel), 'jpn').importJobs.title, 'インポート');
  // 未声明 locales 的插件不得污染槽位
  const noLocaleKernel = createKernel();
  loadBuiltinPlugin(noLocaleKernel, { manifest: manifest('builtin.no-locale'), activate() {} });
  assert.deepEqual(listLocaleContributions(noLocaleKernel), []);
  // 两个插件各带一份同语言补丁是常态：不得因 id 撞车而让第二个插件装载失败，且按注册顺序叠加
  const twoPackKernel = createKernel();
  loadBuiltinPlugin(twoPackKernel, {
    manifest: manifest('builtin.locale-a', { contributes: { locales: [{ language: 'jpn', table: { common: { save: '保存A' } } }] } }),
    activate() {},
  });
  loadBuiltinPlugin(twoPackKernel, {
    manifest: manifest('builtin.locale-b', { contributes: { locales: [{ language: 'jpn', table: { common: { cancel: '取消B' } } }] } }),
    activate() {},
  });
  const twoPackBundles = listLocaleContributions(twoPackKernel);
  assert.equal(twoPackBundles.length, 2, '两个插件的同语言补丁必须共存（id 需要按插件前缀下键）');
  const twoPackMerged = resolveLocaleTable({ common: { save: 'Save', cancel: 'Cancel' } }, twoPackBundles, 'jpn');
  assert.equal(twoPackMerged.common.save, '保存A');
  assert.equal(twoPackMerged.common.cancel, '取消B');

  // 12. 补丁层语言的**未覆盖键回落**：底座没有该档时必须回落 en 档，绝不能兜底成 key 原文。
  //     （t() 的 `result || key` 会把 "toolbar.boards" 直接印到界面上 —— 比显示英文糟得多。）
  const { setLocalePatches, translateFor, listAvailableLanguages } = require('../utils/language-store.ts');
  setLocalePatches([{ language: 'jpn', table: { toolbar: { boards: 'ボード' } } }]);
  try {
    assert.ok(listAvailableLanguages().includes('jpn'), '注册了语言包的插件应让该语言出现在设置页切换器里');
    assert.equal(translateFor('jpn', 'toolbar.boards'), 'ボード', '被补丁覆盖的键应取语言包文案');
    const uncovered = translateFor('jpn', 'common.save');
    assert.notEqual(uncovered, 'common.save', '未覆盖的键回落成了 key 原文（界面会直接显示 key）');
    assert.equal(uncovered, translations.en.common.save, '未覆盖的键应回落到 en 档');
    // 已有底座的语言档不受影响
    assert.equal(translateFor('zho', 'common.save'), translations.zho.common.save);
  } finally {
    setLocalePatches([]);
  }
  assert.equal(translateFor('jpn', 'common.save'), translations.en.common.save, '清空补丁后仍以 en 档为底');

  // 13. 外部声明式语言包（B2）注册路径：主进程读好的表 → locales 槽位 → 合并后真的生效。
  //     这条路径与内置 loader 不同（走 IPC 拿数据、按插件前缀下键），必须单独覆盖。
  const { applyDeclarativePlugins } = require('../plugin-runtime/declarative-loader.ts');
  const declarativeKernel = createKernel();
  const declarativeTable = { toolbar: { undo: '元に戻す' } };
  let requestedPluginList = 0;
  global.window = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    artflowApp: {
      listDeclarativePlugins: async () => {
        requestedPluginList += 1;
        return {
          plugins: [
            { id: 'local.locale-jpn', name: '日本語パック', formatAliases: [], locales: [{ language: 'jpn', table: declarativeTable }] },
            { id: 'local.locale-kor', name: '한국어', formatAliases: [], locales: [{ language: 'kor', table: { toolbar: { undo: '되돌리기' } } }] },
          ],
        };
      },
    },
  };
  try {
    await applyDeclarativePlugins(declarativeKernel);
    assert.equal(requestedPluginList, 1);
    assert.deepEqual(listLocaleContributions(declarativeKernel), [
      { language: 'jpn', table: declarativeTable },
      { language: 'kor', table: { toolbar: { undo: '되돌리기' } } },
    ]);
    setLocalePatches(listLocaleContributions(declarativeKernel));
    assert.equal(translateFor('jpn', 'toolbar.undo'), '元に戻す');
    assert.equal(translateFor('kor', 'toolbar.undo'), '되돌리기');
    // 外部包同样只做补丁：未覆盖的键回落 en，而不是漏成 key 原文
    assert.equal(translateFor('jpn', 'toolbar.layers'), translations.en.toolbar.layers);
    // 被用户在插件管理里停用的外部插件不得贡献语言包
    const disabledKernel = createKernel();
    const disabledStorage = {
      getItem: () => JSON.stringify(['local.locale-jpn']),
      setItem() {},
      removeItem() {},
    };
    await applyDeclarativePlugins(disabledKernel, disabledStorage);
    assert.deepEqual(listLocaleContributions(disabledKernel), [
      { language: 'kor', table: { toolbar: { undo: '되돌리기' } } },
    ], '被停用的外部插件不得注册语言包');
  } finally {
    delete global.window;
    setLocalePatches([]);
  }
};

runCommandContributionChecks()
  .then(runPluginFormatHandlerChecks)
  .then(runPluginPanelChecks)
  .then(runStorageContractChecks)
  .then(runStorageBridgeChecks)
  .then(runImportJobChecks)
  .then(runDerivativeJobChecks)
  .then(runAutoSyncChecks)
  .then(runImageLODChecks)
  .then(runAIProviderChecks)
  .then(runI18nChecks)
  .then(
    () => console.log('foundation checks: ok'),
    error => {
      console.error(error);
      process.exitCode = 1;
    },
  );
