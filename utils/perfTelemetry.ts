/**
 * perfTelemetry.ts —— 性能遥测采集（本体薄采集层，builtin/perf-monitor 消费）。
 *
 * 三层归因：
 * ① React Profiler 回调：`recordProfilerRender` 由 CanvasElement（按控件实例
 *    `el:<type>:<elementId>`）与 MainCanvas（整体）的 <Profiler onRender> 调用。
 *    actualDuration 仅在 dev / profiling 构建中有值，普通 production 恒为 0 ——
 *    本层对 0 值直接忽略。`getRenderRanking` 支持 'flat'（实例）/ 'type'（类型归并）双视图。
 * ② 交互延迟：`recordInteraction` 由插件侧 Event Timing observer（type 'event'）
 *    调用，DOM 归因（closest '[data-id]'）在插件层完成，本层只收控件标签。
 * ③ 长帧：PerformanceObserver 'long-animation-frame'（Chromium 123+，含脚本级归因），
 *    插件侧兜底回退 'longtask'（无脚本归因）。recordLongFrame 会把帧与最近 500ms
 *    内交互过的控件做启发式关联（recentControl）。
 *
 * 纯数据层：无 React / DOM 依赖，Node SSR 安全。
 */

export interface PerfScriptAttribution {
  /** 脚本源地址（dev 下是模块 URL，含文件名）。 */
  url: string;
  /** 函数名或 invoker。 */
  fn: string;
  /** 该脚本在帧内耗时 ms。 */
  ms: number;
}

export interface PerfLongFrameRecord {
  /** 帧起始时间戳（performance.timeOrigin + startTime）。 */
  ts: number;
  /** 帧总时长 ms（>50ms 才会被上报）。 */
  durationMs: number;
  /** 阻塞时长 ms（LoAF blockingDuration；longtask 用 duration 近似）。 */
  blockingMs: number;
  /** 脚本归因（按耗时降序，最多保留 3 条）。 */
  scripts: PerfScriptAttribution[];
  // —— 以下仅限 LoAF 有实际观测值的字段（longtask 兜底时缺省） ——
  /** LoAF.scripts 中可归因的 ScriptTiming.duration 之和；不包括 GC/未归因任务。 */
  scriptMs?: number;
  /** 当前 LoAF API 无法拆分 style/layout；仅保留字段兼容旧采集者。 */
  styleMs?: number;
  layoutMs?: number;
  /** 脚本级强制样式布局之和（不代表一帧全部布局）。 */
  forcedMs?: number;
  /** renderStart → 帧末的阶段时长，包含等待；并非纯 GPU/绘制耗时。 */
  renderMs?: number;
  /** 启发式关联：帧发生前后 500ms 内最近交互命中的控件标签（可能与卡顿无关）。 */
  recentControl?: string;
}

/** LoAF has no frame-level script/style/layout timings. Avoid calling an unmeasured 0ms GPU work. */
export function describeLongFrame(record: PerfLongFrameRecord): string {
  if (record.scripts.length > 0) return '';
  if (record.blockingMs < 15 && record.durationMs >= 50) {
    return `主线程阻塞较低（${fmtMs(record.blockingMs)}ms）；可能是合成、调度或采样空档，需 trace 才能判定`;
  }
  if (record.scriptMs !== undefined && record.scriptMs >= Math.max(10, record.blockingMs * 0.4)) {
    return `可归因脚本 ${fmtMs(record.scriptMs)}ms；其余耗时仍需 trace 验证`;
  }
  if (record.renderMs !== undefined) {
    return `渲染阶段 ${fmtMs(record.renderMs)}ms（含等待；无法仅凭 LoAF 区分绘制/GPU、GC 或未归因脚本）`;
  }
  return '无脚本归因（浏览器未提供足够的耗时构成，需 Performance trace）';
}

export interface PerfRenderAggregate {
  id: string;
  totalMs: number;
  count: number;
  maxMs: number;
  lastTs: number;
}

const MAX_LONG_FRAMES = 60;
const MAX_RENDER_AGG = 1000;
const MAX_INTERACTION_AGG = 500;
const MAX_RECENT_INTERACTIONS = 60;
/** 长帧与交互的启发式关联窗口（ms）。 */
const INTERACTION_LINK_WINDOW_MS = 500;

const renderAgg = new Map<string, PerfRenderAggregate>();
const interactionAgg = new Map<string, PerfRenderAggregate>();
const scriptAgg = new Map<string, { url: string; fn: string; totalMs: number; count: number }>();
const recentInteractions: Array<{ ts: number; label: string; durationMs: number; interactionId: number }> = [];
let longFrames: PerfLongFrameRecord[] = [];

