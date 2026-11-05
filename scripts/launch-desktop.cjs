#!/usr/bin/env node
/**
 * 职责：无窗口启动 Artflow 桌面端（dev 模式）。
 *
 * 链路：
 *   start-electron.vbs（双击 / 桌面快捷方式，无窗口）
 *     └─ 本脚本（node，控制台已被 VBS 隐藏）
 *          ├─ Vite dev server（隐藏控制台，日志 → logs/vite.log）
 *          └─ Electron 主窗口（GUI 子系统，天然无控制台，日志 → logs/electron.log）
 *
 * 三条硬约束（都是实测踩出来的，改前先读）：
 *  1. Electron 必须用 `node_modules/electron/dist/electron.exe` 直接启动，且**不能**加
 *     windowsHide / SW_HIDE：Electron 主窗口的首个 ShowWindow 会吃 STARTUPINFO 里的
 *     wShowWindow，一旦是 SW_HIDE，窗口创建成功却永远不可见（实测 isVisible()===false）。
 *  2. 端口由 dev-server.config.json 统一给出（当前 4002）且带 --strictPort：localStorage 按
 *     origin 隔离，端口漂移 = 换一份存储，插件开关与 AI 配置会「看起来被重置」。
 *     --strictPort 保证端口被占时直接失败退出，而不是静默漂到 4003 变成另一份存储。
 *  3. 启动前必须清掉宿主注入的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS：否则 Electron 会被
 *     当成纯 Node 跑，报 `require('electron') === undefined`。
 *
 * 顺序：前端与 Electron **并行**拉起，不等前端就绪。冷启动那 2~3 秒由 splash 覆盖
 * （main.cjs 在 dev 下自己轮询服务再装载）。就绪等待只作为诊断存在。
 *
 * 「不弹命令窗口」是由三处一起保证的（历史上分别踩过）：
 *   a. 快捷方式指向 .vbs（不是 .cmd）—— 旧版 `start "Artflow" electron.cmd` 会派生
 *      一个 `cmd /K`，那个黑窗会**整个会话都开着**。
 *   b. Vite 与 Electron 都被拉成「没有可见控制台」的进程；Vite 内部 exec("net use")
 *      那次由 vite-preload-hide-console.cjs 兜住（否则会闪一个新分配的黑窗）。
 *   c. Electron 不能用 windowsHide（见约束 1），但它是 GUI 子系统，本身不产生控制台。
 *
 * 带窗口的调试启动是 ./start-electron.cmd（能看到 Electron 实时日志）。
 *
 * 参数：
 *   --mode=dev|prod   dev（默认，Vite dev server + HMR，代码永远最新）
 *                     prod（预构建产物，首帧快约 1s；需先 npm run build）
 *   --ephemeral       服务随窗口退出（默认是常驻复用，省掉下次 1~2s 冷启动）
 *   --nogpu           强制软件渲染（本机 GPU 子进程不稳时用）。不加则**自动**兜底：
 *                     GPU 版启动后立刻崩（带 GPU 崩溃签名）时，自动改用软件渲染重试一次。
 *   --port=           端口（默认 4002；换端口 = 换 localStorage origin，慎改）
 *   --app-dir=        备用入口目录（默认项目根，测试用）
 *   --dry-run         只打印启动计划
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 端口只有一个来源：根目录 dev-server.config.json。vite.config.ts 与 main.cjs 都读同一份，
// 避免"三个地方各写一个数字"再次漂移（端口漂移 = 换 localStorage origin = 插件偏好整套作废）。
const DEV_SERVER_CONFIG = require('../dev-server.config.json');

const DEFAULTS = Object.freeze({
  port: DEV_SERVER_CONFIG.port,
  readyTimeoutMs: 30_000,
  readyPollMs: 250,
});

// GPU 关闭时的 Electron 开关，与 start-electron.cmd --nogpu 保持同一套语义。
const SOFTWARE_GPU_FLAGS = Object.freeze(['--no-sandbox', '--disable-gpu', '--in-process-gpu']);

// Vite 的 Windows 网络盘探测会 exec("net use")，那个 cmd 会新分配一个可见控制台。
// 这个 preload 只把该命令的窗口藏掉（Vite 判定逻辑不变），否则每次启动都闪一下黑窗。
const VITE_PRELOAD = path.join(__dirname, 'vite-preload-hide-console.cjs');

// GPU 崩溃的判定窗口：真正跑起来的实例会活很久，只有"刚起来就死"才像 GPU 子进程崩。
// 本机实测崩溃发生在 ~500ms，给到 10s 留足慢机器余量，同时不至于把"用户用了一会儿嫌烦主动关掉"
// 误判成崩溃（那种情况 runtimeMs 远超此值）。
const GPU_CRASH_WINDOW_MS = 10_000;

// GPU 崩溃在 electron.log 里留下的原文签名（任一条命中即可判为 GPU 不可用）。
const GPU_FATAL_SIGNATURES = Object.freeze([
  "GPU process isn't usable",
  'gpu_process_host.cc',
]);

function parseArgs(argv) {
  const options = { port: DEFAULTS.port, nogpu: false, dryRun: false, appDir: ROOT, mode: 'dev', ephemeral: false };
  for (const arg of argv) {
    if (arg === '--nogpu') options.nogpu = true;
    else if (arg === '--dry-run') options.dryRun = true;
    // 默认把 dev server 留着（下次启动省掉 1~2s 冷启动）；--ephemeral 让它随窗口退出。
    else if (arg === '--ephemeral') options.ephemeral = true;
    else if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      if (mode !== 'dev' && mode !== 'prod') throw new Error(`--mode 只支持 dev / prod，收到：${mode}`);
      options.mode = mode;
    } else if (arg.startsWith('--app-dir=')) {
      // 演进缝：默认就是项目根；换目录可用来跑其它构建，或对启动链路做隔离验证。
      const dir = path.resolve(arg.slice('--app-dir='.length));
      if (!fs.existsSync(dir)) throw new Error(`--app-dir 不存在：${dir}`);
      options.appDir = dir;
    } else if (arg.startsWith('--port=')) {
      const port = Number.parseInt(arg.slice('--port='.length), 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port 需要 1-65535 的整数，收到：${arg}`);
      }
      options.port = port;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/** 子进程环境：清掉宿主注入的变量，并把 dev 模式显式钉在固定 origin 上。 */
