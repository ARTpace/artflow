const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseDeclarativeManifest, listDeclarativePlugins } = require('../main/declarativePlugins.cjs');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

// 主进程 CJS 不参与打包，语法错误只在安装运行后才爆（曾因注释里出现 `builtin.*/` 提前闭合块注释，
// 导致 main.cjs 直接 SyntaxError 启动即崩）。用 vm 编译源码做纯内存语法自检（不执行、不起子进程）。
const assertParses = relative => {
  try {
    new vm.Script(read(relative), { filename: relative });
  } catch (error) {
    assert.fail(`${relative} has a syntax error: ${error.message}`);
  }
};
assertParses('main.cjs');
assertParses('preload.cjs');
for (const dir of ['main', 'sandbox']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (name.endsWith('.cjs')) assertParses(`${dir}/${name}`);
  }
}

const handlers = read('hooks/useFileHandlers.ts');
assert.match(handlers, /parsed\.kind === 'reader'/);
assert.match(handlers, /parsed\.kind === 'card'/);
assert.match(handlers, /loadedItemFromCard/);
assert.doesNotMatch(handlers, /readTextFile|parseUrlFile|loadFontFile|getLanguageFromExt/);
// formats-files 已迁到 editable channel（plugins 播种 + editable-loader 受信任执行）。
// 断言改为校验：播种源含全部 handler id；旧 builtin 目录已不存在；渲染端确实接了该通道。
assert.match(read('plugins/builtin.formats-files/plugin.js'), /builtin\.format-markdown/);
assert.match(read('plugins/builtin.formats-files/plugin.js'), /builtin\.format-code/);
assert.match(read('plugins/builtin.formats-files/plugin.js'), /builtin\.format-bookmark/);
assert.match(read('plugins/builtin.formats-files/plugin.js'), /builtin\.format-font/);
assert.match(read('plugins/builtin.formats-files/plugin.js'), /builtin\.format-model3d/);
assert.match(read('plugins/builtin.formats-files/manifest.json'), /"mode":\s*"editable"/);
assert.doesNotMatch(read('builtin-plugins/index.ts'), /formatsFilesPlugin/);
assert.match(read('plugin-runtime/editable-loader.ts'), /readEditablePlugins/);
// commands-core / media 也已迁 editable channel：注册编排在播种源，旧目录已删。
assert.match(read('plugins/builtin.commands-core/plugin.js'), /edit\.undo/);
assert.match(read('plugins/builtin.commands-core/plugin.js'), /builtin\.canvas-menus\./);
assert.match(read('plugins/builtin.commands-core/manifest.json'), /"mode":\s*"editable"/);
assert.match(read('plugins/builtin.media/plugin.js'), /builtin\.media\.format-video/);
assert.match(read('plugins/builtin.media/manifest.json'), /"mode":\s*"editable"/);
assert.doesNotMatch(read('builtin-plugins/index.ts'), /commandsCorePlugin|mediaPlugin/);
// core-extensions / project-portable 也已迁 editable channel：编排在播种源，旧目录已删。
assert.match(read('plugins/builtin.core-extensions/plugin.js'), /core\.operation-guard/);
assert.match(read('plugins/builtin.core-extensions/plugin.js'), /Artflow\.services\.EXTENSION_RUNTIME/);
assert.match(read('plugins/builtin.core-extensions/manifest.json'), /"mode":\s*"editable"/);
assert.match(read('plugins/builtin.project-portable/plugin.js'), /project\.export-artflow/);
assert.match(read('plugins/builtin.project-portable/plugin.js'), /project\.import-artflow/);
assert.match(read('plugins/builtin.project-portable/manifest.json'), /"mode":\s*"editable"/);
assert.doesNotMatch(read('builtin-plugins/index.ts'), /coreExtensionsPlugin|projectPortablePlugin/);
assert.match(read('plugin-runtime/editable-loader.ts'), /createOperationGuardHook/);
assert.match(read('plugin-runtime/editable-loader.ts'), /EXTENSION_RUNTIME: EXTENSION_RUNTIME_SERVICE/);
assert.match(read('plugin-runtime/editable-loader.ts'), /zipSync/);
// editable 插件的「打开文件夹」：主进程按 id 注入 editable: 句柄并解析到 userData/plugins/<id>，
// 不信任 manifest 自带的 sourceDir（可伪造）。
assert.match(read('main/editablePlugins.cjs'), /sourceDir: `editable:\$\{value\.id\}`/);
assert.match(read('main.cjs'), /relPath\.startsWith\('editable:'\)/);
// 内置插件不带 sourceDir：打包后本就没有源码目录，留旧值只会显示一条不存在的假路径、且「打开文件夹」必失败。
assert.doesNotMatch(read('builtin-plugins/tools-canvas/manifest.json'), /"sourceDir"/);
assert.doesNotMatch(read('builtin-plugins/cards/manifest.json'), /"sourceDir"/);
// 内置/第三方分档依据 = 插件 manifest 自报的 runtime.mode（透出到 resolved profile，UI 只读它）。
assert.match(read('plugin-runtime/profile.ts'), /runtimeMode: state\.manifest\.runtime\.mode/);
assert.match(read('builtin-plugins/ui-plugin-manager/catalog.ts'), /export const isEditableMode/);
assert.match(read('main.cjs'), /pluginsRoot\(\)/);
// 内置插件「运行副本」与第三方物理隔离：内置落 plugins/builtin/，第三方留 plugins/ 根。
// 播种目标、内置扫描根、清单同步根、打开目录解析都必须指向 builtin 子目录；
// 第三方的 declarative / installed / install / uninstall 仍用 pluginsRoot（不能用 builtinPluginsRoot）。
const mainSource = read('main.cjs');
assert.match(mainSource, /function builtinPluginsRoot\(\)/);
assert.match(mainSource, /path\.join\(pluginsRoot\(\), 'builtin'\)/);
assert.match(mainSource, /seedBundledPlugins\(builtinPluginsRoot\(\)\)/);
assert.match(mainSource, /readEditablePlugins\(builtinPluginsRoot\(\)\)/);
assert.match(mainSource, /resolveBuiltinPackageDir/);
assert.match(mainSource, /migrateLegacyBuiltinDir/);
assert.match(mainSource, /listDeclarativePlugins\(pluginsRoot\(\)\)/);
// 第三方安装统一经 installFromSourcePath（文件夹 + .zip 共用）：对话框与画布拖拽都复用它，
// 它内部落到 installPluginDirectory(sourceDir, pluginsRoot()) —— 第三方仍用 pluginsRoot（不能 builtinPluginsRoot）。
assert.match(mainSource, /installFromSourcePath\(selection\.filePaths\[0\], owner\)/);
assert.match(mainSource, /installFromSourcePath\(path\.resolve\(sourcePath\), owner\)/);
assert.match(mainSource, /installPluginDirectory\(sourceDir, pluginsRoot\(\)\)/);
assert.match(mainSource, /uninstallPlugin\(pluginsRoot\(\), id\)/);
assert.doesNotMatch(mainSource, /return readEditablePlugins\(pluginsRoot\(\)\)/);
// 允许「新布局为空时回退老布局」这一处受控回退（半迁移保护），但必须包在 legacy 变量里，
// 不能出现无条件的裸扫描 —— 那会回到"两个位置都能被当成主目录"的旧混乱状态。
assert.match(mainSource, /const legacy = readEditablePlugins\(pluginsRoot\(\)\)/);
// 迁移只能搬 editable 包（有 entry），**不能**把声明式皮肤搬进 builtin/：
// listDeclarativePlugins 曾经是单层扫描，搬走 = 皮肤凭空消失。两道保险都要在。
assert.match(mainSource, /isEditablePackageDir/);
assert.match(read('main/declarativePlugins.cjs'), /function collectDeclarativeDirs/);
assert.match(read('main/declarativePlugins.cjs'), /已存在|下探一层/);
// manifest 上限必须容得下内联了预览图的皮肤包（用户实测 621KB），否则被静默跳过。
{
  const declarative = read('main/declarativePlugins.cjs');
  const cap = Number((declarative.match(/MAX_MANIFEST_BYTES = (\d+) \* 1024 \* 1024/) || [])[1] || 0);
  assert.ok(cap >= 4, `声明式 manifest 上限应 ≥ 4MB 以容纳内联媒体皮肤，实际 ${cap}MB`);
}
// editable 插件的 manifest 必须同步并入顶层 profile —— 否则设置页看不到、停不掉、configSchema 阈值无处可改。
assert.match(read('builtin-plugins/index.ts') + read('index.tsx'), /readEditableManifestsSync/);
assert.match(read('preload.cjs'), /readEditableManifestsSync/);
assert.match(read('main.cjs'), /pluginStateEditableManifests/);
assert.match(read('types.ts'), /type: 'plugin-node'/);
assert.match(read('components/CanvasElement.tsx'), /getMaterializedCardComponent\(element\.type\)/);

