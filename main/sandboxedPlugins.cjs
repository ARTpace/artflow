/**
 * Install and describe third-party plugins. Plugin source is never executed here.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseDeclarativeManifest } = require('./declarativePlugins.cjs');
const { validateCardResult } = require('../sandbox/module-table.cjs');
const { performHostCall, HOST_PERMISSIONS } = require('./hostFacade.cjs');
const { loadPluginData, savePluginData } = require('./pluginData.cjs');

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_CLIENT_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const ID_PATTERN = /^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** Dependency ids follow the same shape as any contribution id. */
const DEPENDENCY_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
/**
 * The host API contract version third-party plugins compile against.
 * A plugin may declare `minHostVersion`; anything newer is refused at activation
 * instead of failing later with a confusing missing-method error.
 * Bump on any breaking change to a facade signature in `types/artflow-plugin.d.ts`.
 * 1.2.0 — adds `api.storage.load()/save()` (plugin-owned KV persistence,
 *         `<plugin dir>/data.json`, 256 KB cap), see main/pluginData.cjs.
 * 1.1.0 — adds the `host.events` namespace (`asset.added/renamed/removed`,
 *         permission `events.subscribe`), see main/hostEvents.cjs.
 */
const HOST_API_VERSION = '1.2.0';
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** Guards against a manifest declaring a permission the host does not implement. */
const HOST_PERMISSION_SET = new Set(HOST_PERMISSIONS);
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;
const DENIED_SOURCE = /\b(?:require|process|ipcRenderer|child_process|eval|Function)\s*[(.]|\bimport\s*(?:\(|[a-z*{])|node:/;
// 兼容通道白名单：Obsidian 官方构建约定把 `obsidian` 标为 external，所以产物里**必然**保留
// 字面量 `require("obsidian")`（本机 45 个插件中 31 个能直接检出）。沙箱在运行时用
// boundedRequire 接管这个调用（sandbox/module-table.cjs 的 compat 激活逻辑），所以安装前
// 的静态扫描必须对它例外，否则自家兼容通道会被自己的守卫拦死。
// 只放行这一个字面量；`require('fs')` / `require("path")` 等仍照旧拒绝。
const OBSIDIAN_REQUIRE = /\brequire\s*\(\s*(['"])obsidian\1\s*\)/g;
function hasDeniedSource(source) {
  // 先剔除白名单调用再判定，避免"整篇放行"把其他 require 一起放过。
  return DENIED_SOURCE.test(source.replace(OBSIDIAN_REQUIRE, ''));
}
// unrestricted 能力声明白名单：'components' 是最重的一档（client.js 进画布渲染进程），
// 安装时必须走风险确认（组件贡献 = 宿主权限，见 docs/插件系统设计.md §8）。
const ALLOWED_KEYS = new Set(['id', 'name', 'version', 'runtime', 'description', 'permissions', 'capabilities', 'minHostVersion', 'requires']);
const CAPABILITIES_PATTERN = new Set(['components', 'format', 'commands', 'panels', 'assets']);
const PROTECTED_FILES = new Set(['manifest.json', 'plugin.js', 'client.js', 'data.json']);
// 入口文件名：默认 plugin.js（历史契约），也接受 Obsidian 惯例的 main.js 等任意安全文件名。
// 单段路径、字符白名单、不得与受保护/保留文件重名（否则安装流会把 manifest/client 覆盖掉）。
const ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.js$/;
// 注意：plugin.js 是历史默认入口，必须允许；这里挡的是「入口与其他受保护文件重名」。
const RESERVED_ENTRY_NAMES = new Set(['manifest.json', 'client.js', 'data.json', 'guest.js']);

function normalizeRelativeList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const paths = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 80) return null;
    if (entry === '.') {
      paths.push('.');
      continue;
    }
    if (entry.includes('\\') || entry.startsWith('/') || entry.includes('..')) return null;
    const segments = entry.split('/');
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return null;
    paths.push(segments.join('/'));
  }
  return paths;
}

function normalizeHosts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const hosts = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !HOST_PATTERN.test(entry)) return null;
    const host = entry.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return null;
    hosts.push(host);
  }
  return hosts;
}

