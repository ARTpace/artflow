/**
 * check-preference-storage —— 通用 Storage 适配器的回归守卫。
 *
 * 适配器的价值是"让既有以 `Pick<Storage, ...>` 为注入契约的模块**零内部改动**搬到主进程文件"，
 * 所以这里守的正是"换后端之后行为与 Storage 语义一致"：
 *  1. 读写往返：对象 / 数组 / 数字 / 布尔 / 裸字符串，读回与写前一致。
 *  2. 结构化存盘：JSON 值以结构化形式落在偏好卷里（可读、可手改），不是转义字符串。
 *  3. 旧键一次性采纳：宿主为空时从 localStorage 取，落盘成正式键。
 *  4. 采纳只一次：清空偏好卷后重启，旧键**不得**把用户已放弃的值推回来。
 *  5. removeItem 回到 fallback。
 *  6. 前缀映射（`bp-skin-config.<id>` → `appearance.skinConfig.<id>`）。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../main/configStore.cjs');

const STORE_MODULES = [
  '../plugin-runtime/legacy-adoption-marker.ts',
  '../plugin-runtime/preferences-store.ts',
  '../plugin-runtime/preference-storage.ts',
];

const tempDirs = [];
const makeStores = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-prefstorage-'));
  tempDirs.push(dir);
  return {
    dir,
    preferences: createConfigStore({ filePath: path.join(dir, 'preferences.json'), schemaVersion: 1 }),
  };
};

const makeMemoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
};

const makeBridge = stores => ({
  readPreferences: () => stores.preferences.read(),
  readSecrets: () => ({ ok: true, values: {}, source: 'none' }),
  setPreference: (key, value) => stores.preferences.set(key, value),
  patchPreferences: values => stores.preferences.patch(values),
  resetPreferences: keys => stores.preferences.reset(Array.isArray(keys) ? keys : []),
  clearPreferences: () => stores.preferences.reset(),
  setSecret: () => ({ ok: true }),
  removeSecret: () => ({ ok: true }),
  stats: () => stores.preferences.stats(),
  reportBoot: () => {},
});

/** 重新装载渲染层模块：它们都有模块级副作用，必须换一轮模块缓存。 */
const loadAdapterModule = (bridge, storage) => {
  globalThis.window = bridge ? { artflowConfig: bridge } : {};
  globalThis.localStorage = storage;
  for (const modulePath of STORE_MODULES) delete require.cache[require.resolve(modulePath)];
  return require('../plugin-runtime/preference-storage.ts');
};

