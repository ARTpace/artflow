/**
 * 内置可编辑插件目录（editable channel）。
 *
 * 与 declarative / sandboxed 的区别：
 *   - declarative：只读 JSON，零代码；
 *   - sandboxed  ：第三方不可信代码，guest 窗口 + 受限 API，id 强制 `local.`；
 *   - editable   ：**内置**插件的可编辑形态，id 保留 `builtin.`，代码以纯 JS 播种到
 *                  userData/plugins/builtin/<id>/plugin.js。装完可改，重启生效，无需重编译宿主。
 *
 * 安全边界（重要）：editable 插件在渲染进程主世界**受信任执行**（等同现有编译进 bundle 的
 * 内置插件）。它只应来自我们播种的目录，不接受用户从外部安装 —— 所以：
 *   - 只扫描 id 以 `builtin.` 开头的包；
 *   - 主进程只读源码文本并做**形状校验**，绝不执行（执行在渲染层）；
 *   - 因此不带 DENIED_SOURCE 那套 API 白名单：受信任代码本就可以用宿主能力。
 * installExternalPlugin 只认 local.，天然不会写进这里。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_PLUGINS = 32;
const MAX_MANIFEST_BYTES = 16 * 1024;
/** 插件源码上限：内置插件体量可能较大（如含解析器），给 512KB 余量。 */
const MAX_SOURCE_BYTES = 512 * 1024;
/** id 必须 `builtin.` 前缀（与外部 local. 通道互斥）。 */
const BUILTIN_ID_PATTERN = /^builtin\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set([
  'manifestVersion', 'id', 'version', 'minHostVersion', 'name', 'nameI18n',
  'author', 'license', 'runtime', 'host', 'requires', 'optionalRequires',
  'configSchema', 'capabilities', 'resourceBudget', 'contributes',
  'description', 'descriptionI18n', 'category', 'mcp',
]);
const ENTRY_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.js$/;

/** 读 manifest.json（有大小上限，失败返回 null）。 */
function readManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 校验 editable manifest：必须是 `runtime.mode === 'editable'` + `entry` 指向 .js。
 * 返回解析后的对象，失败返回 null（不抛错，跳过该包）。
 */
function parseEditableManifest(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !ALLOWED_KEYS.has(key))) return null;
  if (typeof value.id !== 'string' || !BUILTIN_ID_PATTERN.test(value.id)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80) return null;
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  if (runtime.mode !== 'editable') return null;
  if (typeof runtime.entry !== 'string' || !ENTRY_PATTERN.test(runtime.entry) || runtime.entry.includes('..')) return null;
  return {
    id: value.id,
    name: value.name,
    version: typeof value.version === 'string' ? value.version : '0.0.0',
    entry: runtime.entry,
    description: typeof value.description === 'string' ? value.description.slice(0, 200) : '',
    // 由主进程注入「可编辑插件目录」的可打开句柄（不接受 manifest 自带 sourceDir：
    // 那是可伪造字段）。插件管理器据此显示并在系统里打开 userData/plugins/builtin/<id>/。
    sourceDir: `editable:${value.id}`,
    manifest: { ...value, sourceDir: `editable:${value.id}` },
  };
}

/** 扫描目录，返回可编辑包（含源码文本）。源码不在此执行。 */
function listEditablePackages(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || packages.length >= MAX_PLUGINS) continue;
    if (!entry.name.startsWith('builtin.')) continue;
    const dir = path.join(root, entry.name);
    const raw = readManifest(dir);
    if (!raw) continue;
    const parsed = parseEditableManifest(raw);
    if (!parsed || parsed.id !== entry.name) continue;
    const entryPath = path.join(dir, parsed.entry);
    let stat;
    try { stat = fs.statSync(entryPath); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
    packages.push({
      id: parsed.id,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      entryPath,
      manifest: parsed.manifest,
    });
  }
  return packages;
}

/**
 * 列举并读取所有可编辑插件的源码（供渲染层执行）。
 * 返回 { plugins: [{ id, name, version, description, manifest, source }] }。
 * 源码执行在渲染进程；主进程只搬运文本。
 */
function readEditablePlugins(root) {
  const plugins = [];
  for (const pkg of listEditablePackages(root)) {
    let source;
    try { source = fs.readFileSync(pkg.entryPath, 'utf8'); } catch { continue; }
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) continue;
    plugins.push({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      manifest: pkg.manifest,
      source,
    });
  }
  return { plugins };
}

module.exports = { parseEditableManifest, listEditablePackages, readEditablePlugins };
