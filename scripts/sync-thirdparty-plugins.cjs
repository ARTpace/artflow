#!/usr/bin/env node
/**
 * sync-thirdparty-plugins —— 把工程源码里的 plugins/（第三方可编辑插件）同步到「运行副本」目录。
 *
 * 用途：开发时改了 H:\AI-Tools\artflow\plugins\<id>\plugin.js，
 *       但不想重新打包，想立刻在已安装的 ArtFlow 里看到效果。
 *
 * 目标目录（自动探测，两种布局都支持）：
 *   新布局：<userData>/plugins/builtin/<id>/
 *   老布局：<userData>/plugins/<id>/
 *
 * 覆盖语义：只覆盖 manifest.json 与 runtime.entry 指向的源码文件（默认 plugin.js）。
 * 这样可编辑插件的两个文件永远跟源码一致；将来若插件带 assets/ 也一并镜像。
 *
 * 用法：
 *   node scripts/sync-thirdparty-plugins.cjs                 # 同步全部第三方包
 *   node scripts/sync-thirdparty-plugins.cjs builtin.media   # 只同步指定包
 *   node scripts/sync-thirdparty-plugins.cjs --dry           # 只报告不写入
 *   node scripts/sync-thirdparty-plugins.cjs --user-data <path>   # 指定 userData 根
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sourceRoot = path.join(root, 'plugins');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const userDataFlag = args.indexOf('--user-data');
const explicitUserData = userDataFlag >= 0 ? args[userDataFlag + 1] : null;
const only = args.filter(arg => !arg.startsWith('--') && arg !== explicitUserData);

/** 候选 userData 目录：显式指定 > 常见 app.name 变体（含 --user-data 未给时的兜底）。 */
function resolveUserDataRoots() {
  if (explicitUserData) return [path.resolve(explicitUserData)];
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return ['artflow-zho', 'ArtFlow', 'artflow'].map(name => path.join(appData, name));
}

/** 返回已存在的「运行副本」根目录列表（新布局优先）。 */
function resolveDestinationRoots() {
  const found = [];
  for (const userData of resolveUserDataRoots()) {
    const pluginsRoot = path.join(userData, 'plugins');
    if (!fs.existsSync(pluginsRoot)) continue;
    const builtinDir = path.join(pluginsRoot, 'builtin');
    if (fs.existsSync(builtinDir)) found.push(builtinDir);
    // 老布局：plugins/ 根下直接是 builtin.* 目录
    let hasLegacy = false;
    try {
      hasLegacy = fs.readdirSync(pluginsRoot, { withFileTypes: true })
        .some(entry => entry.isDirectory() && /^builtin\./.test(entry.name));
    } catch { /* 忽略读取失败 */ }
    if (hasLegacy) found.push(pluginsRoot);
  }
  return found;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 需要同步的文件：manifest.json + runtime.entry（默认为 plugin.js）。 */
function packageFiles(packageDir) {
  const files = ['manifest.json'];
  const manifest = readJson(path.join(packageDir, 'manifest.json'));
  const entry = manifest?.runtime?.entry;
  if (typeof entry === 'string' && entry.length > 0) files.push(entry);
  else files.push('plugin.js');
  return [...new Set(files)];
}

let synced = 0;
let skipped = 0;
let failed = 0;

function main() {
  if (!fs.existsSync(sourceRoot)) {
    console.error(`源目录不存在：${sourceRoot}`);
    process.exitCode = 1;
    return;
  }
  const destinations = resolveDestinationRoots();
  if (destinations.length === 0) {
    console.error('未找到任何运行副本目录（plugins/ 或 plugins/builtin/）。');
    console.error('请先启动一次 ArtFlow 完成播种，或用 --user-data 指定 userData 根。');
    process.exitCode = 1;
    return;
  }

  const packages = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^builtin\./.test(entry.name))
    .map(entry => entry.name)
    .filter(name => only.length === 0 || only.includes(name));

  if (packages.length === 0) {
    console.log('没有匹配的第三方包。');
    return;
  }

  console.log(`源：${sourceRoot}`);
  console.log(`目标：${destinations.join('  |  ')}`);
  console.log(dryRun ? '（--dry 模式：不写入）\n' : '');

  for (const name of packages) {
    const files = packageFiles(path.join(sourceRoot, name));
    for (const destRoot of destinations) {
      const destDir = path.join(destRoot, name);
      if (!fs.existsSync(destDir)) { skipped++; continue; }
      for (const file of files) {
        const from = path.join(sourceRoot, name, file);
        const to = path.join(destDir, file);
        if (!fs.existsSync(from)) continue;
        if (dryRun) {
          console.log(`会覆盖 ${path.relative(destRoot, to)}`);
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          synced++;
        } catch (error) {
          failed++;
          console.warn(`写入失败 ${to}：${error.message}`);
        }
      }
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`dry-run 完成：${packages.length} 个包待检查（第三方）。`);
  } else {
    console.log(`同步完成：写入 ${synced} 个文件${skipped ? `，跳过 ${skipped} 个未播种的包` : ''}${failed ? `，失败 ${failed}` : ''}。`);
    console.log('重启 ArtFlow 生效。');
  }
  if (failed) process.exitCode = 1;
}

main();
