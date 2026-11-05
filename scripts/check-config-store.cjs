/**
 * check-config-store —— 用户级配置存储（主进程文件 + 渲染层 store）的回归守卫。
 *
 * 守护的是「用户数据不该按 origin 隔离、也不该静默回默认」这条线。四条关键不变量：
 *  1. 宿主桥可用时，渲染层偏好**只**读写宿主文件，localStorage 不参与运行期读写。
 *  2. 旧 localStorage 键**只采纳一次**，采纳后清空宿主不能被旧值复活。
 *  3. 宿主文件损坏时回退**上次可用快照**，绝不退化成"空配置"（空配置在消费方语义是默认值）。
 *  4. 写失败必须**同步抛出并回滚内存值** —— 否则界面显示已改、磁盘没改，重启就复活。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../main/configStore.cjs');

const PREFERENCES_MODULE = '../plugin-runtime/preferences-store.ts';
const SECRETS_MODULE = '../plugin-runtime/secrets-store.ts';

const tempDirs = [];
const makeTempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeMemoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0, getKeys: [], setKeys: [] };
  return {
    map,
    calls,
    getItem: key => {
      calls.get += 1;
      calls.getKeys.push(key);
      return map.has(key) ? map.get(key) : null;
    },
    setItem: (key, value) => {
      calls.set += 1;
      calls.setKeys.push(key);
      map.set(key, String(value));
    },
    removeItem: key => { map.delete(key); },
  };
};

/** 宿主桥：直接接真实的主进程存储模块（临时目录），两层一起验。 */
const makeStores = () => {
  const dir = makeTempDir('artflow-config-');
  return {
    dir,
    preferences: createConfigStore({ filePath: path.join(dir, 'preferences.json'), schemaVersion: 1 }),
    secrets: createConfigStore({ filePath: path.join(dir, 'secrets.json'), schemaVersion: 1 }),
  };
};

const makeBridge = (stores, overrides = {}) => ({
  readPreferences: () => stores.preferences.read(),
  readSecrets: () => stores.secrets.read(),
  setPreference: (key, value) => stores.preferences.set(key, value),
  patchPreferences: values => stores.preferences.patch(values),
  resetPreferences: keys => stores.preferences.reset(Array.isArray(keys) ? keys : []),
  clearPreferences: () => stores.preferences.reset(),
  setSecret: (key, value) => stores.secrets.set(key, value),
  removeSecret: key => stores.secrets.reset([key]),
  stats: store => (store === 'secrets' ? stores.secrets.stats() : stores.preferences.stats()),
  reportBoot: () => {},
  ...overrides,
});

/** 重新装载渲染层 store：它们有模块级副作用（首帧前就要读到快照），必须换一轮模块缓存。 */
const loadRendererStore = (modulePath, { bridge, storage }) => {
  globalThis.window = bridge ? { artflowConfig: bridge } : {};
  globalThis.localStorage = storage;
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
};

