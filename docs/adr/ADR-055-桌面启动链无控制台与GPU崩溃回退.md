# ADR-055 · 桌面启动链契约：无控制台 + 启动动画 + GPU 崩溃回退

- 状态：已采纳
- 日期：2026-10-09
- 关联：`scripts/launch-desktop.cjs`、`start-electron.vbs`、`start-electron.cmd`、`main.cjs`、`启动 Artflow.lnk`

## 背景

用户报障原文：「这个启动 需要支持启动动画和 不要显示命令窗口」。

排查结论是：**两项能力代码里都已经有了**（`branding/splash.html` + `main.cjs` 的
`createSplashWindow()`；`start-artflow.vbs` 的无窗口 VBS→node 启动器），真正的缺陷只有两处：

1. **快捷方式的指向错了** —— `启动 Artflow.lnk` 指向 `start-electron.cmd`，而它第 54 行是
   `start "Artflow" /d "%~dp0" "node_modules\.bin\electron.cmd" .`。`electron.cmd` 是批处理，
   Windows 必须用 `cmd /K` 承载它，**那个黑窗会一直开到会话结束**。进程导出实锤：
   `C:\Windows\system32\cmd.exe  /K ""node_modules\.bin\electron.cmd""  . `
2. **本机 GPU 子进程必崩** —— `GPU process exited unexpectedly: exit_code=-1073741819` ×9 后
   跟 `FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417] GPU process isn't usable.
   Goodbye.`，Electron 在 ~0.5~3s 内带 `2147483651` 退出，**splash 还没上屏**。
   用户看到的"没有启动动画"，实际是"应用崩了"（单实例复现，与并发无关）。

## 决策

### 1. 快捷方式指向 `.vbs`，永不指向 `.cmd`

`.cmd` 是**调试入口**（要看得见 Electron 实时日志）；用户入口是 `.vbs`。
VBS 用 `sh.Run(cmd, 0, True)` 起 node —— 窗口样式 0 给 node 一个**隐藏**的控制台，
而 node 是控制台程序，隐藏而不消失，所以后续子进程仍能正常继承 stdio。

`.cmd` 内部也从 `start ... electron.cmd` 改成 `call "node_modules\.bin\electron.cmd" .`：
`call` 复用当前控制台，不再派生第二个 `cmd /K`。

### 2. `.lnk` 用"等长字节补丁"改指向，不重建

`.lnk` 的目标存在**四处**：IDList ANSI / IDList UTF-16 / LinkInfo `LocalBasePath` /
StringData `RELATIVE_PATH`。四处必须一致。

不重建的理由是实测的：手工拼一个最小 MS-SHLLINK（不含 LinkTargetIDList）会被
`Start-Process` 以「没有应用程序与此操作的指定文件有关联」拒绝，而 Explorer 生成的
原快捷方式能正常启动。等长替换（`start-electron.cmd` → `start-electron.vbs`，都是 18 字符）
则完全绕开长度字段重写，风险最小。

**因此文件名长度是承重的**：`start-electron.vbs` 必须保持 18 字符。
备份留在 `scratch/<日期>_launch-ux/启动 Artflow.lnk.orig`。

### 3. 前端与 Electron 并行拉起，冷启动等待由 splash 覆盖

旧顺序是"等前端就绪再拉窗口"，冷启动那几秒屏幕上什么都没有 —— 这正是"没有动画"的观感来源。
现在 Electron 一起来就上 splash（`app ready` 后 ~0.5s），前端就绪与否由 `main.cjs` 在 dev 下
自己轮询（`waitForDevServer`），**等待全程被 splash 盖住**。

splash 的兜底计时器必须**延迟起表**：`armSplashTimeout()` 只在 `loadURL`/`loadFile`
**之后**调用。从 `whenReady` 起表的话，dev 冷启动"等前端服务"那段会先把预算吃光，
窗口在渲染层就绪前就被强制显示 —— 用户看到的是一个空壳。

### 4. GPU 崩溃：先按用户选择跑，崩了兜底一次

GPU 正常时它换来的是画布拖拽性能，不能因为偶发崩溃就默认关掉。所以策略是
**一次性回退**：`exitCode !== 0` 且 `runtimeMs < 10s` 且 `electron.log` 里出现 GPU 崩溃
原文签名（`GPU process isn't usable` / `gpu_process_host.cc`）时，改用
`--no-sandbox --disable-gpu --in-process-gpu` 重启一次，并把崩溃那次的日志另存为
`logs/electron-gpu-crash.log` 作为证据。

### 5. Vite 内部的 `net use` 探针由 preload 隐藏

Vite 在 Windows 上会无条件 `exec("net use")` 探测映射网络盘
（`optimizeSafeRealPathSync`，见 `node_modules/vite/dist/node-cjs/publicUtils.cjs`）。
它没传 `windowsHide`，而我们把 Vite 起成 `CREATE_NO_WINDOW`（**该进程没有控制台**），
于是那个 `cmd.exe` 只能**新分配**一个控制台 —— 新分配的控制台默认可见，就是每次启动
闪一下的黑窗。实测抓到：`cmd.exe:500 parent=<vite> :: /d /s /c "net use"`，`visible=[500]`。

修法是只给这一条命令的 `windowsHide` 强制为 true（`scripts/vite-preload-hide-console.cjs`
经 `node --require` 预加载）。`net use` 照常执行、stdout 照常回给 Vite 的解析回调，
**判定逻辑一字不改** —— 修的是我们自己的进程创建方式，不是 Vite 的行为。

### 6. 启动器自身的两条健壮性约束

- **`log()` 先落文件、再尽力回显 stdout，两处各自 try/catch**。双击场景下 stdout 随时可能
  断（EPIPE），日志失败绝不能升级成启动失败。
- **`waitForExit` 必须把 settle 结果交给 resolve**。写成 `child.once('exit', settle)` 的话，
  `settle` 的返回值会被 EventEmitter 丢掉，Promise 永不 settle —— 表现是 Electron 崩了、
  窗口没了，启动器却一直卡在 `await` 里，回退逻辑永远不跑。（这个坑真实踩过，
  日志里"Electron 已退出"整行消失是它的唯一症状。）

## 影响

- 用户入口 `启动 Artflow.lnk` → `start-electron.vbs` → `node scripts/launch-desktop.cjs`
  → 并行起 Vite（隐藏控制台）+ Electron（GUI，无控制台）。全程无可见控制台窗口。
- 调试入口 `start-electron.cmd` 保持可见日志，并且不再派生第二个黑窗。
- GPU 崩溃的机器上，第一次启动会多花 ~0.5~3s（崩溃那轮的启动时间）。
  彻底避免需要"熔断记忆"（记住崩溃、冷却期内直接软件渲染），当前**未实现**，
  见下节。

## 未采纳 / 待定

- **GPU 熔断记忆**：把崩溃时间戳持久化，冷却期（如 6 小时）内直接软件渲染，到期再试一次 GPU。
  代价是引入一个跨启动状态文件；收益是这台机器每次启动省掉一次必然失败的尝试。
  属于"策略缝"，等用户决定取舍。
- **把 `--nogpu` 做进快捷方式**：简单直接，但会把软件渲染固化成默认，
  丢了 GPU 正常时的画布性能。倾向用熔断而不是写死。
