/**
 * Hidden sandboxed window. Plugin functions stay in that window.
 * The main process only forwards JSON and bytes.
 */
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, ipcMain } = require('electron');
const { listSandboxedPackages, validateCardResult, performPluginHostOp, readPluginClients, HOST_API_VERSION } = require('./sandboxedPlugins.cjs');
const hostEvents = require('./hostEvents.cjs');

const MAX_PARSE_BYTES = 512 * 1024 * 1024;
/** 无响应宽限期：大文件解析会短暂堵住沙箱窗口的消息循环，先给它一次自愈机会再判定死亡。 */
const UNRESPONSIVE_GRACE_MS = 10000;
/**
 * ready 硬上限（加固项③）：guest 启动完成的回推若是永远不来，宿主必须自己认输。
 * guest 是本机 HTML + preload，正常 ready 在 1s 内；15s 是留给启动高压期（Defender 全盘扫描、
 * 冷盘首读）的余量，同时比 20s 的单次 RPC 预算更早落定 —— 用户不必白等满一整轮才发现插件调不动。
 */
const READY_TIMEOUT_MS = 15000;
/** 单次沙箱 RPC 预算：ready 之后「发送 + 等回执」这一段。 */
const CALL_TIMEOUT_MS = 20000;
/** 自动重建额度：同一时间窗内最多自动重建几次，防止"一激活就崩"的插件把宿主拖成重建死循环。 */
const MAX_AUTO_REBUILDS = 3;
const AUTO_REBUILD_WINDOW_MS = 60000;

let hostPromise = null;
/** 当前宿主句柄。hostPromise 会被置空，需要一个"事件是不是来自当前这次会话"的比对对象。 */
let currentHost = null;
let requestSeq = 0;
const installedPlugins = new Map();
/** 最近一次激活使用的插件根目录：宿主重建后据此重放激活。 */
let lastPluginsRoot = null;
/** 自动重建的时间戳（滑动窗口内计数，见 MAX_AUTO_REBUILDS）。 */
let autoRebuildStamps = [];
/**
 * 宿主换代通知器（main.cjs 在 registerPluginStoreIpc 注入）。
 * 沙箱窗口一换，渲染层手里那份"沙箱贡献目录"（面板/命令/格式处理器/卡片）就全是死引用，
 * 需要它重新激活一次；返回 false 表示当前不宜重建（如应用正在退出、主窗口已销毁）。
 */
let hostRecoveryNotifier = null;
/** 正在进行的激活任务（并发去重，见 activateInstalledPlugins）。 */
let activationInFlight = null;
// —— unrestricted 数据通道的“当前输入”暂存 ——
// parse 的原始 bytes 已经随 invoke 到达主进程；guest 里 storeInput() 无需二次传输，
// 主进程从这份暂存直接落仓。一个插件同一时刻只有一条 parse 在跑（沙箱窗口顺序处理）。
const pendingParseInputs = new Map();
let pluginStore = null;
let archiveReader = null;
/** 资产库仓储（projectStorageController）。host 能力面的 assets 命名空间走这里。 */
let storageController = null;

/** main.cjs 启动时注入数据仓与 ZIP 随机访问引擎（comicArchiveController 实例）。 */
function setPluginStore(store) {
  pluginStore = store;
}
function setArchiveReader(reader) {
  archiveReader = reader;
}
/** 注入资产仓储。没有它时 host.assets 调用会明确报「asset storage is unavailable」。 */
function setStorageController(controller) {
  storageController = controller;
}
/**
 * 注入"宿主换代"通知器。沙箱窗口崩溃重建后由这里回调，把「需要重新激活」送达渲染层。
 * 回调返回 false 表示当前不宜重建（应用退出中 / 主窗口已销毁），宿主只清状态、不重建。
 */
function setHostRecoveryNotifier(notifier) {
  hostRecoveryNotifier = typeof notifier === 'function' ? notifier : null;
}

