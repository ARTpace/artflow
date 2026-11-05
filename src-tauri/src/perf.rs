//! Native process metrics for the perf-monitor HUD.
//!
//! The renderer reads one whitelisted shape on both hosts
//! (`utils/perf-process-metrics.ts` + `types.ts`): Electron fills it from
//! `app.getAppMetrics()`, this module fills it from the real OS counters so the
//! HUD never shows fabricated numbers.

use serde::Serialize;

#[derive(Serialize)]
pub struct PerfMetricEntry {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub pid: u32,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f32,
    #[serde(rename = "workingSetKB")]
    pub working_set_kb: u64,
    #[serde(rename = "peakWorkingSetKB")]
    pub peak_working_set_kb: u64,
    #[serde(rename = "dedicatedGpuKB", skip_serializing_if = "Option::is_none")]
    pub dedicated_gpu_kb: Option<u64>,
}

impl PerfMetricEntry {
    fn new(kind: &'static str, pid: u32, name: Option<String>) -> Self {
        Self {
            kind,
            name,
            pid,
            cpu_percent: 0.0,
            working_set_kb: 0,
            peak_working_set_kb: 0,
            dedicated_gpu_kb: None,
        }
    }
}

/// Classifies a process of our own tree the way the HUD expects it.
///
/// Chromium marks its children on the command line, and WebView2 keeps that
/// convention; the root process is the browser itself.
pub fn classify(pid: u32, root: u32, cmd: &str) -> &'static str {
    if pid == root {
        return "Browser";
    }
    let mut kind = "Utility";
    for argument in cmd.split_whitespace() {
        if let Some(value) = argument.strip_prefix("--type=") {
            kind = match value {
                "gpu-process" => "GPU",
                "renderer" => "Renderer",
                _ => "Utility",
            };
        }
    }
    kind
}

#[cfg(windows)]
mod native {
    use super::{classify, PerfMetricEntry};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    use sysinfo::{
        ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind,
    };
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
        PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    const COUNTER_TIMEOUT: Duration = Duration::from_millis(120);
    const CPU_WINDOW: Duration = Duration::from_millis(250);

