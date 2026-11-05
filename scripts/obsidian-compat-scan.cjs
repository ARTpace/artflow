#!/usr/bin/env node
/**
 * obsidian-compat-scan.cjs —— Obsidian 插件可移植性扫描器。
 *
 * 用途：读一个 Obsidian 库的 `.obsidian/plugins/` 目录，逐个分析 `main.js`
 * 实际用到的 Obsidian API，按「移植难度」分档，汇总出一张覆盖率表。
 *
 * 这是将来 `artflow-import-obsidian` 转换器的扫描内核（P2），
 * 不是一次性探针 —— 保持无副作用、只读。
 *
 * 用法：
 *   node scripts/obsidian-compat-scan.cjs ["<库>/.obsidian/plugins"] [--json]
 *
 * 关键前提（决定「自动移植」是否成立）：
 *   Obsidian 插件在打包时把 `obsidian` 标为 external，所以产物里
 *   保留了字面量 `require("obsidian")` 调用。这意味着「提供同名 shim 模块」
 *   就能在不改插件源码的前提下接管它的 API —— 前提是沙箱要放一个
 *   只解析白名单的 `require`。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'J:/资产库/知识库/.obsidian/plugins';
const AS_JSON = process.argv.includes('--json');

/** Obsidian 顶层导出 → 分类。分类决定移植工作量。 */
const EXPORT_CLASS = {
  // —— 生命周期 / 登记：artflow 已有对应插槽，可自动移植 ——
  Plugin: 'core',
  Component: 'core',
  Events: 'core',
  // —— 数据结构 ——
  TFile: 'model',
  TFolder: 'model',
  TAbstractFile: 'model',
  // —— UI（artflow 需补 Notice/Modal 或走声明式 schema）——
  Notice: 'ui',
  Modal: 'ui',
  SuggestModal: 'ui',
  FuzzySuggestModal: 'ui',
  Setting: 'ui',
  PluginSettingTab: 'ui',
  ItemView: 'ui',
  Menu: 'ui',
  MenuItem: 'ui',
  // —— 编辑器 / Markdown：artflow 无对标物，最重 ——
  MarkdownView: 'editor',
  Editor: 'editor',
  MarkdownRenderer: 'editor',
  MarkdownRenderChild: 'editor',
  EditorSuggest: 'editor',
  // —— 工具 ——
  requestUrl: 'util',
  normalizePath: 'util',
  debounce: 'util',
  Platform: 'util',
  moment: 'util',
  arrayBufferToBase64: 'util',
  base64ToArrayBuffer: 'util',
  parseYaml: 'util',
  stringifyYaml: 'util',
  prepareSimpleSearch: 'util',
  // —— 宿主对象类型（类型声明用，运行时不出现，但保留识别）——
  App: 'host',
  Vault: 'host',
  Workspace: 'host',
  MetadataCache: 'host',
  FileManager: 'host',
  FileSystemAdapter: 'host',
};

/** Plugin 实例方法 → 分类（扫 `this.xxx(` 与 `xxx(`）。 */
const INSTANCE_METHOD_CLASS = {
  addCommand: 'registry',
  addRibbonIcon: 'registry',
  addStatusBarItem: 'registry',
  addSettingTab: 'registry',
  registerEvent: 'registry',
  registerDomEvent: 'registry',
  registerInterval: 'registry',
  registerView: 'registry',
  registerMarkdownCodeBlockProcessor: 'editor',
  registerEditorExtension: 'cm6',
  registerEditorSuggest: 'editor',
  registerHoverLinkSource: 'editor',
  loadData: 'data',
  saveData: 'data',
  addChild: 'core',
  register: 'core',
};

/** 宿主对象访问路径 → 分类。 */
const HOST_PATH_CLASS = {
  'vault.read': 'vault.content',
  'vault.cachedRead': 'vault.content',
  'vault.modify': 'vault.write',
  'vault.create': 'vault.write',
  'vault.createFolder': 'vault.write',
  'vault.delete': 'vault.write',
  'vault.trash': 'vault.write',
  'vault.rename': 'vault.write',
  'vault.adapter': 'vault.raw',
  'metadataCache.getFileCache': 'metadata',
  'metadataCache.getCache': 'metadata',
  'metadataCache.getFirstLinkpathDest': 'metadata',
  'workspace.getActiveViewOfType': 'workspace',
  'workspace.getActiveFile': 'workspace',
  'workspace.getLeaf': 'workspace',
  'workspace.detachLeavesOfType': 'workspace',
  'workspace.on': 'workspace',
  'fileManager.processFrontMatter': 'frontmatter',
  'fileManager.renameFile': 'vault.write',
};

/** Node / Electron 依赖 → 直接判重。 */
const NODE_DEPS = ['electron', 'fs', 'fs/promises', 'path', 'child_process', 'os', 'crypto', 'http', 'https'];

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * 找出产物里 `"obsidian"` 的绑定形式。
 * 覆盖三种打包器写法：
 *   esbuild/rollup: var obsidian_1 = require("obsidian")  → objects
 *   解构:           const { Plugin, Notice } = require("obsidian") → destructured
 *   webpack:        <var> = __webpack_require__( ... "obsidian" ) → objects（取外层变量名）
 */