const app = read('App.tsx');
assert.doesNotMatch(app, /from '\.\/components\/PromptBar'|from '\.\/components\/PresentationUI'|from '\.\/components\/ElementTagsPanel'/);
assert.match(app, /placement="prompt"/);
assert.match(app, /placement="presentation"/);
assert.match(app, /ELEMENT_COMMAND_ACTIONS_SERVICE/);
assert.match(app, /AI_SESSION_SERVICE/);
assert.match(read('plugins/builtin.commands-core/plugin.js'), /edit\.undo/);
assert.match(read('plugins/builtin.commands-core/plugin.js'), /'z'/);
assert.match(read('builtin-plugins/ai-providers/index.ts'), /AI_SESSION_SERVICE/);
assert.doesNotMatch(read('builtin-plugins/studio-chrome/index.tsx'), /ipcRenderer|localStorage/);

assert.equal(parseDeclarativeManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'declarative', entry: 'index.js' },
  formatAliases: [{ extension: 'note', handlerId: 'builtin.format-book-reader' }],
})), null);
assert.equal(parseDeclarativeManifest('{"id":"local.notes","name":"Notes","runtime":{"mode":"builtin"},"formatAliases":[]}'), null);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-plugins-'));
fs.mkdirSync(path.join(dir, 'local.notes'));
fs.writeFileSync(path.join(dir, 'local.notes', 'manifest.json'), JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'declarative' },
  formatAliases: [{ extension: 'note', handlerId: 'builtin.format-book-reader' }],
}));
fs.mkdirSync(path.join(dir, 'local.code'));
fs.writeFileSync(path.join(dir, 'local.code', 'manifest.json'), JSON.stringify({
  id: 'local.code',
  name: 'Code',
  runtime: { mode: 'declarative', entry: 'plugin.js' },
  formatAliases: [{ extension: 'abc', handlerId: 'builtin.format-code' }],
}));
const listed = listDeclarativePlugins(dir);
assert.deepEqual(listed.plugins, [{
  id: 'local.notes',
  name: 'Notes',
  formatAliases: [{ extension: 'note', handlerId: 'builtin.format-book-reader' }],
}]);

// —— 语言包通道（B2）：formatAliases 从「必须」放宽成「与 locales 至少一种」，表体可内联或分片 ——
const {
  parseLocaleDeclarations,
  parseLocaleTable,
  MAX_LOCALE_SEGMENTS,
  MAX_LOCALE_ARRAY,
  MAX_LOCALE_SHARD_BYTES,
} = require('../main/declarativePlugins.cjs');

const declarativeManifest = (overrides = {}) => JSON.stringify({
  id: 'local.locale',
  name: 'Locale',
  runtime: { mode: 'declarative' },
  ...overrides,
});

// 只有 locales、没有 formatAliases 的纯语言包必须能过（否则 B2 的核心场景根本不成立）
assert.equal(
  parseDeclarativeManifest(declarativeManifest({ locales: [{ language: 'jpn', table: { a: 'あ' } }] })).locales.length,
  1,
);
assert.deepEqual(
  parseDeclarativeManifest(declarativeManifest({ locales: [{ language: 'jpn', table: { a: 'あ' } }] })).formatAliases,
  [],
  '缺省 formatAliases 必须是空数组而非 undefined，消费端才能安全遍历',
);
// 但"什么都不贡献"的空插件仍要拒（formatAliases: [] 旧行为是合法却毫无作用）
assert.equal(parseDeclarativeManifest(declarativeManifest({})), null);
assert.equal(parseDeclarativeManifest(declarativeManifest({ formatAliases: [] })), null);
assert.equal(parseDeclarativeManifest(declarativeManifest({ locales: [] })), null);
assert.equal(parseDeclarativeManifest(declarativeManifest({ locales: [{ language: 'jpn', table: {} }], extra: 1 })), null);

