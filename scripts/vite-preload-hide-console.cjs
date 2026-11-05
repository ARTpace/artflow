#!/usr/bin/env node
/**
 * 职责：让 Vite 内部那一次 `net use` 探测不再弹出黑色控制台窗口。
 *
 * 背景（实测定位，改前先读）：
 *   Vite 在 Windows 上启动时会调用 `optimizeSafeRealPathSync()`
 *   （node_modules/vite/dist/node-cjs/publicUtils.cjs，函数体里有无条件的
 *    `child_process.exec("net use", ...)`）—— 目的是识别「映射网络盘」，因为
 *   Node 的 realpathSync.native 在映射盘上会解析成 UNC 路径。
 *
 *   问题不在 Vite，而在我们的启动方式：我们把 Vite 起成 `windowsHide: true`
 *   （= CREATE_NO_WINDOW，**该进程没有控制台**）。于是 Vite 再 exec 出来的那个
 *   `cmd.exe /d /s /c "net use"` 无处继承控制台，Windows 只能给它**新分配**一个
 *   —— 一个新分配的控制台窗口默认是**可见**的。表现就是：每次启动都闪一下黑窗。
 *
 * 做法：
 *   只把 `net use` 这一条命令的 `windowsHide` 强制为 true（= CREATE_NO_WINDOW）。
 *   `net use` 照常执行、stdout 照常回给 Vite 的解析回调，**判定逻辑一字不改**；
 *   区别只是那个 cmd 不再拥有可见窗口。
 *
 * 为什么安全：本机 `net use` 列表为空（H: 不是网络盘），Vite 走的本来就是
 *   `safeRealpathSync = fs.realpathSync.native` 这条分支；即使列表非空，输出也一模一样。
 *
 * 演进缝：要覆盖更多命令，只改 HIDDEN_COMMAND 正则即可；要整体关掉，别 require 它。
 */
'use strict';

const childProcess = require('node:child_process');

// Vite 用的是 `net use`（无参数）。这里放宽到任意 `net use ...`，免得 Vite 以后加参数时静默失效。
const HIDDEN_COMMAND = /^\s*net\s+use\b/i;

const originalExec = childProcess.exec;

childProcess.exec = function exec(command, options, callback) {
  if (typeof command === 'string' && HIDDEN_COMMAND.test(command)) {
    // exec(command, callback) 的两种重载都要接住。
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    return originalExec.call(this, command, { ...(options || {}), windowsHide: true }, callback);
  }
  return originalExec.apply(this, arguments);
};

// 保留 promisify(exec) 的能力（覆盖 `.exec` 会丢掉这个自定义符号）。
const kCustomPromisifiedSymbol = Symbol.for('nodejs.util.promisify.custom');
if (originalExec[kCustomPromisifiedSymbol]) {
  childProcess.exec[kCustomPromisifiedSymbol] = originalExec[kCustomPromisifiedSymbol];
}
