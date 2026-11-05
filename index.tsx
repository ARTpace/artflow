import './plugin-runtime/tauri-preview';
import { createServiceDirectory, SERVICE_DIRECTORY } from './plugin-runtime/service-directory';


import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { createKernel } from './plugin-runtime/kernel';
import { setKernel } from './plugin-runtime/instance';
import { loadBuiltinPlugins } from './plugin-runtime/loader';
import type { BuiltinPluginModule } from './plugin-runtime/loader';
import { validateManifest } from './plugin-runtime/manifest';
import { dumpResolvedProfile } from './plugin-runtime/profile';
import {
  createPluginProfileManager,
  PLUGIN_PROFILE_MANAGER_SERVICE,
  resolveStartupPluginProfile,
} from './plugin-runtime/plugin-profile-manager';
import { reloadForPluginApply } from './utils/pluginReload';
import { materializeRendererContributions } from './plugin-runtime/renderer-materialization';
import { createExtensionHost } from './plugin-runtime/extension-host';
import { EXTENSION_RUNTIME_SERVICE } from './plugin-runtime/extension-service';
import { bootstrapSkinEngine, createSkinEngine, SKIN_ENGINE_SERVICE } from './plugin-runtime/skin-engine';
import { createHostPlatformService, HOST_PLATFORM_SERVICE } from './plugin-runtime/host-platform';
import { MCP_EXPORT_REGISTRY } from './plugin-runtime/mcp-exports';
import { listLocaleContributions } from './plugin-runtime/locale-contributions';
import { setLocalePatches } from './utils/language-store';
import { BUILTIN_PLUGINS } from './builtin-plugins';
import { activateCoreModules, CORE_MODULE_IDS } from './core-modules';
import { createPluginStateStorage } from './plugin-runtime/plugin-state-storage';
import { createExternalPanels, activateExternalPlugins, watchSandboxHostRestart, EXTERNAL_PANELS_SERVICE } from './plugin-runtime/external-runtime';
import { applyDeclarativePlugins } from './plugin-runtime/declarative-loader';
import { loadEditablePlugins } from './plugin-runtime/editable-loader';
import { normalizeCardCapabilityManifest } from './plugin-runtime/card-capability-compat';
import { readStartupDisabledExternalPluginIds } from './plugin-runtime/external-plugin-prefs';
import { PipPanelApp } from './components/PipPanelApp';

/**
 * 根级错误边界：渲染期异常不再把窗口变成一片空白。
 * 直接动机：dev 态 Fast Refresh 会重挂载组件，而内核与插件激活是"一次性引导"的单例语义
 * （引导只在 index.tsx 跑一次），重挂载撞上重复登记时 React 会卸载整棵树 —— 表现为
 * "一改代码界面就空白，必须重启应用"。有了边界，最坏情况也只是一个可点击恢复的界面；
 * 配合 Kernel.replace 的幂等登记，正常情况下根本不会再抛。
 * 用内联样式：它挂在 App 之外，不能依赖任何应用内 CSS（崩的时候样式可能也没了）。
 */
class RootErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { error: Error | null }
> {
  // 本工程没有安装 @types/react（React 19 不自带类型），React.Component 在类型层近似 any，
  // 从基类继承来的 props 不可见 —— 显式声明本组件用到的字段即可。无初始化器 ⇒ 不产生运行时
  // 赋值，this.props 仍由 React 在构造期写入。
  props: { children?: React.ReactNode };
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[root] render crashed:', error, info);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#1b1f27', color: '#f4f4f5', padding: 24,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      }}>
        <div style={{ maxWidth: 560, width: '100%', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>界面遇到异常，已停止渲染</div>
          <pre style={{
            margin: 0, maxHeight: 200, overflow: 'auto', fontSize: 12, lineHeight: 1.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'rgba(244,244,245,0.75)',
          }}>{error.message}</pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16, padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.1)',
              color: '#f4f4f5', fontSize: 13,
            }}
          >
            重新加载界面
          </button>
          <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'rgba(244,244,245,0.5)' }}>
            开发态下改代码触发的热更新重挂载是常见原因；点上面的按钮即可恢复到干净状态，不需要重启应用。
          </div>
        </div>
      </div>
    );
  }
}

// 独立面板窗口（主窗口「弹出面板」创建的 frameless BrowserWindow）：只挂 PipPanelApp，
// 不挂主工作台；外部/声明式插件也跳过——避免同一 localStorage 配置下的双实例副作用。
const isPipPanelWindow = window.location.hash.startsWith('#pip-panel');