// 声明级校验：来源二选一、语言码合法、不重复、路径不得越界
assert.equal(parseLocaleDeclarations(undefined).length, 0);
assert.equal(parseLocaleDeclarations([{ language: 'jpn', table: { a: 'あ' } }, { language: 'kor', file: 'kor.json' }]).length, 2);
assert.equal(parseLocaleDeclarations([{ language: 'jpn', table: {}, file: 'a.json' }]), null, '内联与分片必须二选一');
assert.equal(parseLocaleDeclarations([{ language: 'jpn' }]), null, '必须给出表体或分片');
assert.equal(parseLocaleDeclarations([{ language: 'jpn', table: {} }, { language: 'jpn', table: {} }]), null, '语言码不得重复');
assert.equal(parseLocaleDeclarations([{ language: 'JPN', table: {} }]), null, '语言码必须是小写 BCP-47');
assert.equal(parseLocaleDeclarations([{ language: 'jpn', file: '../escape.json' }]), null, '不得越界');
assert.equal(parseLocaleDeclarations([{ language: 'jpn', file: 'sub/../escape.json' }]), null, '不得越界');
assert.equal(parseLocaleDeclarations([{ language: 'jpn', file: '/abs.json' }]), null, '不得用绝对路径');
assert.equal(parseLocaleDeclarations([{ language: 'jpn', file: 'x.txt' }]), null, '分片必须是 .json');
// 9 个**合法**语言码，只为触发数量上限（用含数字的码会先被语言码正则拒掉，测不到数量闸）
const nineLanguages = Array.from({ length: 9 }, (_, i) => `a${String.fromCharCode(97 + i)}a`);
assert.equal(nineLanguages.every(tag => /^[a-z]{3}$/.test(tag)), true);
assert.equal(
  parseLocaleDeclarations(nineLanguages.slice(0, 8).map(language => ({ language, table: {} }))).length,
  8,
  '正控：8 个合法语言码必须放行（证明上面那条挂的是数量闸而不是语言码正则）',
);
assert.equal(
  parseLocaleDeclarations(nineLanguages.map(language => ({ language, table: {} }))),
  null,
  '语言分片数量有上限',
);

// 表体：字符串 / 数组 / 纯对象放行；函数、数字、null、超深、超量拒收
const tableFixtures = [
  { name: '普通字符串', table: { a: 'x' }, ok: true },
  { name: '嵌套对象', table: { a: { b: 'x' } }, ok: true },
  { name: '对象数组（quickPrompts 形态）', table: { a: [{ b: 'x' }] }, ok: true },
  { name: '字符串数组', table: { a: ['x'] }, ok: true },
  { name: '空表', table: {}, ok: true },
  { name: '函数叶子（JSON 表达不了插值）', table: { a: () => 1 }, ok: false },
  { name: '数字叶子', table: { a: 1 }, ok: false },
  { name: 'null 叶子', table: { a: null }, ok: false },
  { name: '布尔叶子', table: { a: true }, ok: false },
  { name: '超过深度上限', table: { a: { b: { c: { d: { e: 'x' } } } } }, ok: false },
  { name: '数组元素是函数', table: { a: [{ b: () => 1 }] }, ok: false },
  { name: '超过单数组元素上限', table: { a: Array.from({ length: MAX_LOCALE_ARRAY + 1 }, () => 'x') }, ok: false },
  {
    name: '超过单层键数上限',
    table: Object.fromEntries(Array.from({ length: MAX_LOCALE_SEGMENTS + 1 }, (_, i) => [`k${i}`, 'x'])),
    ok: false,
  },
];

// ★两套校验器（主进程不可信输入第一道闸 / 渲染进程统一契约）判定必须一致，否则
//   「主进程放行、渲染进程拒收」会让插件列表里看得见却永远不生效。
require('./register-typescript.cjs');
const { validateManifest: validateRendererManifest } = require('../plugin-runtime/manifest.ts');
const rendererManifest = (id, overrides = {}) => ({
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
for (const fixture of tableFixtures) {
  assert.equal(parseLocaleTable(fixture.table) !== null, fixture.ok, `主进程对「${fixture.name}」判定不符预期`);
  let rendererVerdict = true;
  try {
    validateRendererManifest(rendererManifest('builtin.locale-fixture', {
      contributes: { locales: [{ language: 'jpn', table: fixture.table }] },
    }));
  } catch {
    rendererVerdict = false;
  }
  assert.equal(rendererVerdict, fixture.ok, `渲染进程对「${fixture.name}」判定不符预期`);
}

// 端到端：分片被主进程读成表体、坏分片只丢自己、越界分片整体拒收
fs.mkdirSync(path.join(dir, 'local.locale-jpn'));
fs.writeFileSync(path.join(dir, 'local.locale-jpn', 'manifest.json'), JSON.stringify({
  id: 'local.locale-jpn',
  name: '日本語パック',
  runtime: { mode: 'declarative' },
  locales: [
    { language: 'jpn', file: 'jpn.json' },
    { language: 'kor', file: 'missing.json' },
    { language: 'deu', table: { toolbar: { undo: 'Rückgängig' } } },
  ],
}));
fs.writeFileSync(path.join(dir, 'local.locale-jpn', 'jpn.json'), JSON.stringify({
  toolbar: { undo: '元に戻す' },
  quickPrompts: [{ name: '図', value: 'x' }],
}));
const localePlugin = listDeclarativePlugins(dir).plugins.find(plugin => plugin.id === 'local.locale-jpn');
assert.ok(localePlugin, '语言包插件必须出现在列表里');
assert.deepEqual(localePlugin.formatAliases, []);
assert.deepEqual(
  localePlugin.locales.map(bundle => bundle.language).sort(),
  ['deu', 'jpn'],
  '缺失的分片只丢弃自己，内联表与其它语言照常生效',
);
assert.equal(localePlugin.locales.find(bundle => bundle.language === 'jpn').table.toolbar.undo, '元に戻す');
assert.deepEqual(
  localePlugin.locales.find(bundle => bundle.language === 'jpn').table.quickPrompts,
  [{ name: '図', value: 'x' }],
  '数组必须完好穿过主进程校验',
);
assert.equal('file' in localePlugin.locales.find(bundle => bundle.language === 'deu'), false, '分片字段不得漏到渲染进程');

// 分片路径越界 / 超限 / 坏 JSON → 该语言被丢弃，但插件本身仍可用
fs.mkdirSync(path.join(dir, 'local.locale-bad'));
fs.writeFileSync(path.join(dir, 'local.locale-bad', 'manifest.json'), JSON.stringify({
  id: 'local.locale-bad',
  name: 'Bad',
  runtime: { mode: 'declarative' },
  locales: [
    { language: 'jpn', file: 'broken.json' },
    { language: 'kor', file: 'huge.json' },
  ],
}));
fs.writeFileSync(path.join(dir, 'local.locale-bad', 'broken.json'), '{ not json');
fs.writeFileSync(path.join(dir, 'local.locale-bad', 'huge.json'), JSON.stringify({ a: 'x'.repeat(MAX_LOCALE_SHARD_BYTES + 1) }));
const badPlugin = listDeclarativePlugins(dir).plugins.find(plugin => plugin.id === 'local.locale-bad');
assert.ok(badPlugin, '坏分片不应让整个插件消失');
assert.equal('locales' in badPlugin, false, '所有分片都坏掉时不应带空的 locales 字段');

// 越界分片在**声明阶段**就被拒 → 整个 manifest 非法（不能靠丢分片掩盖路径穿越）
fs.mkdirSync(path.join(dir, 'local.locale-escape'));
fs.writeFileSync(path.join(dir, 'local.locale-escape', 'manifest.json'), JSON.stringify({
  id: 'local.locale-escape',
  name: 'Escape',
  runtime: { mode: 'declarative' },
  locales: [{ language: 'jpn', file: '../outside.json' }],
}));
assert.equal(
  listDeclarativePlugins(dir).plugins.some(plugin => plugin.id === 'local.locale-escape'),
  false,
  '带路径穿越的 manifest 必须整体被拒',
);

// ★仓库自带的示例语言包必须始终可解析、且非空 —— 它是这条通道的活文档
const { listDeclarativePlugins: listExamples } = require('../main/declarativePlugins.cjs');
const exampleLocale = listExamples(path.join(root, 'examples')).plugins.find(plugin => plugin.id === 'local.locale-jpn');
assert.ok(exampleLocale, 'examples/local.locale-jpn 必须能被解析（示例就是活样本）');
assert.equal(exampleLocale.locales[0].language, 'jpn');
assert.ok(Object.keys(exampleLocale.locales[0].table).length >= 3, '示例语言包不应是空壳');

const { evaluatePluginSource } = require('../sandbox/module-table.cjs');
const { installPluginDirectory, parseSandboxedManifest } = require('../main/sandboxedPlugins.cjs');
const session = evaluatePluginSource(`
Artflow.modules.definePlugin(function (api) {
  api.formats.register({
    id: 'local.notes.read',
    extensions: ['note'],
    parse: function (file) {
      return { kind: 'card', cardType: 'markdown', name: file.name, width: 320, height: 200, fields: { content: 'hello' } };
    }
  });
  api.commands.register({ id: 'local.notes.ping', title: 'Ping', run: function () {} });
  api.panels.register({ id: 'local.notes.panel', title: 'Notes', html: '<p>Hi</p>' });
});
`, 'local.notes');
assert.deepEqual(session.catalog.formats, [{ id: 'local.notes.read', extensions: ['note'] }]);
assert.throws(() => evaluatePluginSource('require("fs")', 'local.notes'), /module "fs" is not available in the plugin sandbox/, 'require 已换成白名单版：fs 必须给明确报错而不是 undefined');
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
})).entry, 'plugin.js');
// runtime.entry 现在可自定义（Obsidian 惯例 main.js），但仅限安全的单段 .js 文件名。
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.obs',
  name: 'Obsidian style',
  runtime: { mode: 'sandboxed', entry: 'main.js' },
})).entry, 'main.js', 'Obsidian 惯例的 main.js 入口必须被接受');
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.obs',
  name: 'Obsidian style',
  runtime: { mode: 'sandboxed', entry: '../evil.js' },
})), null, '入口带路径穿越必须整体拒绝');
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.obs',
  name: 'Obsidian style',
  runtime: { mode: 'sandboxed', entry: 'manifest.json' },
})), null, '入口不得与受保护文件重名');
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'builtin.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
})), null);