try {
  // —— 1. 往返：对象 / 数组 / 数字 / 布尔 / 裸字符串 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage();
    const { createPreferenceStorage } = loadAdapterModule(makeBridge(stores), storage);
    const view = createPreferenceStorage({ namespace: 'test.kv' });

    assert.equal(view.getItem('missing'), null, '缺省必须返回 null（与 Storage 语义一致）');

    view.setItem('obj', JSON.stringify({ gridVisible: true, gridSize: 32 }));
    assert.equal(view.getItem('obj'), '{"gridVisible":true,"gridSize":32}');

    view.setItem('arr', JSON.stringify(['local.a', 'local.b']));
    assert.equal(view.getItem('arr'), '["local.a","local.b"]');

    view.setItem('num', '1');
    assert.equal(view.getItem('num'), '1', '数字字符串往返不得变成别的样子');

    view.setItem('flag', '0');
    assert.equal(view.getItem('flag'), '0');

    view.setItem('raw', 'hello');
    assert.equal(view.getItem('raw'), 'hello', '裸字符串必须原样往返');

    // 结构化存盘：偏好卷里应是对象/数组，而不是被转义的字符串。
    const values = stores.preferences.read().values;
    assert.deepEqual(values['test.kv.obj'], { gridVisible: true, gridSize: 32 }, 'JSON 对象应结构化存盘');
    assert.deepEqual(values['test.kv.arr'], ['local.a', 'local.b'], 'JSON 数组应结构化存盘');
    assert.equal(values['test.kv.num'], 1, '可解析的数字应存成 number');
    assert.equal(values['test.kv.raw'], 'hello', '裸字符串按原样存');
  }

  // —— 2. removeItem 回到 fallback ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage();
    const { createPreferenceStorage } = loadAdapterModule(makeBridge(stores), storage);
    const view = createPreferenceStorage({ namespace: 'test.kv' });

    view.setItem('a', JSON.stringify({ x: 1 }));
    assert.equal(stores.preferences.read().values['test.kv.a'] !== undefined, true);
    view.removeItem('a');
    assert.equal(view.getItem('a'), null, 'removeItem 后应回到 fallback');
    assert.equal(stores.preferences.read().values['test.kv.a'], undefined);
  }

  // —— 3. 旧键一次性采纳：宿主为空 → 从 localStorage 取 → 落盘 ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage({ 'bp-skin-state': JSON.stringify({ skinId: 'builtin.skin-dark' }) });
    const { createPreferenceStorage } = loadAdapterModule(makeBridge(stores), storage);
    const view = createPreferenceStorage({ namespace: 'appearance.skinState' });

    assert.equal(view.getItem('bp-skin-state'), '{"skinId":"builtin.skin-dark"}', '须采纳旧 localStorage 值');
    assert.deepEqual(
      stores.preferences.read().values['appearance.skinState.bp-skin-state'],
      { skinId: 'builtin.skin-dark' },
      '采纳结果必须立刻结构化落盘',
    );

    // 采纳只做一次：清空偏好卷后重启，旧键不得复活。
    stores.preferences.reset();
    const restarted = loadAdapterModule(makeBridge(stores), storage);
    const view2 = restarted.createPreferenceStorage({ namespace: 'appearance.skinState' });
    assert.equal(
      view2.getItem('bp-skin-state'),
      null,
      '采纳过一次后，旧 localStorage 键不得把用户已放弃的值推回来',
    );
  }

  // —— 4. 前缀映射：bp-skin-config.<id> → appearance.skinConfig.<id> ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage();
    const { createPrefixedPreferenceStorage } = loadAdapterModule(makeBridge(stores), storage);
    const view = createPrefixedPreferenceStorage('bp-skin-config.', 'appearance.skinConfig');

    view.setItem('bp-skin-config.builtin.skin-dark', JSON.stringify({ showGlow: false }));
    assert.equal(view.getItem('bp-skin-config.builtin.skin-dark'), '{"showGlow":false}');
    assert.deepEqual(
      stores.preferences.read().values['appearance.skinConfig.builtin.skin-dark'],
      { showGlow: false },
      '动态皮肤配置应按前缀映射成稳定的 prefKey',
    );
  }

  // —— 5. 关掉采纳：adoptLegacy=false 时不读 localStorage ——
  {
    const stores = makeStores();
    const storage = makeMemoryStorage({ legacy: '{"a":1}' });
    const { createPreferenceStorage } = loadAdapterModule(makeBridge(stores), storage);
    const view = createPreferenceStorage({ namespace: 'test.kv', adoptLegacy: false });

    assert.equal(view.getItem('legacy'), null, '关闭采纳后不得读旧键');
    assert.equal(stores.preferences.read().values['test.kv.legacy'], undefined);
  }

  // —— 6. 桥不可用（纯浏览器）：适配器退化为 localStorage 卷，不抛错 ——
  {
    const storage = makeMemoryStorage();
    const { createPreferenceStorage } = loadAdapterModule(null, storage);
    const view = createPreferenceStorage({ namespace: 'test.kv' });

    view.setItem('a', JSON.stringify({ x: 2 }));
    assert.equal(view.getItem('a'), '{"x":2}', '无桥时仍应能读写（走 localStorage 回退卷）');
  }

  console.log('preference storage checks: ok');
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  delete globalThis.window;
  delete globalThis.localStorage;
}