/** Map 超上限时淘汰 lastTs 最旧的条目（诊断数据，允许有损）。 */
const evictOldest = <T extends { lastTs: number }>(map: Map<string, T>, max: number): void => {
  while (map.size > max) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, value] of map) {
      if (value.lastTs < oldestTs) {
        oldestTs = value.lastTs;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    map.delete(oldestKey);
  }
};

/**
 * 'el:<type>:<elementId>' → 'el:<type>'（类型视图归并 key）。
 * 非该格式的 id（如 MainCanvas、旧格式 'el:<type>'）原样返回。
 */
export function renderTypeKeyOf(id: string): string {
  if (!id.startsWith('el:')) return id;
  const rest = id.slice(3);
  const sep = rest.indexOf(':');
  return sep === -1 ? id : `el:${rest.slice(0, sep)}`;
}

const bumpAggregate = (map: Map<string, PerfRenderAggregate>, id: string, durationMs: number, max: number): void => {
  if (!(durationMs > 0)) return; // 普通构建无 profiling/无有效值，忽略
  const ts = Date.now();
  const agg = map.get(id);
  if (agg) {
    agg.totalMs += durationMs;
    agg.count += 1;
    agg.maxMs = Math.max(agg.maxMs, durationMs);
    agg.lastTs = ts;
  } else {
    map.set(id, { id, totalMs: durationMs, count: 1, maxMs: durationMs, lastTs: ts });
    evictOldest(map, max);
  }
};

/** Profiler onRender 入口（转发引用必须稳定，勿在渲染中新建箭头函数再传入）。id 为控件实例 key。 */
export function recordProfilerRender(id: string, _phase: 'mount' | 'update' | 'nested-update', actualDuration: number): void {
  bumpAggregate(renderAgg, id, actualDuration, MAX_RENDER_AGG);
}

/**
 * Event Timing 采集入口（由插件侧 observer 调用；DOM → 控件标签的解析在插件层完成）。
 * interactionId 为 0 表示浏览器未分配（仍按条目计入控件聚合）。
 */
export function recordInteraction(entry: { label: string; durationMs: number; interactionId: number; ts: number }): void {
  if (!(entry.durationMs > 0)) return;
  bumpAggregate(interactionAgg, entry.label, entry.durationMs, MAX_INTERACTION_AGG);
  recentInteractions.push({ ts: entry.ts, label: entry.label, durationMs: entry.durationMs, interactionId: entry.interactionId });
  if (recentInteractions.length > MAX_RECENT_INTERACTIONS) recentInteractions.splice(0, recentInteractions.length - MAX_RECENT_INTERACTIONS);
}

export function recordLongFrame(record: PerfLongFrameRecord): void {
  // 启发式关联：窗口内与帧时间差最小的交互（缓冲最多 60 条，线性扫描代价可忽略）。
  let linked: string | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const item of recentInteractions) {
    const diff = Math.abs(record.ts - item.ts);
    if (diff <= INTERACTION_LINK_WINDOW_MS && diff < bestDiff) {
      bestDiff = diff;
      linked = item.label;
    }
  }
  longFrames.push(linked ? { ...record, recentControl: linked } : record);
  if (longFrames.length > MAX_LONG_FRAMES) longFrames.splice(0, longFrames.length - MAX_LONG_FRAMES);
  for (const script of record.scripts) {
    const key = `${script.url}#${script.fn}`;
    const agg = scriptAgg.get(key);
    if (agg) {
      agg.totalMs += script.ms;
      agg.count += 1;
    } else {
      scriptAgg.set(key, { url: script.url, fn: script.fn, totalMs: script.ms, count: 1 });
    }
  }
}

/**
 * React 渲染耗时排行。
 * - 'flat'（默认）：按 Profiler id 原样（控件实例 `el:<type>:<elementId>` / MainCanvas）。
 * - 'type'：把实例条目归并回 `el:<type>`（适合回答"哪类控件最贵"）。
 */