// This session's external-plugin state is fixed at bootstrap, NOT when Settings mounts.
// Preference changes made later are persisted immediately but require a reload to apply.
// 存储走主进程配置卷（`plugins.external.disabled`），不再依赖 window.localStorage。
readStartupDisabledExternalPluginIds();

// —— 启动期组合控制面 ——
// profile / patch 只过滤 capability plugin；Runtime Core 不走这个通道，不能被 user patch 关闭。
// editable 通道（formats-* / commands-core / media）的 manifest 同步并入：它们的源码在 userData 播种，
// 但**开关与 configSchema 必须与编译内置插件同级可见**（否则设置页看不到、也停不掉，阈值无处可改）。
// 只回 manifest 不回源码 —— 源码体积大，且只有渲染层执行时才需要，走异步 loadEditablePlugins。
const editableManifests: unknown[] = (() => {
  try { return (window.artflowPluginState?.readEditableManifestsSync?.().manifests ?? []).map(normalizeCardCapabilityManifest); } catch { return []; }
})();
const builtinManifests = [...BUILTIN_PLUGINS.map(plugin => plugin.manifest), ...editableManifests];
// 插件偏好存放在宿主侧文件（userData/plugin-profile.json），与 dev server 的 origin 无关 ——
// 否则换个启动方式（:4002 / 直跑 vite / 打包 file://）就会读到另一份空存储，
// 于是"关掉的插件重启又自己开了"。旧版本的 localStorage 数据会在首次启动时自动迁移一次。
const pluginStateStorage = createPluginStateStorage();
const { profile, warning: profileWarning } = resolveStartupPluginProfile(
  builtinManifests,
  pluginStateStorage,
  [],
  CORE_MODULE_IDS,
);
// 读取阶段的告警（文件损坏回退快照 / 完全读不出来 / 迁移失败）与解析阶段的告警合并，
// 统一交给设置页展示 —— 以前读失败是静默回退"全默认"，用户只会看到插件集体复活。
const startupWarning = [pluginStateStorage.warning, profileWarning].filter(Boolean).join('；') || null;
const enabledPluginIds = new Set(profile.enabledPluginIds);
// 隔离原则：manifest 非法的插件不进装载列表（原因已记录在 profile.rejected），本体照常启动。
const enabledBuiltinPlugins = BUILTIN_PLUGINS.filter(plugin => {
  try {
    return enabledPluginIds.has(validateManifest(plugin.manifest).id);
  } catch (error) {
    console.error('[bootstrap] skipped plugin with invalid manifest:', error);
    return false;
  }
});

