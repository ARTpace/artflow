/**
 * check-plugin-state-storage —— 插件偏好存储的回归守卫。
 *
 * 守护的是一条曾经真实存在的失败链：插件明明关了，重启又自己开了。三个关键不变量：
 *  1. 宿主桥可用时，偏好**只**读写宿主文件（与 origin 解耦），localStorage 不参与运行期读写。
 *  2. 旧 localStorage 数据**只迁移一次**：迁移后清空宿主不能被旧值复活。
 *  3. 宿主文件损坏时回退**上次可用快照**，绝不能退化成"没有偏好"（那等于全部插件启用）。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginProfileStore } = require('../main/pluginProfileStore.cjs');
const { PROFILE_PATCH_STORAGE_KEY } = require('../plugin-runtime/profile.ts');
const {
  createPluginStateStorage,
  PROFILE_MIGRATION_MARKER_KEY,
} = require('../plugin-runtime/plugin-state-storage.ts');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-plugin-state-'));

/** 宿主桥：直接接真实的主进程存储模块（临时目录），两层一起验。 */
const makeBridge = store => ({
  readSync: () => store.read(),
  writeSync: patches => store.write(patches),
  clearSync: () => store.clear(),
});

const makeMemoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
};

const legacyBlob = patches => JSON.stringify({ patches });
const readFilePatches = filePath => {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parsed.patches;
};

const tempDirs = [];
const makeStore = () => {
  const dir = makeTempDir();
  tempDirs.push(dir);
  const filePath = path.join(dir, 'plugin-profile.json');
  return { store: createPluginProfileStore({ filePath }), filePath };
};

