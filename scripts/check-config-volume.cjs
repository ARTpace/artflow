/**
 * check-config-volume —— 渲染层**通用配置卷**（`plugins/config-volume.ts`）的回归守卫。
 *
 * 这个适配器是"新卷一行接入"的关键：workspace / recent-files 都靠它拿到与偏好卷同语义的
 * 读写。它有三条极易被后来者改坏的语义，各配一组断言：
 *  A. **失败即抛 + 回滚内存**。保留内存新值会造成"界面已生效、磁盘没改"的假成功，
 *     下次启动又变回去 —— 那正是"关掉的插件重启又自己开了"的同构 bug。
 *  B. **安全模式只改内存、不落盘、不抛错**（只读会话，见 ADR-053）。
 *  C. **同名共享实例**。两个组件各持一份就会互相覆盖。
 *
 * 另有一组"回退路径"断言：桥不可用（纯浏览器 vite / 单测）时回退 localStorage，
 * 键前缀 `artflow.volume.<name>.` —— 回退只为"浏览器里能跑"，不是权威存储。
 */

const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const VOLUME_MODULE = '../plugin-runtime/config-volume.ts';

const makeMemoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
  };
};

/** 模块有模块级副作用（构造即读宿主），每轮实验都要换一轮模块缓存。 */
const loadVolume = ({ bridge, storage }) => {
  globalThis.window = bridge ? { artflowConfig: bridge } : {};
  globalThis.localStorage = storage;
  const resolved = require.resolve(VOLUME_MODULE);
  delete require.cache[resolved];
  return require(VOLUME_MODULE);
};

/** 一个记账用的宿主桥：`failWrites` 一开，所有写入都返回失败。 */
const makeBridge = (initialValues = {}, { source = 'file' } = {}) => {
  const state = { values: { ...initialValues }, writes: [], fails: false, resets: [], clears: 0 };
  const snapshot = () => ({
    ok: true, values: { ...state.values }, source, schemaVersion: 1, degraded: false,
  });
  return {
    state,
    readStore: () => snapshot(),
    setStoreValue: (name, key, value) => {
      state.writes.push({ name, key, value });
      if (state.fails) return { ok: false, message: '磁盘满' };
      state.values[key] = value;
      return { ok: true };
    },
    patchStore: (name, values) => {
      state.writes.push({ name, values });
      if (state.fails) return { ok: false, message: '磁盘满' };
      Object.assign(state.values, values);
      return { ok: true };
    },
    resetStore: (name, keys) => {
      state.resets.push({ name, keys });
      if (state.fails) return { ok: false, message: '磁盘满' };
      for (const key of keys) delete state.values[key];
      return { ok: true };
    },
    clearStore: name => {
      state.clears += 1;
      if (state.fails) return { ok: false, message: '磁盘满' };
      state.values = {};
      void name;
      return { ok: true };
    },
  };
};

try {
  // —— 1. 宿主桥可用：构造即读快照，来源自证为 host-file ——
  {
    const bridge = makeBridge({ 'panel.board': true });
    const { createConfigVolume } = loadVolume({ bridge, storage: makeMemoryStorage() });
    const volume = createConfigVolume('workspace');

    assert.equal(volume.read('panel.board', false), true, '启动期必须同步读到宿主快照');
    assert.equal(volume.read('panel.missing', 'fallback'), 'fallback', '缺值走 fallback');
    assert.equal(volume.source, 'host-file');
    assert.equal(volume.safeMode, false);
  }

  // —— 2. 写入直达宿主；同名卷共享实例（订阅与内存态必须是一份） ——
  {
    const bridge = makeBridge();
    const { createConfigVolume } = loadVolume({ bridge, storage: makeMemoryStorage() });
    const volume = createConfigVolume('workspace');
    const same = createConfigVolume('workspace');

    assert.equal(same, volume, '同名卷必须是同一实例，否则两个组件会互相覆盖');

    volume.write('panel.side', { isOpen: true, tab: 'layers' });
    assert.deepEqual(bridge.state.values['panel.side'], { isOpen: true, tab: 'layers' }, '写入必须同步落到宿主');

    let hits = 0;
    const dispose = volume.subscribe('panel.side', () => { hits += 1; });
    volume.write('panel.side', { isOpen: false, tab: 'frames' });
    assert.equal(hits, 1, '订阅者必须收到变更通知');
    dispose();
    volume.write('panel.side', { isOpen: true, tab: 'layers' });
    assert.equal(hits, 1, 'disposer 之后不再通知');
  }

  // —— 3. 写失败：**同步抛出**且内存回滚（不得留下"界面已生效、磁盘没改"） ——
  {
    const bridge = makeBridge();
    const { createConfigVolume } = loadVolume({ bridge, storage: makeMemoryStorage() });
    const volume = createConfigVolume('workspace');

    volume.write('panel.project', false);
    bridge.state.fails = true;
    assert.throws(() => volume.write('panel.project', true), /磁盘满/, '失败必须同步抛错');
    assert.equal(volume.read('panel.project', false), false, '失败后内存必须回滚到旧值');

    // 新增键失败 → 该键不该残留在内存里。
    assert.throws(() => volume.write('panel.finder', true), /磁盘满/);
    assert.equal(volume.has('panel.finder'), false, '新键写失败后不得留在内存');

    // patch 失败要整批回滚，不能只滚一半。
    bridge.state.fails = false;
    volume.patch({ 'panel.board': true, 'panel.side': { isOpen: false, tab: 'layers' } });
    bridge.state.fails = true;
    assert.throws(() => volume.patch({ 'panel.board': false, 'panel.cursor': 3 }), /磁盘满/);
    assert.equal(volume.read('panel.board', null), true, 'patch 失败必须回滚已存在键');
    assert.equal(volume.has('panel.cursor'), false, 'patch 失败必须撤销新增键');
  }

  // —— 4. 安全模式：只改内存、不落盘、不抛错（只读会话） ——
  {
    const bridge = makeBridge({}, { source: 'safe-mode' });
    const { createConfigVolume } = loadVolume({ bridge, storage: makeMemoryStorage() });
    const volume = createConfigVolume('workspace');

    assert.equal(volume.safeMode, true, '必须识别出安全模式');
    assert.equal(volume.source, 'host-safe-mode');

    assert.doesNotThrow(() => volume.write('panel.board', true), '安全模式下写入不得抛错（否则启动期日志全是噪声）');
    assert.equal(volume.read('panel.board', false), true, '安全模式下界面仍要即时反映');
    assert.deepEqual(bridge.state.writes, [], '安全模式不得向宿主写入任何一次');
  }

  // —— 5. 桥不可用：回退 localStorage（键前缀 artflow.volume.<name>.） ——
  {
    const storage = makeMemoryStorage({ 'artflow.volume.workspace.panel.board': 'true' });
    const { createConfigVolume } = loadVolume({ bridge: null, storage });
    const volume = createConfigVolume('workspace');

    assert.equal(volume.source, 'local-storage-fallback');
    assert.equal(volume.read('panel.board', false), true, '回退路径必须能读回旧值');

    volume.write('panel.side', { isOpen: true, tab: 'layers' });
    assert.equal(storage.getItem('artflow.volume.workspace.panel.side'), JSON.stringify({ isOpen: true, tab: 'layers' }));

    // 另一个卷不能读到本卷的键（前缀隔离）。
    const other = createConfigVolume('recent-files');
    assert.equal(other.has('panel.board'), false, '卷之间必须按键前缀隔离');
  }

  console.log('config volume checks: ok');
} finally {
  delete globalThis.window;
  delete globalThis.localStorage;
}