    pub fn collect() -> Result<Vec<PerfMetricEntry>, String> {
        let refresh = ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet);
        let mut system = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh))
            .map_err(|error| format!("process snapshot unavailable: {error}"))?;

        let root = std::process::id();
        let order = process_tree(&system, root);

        // CPU is a delta over a real time window: sample kernel+user time,
        // wait, then sample again. sysinfo's own cpu_usage stays near zero
        // here, so it is not used as the source of truth.
        let first = cpu_times(&order);
        let window_start = Instant::now();
        std::thread::sleep(CPU_WINDOW);
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&order.iter().map(|pid| sysinfo::Pid::from_u32(*pid)).collect::<Vec<_>>()),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        let second = cpu_times(&order);
        let elapsed = window_start.elapsed().as_secs_f64().max(0.001);

        let mut entries = Vec::with_capacity(order.len());
        for (index, pid) in order.iter().enumerate() {
            let process = system.process(sysinfo::Pid::from_u32(*pid));
            let cmd = process
                .map(|process| {
                    process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let mut entry = PerfMetricEntry::new(classify(*pid, root, &cmd), *pid, None);
            if let Some(process) = process {
                entry.name = Some(process.name().to_string_lossy().into_owned());
                entry.working_set_kb = process.memory() / 1024;
            }
            if let (Some(start), Some(end)) = (first[index], second[index]) {
                let seconds = (end.saturating_sub(start)) as f64 / 10_000_000.0;
                // Chromium/Electron scale: 100 % == one core fully busy, so a
                // multi-threaded process can exceed 100. Matching that keeps
                // the HUD comparable across both hosts.
                entry.cpu_percent = finite(((seconds / elapsed) * 100.0) as f32);
            }
            entry.peak_working_set_kb = peak_working_set_kb(*pid).unwrap_or(entry.working_set_kb);
            entries.push(entry);
        }

        let pids: Vec<u32> = entries.iter().map(|entry| entry.pid).collect();
        for (entry, vram) in entries.iter_mut().zip(dedicated_gpu_kb(&pids)) {
            entry.dedicated_gpu_kb = vram;
        }
        Ok(entries)
    }

    fn process_tree(system: &System, root: u32) -> Vec<u32> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent.as_u32()).or_default().push(pid.as_u32());
            }
        }
        let mut order = vec![root];
        let mut cursor = 0;
        while cursor < order.len() {
            if let Some(kids) = children.get(&order[cursor]) {
                for kid in kids {
                    if !order.contains(kid) {
                        order.push(*kid);
                    }
                }
            }
            cursor += 1;
        }
        order
    }

    /// Kernel + user time in 100 ns units, straight from the OS.
    fn cpu_times(pids: &[u32]) -> Vec<Option<u64>> {
        pids.iter()
            .map(|pid| unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, *pid).ok()?;
                let mut creation = Default::default();
                let mut exit = Default::default();
                let mut kernel = Default::default();
                let mut user = Default::default();
                let result = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);
                let _ = CloseHandle(process);
                if result.is_err() {
                    return None;
                }
                Some(filetime_units(kernel) + filetime_units(user))
            })
            .collect()
    }

    fn filetime_units(value: windows::Win32::Foundation::FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    fn finite(value: f32) -> f32 {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            0.0
        }
    }

    fn peak_working_set_kb(pid: u32) -> Option<u64> {
        unsafe {
            let process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                false,
                pid,
            )
            .ok()?;
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let result = GetProcessMemoryInfo(process, &mut counters, counters.cb);
            let _ = CloseHandle(process);
            result.ok()?;
            Some((counters.PeakWorkingSetSize as u64) / 1024)
        }
    }

    struct Query(PDH_HQUERY);

    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                let _ = PdhCloseQuery(self.0);
            }
        }
    }

    fn dedicated_gpu_kb(pids: &[u32]) -> Vec<Option<u64>> {
        let mut values = vec![None; pids.len()];
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return values;
            }
            let query = Query(query);

            let mut counters = Vec::with_capacity(pids.len());
            for pid in pids {
                let path = format!(r"\GPU Process Memory(pid_{pid}_*)\Dedicated Usage");
                let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
                let mut counter = PDH_HCOUNTER::default();
                let added = PdhAddEnglishCounterW(
                    query.0,
                    PCWSTR::from_raw(wide.as_ptr()),
                    0,
                    &mut counter,
                ) == 0;
                counters.push(if added { Some(counter) } else { None });
            }
            if !counters.iter().any(Option::is_some) {
                return values;
            }

            // Gauges still need a settled second sample on some drivers.
            let _ = PdhCollectQueryData(query.0);
            std::thread::sleep(COUNTER_TIMEOUT);
            if PdhCollectQueryData(query.0) != 0 {
                return values;
            }

            for (index, counter) in counters.iter().enumerate() {
                if let Some(counter) = counter {
                    values[index] = counter_kb(*counter);
                }
            }
        }
        values
    }

    unsafe fn counter_kb(counter: PDH_HCOUNTER) -> Option<u64> {
        let mut size = 0u32;
        let mut count = 0u32;
        let probe = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_LARGE,
            &mut size,
            &mut count,
            None,
        );
        if probe != PDH_MORE_DATA || size == 0 || count == 0 {
            return None;
        }
        // u64 storage keeps the item buffer aligned for the value records.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let read = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_LARGE,
            &mut size,
            &mut count,
            Some(buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W),
        );
        if read != 0 || count == 0 {
            return None;
        }
        let items =
            std::slice::from_raw_parts(buffer.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, count as usize);
        let mut total = 0i64;
        for item in items {
            let status = item.FmtValue.CStatus;
            if status == PDH_CSTATUS_VALID_DATA || status == PDH_CSTATUS_NEW_DATA {
                let value = item.FmtValue.Anonymous.largeValue;
                if value > 0 {
                    total += value;
                }
            }
        }
        if total <= 0 {
            None
        } else {
            Some((total as u64) / 1024)
        }
    }
}

#[cfg(not(windows))]
mod native {
    use super::PerfMetricEntry;

    pub fn collect() -> Result<Vec<PerfMetricEntry>, String> {
        Err("perf metrics are only implemented on Windows".to_string())
    }
}

pub use native::collect;
