// 回归检查：Windows frameless 窗口的右键拖拽定位不得让窗口逐帧变大。
//
// 背景（实测复现，Electron 44 / Windows）：
//   对 frame:false 的窗口每帧调用 setPosition，Chromium 会按窗口边框重算外框，
//   每调用一次就把边框厚度再累加一层 → 每帧 +1px，拖 1 秒长 60px，窗口肉眼可见地
//   "越拖越大"。setBounds 显式回传宽高则恒定；thickFrame:false 同样无效
//   （说明与 thickFrame 无关，别再往那个方向排查）。
//
// 判据（两条都要满足）：
//   1. legacy：只给位置的 setPosition 必须复现膨胀（证明本脚本真能抓到该缺陷，
//      否则一个永远 PASS 的检查毫无价值）；漂移应 >= 20px。
//   2. current：setBounds 带锁定尺寸必须稳定，漂移 <= 1px。
//
// 用法：npm run check:window-move-growth
//   Windows 上以 Electron 进程运行；非 win32 跳过并视为通过。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const FRAMES = 60;
/** 边框量化误差：setBounds 第一帧可能 +1px，属正常。 */
const MAX_ALLOWED_DRIFT_PX = 1;
/** 复现阈值：60 帧 × 1px = 60px，留足余量取 20px。 */
const MIN_LEGACY_DRIFT_PX = 20;

const OUT = path.join(__dirname, '.window-move-growth.result.txt');
const log = (...args) => {
  try { fs.appendFileSync(OUT, args.join(' ') + '\n'); } catch { /* 诊断输出失败不掩盖判据 */ }
};

/** 主进程 setTimeout 在部分环境被节流到不触发；setBounds 的 Windows 消息同步投递，
 *  Atomics.wait 让出消息循环即可，不需要真实时间流逝。 */
const park = (ms) => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
};

const dragWith = (win, base, apply) => {
  for (let i = 1; i <= FRAMES; i += 1) apply(base, i);
  park(400);
  const end = win.getBounds();
  return { width: end.width - base.width, height: end.height - base.height, end };
};

const run = async () => {
  fs.writeFileSync(OUT, `check-window-move-growth ${new Date().toISOString()} pid=${process.pid}\n`);
  if (process.platform !== 'win32') {
    log('SKIP: 该缺陷只存在于 Windows');
    log('RESULT: PASS');
    process.exit(0);
    return;
  }

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    frame: false,
    thickFrame: true,
    resizable: true,
  });
  win.loadURL('data:text/html,<body style="background:%23222"></body>');
  park(800);

  // 1) legacy 写法：只给位置（修复前的实现）
  win.setBounds({ x: 300, y: 300, width: 800, height: 600 });
  park(400);
  const legacyBase = win.getBounds();
  const legacy = dragWith(win, legacyBase, (b, i) => {
    win.setPosition(b.x + i, b.y + i);
  });
  log(`legacy setPosition: base=${JSON.stringify(legacyBase)} drift=${JSON.stringify({ width: legacy.width, height: legacy.height })}`);

  // 2) current 写法：锁定起始尺寸，每帧 setBounds 回传宽高（main.cjs 的实现）
  win.setBounds({ x: 300, y: 300, width: 800, height: 600 });
  park(400);
  const currentBase = win.getBounds();
  const current = dragWith(win, currentBase, (b, i) => {
    win.setBounds({ x: b.x + i, y: b.y + i, width: b.width, height: b.height });
  });
  log(`current setBounds: base=${JSON.stringify(currentBase)} drift=${JSON.stringify({ width: current.width, height: current.height })}`);

  const legacyReproduced = Math.abs(legacy.width) >= MIN_LEGACY_DRIFT_PX
    || Math.abs(legacy.height) >= MIN_LEGACY_DRIFT_PX;
  const currentStable = Math.abs(current.width) <= MAX_ALLOWED_DRIFT_PX
    && Math.abs(current.height) <= MAX_ALLOWED_DRIFT_PX;
  const passed = legacyReproduced && currentStable;

  log(`ASSERT legacy-reproduces: ${legacyReproduced ? 'PASS' : 'FAIL'} (need >= ${MIN_LEGACY_DRIFT_PX}px, got ${legacy.width}/${legacy.height})`);
  log(`ASSERT current-stable: ${currentStable ? 'PASS' : 'FAIL'} (allowed <= ${MAX_ALLOWED_DRIFT_PX}px, got ${current.width}/${current.height})`);
  log(`RESULT: ${passed ? 'PASS' : 'FAIL'}`);
  // 判据已写盘，用 process.exit 明确带走退出码（app.exit 在部分环境不生效）。
  process.exit(passed ? 0 : 1);
};

app.whenReady().then(() => {
  run().catch(error => {
    log(`RESULT: FAIL (${error.message})`);
    process.exit(1);
  });
});