function parsePermissions(value) {
  if (value === undefined) return { read: [], write: [], network: [], library: [], host: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => key !== 'read' && key !== 'write' && key !== 'network' && key !== 'library' && key !== 'host')) return null;
  const read = normalizeRelativeList(value.read);
  const write = normalizeRelativeList(value.write);
  const network = normalizeHosts(value.network);
  const library = normalizeLibrary(value.library);
  const host = normalizeHostPermissions(value.host);
  if (!read || !write || !network || !library || !host) return null;
  return { read, write, network, library, host };
}

/**
 * `host` capability permissions are a closed list: a manifest cannot invent one,
 * so a typo fails at install time instead of silently granting nothing.
 */
function normalizeHostPermissions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > HOST_PERMISSION_SET.size) return null;
  const permissions = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !HOST_PERMISSION_SET.has(entry)) return null;
    if (!permissions.includes(entry)) permissions.push(entry);
  }
  return permissions;
}

/** Declared dependencies are ids only — resolution and conflict blocking happen in the profile layer. */
function normalizeDependencies(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !DEPENDENCY_PATTERN.test(entry) || entry.length > 80) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

/** Positive means left is newer. Intentionally small: manifests only declare a minimum. */
function comparePluginVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function isHostCompatible(minHostVersion, hostVersion = HOST_API_VERSION) {
  if (typeof minHostVersion !== 'string') return true;
  return comparePluginVersions(hostVersion, minHostVersion) >= 0;
}

function normalizeLibrary(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) return null;
  if (value.length === 0) return [];
  if (value[0] !== 'rename') return null;
  return ['rename'];
}

function parseSandboxedManifest(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !ALLOWED_KEYS.has(key))) return null;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80) return null;
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  if (Object.keys(runtime).some(key => key !== 'mode' && key !== 'entry')) return null;
  if (runtime.mode !== 'sandboxed') return null;
  // entry 可省略（= plugin.js）；给了就必须是安全的单段 .js 文件名。
  const entryName = typeof runtime.entry === 'string' ? runtime.entry : 'plugin.js';
  if (!ENTRY_PATTERN.test(entryName) || RESERVED_ENTRY_NAMES.has(entryName)) return null;
  const permissions = parsePermissions(value.permissions);
  if (!permissions) return null;
  // minHostVersion：语义版本字符串。格式错就拒（拼错版本号等于没写，不如直接报错）。
  // 与当前 HOST_API_VERSION 的兼容性判断不在这里做 —— 见 listSandboxedPackages，那里能给出原因。
  let minHostVersion = '';
  if (value.minHostVersion !== undefined) {
    if (typeof value.minHostVersion !== 'string' || !VERSION_PATTERN.test(value.minHostVersion)) return null;
    minHostVersion = value.minHostVersion;
  }
  const requires = normalizeDependencies(value.requires, 'requires');
  if (!requires) return null;
  // capabilities：显式能力申请（省略 = 仅数据型，等同 ['format','commands','panels','assets'] 无组件）。
  let capabilities;
  if (value.capabilities === undefined) {
    capabilities = ['format', 'commands', 'panels', 'assets'];
  } else {
    if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > CAPABILITIES_PATTERN.size) return null;
    if (value.capabilities.some(capability => !CAPABILITIES_PATTERN.has(capability))) return null;
    capabilities = [...new Set(value.capabilities)];
  }
  return { id: value.id, name: value.name, entry: entryName, permissions, capabilities, requires, minHostVersion, description: typeof value.description === 'string' ? value.description.slice(0, 200) : '' };
}

function readManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > 16 * 1024) return null;
    return fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
}

function listSandboxedPackages(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || packages.length >= 32) continue;
    const dir = path.join(root, entry.name);
    const raw = readManifest(dir);
    if (!raw) continue;
    const parsed = parseSandboxedManifest(raw);
    if (!parsed || parsed.id !== entry.name) continue;
    const entryPath = path.join(dir, parsed.entry);
    let stat;
    try { stat = fs.statSync(entryPath); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
    const clientPath = path.join(dir, 'client.js');
    let hasClient = false;
    try {
      const clientStat = fs.statSync(clientPath);
      hasClient = clientStat.isFile() && clientStat.size <= MAX_CLIENT_BYTES;
    } catch { /* client.js is optional */ }
    packages.push({
      id: parsed.id,
      name: parsed.name,
      entry: parsed.entry,
      description: parsed.description,
      entryPath,
      dir,
      permissions: parsed.permissions,
      capabilities: parsed.capabilities,
      requires: parsed.requires,
      minHostVersion: parsed.minHostVersion,
      // 版本门只标记不剔除：插件仍出现在列表里，激活时才报明确原因
      // （「requires host API 2.0.0」比「插件凭空消失」好排查）。
      hostCompatible: isHostCompatible(parsed.minHostVersion),
      clientPath: hasClient ? clientPath : null,
    });
  }
  return packages;
}