/**
 * 建一个沙箱宿主窗口。
 * `onLost(reason)` 在窗口彻底不可用时**恰好回调一次**（渲染进程崩溃 / 窗口被销毁 /
 * 持续无响应），由 ensureHost 侧统一收口：清会话态 → 通知渲染层 → 视额度重建。
 */
function createHost(onLost) {
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const pending = new Map();
  /** 本宿主是否已死亡。死亡后 call() 立刻失败，绝不把消息发给死窗口再干等 20s 超时。 */
  let dead = false;
  let deadReason = null;
  let unresponsiveTimer = null;
  /** ready 看门狗句柄（加固项③）。 */
  let readyWatchdog = null;
  let notified = false;
  /** ready 与"死亡"之间的竞速：崩溃早于 ready 时，挂在 readyPromise 上的调用者永远等不到结果。 */
  let signalDead;
  const deadPromise = new Promise(resolve => { signalDead = resolve; });
  const win = new BrowserWindow({
    show: false,
    // 隐藏期完全不绘制：防止启动高压期（Defender 全力扫描等）窗口首帧泄漏可见，
    // 变成一个用户看得见却永远没有内容的白框。
    paintWhenInitiallyHidden: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'artflow-plugin-sandbox',
      preload: path.join(__dirname, '../sandbox/preload.cjs'),
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /**
   * ready 看门狗（加固项③）。
   *
   * ready 是 guest 启动完成的回推。窗口加载失败（guest.html 读不到 / 磁盘报错）、preload 被拦、
   * 或首帧脚本卡死时，这个回推永远不来，而"死亡信号"（render-process-gone / destroyed /
   * unresponsive）也一个都不会触发：
   *   - call() 停在 readyPromise 上 —— 它的 20s 计时器要 ready **之后**才启动，等于没有，永久挂起；
   *   - runActivation 停在 Promise.race([ready, dead]) 上 —— 并发去重会把之后所有激活请求都
   *     挂在同一个不落定的 Promise 上。
   * 表现（插件面板点了没反应、日志无线索）与加固项②要消灭的静默卡死完全同源，所以这里给 ready
   * 一个硬上限：到点直接走 die() —— deadPromise 落定（挂在它上面的调用方立刻拿到
   * "host is gone (ready-timeout)"）、pending 立即失败、hostPromise 作废并按②的链路重建。
   */
  function startReadyWatchdog() {
    if (readyWatchdog || dead) return;
    readyWatchdog = setTimeout(() => {
      readyWatchdog = null;
      if (dead) return;
      console.warn(`[plugin-sandbox] host not ready within ${READY_TIMEOUT_MS}ms; treating it as lost`);
      die('ready-timeout', { destroy: true });
    }, READY_TIMEOUT_MS);
    // 同 unresponsive 宽限定时器：不该拖住进程退出（隐藏窗口的闹钟不能吊着应用退出）。
    if (readyWatchdog.unref) readyWatchdog.unref();
  }
  /** ready 已到 / 宿主已死，闹钟就没有再烧的意义。 */
  function stopReadyWatchdog() {
    if (!readyWatchdog) return;
    clearTimeout(readyWatchdog);
    readyWatchdog = null;
  }

  /**
   * 一次性的死亡收口。只做本宿主内部的事：清 pending / ready 等待者 / 订阅 emitter /
   * ipc 监听，并上报 onLost；模块级状态（hostPromise、installedPlugins…）由 ensureHost 侧处理。
   */
  const die = (reason, options) => {
    if (dead) return;
    dead = true;
    deadReason = reason;
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
    // ready 看门狗同理：此处死亡已收口，闹钟再响一次只会重复上报（die 幂等，但没必要）。
    stopReadyWatchdog();
    // pending 里的调用方必须**立刻**收到失败：过去它们各自耗满 20s 超时，
    // 表现是"插件面板点了没反应"，而真正的原因（宿主已崩）要等 20s 才浮现。
    for (const settle of pending.values()) settle({ ok: false, message: `sandbox host is gone (${reason})` });
    pending.clear();
    signalDead(reason);
    // ipcMain 监听是全局的：不摘掉，每重建一次就多留一个监听器，旧的那个还会继续被调用。
    ipcMain.removeListener('artflow-app:plugin-sandbox-reply', onReply);
    // 立刻解绑宿主事件推送：死窗口绝不能留在推送路径上（订阅表的统一作废在 ensureHost 侧做）。
    hostEvents.clearEmitter();
    if (options && options.destroy && !win.isDestroyed()) win.destroy();
    if (!notified) {
      notified = true;
      onLost(reason);
    }
  };

  // —— 崩溃检测（加固项②）——
  // 沙箱宿主是隐藏窗口，此前没有任何"它没了"的信号：第三方插件抛未捕获异常 / OOM / 死循环，
  // 渲染进程 gone 之后 hostPromise 仍指向死窗口，后续 call() 全部耗满 20s。
  // 三个信号都收：render-process-gone（崩溃）、destroyed（窗口没了）、unresponsive（卡死）。
  win.webContents.on('render-process-gone', (_event, details) => {
    console.warn(`[plugin-sandbox] render process gone: ${details && details.reason ? details.reason : 'unknown'}`);
    die(`render-process-gone:${(details && details.reason) || 'unknown'}`);
  });
  win.webContents.on('destroyed', () => die('destroyed'));
  win.webContents.on('unresponsive', () => {
    if (dead || unresponsiveTimer) return;
    console.warn(`[plugin-sandbox] host unresponsive; rebuilding in ${UNRESPONSIVE_GRACE_MS}ms if it stays stuck`);
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (dead) return;
      console.warn('[plugin-sandbox] host still unresponsive; forcing rebuild');
      die('unresponsive', { destroy: true });
    }, UNRESPONSIVE_GRACE_MS);
    // 定时器不该拖住进程退出（沙箱宿主是隐藏窗口，退出判定只看可见窗口）。
    if (unresponsiveTimer.unref) unresponsiveTimer.unref();
  });
  win.webContents.on('responsive', () => {
    if (!unresponsiveTimer) return;
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  });
  // 窗口被关掉（应用退出 / 显式销毁）走同一条收口：否则 hostPromise 会永久留着死窗口。
  win.on('closed', () => die('closed'));

  // —— 宿主事件回推 ——
  // 订阅表在主进程（hostEvents），handler 留在沙箱窗口。宿主发生变更时只推一条 JSON，
  // 沙箱按 subscriptionId 找回 handler 执行。窗口没了就丢弃 —— 事件永远不能反过来
  // 影响宿主自身的操作（导入/重命名必须照常成功）。
  hostEvents.setEmitter((pluginId, event) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('artflow-app:plugin-sandbox-message', {
      type: 'host-event',
      pluginId,
      subscriptionId: event.subscriptionId,
      name: event.name,
      payload: event.payload,
    });
  });
  const session = win.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    callback({ cancel: true });
  });
  function onReply(event, payload) {
    if (event.sender !== win.webContents || !payload || typeof payload !== 'object') return;
    if (payload.type === 'ready') {
      // ready 已到：撤掉看门狗（加固项③），本次会话的启动阶段就此结束。
      stopReadyWatchdog();
      ready();
      return;
    }
    // 插件 console 输出：沙箱窗口是隐藏的，必须转发到主进程才有人看得到。
    if (payload.type === 'log') {
      const level = ['log', 'info', 'warn', 'error'].includes(payload.level) ? payload.level : 'log';
      const text = typeof payload.text === 'string' ? payload.text.slice(0, 4000) : '';
      const pluginId = typeof payload.pluginId === 'string' && payload.pluginId ? payload.pluginId : 'unknown';
      console[level](`[plugin] ${pluginId} ${text}`);
      return;
    }
    if (payload.type === 'host') {
      const plugin = installedPlugins.get(payload.pluginId);
      let op;
      if (plugin) {
        const request = payload.op === 'store-input'
          ? { ...payload, inputBytes: pendingParseInputs.get(payload.pluginId) }
          : payload;
        op = performPluginHostOp(plugin, { pluginStore, archiveReader, storage: storageController }, request);
      } else {
        op = Promise.resolve({ ok: false, message: 'plugin is not installed' });
      }
      Promise.resolve(op).then(result => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.send('artflow-app:plugin-sandbox-message', {
          type: 'host-result',
          requestId: payload.requestId,
          ok: Boolean(result.ok),
          result: result.result,
          message: result.message,
        });
      });
      return;
    }
    const settle = pending.get(payload.requestId);
    if (!settle) return;
    pending.delete(payload.requestId);
    settle(payload);
  }
  ipcMain.on('artflow-app:plugin-sandbox-reply', onReply);

  const call = (message) => Promise.race([
    readyPromise.then(() => null),
    // 崩溃早于 ready：让调用者拿到"宿主已死"而不是等到 20s 超时（旧实现下这是常态）。
    deadPromise.then(reason => String(reason)),
  ]).then(gone => {
    if (gone !== null) return { ok: false, message: `sandbox host is gone (${gone})` };
    // ready 与发送之间的窗口期：宿主可能刚崩，此时发出去的消息永远不会有人回。
    if (dead || win.isDestroyed() || win.webContents.isDestroyed()) {
      return { ok: false, message: `sandbox host is gone (${deadReason || 'window destroyed'})` };
    }
    return new Promise(resolve => {
      const requestId = ++requestSeq;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, message: 'sandbox timed out' });
      }, CALL_TIMEOUT_MS);
      pending.set(requestId, payload => {
        clearTimeout(timer);
        resolve(payload);
      });
      win.webContents.send('artflow-app:plugin-sandbox-message', { ...message, requestId });
    });
  });
  // guest 开始加载，同时给 ready 上闹钟：两者必须同刻启动，否则"窗口加载卡住"这一段
  // 没有任何计时器在看着（加固项③，见 startReadyWatchdog）。
  startReadyWatchdog();
  win.loadFile(path.join(__dirname, '../sandbox/guest.html'));
  return {
    call,
    ready: readyPromise,
    /** 本宿主的死亡 Promise（resolve 出原因）。宿主在 ready 前就崩时，光有 ready 会永远等不到结果。 */
    dead: deadPromise,
    /** 当前宿主是否还能用（call 内部已判定，这里供调用方提前短路）。 */
    isAlive: () => !dead && !win.isDestroyed() && !win.webContents.isDestroyed(),
  };
}

