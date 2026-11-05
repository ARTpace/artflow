// 校验 Tauri 命令在三处登记是否一致：
//   1. src/main.rs 的 tauri::generate_handler![...]（真正注册的处理器）
//   2. build.rs 的 AppManifest::new().commands(&[...])（参与 ACL 的命令清单）
//   3. capabilities/main-local.json 的 permissions（allow-<kebab-command>）
// 任何一处漏登记都会导致运行时 "not allowed" 或命令不可见，且编译期不会报错。
//
// 用法：node scripts/check-tauri-commands.cjs

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src-tauri');
const mainRs = path.join(root, 'src', 'main.rs');
const buildRs = path.join(root, 'build.rs');
const capabilitiesPath = path.join(root, 'capabilities', 'main-local.json');

const failures = [];

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`missing file: ${file}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

/** 从 generate_handler![...] 里抽出命令名（去掉模块前缀）。 */
function parseHandlers(source) {
  const start = source.indexOf('tauri::generate_handler![');
  if (start < 0) {
    failures.push('main.rs: tauri::generate_handler![...] not found');
    return [];
  }
  const open = source.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    failures.push('main.rs: generate_handler![] is not closed');
    return [];
  }
  const body = source.slice(open + 1, end);
  return body
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const withoutAttributes = entry.replace(/^#\[[^\]]*\]\s*/, '');
      const name = withoutAttributes.split('::').pop();
      return name.trim();
    })
    .filter(name => /^[a-z][a-z0-9_]*$/.test(name));
}

/** 从 build.rs 的 commands(&[...]) 里抽命令名。 */
function parseManifestCommands(source) {
  const marker = '.commands(&[';
  const start = source.indexOf(marker);
  if (start < 0) {
    failures.push('build.rs: AppManifest::commands(&[...]) not found');
    return [];
  }
  const open = source.indexOf('[', start);
  const close = source.indexOf('],', open);
  const end = close < 0 ? source.indexOf('])', open) : close;
  if (end < 0) {
    failures.push('build.rs: commands array is not closed');
    return [];
  }
  return source
    .slice(open + 1, end)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => entry.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** snake_case 命令名 → capability 的 allow-kebab-case 标识符。 */
function permissionFor(command) {
  return `allow-${command.replace(/_/g, '-')}`;
}

const mainSource = read(mainRs);
const buildSource = read(buildRs);
let capabilities = null;
try {
  capabilities = JSON.parse(read(capabilitiesPath) || 'null');
} catch (error) {
  failures.push(`capabilities/main-local.json: invalid JSON (${error.message})`);
}

const handled = parseHandlers(mainSource);
const manifested = parseManifestCommands(buildSource);
const permissions = Array.isArray(capabilities?.permissions) ? capabilities.permissions : [];

if (handled.length === 0) failures.push('generate_handler!: no commands parsed');
if (manifested.length === 0) failures.push('build.rs: no commands parsed');
if (permissions.length === 0) failures.push('capabilities: no permissions parsed');

const handledSet = new Set(handled);
const manifestedSet = new Set(manifested);

for (const command of handledSet) {
  if (!manifestedSet.has(command)) {
    failures.push(`build.rs is missing command: ${command}`);
  }
  const permission = permissionFor(command);
  if (!permissions.includes(permission)) {
    failures.push(`capabilities/main-local.json is missing permission: ${permission}`);
  }
}

for (const command of manifestedSet) {
  if (!handledSet.has(command)) {
    failures.push(`generate_handler! is missing command: ${command}`);
  }
}

for (const permission of permissions) {
  if (!permission.startsWith('allow-')) continue;
  const command = permission.slice('allow-'.length).replace(/-/g, '_');
  if (!handledSet.has(command)) {
    failures.push(`capabilities lists a permission with no handler: ${permission}`);
  }
}

// 重复项同样危险：Tauri 在重复的 allow 条目上行为不一致，generate_handler 重复会编译失败。
const duplicates = list => [...new Set(list.filter((item, index) => list.indexOf(item) !== index))];
for (const duplicate of duplicates(handled)) failures.push(`generate_handler! has duplicate: ${duplicate}`);
for (const duplicate of duplicates(manifested)) failures.push(`build.rs has duplicate: ${duplicate}`);
for (const duplicate of duplicates(permissions)) failures.push(`capabilities has duplicate: ${duplicate}`);

if (failures.length > 0) {
  console.error(`FAIL tauri command wiring: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS tauri command wiring: ${handled.length} commands registered consistently across generate_handler!, build.rs manifest and capabilities`,
  );
}
