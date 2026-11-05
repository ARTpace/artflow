/**
 * configStore.cjs —— 用户级配置的宿主侧落盘（userData/config/<name>.json）。
 *
 * 这是 main/pluginProfileStore.cjs 的通用化：从「一个文件解决一类偏好」推广成
 * 「一个通用 store 解决全部用户数据」。存在理由与它同源 —— localStorage 是**按 origin
 * 隔离**的（dev :4002 / 直跑 vite / 打包 file:// 各一份），且渲染层异步刷盘、多实例互抢
 * 同一份 leveldb。用户数据必须由主进程以文件持有，与 origin 无关。
 *
 * 文件形状（单文件卷，名字看不出内容，值全部住在 values 里）：
 *   { schemaVersion: 1, updatedAt: "2026-10-09T…", values: { "general.language": "zho" } }
 *
 * 三条不可破的语义（pluginProfileStore 已验证，这里固化成本模块的契约）：
 *  1. **同步**：调用方（渲染层 persistLayer / 模块级初始化）是同步契约，写失败必须同步
 *     返回 ok:false —— 不能变成一个没人 await 的 Promise 然后静默丢失。
 *  2. **备份优先于重置**：主文件损坏 → 回退 .backup；**绝不**静默重置成 defaults。
 *     （"关掉的插件重启又自己开了" 的元凶正是这种静默重置。）
 *  3. **降级可见**：任何回退都带 degraded + message，由调用方写进 logs/electron.log
 *     并在设置页提示，而不是只在渲染层 console 里打一行没人看见的日志。
 */

const fs = require('node:fs');
const path = require('node:path');

const { SAFE_MODE_READ_MESSAGE, SAFE_MODE_WRITE_REJECTED } = require('./safeMode.cjs');

const MAX_KEY_LENGTH = 120;
const MAX_STRING_LENGTH = 100_000;
const MAX_ARRAY_LENGTH = 5_000;
const MAX_DEPTH = 12;
/** 原型链相关键名一律拒绝：values 会被展开进普通对象，`__proto__` 会造成原型污染。 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 只接受能无损往返 JSON 的值；undefined / 函数 / symbol / bigint / Date 一律拒绝。 */
function isStorableValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string') return value.length <= MAX_STRING_LENGTH;
  if (type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_ARRAY_LENGTH && value.every(item => isStorableValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.keys(value).every(key => !RESERVED_KEYS.has(key) && isStorableValue(value[key], depth + 1));
  }
  return false;
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH
    || !KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
    throw new Error(`invalid config key: ${String(key)}`);
  }
  return key;
}

/** 只接受 { schemaVersion, values:{} } 形状；多余字段被忽略（向前兼容）。 */
function parseEnvelope(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !isPlainObject(value.values)) return null;
  if (value.schemaVersion !== undefined && !Number.isInteger(value.schemaVersion)) return null;
  return value;
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 值级编解码（secrets 卷的 OS 钥匙串加密就挂在这里）。缺省 = 恒等，亦即"这个卷不加密"。
 * 做成**值级**而不是整篇文件级：整篇加密会让 `stats()` 连键名都数不出来，
 * 而"存储管理面板"恰恰要展示键数与字节数。
 */
function normalizeValueCodec(spec) {
  if (spec === undefined || spec === null) return null;
  if (!isPlainObject(spec)) throw new Error('valueCodec 必须是普通对象');
  if (typeof spec.encode !== 'function' || typeof spec.decode !== 'function') {
    throw new Error('valueCodec 必须同时提供 encode 与 decode 函数');
  }
  return { encode: spec.encode, decode: spec.decode };
}

/**
 * @param {object} options
 * @param {string} options.filePath           目标文件（父目录会自动创建）
 * @param {number} [options.schemaVersion=1]  当前代码支持的版本
 * @param {(values: object, from: number, to: number) => object} [options.migrate]
 *        旧版本文件的迁移函数；返回新的 values。抛错 → 保留原值并标记 degraded。
 * @param {boolean} [options.safeMode=false]
 *        「工厂启动」（`ARTFLOW_SAFE_MODE=1`，见 `main/safeMode.cjs`）：读侧一律返回空 values，
 *        写侧一律拒绝。**不删文件** —— 去掉环境变量正常启动即完全恢复。
 * @param {{encode: (value: unknown, key: string) => unknown, decode: (value: unknown, key: string) => unknown}} [options.valueCodec]
 *        值级编解码（secrets 卷用它接 OS 钥匙串）。缺省恒等。
 * @param {boolean} [options.restrictPermissions=false]
 *        写入后把文件权限收成 `0600`（仅所有者可读写）。POSIX 上有效；Windows 上
 *        Node 的 chmod 几乎无实际效果 —— 那边靠的是 `safeStorage` 的 DPAPI 加密，不是 ACL。
 *        失败不阻断写入（收紧权限是加固，不是正确性前提）。
 */
