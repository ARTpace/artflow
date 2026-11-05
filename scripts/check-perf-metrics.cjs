// 进程性能指标纯函数自检：把 Electron / Tauri 两种真实快照形状喂进 summarizeProcessMetrics，
// 断言 HUD 依赖的五个字段都对。之前 HUD 用手写 for 循环匹配 'Renderer' / 'GPU Process'，
// 在 Electron（词表是 'Tab'）上永不命中、全 0 —— 这里的用例就是防这个回归。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { summarizeProcessMetrics, formatKB } = require('../utils/perf-process-metrics.ts');

// —— Electron app.getAppMetrics() 真实形状：渲染进程叫 'Tab'，没有专用显存字段 ——
const electron = summarizeProcessMetrics([
  { type: 'Browser', pid: 1, cpuPercent: 1.2, workingSetKB: 90000, peakWorkingSetKB: 95000 },
  { type: 'Tab', pid: 2, cpuPercent: 12, workingSetKB: 200000, peakWorkingSetKB: 210000 },
  { type: 'GPU', pid: 3, cpuPercent: 3.5, workingSetKB: 113000, peakWorkingSetKB: 130000 },
  { type: 'Utility', pid: 4, cpuPercent: 0.5, workingSetKB: 20000, peakWorkingSetKB: 21000 },
]);
assert.equal(electron.rendererKB, 200000, 'Electron 渲染进程是 Tab');
assert.equal(electron.cpuPercent, 12, 'CPU 只累加渲染进程');
assert.equal(electron.gpuKB, 113000);
assert.equal(electron.gpuPeakKB, 130000);
assert.equal(electron.vramKB, 0, 'Electron 不提供专用显存');
assert.equal(electron.processCount, 4);

// —— Tauri Rust 采样形状：'Renderer' + 跨进程专用显存 ——
const tauri = summarizeProcessMetrics([
  { type: 'Browser', pid: 10, cpuPercent: 0.4, workingSetKB: 40000, peakWorkingSetKB: 0 },
  { type: 'Renderer', pid: 11, cpuPercent: 8, workingSetKB: 100000, peakWorkingSetKB: 0 },
  { type: 'GPU', pid: 12, cpuPercent: 2, workingSetKB: 50000, peakWorkingSetKB: 0, dedicatedGpuKB: 115900 },
  { type: 'Utility', pid: 13, cpuPercent: 0.1, workingSetKB: 8000, peakWorkingSetKB: 0, dedicatedGpuKB: 4096 },
]);
assert.equal(tauri.rendererKB, 100000);
assert.equal(tauri.cpuPercent, 8);
assert.equal(tauri.gpuKB, 50000);
assert.equal(tauri.vramKB, 115900 + 4096, '专用显存跨条目求和（115900 + 4096 = 119996）');

// —— 空/非法输入一律 null，HUD 据此显示 '—' ——
assert.equal(summarizeProcessMetrics(null), null);
assert.equal(summarizeProcessMetrics(undefined), null);
assert.equal(summarizeProcessMetrics([]), null);
assert.equal(summarizeProcessMetrics({}), null);
assert.equal(summarizeProcessMetrics('nope'), null);

// —— 脏数据不能污染结果 ——
const dirty = summarizeProcessMetrics([
  { type: 'WindowsProcess', pid: 20, cpuPercent: 99, workingSetKB: 5000, peakWorkingSetKB: 5000 },
  { type: 'Tab', pid: 21, cpuPercent: -4, workingSetKB: -200, peakWorkingSetKB: 0 },
  { type: 'Renderer', pid: 22, cpuPercent: Number.NaN, workingSetKB: Number.NaN, peakWorkingSetKB: Number.NaN },
  { type: 'GPU', pid: 23, cpuPercent: 1, workingSetKB: 1000, peakWorkingSetKB: -1, dedicatedGpuKB: 0 },
  { type: 'GPU Process', pid: 24, cpuPercent: 1, workingSetKB: 2000, peakWorkingSetKB: 0, dedicatedGpuKB: -8 },
]);
assert.equal(dirty.rendererKB, 0, '负值/NaN 归零');
assert.equal(dirty.cpuPercent, 0);
assert.equal(dirty.gpuKB, 3000, "GPU 与 'GPU Process' 同归一类");
assert.equal(dirty.gpuPeakKB, 0);
assert.equal(dirty.vramKB, 0, 'dedicatedGpuKB: 0 / 负值不计');
assert.equal(dirty.processCount, 5, '未知类型仍计入进程数');

// —— 大小写与空格不敏感 ——
const mixed = summarizeProcessMetrics([
  { type: 'tab', pid: 30, cpuPercent: 2, workingSetKB: 10, peakWorkingSetKB: 0 },
  { type: 'RENDERER PROCESS', pid: 31, cpuPercent: 3, workingSetKB: 20, peakWorkingSetKB: 0 },
  { type: 'gpu process', pid: 32, cpuPercent: 0, workingSetKB: 40, peakWorkingSetKB: 60 },
]);
assert.equal(mixed.rendererKB, 30);
assert.equal(mixed.cpuPercent, 5);
assert.equal(mixed.gpuKB, 40);
assert.equal(mixed.gpuPeakKB, 60);

// —— 格式化边界 ——
assert.equal(formatKB(512), '512 KB');
assert.equal(formatKB(2048), '2.0 MB');
assert.equal(formatKB(1023), '1023 KB');
assert.equal(formatKB(1024), '1.0 MB');
assert.equal(formatKB(0), '0 KB');
assert.equal(formatKB(-16), '0 KB');
assert.equal(formatKB(Number.NaN), '0 KB');

console.log('PASS perf process metrics: Electron Tab / Tauri Renderer normalization, dedicated VRAM sum, dirty value guards, case-insensitive types, formatKB boundaries');
