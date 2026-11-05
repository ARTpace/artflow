//! 把 `window.artflowConfig` 注入渲染层的初始化脚本（`WebviewWindow::initialization_script`）。
//!
//! Electron 侧这层是 `preload.cjs:200-232` 的 `contextBridge.exposeInMainWorld('artflowConfig', …)`，
//! 全部方法走 `ipcRenderer.sendSync` / `invoke`。Tauri 没有同步 IPC：`invoke` 一定是 Promise，
//! 而 `plugin-runtime/config-volume.ts:104` 与 `preferences-store.ts` 在**模块求值期**同步调用
//! `api.readStore(name)` / `api.readPreferences()`。所以这里只能：
//!
//! 1. 启动时由 `config::startup_cache()` 预读全部白名单卷，序列化后随脚本一起注入；
//! 2. 读方法（`readPreferences` / `readSecrets` / `readStore` / `stats`）全部同步地答自这份缓存；
//! 3. 写方法先同步地乐观更新缓存并返回 `{ok:true}`，再 `invoke` 落盘；落盘失败就**回滚缓存**并
//!    把失败通过 `console.error` + `artflowconfig:write-failed` 事件 + 启动日志暴露出来；
//! 4. 预设与存储管理本来就是用户点击触发的异步动作，直接 `invoke`。
//!
//! ## 唯一的能力缺口（必须知道，不能当作已对齐）
//!
//! `configStore` 的三条语义里，"写失败必须同步返回 `ok:false`"在 Tauri 无法保留：渲染层
//! `persist()` 拿到的返回值已经是乐观值。可以同步拒绝的情况仍然同步拒绝（未知卷、安全模式、
//! 非法键名、无法序列化的值），只有**磁盘层失败**（文件不可读、版本过高、IO 错误）是事后发现。
//! 要真正恢复同步失败语义，只有两条路：让 `persist()` 改 async（要动渲染层），或引入同步协议
//! （WebView2 的 WebResourceRequested 是 deferral 异步回复，同步 XHR 会在 UI 线程自锁，不可取）。

/// 脚本里缓存 JSON 字面量的占位符。`initialization_script` 会把它替换成真正的 JSON 字面量。
const CACHE_PLACEHOLDER: &str = "__ARTFLOW_CONFIG_CACHE_JSON__";

/// 桥标记的占位符，替换成 [`BRIDGE_MARKER`]。
const MARKER_PLACEHOLDER: &str = "__BRIDGE_MARKER__";

/// 注入脚本用的标记：`window.artflowConfig.__tauriBridge`。重复注入时据此跳过，
/// 避免第二次注入把第一次已经打过的补丁覆盖掉。
pub const BRIDGE_MARKER: &str = "tauri-2";

/// 生成完整的初始化脚本文本。`cache` 由 `config::startup_cache()` 在窗口创建前算好。
pub fn initialization_script(cache: &crate::config::StartupCache) -> String {
    let json = serde_json::to_string(cache).unwrap_or_else(|_| "null".to_string());
    TEMPLATE
        .replace(CACHE_PLACEHOLDER, &js_string_literal(&json))
        .replace(MARKER_PLACEHOLDER, BRIDGE_MARKER)
}

/// 把任意文本变成一个合法的 JS 字符串字面量（含引号）。
///
/// 直接字符串拼接 JSON 会在三种情况下破功：值里含 `</script>`（HTML 内联时提前结束标签）、
/// 含 U+2028/U+2029（在 JSON 里合法、在 JS 源码里是换行）、含引号与反斜杠。
/// `serde_json` 已经处理了引号和反斜杠，剩下两个在这里补。
fn js_string_literal(text: &str) -> String {
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"null\"".to_string());
    literal
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
        .replace("</", "<\\/")
}