try {
  // —— 1. 主进程内核：备份优先于重置 ——
  {
    const { preferences } = makeStores();
    assert.equal(preferences.read().ok, true, '首次读取应 ok');
    assert.equal(preferences.read().source, 'none', '首次读取来源应为 none');

    assert.equal(preferences.set('general.language', 'zho').ok, true);
    assert.equal(preferences.set('canvas.gridStyle', 'dot').ok, true);
    assert.deepEqual(preferences.read().values, { 'general.language': 'zho', 'canvas.gridStyle': 'dot' });

    // 损坏主文件：必须回退 .backup（= 上一个好状态），而不是返回空配置。
    fs.writeFileSync(preferences.filePath, '{ broken json');
    const recovered = preferences.read();
    assert.equal(recovered.source, 'backup', '主文件损坏应回退到备份');
    assert.equal(recovered.ok, false, '回退必须被标记为 degraded');
    assert.equal(recovered.degraded, true);
    assert.equal(recovered.values['general.language'], 'zho', '备份里应有上一个好状态');
  }

  // —— 2. 主进程内核：版本护栏与键值校验 ——
  {
    const { preferences } = makeStores();
    fs.writeFileSync(preferences.filePath, JSON.stringify({ schemaVersion: 99, values: { future: 1 } }));
    const ahead = preferences.read();
    assert.equal(ahead.ok, false, '更高版本的文件必须只读载入');
    assert.equal(ahead.values.future, 1, '更高版本的值仍应可读');
    assert.equal(preferences.set('x', 1).ok, false, '不得用旧版覆盖更高版本配置');

    fs.writeFileSync(preferences.filePath, JSON.stringify({ schemaVersion: 1, values: {} }));
    assert.equal(preferences.set('__proto__', 1).ok, false, '__proto__ 必须被拒绝');
    assert.equal(preferences.set('a.b', undefined).ok, false, 'undefined 值必须被拒绝');
    assert.equal(preferences.set('a.b', Number.NaN).ok, false, 'NaN 必须被拒绝');
    assert.equal(preferences.set('a.b', () => {}).ok, false, '函数值必须被拒绝');
    assert.deepEqual(preferences.read().values, {}, '被拒的写入不得留下痕迹');
  }

  // —— 3. 主进程内核：迁移与 reset ——
  {
    const dir = makeTempDir('artflow-config-migrate-');
    const filePath = path.join(dir, 'preferences.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, values: { legacyKey: 'v' } }));
    const migratedStore = createConfigStore({
      filePath,
      schemaVersion: 2,
      migrate: values => ({ newKey: values.legacyKey }),
    });
    const snapshot = migratedStore.read();
    assert.equal(snapshot.migratedFrom, 1);
    assert.deepEqual(snapshot.values, { newKey: 'v' });

    assert.equal(migratedStore.reset(['newKey']).ok, true);
    assert.deepEqual(migratedStore.read().values, {});
    assert.equal(migratedStore.reset().ok, true, '全量 reset 也应成功');
  }

  // —— 4. 渲染层：桥可用时偏好读写只走宿主文件，localStorage 仅用于启动期旧键探测 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage({ language: 'en', 'artflow.prefs.v1': '{"stale":true}' });
    stores.preferences.set('general.language', 'zho'); // 宿主已有正式键
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: makeBridge(stores), storage });

    assert.equal(grep.preferencesBackendSource(), 'host-file');
    assert.equal(grep.getPreference('general.language', 'fallback'), 'zho', '宿主里的值优先于旧键');
    assert.equal(storage.map.get('language'), 'en', '宿主已有值时不得回写 / 覆盖旧 localStorage 键');
    assert.equal(storage.map.get('artflow.prefs.v1'), '{"stale":true}', '回退卷不得被宿主模式写坏');
    // 唯一允许写 localStorage 的是"旧键已处理"标记；业务键绝不经浏览器存储。
    assert.deepEqual(
      [...new Set(storage.calls.setKeys)],
      ['artflow.prefs.legacy-adopted.v1'],
      '宿主桥可用时，写入 localStorage 只允许写采纳标记',
    );
  }

  // —— 5. 渲染层：旧键一次性采纳（宿主为空 → 采纳 → 落盘成正式键 → 旧值不再复活） ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage({ language: 'en' });
    const bridge = makeBridge(stores);
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge, storage });

    assert.equal(grep.getPreference('general.language', ''), 'en', '须采纳旧 localStorage 值');
    assert.equal(
      stores.preferences.read().values['general.language'],
      'en',
      '采纳结果必须立刻落盘成正式键',
    );

    // 采纳只做一次（靠 localStorage 里的标记）：清空宿主后重启，旧键不得再次复活。
    stores.preferences.reset();
    const restarted = loadRendererStore(PREFERENCES_MODULE, { bridge, storage });
    assert.equal(
      restarted.getPreference('general.language', 'zho'),
      'zho',
      '采纳过一次后，旧 localStorage 键不得把用户已放弃的值推回来',
    );
    assert.equal(restarted.preferencesBackendSource(), 'host-file');
  }

  // —— 6. 渲染层：写失败必须同步抛出并回滚内存值 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage();
    const failing = makeBridge(stores, {
      setPreference: () => ({ ok: false, message: 'disk full' }),
    });
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: failing, storage });

    assert.equal(grep.getPreference('canvas.gridStyle', 'line'), 'line', '初始应为默认值');
    assert.throws(() => grep.setPreference('canvas.gridStyle', 'dot'), /disk full/);
    assert.equal(
      grep.getPreference('canvas.gridStyle', 'line'),
      'line',
      '写失败必须回滚内存值，不得留下"界面已改、磁盘没改"的假成功',
    );
  }

  // —— 7. 渲染层：桥不可用（纯浏览器）时回退 localStorage 卷 ——
  {
    const storage = makeMemoryStorage();
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: null, storage });

    assert.equal(grep.preferencesBackendSource(), 'local-storage-fallback');
    grep.setPreference('canvas.gridStyle', 'cross');
    assert.equal(grep.getPreference('canvas.gridStyle', 'line'), 'cross');
    const persisted = JSON.parse(storage.map.get('artflow.prefs.v1'));
    assert.equal(persisted['canvas.gridStyle'], 'cross', '回退卷里应有写入的值');

    const reloaded = loadRendererStore(PREFERENCES_MODULE, { bridge: null, storage });
    assert.equal(reloaded.getPreference('canvas.gridStyle', 'line'), 'cross', '回退卷应能往返');
  }

  // —— 8. 密钥卷：与偏好分卷，旧键采纳，绝不落偏好卷 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage({ geminiApiKey: 'legacy-key-value' });
    const secrets = loadRendererStore(SECRETS_MODULE, { bridge: makeBridge(stores), storage });

    assert.equal(secrets.secretsBackendSource(), 'host-file');
    assert.equal(secrets.readSecret('ai.geminiApiKey'), 'legacy-key-value', '须采纳旧 localStorage 密钥');
    assert.equal(stores.secrets.read().values['ai.geminiApiKey'], 'legacy-key-value', '采纳须落盘到密钥卷');
    assert.deepEqual(
      stores.preferences.read().values,
      {},
      '密钥绝不能写进偏好卷（导出预设时不得带出密钥）',
    );

    secrets.writeSecret('ai.geminiApiKey', 'new-key');
    assert.equal(stores.secrets.read().values['ai.geminiApiKey'], 'new-key');
    assert.deepEqual(secrets.listSecretKeys(), ['ai.geminiApiKey']);

    secrets.clearSecret('ai.geminiApiKey');
    assert.equal(secrets.readSecret('ai.geminiApiKey'), null);
    assert.equal(stores.secrets.read().values['ai.geminiApiKey'], undefined);
  }

  // —— 9. 偏好预设：只接受纯 JSON，replace 先清空 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage();
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: makeBridge(stores), storage });

    grep.setPreference('canvas.gridStyle', 'dot');
    grep.setPreference('general.language', 'zho');
    const exported = grep.exportPreferences();

    grep.setPreference('canvas.gridStyle', 'line');
    grep.importPreferences(exported, 'replace');
    assert.equal(grep.getPreference('canvas.gridStyle', 'line'), 'dot', 'replace 导入应恢复预设值');
    assert.equal(stores.preferences.read().values['canvas.gridStyle'], 'dot');

    assert.throws(() => grep.importPreferences('{ not json', 'merge'), /合法 JSON/);
    assert.throws(() => grep.importPreferences('[1,2,3]', 'merge'), /JSON 对象/);
    assert.throws(() => grep.importPreferences('{}', 'merge'), /没有可导入的键/);
  }

  console.log('config store checks: ok');
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  delete globalThis.window;
  delete globalThis.localStorage;
}
