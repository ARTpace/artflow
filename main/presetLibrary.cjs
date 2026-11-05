/**
 * presetLibrary.cjs —— 设置预设的导出 / 导入（对标 Blender 的 `presets/` 目录）。
 *
 * 价值场景：换机迁移、出问题前留一份"能用的配置"、把一套调好的外观/快捷键分享出去。
 *
 * 文件形状（自描述，便于人工看懂与手工编辑）：
 *   {
 *     "kind": "artflow.preset",
 *     "schemaVersion": 1,
 *     "exportedAt": "2026-10-09T…",
 *     "app": { "version": "…" },                 // 只做记录，不在导入时做强校验
 *     "volumes": { "preferences": {…}, "workspace": {…} }   // 卷名 → values
 *   }
 *
 * 安全性：
 *  - 预设名过白名单正则（**不接受路径分隔符**），从根上排除路径穿越；
 *  - 导入时只接受 `kind` 匹配且 `volumes` 是普通对象的文件，单文件体积有上限；
 *  - 本模块只负责"目录内的读写"，弹文件对话框属于 main.cjs 的 UI 职责。
 */

const fs = require('node:fs');
const path = require('node:path');

const PRESET_KIND = 'artflow.preset';
const PRESET_SCHEMA_VERSION = 1;
const MAX_NAME_LENGTH = 64;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 预设是"配置"，不是"素材"：超过 2MB 基本可以断定选错了文件。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function assertName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    throw new Error('预设名只能包含字母/数字/._-，且不超过 64 个字符');
  }
  return name;
}

const readJson = filePath => {
  if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('预设文件过大（>2MB）');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

function createPresetLibrary({ dirPath } = {}) {
  if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
    throw new Error('createPresetLibrary needs a dirPath');
  }
  const fileOf = name => path.join(dirPath, `${assertName(name)}.json`);

  /** 目录内的预设清单。单个文件读坏了只跳过它，不影响其它预设。 */
  function list() {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return { ok: true, presets: [] };
    }
    const presets = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const name = entry.name.slice(0, -'.json'.length);
      if (!NAME_PATTERN.test(name)) continue;
      const filePath = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(filePath);
        const document = readJson(filePath);
        // 只认自己写出去的形状：目录里被用户塞进来的普通 JSON 不该出现在"预设库"里
        // —— 列出来就等于邀请用户去点一个必然失败的"应用"。
        if (!isPlainObject(document) || document.kind !== PRESET_KIND) continue;
        presets.push({
          name,
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
          volumes: isPlainObject(document.volumes) ? Object.keys(document.volumes) : [],
          exportedAt: typeof document.exportedAt === 'string' ? document.exportedAt : null,
        });
      } catch { /* 坏文件不进清单（它仍在磁盘上，用户可自行处理） */ }
    }
    presets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { ok: true, presets };
  }

  /** 写一份预设。`volumes` 由调用方（main.cjs）从各存储卷取，本模块不碰存储层。 */
  function write(name, volumes, appVersion) {
    try {
      assertName(name);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!isPlainObject(volumes) || Object.keys(volumes).length === 0) {
      return { ok: false, message: '预设内容为空：没有可导出的配置' };
    }
    const document = {
      kind: PRESET_KIND,
      schemaVersion: PRESET_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: { version: typeof appVersion === 'string' ? appVersion : null },
      volumes,
    };
    const filePath = fileOf(name);
    const tempPath = `${filePath}.tmp`;
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const serialized = JSON.stringify(document, null, 2);
      if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) return { ok: false, message: '预设过大（>2MB）' };
      fs.writeFileSync(tempPath, serialized, 'utf8');
      fs.renameSync(tempPath, filePath);
      return { ok: true, filePath, bytes: Buffer.byteLength(serialized) };
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* 清理失败不影响结论 */ }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 读回一份预设。形状不对就明确拒绝，不让半截数据进到存储层。 */
  function read(name) {
    let filePath;
    try {
      filePath = fileOf(name);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    let document;
    try {
      document = readJson(filePath);
    } catch (error) {
      return { ok: false, message: `无法读取预设：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isPlainObject(document) || document.kind !== PRESET_KIND) {
      return { ok: false, message: '不是 Artflow 预设文件（kind 不匹配）' };
    }
    if (!isPlainObject(document.volumes)) {
      return { ok: false, message: '预设内容缺失（volumes 不是对象）' };
    }
    return { ok: true, document };
  }

  function remove(name) {
    try {
      fs.rmSync(fileOf(name), { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { dirPath, list, write, read, remove };
}

module.exports = { createPresetLibrary, PRESET_KIND, PRESET_SCHEMA_VERSION, MAX_FILE_BYTES };