const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-plugin-src-'));
fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
}));
fs.writeFileSync(path.join(sourceDir, 'plugin.js'), 'require("fs")');
const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-plugin-dest-'));
assert.equal(installPluginDirectory(sourceDir, destRoot).ok, false);
assert.doesNotMatch(read('main.cjs'), /evaluatePluginSource/);
assert.match(read('main/pluginSandboxHost.cjs'), /sandbox: true/);
assert.match(read('builtin-plugins/external-plugins/index.tsx'), /plugin\.install-external/);
assert.doesNotMatch(read('builtin-plugins/external-plugins/index.tsx'), /ipcRenderer|evaluatePluginSource/);
// parse 上限曾从 8 MiB 提到 512 MiB（与主进程漫画档案仓同量级），
// 断言跟到新值：上限本身不是回归点，别让它变成"必须改回旧数字"的枷锁。
assert.match(read('main/pluginSandboxHost.cjs'), /512 \* 1024 \* 1024/);

// —— 启动链守卫：require 解构必须覆盖被调用模块的全部导出 ——
// 真实故障（2026-10-10）：pluginSandboxHost.cjs 导出了 setArchiveReader，
// main.cjs 的解构漏了它，registerPluginStoreIpc() 里抛 ReferenceError，
// 表现为「双击快捷方式毫无反应 / splash 闪一下就没」。日志里才有线索。
// 这类错误 node --check 查不出来（语法合法），只能靠一致性断言拦住。
{
  const mainSource = read('main.cjs');
  const hostExports = Object.keys(require('../main/pluginSandboxHost.cjs'));
  const requireLine = mainSource.split('\n').find(line => line.includes("require('./main/pluginSandboxHost.cjs')"));
  assert.ok(requireLine, 'main.cjs 不再 require pluginSandboxHost.cjs —— 若改用其他注入方式，请同步删除这条守卫');
  for (const name of hostExports) {
    // 反向也查：解构了但模块没导出 =拼错名字，运行时同样是 ReferenceError。
    assert.match(requireLine, new RegExp(`\\b${name}\\b`), `main.cjs 未从 pluginSandboxHost.cjs 解构 ${name}（该模块已导出它）`);
  }
  // 模块里出现过的调用点必须都有对应解构（覆盖「新增调用但忘了加进解构」）。
  for (const call of ['setPluginStore', 'setArchiveReader']) {
    if (new RegExp(`\\b${call}\\s*\\(`).test(mainSource)) {
      assert.match(requireLine, new RegExp(`\\b${call}\\b`), `main.cjs 调用了 ${call}() 却没有解构它`);
    }
  }
}