try {
  // —— 1. 宿主桥不可用（纯浏览器运行）：行为与迁移前完全一致 ——
  {
    const fallback = makeMemoryStorage();
    const storage = createPluginStateStorage({ bridge: null, fallback });
    assert.equal(storage.source, 'local-storage');
    assert.equal(storage.warning, null);
    assert.equal(storage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
    storage.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob([{ id: 'builtin.a', enabled: false }]));
    assert.deepEqual(JSON.parse(storage.getItem(PROFILE_PATCH_STORAGE_KEY)).patches, [{ id: 'builtin.a', enabled: false }]);
    storage.removeItem(PROFILE_PATCH_STORAGE_KEY);
    assert.equal(storage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
  }

  // —— 2. 宿主为空 + localStorage 有旧数据 → 一次性迁移，且运行期再不经 localStorage ——
  {
    const { store, filePath } = makeStore();
    const fallback = makeMemoryStorage({
      [PROFILE_PATCH_STORAGE_KEY]: legacyBlob([
        { id: 'builtin.commands-core', enabled: false },
        { id: 'builtin.perf-monitor', enabled: true },
      ]),
    });
    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback });
    assert.equal(storage.source, 'host-migrated');
    assert.equal(storage.warning, null);
    assert.deepEqual(readFilePatches(filePath), [
      { id: 'builtin.commands-core', enabled: false },
      { id: 'builtin.perf-monitor', enabled: true },
    ]);
    assert.equal(fallback.getItem(PROFILE_MIGRATION_MARKER_KEY), '1', '迁移后应落标记');

    // 运行期写入只进宿主文件，不再碰 localStorage。
    fallback.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob([{ id: 'builtin.decoy', enabled: false }]));
    storage.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob([{ id: 'builtin.tools-canvas', enabled: false }]));
    assert.deepEqual(readFilePatches(filePath), [{ id: 'builtin.tools-canvas', enabled: false }]);
  }

  // —— 3. 已迁移过：宿主被清空不得被旧值复活 ——
  {
    const { store, filePath } = makeStore();
    const fallback = makeMemoryStorage({
      [PROFILE_PATCH_STORAGE_KEY]: legacyBlob([{ id: 'builtin.commands-core', enabled: false }]),
      [PROFILE_MIGRATION_MARKER_KEY]: '1',
    });
    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback });
    assert.equal(storage.source, 'host-empty');
    assert.equal(storage.getItem(PROFILE_PATCH_STORAGE_KEY), null, '宿主为空就是没有偏好，不能拿旧值顶替');
    assert.equal(fs.existsSync(filePath), false);
  }

  // —— 4. 宿主为空且没有旧数据：全新安装，读 null，不报错 ——
  {
    const { store } = makeStore();
    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback: makeMemoryStorage() });
    assert.equal(storage.source, 'host-empty');
    assert.equal(storage.warning, null);
    assert.equal(storage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
  }

  // —— 5. 正常读写往返 + 写后回读校验 + 非 profile 键透传 ——
  {
    const { store, filePath } = makeStore();
    const fallback = makeMemoryStorage();
    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback });
    storage.setItem('artflow.other.key', 'passthrough');
    assert.equal(storage.getItem('artflow.other.key'), 'passthrough', '非 profile 键应回落到 localStorage');

    // source 描述的是**启动时读到了什么**，不随本次会话的写入变化（全新安装 = host-empty）。
    assert.equal(storage.source, 'host-empty');
    const patches = [{ id: 'builtin.ai-providers', enabled: false }, { id: 'builtin.asset-library', enabled: false }];
    storage.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob(patches));
    assert.deepEqual(JSON.parse(storage.getItem(PROFILE_PATCH_STORAGE_KEY)).patches, patches);
    assert.deepEqual(readFilePatches(filePath), patches);
    assert.equal(fs.existsSync(`${filePath}.tmp`), false, '原子写不应留下临时文件');

    storage.removeItem(PROFILE_PATCH_STORAGE_KEY);
    assert.equal(storage.getItem(PROFILE_PATCH_STORAGE_KEY), null);
    assert.equal(fs.existsSync(filePath), false);
  }

  // —— 6. 写入失败必须同步抛出（设置页据此提示，而不是静默丢失）——
  {
    const failingBridge = {
      readSync: () => ({ ok: true, patches: null, source: 'none' }),
      writeSync: () => ({ ok: false, message: 'disk full' }),
      clearSync: () => ({ ok: false, message: 'disk full' }),
    };
    const storage = createPluginStateStorage({ bridge: failingBridge, fallback: makeMemoryStorage() });
    assert.throws(
      () => storage.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob([{ id: 'builtin.cutout', enabled: false }])),
      /disk full/,
    );
    assert.throws(() => storage.removeItem(PROFILE_PATCH_STORAGE_KEY), /disk full/);
  }

  // —— 7. 写后回读不一致必须抛出（"看着写入成功、重启却回默认"正是要拦的）——
  {
    const lyingBridge = {
      readSync: () => ({ ok: true, patches: [{ id: 'builtin.something-else', enabled: true }], source: 'file' }),
      writeSync: () => ({ ok: true, count: 1 }),
      clearSync: () => ({ ok: true }),
    };
    const storage = createPluginStateStorage({ bridge: lyingBridge, fallback: makeMemoryStorage() });
    assert.throws(
      () => storage.setItem(PROFILE_PATCH_STORAGE_KEY, legacyBlob([{ id: 'builtin.cutout', enabled: false }])),
      /校验失败/,
    );
  }

  // —— 8. 宿主文件损坏 → 回退上次可用快照并带告警（绝不能退化成"全部启用"）——
  {
    const { store, filePath } = makeStore();
    const good = [{ id: 'builtin.workspace-panels', enabled: false }];
    store.write(good);
    store.write([...good, { id: 'builtin.perf-monitor', enabled: true }]);
    fs.writeFileSync(filePath, '{ this is not json');

    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback: makeMemoryStorage() });
    assert.equal(storage.source, 'host-backup');
    assert.ok(storage.warning && storage.warning.length > 0, '回退快照必须带告警');
    assert.deepEqual(JSON.parse(storage.getItem(PROFILE_PATCH_STORAGE_KEY)).patches, good);
  }

  // —— 9. 非法 patch 结构：拒绝写入而不是写坏 ——
  {
    const { store, filePath } = makeStore();
    const storage = createPluginStateStorage({ bridge: makeBridge(store), fallback: makeMemoryStorage() });
    assert.throws(() => storage.setItem(PROFILE_PATCH_STORAGE_KEY, '[1,2,3]'), /patches/);
    assert.throws(() => storage.setItem(PROFILE_PATCH_STORAGE_KEY, 'not json'), /patches/);
    assert.equal(fs.existsSync(filePath), false);
  }

  console.log('plugin-state-storage checks: ok');
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