function ensureHost() {
  if (!hostPromise) {
    let host;
    host = createHost(reason => handleHostLost(host, reason));
    currentHost = host;
    hostPromise = Promise.resolve(host);
  }
  return hostPromise;
}

/**
 * 沙箱宿主失效的统一收口（加固项②）。
 *
 * 旧的失败形态：第三方插件把渲染进程搞崩之后，宿主窗口死了而 hostPromise 还指着它 ——
 * 之后每次 call() 都停在 ready 上，各自的 20s 超时是唯一反馈，用户看到的是
 * "插件面板点了没反应 / 导入卡住"，日志里没有任何线索。
 *
 * 现在这里做三件事：
 *  1. 清掉挂在死窗口上的模块级会话态（hostPromise / installedPlugins / pendingParseInputs），
 *     下一次 ensureHost() 会建一个全新的宿主；
 *  2. 通知渲染层：它手里那份沙箱贡献目录（面板 / 命令 / 格式处理器 / 卡片）全部作废，需要重新激活；
 *  3. 在额度内自动重建 + 重放激活 —— 否则"重建出来的窗口里一个插件都没有"，
 *     后续插件调用会得到 'plugin is not installed'，比超时更难排查。
 */
function handleHostLost(host, reason) {
  if (currentHost !== host) return; // 迟到的旧窗口事件（已被新宿主取代）
  currentHost = null;
  hostPromise = null;
  installedPlugins.clear();
  pendingParseInputs.clear();
  // 作废"死宿主自己在途的那次激活"。宿主死亡与激活失败常常同刻发生（最典型的就是加固项③ 的
  // ready 超时：runActivation 正停在这个宿主的 dead 上），而 die() 的 onLost 是**同步**回调，
  // 那次激活任务的 .finally 微任务还没轮上。若不清这个标，下面第 3 步的自动重放会被并发去重
  // 直接退化成"等那份正在收尾的旧任务"——重建实际上没发生，宿主一直空着，之后所有插件调用都
  // 报 not installed。旧任务此刻已确定失败（dead 已竞速落定），且它的 finally 带身份校验，
  // 不会误清新任务。
  activationInFlight = null;
  // 换代作废：订阅表与 emitter 一起清（此刻还没有新窗口，不会误伤新 emitter）。
  hostEvents.resetForNewHost();
  console.warn(`[plugin-sandbox] host lost (${reason}); re-activation required`);

  let approved = true;
  if (hostRecoveryNotifier) {
    try {
      approved = hostRecoveryNotifier(reason) !== false;
    } catch (error) {
      console.warn('[plugin-sandbox] recovery notifier failed', error);
    }
  }
  if (!approved) {
    console.warn('[plugin-sandbox] rebuild skipped (notifier vetoed: app quitting or no renderer)');
    return;
  }

  const now = Date.now();
  autoRebuildStamps = autoRebuildStamps.filter(stamp => now - stamp < AUTO_REBUILD_WINDOW_MS);
  if (!lastPluginsRoot) {
    console.warn('[plugin-sandbox] rebuild deferred (no plugins root known yet; next activation will create it)');
    return;
  }
  if (autoRebuildStamps.length >= MAX_AUTO_REBUILDS) {
    // 额度用尽：宿主在短时间内反复崩溃，继续自动重建只会变成死循环 —— 交给下一次显式激活。
    console.warn(`[plugin-sandbox] auto rebuild budget exhausted (${MAX_AUTO_REBUILDS}/${AUTO_REBUILD_WINDOW_MS}ms); waiting for explicit activation`);
    return;
  }
  autoRebuildStamps.push(now);
  activateInstalledPlugins(lastPluginsRoot).catch(error => {
    console.warn('[plugin-sandbox] rebuild activation failed', error);
  });
}