const { performPluginHostOp } = require('../main/sandboxedPlugins.cjs');
require('./register-typescript.cjs');
const { evaluateClientSource } = require('../sandbox/client-module.ts');
const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-plugin-files-'));
fs.writeFileSync(path.join(fileDir, 'notes.txt'), 'hi');
// 这批断言原先是裸 .then(...)：脚本是 CommonJS 顶层同步流，进程会在 promise
// settle 前就退出 → 断言**从未真正执行**，里面的失败也永远不会报出来。
// 现在串进末尾的主链（await），它们才成为真守卫。
const assertHostOps = async () => {
  const note = await session.parse('local.notes.read', { name: 'a.note' });
  assert.equal(note.cardType, 'markdown');
  // performPluginHostOp(plugin, services, request) 的第一个参数是**插件描述**
  // { dir, permissions }，不是目录字符串 —— 传字符串会让 plugin.permissions 与
  // plugin.dir 都是 undefined，直接落到 'file read is not permitted'。
  // 这处以前写成裸 .then(...)，断言从未执行，所以错误入参一直没人发现。
  const sandboxPlugin = { id: 'local.notes', dir: fileDir, permissions: { read: ['.'], write: [], network: [] } };
  const allowed = await performPluginHostOp(sandboxPlugin, {}, { op: 'read', path: 'notes.txt' });
  assert.equal(allowed.ok, true, `读取授权路径必须成功，实际：${JSON.stringify(allowed)}`);
  assert.equal(allowed.result, 'hi');
  const denied = await performPluginHostOp(sandboxPlugin, {}, { op: 'read', path: '../secret' });
  assert.equal(denied.ok, false, '读取越界路径必须被拒绝');
  const parsed = await custom.parse('local.notes.custom', { name: 'a.xyz' });
  assert.equal(parsed.cardType, 'local.notes.card');
  assert.equal(parsed.fields.text, 'hi');

  // —— host 面：权限在宿主侧逐方法校验，沙箱里没有旁路 ——
  const hostPlugin = { id: 'local.notes', dir: fileDir, permissions: { read: [], write: [], network: [], library: [], host: [] } };
  const hostDenied = await performPluginHostOp(hostPlugin, {}, { op: 'host', namespace: 'assets', method: 'list', args: [{}] });
  assert.equal(hostDenied.ok, false, 'host 调用未声明权限时必须被拒绝');
  assert.match(hostDenied.message, /permission denied: assets\.read/);
  // 读权限不得顺带放开写权限 —— 逐方法映射的意义就在这里。
  const writeDenied = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, host: ['assets.read'] } },
    {},
    { op: 'host', namespace: 'assets', method: 'rename', args: [{ changes: [{ id: 'a1', name: 'b' }] }] },
  );
  assert.match(writeDenied.message, /permission denied: assets\.write/, 'assets.read 不能顺带授权 assets.write');
  const inventory = [{ id: 'a1', originalName: 'x.png', kind: 'image', mimeType: 'image/png', byteSize: 3, updatedAt: 1, usage: 'none', hashPrefix: 'deadbeef' }];
  const listed = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, host: ['assets.read'] } },
    { storage: { listAssetInventory: () => Promise.resolve({ items: inventory }) } },
    { op: 'host', namespace: 'assets', method: 'list', args: [{}] },
  );
  assert.equal(listed.ok, true, `声明权限后读取必须成功，实际：${JSON.stringify(listed)}`);
  assert.deepEqual(listed.result.assets, [
    { id: 'a1', name: 'x.png', kind: 'image', mimeType: 'image/png', byteSize: 3, updatedAt: 1, usage: 'none' },
  ], 'host 面只回可操作字段：不得泄露 hashPrefix 等内部线索');
  // 未实现的 namespace 必须给出明确原因 —— 静默返回空数组会让插件作者以为是数据为空。
  const pending = await performPluginHostOp(hostPlugin, {}, { op: 'host', namespace: 'board', method: 'snapshot', args: [] });
  assert.match(pending.message, /not available yet/, '未实现的 host namespace 必须明确报错');

  // —— 沙箱侧第 8 面的形状 ——
  // 一次 host 调用要带着 namespace/method/args 出门；宿主包的信封（{ assets } / { asset }）
  // 必须在这里就剥掉 —— 插件看到的是 AssetRef[]，不是内部协议。
  const hostCalls = [];
  const hostLogs = [];
  const originalLog = console.log;
  console.log = (...args) => hostLogs.push(args.join(' '));
  try {
    const hostSession = evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.commands.register({
    id: 'local.notes.host',
    title: 'Host',
    run: async function () {
      var list = await api.host.assets.list({ limit: 5 });
      var one = await api.host.assets.get('a1');
      console.log(api.host.meta.hostApiVersion + ':' + list.length + ':' + one.id);
    },
  });
});
`, 'local.notes', (op, fields) => {
      hostCalls.push({ op, ...fields });
      return Promise.resolve(fields.method === 'get' ? { asset: { id: 'a1' } } : { assets: [{ id: 'a1' }, { id: 'a2' }] });
    }, { hostApiVersion: '9.9.9' });
    await hostSession.run('local.notes.host');
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(hostCalls.map(call => [call.op, call.namespace, call.method, call.args]), [
    ['host', 'assets', 'list', [{ limit: 5 }]],
    ['host', 'assets', 'get', ['a1']],
  ], 'sandbox 侧 host 调用的 op/namespace/method/args 形状变了');
  assert.match(hostLogs.join('\n'), /9\.9\.9:2:a1/, 'host.meta.hostApiVersion 必须来自宿主注入，且返回值要剥掉信封');

  // —— host.events：订阅在宿主登记、handler 留在沙箱 ——
  const hostEvents = require('../main/hostEvents.cjs');
  assert.deepEqual(hostEvents.listEventNames(), ['asset.added', 'asset.renamed', 'asset.removed'], '宿主事件权威列表变了');
  // 未声明 events.subscribe：订阅被拒（登记不可能静默生效）。
  hostEvents.reset();
  const subDenied = await performPluginHostOp(
    hostPlugin,
    {},
    { op: 'host', namespace: 'events', method: 'subscribe', args: [{ subscriptionId: 'local.notes#e1', names: ['asset.added'] }] },
  );
  assert.match(subDenied.message, /permission denied: events\.subscribe/, '未声明 events.subscribe 时订阅必须被拒绝');
  // 拼错事件名：订阅时就被拒（而不是静默永不触发）。
  const subTypo = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, host: ['events.subscribe'] } },
    {},
    { op: 'host', namespace: 'events', method: 'subscribe', args: [{ subscriptionId: 'local.notes#e1', names: ['asset.addded'] }] },
  );
  assert.match(subTypo.message, /event names must be/, '拼错的事件名必须在订阅时被拒绝');
  // 正常订阅 + emit：payload 逐字段重建，内部字段出不去。
  hostEvents.reset();
  let pushed = null;
  hostEvents.setEmitter((pluginId, event) => { pushed = { pluginId, ...event }; });
  const subscribed = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, host: ['events.subscribe'] } },
    {},
    { op: 'host', namespace: 'events', method: 'subscribe', args: [{ subscriptionId: 'local.notes#e1', names: ['asset.added'] }] },
  );
  assert.equal(subscribed.ok, true, `声明权限后订阅必须成功，实际：${JSON.stringify(subscribed)}`);
  assert.equal(hostEvents.emit('asset.added', { asset: { id: 'a1', name: 'x.png', hashPrefix: 'deadbeef', storagePath: '/secret' } }), 1, '有订阅者时 emit 必须送达');
  assert.equal(pushed && pushed.pluginId, 'local.notes', '事件必须带订阅者的插件 id');
  assert.equal(pushed && pushed.subscriptionId, 'local.notes#e1', '事件必须按 subscriptionId 定向');
  assert.deepEqual(pushed && pushed.payload && pushed.payload.asset, { id: 'a1', name: 'x.png' }, '事件 payload 必须逐字段重建：hashPrefix/路径不得外泄');
  const unsubscribed = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, host: ['events.subscribe'] } },
    {},
    { op: 'host', namespace: 'events', method: 'unsubscribe', args: [{ subscriptionId: 'local.notes#e1' }] },
  );
  assert.equal(unsubscribed.ok, true, JSON.stringify(unsubscribed));
  assert.equal(hostEvents.emit('asset.added', { asset: { id: 'a1' } }), 0, '退订后 emit 必须零送达');
  hostEvents.setEmitter(null);

  // 沙箱侧 events.on：同步返回 id + bridge 收到 subscribe 登记 + 回推命中 handler。
  const eventCalls = [];
  const eventLogs = [];
  const previousLog = console.log;
  console.log = (...args) => eventLogs.push(args.join(' '));
  try {
    const eventSession = evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.host.events.on('asset.added', function (event) {
    console.log('fired:' + event.asset.id);
  });
  api.host.events.on('asset.added', function () {});
});`, 'local.notes', (op, fields) => {
      eventCalls.push({ op, ...fields });
      return Promise.resolve({ events: ['asset.added'] });
    }, { hostApiVersion: '1.0.0' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(eventCalls.map(call => [call.op, call.namespace, call.method]), [
      ['host', 'events', 'subscribe'],
      ['host', 'events', 'subscribe'],
    ], 'on() 必须向宿主登记 subscribe');
    assert.deepEqual(eventCalls[0].args, [{ subscriptionId: 'local.notes#e1', names: ['asset.added'] }], 'on() 的登记形状变了');
    assert.equal(eventSession.dispatchEvent({ subscriptionId: 'local.notes#e1', name: 'asset.added', payload: { asset: { id: 'a1' } } }), true, '回推必须命中本地 handler');
    assert.equal(eventSession.dispatchEvent({ subscriptionId: 'local.notes#e2', name: 'asset.added', payload: {} }), true, '第二个订阅也要命中');
  assert.equal(eventSession.dispatchEvent({ subscriptionId: 'local.notes#e9', name: 'asset.added', payload: {} }), false, '未知订阅必须返回 false 而不是抛错');
  assert.match(eventLogs.join('\n'), /fired:a1/, 'handler 必须拿到回推 payload');
  } finally {
    console.log = previousLog;
  }

  // —— api.storage：插件自有 KV 持久化（data.json，无需权限） ——
  const { loadPluginData, savePluginData, pluginDataPath } = require('../main/pluginData.cjs');
  assert.equal(pluginDataPath(fileDir), path.join(fileDir, 'data.json'), 'data.json 的落点变了');
  assert.equal(loadPluginData(fileDir), null, '没有 data.json 时必须返回 null（首次运行语义）');
  const savedData = savePluginData(fileDir, { count: 3, nested: { ok: true } });
  assert.ok(savedData.bytes > 0, 'save 必须返回写入字节数');
  assert.deepEqual(loadPluginData(fileDir), { count: 3, nested: { ok: true } }, 'save 后 load 必须原样读回');
  fs.writeFileSync(pluginDataPath(fileDir), '{oops');
  assert.throws(() => loadPluginData(fileDir), /corrupted/, '损坏的 data.json 必须明确报错（静默 null 会在下次 save 吞掉插件状态）');
  assert.throws(() => savePluginData(fileDir, { blob: 'x'.repeat(300 * 1024) }), /exceeds/, '超过 256KB 必须被拒绝');
  fs.unlinkSync(pluginDataPath(fileDir));
  // files.write 不得绕过 api.storage 的上限与语义直接碰 data.json。
  const dataWriteBlocked = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, write: ['.'] } },
    {},
    { op: 'write', path: 'data.json', text: '{}' },
  );
  assert.equal(dataWriteBlocked.ok, false, 'files.write 必须被 PROTECTED_FILES 拦住，不能碰 data.json');
  // write 分支此前引用了未定义的 pluginDir（任何 files.write 都会 ReferenceError），修复后必须可用。
  const writeOk = await performPluginHostOp(
    { ...hostPlugin, permissions: { ...hostPlugin.permissions, write: ['.'] } },
    {},
    { op: 'write', path: 'out.txt', text: 'ok' },
  );
  assert.equal(writeOk.ok, true, `files.write 必须可用（pluginDir 引用已修复）：${JSON.stringify(writeOk)}`);
  fs.unlinkSync(path.join(fileDir, 'out.txt'));
  // 沙箱侧 storage 的 bridge op 形状。
  const storageCalls = [];
  evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.storage.load().then(function (value) {
    console.log('loaded:' + value);
  });
  api.storage.save({ a: 1 });
});`, 'local.notes', (op, fields) => {
    storageCalls.push({ op, ...fields });
    return op === 'data-load' ? Promise.resolve({ data: null }) : Promise.resolve({ bytes: 5 });
  }, { hostApiVersion: '1.0.0' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(storageCalls.map(call => call.op), ['data-load', 'data-save'], 'storage 的 bridge op 形状变了');
  assert.deepEqual(storageCalls[1].data, { a: 1 }, 'save 的数据必须原样过桥');

  // —— obsidian-compat：白名单 require + module.exports 自动激活（方案 D2） ——
  const compatCalls = [];
  const compatSession = evaluatePluginSource(`