export function getRenderRanking(mode: 'flat' | 'type' = 'flat'): readonly PerfRenderAggregate[] {
  if (mode !== 'type') return [...renderAgg.values()].sort((a, b) => b.totalMs - a.totalMs);
  const byType = new Map<string, PerfRenderAggregate>();
  for (const agg of renderAgg.values()) {
    const key = renderTypeKeyOf(agg.id);
    const merged = byType.get(key);
    if (merged) {
      merged.totalMs += agg.totalMs;
      merged.count += agg.count;
      merged.maxMs = Math.max(merged.maxMs, agg.maxMs);
      merged.lastTs = Math.max(merged.lastTs, agg.lastTs);
    } else {
      byType.set(key, { ...agg, id: key });
    }
  }
  return [...byType.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/** 控件交互延迟排行（Event Timing，>durationThreshold 的事件按控件聚合）。 */
export function getInteractionRanking(): readonly PerfRenderAggregate[] {
  return [...interactionAgg.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/** 最近交互流水（供长帧关联展示与调试）。 */
export function getRecentInteractions(): ReadonlyArray<{ ts: number; label: string; durationMs: number; interactionId: number }> {
  return recentInteractions;
}

export function getScriptRanking(): ReadonlyArray<{ url: string; fn: string; totalMs: number; count: number }> {
  return [...scriptAgg.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function getLongFrames(): readonly PerfLongFrameRecord[] {
  return longFrames;
}

/**
 * 模块归并：取 URL 路径中「已知顶层目录 + 下一级」为模块名
 * （如 components/cards/VideoCanvasCard.tsx → cards/VideoCanvasCard.tsx，
 *   builtin/media/index.tsx → media/index.tsx，hooks/useFileHandlers.ts → hooks/useFileHandlers.ts）。
 * 无法识别时退化为文件名。
 */
export function moduleOfUrl(url: string): string {
  if (!url) return '(匿名)';
  let path = url;
  try {
    if (url.startsWith('http') || url.startsWith('file:')) path = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  const KNOWN = ['components', 'hooks', 'utils', 'plugins', 'builtin', 'services', 'workers', 'main', 'src'];
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (KNOWN.includes(segments[i])) {
      return segments.slice(i, i + 2).join('/');
    }
  }
  return segments[segments.length - 1] || '(匿名)';
}

export interface PerfModuleShare {
  module: string;
  totalMs: number;
  share: number; // 0~1
}

/** 长帧脚本耗时按模块聚合占比（"不同模块的消耗占比"）。 */
export function getModuleShare(): readonly PerfModuleShare[] {
  const byModule = new Map<string, number>();
  let total = 0;
  for (const item of scriptAgg.values()) {
    const module = moduleOfUrl(item.url);
    byModule.set(module, (byModule.get(module) ?? 0) + item.totalMs);
    total += item.totalMs;
  }
  return [...byModule.entries()]
    .map(([module, ms]) => ({ module, totalMs: ms, share: total > 0 ? ms / total : 0 }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function clearPerfTelemetry(): void {
  renderAgg.clear();
  interactionAgg.clear();
  scriptAgg.clear();
  recentInteractions.length = 0;
  longFrames = [];
}

const fmtMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

const fmtClock = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);

export interface PerfOverviewSnapshot {
  fps?: number;
  minFps?: number;
  heapUsedMB?: number;
  heapLimitMB?: number;
  rendererMB?: number;
  gpuMB?: number;
  devReactTimings: boolean;
}

/** 复制给开发用的 Markdown 报告。 */
export function formatPerfLog(overview: PerfOverviewSnapshot): string {
  const lines: string[] = [];
  lines.push('# Artflow 性能日志');
  lines.push(`- 时间：${new Date().toLocaleString()}`);
  lines.push(`- React 实测计时：${overview.devReactTimings ? '可用（dev/带 profiling 构建）' : '不可用（production，仅长帧归因）'}`);
  const overviewParts: string[] = [];
  if (overview.fps !== undefined) overviewParts.push(`FPS ${overview.fps}（5s 最低 ${overview.minFps ?? '—'}）`);
  if (overview.heapUsedMB !== undefined) overviewParts.push(`JS 堆 ${overview.heapUsedMB.toFixed(1)}/${overview.heapLimitMB?.toFixed(0) ?? '?'} MB`);
  if (overview.rendererMB !== undefined) overviewParts.push(`渲染进程 ${overview.rendererMB.toFixed(1)} MB`);
  if (overview.gpuMB !== undefined) overviewParts.push(`GPU 进程 ${overview.gpuMB.toFixed(1)} MB`);
  if (overviewParts.length > 0) lines.push(`- 概览：${overviewParts.join(' | ')}`);

  const renders = getRenderRanking('type');
  if (renders.length > 0) {
    lines.push('');
    lines.push('## React 渲染耗时排行（按控件类型归并，Top 10）');
    lines.push('| 子树 | 累计 ms | 提交次数 | 单次峰值 ms |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of renders.slice(0, 10)) {
      lines.push(`| ${r.id} | ${fmtMs(r.totalMs)} | ${r.count} | ${fmtMs(r.maxMs)} |`);
    }
    const instances = getRenderRanking('flat').filter(r => r.id.startsWith('el:'));
    if (instances.length > 0) {
      lines.push('');
      lines.push('## 控件实例渲染耗时排行（Top 10，elementId 可在图层定位）');
      lines.push('| 控件实例 | 累计 ms | 提交次数 | 单次峰值 ms |');
      lines.push('| --- | --- | --- | --- |');
      for (const r of instances.slice(0, 10)) {
        lines.push(`| ${r.id} | ${fmtMs(r.totalMs)} | ${r.count} | ${fmtMs(r.maxMs)} |`);
      }
    }
  }

  const interactions = getInteractionRanking();
  if (interactions.length > 0) {
    lines.push('');
    lines.push('## 控件交互延迟排行（Event Timing，Top 10）');
    lines.push('| 控件 | 累计 ms | 事件次数 | 最差 ms |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of interactions.slice(0, 10)) {
      lines.push(`| ${r.id} | ${fmtMs(r.totalMs)} | ${r.count} | ${fmtMs(r.maxMs)} |`);
    }
  }

  const modules = getModuleShare();
  if (modules.length > 0) {
    lines.push('');
    lines.push('## 模块长帧脚本归因占比（每帧 Top 3，模块 Top 8）');
    lines.push('| 模块 | 累计 ms | 占比 |');
    lines.push('| --- | --- | --- |');
    for (const m of modules.slice(0, 8)) {
      lines.push(`| ${m.module} | ${fmtMs(m.totalMs)} | ${(m.share * 100).toFixed(1)}% |`);
    }
  }

  const scripts = getScriptRanking();
  if (scripts.length > 0) {
    lines.push('');
    lines.push('## 长帧脚本排行（Top 10）');
    lines.push('| 函数 | 累计 ms | 出现次数 | 来源 |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of scripts.slice(0, 10)) {
      lines.push(`| ${s.fn || '(匿名)'} | ${fmtMs(s.totalMs)} | ${s.count} | ${s.url || '(匿名)'} |`);
    }
  }

  const frames = getLongFrames();
  if (frames.length > 0) {
    // LoAF only exposes individual scripts and renderStart; it does not provide
    // frame-level script/style/layout durations. These totals can overlap and
    // must not be treated as percentages of a single blocking-time budget.
    let sumScript = 0, sumRender = 0, noAttr = 0, withScript = 0;
    for (const f of frames) {
      sumScript += f.scriptMs ?? 0;
      sumRender += f.renderMs ?? 0;
      if (f.scripts.length > 0) withScript += 1; else noAttr += 1;
    }
    lines.push('');
    lines.push(`## 长帧归因（最近 ${frames.length} 条）`);
    lines.push(`- 有脚本归因的帧：${withScript} | 无脚本归因的帧：${noAttr}`);
    lines.push(`- 已归因脚本合计 ${fmtMs(sumScript)}ms / renderStart→帧末阶段合计 ${fmtMs(sumRender)}ms（包含等待，不等于 GPU 耗时）`);
    lines.push('- 判读：LoAF 不提供完整的脚本、样式和布局总时长；两项可能重叠，不能据此断言“脚本 0ms”或“卡顿主因一定是 GPU”。需结合下方脚本归因与 Performance trace。');

    lines.push('');
    lines.push(`## 长帧记录（最近 ${frames.length} 条，>50ms）`);
    for (const f of frames.slice().reverse()) {
      const breakdown = f.scriptMs !== undefined || f.renderMs !== undefined
        ? `；已归因脚本 ${f.scriptMs === undefined ? '—' : fmtMs(f.scriptMs)} / 渲染阶段 ${f.renderMs === undefined ? '—' : fmtMs(f.renderMs)}${f.forcedMs === undefined ? '' : ` / 脚本内强制布局 ${fmtMs(f.forcedMs)}`}`
        : '';
      const top = f.scripts.length > 0
        ? f.scripts.map(s => `${s.fn || '(匿名)'} ${fmtMs(s.ms)}ms`).join(' | ')
        : describeLongFrame(f);
      const suspect = f.recentControl ? `；交互关联控件 ${f.recentControl}` : '';
      lines.push(`- [${fmtClock(f.ts)}] 帧长 ${fmtMs(f.durationMs)}ms（阻塞 ${fmtMs(f.blockingMs)}ms${breakdown}）— ${top}${suspect}`);
    }
  } else {
    lines.push('');
    lines.push('## 长帧记录');
    lines.push('- 采集期间未捕获到 >50ms 长帧');
  }

  return lines.join('\n');
}