/**
 * 激活清单里的沙箱插件。
 *
 * 并发去重：宿主崩溃重建时，"主进程自动重放"与"渲染层收到换代通知后的重新激活"会几乎
 * 同时打进来，两份都放进去会让每个插件在同一个 guest 里被激活两次（各注册一遍 handler）。
 * 记下 lastPluginsRoot：宿主再崩时自动重建要照着同一个目录重放。
 */
function activateInstalledPlugins(root) {
  if (activationInFlight) return activationInFlight;
  const task = runActivation(root).finally(() => {
    if (activationInFlight === task) activationInFlight = null;
  });
  activationInFlight = task;
  return task;
}

async function runActivation(root) {
  lastPluginsRoot = root;
  const host = await ensureHost();
  // 宿主可能在 ready 之前就崩（上一次崩溃刚重建、下一秒又崩，或插件把渲染进程搞挂）。
  // 只 await ready 的话这个 Promise 永不落定：activateInstalledPlugins 的并发去重会把
  // 之后所有激活请求都挂在同一个死 Promise 上 —— 表现是"插件再也装不上、日志也没有"，
  // 正好是加固项②要消灭的那种静默卡死。
  const diedBeforeReady = await Promise.race([host.ready.then(() => null), host.dead]);
  if (diedBeforeReady !== null) {
    console.warn(`[plugin-sandbox] activation aborted (host died before ready: ${diedBeforeReady})`);
    return { plugins: [] };
  }
  // 一次激活 = 一次全新的沙箱会话。上一轮的订阅属于可能已经不存在的插件，一并作废。
  // 这里只能清订阅表（reset）：emitter 已由 createHost() 绑到新窗口，清掉就再也推不出去了。
  hostEvents.reset();
  // 同理，插件登记也换成本轮的：崩溃重建后旧记录指向的插件在 guest 里已随窗口一起消失。
  installedPlugins.clear();
  const plugins = [];
  for (const pkg of listSandboxedPackages(root)) {
    installedPlugins.set(pkg.id, pkg);
    // 版本门：声明了比本构建更新的 host API 就拒绝激活，并给出可读原因
    // （否则插件会在调用某个不存在的 facade 方法时才炸，报错点离根因很远）。
    if (!pkg.hostCompatible) {
      plugins.push({
        id: pkg.id,
        name: pkg.name,
        error: `requires host API ${pkg.minHostVersion}, this build provides ${HOST_API_VERSION}`,
        formats: [],
        commands: [],
        panels: [],
      });
      continue;
    }
    const source = fs.readFileSync(pkg.entryPath, 'utf8');
    const reply = await host.call({ type: 'activate', pluginId: pkg.id, source, hostApiVersion: HOST_API_VERSION, manifest: { name: pkg.name, version: pkg.version } });
    if (reply.error || !reply.catalog) {
      plugins.push({ id: pkg.id, name: pkg.name, error: reply.error || reply.message || 'activation failed', formats: [], commands: [], panels: [] });
      continue;
    }
    plugins.push({ id: pkg.id, name: pkg.name, ...reply.catalog });
  }
  return { plugins };
}