function findObsidianBindings(src) {
  const objects = new Set();
  const destructured = new Set();

  // 先用一次线性扫描定位所有 "obsidian" 字面量，再在前后窗口内做模式匹配。
  // ⚠️ 不要在整份产物上直接跑「A = B( ... "obsidian")」这类模式：`[\w$]*` 与
  // `[^)]{0,80}` 叠加会在 2.6MB 压缩产物上产生二次方回溯（实测 45 个插件跑不完）。
  for (const hit of src.matchAll(/["']obsidian["']/g)) {
    const win = src.slice(Math.max(0, hit.index - 240), hit.index);
    // esbuild/rollup: var obsidian_1 = require(   /   n = __webpack_require__(
    const obj = win.match(/([A-Za-z_$][\w$]{0,40})\s*=\s*(?:__webpack_require__|[A-Za-z_$][\w$]{0,40})?\s*\(?\s*$/);
    if (obj) objects.add(obj[1]);
    // 解构: const { Plugin, Notice } = require(
    const dest = win.match(/\{([^{}]{1,400})\}\s*=\s*(?:__webpack_require__|[A-Za-z_$][\w$]{0,40})?\s*\(?\s*$/);
    if (dest) {
      for (const raw of dest[1].split(',')) {
        const name = raw.split(':').pop().trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(name)) destructured.add(name);
      }
    }
  }
  return { objects: [...objects], destructured: [...destructured] };
}

/**
 * 单遍提取：把所有 `标识符.标识符` 与 `标识符(` 收集进两个 Set。
 *
 * 早先按「每个候选符号各跑一次正则」实现，45 个 1MB+ 产物 × 40 符号
 * 要扫近 10GB 文本，直接被打断。这里改成全文只过两遍正则。
 */
function harvest(src, objects) {
  const aliasMembers = new Set(); // 在 obsidian 别名上被点访问的成员
  const allMethods = new Set();   // 全部 `.xxx(` 形式的方法名

  if (objects.length) {
    const re = new RegExp(`(?:${objects.map(a => a.replace(/[$]/g, '\\$&')).join('|')})\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of src.matchAll(re)) aliasMembers.add(m[1]);
  }
  for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) allMethods.add(m[1]);

  return { aliasMembers, allMethods };
}

/** `require("x")` 的字面量集合，单遍。 */
function harvestRequires(src) {
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) out.add(m[1]);
  return out;
}

function classify(p) {
  const ex = new Set(p.exportsUsed);
  const me = new Set(p.methodsUsed);
  if (p.nodeDeps.some(d => ['electron', 'child_process', 'fs', 'fs/promises'].includes(d))) return 'C-node';
  if (p.hasCm6 || ex.has('Editor') || ex.has('MarkdownView') || ex.has('MarkdownRenderer')) return 'C-editor';
  if (p.hostPaths.some(h => h.startsWith('metadata') || h.startsWith('frontmatter'))) return 'B-metadata';
  if (p.hostPaths.some(h => h.startsWith('vault'))) return 'B-vault';
  if (ex.has('Modal') || ex.has('ItemView') || me.has('registerView') || ex.has('SuggestModal') || ex.has('FuzzySuggestModal')) return 'B-ui';
  if (ex.size === 0 && me.size === 0 && !p.hasObsidianRequire) return 'UNKNOWN';
  return 'A-auto';
}

const CLASS_NOTE = {
  'A-auto': '可直接跑 shim（命令/按钮/设置页/请求/数据持久化）',
  'B-ui': '需补 Notice/Modal/View 桥',
  'B-vault': '需把 vault 映射到资产库',
  'B-metadata': '需元数据/frontmatter 桥（笔记语义）',
  'C-editor': '依赖编辑器/Markdown，artflow 无对标物',
  'C-node': '依赖 Electron/Node 原生能力',
  UNKNOWN: '未识别到 Obsidian API',
};

function scanPlugin(dir) {
  const name = path.basename(dir);
  const manifest = readIf(path.join(dir, 'manifest.json'));
  let meta = {};
  try { meta = JSON.parse(manifest || '{}'); } catch { /* ignore */ }
  const main = readIf(path.join(dir, 'main.js'));
  if (!main) return null;

  const bindings = findObsidianBindings(main);
  const aliases = [...bindings.objects, ...bindings.destructured];
  const { aliasMembers, allMethods } = harvest(main, bindings.objects);
  const requires = harvestRequires(main);

  // 顶层导出：别名点访问命中，或作为解构名被真实引用
  const exportsUsed = new Set();
  for (const sym of Object.keys(EXPORT_CLASS)) {
    if (aliasMembers.has(sym)) exportsUsed.add(sym);
    else if (bindings.destructured.includes(sym) && new RegExp(`\\b${sym}\\b`).test(main)) exportsUsed.add(sym);
  }

  const methodsUsed = new Set();
  for (const m of Object.keys(INSTANCE_METHOD_CLASS)) if (allMethods.has(m)) methodsUsed.add(m);

  const hostPaths = new Set();
  for (const p of Object.keys(HOST_PATH_CLASS)) {
    const [obj, member] = p.split('.');
    if (member && allMethods.has(member) && new RegExp(`\\.${obj}\\b`).test(main)) hostPaths.add(p);
  }
  for (const obj of ['vault', 'workspace', 'metadataCache', 'fileManager']) {
    if (new RegExp(`\\.${obj}\\b`).test(main)) hostPaths.add(`${obj}.*`);
  }
  if (allMethods.has('processFrontMatter')) hostPaths.add('frontmatter.*');

  const nodeDeps = NODE_DEPS.filter(d => requires.has(d));

  const result = {
    id: meta.id || name,
    name: meta.name || name,
    dirName: name,
    version: meta.version || '',
    isDesktopOnly: meta.isDesktopOnly === true,
    minAppVersion: meta.minAppVersion || '',
    bytes: main.length,
    hasObsidianRequire: aliases.length > 0,
    aliases,
    exportsUsed: [...exportsUsed].sort(),
    methodsUsed: [...methodsUsed].sort(),
    hostPaths: [...hostPaths].sort(),
    nodeDeps,
    hasCm6: allMethods.has('registerEditorExtension') || requires.has('@codemirror/state') || /from\s*["']@codemirror/.test(main),
    usesDom: allMethods.has('createEl') || allMethods.has('createDiv') || /document\./.test(main),
  };
  result.grade = classify(result);
  return result;
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`目录不存在：${ROOT}`);
    process.exit(1);
  }
  const dirs = fs.readdirSync(ROOT)
    .map(d => path.join(ROOT, d))
    .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });

  const scanned = dirs.map(scanPlugin).filter(Boolean);

  if (AS_JSON) {
    console.log(JSON.stringify(scanned, null, 2));
    return;
  }

  // —— 汇总 ——
  const byGrade = {};
  for (const p of scanned) (byGrade[p.grade] ||= []).push(p);

  console.log(`扫描目录：${ROOT}`);
  console.log(`插件总数：${scanned.length} ｜ 含 require("obsidian") 的：${scanned.filter(p => p.hasObsidianRequire).length}`);
  console.log('');

  console.log('== 移植难度分档 ==');
  for (const g of ['A-auto', 'B-ui', 'B-vault', 'B-metadata', 'C-editor', 'C-node', 'UNKNOWN']) {
    const list = byGrade[g] || [];
    console.log(`${g.padEnd(12)} ${String(list.length).padStart(3)}  ${CLASS_NOTE[g]}`);
  }
  console.log('');

  console.log('== Obsidian 顶层导出的使用频次（决定 shim 要先实现谁）==');
  const expFreq = {};
  for (const p of scanned) for (const s of p.exportsUsed) (expFreq[s] ||= new Set()).add(p.id);
  Object.entries(expFreq)
    .sort((a, b) => b[1].size - a[1].size)
    .forEach(([sym, set]) => console.log(`  ${sym.padEnd(32)} ${String(set.size).padStart(3)} 个插件  [${EXPORT_CLASS[sym] || '?'}]`));
  console.log('');

  console.log('== Plugin 实例方法的使用频次 ==');
  const mFreq = {};
  for (const p of scanned) for (const s of p.methodsUsed) (mFreq[s] ||= new Set()).add(p.id);
  Object.entries(mFreq)
    .sort((a, b) => b[1].size - a[1].size)
    .forEach(([sym, set]) => console.log(`  ${sym.padEnd(36)} ${String(set.size).padStart(3)} 个插件  [${INSTANCE_METHOD_CLASS[sym] || '?'}]`));
  console.log('');

  console.log('== 宿主对象访问频次 ==');
  const hFreq = {};
  for (const p of scanned) for (const s of p.hostPaths) (hFreq[s] ||= new Set()).add(p.id);
  Object.entries(hFreq)
    .sort((a, b) => b[1].size - a[1].size)
    .forEach(([sym, set]) => console.log(`  ${sym.padEnd(36)} ${String(set.size).padStart(3)} 个插件`));
  console.log('');

  console.log('== Node/Electron 依赖 ==');
  const nFreq = {};
  for (const p of scanned) for (const s of p.nodeDeps) (nFreq[s] ||= new Set()).add(p.id);
  if (Object.keys(nFreq).length === 0) console.log('  （无）');
  Object.entries(nFreq).sort((a, b) => b[1].size - a[1].size)
    .forEach(([sym, set]) => console.log(`  require("${sym}")`.padEnd(38) + `${set.size} 个插件`));
  console.log('');

  console.log('== 逐插件明细 ==');
  for (const p of scanned.sort((a, b) => a.grade.localeCompare(b.grade) || a.id.localeCompare(b.id))) {
    console.log(`${p.grade.padEnd(11)} ${p.id.padEnd(38)} ${String(Math.round(p.bytes / 1024)).padStart(5)}KB  导出:${p.exportsUsed.length} 方法:${p.methodsUsed.length} 宿主:${p.hostPaths.length}${p.nodeDeps.length ? ' node:' + p.nodeDeps.join(',') : ''}`);
  }
}

main();
