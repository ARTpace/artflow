# ADR-056 · Windows frameless 窗口的程序化定位必须锁定尺寸

- 状态：已采纳
- 日期：2026-10-10
- 关联：`main.cjs`（`CHANNELS.windowMove`）、`hooks/useCanvasWindowMove.ts`、`scripts/check-window-move-growth.cjs`

## 背景

用户报障原文：「使用鼠标右键拖动界面 会出现拖动界面慢慢自己变大的bug」。

现象是画布上右键拖拽（= 移动应用窗口）时，**窗口一边移动一边变大**，拖得越久涨得越多。

`useCanvasWindowMove` 的手势本身没问题（6px 阈值、右键捕获、contextmenu抑制都对），
问题全在主进程这一行：

```js
win.setPosition(session.baseX + Math.round(x - session.x), session.baseY + Math.round(y - session.y));
```

## 根因（实测，非推测）

用最小 Electron 脚本做了三组对照，每组都模拟 60 帧拖拽：

| 场景 | 起始 | 60 帧后 | 结论 |
|---|---|---|---|
| A：`setPosition` + `thickFrame:true`（修复前） | 801×602 | **861×662** | 每帧恰好 +1px |
| B：`setBounds` 带原尺寸 | 801×602 | 802×603（第一帧 +1 后恒定） | 稳定 |
| C：`setPosition` + `thickFrame:false` | 800×600 | **860×660** | 同样膨胀 |

**根因**：Windows 上对 `frame:false` 的窗口调用 `setPosition`，Chromium 会按窗口边框
重新计算外框，**每调用一次就把边框厚度再累加一层**。拖拽期间渲染层每帧（rAF 合并后
仍约 60 次/秒）发一次 `update`，于是每帧 +1px —— 拖 1 秒长 60px，视觉上就是"慢慢变大"。

场景 C 是重要的**反证**：`thickFrame:false` 完全无效，说明这与 `thickFrame` 无关。
排查时很容易先怀疑「无边框窗口的 resize 边框」，但那条路是死的。

## 决策

### 1. 每帧显式回传宽高，不用只给位置的 `setPosition`

`windowMove` 的 session 在 `start` 阶段锁定 `{ baseX, baseY, width, height }`，
`update` 阶段一律走 `setBounds`：

```js
win.setBounds({
  x: session.baseX + Math.round(x - session.x),
  y: session.baseY + Math.round(y - session.y),
  width: session.width,
  height: session.height,
});
```

锁定的是**手势开始那一刻**的尺寸：拖拽过程中即便系统在其他路径动过尺寸，也不会被拖拽带跑。
用户自己拖边框改大小是在手势之外发生的，不受影响。

最大化还原那条分支（`unmaximize` 后按抓取点比例复位）同样换成 `setBounds` 并回传
`restored.width/height` —— 它也在拖拽链路上，一次都不例外。

残留的 1px 是边框量化误差（`setBounds` 也会加一次），只发生在手势第一帧，之后恒定，
不影响使用；判据把它显式列为"允许 1px"。

### 2. 回归检查必须双向断言，不能只断言"当前写法是好的"

`scripts/check-window-move-growth.cjs` 同时跑两种写法：

- `legacy-reproduces`：只给位置的 `setPosition` **必须**复现膨胀（漂移 ≥ 20px）
- `current-stable`：锁定尺寸的 `setBounds` 必须稳定（漂移 ≤ 1px）

只断言"当前写法稳定"的话，脚本有可能因为**根本没能触发那条代码路径**而永远 PASS
—— 这种检查不产生任何保护力。让它同时证明"能抓到缺陷"和"修复有效"，缺一条就 FAIL。

## 后果与边界

- **平台**：缺陷只在 Windows（`frame:false`）。`main.cjs` 的 `windowMove` 处理器本身就有
  `process.platform !== 'win32'` 前置拒绝，所以调用方无需改动；非 win32 上检查脚本 SKIP。
- **性能**：`setBounds` 与 `setPosition` 同为同步 IPC 消息，无额外开销；每帧多传两个整数，
  载荷可忽略。
- **面板窗口**：`openPanelWindow` 的面板窗口同样是 `frame:false + resizable:true`。
  它目前没有右键拖窗链路，但若将来接入，必须同样锁尺寸 —— 检查脚本对任意 frameless
  窗口都成立，可直接复用。

## 环境备注（本机实测踩到）

- `ELECTRON_RUN_AS_NODE=1` 会让 `electron.exe` 当纯 Node 跑，`app` 是 `undefined`。
  跑 Electron 脚本必须 `env -u ELECTRON_RUN_AS_NODE`。
- Windows 下 Electron 是 GUI 子系统，**stdout 不可靠**（`console.log` 拿不到），
  判据必须写文件。
- 本机主进程 `setTimeout` 在长时间同步操作后不触发，`await settle(ms)` 会挂住；
  改用 `Atomics.wait` 同步让出消息循环（`setBounds` 的 Windows 消息是同步投递的）。
- `app.exit()` 在本机不生效，用 `process.exit()` 带走退出码。