const { Plugin } = require('obsidian');
module.exports = class CompatPlugin extends Plugin {
  async onload() {
    const state = (await this.loadData()) || { n: 0 };
    state.n += 1;
    await this.saveData(state);
    this.addCommand({ id: 'greet', name: 'Greet', callback: function () {} });
    this.addSettingTab({ settingsSchema: [
      { type: 'text', key: 'greeting', label: '问候语', default: 'hi' },
    ] });
  }
};
`, 'local.compat', (op, fields) => {
    compatCalls.push({ op, ...fields });
    return op === 'data-load' ? Promise.resolve({ data: null }) : Promise.resolve({ bytes: 4 });
  }, { hostApiVersion: '1.2.0', manifest: { name: 'Compat', version: '0.1.0' } });
  assert.ok(compatSession && typeof compatSession.whenReady === 'function' || compatSession.whenReady instanceof Promise, 'compat 激活必须暴露 whenReady');
  await compatSession.whenReady;
  const compatCatalog = compatSession.buildCatalog();
  assert.deepEqual(compatCatalog.commands, [{ id: 'local.compat.greet', title: 'Greet', description: '' }], 'compat addCommand 必须映射成宿主命令');
  assert.equal(compatCatalog.settingsTabs.length, 1, 'compat addSettingTab(settingsSchema) 必须登记设置页');
  assert.deepEqual(compatCatalog.settingsTabs[0].controls.map(control => control.key), ['greeting'], 'settingsSchema 控件必须进 catalog');
  assert.deepEqual(compatCalls.map(call => call.op), ['data-load', 'data-save'], 'compat loadData/saveData 必须走 storage 桥');
  assert.throws(() => evaluatePluginSource('require("@codemirror/view")', 'local.compat'), /no Markdown editor/, '编辑器依赖必须给明确报错');
  assert.throws(() => evaluatePluginSource(`
