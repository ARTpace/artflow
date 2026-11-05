const sessions = new Map();
const hostWaiters = new Map();
let hostSeq = 0;
const reply = message => window.sandboxHost.reply(message);

// —— 插件日志回传 ——
// 沙箱窗口是隐藏的，它的 console 没有任何人看得到。把输出转成一条消息发回主进程打印，
// 否则第三方插件「到底跑没跑起来」无从判断 —— 这是插件作者最需要的那条反馈回路。
let currentPluginId = '';
function formatLogArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    try { original.apply(console, args); } catch { /* ignore */ }
    try {
      reply({ type: 'log', pluginId: currentPluginId, level, text: args.map(formatLogArg).join(' ').slice(0, 4000) });
    } catch { /* 日志永远不能反过来打断插件 */ }
  };
}

function hostBridge(pluginId) {
  return (op, fields) => new Promise((resolve, reject) => {
    const requestId = `h${pluginId}:${++hostSeq}`;
    hostWaiters.set(requestId, { resolve, reject });
    reply(Object.assign({ type: 'host', requestId, pluginId, op }, fields));
  });
}

window.sandboxHost.onMessage(message => {
  if (message.type === 'host-result') {
    const waiter = hostWaiters.get(message.requestId);
    if (!waiter) return;
    hostWaiters.delete(message.requestId);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.message || 'host call failed'));
    return;
  }
  // —— 宿主事件回推：单向推送，无 requestId，无需回执。 ——
  if (message.type === 'host-event') {
    const target = sessions.get(message.pluginId);
    if (target && typeof target.dispatchEvent === 'function') {
      try {
        target.dispatchEvent({ subscriptionId: message.subscriptionId, name: message.name, payload: message.payload });
      } catch (error) {
        console.error(`[events] dispatch failed: ${error && error.message || error}`);
      }
    }
    return;
  }
  const finish = payload => reply(Object.assign({ requestId: message.requestId }, payload));
  if (message.type === 'activate') {
    currentPluginId = message.pluginId;
    try {
      const session = window.ArtflowModuleTable.evaluatePluginSource(
        message.source,
        message.pluginId,
        hostBridge(message.pluginId),
        { hostApiVersion: message.hostApiVersion, manifest: message.manifest },
      );
      sessions.set(message.pluginId, session);
      // obsidian-compat 插件的 onload 是 async：等它跑完再回 catalog，
      // 否则 await 之后注册的命令/设置页会丢出清单。
      Promise.resolve(session.whenReady).then(
        () => finish({ type: 'activated', pluginId: message.pluginId, catalog: session.buildCatalog() }),
        error => finish({ type: 'activated', pluginId: message.pluginId, error: String(error && error.message || error) }),
      );
    } catch (error) {
      finish({ type: 'activated', pluginId: message.pluginId, error: String(error && error.message || error) });
    }
    return;
  }
  const session = sessions.get(message.pluginId);
  if (!session) {
    finish({ type: 'result', ok: false, message: 'plugin is not active' });
    return;
  }
  const action = message.type === 'parse'
    ? session.parse(message.handlerId, { name: message.name, mimeType: message.mimeType, bytes: message.bytes })
    : message.type === 'probe'
      ? session.probe(message.sourceId)
      : message.type === 'submit'
        ? session.submit(message.sourceId, message.submission)
        : message.type === 'panel-action'
          ? session.dispatchPanelAction(message.panelId, message.actionId, message.values)
          : session.run(message.commandId);
  Promise.resolve(action).then(
    result => finish({ type: 'result', ok: true, result: result || null }),
    error => finish({ type: 'result', ok: false, message: String(error && error.message || error) }),
  );
});

reply({ type: 'ready' });
