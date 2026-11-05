/**
 * builtin/perf-monitor/index.tsx —— 性能监测 HUD 插件。
 *
 * 悬浮卡片：标题栏可拖拽（pointer capture），位置 localStorage 记忆。
 * 四个 Tab：
 * - 概览：FPS（含 5s 最低值）/ JS 堆 / 渲染与 GPU 进程内存、CPU。
 * - 排行：React 渲染耗时（Profiler 控件实例 + 类型归并双视图）、控件交互延迟
 *   （Event Timing → data-id 归因）、模块消耗占比条、长帧脚本排行。
 * - 日志：长帧事件流水（含交互关联控件）+ 一键复制 Markdown 报告。
 * - 排查：控件隐藏排除法——逐个/分组隐藏画布控件采样 FPS 回升，定位
 *   JS Profiler 测不到的 CSS/合成/GPU 类卡顿源。
 *
 * 数据链路：React Profiler（CanvasElement 实例级 / MainCanvas）与 PerformanceObserver
 * （long-animation-frame、event）→ utils/perfTelemetry.ts 单例聚合 → 本组件读取。
 *
 * 开销控制：折叠态仅 1Hz FPS 更新、零 IPC、零 observer 工作外的开销；
 * 展开态概览 1~0.5Hz；排行/日志 Tab 1Hz 读取聚合快照（纯 Map 读取）。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Kernel, Effect } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { WorkspaceWidgetProps } from '../../plugin-runtime/widget-contributions';
import {
  clearPerfTelemetry,
  describeLongFrame,
  formatPerfLog,
  getInteractionRanking,
  getLongFrames,
  getModuleShare,
  getRenderRanking,
  getScriptRanking,
  recordInteraction,
  recordLongFrame,
} from '../../utils/perfTelemetry';
import { createPreferenceStorage } from '../../plugin-runtime/preference-storage';
import { formatKB, summarizeProcessMetrics } from '../../utils/perf-process-metrics';
import type { ProcessSummary } from '../../utils/perf-process-metrics';
import manifest from './manifest.json';

const VISIBLE_KEY = 'artflow.perfHud.visible';
const EXPANDED_KEY = 'artflow.perfHud.expanded';
const POS_KEY = 'artflow.perfHud.pos';
const TOGGLE_TOPIC = 'perf-hud:toggle';

/**
 * HUD 状态（可见/展开/位置）的存储。
 * 原来直接落 localStorage（按 origin 隔离）→ 改用主进程 config/preferences.json：
 * 键 `perf.hud.visible` / `perf.hud.expanded` / `perf.hud.pos`，旧键由适配器一次性采纳。
 * 适配器的接口就是 `Pick<Storage, ...>`，所以下面读写函数一行都不用改。
 */
const hudStorage = createPreferenceStorage({
  namespace: 'perf.hud',
  toPreferenceKey: storageKey => `perf.hud.${storageKey.replace(/^artflow\.perfHud\./, '')}`,
});

type HudTab = 'overview' | 'rank' | 'log' | 'hunt';

const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const raw = hudStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
};

const writeFlag = (key: string, value: boolean): void => {
  try {
    hudStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* persistence is best-effort */
  }
};

const readPos = (): { x: number; y: number } | null => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = hudStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x: number; y: number };
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    // 视口可能缩小过：读出时钳回可见范围；顶部钳进安全区（系统拖拽带会吞事件）。
    const maxX = Math.max(0, window.innerWidth - 80);
    const maxY = Math.max(topSafeZone(), window.innerHeight - 40);
    return { x: Math.min(Math.max(parsed.x, 0), maxX), y: Math.min(Math.max(parsed.y, topSafeZone()), maxY) };
  } catch {
    return null;
  }
};

const writePos = (pos: { x: number; y: number } | null): void => {
  try {
    if (pos === null) hudStorage.removeItem(POS_KEY);
    else hudStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* persistence is best-effort */
  }
};

const TONE_COLOR: Record<'ok' | 'warn' | 'bad', string> = {
  ok: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
};

const fpsTone = (value: number): 'ok' | 'warn' | 'bad' => (value >= 50 ? 'ok' : value >= 30 ? 'warn' : 'bad');

const fmtMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

const fileNameOf = (url: string): string => {
  if (!url) return '(匿名)';
  const clean = url.split('?')[0];
  const parts = clean.split('/');
  return parts[parts.length - 1] || '(匿名)';
};

const fmtClock = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);