Artflow.modules.definePlugin(function (api) {
  api.commands.register({ id: 'local.compat.ping', title: 'Ping', run: function () {} });
});
module.exports = class extends (require('obsidian').Plugin) {};
`, 'local.compat'), /pick one entry style/, '两种入口风格不得混用');
  assert.throws(() => evaluatePluginSource(`
module.exports = class Broken {
  constructor() { this.x = 1; }
};
`, 'local.compat'), /must extend the Plugin class/, '不继承 compat Plugin 的导出必须报错');
  // esbuild CJS 互操作形态（exports.default = class）是 Obsidian 插件的主流产物形状。
  const defaultShapeSession = evaluatePluginSource(`
const { Plugin } = require('obsidian');
module.exports = { default: class DefaultShapePlugin extends Plugin {
  onload() { this.addCommand({ id: 'ping', name: 'Ping', callback: function () {} }); }
} };
`, 'local.compat');
  await defaultShapeSession.whenReady;
  assert.deepEqual(defaultShapeSession.buildCatalog().commands, [{ id: 'local.compat.ping', title: 'Ping', description: '' }], 'exports.default 形态必须能激活（esbuild CJS 产物）');


  // —— api.ui：声明式设置页（本地登记，schema 随 catalog 带出，不过 bridge） ——
  const uiSession = evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.ui.registerSettingsTab({
    id: 'local.notes.settings',
    title: 'Notes',
    controls: [
      { type: 'text', key: 'endpoint', label: 'Endpoint', default: 'https://x' },
      { type: 'toggle', key: 'verbose', label: 'Verbose' },
      { type: 'select', key: 'mode', label: 'Mode', options: [{ value: 'fast', label: 'Fast' }] },
      { type: 'note', text: 'hello' },
    ],
  });
});`, 'local.notes', () => Promise.resolve({}), {});
  assert.equal(uiSession.catalog.settingsTabs.length, 1, 'settingsTabs 必须随 catalog 带出');
  assert.deepEqual(uiSession.catalog.settingsTabs[0].controls.map(control => control.type), ['text', 'toggle', 'select', 'note'], '设置控件的形状变了');
  assert.throws(() => evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.ui.registerSettingsTab({ id: 'wrong.prefix', title: 'x', controls: [{ type: 'text', key: 'a', label: 'b' }] });
});`, 'local.notes', () => Promise.resolve({}), {}), /must start with the plugin id/, '设置页 id 必须带插件前缀');
  assert.throws(() => evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.ui.registerSettingsTab({ id: 'local.notes.s', title: 'x', controls: [{ type: 'toggle', key: 'a', label: 'b', default: 'yes' }] });
});`, 'local.notes', () => Promise.resolve({}), {}), /default does not match/, '默认值类型必须与控件匹配');
  assert.throws(() => evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.ui.registerSettingsTab({ id: 'local.notes.s1', title: 'a', controls: [{ type: 'text', key: 'k', label: 'l' }] });
  api.ui.registerSettingsTab({ id: 'local.notes.s2', title: 'b', controls: [{ type: 'text', key: 'k', label: 'l' }] });
});`, 'local.notes', () => Promise.resolve({}), {}), /at most one settings tab/, '每插件最多一个设置页');

  // —— ui.registerPanel：声明式交互面板（控件 + 动作回推） ——
  const panelSession = evaluatePluginSource(`Artflow.modules.definePlugin(function (api) {
  api.ui.registerPanel({
    id: 'local.notes.chat',
    title: 'Chat',
    controls: [
      { type: 'textarea', key: 'message', label: '内容', placeholder: '说点什么', default: 'hello' },
      { type: 'select', key: 'tone', label: '语气', options: [{ value: 'formal', label: '正式' }], default: 'formal' },
      { type: 'button', key: 'go', label: '发送', action: 'send' },
      { type: 'note', text: '动作会回推到 onAction' },
    ],
    content: '<p>初始内容</p>',
    onAction: function (actionId, values) {
      if (actionId === 'boom') throw new Error('intentional');
      if (actionId === 'send') return Promise.resolve({ content: '<p>回复：' + values.message + '</p>', notice: '已发送' });
      return {};
    },
  });
});`, 'local.notes', () => Promise.resolve({}), {});
  const panelEntry = panelSession.catalog.panels.find(panel => panel.id === 'local.notes.chat');
  assert.ok(panelEntry && panelEntry.schema, 'schema 面板必须随 catalog 带出');
  assert.deepEqual(panelEntry.schema.controls.map(control => control.type), ['textarea', 'select', 'button', 'note'], '面板控件形状变了');
  assert.equal(panelEntry.schema.controls[2].action, 'send', 'button 必须带 action');
  assert.equal(panelEntry.schema.content, '<p>初始内容</p>', '初始 content 必须原样带出');
  const sendResult = await panelSession.dispatchPanelAction('local.notes.chat', 'send', { message: '你好' });
  assert.equal(sendResult.content, '<p>回复：你好</p>', 'onAction 返回的 content 必须带回渲染层');
  assert.equal(sendResult.notice, '已发送', 'notice 必须带回');
  await panelSession.dispatchPanelAction('local.notes.chat', 'boom', {}).then(
    () => { throw new Error('onAction 抛错必须向上传播'); },
    error => { assert.match(String(error.message), /intentional/, 'onAction 抛错必须向上传播而不是静默'); },
  );
};
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  permissions: { read: ['../secret'] },
})), null);

// —— host 能力面（受控宿主对象图）的清单契约 ——
// host 权限是**封闭白名单**：写错权限名在安装时就被拒，而不是静默不授权
// （静默不授权会让插件作者以为是自己的代码问题，排查成本极高）。
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  permissions: { host: ['assets.delete'] },
})), null);
assert.deepEqual(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  minHostVersion: '1.0.0',
  requires: ['local.other'],
  permissions: { host: ['assets.read', 'assets.write'] },
})).permissions.host, ['assets.read', 'assets.write']);
assert.deepEqual(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  permissions: { host: ['events.subscribe'] },
})).permissions.host, ['events.subscribe'], 'events.subscribe 必须在封闭白名单里');
assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.notes',
  name: 'Notes',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  minHostVersion: '1.0',
})), null, 'minHostVersion 必须是完整语义版本');
// 版本门：声明了比宿主更新的 host API 版本 → 不兼容（激活时拒绝，但仍在列表里并给出原因）。
const { isHostCompatible, HOST_API_VERSION } = require('../main/sandboxedPlugins.cjs');
assert.equal(HOST_API_VERSION, '1.2.0', '宿主 API 版本变了：SDK 的 minHostVersion 说明与指南要同步');
assert.equal(isHostCompatible('1.0.0'), true, '旧版插件必须继续兼容');
assert.equal(isHostCompatible('1.3.0'), false, '宿主 1.2.0 不认识声明 1.3.0 的插件');
assert.equal(isHostCompatible(undefined), true, '未声明 minHostVersion 视为不限');

const custom = evaluatePluginSource(`
Artflow.modules.definePlugin(function (api) {
  api.cards.register({ nodeType: 'local.notes.card' });
  api.formats.register({
    id: 'local.notes.custom',
    extensions: ['xyz'],
    parse: function () {
      return { kind: 'card', cardType: 'local.notes.card', name: 'N', width: 20, height: 20, fields: { text: 'hi' } };
    }
  });
});
`, 'local.notes');
const ReactStub = { createElement: (type, props) => ({ type, props }) };
const client = evaluateClientSource(`
Artflow.modules.definePlugin(function (api) {
  api.cards.register({
    nodeType: 'local.notes.card',
    component: function (props) { return React.createElement('div', null); }
  });
  api.overlays.register({
    id: 'local.notes.mark',
    component: function () { return React.createElement('i', null); }
  });
});
`, 'local.notes', ReactStub);
assert.equal(client.cards[0].nodeType, 'local.notes.card');
assert.equal(typeof client.overlays[0].component, 'function');
assert.throws(() => evaluateClientSource('require("fs")', 'local.notes', ReactStub));

assert.equal(parseSandboxedManifest(JSON.stringify({
  id: 'local.asset-rename',
  name: '批量重命名',
  runtime: { mode: 'sandboxed', entry: 'plugin.js' },
  permissions: { library: ['delete'] },
})), null);
const sampleRoot = path.join(root, 'examples', 'local.asset-rename');
const sampleDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-rename-dest-'));
const installed = installPluginDirectory(sampleRoot, sampleDest);
assert.equal(installed.ok, true);
assert.equal(installed.id, 'local.asset-rename');
const { readPluginClients } = require('../main/sandboxedPlugins.cjs');
const clients = readPluginClients(sampleDest);
assert.equal(clients.clients[0].library, true);
const ReactPanel = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
};
const panelClient = evaluateClientSource(fs.readFileSync(path.join(sampleRoot, 'client.js'), 'utf8'), 'local.asset-rename', ReactPanel);
assert.equal(panelClient.panels[0].id, 'local.asset-rename.panel');
const listCalls = [];
const view = panelClient.panels[0].component({
  library: {
    list: () => {
      listCalls.push('list');
      return Promise.resolve({ ok: true, items: [{ id: 'a', name: 'clip.mp4', kind: 'video', byteSize: 12 }] });
    },
    rename: () => Promise.resolve({ ok: true, renamed: [], missing: [] }),
  },
});
const buttons = [];
const walk = node => {
  if (!node || typeof node !== 'object') return;
  if (node.props && typeof node.props.onClick === 'function') buttons.push(node);
  for (const child of node.children || []) walk(child);
};
walk(view);
const refresh = buttons.find(node => node.children[0] === '刷新');
assert.equal(typeof refresh, 'object');
refresh.props.onClick();
assert.deepEqual(listCalls, ['list']);

// 沙箱插件对「只装工具、不持有源码」的第三方是否真的可开发：SDK 类型声明、可运行示例、
// 应用内开发指南三者必须同源且随包分发。任何一处漏掉，第三方就只能解包 asar 自己猜 API。
{
  const pkg = require('../package.json');
  const shipped = (pkg.build.extraResources ?? []).map(entry => (typeof entry === 'string' ? entry : entry.from)).join('|');
  // 必须走 extraResources：electron-builder 的 excludedExts 硬编码排除了 d.ts，
  // 放进 files 白名单也救不回来；而且 asar 内的文件第三方根本看不到。
  assert.ok(shipped.includes('examples'), 'examples 必须随包分发（extraResources），第三方才拿得到可运行示例');
  assert.ok(shipped.includes('types/artflow-plugin.d.ts'), 'SDK 类型声明必须随包分发（extraResources）');
  assertParses('sandbox/module-table.cjs');
  const sdk = read('types/artflow-plugin.d.ts');
  const guide = read('builtin-plugins/ui-plugin-manager/dev-guide.tsx');
  const sandbox = read('sandbox/module-table.cjs');
  for (const face of ['formats', 'commands', 'panels', 'cards', 'assets', 'files', 'net', 'storage', 'ui', 'host']) {
    assert.ok(sandbox.includes(`${face}: Object.freeze`), `沙箱能力面 ${face} 不存在了，SDK 与指南要跟着改`);
    assert.ok(sdk.includes(`    ${face}:`), `SDK 类型声明漏了能力面 ${face}`);
    assert.ok(guide.includes(`name: '${face}'`), `开发指南漏了能力面 ${face}`);
  }
  assert.ok(sdk.includes('Artflow'), 'SDK 必须声明 Artflow 全局入口');
  assert.ok(sdk.includes('local.${string}'), 'SDK 必须写明插件 id 的 local. 前缀约束');
  assert.ok(guide.includes('local.my-plugin'), '开发指南必须给出可复制的示例 id');
  assert.ok(guide.includes('Artflow.modules.definePlugin'), '开发指南必须给出可复制的入口调用');
  assert.ok(read('examples/README.md').includes('artflow-plugin.d.ts'), '示例说明必须指回 SDK');
  assert.ok(guide.includes('resources/plugin-sdk'), '开发指南必须告诉第三方去哪拿示例与类型');
}

// 异步断言统一在这里收口：失败 → 非零退出码，CI 才拦得住。
// 放在最后是为了让上面所有同步断言先跑完，报错信息更接近根因。
assertHostOps().then(() => {
  console.log('plugin openings: card results, chrome, commands, declarative manifests, sandbox module table');
}).catch(error => {
  console.error('plugin openings FAILED:', error.message);
  process.exitCode = 1;
});