// 顺序：Kernel → startup profile → generic profile service → builtin activation → renderer contributions → skin → React。
const kernel = createKernel();
setKernel(kernel);
kernel.provide(SERVICE_DIRECTORY, createServiceDirectory(profile.serviceBindings));
kernel.provide(PLUGIN_PROFILE_MANAGER_SERVICE, createPluginProfileManager({
  manifests: builtinManifests,
  activeProfile: profile,
  storage: pluginStateStorage,
  reload: () => reloadForPluginApply(),
  hostModuleIds: CORE_MODULE_IDS,
  warning: startupWarning,
}));
// 宿主平台能力（打开目录/窗口控制/字节落盘）必须在插件激活前 provide——插件 activate 时即可能消费。
// 存储桥（openPluginDir 在 artflowStorage 上）与窗口桥（artflowApp）合并成单一平台能力面。
const mcpBridge = window.artflowMcp;
kernel.provide(HOST_PLATFORM_SERVICE, createHostPlatformService({
  ...window.artflowStorage,
  ...window.artflowApp,
  confirm: message => window.confirm(message),
  setMcpEnabled: mcpBridge ? enabled => mcpBridge.setEnabled(enabled) : undefined,
  getMcpStatus: mcpBridge ? () => mcpBridge.getStatus() : undefined,
  createMcpCredential: mcpBridge ? request => mcpBridge.createCredential(request) : undefined,
  revokeMcpCredential: mcpBridge ? id => mcpBridge.revokeCredential(id) : undefined,
  revealMcpCredential: mcpBridge ? id => mcpBridge.revealCredential(id) : undefined,
  publishMcpCatalog: mcpBridge ? catalog => mcpBridge.publishCatalog(catalog) : undefined,
  onDispatch: mcpBridge ? handler => mcpBridge.onDispatch(handler) : undefined,
}));
const mcpExports = new Map<string, readonly string[]>();
for (const plugin of BUILTIN_PLUGINS) {
  try {
    const parsed = validateManifest(plugin.manifest);
    if (parsed.mcp) mcpExports.set(parsed.id, parsed.mcp.export);
  } catch {
    // 非法 manifest 已在后面的装载过滤里记录，这里跳过它的 MCP 白名单。
  }
}
kernel.provide(MCP_EXPORT_REGISTRY, mcpExports);
// 声明式扩展宿主（V3–V7）：单一运行时在 builtin 激活前就绪；invoke/update 由 App 在文档引导后 staging。
// 存储走主进程配置卷（默认参数），不再传 window.localStorage —— 安装列表不该按 origin 隔离。
kernel.provide(EXTENSION_RUNTIME_SERVICE, createExtensionHost());
// 皮肤引擎必须先于 builtin 激活 provide：主题库等皮肤面板 activate 时用
// ctx.use(SKIN_ENGINE_SERVICE) 拿引擎（M1 注册与激活分离，激活由用户点选/持久化恢复触发）。
// 皮肤自身的属性型开关（辉光/壁纸/气泡）由引擎的 attributeBindings 通道投影，无需运行时底座插件。
const skinEngine = createSkinEngine(kernel);
kernel.provide(SKIN_ENGINE_SERVICE, skinEngine);
activateCoreModules(kernel);
const externalPanels = createExternalPanels();
kernel.provide(EXTERNAL_PANELS_SERVICE, externalPanels);
void (async () => {
  // The desktop MCP listener follows the optional headless profile, never a protected core ID.
  if (!isPipPanelWindow) {
    try {
      await window.artflowMcp?.setEnabled(enabledPluginIds.has('builtin.headless'));
    } catch (error) {
      console.warn('[headless] MCP listener state could not be applied', error);
    }
  }
  // 内置可编辑插件（editable channel）：从 userData/plugins/builtin/builtin.*/plugin.js 读源码并受信任执行，
  // 与编译进 bundle 的 BUILTIN_PLUGINS 走**同一条** loadBuiltinPlugins 激活路径（同信任级、同 profile 过滤）。
  // 先执行拿到模块，再与内置模块合并统一装载 —— 这样依赖解析（builtin.cards 等）对两者一视同仁。
  let editableModules: BuiltinPluginModule[] = [];
  try {
    editableModules = await loadEditablePlugins(kernel);
  } catch (error) {
    console.warn('[editable] boot skipped', error);
  }
  const editableEnabled = editableModules.filter(module => {
    try { return enabledPluginIds.has(validateManifest(module.manifest).id); } catch { return false; }
  });
  loadBuiltinPlugins(kernel, [...enabledBuiltinPlugins, ...editableEnabled]);
  // 语言包补丁必须在 root.render 之前注入 —— 与 bootstrapSkinEngine 同一条时序约束：
  // 首帧就要用合并后的文案，否则会先按未合并的底座渲染一遍再"跳"一次。
  setLocalePatches(listLocaleContributions(kernel));
  const rendererContributions = materializeRendererContributions(kernel);

  // 外部声明式插件（皮肤 + 语言包）必须在 bootstrapSkinEngine 之前注册：
  // 默认皮肤包已转外部声明式，若在其抵达前就选定默认皮肤，回退逻辑会误选其它内置皮肤（aurora/abyssal）。
  try {
    await applyDeclarativePlugins(kernel); // 渲染进程经 IPC 拿到主进程预读的声明式清单（含皮肤）
  } catch (error) {
    console.warn('[declarative] boot skipped', error);
  }
  // 外部语言包异步到达后必须再刷一次补丁快照，否则注册进槽位也不会生效。
  setLocalePatches(listLocaleContributions(kernel));

  // 恢复持久化皮肤（token 含混搭 + CSS 皮肤，互斥兜底在 bootstrapSkinEngine 内）；引擎实例复用上面已 provide 的。
  bootstrapSkinEngine(kernel, skinEngine);

  // 调试口：resolved profile 是启动快照；可用 __bpProfile.dump() 复制用于问题复现。
  const debugSurface = window as unknown as Record<string, unknown>;
  debugSurface.__bpKernel = kernel;
  debugSurface.__bpSkinEngine = skinEngine;
  debugSurface.__bpRendererContributions = rendererContributions;
  debugSurface.__bpProfile = {
    resolved: profile,
    warning: startupWarning,
    storageSource: pluginStateStorage.source,
    dump: () => dumpResolvedProfile(profile),
  };

  // 启动诊断：把这一次真正读到的偏好来源、被拒条目与最终启用/关闭集上报主进程，
  // 落到 logs/electron.log 的 [boot +Nms] 行里。这些信息以前只在渲染层 console，
  // Electron 里根本看不到 —— 于是"插件关了又开"只能靠猜。
  window.artflowPluginState?.reportBoot?.({
    source: pluginStateStorage.source,
    enabled: [...profile.enabledPluginIds],
    disabled: profile.plugins.filter(plugin => !plugin.enabled).map(plugin => plugin.id),
    rejected: profile.rejected.map(entry => entry.id ?? entry.name ?? '(unknown)'),
    warning: startupWarning,
  });

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error("Could not find root element to mount to");
  }

  const root = ReactDOM.createRoot(rootElement);
  // 首帧就绪信号：宿主据此撤掉启动画面、显示主窗口。
  // 硬约束：信号必须由 React **真正 commit 之后**发出。
  // 旧实现在 root.render() 之后挂了一个 300ms 的 setTimeout 兜底，语义是"早发一点也比不发好"；
  // 但 React 首帧慢于 300ms 时（重 App + StrictMode 双渲染 + 画布初始化）它会抢跑，
  // 宿主拿到信号就把"还没画任何内容"的窗口显示出来 —— 表现正是白屏之后才出现画布界面。
  // 现在改由根组件里的 useEffect 触发（useEffect 必然在 commit 之后），rAF 双帧再确认这一帧合成过；
  // 兜底同样只在 commit 之后生效，不再存在任何早于 commit 的上报路径。
  const FirstPaintSignal: React.FC<{ onReady: () => void }> = ({ onReady }) => {
    React.useEffect(() => {
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        onReady();
      };
      const frame = requestAnimationFrame(() => requestAnimationFrame(send));
      // 隐藏窗口的 rAF 有被节流的历史（宿主已关掉节流，这里只是第二道保险）。
      const timer = window.setTimeout(send, 1200);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }, [onReady]);
    return null;
  };
  // 模块级常量，引用天然稳定：保证 FirstPaintSignal 的 effect 依赖不会每次渲染都换新引用。
  // 弹出面板窗口不参与启动时序（它由主窗口打开），上报会干扰宿主的换窗口判定。
  const notifyHostFirstPaint = () => {
    if (isPipPanelWindow) return;
    window.artflowApp?.notifyRendererReady?.();
  };
  const renderApp = () => {
    root.render(
      <React.StrictMode>
        {/* 首帧信号刻意留在边界外：App 渲染崩了也要照常上报，宿主才不会卡在启动画面。 */}
        <FirstPaintSignal onReady={notifyHostFirstPaint} />
        <RootErrorBoundary>
          {isPipPanelWindow ? <PipPanelApp kernel={kernel} /> : <App />}
        </RootErrorBoundary>
      </React.StrictMode>
    );
  };

  const loadSandboxedPlugins = async () => {
    try {
      // 沙箱代码插件（面板等）在首帧后装载；real-app 路径原先会先等沙箱再首帧，这里保持一致：先等（上限 4s）再渲染。
      await Promise.race([
        activateExternalPlugins(kernel, externalPanels),
        new Promise<void>(resolve => setTimeout(resolve, 4000)),
      ]);
    } catch (error) {
      console.warn('[external-plugins] boot skipped', error);
    }
    // 加固项②：沙箱宿主渲染进程崩溃后主进程会重建宿主窗口，此前的激活结果随之作废
    // （面板组件、命令、格式处理器全是旧窗口的死引用）。订阅换代通知并自动重新激活。
    // 订阅挂在启动链上、只订阅一次；返回的退订函数与进程同生命周期，无需保存。
    watchSandboxHostRestart(kernel, externalPanels);
  };

  if (isPipPanelWindow) {
    renderApp();
  } else if (window.artflowApp?.listSandboxedPlugins) {
    // real-app：先等沙箱代码插件（面板等）装载（上限 4s）再首帧，保持原行为。
    await loadSandboxedPlugins();
    renderApp();
  } else {
    // 纯 web dev：无沙箱，直接首帧（声明式插件已在上方 await 注册）。
    renderApp();
  }
})();