function permissionLabels(permissions) {
  const labels = [];
  if (permissions.library.includes('rename')) labels.push('library:rename');
  if (permissions.read.length) labels.push('read');
  if (permissions.write.length) labels.push('write');
  if (permissions.network.length) labels.push('network');
  // host 面权限用全名列出（assets.read / assets.write），安装确认框据此逐条展示。
  for (const permission of permissions.host || []) labels.push(permission);
  return labels;
}

function listInstalledPlugins(root) {
  const declarative = require('./declarativePlugins.cjs').listDeclarativePlugins(root).plugins
    .map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      mode: 'declarative',
      ...(plugin.description ? { description: plugin.description } : {}),
    }));
  const sandboxed = listSandboxedPackages(root)
    .map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      mode: 'sandboxed',
      ...(plugin.description ? { description: plugin.description } : {}),
      permissions: permissionLabels(plugin.permissions),
    }));
  return { plugins: [...sandboxed, ...declarative] };
}

function installPluginDirectory(sourceDir, destRoot) {
  const raw = readManifest(sourceDir);
  if (!raw) return { ok: false, message: 'manifest.json is missing or too large' };
  const declarative = parseDeclarativeManifest(raw);
  const sandboxed = parseSandboxedManifest(raw);
  const parsed = sandboxed || declarative;
  if (!parsed) return { ok: false, message: 'manifest was rejected' };
  if (!ID_PATTERN.test(parsed.id)) return { ok: false, message: 'external plugin id must start with local.' };
  let source = '';
  if (sandboxed) {
    try {
      source = fs.readFileSync(path.join(sourceDir, sandboxed.entry), 'utf8');
    } catch {
      return { ok: false, message: `${sandboxed.entry} is missing` };
    }
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { ok: false, message: `${sandboxed.entry} is too large` };
    if (hasDeniedSource(source)) return { ok: false, message: `${sandboxed.entry} uses an API the sandbox does not allow` };
  }
  let clientSource = null;
  if (sandboxed && fs.existsSync(path.join(sourceDir, 'client.js'))) {
    try {
      clientSource = fs.readFileSync(path.join(sourceDir, 'client.js'), 'utf8');
    } catch {
      return { ok: false, message: 'client.js could not be read' };
    }
    if (Buffer.byteLength(clientSource) > MAX_CLIENT_BYTES) return { ok: false, message: 'client.js is too large' };
    if (hasDeniedSource(clientSource)) return { ok: false, message: 'client.js uses an API the sandbox does not allow' };
  }
  const dest = path.resolve(destRoot, parsed.id);
  const root = path.resolve(destRoot);
  if (dest !== path.join(root, parsed.id)) return { ok: false, message: 'plugin path was rejected' };
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (sandboxed) {
    fs.writeFileSync(path.join(dest, 'manifest.json'), raw);
    fs.writeFileSync(path.join(dest, sandboxed.entry), source);
    if (clientSource !== null) fs.writeFileSync(path.join(dest, 'client.js'), clientSource);
    return { ok: true, id: parsed.id, mode: 'sandboxed' };
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), raw);
  // 语言包分片必须跟着 manifest 一起复制 —— 只搬 manifest.json 会让装好的插件读不到表体
  // （列表里看着在，语言切换器里也有选项，但整档是空的）。分片路径在校验阶段已拒 `..`/绝对路径。
  for (const declaration of parsed.locales || []) {
    if (!declaration.file) continue;
    const source = path.resolve(sourceDir, declaration.file);
    const target = path.resolve(dest, declaration.file);
    if (!target.startsWith(dest + path.sep)) return { ok: false, message: 'locale shard path was rejected' };
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      return { ok: false, message: `locale shard is missing: ${declaration.file}` };
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return { ok: false, message: `locale shard is unreadable or too large: ${declaration.file}` };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return { ok: true, id: parsed.id, mode: 'declarative' };
}

function uninstallPlugin(destRoot, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, message: 'plugin id was rejected' };
  const dest = path.resolve(destRoot, id);
  const root = path.resolve(destRoot);
  if (!dest.startsWith(root + path.sep)) return { ok: false, message: 'plugin path was rejected' };
  fs.rmSync(dest, { recursive: true, force: true });
  return { ok: true };
}