function buildChildEnv(options) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.PYTHONPATH;
  env.NODE_ENV = 'development';
  env.VITE_DEV_SERVER_URL = `http://localhost:${options.port}`;
  if (options.nogpu) env.ARTFLOW_DISABLE_GPU = '1';
  return env;
}

/** 逐个探测候选路径，返回第一个存在的（不写死单一位置，方便换包管理器）。 */
function locateFirst(candidates, hint) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 ${hint}，候选：\n  ${candidates.join('\n  ')}`);
}

function locateElectronExe() {
  const distDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
  return locateFirst(
    [path.join(distDir, 'electron.exe'), path.join(distDir, 'electron')],
    'Electron 可执行文件（先跑 npm install）',
  );
}

function locateViteEntry() {
  return locateFirst(
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')],
    'Vite CLI 入口（先跑 npm install）',
  );
}

function openLog(logDir, fileName) {
  fs.mkdirSync(logDir, { recursive: true });
  return fs.openSync(path.join(logDir, fileName), 'w');
}

/**
 * 造一个「启动一次 Electron」的函数。做成工厂是因为 GPU 回退要启动**第二次**，
 * 每次都得重新开日志句柄（openLog 用 'w' 会截断，正好让 electron.log 只保留最近一次）。
 */
function createElectronLauncher({ electronExe, appArg, env, logDir, log }) {
  return function launchElectron(extraFlags) {
    const electronLog = openLog(logDir, 'electron.log');
    const child = spawn(electronExe, [appArg, ...extraFlags], {
      cwd: ROOT,
      env,
      // 硬约束 1：**不能** windowsHide / SW_HIDE —— Electron 主窗口的首个 ShowWindow 会吃
      // STARTUPINFO.wShowWindow，一旦是 SW_HIDE，窗口创建成功却永远不可见。
      // 控制台是靠 stdout/stderr 重定向到日志文件消除的（Electron 是 GUI 子系统，本身不弹黑窗）。
      windowsHide: false,
      stdio: ['ignore', electronLog, electronLog],
    });
    // 每次启动都记下时间戳，避免 waitForExit 用"调用时刻"当起点（回退那次调用链更长）。
    child.__startedAt = Date.now();
    child.once('exit', () => {
      try {
        fs.closeSync(electronLog);
      } catch {
        /* 句柄已关闭 */
      }
    });
    child.on('error', error => log(`Electron 启动失败：${error.message}`));
    const suffix = extraFlags.length ? `，附加参数 ${extraFlags.join(' ')}` : '';
    log(`已拉起 Electron（pid=${child.pid}${suffix}），日志 → logs/electron.log`);
    return child;
  };
}

/** 等子进程退出，返回 { exitCode, runtimeMs }。runtimeMs 供 GPU 崩溃判定用。 */
function waitForExit(child) {
  const startedAt = child.__startedAt ?? Date.now();
  const settle = (code, signal) => ({
    // 被信号杀掉没有 code（null）—— 对判定而言属于"非正常退出"，一律折成非零。
    exitCode: code ?? (signal ? 1 : 0),
    runtimeMs: Date.now() - startedAt,
  });
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(settle(child.exitCode, child.signalCode));
      return;
    }
    // 注意：必须把结果交给 resolve。写成 `once('exit', settle)` 的话，settle 的返回值
    // 会被 EventEmitter 丢掉，Promise 永不 settle —— 表现是 Electron 崩了、窗口没了，
    // 但启动器一直卡在 await 里，回退逻辑永远不跑（这个坑真实踩过）。
    child.once('exit', (code, signal) => resolve(settle(code, signal)));
  });
}

/** 上一次 Electron 运行留下的日志里，是否有 GPU 子进程崩溃的原文签名。 */
function hasGpuFatalSignature(logDir) {
  try {
    const text = fs.readFileSync(path.join(logDir, 'electron.log'), 'utf8');
    return GPU_FATAL_SIGNATURES.some(signature => text.includes(signature));
  } catch {
    return false;
  }
}

async function isServerReady(port) {
  try {
    const response = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(port, log) {
  const deadline = Date.now() + DEFAULTS.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReady(port)) return true;
    await sleep(DEFAULTS.readyPollMs);
  }
  log(`等待前端服务(${port}) 就绪超时，请查看 logs/vite.log`);
  return false;
}

/** dev = Vite dev server（HMR，模块按需转换）；prod = 预构建产物（首帧明显更快）。 */
function buildServerArgs(viteEntry, options) {
  const tail = ['--port', String(options.port), '--strictPort'];
  // --require 必须排在入口脚本**之前**：Vite 在 Windows 上会 exec("net use") 探测网络盘，
  // 那次 exec 会新分配一个可见控制台（黑窗闪一下）。preload 把这条命令的窗口藏掉。
  const head = ['--require', VITE_PRELOAD, viteEntry];
  return options.mode === 'prod' ? [...head, 'preview', ...tail] : [...head, ...tail];
}

function assertProdBuildReady() {
  const entry = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(entry)) return;
  throw new Error(
    '--mode=prod 需要先构建：dist/index.html 不存在。\n'
    + '  请先执行 npm run build，或不带 --mode=prod 用 dev 模式启动。',
  );
}

/** Windows：连带子进程一起结束（Vite 会派生 esbuild 服务进程）。 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* 进程已退出 */
  }
}

function tailLines(filePath, lineCount) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').slice(-lineCount).join('\n').trim();
  } catch {
    return '(无日志)';
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const launcherLog = path.join(logDir, 'launcher.log');
  // 先落文件（真源），再尽力回显到 stdout。stdout 在"双击 / 隐藏控制台"场景下随时可能
  // EPIPE（父窗口关了、控制台没了），一旦 write 抛异常就会把启动器弄死——日志失败绝不能
  // 升级成启动失败，所以两处都各自兜住。
  const log = message => {
    const line = `[${new Date().toISOString()}] ${message}`;
    try {
      fs.appendFileSync(launcherLog, `${line}\n`);
    } catch {
      /* 磁盘写不了也不能让启动链断掉 */
    }
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      /* stdout 已断（EPIPE），忽略 */
    }
  };

  const electronExe = locateElectronExe();
  const viteEntry = locateViteEntry();
  if (options.mode === 'prod') assertProdBuildReady();
  const viteArgs = buildServerArgs(viteEntry, options);
  const appArg = options.appDir === ROOT ? '.' : options.appDir;
  const electronArgs = [appArg, ...(options.nogpu ? SOFTWARE_GPU_FLAGS : [])];

  if (options.dryRun) {
    log('--dry-run：只解析计划，不启动任何进程');
    log(`  模式     : ${options.mode}${options.ephemeral ? '（服务随窗口退出）' : '（服务常驻复用）'}`);
    log(`  electron : ${electronExe} ${electronArgs.join(' ')}`);
    log(`  server   : ${process.execPath} ${viteArgs.join(' ')}`);
    log(`  日志目录 : ${logDir}`);
    return 0;
  }

  const env = buildChildEnv(options);
  const launchElectron = createElectronLauncher({ electronExe, appArg, env, logDir, log });
  let viteProcess = null;

  if (await isServerReady(options.port)) {
    log(`复用已在运行的前端服务（http://localhost:${options.port}）`);
  } else {
    const viteLog = openLog(logDir, 'vite.log');
    viteProcess = spawn(process.execPath, viteArgs, {
      cwd: ROOT,
      env,
      // Vite 是控制台程序，windowsHide 只藏它的控制台窗口，不影响任何 GUI。
      windowsHide: true,
      stdio: ['ignore', viteLog, viteLog],
      // detached + unref：父进程退出后它继续活着，下次启动直接复用（省掉 1~2s 冷启动）。
      detached: !options.ephemeral,
    });
    if (!options.ephemeral) viteProcess.unref();
    log(`已拉起 ${options.mode === 'prod' ? 'preview' : 'Vite dev'} 服务（pid=${viteProcess.pid}），日志 → logs/vite.log`);
    viteProcess.on('error', error => log(`前端服务启动失败：${error.message}`));
  }

  // 立刻拉起 Electron，**不等**前端就绪。
  //
  // 旧顺序是"先等前端就绪再拉窗口"：冷启动那 2~3 秒里屏幕上什么都没有，
  // 用户看到的是一个"双击后没反应"的应用 —— 那正是"启动没有动画"的观感来源。
  // 现在改成并行：Electron 一起来就把 splash 亮起来（app ready 后 ~0.5s 上屏），
  // 前端服务就绪与否由 main.cjs 在 dev 模式下自己轮询解决，等待全程被 splash 盖住。
  let electronProcess = launchElectron(options.nogpu ? SOFTWARE_GPU_FLAGS : []);

  // 就绪等待降级为**诊断**：不阻塞窗口，只负责把失败落进日志并回收前端进程。
  // Electron 侧有独立的等待上限，超时后会走既有的"加载失败兜底"把窗口交出去。
  if (viteProcess) {
    void waitForServer(options.port, log).then(ready => {
      if (ready) {
        log(`前端服务就绪（${options.mode}）`);
        return;
      }
      log(`前端服务未能就绪，最后 20 行 vite.log：\n${tailLines(path.join(logDir, 'vite.log'), 20)}`);
      killTree(viteProcess.pid);
    });
  }

  const stopVite = () => {
    if (viteProcess && viteProcess.exitCode === null) {
      log('关闭前端服务');
      killTree(viteProcess.pid);
    }
  };
  process.on('SIGINT', () => {
    stopVite();
    if (electronProcess.exitCode === null) killTree(electronProcess.pid);
    process.exit(0);
  });

  let { exitCode, runtimeMs } = await waitForExit(electronProcess);
  log(`Electron 已退出（code=${exitCode}，运行 ${Math.round(runtimeMs / 1000)}s）`);

  // —— GPU 崩溃自动回退（一次）——
  // 本机实测：GPU 子进程会连刷 `gpu_process_host ... exit_code=-1073741819` 然后
  // FATAL `GPU process isn't usable. Goodbye.`，Electron 在 ~500ms 内带着非零码退出。
  // 那一刻 splash 还没来得及上屏，用户看到的是"双击没反应"—— 与"没有启动动画"是同一个现象。
  // GPU 正常时它带来的是画布拖拽性能，不能因为偶发崩溃就默认关掉；所以策略是
  // **先按用户的选择跑，崩了才兜底重试一次**，并把 GPU 那次的日志另存为证据。
  if (!options.nogpu && exitCode !== 0 && runtimeMs < GPU_CRASH_WINDOW_MS && hasGpuFatalSignature(logDir)) {
    const archive = path.join(logDir, 'electron-gpu-crash.log');
    try {
      fs.copyFileSync(path.join(logDir, 'electron.log'), archive);
    } catch (error) {
      log(`保存 GPU 崩溃日志失败：${error.message}`);
    }
    log(`检测到 GPU 进程崩溃 → 改用软件渲染重试一次（拖着画布会变慢，但至少能起来）；证据 → logs/electron-gpu-crash.log`);
    electronProcess = launchElectron(SOFTWARE_GPU_FLAGS);
    ({ exitCode, runtimeMs } = await waitForExit(electronProcess));
    log(`Electron 已退出（软件渲染，code=${exitCode}，运行 ${Math.round(runtimeMs / 1000)}s）`);
  }

  if (options.ephemeral) stopVite();
  else if (viteProcess) log('前端服务保持后台运行（下次启动直接复用；要它随窗口退出请加 --ephemeral）');
  if (exitCode !== 0) {
    log(`最后 20 行 electron.log：\n${tailLines(path.join(logDir, 'electron.log'), 20)}`);
  }
  return exitCode;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    // 双击场景没有可见控制台，失败详情落 logs/launcher.log（VBS 会弹窗提示）。
    try {
      fs.appendFileSync(
        path.join(ROOT, 'logs', 'launcher.log'),
        `[${new Date().toISOString()}] 启动失败：${error.message}\n${error.stack}\n`,
      );
    } catch {
      /* 日志都写不了就只能静默 */
    }
    process.stderr.write(`启动失败：${error.message}\n`);
    process.exit(1);
  });
