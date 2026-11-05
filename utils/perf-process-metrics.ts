/**
 * utils/perf-process-metrics.ts —— 进程性能指标的纯函数层（无 React / DOM 依赖）。
 *
 * 两个宿主给出同一份契约，但 type 词表不同：
 * - Electron `app.getAppMetrics()`：'Browser' | 'GPU' | 'Utility' | 'Tab'（渲染进程 = 'Tab'）。
 * - Tauri Rust 侧原生采样：'Browser' | 'Renderer' | 'GPU' | 'Utility'。
 * 历史实现只认 'Renderer' / 'GPU Process'，在 Electron 上两个分支永不命中，
 * 于是 HUD 的渲染进程内存 / CPU / GPU 内存恒为 0。这里把类型归一化收在一处，
 * 大小写与空格都不敏感，未知类型一律降级为 other（不计入内存与 CPU）。
 */

export type PerfMetricEntry = {
  type: string;
  name?: string;
  pid: number;
  cpuPercent: number;
  workingSetKB: number;
  peakWorkingSetKB: number;
  /** 仅在该进程确实占用专用显存且 > 0 时出现；不可用的宿主不提供该字段。 */
  dedicatedGpuKB?: number;
};

export type ProcessSummary = {
  rendererKB: number;
  gpuKB: number;
  gpuPeakKB: number;
  cpuPercent: number;
  vramKB: number;
  processCount: number;
};

type ProcessKind = 'renderer' | 'gpu' | 'other';

const normalizeType = (type: unknown): ProcessKind => {
  if (typeof type !== 'string') return 'other';
  const key = type.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (key === 'tab' || key === 'renderer' || key === 'renderer process') return 'renderer';
  if (key === 'gpu' || key === 'gpu process') return 'gpu';
  return 'other';
};

/** NaN / Infinity / 负值一律归零，避免脏数据污染汇总。 */
const safeNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 汇总一份进程指标快照；null / 非数组 / 空数组返回 null（调用方据此显示 '—'）。
 * CPU 只累加渲染进程，Browser / Utility 不计入。
 */
export function summarizeProcessMetrics(entries: PerfMetricEntry[] | null | undefined): ProcessSummary | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let rendererKB = 0;
  let cpuPercent = 0;
  let gpuKB = 0;
  let gpuPeakKB = 0;
  let vramKB = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = normalizeType(entry.type);
    const workingSetKB = safeNumber(entry.workingSetKB);
    if (kind === 'renderer') {
      rendererKB += workingSetKB;
      cpuPercent += safeNumber(entry.cpuPercent);
    } else if (kind === 'gpu') {
      gpuKB += workingSetKB;
      gpuPeakKB += safeNumber(entry.peakWorkingSetKB);
    }
    // 专用显存跨进程求和：某些宿主把它挂在 GPU 进程，某些挂在渲染/工具进程上。
    vramKB += safeNumber(entry.dedicatedGpuKB);
  }
  return { rendererKB, gpuKB, gpuPeakKB, cpuPercent, vramKB, processCount: entries.length };
}

/** KB → 展示文本：≥1024KB 用 MB（一位小数），否则原样 KB。 */
export function formatKB(kb: number): string {
  const value = safeNumber(kb);
  if (value >= 1024) return `${(value / 1024).toFixed(1)} MB`;
  return `${Math.round(value)} KB`;
}