function resolvePluginPath(pluginDir, relativePath, roots) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 180) return null;
  if (relativePath.includes('\\') || relativePath.startsWith('/') || /^[a-z]:/i.test(relativePath)) return null;
  const segments = relativePath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return null;
  const root = path.resolve(pluginDir);
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) return null;
  const allowed = roots.some(rootRel => {
    const base = rootRel === '.' ? root : path.resolve(root, ...rootRel.split('/'));
    return target === base || target.startsWith(base + path.sep);
  });
  return allowed ? target : null;
}

async function performPluginHostOp(plugin, services, request) {
  const pluginStore = services && services.pluginStore;
  const archiveReader = services && services.archiveReader;
  const granted = plugin.permissions || { read: [], write: [], network: [], host: [] };
  // —— host 能力面：受控宿主对象图（资产库等）。权限在 hostFacade 里逐方法校验。 ——
  if (request && request.op === 'host') return performHostCall(plugin, services, request);
  if (request && request.op === 'read') {
    if (!granted.read.length) return { ok: false, message: 'file read is not permitted' };
    const target = resolvePluginPath(plugin.dir, request.path, granted.read);
    if (!target) return { ok: false, message: 'path was rejected' };
    let stat;
    try { stat = fs.statSync(target); } catch { return { ok: false, message: 'file is missing' }; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { ok: false, message: 'file is missing or too large' };
    return { ok: true, result: fs.readFileSync(target, 'utf8') };
  }
  // —— unrestricted 数据仓：大字节（漫画档案/模型文件等）内容寻址落盘，按 ref 读回 ——
  // store：任意字节；store-input：当前 parse 调用的原始文件字节（主进程暂存，免二次传输）。
  if (request.op === 'store' || request.op === 'store-input') {
    if (!pluginStore) return { ok: false, message: 'plugin data store is unavailable' };
    const bytes = request.op === 'store-input' ? request.inputBytes : request.bytes;
    try {
      const stored = await pluginStore.store({ pluginId: plugin.id, bytes });
      return { ok: true, result: stored };
    } catch (error) {
      return { ok: false, message: error?.message || 'store failed' };
    }
  }
  // —— 插件漫画档案通道：暂存输入落仓 → ZIP 引擎按需解页（与内置阅读器同一引擎，原生 zlib）。
  // 一步到位：parse 里 files.openArchiveInput() 拿 { ref, pageNames, pageCount } 填卡片 fields。
  if (request.op === 'archive-open') {
    if (!pluginStore || !archiveReader) return { ok: false, message: 'archive service is unavailable' };
    try {
      const stored = await pluginStore.store({ pluginId: plugin.id, bytes: request.inputBytes });
      const opened = await archiveReader.openArchivePath(
        `${plugin.id}:${stored.ref}`,
        pluginStore.pluginPath(plugin.id, stored.ref),
      );
      return { ok: true, result: { ref: stored.ref, byteSize: stored.byteSize, ...opened } };
    } catch (error) {
      return { ok: false, message: error?.message || 'archive open failed' };
    }
  }
  if (request.op === 'write') {
    if (!granted.write.length) return { ok: false, message: 'file write is not permitted' };
    if (typeof request.text !== 'string' || Buffer.byteLength(request.text) > MAX_FILE_BYTES) {
      return { ok: false, message: 'write is empty or too large' };
    }
    const target = resolvePluginPath(plugin.dir, request.path, granted.write);
    const protectedNames = plugin.entry && plugin.entry !== 'plugin.js'
      ? new Set([...PROTECTED_FILES, plugin.entry])
      : PROTECTED_FILES;
    if (!target || protectedNames.has(path.basename(target))) return { ok: false, message: 'path was rejected' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, request.text);
    return { ok: true, result: { ok: true } };
  }
  // —— 插件自有 KV 持久化（api.storage.load/save）：固定落 <插件目录>/data.json。 ——
  // 路径插件不可选 → 无遍历风险 → 不需要权限；大小上限 256KB；data.json 在
  // PROTECTED_FILES 里，files.write 绕不过去。与 Obsidian 的 loadData/saveData 同语义。
  if (request.op === 'data-load') {
    try {
      return { ok: true, result: { data: loadPluginData(plugin.dir) } };
    } catch (error) {
      return { ok: false, message: error?.message || 'plugin data load failed' };
    }
  }
  if (request.op === 'data-save') {
    try {
      return { ok: true, result: savePluginData(plugin.dir, request.data) };
    } catch (error) {
      return { ok: false, message: error?.message || 'plugin data save failed' };
    }
  }
  if (request.op === 'fetch') {
    let parsed;
    try { parsed = new URL(request.url); } catch { return { ok: false, message: 'url is invalid' }; }
    if (parsed.protocol !== 'https:') return { ok: false, message: 'only https is allowed' };
    if (!granted.network.includes(parsed.hostname.toLowerCase())) return { ok: false, message: 'host is not permitted' };
    // method/headers/body：Obsidian requestUrl 的常用形状。安全边界不变 ——
    // 仍限 https + 域名白名单；headers 只放标量字符串；body 上限 256KB。
    const method = request.method === 'POST' || request.method === 'GET' ? request.method : 'GET';
    const headers = {};
    if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string' && value.length <= 1024) headers[key] = value;
      }
      if (Object.keys(headers).length > 16) return { ok: false, message: 'too many headers' };
    }
    const body = typeof request.body === 'string' && request.body.length <= 256 * 1024 ? request.body : undefined;
    if (body !== undefined && method === 'GET') return { ok: false, message: 'GET cannot carry a body' };
    const response = await fetch(parsed.toString(), {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (text.length > MAX_FILE_BYTES) return { ok: false, message: 'response is too large' };
    return { ok: true, result: { status: response.status, text } };
  }
  return { ok: false, message: 'unknown host operation' };
}

function readPluginClients(root) {
  return {
    clients: listSandboxedPackages(root)
      .filter(plugin => plugin.clientPath)
      .map(plugin => ({
        id: plugin.id,
        source: fs.readFileSync(plugin.clientPath, 'utf8'),
        capabilities: plugin.capabilities,
        library: Array.isArray(plugin.permissions.library) && plugin.permissions.library.includes('rename'),
      })),
  };
}

/** Find one installed sandboxed package by id — the gate for renderer-side data access. */
function findSandboxedPackage(root, pluginId) {
  if (typeof pluginId !== 'string' || pluginId.length === 0 || pluginId.length > 120) return null;
  return listSandboxedPackages(root).find(plugin => plugin.id === pluginId) || null;
}

/** 安装前检查：供主进程弹风险确认（组件贡献 = 宿主权限，须用户显式授权）。 */
function inspectPluginDirectory(sourceDir) {
  const raw = readManifest(sourceDir);
  if (!raw) return { ok: false, message: 'manifest.json is missing or too large' };
  const sandboxed = parseSandboxedManifest(raw);
  if (!sandboxed) {
    const declarative = require('./declarativePlugins.cjs').parseDeclarativeManifest(raw);
    return declarative ? { ok: true, mode: 'declarative' } : { ok: false, message: 'manifest was rejected' };
  }
  let hasClient = false;
  try {
    hasClient = fs.statSync(path.join(sourceDir, 'client.js')).isFile();
  } catch { /* client.js is optional */ }
  return {
    ok: true,
    mode: 'sandboxed',
    id: sandboxed.id,
    name: sandboxed.name,
    capabilities: sandboxed.capabilities,
    // 两条都要用户显式授权：
    // ① 申请了 'components'（client.js 进画布渲染进程）= unrestricted 权限；
    // ② 申请了 host 权限（读写宿主资产库）= 数据权限。只声明 host 而不弹框，
    //    等于用户对「这个插件能改我的资产名」毫不知情 —— 披露是授权的前提。
    needsTrustConfirmation: hasClient || sandboxed.capabilities.includes('components') || sandboxed.permissions.host.length > 0,
    permissions: permissionLabels(sandboxed.permissions),
    minHostVersion: sandboxed.minHostVersion,
    hostCompatible: isHostCompatible(sandboxed.minHostVersion),
  };
}

module.exports = {
  parseSandboxedManifest,
  listSandboxedPackages,
  listInstalledPlugins,
  installPluginDirectory,
  uninstallPlugin,
  validateCardResult,
  resolvePluginPath,
  performPluginHostOp,
  readPluginClients,
  findSandboxedPackage,
  inspectPluginDirectory,
  permissionLabels,
  comparePluginVersions,
  isHostCompatible,
  HOST_API_VERSION,
};
