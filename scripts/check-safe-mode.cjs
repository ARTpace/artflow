/**
 * check-safe-mode —— 「工厂启动」（`ARTFLOW_SAFE_MODE=1`）的回归守卫。
 *
 * 守护的是一条**诊断能力不能反过来变成数据事故**的线。安全模式只有三条语义，但每条都
 * 极易被后来者无意破坏，所以各配一组断言：
 *   A. **读空**：所有用户卷读出空值 → 插件按默认装载、皮肤回默认、语言回默认。
 *      同时「读空」**不等于**「文件坏了」：必须是 `ok:true` + `degraded:false`，
 *      否则设置页会弹一条"配置异常"，把用户引向一个根本没坏的东西。
 *   B. **只读会话**：宿主侧任何写入一律 `ok:false`，**磁盘文件一个字节都不许变**。
 *      渲染层则**不抛错、只改内存** —— 启动期有一批 effect 会把默认值写回一遍，
 *      照旧抛错就会在日志里刷出一串假的 `[启动错误]`，而"拿到一份干净日志"正是安全模式
 *      的全部意义。这不构成"假成功"：横幅已明写"本次改动不会保存"。
 *   C. **不采纳旧键**：偏好卷读空后每个登记键都"缺值"，若不短路，采纳逻辑会把用户真实的
 *      localStorage 值原样搬回来，安全模式当场失效。所以断言不只是"值对不对"，
 *      还要断言**标记没被写下去**（留白给正常启动采纳一次）。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../main/configStore.cjs');
const { createPluginProfileStore } = require('../main/pluginProfileStore.cjs');
const { SAFE_MODE_ENV, isSafeMode } = require('../main/safeMode.cjs');

const PREFERENCES_MODULE = '../plugin-runtime/preferences-store.ts';
const SECRETS_MODULE = '../plugin-runtime/secrets-store.ts';
const PREFERENCE_STORAGE_MODULE = '../plugin-runtime/preference-storage.ts';
const PLUGIN_STATE_MODULE = '../plugin-runtime/plugin-state-storage.ts';
const PROFILE_MODULE = '../plugin-runtime/profile.ts';

const tempDirs = [];
const makeTempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeMemoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  const calls = { getKeys: [], setKeys: [] };
  return {
    map,
    calls,
    getItem: key => { calls.getKeys.push(key); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { calls.setKeys.push(key); map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
};

/** 主进程存储对：`safeMode` 决定是"工厂启动"还是正常。 */
const makeStores = (safeMode = false) => {
  const dir = makeTempDir(safeMode ? 'artflow-safemode-' : 'artflow-normal-');
  return {
    dir,
    preferences: createConfigStore({ filePath: path.join(dir, 'preferences.json'), schemaVersion: 1, safeMode }),
    secrets: createConfigStore({ filePath: path.join(dir, 'secrets.json'), schemaVersion: 1, safeMode }),
  };
};