function createConfigStore({ filePath, schemaVersion = 1, migrate, safeMode = false, valueCodec, restrictPermissions = false } = {}) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createConfigStore needs a filePath');
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('schemaVersion must be a positive integer');
  }
  if (migrate !== undefined && typeof migrate !== 'function') {
    throw new Error('migrate must be a function when provided');
  }
  const codec = normalizeValueCodec(valueCodec);
  const safe = safeMode === true;

  const backupPath = `${filePath}.backup`;
  const tempPath = `${filePath}.tmp`;

  const envelope = values => ({ schemaVersion, updatedAt: new Date().toISOString(), values });

  /**
   * 磁盘快照（不做安全模式短路、**不做 codec 解码**）。内部一致性检查要用**真实**内容，
   * 否则安全模式会把"文件来自更高版本"这类信息一起吞掉。
   * @returns {{ ok: boolean, values: object, source: 'file'|'backup'|'none'|'unreadable',
   *             schemaVersion: number, degraded: boolean, message?: string, migratedFrom?: number }}
   */
  function readRawFile() {
    const primaryRaw = readIfExists(filePath);
    if (primaryRaw === null) {
      // 区分「从没写过」（正常首启）与「存在但读不出来」（必须告警）。
      if (!fs.existsSync(filePath)) {
        return { ok: true, values: {}, source: 'none', schemaVersion, degraded: false };
      }
      return {
        ok: false, values: {}, source: 'unreadable', schemaVersion, degraded: true,
        message: `无法读取 ${filePath}`,
      };
    }

    const primary = parseEnvelope(primaryRaw);
    if (primary) {
      const fileVersion = primary.schemaVersion === undefined ? schemaVersion : primary.schemaVersion;
      // 文件来自更新的版本：值读得出来，但拒绝写回，避免旧版把新版配置降级覆盖。
      if (fileVersion > schemaVersion) {
        return {
          ok: false, values: primary.values, source: 'file', schemaVersion: fileVersion, degraded: true,
          message: `配置文件版本 ${fileVersion} 高于当前支持的 ${schemaVersion}，已只读载入`,
        };
      }
      if (fileVersion < schemaVersion && migrate) {
        try {
          const migrated = migrate(primary.values, fileVersion, schemaVersion);
          return {
            ok: true,
            values: isPlainObject(migrated) ? migrated : primary.values,
            source: 'file', schemaVersion, degraded: false, migratedFrom: fileVersion,
          };
        } catch (error) {
          return {
            ok: false, values: primary.values, source: 'file', schemaVersion: fileVersion, degraded: true,
            message: `配置迁移失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      return { ok: true, values: primary.values, source: 'file', schemaVersion: fileVersion, degraded: false };
    }

    // 主文件损坏 → 回退上次可用快照，而不是把用户数据当"没有"。
    const backup = parseEnvelope(readIfExists(backupPath));
    if (backup) {
      return {
        ok: false, values: backup.values, source: 'backup', schemaVersion, degraded: true,
        message: '配置文件损坏，已回退到上次可用快照',
      };
    }
    return {
      ok: false, values: {}, source: 'unreadable', schemaVersion, degraded: true,
      message: '配置文件与备份均无法解析',
    };
  }

  /**
   * 解码包装（codec 缺省时直通）。解不开的键**从 `values` 里剔除**（渲染层不该看到密文），
   * 但原文被记进 `preserved` 并在写回时原样并回去 ——
   * 绝不因为"这一次解不开"就把用户的密钥从文件里抹掉（那是不可逆的数据损失）。
   * 典型成因：系统钥匙串被重置 / 换机后 keychain 密钥不同。
   */
  function readFile() {
    const snapshot = readRawFile();
    if (!codec) return { ...snapshot, preserved: {} };
    const values = {};
    const preserved = {};
    const undecodable = [];
    for (const [key, raw] of Object.entries(snapshot.values)) {
      try {
        values[key] = codec.decode(raw, key);
      } catch {
        undecodable.push(key);
        preserved[key] = raw;
      }
    }
    const result = { ...snapshot, values, preserved };
    if (undecodable.length > 0) {
      result.degraded = true;
      const head = snapshot.message ? `${snapshot.message}；` : '';
      result.message = `${head}有 ${undecodable.length} 项密钥无法解密（${undecodable.join(', ')}）`;
    }
    return result;
  }

  /**
   * 对外读取。安全模式下**不消费**用户数据 —— 返回空 values，但**不是**"读失败"：
   * `source: 'safe-mode'` 且 `degraded: false`，因为它一切正常，只是刻意忽略。
   * （若把它标成 degraded，就会在设置页弹出一条"配置异常"告警，误导用户去修一个没坏的东西。）
   */
  function read() {
    if (safe) {
      return {
        ok: true, values: {}, source: 'safe-mode', schemaVersion,
        degraded: false, message: SAFE_MODE_READ_MESSAGE,
      };
    }
    return readFile();
  }

  function writeEnvelope(values, preserved = {}) {
    let stored = values;
    if (codec) {
      // preserved 里的值**已经是密文**（这次解不开的那些），再 encode 一次就是双重加密。
      stored = { ...preserved };
      for (const [key, value] of Object.entries(values)) {
        if (Object.prototype.hasOwnProperty.call(preserved, key)) continue;
        try {
          stored[key] = codec.encode(value, key);
        } catch (error) {
          return { ok: false, message: `配置加密失败（${key}）：${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    let serialized;
    try {
      serialized = JSON.stringify(envelope(stored), null, 2);
    } catch (error) {
      return { ok: false, message: `配置序列化失败：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    // 备份「上一次可用内容」（当前文件），保证回退拿到的是上一个好状态，而不是刚写坏的东西。
    const current = readIfExists(filePath);
    if (current !== null && parseEnvelope(current)) {
      try { fs.writeFileSync(backupPath, current); } catch { /* 备份失败不阻断写入 */ }
    }
    try {
      fs.writeFileSync(tempPath, serialized, 'utf8');
      fs.renameSync(tempPath, filePath);
      // 权限收紧：POSIX 上是"别人读不到"，Windows 上是 no-op（那边由 safeStorage 加密兜底）。
      if (restrictPermissions) {
        try { fs.chmodSync(filePath, 0o600); } catch { /* 收紧失败不改变"已写入"这个结论 */ }
      }
      return { ok: true, bytes: Buffer.byteLength(serialized), count: Object.keys(values).length };
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* 清理失败不影响结论 */ }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 读-改-写一体。校验全部键值后再落盘，避免半套写入。 */
  function applyChanges(changes, removeKeys) {
    // 安全模式一律拒写：一次"顺手保存"就会覆盖用户的真实配置，而那是不可逆的。
    // 这里返回 ok:false 而不是静默成功 —— 界面据此显式提示"安全模式下不保存"。
    if (safe) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    for (const [key, value] of changes) {
      try {
        assertKey(key);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (value === undefined) {
        return { ok: false, message: `值不可序列化（undefined）：${key}` };
      }
      if (!isStorableValue(value)) {
        return { ok: false, message: `值必须是 JSON 可序列化的原始值或普通对象：${key}` };
      }
    }
    const snapshot = readFile();
    // 只读态（文件版本更新 / 不可读）拒绝写入，避免用不完整的内存态覆盖磁盘。
    if (snapshot.schemaVersion > schemaVersion) return { ok: false, message: snapshot.message };
    if (!snapshot.ok && snapshot.source === 'unreadable' && snapshot.message?.includes('均无法解析')) {
      return { ok: false, message: '配置文件不可读，拒绝覆盖（请先人工检查该文件）' };
    }
    const next = { ...snapshot.values };
    const preserved = { ...(snapshot.preserved ?? {}) };
    for (const key of removeKeys) {
      delete next[key];
      // 解不开的键只在 preserved 里 —— 用户点"删除/清空"时不把它带回来。
      delete preserved[key];
    }
    for (const [key, value] of changes) next[key] = value;
    return writeEnvelope(next, preserved);
  }

  return {
    filePath,
    backupPath,
    schemaVersion,
    safeMode: safe,
    read,
    set: (key, value) => applyChanges([[key, value]], []),
    patch: values => {
      if (!isPlainObject(values)) return { ok: false, message: 'patch 需要一个普通对象' };
      return applyChanges(Object.entries(values), []);
    },
    /** 不给 keys 则清空整个 values（回到 defaults）；给了则只删这些键。写前照例备份，可撤销。 */
    reset: keys => {
      if (keys === undefined) {
        const snapshot = readFile();
        // 连"解不开、原文暂存"的那些键一起清 —— 否则「恢复默认」会留下一个删不掉的尾巴。
        return applyChanges([], [...Object.keys(snapshot.values), ...Object.keys(snapshot.preserved ?? {})]);
      }
      if (!Array.isArray(keys)) return { ok: false, message: 'reset 的 keys 必须是数组' };
      return applyChanges([], keys);
    },
    stats() {
      // 诊断口径：报**磁盘上的真相**，而不是本会话消费到的值 ——
      // 安全模式下这两者刻意不同（读了 0 个键，但文件里可能躺着 200 个）。
      const snapshot = readFile();
      let bytes = 0;
      let updatedAt = null;
      // 键数优先取磁盘原文：codec 卷里有解不开的键时，它们不在已解码的 values 里，
      // 但"文件里有几个键"这件事与能不能解开无关。
      let keyCount = Object.keys(snapshot.values).length + Object.keys(snapshot.preserved ?? {}).length;
      try {
        bytes = fs.statSync(filePath).size;
        const parsed = parseEnvelope(readIfExists(filePath));
        if (parsed) {
          updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
          keyCount = Object.keys(parsed.values).length;
        }
      } catch { /* 文件不存在时保持 0 / null */ }
      return {
        filePath,
        exists: fs.existsSync(filePath),
        bytes,
        keyCount,
        schemaVersion: snapshot.schemaVersion,
        source: snapshot.source,
        degraded: snapshot.degraded,
        updatedAt,
        safeMode: safe,
        encrypted: codec !== null,
      };
    },
  };
}

module.exports = { createConfigStore, isStorableValue, RESERVED_KEYS };