async function invokePlugin(message) {
  if (!message || typeof message.pluginId !== 'string') return { ok: false, message: 'plugin id is missing' };
  const host = await ensureHost();
  if (message.op === 'parse') {
    const bytes = message.bytes;
    const length = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
    if (length <= 0 || length > MAX_PARSE_BYTES) return { ok: false, message: 'file is empty or larger than 512MB' };
    // 暂存原始输入：guest 里 storeInput() 时主进程直接取这份 bytes 落仓（免二次传输）。
    pendingParseInputs.set(message.pluginId, bytes);
    try {
      const reply = await host.call({
        type: 'parse',
        pluginId: message.pluginId,
        handlerId: message.handlerId,
        name: typeof message.name === 'string' ? message.name.slice(0, 180) : 'file',
        mimeType: typeof message.mimeType === 'string' ? message.mimeType.slice(0, 120) : '',
        bytes,
      });
      if (!reply.ok) return { ok: false, message: reply.message || 'parse failed' };
      try {
        return { ok: true, result: validateCardResult(reply.result, message.pluginId) };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    } finally {
      pendingParseInputs.delete(message.pluginId);
    }
  }
  if (message.op === 'command') {
    const reply = await host.call({ type: 'command', pluginId: message.pluginId, commandId: message.commandId });
    return reply.ok ? { ok: true } : { ok: false, message: reply.message || 'command failed' };
  }
  if (message.op === 'panel-action') {
    const reply = await host.call({
      type: 'panel-action',
      pluginId: message.pluginId,
      panelId: typeof message.panelId === 'string' ? message.panelId : '',
      actionId: typeof message.actionId === 'string' ? message.actionId : '',
      values: message.values && typeof message.values === 'object' && !Array.isArray(message.values) ? message.values : {},
    });
    return reply.ok ? { ok: true, result: reply.result } : { ok: false, message: reply.message || 'panel action failed' };
  }
  if (message.op === 'asset-probe' || message.op === 'asset-submit') {
    const reply = await host.call({
      type: message.op === 'asset-probe' ? 'probe' : 'submit',
      pluginId: message.pluginId,
      sourceId: message.sourceId,
      submission: message.submission,
    });
    return reply.ok ? { ok: true, result: reply.result } : { ok: false, message: reply.message || 'asset call failed' };
  }
  return { ok: false, message: 'unknown sandbox operation' };
}

function listPluginClients(root) {
  return readPluginClients(root);
}

module.exports = {
  activateInstalledPlugins,
  invokePlugin,
  listPluginClients,
  setPluginStore,
  setArchiveReader,
  setStorageController,
  setHostRecoveryNotifier,
};