const makeBridge = stores => ({
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
  // —— 1. 判定入口：只有显式的 "1" 才算，别的值一律不算 ——
  {
    assert.equal(isSafeMode({ [SAFE_MODE_ENV]: '1' }), true, '"1" 应开启安全模式');
    assert.equal(isSafeMode({}), false, '未设置应关闭');
    assert.equal(isSafeMode({ [SAFE_MODE_ENV]: 'true' }), false, '必须是 "1"，"true" 不算（避免误进）');
    assert.equal(isSafeMode({ [SAFE_MODE_ENV]: '0' }), false, '"0" 应关闭');
  }

  // —— 2. 主进程内核：安全模式读空，但**不是**"读失败"，且文件原封不动 ——
  {
    const { preferences } = makeStores();
    preferences.set('general.language', 'zho');
    preferences.set('canvas.view', { gridVisible: true, gridSize: 48 });
    const before = fs.readFileSync(preferences.filePath, 'utf8');
    const backupBefore = fs.readFileSync(preferences.backupPath, 'utf8');

    // 同一个文件，换成安全模式打开。
    const safeStore = createConfigStore({ filePath: preferences.filePath, schemaVersion: 1, safeMode: true });
    const snapshot = safeStore.read();
    assert.equal(snapshot.source, 'safe-mode', '安全模式的来源必须自成一档');
    assert.equal(snapshot.ok, true, '安全模式是刻意忽略，不是读失败');
    assert.equal(snapshot.degraded, false, '不得标记降级 —— 否则设置页会误报"配置异常"');
    assert.deepEqual(snapshot.values, {}, '安全模式不得消费任何用户值');

    assert.equal(fs.readFileSync(preferences.filePath, 'utf8'), before, '安全模式读一次不得改动主文件');
    assert.equal(fs.readFileSync(preferences.backupPath, 'utf8'), backupBefore, '也不得改动备份');
  }

  // —— 3. 主进程内核：安全模式一律拒写，且磁盘零变化 ——
  {
    const { preferences } = makeStores();
    preferences.set('general.language', 'zho');
    const before = fs.readFileSync(preferences.filePath, 'utf8');
    const safeStore = createConfigStore({ filePath: preferences.filePath, schemaVersion: 1, safeMode: true });

    for (const [label, result] of [
      ['set', safeStore.set('general.language', 'en')],
      ['patch', safeStore.patch({ 'canvas.view': { gridSize: 8 } })],
      ['reset 指定键', safeStore.reset(['general.language'])],
      ['reset 全量', safeStore.reset()],
    ]) {
      assert.equal(result.ok, false, `${label} 在安全模式下必须失败`);
      assert.match(String(result.message), /安全模式/, `${label} 的失败原因必须说清是安全模式`);
    }
    assert.equal(fs.readFileSync(preferences.filePath, 'utf8'), before, '被拒的写入不得留下任何痕迹');

    // 诊断口径：stats 报的是**磁盘真相**，与本次是否消费无关。
    const stats = safeStore.stats();
    assert.equal(stats.safeMode, true, 'stats 应标出安全模式');
    assert.equal(stats.keyCount, 1, 'stats 仍应报告磁盘上真实的键数');
  }

  // —— 4. 插件偏好卷：安全模式读出"无 patches"（= 全部按默认装载），且拒绝写/清 ——
  {
    const dir = makeTempDir('artflow-safemode-profile-');
    const filePath = path.join(dir, 'plugin-profile.json');
    const normal = createPluginProfileStore({ filePath });
    normal.write([{ pluginId: 'builtin.commands-edit', enabled: false }]);
    const before = fs.readFileSync(filePath, 'utf8');

    const safe = createPluginProfileStore({ filePath, safeMode: true });
    const snapshot = safe.read();
    assert.equal(snapshot.source, 'safe-mode');
    assert.equal(snapshot.ok, true, '安全模式不是读失败');
    assert.equal(snapshot.patches, null, '无 patches = 全部插件按默认装载');
    assert.deepEqual(normal.read().patches, [{ pluginId: 'builtin.commands-edit', enabled: false }], '正常模式仍读得到');

    assert.equal(safe.write([]).ok, false, '安全模式不得改写插件开关记录');
    assert.equal(safe.clear().ok, false, '安全模式不得清空插件开关记录');
    assert.equal(fs.readFileSync(filePath, 'utf8'), before, '插件偏好文件必须原封不动');
  }

  // —— 5. 渲染层偏好：安全模式**不采纳**旧键，也不写采纳标记 ——
  {
    const stores = makeStores(true);
    const storage = makeMemoryStorage({ language: 'en', wheelAction: 'pan' });
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: makeBridge(stores), storage });

    assert.equal(grep.preferencesSafeMode(), true, '渲染层必须知道自己在安全模式里');
    assert.equal(grep.preferencesBackendSource(), 'host-safe-mode');
    assert.equal(
      grep.getPreference('general.language', 'zho'),
      'zho',
      '安全模式不得把旧 localStorage 的语言值搬回来 —— 那会让安全模式当场失效',
    );
    assert.deepEqual(
      storage.calls.setKeys,
      [],
      '安全模式连采纳标记都不该写：这次"没查过"，留给正常启动去采纳',
    );
    // 安全模式不是降级：绝不能把它的说明包装成"配置异常"弹给用户。
    assert.deepEqual(
      grep.preferencesDegraded(),
      { degraded: false, message: null },
      '安全模式不得被报成降级 —— 否则设置页会把人引去修一个没坏的东西',
    );
  }

  // —— 6. 渲染层偏好：安全模式是**只读会话** —— 不抛错、只改内存、宿主零变化 ——
  {
    const stores = makeStores();
    stores.preferences.set('general.language', 'en');
    const before = fs.readFileSync(stores.preferences.filePath, 'utf8');

    // 同一个文件，换成安全模式打开（对拍：只差 safeMode 这一个开关）。
    const safeStores = {
      preferences: createConfigStore({ filePath: stores.preferences.filePath, schemaVersion: 1, safeMode: true }),
      secrets: stores.secrets,
    };
    const storage = makeMemoryStorage();
    const grep = loadRendererStore(PREFERENCES_MODULE, { bridge: makeBridge(safeStores), storage });

    assert.equal(grep.getPreference('canvas.gridStyle', 'line'), 'line');
    // 启动期有一批 effect 会把默认值"写回"一遍 —— 那些调用绝不能炸，否则日志里
    // 会刷出一串假的 `[启动错误]`，把真正的问题淹掉（而"干净日志"正是安全模式的意义）。
    assert.doesNotThrow(
      () => grep.setPreference('canvas.gridStyle', 'dot'),
      '安全模式下写入不得抛错（只读会话：横幅已告知"不会保存"）',
    );
    assert.equal(grep.getPreference('canvas.gridStyle', 'dot'), 'dot', '内存里照常生效，界面要立刻反映');
    assert.equal(
      fs.readFileSync(stores.preferences.filePath, 'utf8'),
      before,
      '只读会话：安全模式下的"写入"一个字节都不许落到宿主文件上',
    );
    assert.doesNotThrow(() => grep.clearPreferences(), '清空偏好在安全模式下也不得抛错');
    assert.equal(fs.readFileSync(stores.preferences.filePath, 'utf8'), before, '清空也不得落到宿主文件上');
  }

  // —— 7. 存储适配器：安全模式同样跳过旧键采纳 ——
  {
    const stores = makeStores(true);
    const storage = makeMemoryStorage({ 'bp-skin-state': '{"skinId":"user.picked"}' });
    // 先装载 preferences-store（preference-storage 依赖它的安全模式判定），再装载适配器。
    loadRendererStore(PREFERENCES_MODULE, { bridge: makeBridge(stores), storage });
    const { createPreferenceStorage } = loadRendererStore(PREFERENCE_STORAGE_MODULE, {
      bridge: makeBridge(stores),
      storage,
    });

    const skinStorage = createPreferenceStorage({
      namespace: 'appearance',
      toPreferenceKey: () => 'appearance.skinState',
    });
    assert.equal(skinStorage.getItem('bp-skin-state'), null, '安全模式不得采纳皮肤配置');
    assert.deepEqual(storage.calls.setKeys, [], '安全模式不得写采纳标记');
  }

  // —— 8. 插件状态存储：host-safe-mode 走"无 patches"，且**不**触发旧 localStorage 迁移 ——
  {
    const { PROFILE_PATCH_STORAGE_KEY } = require(PROFILE_MODULE);
    const storage = makeMemoryStorage({
      [PROFILE_PATCH_STORAGE_KEY]: JSON.stringify({ patches: [{ pluginId: 'builtin.perf-monitor', enabled: false }] }),
    });
    globalThis.window = {};
    globalThis.localStorage = storage;
    delete require.cache[require.resolve(PLUGIN_STATE_MODULE)];
    const { createPluginStateStorage, PROFILE_MIGRATION_MARKER_KEY } = require(PLUGIN_STATE_MODULE);

    const adapter = createPluginStateStorage({
      bridge: {
        readSync: () => ({ ok: true, patches: null, source: 'safe-mode' }),
        writeSync: () => ({ ok: false, message: '安全模式：拒绝写入' }),
        clearSync: () => ({ ok: false, message: '安全模式：拒绝写入' }),
      },
      fallback: storage,
    });

    assert.equal(adapter.source, 'host-safe-mode', '安全模式必须自成一档来源');
    assert.equal(adapter.warning, null, '安全模式没有告警可报 —— 一切正常');
    assert.equal(adapter.getItem(PROFILE_PATCH_STORAGE_KEY), null, '安全模式不得把旧 patches 搬回来');
    assert.equal(storage.map.get(PROFILE_MIGRATION_MARKER_KEY), undefined, '不得写迁移标记（留给正常启动迁移一次）');
  }

  // —— 9. 密钥卷：安全模式不采纳旧 API key（工厂启动 = 全新安装的样子） ——
  {
    const stores = makeStores(true);
    const storage = makeMemoryStorage({ geminiApiKey: 'legacy-key-value' });
    const secrets = loadRendererStore(SECRETS_MODULE, { bridge: makeBridge(stores), storage });

    assert.equal(secrets.secretsBackendSource(), 'host-safe-mode');
    assert.equal(secrets.readSecret('ai.geminiApiKey'), null, '安全模式不得采纳旧密钥');
    assert.deepEqual(storage.calls.setKeys, [], '安全模式不得写密钥采纳标记');
  }

  console.log('safe mode checks: ok');
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  delete globalThis.window;
  delete globalThis.localStorage;
}
