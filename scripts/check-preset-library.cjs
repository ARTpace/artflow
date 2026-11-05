/**
 * check-preset-library —— 设置预设（`config/presets/`）与密钥加固（`secrets.json`）的回归守卫。
 *
 * 两块都直接碰用户的**可分享数据**与**敏感数据**，各有一组不许退化的性质：
 *
 *  预设（main/presetLibrary.cjs）
 *   A. **名称白名单**：不接受路径分隔符 —— 从根上排除路径穿越（预设名来自用户输入）。
 *   B. **自描述格式**：`kind` 不匹配的文件一律拒绝，不让半截 JSON 流进存储层。
 *   C. 全流程可用：write → list → read → remove。
 *
 *  密钥（main/secretCodec.cjs + configStore 的 valueCodec）
 *   D. **加密不可用时拒绝写入**，绝不静默写明文（用户以为加密了、其实没有，是最坏的结局）。
 *   E. **明文向后兼容**：无 `enc:v1:` 前缀的旧值直通 —— P1/P2 写下的 secrets.json 必须还能读。
 *   F. **解不开的值不许丢**：钥匙串变更后 decode 失败，原文被 preserved 保留并在写回时原样并回，
 *      否则用户一次普通保存就把密钥从文件里抹掉了（不可逆）。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../main/configStore.cjs');
const { createPresetLibrary, PRESET_KIND } = require('../main/presetLibrary.cjs');
const { createSecretCodec, CIPHER_PREFIX } = require('../main/secretCodec.cjs');

const tempDirs = [];
const makeTempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

/** 假钥匙串：`encryptString` 产出可逆的包装；`broken` 一开，解密一律抛错（模拟换机后 keychain 变更）。 */
const makeFakeSafeStorage = ({ available = true, broken = false } = {}) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(`plain:${text}`, 'utf8'),
  decryptString: buffer => {
    if (broken) throw new Error('decrypt failed');
    const text = buffer.toString('utf8');
    if (!text.startsWith('plain:')) throw new Error('not our ciphertext');
    return text.slice('plain:'.length);
  },
});