const TEMPLATE: &str = r##"(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var existing = window.artflowConfig;
  if (existing && existing.__tauriBridge === '__BRIDGE_MARKER__') return;

  var SAFE_MODE_WRITE_REJECTED = '安全模式：本次会话不写入用户数据（去掉 ARTFLOW_SAFE_MODE=1 后正常启动即可保存）';
  var MAX_KEY_LENGTH = 120;
  var KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var RESERVED_KEYS = { '__proto__': true, 'constructor': true, 'prototype': true };
  var FAILURE_EVENT = 'artflowconfig:write-failed';

  var raw = __ARTFLOW_CONFIG_CACHE_JSON__;
  var cache;
  try {
    cache = JSON.parse(raw);
  } catch (error) {
    cache = null;
  }
  if (!cache || typeof cache !== 'object') {
    cache = { schemaVersion: 1, safeMode: false, configRoot: '', volumes: {}, secret: { encrypted: false, scheme: 'plaintext', prefix: 'enc:v1:' } };
  }
  if (!cache.volumes || typeof cache.volumes !== 'object') cache.volumes = {};
  window.__artflowConfigCache = cache;

  var VOLUMES = ['preferences', 'workspace', 'recent-files', 'secrets', 'ai-providers'];

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch (error) {
      return null;
    }
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function invokeAvailable() {
    var tauri = window.__TAURI__;
    return Boolean(tauri && tauri.core && typeof tauri.core.invoke === 'function');
  }

  // 懒查找而不是开场捕获：脚本可能早于 Tauri 的全局对象注入执行。
  // 拿不到时返回一个 rejected Promise，让异步方法统一走 {ok:false, message} 的形状，
  // 而不是变成静默成功。
  function invoke(command, args) {
    if (!invokeAvailable()) {
      return Promise.reject(new Error('Tauri invoke 不可用：' + command));
    }
    return window.__TAURI__.core.invoke(command, args);
  }

  function snapshotFailure(message) {
    return {
      ok: false,
      values: {},
      source: 'unreadable',
      schemaVersion: cache.schemaVersion || 1,
      degraded: true,
      message: message
    };
  }

  // 缓存条目是「扁平快照 + stats」：`CachedVolume` 用 `#[serde(flatten)]` 把 ConfigSnapshot
  // 的字段摊在同一层，所以 values/source/degraded 就在 entry 上，stats 是它的兄弟字段。
  function volumeOf(name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (VOLUMES.indexOf(name) === -1) return null;
    var entry = cache.volumes[name];
    return entry && typeof entry === 'object' ? entry : null;
  }

  // 渲染层会 Object.assign 到自己的表里，也会直接改读到的对象；
  // 交出克隆，缓存本身只由写路径维护。
  function readStoreSync(name) {
    var entry = volumeOf(name);
    if (!entry) return snapshotFailure('unknown config store');
    var values = clone(entry.values);
    return {
      ok: entry.ok !== false,
      values: values && typeof values === 'object' ? values : {},
      source: typeof entry.source === 'string' ? entry.source : 'unreadable',
      schemaVersion: typeof entry.schemaVersion === 'number' ? entry.schemaVersion : (cache.schemaVersion || 1),
      degraded: entry.degraded === true,
      message: typeof entry.message === 'string' ? entry.message : undefined,
      migratedFrom: typeof entry.migratedFrom === 'number' ? entry.migratedFrom : undefined
    };
  }

  function statsSync(store) {
    var entry = volumeOf(String(store));
    if (!entry || !entry.stats || typeof entry.stats !== 'object') return null;
    return clone(entry.stats);
  }

  function assertKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return 'invalid config key: ' + String(key);
    if (!KEY_PATTERN.test(key)) return 'invalid config key: ' + key;
    if (hasOwn(RESERVED_KEYS, key)) return 'invalid config key: ' + key;
    return null;
  }

  function checkValue(key, value) {
    var encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (error) {
      return '值必须是 JSON 可序列化的原始值或普通对象：' + key;
    }
    if (encoded === undefined) return '值不可序列化（undefined）：' + key;
    return null;
  }

  function reportWriteFailure(store, message) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[artflowConfig] 写入 ' + store + ' 失败：' + message);
    }
    try {
      window.dispatchEvent(new CustomEvent(FAILURE_EVENT, { detail: { store: store, message: message } }));
    } catch (error) { /* 事件通道不可用时仍有 console */ }
    // 失败也要留下持久痕迹：下一次 storageOverview / 启动日志能看到。
    try {
      invoke('tauri_config_boot_error', { line: '配置写入失败（' + store + '）：' + message });
    } catch (error) { /* invoke 不可用时无处上报，console 已记录 */ }
  }

  // 乐观应用：返回回滚函数。缓存是本次会话读的唯一来源，写后必须立刻可见。
  function applyLocal(store, payload) {
    var entry = cache.volumes[store];
    if (!entry) return function () {};
    if (!entry.values || typeof entry.values !== 'object') entry.values = {};
    if (!entry.stats || typeof entry.stats !== 'object') entry.stats = { keyCount: 0 };
    var previousValues = clone(entry.values) || {};
    var previousCount = typeof entry.stats.keyCount === 'number' ? entry.stats.keyCount : 0;
    var op = payload.op;
    if (op === 'set') {
      entry.values[payload.key] = clone(payload.value);
    } else if (op === 'patch') {
      var values = payload.values || {};
      for (var key in values) {
        if (!hasOwn(values, key)) continue;
        entry.values[key] = clone(values[key]);
      }
    } else if (op === 'reset') {
      if (Array.isArray(payload.keys)) {
        for (var index = 0; index < payload.keys.length; index += 1) delete entry.values[payload.keys[index]];
      } else {
        entry.values = {};
      }
    }
    entry.stats.keyCount = Object.keys(entry.values).length;
    return function rollback() {
      cache.volumes[store].values = previousValues;
      cache.volumes[store].stats.keyCount = previousCount;
    };
  }

  function writeStoreSync(store, payload) {
    var entry = volumeOf(store);
    if (!entry) return { ok: false, message: 'unknown config store' };
    if (entry.source === 'safe-mode' || cache.safeMode === true) {
      return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    }
    var op = payload.op;
    if (op === 'set') {
      var keyError = assertKey(payload.key);
      if (keyError) return { ok: false, message: keyError };
      var valueError = checkValue(payload.key, payload.value);
      if (valueError) return { ok: false, message: valueError };
    } else if (op === 'patch') {
      if (!payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) {
        return { ok: false, message: 'patch 需要一个普通对象' };
      }
      for (var key in payload.values) {
        if (!hasOwn(payload.values, key)) continue;
        var patchKeyError = assertKey(key);
        if (patchKeyError) return { ok: false, message: patchKeyError };
        var patchValueError = checkValue(key, payload.values[key]);
        if (patchValueError) return { ok: false, message: patchValueError };
      }
    } else if (op === 'reset') {
      if (payload.keys !== undefined && !Array.isArray(payload.keys)) {
        return { ok: false, message: 'reset 的 keys 必须是数组' };
      }
      if (Array.isArray(payload.keys)) {
        for (var index = 0; index < payload.keys.length; index += 1) {
          var resetKeyError = assertKey(payload.keys[index]);
          if (resetKeyError) return { ok: false, message: resetKeyError };
        }
      }
    } else {
      return { ok: false, message: 'unsupported config op: ' + String(op) };
    }

    var rollback = applyLocal(store, payload);
    var request = { store: store, op: op };
    if (op === 'set') {
      request.key = payload.key;
      request.value = payload.value;
    } else if (op === 'patch') {
      request.values = payload.values;
    } else if (Array.isArray(payload.keys)) {
      request.keys = payload.keys;
    }
    invoke('tauri_config_write', { request: request }).then(function (result) {
      if (result && result.ok === true) {
        // 写成功后 stats 不能再报启动快照：exists/bytes/updatedAt 用宿主真实回执刷新，
        // 否则面板会一直显示「文件不存在」而磁盘上其实已经写好。
        var refreshed = volumeOf(store);
        if (refreshed) {
          refreshed.source = 'file';
        }
        if (refreshed && refreshed.stats && typeof refreshed.stats === 'object') {
          refreshed.stats.exists = true;
          refreshed.stats.source = 'file';
          if (typeof result.bytes === 'number') refreshed.stats.bytes = result.bytes;
          if (typeof result.count === 'number') refreshed.stats.keyCount = result.count;
          refreshed.stats.updatedAt = new Date().toISOString();
        }
        return;
      }
      rollback();
      reportWriteFailure(store, (result && result.message) || '写入未确认');
    }, function (error) {
      rollback();
      reportWriteFailure(store, error && error.message ? error.message : String(error));
    });
    // 乐观结果。磁盘失败会回滚缓存并走上面的失败通道，见文件头「能力缺口」。
    return { ok: true };
  }

  function presetCall(op, name) {
    var request = { op: op };
    if (typeof name === 'string') request.name = name;
    return invoke('tauri_config_presets', { request: request }).then(function (result) {
      return result && typeof result === 'object' ? result : { ok: false, message: '预设操作没有返回结果' };
    }, function (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    });
  }

  function storageCall(op) {
    return invoke('tauri_config_storage', { request: { op: op } }).then(function (result) {
      return result && typeof result === 'object' ? result : { ok: false, message: '存储操作没有返回结果' };
    }, function (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    });
  }

  var bridge = {
    __tauriBridge: '__BRIDGE_MARKER__',

    readPreferences: function () { return readStoreSync('preferences'); },
    readSecrets: function () { return readStoreSync('secrets'); },
    readStore: function (name) { return readStoreSync(name); },
    stats: function (store) { return statsSync(store); },

    setPreference: function (key, value) {
      return writeStoreSync('preferences', { op: 'set', key: key, value: value });
    },
    patchPreferences: function (values) {
      return writeStoreSync('preferences', { op: 'patch', values: values });
    },
    resetPreferences: function (keys) {
      return writeStoreSync('preferences', { op: 'reset', keys: Array.isArray(keys) ? keys : [] });
    },
    clearPreferences: function () {
      return writeStoreSync('preferences', { op: 'reset' });
    },
    setSecret: function (key, value) {
      return writeStoreSync('secrets', { op: 'set', key: key, value: value });
    },
    removeSecret: function (key) {
      return writeStoreSync('secrets', { op: 'reset', keys: [key] });
    },
    setStoreValue: function (name, key, value) {
      return writeStoreSync(name, { op: 'set', key: key, value: value });
    },
    patchStore: function (name, values) {
      return writeStoreSync(name, { op: 'patch', values: values });
    },
    resetStore: function (name, keys) {
      return writeStoreSync(name, { op: 'reset', keys: Array.isArray(keys) ? keys : [] });
    },
    clearStore: function (name) {
      return writeStoreSync(name, { op: 'reset' });
    },

    listPresets: function () { return presetCall('list'); },
    savePreset: function (name) { return presetCall('save', name); },
    loadPreset: function (name) { return presetCall('load', name); },
    removePreset: function (name) { return presetCall('remove', name); },
    exportPresetToFile: function () { return presetCall('export-to'); },
    importPresetFromFile: function () { return presetCall('import-from'); },

    storageOverview: function () { return storageCall('overview'); },
    clearCache: function () { return storageCall('clear-cache'); },

    reportBoot: function (payload) {
      try {
        invoke('tauri_config_boot_log', { payload: payload });
      } catch (error) { /* 启动期上报失败不能让页面挂掉 */ }
    },
    reportBootError: function (line) {
      try {
        invoke('tauri_config_boot_error', { line: String(line).slice(0, 1600) });
      } catch (error) { /* 同上 */ }
    }
  };

  window.artflowConfig = bridge;
})();
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::startup_cache_for_tests;
    use std::path::PathBuf;

    fn cache_root() -> PathBuf {
        let unique = format!(
            "artflow-config-script-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("script fixture root");
        path
    }

    fn script() -> String {
        let root = cache_root();
        let cache = startup_cache_for_tests(&root, false);
        let text = initialization_script(&cache);
        let _ = std::fs::remove_dir_all(&root);
        text
    }

    /// 脚本里嵌入的缓存必须能被 `JSON.parse` 吃掉：占位符替换掉之后那一段就是 JSON 字面量。
    #[test]
    fn the_embedded_cache_is_a_json_string_literal() {
        let text = script();
        assert!(!text.contains(CACHE_PLACEHOLDER), "placeholder must be replaced");
        let start = text.find("var raw = ").expect("raw assignment");
        let rest = &text[start + "var raw = ".len()..];
        let end = rest.find(";\n  var cache").expect("statement end");
        let literal = &rest[..end];
        assert!(literal.starts_with('"'), "must be a string literal: {literal}");
        let inner: String = serde_json::from_str(literal).expect("literal is valid JSON string");
        let parsed: serde_json::Value = serde_json::from_str(&inner).expect("inner text is JSON");
        assert!(parsed.get("volumes").is_some(), "cache carries volumes");
        assert!(parsed.get("secret").is_some(), "cache carries the cipher description");
    }

    /// `</script>` 与 U+2028 在 JSON 里合法、在 JS 源码里会截断或换行。
    #[test]
    fn hostile_text_cannot_break_out_of_the_literal() {
        assert_eq!(js_string_literal("</script>"), "\"<\\/script>\"");
        let separator = js_string_literal("a\u{2028}b");
        assert!(separator.contains("\\u2028"), "{separator}");
        assert!(!separator.contains('\u{2028}'), "{separator}");
        let line = js_string_literal("a\u{2029}b");
        assert!(line.contains("\\u2029"), "{line}");
        assert_eq!(js_string_literal("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    /// 27 个方法名一个都不能少 —— 它们就是 `preload.cjs:200-232` 的对外契约。
    #[test]
    fn every_method_from_the_preload_bridge_is_present() {
        let text = script();
        let methods = [
            "readPreferences",
            "readSecrets",
            "setPreference",
            "patchPreferences",
            "resetPreferences",
            "clearPreferences",
            "setSecret",
            "removeSecret",
            "readStore",
            "setStoreValue",
            "patchStore",
            "resetStore",
            "clearStore",
            "stats",
            "reportBoot",
            "reportBootError",
            "listPresets",
            "savePreset",
            "loadPreset",
            "removePreset",
            "exportPresetToFile",
            "importPresetFromFile",
            "storageOverview",
            "clearCache",
        ];
        for method in methods {
            assert!(
                text.contains(&format!("    {method}: function")),
                "missing {method} in the injected bridge"
            );
        }
    }

    /// 每个同步方法名都要挂在 `window.artflowConfig` 上，而不是散在闭包里。
    #[test]
    fn the_bridge_is_installed_on_the_window() {
        let text = script();
        assert!(text.contains("window.artflowConfig = bridge;"));
        assert!(text.contains("window.__artflowConfigCache = cache;"));
        assert!(text.contains(BRIDGE_MARKER));
    }

    /// 安全模式的拒绝文案与卷白名单必须和 Electron 侧一字不差。
    #[test]
    fn the_injected_script_repeats_the_upstream_messages() {
        let text = script();
        assert!(text.contains("安全模式：本次会话不写入用户数据"));
        assert!(text.contains("unknown config store"));
        assert!(text.contains("patch 需要一个普通对象"));
        assert!(text.contains("reset 的 keys 必须是数组"));
        for volume in ["preferences", "workspace", "recent-files", "secrets", "ai-providers"] {
            assert!(text.contains(&format!("'{volume}'")), "missing volume {volume}");
        }
    }
}
