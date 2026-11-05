/**
 * pluginProfileStore.cjs —— 插件启用 / 配置偏好的宿主侧落盘（userData 下的单个 JSON 文件）。
 *
 * 为什么必须搬到主进程 + 文件，而不是继续用渲染层 localStorage：
 *  1. localStorage 是**按 origin 隔离**的。dev 走 `http://localhost:4002`、直接 `npm run dev`
 *     走 vite.config.ts 的端口、打包后走 `file://` —— 三份互不相干的存储。换个启动方式，
 *     整套插件偏好就"消失"，渲染层退回默认 profile（默认 = 全部启用），表现为"关掉的插件
 *     重启又自己开了"。文件存储与 origin 无关，dev / 打包 / 多实例共享同一份真相。
 *  2. localStorage 是渲染层异步刷盘的：改完开关立刻关窗可能丢；多实例共用同一份 leveldb
 *     时同步 API 还会互相阻塞。主进程单一写者 + 原子写没有这些问题。
 *
 * 写策略：先备份当前文件 → 写 .tmp → rename 原子替换。任一步失败都返回 { ok:false }，
 *        不留下半截文件。
 * 读策略：主文件不可解析时回退 .backup；两者都不可用时返回 ok:false 且 patches 为 null。
 *        **绝不伪造空配置** —— 空配置在渲染层语义正是"全部插件默认启用"，那正是要避免的静默复活。
 */

const fs = require('node:fs');
const path = require('node:path');

const { SAFE_MODE_READ_MESSAGE, SAFE_MODE_WRITE_REJECTED } = require('./safeMode.cjs');

const SCHEMA_VERSION = 1;

/** 只接受 { patches: [...] } 形状；任何多余字段都不影响解析（向前兼容）。 */
function parseProfile(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.patches)) return null;
  return value;
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function createPluginProfileStore({ filePath, safeMode = false }) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('pluginProfileStore needs a filePath');
  }
  const safe = safeMode === true;
  const backupPath = `${filePath}.backup`;
  const tempPath = `${filePath}.tmp`;

  /**
   * @returns {{ ok: boolean, patches: unknown[] | null, source: 'file'|'backup'|'none'|'unreadable'|'safe-mode', schemaVersion: number, message?: string }}
   */
  function read() {
    // 安全模式：不消费用户的插件开关记录 → patches 为 null → 全部插件按默认装载。
    // 注意这里 patches 为 null 与"读不出来"同形，但语义相反：一个是我们刻意忽略，
    // 一个是真出了问题。靠 source 区分，渲染层只对后者弹告警。
    if (safe) {
      return { ok: true, patches: null, source: 'safe-mode', schemaVersion: SCHEMA_VERSION, message: SAFE_MODE_READ_MESSAGE };
    }
    const primaryRaw = readIfExists(filePath);
    if (primaryRaw === null) {
      // 区分"从没写过"与"读不出来"：前者是正常的首次运行，后者要显式告警。
      const exists = fs.existsSync(filePath);
      if (!exists) return { ok: true, patches: null, source: 'none', schemaVersion: SCHEMA_VERSION };
      return { ok: false, patches: null, source: 'unreadable', schemaVersion: SCHEMA_VERSION, message: `无法读取 ${filePath}` };
    }
    const primary = parseProfile(primaryRaw);
    if (primary) {
      return {
        ok: true,
        patches: primary.patches,
        source: 'file',
        schemaVersion: typeof primary.schemaVersion === 'number' ? primary.schemaVersion : SCHEMA_VERSION,
      };
    }
    // 主文件损坏 → 回退上次可用快照，而不是把偏好当"没有"。
    const backup = parseProfile(readIfExists(backupPath));
    if (backup) {
      return {
        ok: false,
        patches: backup.patches,
        source: 'backup',
        schemaVersion: typeof backup.schemaVersion === 'number' ? backup.schemaVersion : SCHEMA_VERSION,
        message: '插件偏好文件损坏，已回退到上次可用快照',
      };
    }
    return {
      ok: false,
      patches: null,
      source: 'unreadable',
      schemaVersion: SCHEMA_VERSION,
      message: '插件偏好文件与备份均无法解析',
    };
  }

  function write(patches) {
    // 安全模式拒写：否则"关掉一个插件"就会把用户的真实开关记录覆盖成默认全集。
    if (safe) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    if (!Array.isArray(patches)) return { ok: false, message: 'patches must be an array' };
    const payload = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), patches };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 备份"上一次可用内容"（当前文件），确保回退拿到的是上一个好状态而不是刚写坏的东西。
      const current = readIfExists(filePath);
      if (current !== null && parseProfile(current)) fs.writeFileSync(backupPath, current);
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
      return { ok: true, count: patches.length };
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 清空用户偏好层（对应设置页的「恢复默认」）：文件移除，但保留备份以便撤销。 */
  function clear() {
    if (safe) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    try {
      const current = readIfExists(filePath);
      if (current !== null) fs.writeFileSync(backupPath, current);
      fs.rmSync(filePath, { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { filePath, backupPath, safeMode: safe, read, write, clear };
}

module.exports = { createPluginProfileStore, SCHEMA_VERSION };