try {
  // ================= 预设库 =================

  // —— 1. 名称白名单：路径穿越从根上排除 ——
  {
    const library = createPresetLibrary({ dirPath: makeTempDir('artflow-presets-') });
    for (const bad of ['../escape', 'a/b', 'a\\b', '', '.hidden'.repeat(20), 'x'.repeat(65)]) {
      const result = library.write(bad, { preferences: { a: 1 } });
      assert.equal(result.ok, false, `必须拒绝危险预设名：${JSON.stringify(bad)}`);
    }
    assert.equal(library.read('../escape').ok, false, '读也必须过同一道白名单');
  }

  // —— 2. 全流程：write → list → read → remove ——
  {
    const dir = makeTempDir('artflow-presets-');
    const library = createPresetLibrary({ dirPath: dir });

    assert.deepEqual(library.list().presets, [], '空目录应返回空清单');
    const written = library.write('my-theme', { preferences: { 'general.language': 'zho' }, workspace: { 'panel.board': true } }, '9.9.9');
    assert.equal(written.ok, true);
    assert.equal(fs.existsSync(`${written.filePath}.tmp`), false, '不得留下临时文件');

    const listed = library.list().presets;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'my-theme');
    assert.deepEqual(listed[0].volumes.sort(), ['preferences', 'workspace'], '清单要报出收录了哪些卷');

    const loaded = library.read('my-theme');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.document.kind, PRESET_KIND);
    assert.equal(loaded.document.volumes.preferences['general.language'], 'zho');

    assert.equal(library.remove('my-theme').ok, true);
    assert.deepEqual(library.list().presets, []);
  }

  // —— 3. 自描述校验：不是预设的文件必须拒绝 ——
  {
    const dir = makeTempDir('artflow-presets-');
    const library = createPresetLibrary({ dirPath: dir });
    fs.writeFileSync(path.join(dir, 'foreign.json'), JSON.stringify({ hello: 'world' }), 'utf8');
    const loaded = library.read('foreign');
    assert.equal(loaded.ok, false, 'kind 不匹配必须拒绝');
    assert.match(loaded.message, /不是 Artflow 预设/);
    // 坏文件不进清单（但仍留在磁盘上，用户可自行处理）
    assert.deepEqual(library.list().presets, []);
  }

  // —— 4. 空内容不写成空壳预设 ——
  {
    const library = createPresetLibrary({ dirPath: makeTempDir('artflow-presets-') });
    assert.equal(library.write('empty', {}).ok, false, '没有内容就不该产出预设文件');
  }

  // ================= 密钥加固 =================

  // —— 5. 加密不可用：encode 抛错，**绝不写明文** ——
  {
    const codec = createSecretCodec({ safeStorage: makeFakeSafeStorage({ available: false }) });
    assert.equal(codec.available(), false);
    assert.throws(() => codec.encode('secret-value'), /钥匙串不可用/, '不可用时必须拒绝加密（进而拒绝写入）');
    assert.equal(codec.encode(''), '', '空串直通（它本来就不是密钥）');
    assert.equal(codec.describe().scheme, 'plaintext');
  }

  // —— 6. 加密可用：产出带前缀的密文，且**明文不再出现在文件里** ——
  {
    const dir = makeTempDir('artflow-secrets-');
    const store = createConfigStore({
      filePath: path.join(dir, 'secrets.json'),
      schemaVersion: 1,
      valueCodec: createSecretCodec({ safeStorage: makeFakeSafeStorage() }),
    });

    assert.equal(store.set('ai.geminiApiKey', 'super-secret-key').ok, true);
    const onDisk = fs.readFileSync(store.filePath, 'utf8');
    assert.equal(onDisk.includes('super-secret-key'), false, '磁盘上不得出现明文密钥');
    assert.ok(onDisk.includes(CIPHER_PREFIX), '密文必须带自描述前缀');

    assert.equal(store.read().values['ai.geminiApiKey'], 'super-secret-key', '读回必须还原明文');
    assert.equal(store.stats().encrypted, true, '统计要标明该卷启用了加密');
    assert.equal(store.stats().keyCount, 1, '键数按磁盘原文计算');
  }

  // —— 7. 明文向后兼容：无前缀的旧值直通 ——
  {
    const dir = makeTempDir('artflow-secrets-');
    const filePath = path.join(dir, 'secrets.json');
    // 模拟 P1/P2 写下的明文 secrets.json
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      values: { 'ai.geminiApiKey': 'legacy-plain-key' },
    }, null, 2), 'utf8');

    const store = createConfigStore({
      filePath,
      schemaVersion: 1,
      valueCodec: createSecretCodec({ safeStorage: makeFakeSafeStorage() }),
    });
    assert.equal(store.read().values['ai.geminiApiKey'], 'legacy-plain-key', '旧明文必须照读（零迁移）');
    assert.equal(store.read().degraded, false, '明文旧值不是降级');
  }

  // —— 8. 解不开的密钥：原文被保留，写回时原样并回（**绝不许丢**） ——
  {
    const dir = makeTempDir('artflow-secrets-');
    const filePath = path.join(dir, 'secrets.json');
    const working = createSecretCodec({ safeStorage: makeFakeSafeStorage() });
    const seed = createConfigStore({ filePath, schemaVersion: 1, valueCodec: working });
    seed.set('ai.geminiApiKey', 'key-that-will-be-lost');
    seed.set('ai.otherKey', 'another');
    const cipherOnDisk = fs.readFileSync(filePath, 'utf8');

    // 钥匙串变了：解密一律失败。
    const brokenStore = createConfigStore({
      filePath,
      schemaVersion: 1,
      valueCodec: createSecretCodec({ safeStorage: makeFakeSafeStorage({ broken: true }) }),
    });
    const snapshot = brokenStore.read();
    assert.equal(snapshot.values['ai.geminiApiKey'], undefined, '解不开的值不该以密文形式暴露给渲染层');
    assert.equal(snapshot.degraded, true, '解不开必须显式降级（面板上要能看见）');
    assert.match(snapshot.message, /无法解密/);

    // 换一个能解开的钥匙串再写一次：原有密文必须原样还在。
    const repairedStore = createConfigStore({ filePath, schemaVersion: 1, valueCodec: working });
    assert.equal(repairedStore.set('ai.thirdKey', 'third').ok, true);
    const after = JSON.parse(fs.readFileSync(filePath, 'utf8')).values;
    assert.equal(after['ai.geminiApiKey'], JSON.parse(cipherOnDisk).values['ai.geminiApiKey'],
      '解不开的密钥原文必须原样保留，不得被写没');
    assert.equal(after['ai.thirdKey'].startsWith(CIPHER_PREFIX), true, '新写入的照常加密');

    // 清空整卷要连"解不开"的尾巴一起清掉（否则「恢复默认」留一条删不掉的记录）。
    assert.equal(repairedStore.reset().ok, true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf8')).values), []);
  }

  // —— 9. restrictPermissions：POSIX 上收紧到 0600（Windows 上 chmod 近乎 no-op，跳过断言） ——
  {
    const dir = makeTempDir('artflow-secrets-');
    const store = createConfigStore({
      filePath: path.join(dir, 'secrets.json'),
      schemaVersion: 1,
      restrictPermissions: true,
    });
    assert.equal(store.set('a.b', 'value').ok, true, '收紧权限不得影响写入本身');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600, '密钥文件必须是 0600');
    }
  }

  console.log('preset library & secret codec checks: ok');
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