/**
 * Windows 无边框窗口（[data-bp-frameless]）顶部有 32px 系统拖拽带
 * （index.css .bp-window-chrome，-webkit-app-region: drag），落在其中的元素
 * 收不到任何指针事件——点不到也拖不动。浮层默认位置与拖拽钳制必须避开；
 * 40px 与 [data-bp-frameless] 顶栏的让位保持一致。browser/dev 模式无此约束。
 */
const topSafeZone = (): number => {
  try {
    if (typeof document === 'undefined') return 0;
    return document.documentElement.hasAttribute('data-bp-frameless') ? 40 : 0;
  } catch {
    return 0;
  }
};

/**
 * Event Timing 目标 → 控件标签：优先画布 <g data-id>（CanvasElement 容器），
 * 其次 data-element-id（SVG 原生节点）；面板/页面其余位置归 '(页面/面板)'。
 */
const controlLabelOf = (target: EventTarget | null | undefined): string => {
  const el = target instanceof Element ? target : null;
  if (!el) return '(页面/面板)';
  const owner = el.closest('[data-id]') ?? el.closest('[data-element-id]');
  const id = owner?.getAttribute('data-id') ?? owner?.getAttribute('data-element-id');
  return id || '(页面/面板)';
};

const hudButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a3a3a3',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: '0 3px',
};

const PerfHudWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const [visible, setVisible] = useState(() => readFlag(VISIBLE_KEY, true));
  const [expanded, setExpanded] = useState(() => readFlag(EXPANDED_KEY, false));
  const [tab, setTab] = useState<HudTab>('overview');
  const [renderView, setRenderView] = useState<'type' | 'instance'>('type');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => readPos());
  const [fps, setFps] = useState(0);
  const [minFps, setMinFps] = useState(0);
  const [heap, setHeap] = useState<{ usedMB: number; limitMB: number } | null>(null);
  const [proc, setProc] = useState<ProcessSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  // 拖拽死区标记：位移 ≥4px 才算拖动；折叠胶囊靠它区分"拖动"与"点击展开"。
  const movedRef = useRef(false);

  // 命令面板开关经 kernel 事件总线到达；可见性持久化。
  useEffect(() => kernel.on(TOGGLE_TOPIC, () => {
    setVisible(prev => {
      const next = !prev;
      writeFlag(VISIBLE_KEY, next);
      return next;
    });
  }), [kernel]);

  // FPS：rAF 计帧；1Hz 更新 state，滚动 5s 窗口取最低值。
  useEffect(() => {
    if (!visible || typeof requestAnimationFrame !== 'function') return;
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const samples: number[] = [];
    const tick = (now: number) => {
      frames += 1;
      const elapsed = now - last;
      if (elapsed >= 1000) {
        const value = Math.round((frames * 1000) / elapsed);
        frames = 0;
        last = now;
        samples.push(value);
        if (samples.length > 5) samples.shift();
        setFps(value);
        setMinFps(Math.min(...samples));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  // JS 堆：1Hz（performance.memory 本身就是量化/限频的，再快无意义）。
  useEffect(() => {
    if (!visible) return;
    const sample = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      if (mem && Number.isFinite(mem.usedJSHeapSize)) {
        setHeap({ usedMB: mem.usedJSHeapSize / 1048576, limitMB: mem.jsHeapSizeLimit / 1048576 });
      } else {
        setHeap(null);
      }
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [visible]);

  // 进程指标：仅展开时 0.5Hz 轮询 IPC，折叠态零 IPC 开销。
  useEffect(() => {
    if (!visible || !expanded) return;
    let stopped = false;
    const poll = async () => {
      try {
        const api = window.artflowApp;
        if (!api?.getPerfMetrics) {
          setProc(null);
          return;
        }
        const metrics = await api.getPerfMetrics();
        if (stopped) return;
        // 类型归一化（Electron 'Tab' / Tauri 'Renderer'、'GPU' / 'GPU Process'）全在纯函数里，
        // HUD 只负责渲染。空快照返回 null → 各行显示 '—'。
        setProc(summarizeProcessMetrics(metrics));
      } catch {
        setProc(null);
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, expanded]);

  // 长帧采集：long-animation-frame（脚本级归因）优先，兜底 longtask。
  useEffect(() => {
    if (!visible) return;
    const PO = window.PerformanceObserver;
    if (typeof PO !== 'function') return;
    const supported: readonly string[] = PO.supportedEntryTypes ?? [];
    const type = supported.includes('long-animation-frame') ? 'long-animation-frame' : 'longtask';
    let observer: PerformanceObserver | null = null;
    const isLoaf = type === 'long-animation-frame';
    try {
      observer = new PO(list => {
        for (const entry of list.getEntries()) {
          const loaf = entry as PerformanceEntry & {
            blockingDuration?: number; scripts?: Array<Record<string, unknown>>; renderStart?: number;
          };
          // The LoAF frame does NOT expose scriptDuration/styleDuration/layoutDuration.
          // ScriptTiming.duration and forcedStyleAndLayoutDuration live on each script.
          // The old reads silently defaulted all three frame fields to 0ms and
          // mislabelled substantial scripting as pure GPU/raster work.
          const attributed = Array.isArray(loaf.scripts) ? loaf.scripts : [];
          const scriptMs = attributed.reduce((sum, s) => sum + Math.max(0, Number(s.duration) || 0), 0);
          const forcedMs = attributed.reduce((sum, s) => sum + Math.max(0, Number(s.forcedStyleAndLayoutDuration) || 0), 0);
          const scripts = attributed
            .slice()
            .sort((a, b) => Number(b.duration) - Number(a.duration))
            .slice(0, 3)
            .map(s => ({
              url: String(s.sourceURL ?? ''),
              fn: String(s.sourceFunctionName ?? s.invoker ?? ''),
              ms: Number(s.duration) || 0,
            }));
          const renderStart = Number(loaf.renderStart ?? 0);
          recordLongFrame({
            ts: performance.timeOrigin + entry.startTime,
            durationMs: entry.duration,
            blockingMs: loaf.blockingDuration ?? entry.duration,
            scripts,
            ...(isLoaf ? {
              ...(attributed.length ? { scriptMs } : {}),
              ...(forcedMs > 0 ? { forcedMs } : {}),
              ...(renderStart > 0 ? { renderMs: Math.max(0, entry.startTime + entry.duration - renderStart) } : {}),
            } : {}),
          });
        }
      });
      observer.observe({ type });
    } catch {
      return;
    }
    return () => {
      try {
        observer?.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [visible]);

  // 交互延迟采集：Event Timing API（Chromium），>50ms 的事件按控件归因。
  // 不用 buffered：回放条目拿不到 target，无法做控件归因；从打开 HUD 起采即可。
  useEffect(() => {
    if (!visible) return;
    const PO = window.PerformanceObserver;
    if (typeof PO !== 'function') return;
    const supported: readonly string[] = PO.supportedEntryTypes ?? [];
    if (!supported.includes('event')) return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PO(list => {
        for (const entry of list.getEntries()) {
          const ev = entry as PerformanceEntry & { interactionId?: number; target?: EventTarget | null };
          recordInteraction({
            label: controlLabelOf(ev.target),
            durationMs: entry.duration,
            interactionId: Number(ev.interactionId ?? 0),
            ts: performance.timeOrigin + entry.startTime,
          });
        }
      });
      observer.observe({ type: 'event', durationThreshold: 50 } as PerformanceObserverInit);
    } catch {
      return;
    }
    return () => {
      try {
        observer?.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [visible]);

  // 排行/日志 Tab：1Hz 重读聚合快照（纯 Map 读取，无 observer 参与）。
  useEffect(() => {
    if (!visible || !expanded || tab === 'overview') return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [visible, expanded, tab]);

  // —— 拖拽：标题栏 pointer capture，位置记忆 ——
  // 注意：按钮（Tab/折叠/关闭）不参与拖拽——若从按钮上 setPointerCapture，
  // 派生的 click 会重定向到标题栏，按钮永远收不到 onClick（实测踩坑）。
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest('button')) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top };
  };
  const onHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!movedRef.current && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    movedRef.current = true;
    const width = boxRef.current?.offsetWidth ?? 240;
    const height = boxRef.current?.offsetHeight ?? 60;
    const minY = topSafeZone();
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(minY, window.innerHeight - height);
    const x = Math.min(Math.max(0, drag.originX + (event.clientX - drag.startX)), maxX);
    const y = Math.min(Math.max(minY, drag.originY + (event.clientY - drag.startY)), maxY);
    setPos({ x, y });
  };
  const onHeaderPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPos(current => {
      writePos(current);
      return current;
    });
  };

  // 窗口缩放/启动/展开后把 HUD 钳回视口内（否则固定像素位置可能整卡在视口外"消失"）。
  useEffect(() => {
    if (!visible || typeof window === 'undefined') return;
    const clampToViewport = () => {
      const width = boxRef.current?.offsetWidth ?? 320;
      const height = boxRef.current?.offsetHeight ?? 80;
      const minY = topSafeZone();
      const maxX = Math.max(0, window.innerWidth - width);
      const maxY = Math.max(minY, window.innerHeight - height);
      setPos(current => {
        if (!current) return current;
        const x = Math.min(current.x, maxX);
        const y = Math.min(Math.max(current.y, minY), maxY);
        if (x === current.x && y === current.y) return current;
        writePos({ x, y });
        return { x, y };
      });
    };
    clampToViewport();
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [visible, expanded]);

  // —— 排查 Tab：控件隐藏排除法 ——
  // 对 JS Profiler 测不到的 CSS/合成/GPU 类卡顿做控件级定位：
  // 注入 g[data-perf-hunt="1"]{display:none!important}，分组/逐个隐藏控件并采样 FPS，
  // 隐藏后回升最多的即卡顿源候选。data-perf-hunt 非 React 管理属性，重渲染不会清除；
  // 停止/完成/卸载时统一移除属性与样式，画布恢复原状。

  interface HuntResult { label: string; baselineFps: number; sampleFps: number; gain: number; }
  interface HuntState {
    stage: 'idle' | 'running' | 'done';
    phaseLabel: string;
    index: number;
    total: number;
    baselineFps: number;
    results: HuntResult[];
  }
  const IDLE_HUNT: HuntState = { stage: 'idle', phaseLabel: '', index: 0, total: 0, baselineFps: 0, results: [] };
  const [hunt, setHunt] = useState<HuntState>(IDLE_HUNT);
  const huntAbortRef = useRef(false);

  // 卸载兜底：确保画布控件与隐藏样式一定被还原。
  useEffect(() => () => {
    document.getElementById('perf-hunt-style')?.remove();
    document.querySelectorAll('[data-perf-hunt]').forEach(el => el.removeAttribute('data-perf-hunt'));
  }, []);

  /** 采样 ms 毫秒的平均 FPS；主线程完全卡死（rAF 停摆）时 3s 超时兜底返回。 */
  const sampleFpsFor = (ms: number): Promise<number> => new Promise(resolve => {
    let frames = 0;
    let done = false;
    const start = performance.now();
    const finish = () => {
      if (done) return;
      done = true;
      resolve((frames * 1000) / Math.max(1, performance.now() - start));
    };
    const tick = (now: number) => {
      frames += 1;
      if (now - start >= ms) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(finish, ms + 3000);
  });

  const startHunt = async (): Promise<void> => {
    if (hunt.stage === 'running') return;
    huntAbortRef.current = false;
    const nodes = Array.from(document.querySelectorAll<SVGGElement>('svg g[data-id]'));
    if (nodes.length === 0) {
      setHunt({ ...IDLE_HUNT, stage: 'done', phaseLabel: '画布上没有可隐藏的控件（svg g[data-id]）' });
      return;
    }
    let styleEl = document.getElementById('perf-hunt-style') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'perf-hunt-style';
      styleEl.textContent = 'g[data-perf-hunt="1"] { display: none !important; }';
      document.head.appendChild(styleEl);
    }
    const restoreAll = (): void => {
      for (const node of nodes) node.removeAttribute('data-perf-hunt');
    };
    const typeOf = (label: string): string => {
      if (label.startsWith('el:')) {
        const rest = label.slice(3);
        const sep = rest.indexOf(':');
        return sep === -1 ? rest : rest.slice(0, sep);
      }
      return '(其他)';
    };
    const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
    try {
      setHunt({ stage: 'running', phaseLabel: '基线采样（不隐藏任何控件）', index: 0, total: 0, baselineFps: 0, results: [] });
      const baselineFps = await sampleFpsFor(700);
      if (huntAbortRef.current) return;
      // 阶段一：按控件类型分组隐藏，先圈定嫌疑类型。
      const groups = new Map<string, SVGGElement[]>();
      for (const node of nodes) {
        const key = typeOf(node.getAttribute('data-id') ?? '');
        const list = groups.get(key) ?? [];
        list.push(node);
        groups.set(key, list);
      }
      const groupKeys = [...groups.keys()];
      const groupResults: HuntResult[] = [];
      for (let i = 0; i < groupKeys.length; i += 1) {
        if (huntAbortRef.current) return;
        const key = groupKeys[i];
        const members = groups.get(key)!;
        setHunt(h => ({ ...h, stage: 'running', phaseLabel: `分组隐藏：${key}`, index: i + 1, total: groupKeys.length, baselineFps }));
        for (const node of members) node.setAttribute('data-perf-hunt', '1');
        await wait(80);
        const sampleFps = await sampleFpsFor(700);
        restoreAll();
        groupResults.push({ label: `类型:${key}`, baselineFps, sampleFps, gain: sampleFps - baselineFps });
        await wait(120);
      }
      if (huntAbortRef.current) return;
      // 阶段二：对回升最明显的类型（≥2 FPS，低于视为噪音）逐个实例定位，上限 50 个。
      const bestGroup = [...groupResults].sort((a, b) => b.gain - a.gain)[0];
      const instanceResults: HuntResult[] = [];
      if (bestGroup && bestGroup.gain >= 2 && bestGroup.label.startsWith('类型:')) {
        const bestType = bestGroup.label.slice(3);
        const capped = (groups.get(bestType) ?? []).slice(0, 50);
        for (let i = 0; i < capped.length; i += 1) {
          if (huntAbortRef.current) return;
          const node = capped[i];
          const label = node.getAttribute('data-id') ?? `(${bestType} #${i + 1})`;
          setHunt(h => ({ ...h, stage: 'running', phaseLabel: `逐个隐藏：${label}`, index: i + 1, total: capped.length, baselineFps }));
          node.setAttribute('data-perf-hunt', '1');
          await wait(80);
          const sampleFps = await sampleFpsFor(700);
          node.removeAttribute('data-perf-hunt');
          instanceResults.push({ label, baselineFps, sampleFps, gain: sampleFps - baselineFps });
          await wait(120);
        }
      }
      if (huntAbortRef.current) return;
      const results = [...instanceResults, ...groupResults].sort((a, b) => b.gain - a.gain);
      setHunt(h => ({
        ...h,
        stage: 'done',
        phaseLabel: results.length > 0 ? '完成：隐藏后 FPS 回升最多的即卡顿源候选（增益低于噪音水平可忽略）' : '完成',
        index: 0,
        total: 0,
        results,
      }));
    } finally {
      restoreAll();
    }
  };

  const stopHunt = (): void => {
    huntAbortRef.current = true;
    document.getElementById('perf-hunt-style')?.remove();
    document.querySelectorAll('[data-perf-hunt]').forEach(el => el.removeAttribute('data-perf-hunt'));
    setHunt(h => ({ ...h, stage: 'idle', phaseLabel: '已停止并恢复所有控件' }));
  };

  if (!visible) return null;

  const tone = fpsTone(fps);

  const boxStyle: React.CSSProperties = {
    position: 'fixed',
    top: pos ? pos.y : 12 + topSafeZone(),
    left: pos ? pos.x : 'auto',
    right: pos ? 'auto' : 12,
    zIndex: 60,
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    background: 'rgba(17, 17, 17, 0.88)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    color: '#e5e5e5',
    font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    userSelect: 'none',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
    backdropFilter: 'blur(4px)',
    // 双保险：浮层压在系统拖拽带（app-region: drag）之上时，声明 no-drag 才能保住指针事件。
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;

  // —— 折叠胶囊 ——
  // 可拖动（与展开态共用拖拽三件套）；位移 <4px 视为点击展开。
  if (!expanded) {
    return (
      <div
        ref={boxRef}
        data-perf-hud="collapsed"
        style={{ ...boxStyle, padding: '4px 10px', cursor: 'grab', touchAction: 'none' }}
        title="性能监测（拖动移动位置 / 点击展开）"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onClick={() => {
          if (movedRef.current) return; // 拖动结束的衍生 click 不展开
          setExpanded(true);
          writeFlag(EXPANDED_KEY, true);
        }}
      >
        <span style={{ color: TONE_COLOR[tone], fontWeight: 700 }}>{fps || '—'}</span> FPS
      </div>
    );
  }

  const tabButton = (key: HudTab, label: string): React.ReactNode => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        background: tab === key ? 'rgba(255,255,255,0.12)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: tab === key ? '#fff' : '#a3a3a3',
        cursor: 'pointer',
        font: 'inherit',
        padding: '2px 8px',
      }}
    >{label}</button>
  );

  const header = (
    <div
      onPointerDown={onHeaderPointerDown}
      onPointerMove={onHeaderPointerMove}
      onPointerUp={onHeaderPointerUp}
      style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: 'grab', touchAction: 'none' }}
      title="拖动移动位置"
    >
      <span style={{ fontWeight: 700, color: '#a3a3a3' }}>性能监测</span>
      {tabButton('overview', '概览')}
      {tabButton('rank', '排行')}
      {tabButton('log', '日志')}
      {tabButton('hunt', '排查')}
      <span style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          title="折叠"
          onClick={event => { event.stopPropagation(); setExpanded(false); writeFlag(EXPANDED_KEY, false); }}
          onPointerDown={event => event.stopPropagation()}
          style={hudButtonStyle}
        >–</button>
        <button
          type="button"
          title="关闭（Alt+P 重新打开）"
          onClick={event => { event.stopPropagation(); setVisible(false); writeFlag(VISIBLE_KEY, false); }}
          onPointerDown={event => event.stopPropagation()}
          style={hudButtonStyle}
        >×</button>
      </span>
    </div>
  );

  // —— 概览 Tab ——
  const overviewRows: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }> = [
    { label: 'FPS 当前 / 5s最低', value: `${fps || '—'} / ${minFps || '—'}`, tone },
    heap
      ? { label: 'JS 堆', value: `${heap.usedMB.toFixed(1)} / ${heap.limitMB.toFixed(0)} MB`, tone: heap.usedMB > heap.limitMB * 0.85 ? 'warn' : undefined }
      : { label: 'JS 堆', value: '—' },
    proc
      ? { label: '渲染进程内存', value: formatKB(proc.rendererKB) }
      : { label: '渲染进程内存', value: '—' },
    proc
      ? { label: '渲染进程 CPU', value: `${proc.cpuPercent.toFixed(1)}%` }
      : { label: '渲染进程 CPU', value: '—' },
    proc
      ? { label: 'GPU 进程内存', value: formatKB(proc.gpuKB) }
      : { label: 'GPU 进程内存', value: '—' },
    proc && proc.vramKB > 0
      ? { label: '显存（专用）', value: formatKB(proc.vramKB) }
      : { label: '显存（专用）', value: '—（Electron 不提供）' },
    proc && proc.gpuPeakKB > 0
      ? { label: 'GPU 进程峰值', value: formatKB(proc.gpuPeakKB) }
      : { label: 'GPU 进程峰值', value: '—' },
  ];

  const overviewBody = (
    <div>
      {overviewRows.map(row => (
        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#a3a3a3' }}>{row.label}</span>
          <span style={{ color: row.tone ? TONE_COLOR[row.tone] : '#e5e5e5', fontWeight: row.tone ? 700 : 400 }}>{row.value}</span>
        </div>
      ))}
    </div>
  );

  // —— 排行 Tab ——
  const renderShareBar = (share: number, color: string): React.ReactNode => (
    <span style={{ display: 'inline-block', width: 70, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${Math.round(share * 100)}%`, height: '100%', background: color }} />
    </span>
  );

  const renders = getRenderRanking(renderView);
  const renderTop = renders[0]?.totalMs ?? 0;
  const modules = getModuleShare();
  const scripts = getScriptRanking();
  const scriptTop = scripts[0]?.totalMs ?? 0;
  const interactions = getInteractionRanking();
  const interactionTop = interactions[0]?.maxMs ?? 0;

  const viewSwitch = (key: 'type' | 'instance', label: string): React.ReactNode => (
    <button
      type="button"
      onClick={() => setRenderView(key)}
      style={{
        background: renderView === key ? 'rgba(168,85,247,0.35)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: renderView === key ? '#fff' : '#a3a3a3',
        cursor: 'pointer',
        font: 'inherit',
        padding: '1px 7px',
      }}
    >{label}</button>
  );

  const rankBody = (
    <div style={{ display: 'grid', gap: 8 }}>
      <div>
        <div style={{ color: '#a3a3a3', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>React 渲染耗时</span>
          {viewSwitch('type', '按类型')}
          {viewSwitch('instance', '按控件实例')}
        </div>
        {renders.length === 0 && (
          <div style={{ color: '#737373' }}>暂无样本：dev 或 profiling 构建下操作画布后出现</div>
        )}
        {renders.slice(0, 6).map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderShareBar(renderTop > 0 ? r.totalMs / renderTop : 0, '#a855f7')}
            <span style={{ minWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.id}>{r.id}</span>
            <span style={{ color: '#a3a3a3' }}>{fmtMs(r.totalMs)}ms / {r.count} 次（峰值 {fmtMs(r.maxMs)}）</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ color: '#a3a3a3', marginBottom: 2 }}>控件交互延迟（Event Timing，按控件归因）</div>
        {interactions.length === 0 && <div style={{ color: '#737373' }}>暂无样本：打开 HUD 后与画布交互，超 50ms 的事件会计入</div>}
        {interactions.slice(0, 6).map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderShareBar(interactionTop > 0 ? r.maxMs / interactionTop : 0, '#fbbf24')}
            <span style={{ minWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.id}>{r.id}</span>
            <span style={{ color: '#a3a3a3' }}>最差 {fmtMs(r.maxMs)}ms / {r.count} 次（均 {fmtMs(r.totalMs / r.count)}）</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ color: '#a3a3a3', marginBottom: 2 }}>模块长帧耗时占比（卡顿归因）</div>
        {modules.length === 0 && <div style={{ color: '#737373' }}>暂无长帧样本：出现超过 50ms 的卡顿后出现</div>}
        {modules.slice(0, 6).map(m => (
          <div key={m.module} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderShareBar(m.share, '#38bdf8')}
            <span style={{ minWidth: 92 }}>{m.module}</span>
            <span style={{ color: '#a3a3a3' }}>{fmtMs(m.totalMs)}ms（{(m.share * 100).toFixed(1)}%）</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ color: '#a3a3a3', marginBottom: 2 }}>长帧脚本排行（文件 / 函数）</div>
        {scripts.length === 0 && <div style={{ color: '#737373' }}>暂无数据</div>}
        {scripts.slice(0, 8).map(s => (
          <div key={`${s.url}#${s.fn}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderShareBar(scriptTop > 0 ? s.totalMs / scriptTop : 0, '#fb7185')}
            <span style={{ minWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.url}>{s.fn || fileNameOf(s.url)}</span>
            <span style={{ color: '#a3a3a3' }}>{fmtMs(s.totalMs)}ms / {s.count} 次</span>
          </div>
        ))}
      </div>
      <div>
        <button
          type="button"
          onClick={() => { clearPerfTelemetry(); setTick(t => t + 1); }}
          style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 6, color: '#e5e5e5', cursor: 'pointer', font: 'inherit', padding: '3px 10px' }}
        >清空统计数据</button>
      </div>
    </div>
  );

  // —— 日志 Tab ——
  const frames = getLongFrames().slice().reverse();
  const copyLog = async () => {
    const text = formatPerfLog({
      fps: fps || undefined,
      minFps: minFps || undefined,
      heapUsedMB: heap?.usedMB,
      heapLimitMB: heap?.limitMB,
      rendererMB: proc && proc.rendererKB > 0 ? proc.rendererKB / 1024 : undefined,
      gpuMB: proc && proc.gpuKB > 0 ? proc.gpuKB / 1024 : undefined,
      devReactTimings: renders.length > 0,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const logBody = (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={copyLog}
          style={{ background: 'rgba(168,85,247,0.25)', border: 'none', borderRadius: 6, color: '#e5e5e5', cursor: 'pointer', font: 'inherit', padding: '3px 10px' }}
        >{copied ? '已复制 ✓' : '复制性能日志（Markdown）'}</button>
        <span style={{ color: '#737373' }}>共 {frames.length} 条长帧</span>
      </div>
      {frames.length === 0 && <div style={{ color: '#737373' }}>采集期间未捕获到超过 50ms 的长帧</div>}
      {frames.slice(0, 10).map((f, index) => (
        <div key={`${f.ts}-${index}`} style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 3 }}>
          <div>
            <span style={{ color: TONE_COLOR[f.blockingMs > 100 ? 'bad' : 'warn'] }}>[{fmtClock(f.ts)}] 阻塞 {fmtMs(f.blockingMs)}ms</span>
            {f.scriptMs !== undefined && (
              <span style={{ color: '#737373' }}> · 脚本 {fmtMs(f.scriptMs)} / 样式 {fmtMs(f.styleMs ?? 0)} / 布局 {fmtMs(f.layoutMs ?? 0)} / 渲染 {fmtMs(f.renderMs ?? 0)}</span>
            )}
          </div>
          <div style={{ color: '#a3a3a3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.scripts.length > 0
              ? f.scripts.map(s => `${s.fn || fileNameOf(s.url)} (${fmtMs(s.ms)}ms @ ${fileNameOf(s.url)})`).join(' | ')
              : describeLongFrame(f)}
          </div>
          {f.recentControl && (
            <div style={{ color: '#fbbf24', opacity: 0.85 }}>↳ 疑似相关控件：{f.recentControl}（前后 500ms 内有交互，仅供线索）</div>
          )}
        </div>
      ))}
    </div>
  );

  // —— 排查 Tab（控件隐藏排除法）——
  const huntMaxGain = Math.max(0, ...hunt.results.map(r => r.gain));
  const huntBody = (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ color: '#737373', lineHeight: 1.5 }}>
        定位 JS 排行测不到的 CSS / 合成 / GPU 类卡顿：自动逐组、逐个隐藏画布控件并采样
        FPS，隐藏后回升最多的即卡顿源。全程数秒～数十秒，测试期间请勿操作画布；
        请在卡顿复现时使用（FPS 已满 60 时测不出差异）。
      </div>
      {hunt.stage !== 'running' && (
        <div>
          <button
            type="button"
            onClick={startHunt}
            style={{ background: 'rgba(74,222,128,0.2)', border: 'none', borderRadius: 6, color: '#e5e5e5', cursor: 'pointer', font: 'inherit', padding: '3px 10px' }}
          >开始隐藏排查</button>
          {hunt.phaseLabel && <span style={{ color: '#737373', marginLeft: 8 }}>{hunt.phaseLabel}</span>}
        </div>
      )}
      {hunt.stage === 'running' && (
        <>
          <div>
            <button
              type="button"
              onClick={stopHunt}
              style={{ background: 'rgba(248,113,113,0.25)', border: 'none', borderRadius: 6, color: '#e5e5e5', cursor: 'pointer', font: 'inherit', padding: '3px 10px' }}
            >停止并恢复</button>
          </div>
          <div style={{ color: '#a3a3a3' }}>
            {hunt.phaseLabel}{hunt.total > 0 ? `（${hunt.index}/${hunt.total}）` : ''}
          </div>
        </>
      )}
      {hunt.stage !== 'idle' && hunt.baselineFps > 0 && (
        <div style={{ color: '#a3a3a3' }}>基线 FPS：{hunt.baselineFps.toFixed(1)}</div>
      )}
      {hunt.stage === 'done' && hunt.results.slice(0, 8).map(r => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {renderShareBar(huntMaxGain > 0 ? Math.max(0, r.gain) / huntMaxGain : 0, '#4ade80')}
          <span style={{ minWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</span>
          <span style={{ color: r.gain >= 2 ? TONE_COLOR.bad : '#a3a3a3' }}>
            隐藏后 {r.sampleFps.toFixed(1)}（{r.gain >= 0 ? '+' : ''}{r.gain.toFixed(1)} FPS）
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div ref={boxRef} data-perf-hud="expanded" data-perf-tab={tab} style={{ ...boxStyle, padding: '8px 10px', minWidth: 300, maxWidth: 380 }}>
      {header}
      {tab === 'overview' && overviewBody}
      {tab === 'rank' && rankBody}
      {tab === 'log' && logBody}
      {tab === 'hunt' && huntBody}
    </div>
  );
};

export const perfMonitorPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposeWidget = ctx.contributions.register('canvas_widgets', {
      id: 'builtin.perf-monitor.hud',
      pluginId: 'builtin.perf-monitor',
      priority: 90,
      value: {
        title: '性能监测 HUD',
        bridgeKey: 'diagnostics' as const,
        placement: 'workspace' as const,
        component: PerfHudWidget,
      },
    });
    const disposeCommand = ctx.contributions.register('commands', {
      id: 'builtin.perf-monitor.toggle-hud',
      pluginId: 'builtin.perf-monitor',
      value: {
        title: '切换性能监测 HUD',
        description: '显示/隐藏性能监测悬浮卡片（FPS、内存、显存、控件级渲染/交互排行与卡顿排查）',
        group: '视图',
        keywords: ['性能', 'fps', '内存', '显存', '帧率', '监测', '控件', '卡顿', '排查', 'perf', 'monitor', 'hud'],
        // 关闭 HUD 后唯一的常驻重开入口：全局 Alt+P（命令面板也可搜"性能"）。
        shortcut: { key: 'p', alt: true },
        run: k => k.emit(TOGGLE_TOPIC),
      },
    });
    return () => {
      disposeCommand();
      disposeWidget();
    };
  },
});
