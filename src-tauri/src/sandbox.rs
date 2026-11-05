//! Phase 2-D — 外部沙箱插件宿主的 Rust 移植（对应 Electron 侧
//! `main/pluginSandboxHost.cjs` + `main/sandboxedPlugins.cjs` + `main/hostFacade.cjs`
//! + `main/hostEvents.cjs` + `main/pluginStoreController.cjs` + `main/pluginData.cjs`
//! + `main/pluginArchive.cjs`）。
//!
//! 能力边界（与上游等价的部分）
//! * 插件清单/安装/卸载/来源判定：文案、上限、校验顺序全部照搬 `sandboxedPlugins.cjs`。
//! * 插件源码闸门：`hasDeniedSource` 的等价实现，只放行字面量 `require("obsidian")`。
//! * 宿主能力面：`hostFacade` 的命名空间白名单、arity、权限声明、参数上限。
//! * 事件面：`hostEvents` 的订阅表、闭集事件名、payload 逐字段重建。
//! * 内容寻址数据仓：`pluginStoreController` 的 sha256 + `wx` 语义。
//! * 插件 data.json：`pluginData` 的 256 KiB 上限与原子写。
//! * ZIP 解包：`pluginArchive` 的上限与不安全路径拒绝（自带 EOCD/CD 解析，store + deflate）。
//! * 宿主机状态机：ready 超时、崩溃/销毁重建、重建预算、重建被拒。
//!
//! 与上游的**有意差异**（都写在这里，避免"看起来一样其实不是"）
//! 1. 宿主窗口：Electron 用隐藏 `BrowserWindow` + preload；Tauri 用隐藏
//!    `WebviewWindow(label = "plugin-sandbox")` + `initialization_script` 注入 `sandboxHost` shim，
//!    页面本身由 app 级自定义协议 `artflow-sandbox://` 提供（资源取自 `sandbox/`）。
//! 2. WebView2 没有 `unresponsive` 事件。上游靠 Chromium 的响应性信号；这里改为
//!    **调用超时**驱动的等价状态机：一次 `call` 超过 `CALL_TIMEOUT_MS` 即判宿主无响应，
//!    再经 `UNRESPONSIVE_GRACE_MS` 宽限仍未收到任何回执则强制重建（reason 仍取 `unresponsive`）。
//! 3. `host.assets.*` 依赖主进程资产库（Electron 的 `storageController`）。Tauri 侧
//!    `project.rs` 仍是占位模块，因此这三条方法返回上游在"服务缺失"时的原文案
//!    `asset storage is unavailable`，不伪造空列表。
//! 4. 会话隔离（Electron 的 `partition: 'artflow-plugin-sandbox'`）在 Tauri 侧没有等价物：
//!    宿主窗口只加载应用自带协议 + 由 `capabilities` 拒绝一切其它命令，隔离靠 ACL 与
//!    "该窗口只拿到 `tauri_sandbox_reply` 一条命令"实现。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

// ———————————————————————————— 上限与常量 ————————————————————————————

pub const HOST_API_VERSION: &str = "1.2.0";

/// `sandboxedPlugins.cjs`
pub const MAX_SOURCE_BYTES: u64 = 64 * 1024;
pub const MAX_CLIENT_BYTES: u64 = 128 * 1024;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
pub const MAX_PACKAGES: usize = 32;
pub const MAX_SOURCE_NAME_CHARS: usize = 80;
pub const MAX_DESCRIPTION_CHARS: usize = 200;
pub const MAX_REQUIRES: usize = 8;
pub const MAX_RELATIVE_LIST: usize = 8;
pub const MAX_HOSTS: usize = 8;
pub const MAX_LOCALE_SHARD_BYTES: u64 = 1024 * 1024;

/// `pluginSandboxHost.cjs`
pub const MAX_PARSE_BYTES: usize = 512 * 1024 * 1024;
pub const UNRESPONSIVE_GRACE_MS: u64 = 10_000;
pub const READY_TIMEOUT_MS: u64 = 15_000;
pub const CALL_TIMEOUT_MS: u64 = 20_000;
pub const MAX_AUTO_REBUILDS: usize = 3;
pub const AUTO_REBUILD_WINDOW_MS: u64 = 60_000;

/// `hostFacade.cjs`
pub const MAX_HOST_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_ARG_COUNT: usize = 4;
pub const MAX_LIST_LIMIT: usize = 200;
pub const MAX_LIST_SCAN: usize = 1000;
pub const MAX_LIST_BATCH: usize = 200;
pub const MAX_RENAME_ITEMS: usize = 40;
pub const MAX_ASSET_NAME: usize = 180;
pub const MAX_ASSET_ID: usize = 120;

/// `hostEvents.cjs`
pub const EVENT_NAMES: [&str; 3] = ["asset.added", "asset.renamed", "asset.removed"];
pub const MAX_SUBSCRIPTIONS_PER_PLUGIN: usize = 16;
pub const MAX_NAMES_PER_SUBSCRIPTION: usize = 2;
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024;
pub const MAX_SUBSCRIPTION_ID: usize = 120;
pub const MAX_NAME_CHARS: usize = 180;
pub const MAX_KIND_CHARS: usize = 40;
pub const MAX_MIME_CHARS: usize = 120;

/// `pluginStoreController.cjs`
pub const MAX_STORED_BYTES: u64 = 512 * 1024 * 1024;

/// `pluginData.cjs`
pub const MAX_PLUGIN_DATA_BYTES: usize = 256 * 1024;
pub const DATA_FILE_NAME: &str = "data.json";

/// `pluginArchive.cjs`
pub const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PLUGIN_ENTRY_BYTES: usize = 1024 * 1024;
pub const MAX_PLUGIN_ENTRIES: usize = 4000;
pub const EOCD_SCAN_BYTES: usize = 22 + 65535 + 64;

pub const PROTECTED_FILES: [&str; 4] = ["manifest.json", "plugin.js", "client.js", "data.json"];
pub const RESERVED_ENTRY_NAMES: [&str; 4] = ["manifest.json", "client.js", "data.json", "guest.js"];
pub const CAPABILITY_NAMES: [&str; 5] = ["components", "format", "commands", "panels", "assets"];
pub const HOST_PERMISSIONS: [&str; 3] = ["assets.read", "assets.write", "events.subscribe"];
pub const HOST_PENDING_NAMESPACES: [&str; 3] = ["board", "collections", "ui"];

pub const SANDBOX_WINDOW_LABEL: &str = "plugin-sandbox";
pub const SANDBOX_SCHEME: &str = "artflow-sandbox";
pub const HOST_RESTARTED_EVENT: &str = "artflow-app:sandbox-host-restarted";

/// 沙箱窗口内的 `sandboxHost` shim：与 `sandbox/preload.cjs` 的 `contextBridge` 面等价。
/// `onMessage` 由宿主通过 `eval` 调 `window.__ARTFLOW_SANDBOX_DELIVER__` 投递；`reply` 走本模块
/// 唯一对沙箱窗口开放的 Tauri 命令。
pub fn sandbox_shim_script() -> String {
    r#"(function () {
  var listeners = [];
  // 跨进程只能传 JSON：大字节用 base64 + bytesEncoding 标记，投递前还原成 Uint8Array，
  // 插件看到的 `bytes` 与 Electron 下 `structuredClone` 出来的类型一致。
  function revive(message) {
    if (!message || message.bytesEncoding !== 'base64' || typeof message.bytes !== 'string') return message;
    var binary = window.atob(message.bytes);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    var copy = {};
    for (var key in message) { if (Object.prototype.hasOwnProperty.call(message, key)) copy[key] = message[key]; }
    copy.bytes = bytes;
    delete copy.bytesEncoding;
    return copy;
  }
  window.sandboxHost = {
    onMessage: function (callback) {
      if (typeof callback === 'function') listeners.push(callback);
    },
    reply: function (message) {
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') return;
      Promise.resolve(internals.invoke('tauri_sandbox_reply', { message: message })).catch(function (error) {
        console.error('[plugin-sandbox] reply failed: ' + (error && error.message ? error.message : error));
      });
    },
  };
  window.__ARTFLOW_SANDBOX_DELIVER__ = function (message) {
    var payload = revive(message);
    for (var index = 0; index < listeners.length; index += 1) {
      try { listeners[index](payload); } catch (error) { console.error('[plugin-sandbox] listener threw: ' + error); }
    }
  };
})();"#
        .to_string()
}

// ———————————————————————————— 错误 ————————————————————————————

#[derive(Debug, Clone)]
pub struct SandboxError(String);

impl SandboxError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SandboxError {}

pub type SandboxResult<T> = Result<T, SandboxError>;

// ———————————————————————————— 文本与模式工具 ————————————————————————————

/// JS `string.length` 是 UTF-16 码元数；上限比较必须与它一致。
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn slice_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// `/^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/`
pub fn matches_id_pattern(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("local.") else {
        return false;
    };
    segments_match(rest, |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/`
/// — 至少两个标签；每个标签首尾必须是小写字母或数字，长度 ≤ 64。
pub fn matches_host_pattern(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > 64 {
            return false;
        }
        let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if !edge(&bytes[0]) || !edge(&bytes[bytes.len() - 1]) {
            return false;
        }
        bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    })
}

/// `/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/` — 标签可以以 `-` 结尾，至少两段。
pub fn matches_dependency_pattern(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        let bytes = label.as_bytes();
        if bytes.is_empty() {
            return false;
        }
        (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    })
}

/// `/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/`
pub fn matches_version_pattern(value: &str) -> bool {
    parse_version(value).is_some()
}

/// `/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.js$/`
pub fn matches_entry_pattern(value: &str) -> bool {
    let Some(stem) = value.strip_suffix(".js") else {
        return false;
    };
    let count = utf16_len(stem);
    if count == 0 || count > 63 {
        return false;
    }
    let mut bytes = stem.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn segments_match(value: &str, is_atom: impl Fn(u8) -> bool) -> bool {
    if value.is_empty() {
        return false;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut expect_atom = true;
    while index < bytes.len() {
        let byte = bytes[index];
        if expect_atom {
            if !is_atom(byte) {
                return false;
            }
            expect_atom = false;
        } else if byte == b'.' || byte == b'-' {
            expect_atom = true;
        } else if !is_atom(byte) {
            return false;
        }
        index += 1;
    }
    !expect_atom
}

/// `sandboxedPlugins.cjs::DENIED_SOURCE` 的等价物。
///
/// 上游先把字面量 `require("obsidian")` 抠掉再整体匹配正则；这里改成一次扫描：
/// 逐字节识别 `require` / `process` / `ipcRenderer` / `child_process` / `eval` / `Function`
/// 后紧跟 `(` 或 `.`、`import` 后紧跟 `(`/字母/`*`/`{`、以及任意 `node:` 出现。
pub fn has_denied_source(source: &str) -> bool {
    let bytes = source.as_bytes();
    if bytes.windows(5).any(|window| window == b"node:") {
        return true;
    }
    let banned = [
        "require",
        "process",
        "ipcRenderer",
        "child_process",
        "eval",
        "Function",
    ];
    for keyword in banned {
        let needle = keyword.as_bytes();
        let mut start = 0;
        while let Some(offset) = find_bytes(&bytes[start..], needle) {
            let at = start + offset;
            let after = at + needle.len();
            // 只认完整标识符边界：`myrequire(` 不算命中。
            let before_ok = at == 0 || !is_identifier_byte(bytes[at - 1]);
            if !before_ok {
                start = at + 1;
                continue;
            }
            if keyword == "require" && obsidian_require_at(source, at) {
                start = after;
                continue;
            }
            if let Some(next) = bytes.get(after) {
                let is_call = matches!(next, b'(' | b'.');
                // `\s*` 在正则里允许空白夹在中间，这里按上游语义放宽。
                let is_spaced_call = *next == b' '
                    && bytes
                        .get(after + 1)
                        .is_some_and(|byte| matches!(byte, b'(' | b'.'));
                if is_call || is_spaced_call {
                    return true;
                }
            }
            start = at + 1;
        }
    }
    // `\bimport\s*(?:\(|[a-z*{])`
    let mut start = 0;
    while let Some(offset) = find_bytes(&bytes[start..], b"import") {
        let at = start + offset;
        if at > 0 && is_identifier_byte(bytes[at - 1]) {
            start = at + 1;
            continue;
        }
        let mut cursor = at + 6;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace()) {
            cursor += 1;
        }
        if let Some(next) = bytes.get(cursor) {
            if matches!(*next, b'(' | b'*' | b'{') || next.is_ascii_lowercase() {
                return true;
            }
        }
        start = at + 1;
    }
    false
}

/// `\brequire\s*\(\s*(['"])obsidian\1\s*\)` — 唯一被放行的 require。
fn obsidian_require_at(source: &str, at: usize) -> bool {
    let bytes = source.as_bytes();
    let mut cursor = at + "require".len();
    while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace()) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'(') {
        return false;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace()) {
        cursor += 1;
    }
    let Some(quote) = bytes.get(cursor).copied().filter(|byte| matches!(byte, b'\'' | b'"')) else {
        return false;
    };
    cursor += 1;
    let literal = b"obsidian";
    if bytes.get(cursor..cursor + literal.len()) != Some(literal) {
        return false;
    }
    cursor += literal.len();
    if bytes.get(cursor) != Some(&quote) {
        return false;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace()) {
        cursor += 1;
    }
    bytes.get(cursor) == Some(&b')')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

// ———————————————————————————— 版本比较 ————————————————————————————

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Option<String>,
}

pub fn parse_version(value: &str) -> Option<ParsedVersion> {
    let (core, prerelease) = match value.split_once('-') {
        Some((core, tail)) => {
            if tail.is_empty()
                || !tail
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
            {
                return None;
            }
            (core, Some(tail.to_string()))
        }
        None => (value, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let parse = |part: &str| -> Option<u64> {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse::<u64>().ok()
    };
    Some(ParsedVersion {
        major: parse(major)?,
        minor: parse(minor)?,
        patch: parse(patch)?,
        prerelease,
    })
}

/// `comparePluginVersions`：正数表示 `left` 更新。
pub fn compare_plugin_versions(left: &str, right: &str) -> i32 {
    let (Some(a), Some(b)) = (parse_version(left), parse_version(right)) else {
        return 0;
    };
    for (x, y) in [
        (a.major, b.major),
        (a.minor, b.minor),
        (a.patch, b.patch),
    ] {
        if x != y {
            return if x > y { 1 } else { -1 };
        }
    }
    match (&a.prerelease, &b.prerelease) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(x), Some(y)) => match x.cmp(y) {
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
        },
    }
}

pub fn is_host_compatible(min_host_version: &str, host_version: &str) -> bool {
    if min_host_version.is_empty() {
        return true;
    }
    compare_plugin_versions(host_version, min_host_version) >= 0
}

// ———————————————————————————— 清单 ————————————————————————————

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Permissions {
    pub read: Vec<String>,
    pub write: Vec<String>,
    pub network: Vec<String>,
    pub library: Vec<String>,
    pub host: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SandboxedManifest {
    pub id: String,
    pub name: String,
    pub entry: String,
    pub permissions: Permissions,
    pub capabilities: Vec<String>,
    pub requires: Vec<String>,
    pub min_host_version: String,
    pub description: String,
}

const ALLOWED_MANIFEST_KEYS: [&str; 9] = [
    "id",
    "name",
    "version",
    "runtime",
    "description",
    "permissions",
    "capabilities",
    "minHostVersion",
    "requires",
];

fn normalize_relative_list(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.len() > MAX_RELATIVE_LIST {
        return None;
    }
    let mut result: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str()?;
        let length = utf16_len(text);
        if length == 0 || length > 80 {
            return None;
        }
        if text == "." {
            result.push(".".to_string());
            continue;
        }
        if text.contains('\\') || text.starts_with('/') || text.contains("..") {
            return None;
        }
        let segments: Vec<&str> = text.split('/').collect();
        if segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
        {
            return None;
        }
        result.push(segments.join("/"));
    }
    Some(result)
}

fn normalize_hosts(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.len() > MAX_HOSTS {
        return None;
    }
    let mut hosts: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str()?;
        if !matches_host_pattern(text) {
            return None;
        }
        if text == "localhost" || text.ends_with(".local") || text.ends_with(".localhost") {
            return None;
        }
        if !hosts.iter().any(|existing| existing == text) {
            hosts.push(text.to_string());
        }
    }
    Some(hosts)
}

fn parse_string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return None;
    };
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
    )
}

fn parse_permissions(value: Option<&Value>) -> Option<Permissions> {
    let Some(value) = value else {
        return Some(Permissions::default());
    };
    let map = value.as_object()?;
    for key in map.keys() {
        if !matches!(
            key.as_str(),
            "read" | "write" | "network" | "library" | "host"
        ) {
            return None;
        }
    }
    Some(Permissions {
        read: parse_string_list(map.get("read"))?,
        write: parse_string_list(map.get("write"))?,
        network: normalize_hosts(map.get("network"))?,
        library: normalize_library(map.get("library"))?,
        host: normalize_host_permissions(map.get("host"))?,
    })
}

fn normalize_library(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.len() > 1 {
        return None;
    }
    if items.is_empty() {
        return Some(Vec::new());
    }
    if items[0].as_str() != Some("rename") {
        return None;
    }
    Some(vec!["rename".to_string()])
}

fn normalize_host_permissions(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.is_empty() || items.len() > HOST_PERMISSIONS.len() {
        return None;
    }
    let mut result: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str()?;
        if !HOST_PERMISSIONS.contains(&text) {
            return None;
        }
        if !result.iter().any(|existing| existing == text) {
            result.push(text.to_string());
        }
    }
    Some(result)
}

fn normalize_dependencies(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.len() > MAX_REQUIRES {
        return None;
    }
    let mut result: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str()?;
        if !matches_dependency_pattern(text) || utf16_len(text) > MAX_SOURCE_NAME_CHARS {
            return None;
        }
        if !result.iter().any(|existing| existing == text) {
            result.push(text.to_string());
        }
    }
    Some(result)
}

/// `parseSandboxedManifest` — 未信任输入的闸门。`None` = 不是合法沙箱插件。
pub fn parse_sandboxed_manifest(raw: &str) -> Option<SandboxedManifest> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let map = value.as_object()?;
    if map
        .keys()
        .any(|key| !ALLOWED_MANIFEST_KEYS.contains(&key.as_str()))
    {
        return None;
    }
    let id = map.get("id")?.as_str()?;
    if !matches_id_pattern(id) {
        return None;
    }
    let name = map.get("name")?.as_str()?;
    if name.is_empty() || utf16_len(name) > MAX_SOURCE_NAME_CHARS {
        return None;
    }
    let runtime = map.get("runtime")?.as_object()?;
    if runtime
        .keys()
        .any(|key| key != "mode" && key != "entry")
    {
        return None;
    }
    if runtime.get("mode")?.as_str()? != "sandboxed" {
        return None;
    }
    let entry = match runtime.get("entry") {
        Some(value) => value.as_str()?.to_string(),
        None => "plugin.js".to_string(),
    };
    if !matches_entry_pattern(&entry) || RESERVED_ENTRY_NAMES.contains(&entry.as_str()) {
        return None;
    }
    let permissions = parse_permissions(map.get("permissions"))?;
    let min_host_version = match map.get("minHostVersion") {
        None => String::new(),
        Some(value) => {
            let text = value.as_str()?;
            if !matches_version_pattern(text) {
                return None;
            }
            text.to_string()
        }
    };
    let capabilities = match map.get("capabilities") {
        None => ["format", "commands", "panels", "assets"]
            .iter()
            .map(|name| name.to_string())
            .collect(),
        Some(value) => {
            let items = value.as_array()?;
            if items.is_empty() || items.len() > CAPABILITY_NAMES.len() {
                return None;
            }
            let mut result: Vec<String> = Vec::new();
            for item in items {
                let text = item.as_str()?;
                if !CAPABILITY_NAMES.contains(&text) {
                    return None;
                }
                if !result.iter().any(|existing| existing == text) {
                    result.push(text.to_string());
                }
            }
            result
        }
    };
    let requires = normalize_dependencies(map.get("requires"))?;
    let description = map
        .get("description")
        .and_then(|value| value.as_str())
        .map(|text| slice_chars(text, MAX_DESCRIPTION_CHARS))
        .unwrap_or_default();
    Some(SandboxedManifest {
        id: id.to_string(),
        name: name.to_string(),
        entry,
        permissions,
        capabilities,
        requires,
        min_host_version,
        description,
    })
}

/// `sandboxedPlugins.cjs::parseDeclarativeManifest` 的等价判定（只要 id/name 与合法性）。
fn declarative_manifest_id(raw: &str) -> Option<String> {
    let parsed = crate::declarative::parse_declarative_manifest(raw)?;
    Some(parsed.id)
}

#[derive(Debug, Clone)]
pub struct SandboxedPackage {
    pub id: String,
    pub name: String,
    pub entry: String,
    pub description: String,
    pub entry_path: PathBuf,
    pub dir: PathBuf,
    pub permissions: Permissions,
    pub capabilities: Vec<String>,
    pub requires: Vec<String>,
    pub min_host_version: String,
    pub host_compatible: bool,
    pub client_path: Option<PathBuf>,
}

impl SandboxedPackage {
    pub fn has_client(&self) -> bool {
        self.client_path.is_some()
    }

    /// `permissions.host` 里是否有某条 host 权限。
    pub fn grants(&self, permission: &str) -> bool {
        self.permissions
            .host
            .iter()
            .any(|existing| existing == permission)
    }
}

fn read_manifest(dir: &Path) -> Option<String> {
    let path = dir.join("manifest.json");
    let stat = fs::metadata(&path).ok()?;
    if !stat.is_file() || stat.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    String::from_utf8(bytes).ok()
}

/// `readdirSync(root, { withFileTypes: true })` 的目录项。
fn list_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    dirs
}

/// `listSandboxedPackages`
pub fn list_sandboxed_packages(root: &Path) -> Vec<SandboxedPackage> {
    let mut packages: Vec<SandboxedPackage> = Vec::new();
    for dir in list_dirs(root) {
        if packages.len() >= MAX_PACKAGES {
            break;
        }
        let Some(dir_name) = dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(raw) = read_manifest(&dir) else {
            continue;
        };
        let Some(parsed) = parse_sandboxed_manifest(&raw) else {
            continue;
        };
        if parsed.id != dir_name {
            continue;
        }
        let entry_path = dir.join(&parsed.entry);
        let Ok(stat) = fs::metadata(&entry_path) else {
            continue;
        };
        if !stat.is_file() || stat.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let client_path = dir.join("client.js");
        let has_client = fs::metadata(&client_path)
            .map(|stat| stat.is_file() && stat.len() <= MAX_CLIENT_BYTES)
            .unwrap_or(false);
        let host_compatible = is_host_compatible(&parsed.min_host_version, HOST_API_VERSION);
        packages.push(SandboxedPackage {
            id: parsed.id,
            name: parsed.name,
            entry: parsed.entry,
            description: parsed.description,
            entry_path,
            dir: dir.clone(),
            permissions: parsed.permissions,
            capabilities: parsed.capabilities,
            requires: parsed.requires,
            min_host_version: parsed.min_host_version,
            host_compatible,
            client_path: if has_client { Some(client_path) } else { None },
        });
    }
    packages
}

pub fn find_sandboxed_package(root: &Path, plugin_id: &str) -> Option<SandboxedPackage> {
    if plugin_id.is_empty() || utf16_len(plugin_id) > 120 {
        return None;
    }
    list_sandboxed_packages(root)
        .into_iter()
        .find(|package| package.id == plugin_id)
}

/// `permissionLabels`
pub fn permission_labels(permissions: &Permissions) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    if permissions.library.iter().any(|entry| entry == "rename") {
        labels.push("library:rename".to_string());
    }
    if !permissions.read.is_empty() {
        labels.push("read".to_string());
    }
    if !permissions.write.is_empty() {
        labels.push("write".to_string());
    }
    if !permissions.network.is_empty() {
        labels.push("network".to_string());
    }
    for entry in &permissions.host {
        labels.push(entry.clone());
    }
    labels
}

/// `installPluginDirectory` 的结果。
#[derive(Debug, Clone)]
pub struct InstallOutcome {
    pub id: String,
    pub mode: String,
}

fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path)
}

/// `installPluginDirectory(sourceDir, destRoot)`
pub fn install_plugin_directory(source_dir: &Path, dest_root: &Path) -> SandboxResult<InstallOutcome> {
    let Some(raw) = read_manifest(source_dir) else {
        return Err(SandboxError::new("manifest.json is missing or too large"));
    };
    let sandboxed = parse_sandboxed_manifest(&raw);
    let declarative_id = if sandboxed.is_none() {
        declarative_manifest_id(&raw)
    } else {
        None
    };
    if sandboxed.is_none() && declarative_id.is_none() {
        return Err(SandboxError::new("manifest was rejected"));
    }
    let plugin_id = sandboxed
        .as_ref()
        .map(|parsed| parsed.id.clone())
        .or(declarative_id)
        .unwrap_or_default();
    if !matches_id_pattern(&plugin_id) {
        return Err(SandboxError::new(
            "external plugin id must start with local.",
        ));
    }

    let mut entry_source: Option<String> = None;
    let mut client_source: Option<String> = None;
    if let Some(parsed) = &sandboxed {
        let entry_path = source_dir.join(&parsed.entry);
        let bytes = fs::read(&entry_path)
            .map_err(|_| SandboxError::new(format!("{} is missing", parsed.entry)))?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            return Err(SandboxError::new(format!("{} is too large", parsed.entry)));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if has_denied_source(&text) {
            return Err(SandboxError::new(format!(
                "{} uses an API the sandbox does not allow",
                parsed.entry
            )));
        }
        entry_source = Some(text);

        let client_path = source_dir.join("client.js");
        if client_path.exists() {
            let bytes = fs::read(&client_path)
                .map_err(|_| SandboxError::new("client.js could not be read"))?;
            if bytes.len() as u64 > MAX_CLIENT_BYTES {
                return Err(SandboxError::new("client.js is too large"));
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if has_denied_source(&text) {
                return Err(SandboxError::new(
                    "client.js uses an API the sandbox does not allow",
                ));
            }
            client_source = Some(text);
        }
    }

    let dest = safe_join(dest_root, &plugin_id)
        .ok_or_else(|| SandboxError::new("plugin path was rejected"))?;
    let resolved_root = fs::canonicalize(dest_root).unwrap_or_else(|_| dest_root.to_path_buf());
    if dest.parent() != Some(resolved_root.as_path()) && dest.parent() != Some(dest_root) {
        return Err(SandboxError::new("plugin path was rejected"));
    }
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest).map_err(|_| SandboxError::new("plugin path was rejected"))?;

    fs::write(dest.join("manifest.json"), raw.as_bytes())
        .map_err(|error| SandboxError::new(error.to_string()))?;
    if let Some(entry) = &entry_source {
        let parsed = sandboxed.as_ref().expect("sandboxed manifest");
        fs::write(dest.join(&parsed.entry), entry.as_bytes())
            .map_err(|error| SandboxError::new(error.to_string()))?;
    }
    if let Some(client) = &client_source {
        fs::write(dest.join("client.js"), client.as_bytes())
            .map_err(|error| SandboxError::new(error.to_string()))?;
    }
    if sandboxed.is_none() {
        copy_declarative_locales(&raw, source_dir, &dest)?;
    }
    Ok(InstallOutcome {
        id: plugin_id,
        mode: if sandboxed.is_some() {
            "sandboxed".to_string()
        } else {
            "declarative".to_string()
        },
    })
}

/// 声明式插件的 `locales[]` 分片复制（`installPluginDirectory` 的 declarative 分支）。
fn copy_declarative_locales(raw: &str, source_dir: &Path, dest: &Path) -> SandboxResult<()> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Ok(());
    };
    let Some(items) = value.get("locales").and_then(|value| value.as_array()) else {
        return Ok(());
    };
    for item in items {
        let Some(file) = item.get("file").and_then(|value| value.as_str()) else {
            continue;
        };
        if file.is_empty() {
            continue;
        }
        let Some(target) = safe_join(dest, file) else {
            return Err(SandboxError::new("locale shard path was rejected"));
        };
        let Some(source) = safe_join(source_dir, file) else {
            return Err(SandboxError::new("locale shard path was rejected"));
        };
        let Ok(stat) = fs::metadata(&source) else {
            return Err(SandboxError::new(format!("locale shard is missing: {file}")));
        };
        if !stat.is_file() || stat.len() > MAX_LOCALE_SHARD_BYTES {
            return Err(SandboxError::new(format!(
                "locale shard is unreadable or too large: {file}"
            )));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| SandboxError::new(error.to_string()))?;
        }
        fs::copy(&source, &target).map_err(|error| SandboxError::new(error.to_string()))?;
    }
    Ok(())
}

/// `uninstallPlugin(destRoot, id)`
pub fn uninstall_plugin(dest_root: &Path, plugin_id: &str) -> SandboxResult<()> {
    if !matches_id_pattern(plugin_id) {
        return Err(SandboxError::new("plugin id was rejected"));
    }
    let dest = dest_root.join(plugin_id);
    let resolved_root = fs::canonicalize(dest_root).unwrap_or_else(|_| dest_root.to_path_buf());
    let resolved_dest = fs::canonicalize(&dest).unwrap_or_else(|_| dest.clone());
    if !resolved_dest.starts_with(&resolved_root) || resolved_dest == resolved_root {
        return Err(SandboxError::new("plugin path was rejected"));
    }
    fs::remove_dir_all(&dest).map_err(|error| SandboxError::new(error.to_string()))
}

/// `resolvePluginPath` — 相对路径 + 允许的根，两者都验。
pub fn resolve_plugin_path(plugin_dir: &Path, relative: &str, roots: &[String]) -> Option<PathBuf> {
    if relative.is_empty() || utf16_len(relative) > 180 {
        return None;
    }
    if relative.contains('\\') || relative.starts_with('/') {
        return None;
    }
    let bytes = relative.as_bytes();
    if bytes.len() > 1 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let segments: Vec<&str> = relative.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return None;
    }
    // 上游用 `path.resolve(pluginDir)` 做根，再 `target.startsWith(root + sep)`；
    // 这里两层都先 canonicalize（相对路径也能算对），比较用组件级 `starts_with`。
    let plugin_root =
        fs::canonicalize(plugin_dir).unwrap_or_else(|_| plugin_dir.to_path_buf());
    let mut target = plugin_root.clone();
    for segment in &segments {
        target.push(segment);
    }
    if !target.starts_with(&plugin_root) || target == plugin_root {
        return None;
    }
    for root in roots {
        let base = if root == "." {
            plugin_root.clone()
        } else {
            let mut base = plugin_root.clone();
            for segment in root.split('/') {
                base.push(segment);
            }
            base
        };
        if target.starts_with(&base) {
            return Some(target);
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct PluginInspection {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<String>,
    pub needs_trust_confirmation: bool,
    pub permissions: Vec<String>,
    pub min_host_version: String,
    pub host_compatible: bool,
}

/// `inspectPluginDirectory`
pub fn inspect_plugin_directory(source_dir: &Path) -> SandboxResult<PluginInspection> {
    let Some(raw) = read_manifest(source_dir) else {
        return Err(SandboxError::new("manifest.json is missing or too large"));
    };
    let Some(parsed) = parse_sandboxed_manifest(&raw) else {
        return Err(SandboxError::new("manifest was rejected"));
    };
    let client_path = source_dir.join("client.js");
    let has_client = fs::metadata(&client_path)
        .map(|stat| stat.is_file() && stat.len() <= MAX_CLIENT_BYTES)
        .unwrap_or(false);
    Ok(PluginInspection {
        needs_trust_confirmation: has_client
            || parsed.capabilities.iter().any(|name| name == "components")
            || !parsed.permissions.host.is_empty(),
        id: parsed.id,
        name: parsed.name,
        capabilities: parsed.capabilities,
        permissions: permission_labels(&parsed.permissions),
        min_host_version: parsed.min_host_version.clone(),
        host_compatible: is_host_compatible(&parsed.min_host_version, HOST_API_VERSION),
    })
}

// ———————————————————————————— ZIP（插件包解包） ————————————————————————————

#[derive(Debug, Clone)]
struct ZipEntry {
    name: String,
    flags: u16,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
    local_header_offset: usize,
}

fn u16_at(buffer: &[u8], offset: usize) -> SandboxResult<u16> {
    buffer
        .get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))
}

fn u32_at(buffer: &[u8], offset: usize) -> SandboxResult<u32> {
    buffer
        .get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))
}

fn find_eocd(tail: &[u8]) -> SandboxResult<(usize, usize)> {
    const SIGNATURE: u32 = 0x0605_4b50;
    if tail.len() < 22 {
        return Err(SandboxError::new("plugin archive is corrupted"));
    }
    let mut index = tail.len() - 22;
    loop {
        if u32_at(tail, index)? == SIGNATURE {
            let comment_length = u16_at(tail, index + 20)? as usize;
            if index + 22 + comment_length == tail.len() {
                let cd_size = u32_at(tail, index + 12)? as usize;
                let cd_offset = u32_at(tail, index + 16)? as usize;
                if cd_offset == 0xffff_ffff || cd_size == 0xffff_ffff {
                    return Err(SandboxError::new("plugin archive is corrupted"));
                }
                return Ok((cd_offset, cd_size));
            }
        }
        if index == 0 {
            break;
        }
        index -= 1;
    }
    Err(SandboxError::new("plugin archive is corrupted"))
}

fn parse_central_directory(cd: &[u8]) -> SandboxResult<Vec<ZipEntry>> {
    const SIGNATURE: u32 = 0x0201_4b50;
    let mut entries: Vec<ZipEntry> = Vec::new();
    let mut cursor = 0usize;
    while cursor + 46 <= cd.len() {
        if u32_at(cd, cursor)? != SIGNATURE {
            break;
        }
        let flags = u16_at(cd, cursor + 8)?;
        let method = u16_at(cd, cursor + 10)?;
        let compressed_size = u32_at(cd, cursor + 20)? as usize;
        let uncompressed_size = u32_at(cd, cursor + 24)? as usize;
        let name_length = u16_at(cd, cursor + 28)? as usize;
        let extra_length = u16_at(cd, cursor + 30)? as usize;
        let comment_length = u16_at(cd, cursor + 32)? as usize;
        let local_header_offset = u32_at(cd, cursor + 42)? as usize;
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
        let name_bytes = cd
            .get(name_start..name_end)
            .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(name_bytes).into_owned(),
            flags,
            method,
            compressed_size,
            uncompressed_size,
            local_header_offset,
        });
        cursor = name_end + extra_length + comment_length;
    }
    Ok(entries)
}

fn zip_entries(archive: &[u8]) -> SandboxResult<Vec<ZipEntry>> {
    if archive.len() > MAX_PLUGIN_ARCHIVE_BYTES as usize {
        return Err(SandboxError::new("plugin archive is too large"));
    }
    let tail_start = archive.len().saturating_sub(EOCD_SCAN_BYTES);
    let (cd_offset, cd_size) = find_eocd(&archive[tail_start..])?;
    let cd_end = cd_offset
        .checked_add(cd_size)
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
    let cd = archive
        .get(cd_offset..cd_end)
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
    parse_central_directory(cd)
}

fn inflate_entry(archive: &[u8], entry: &ZipEntry) -> SandboxResult<Vec<u8>> {
    if entry.flags & 0x1 != 0 {
        return Err(SandboxError::new(
            "encrypted plugin archives are not supported",
        ));
    }
    if entry.uncompressed_size > MAX_PLUGIN_ENTRY_BYTES {
        return Err(SandboxError::new(format!(
            "plugin file is too large: {}",
            entry.name
        )));
    }
    const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
    let header = archive
        .get(entry.local_header_offset..entry.local_header_offset + 30)
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
    if u32_at(header, 0)? != LOCAL_SIGNATURE {
        return Err(SandboxError::new("plugin archive is corrupted"));
    }
    let name_length = u16_at(header, 26)? as usize;
    let extra_length = u16_at(header, 28)? as usize;
    let data_offset = entry.local_header_offset + 30 + name_length + extra_length;
    let data_end = data_offset
        .checked_add(entry.compressed_size)
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
    let compressed = archive
        .get(data_offset..data_end)
        .ok_or_else(|| SandboxError::new("plugin archive is corrupted"))?;
    match entry.method {
        0 => {
            if compressed.len() < entry.uncompressed_size {
                return Err(SandboxError::new("plugin archive is corrupted"));
            }
            Ok(compressed[..entry.uncompressed_size].to_vec())
        }
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(compressed);
            let mut bytes = Vec::with_capacity(entry.uncompressed_size);
            decoder
                .read_to_end(&mut bytes)
                .map_err(|_| SandboxError::new("plugin archive is corrupted"))?;
            if bytes.len() != entry.uncompressed_size {
                return Err(SandboxError::new("plugin archive is corrupted"));
            }
            Ok(bytes)
        }
        _ => Err(SandboxError::new(
            "plugin archive uses an unsupported compression method",
        )),
    }
}

fn is_noise_entry(name: &str) -> bool {
    name.starts_with("__MACOSX/") || name.split('/').any(|part| part == ".DS_Store")
}

fn normalize_entry_path(name: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for segment in name.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

/// `extractPluginZip(zipPath, destDir)`
pub fn extract_plugin_zip(zip_path: &Path, dest_dir: &Path) -> SandboxResult<()> {
    let stat =
        fs::metadata(zip_path).map_err(|_| SandboxError::new("plugin archive is not accessible"))?;
    if !stat.is_file() {
        return Err(SandboxError::new("plugin archive is not a file"));
    }
    if stat.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(SandboxError::new("plugin archive is too large"));
    }
    let archive =
        fs::read(zip_path).map_err(|_| SandboxError::new("plugin archive is not accessible"))?;
    let entries = zip_entries(&archive)?;
    if entries.is_empty() {
        return Err(SandboxError::new("plugin archive is empty"));
    }
    if entries.len() > MAX_PLUGIN_ENTRIES {
        return Err(SandboxError::new("plugin archive has too many entries"));
    }
    let mut manifest_found = false;
    for entry in &entries {
        if is_noise_entry(&entry.name) {
            continue;
        }
        let Some(_) = normalize_entry_path(&entry.name) else {
            return Err(SandboxError::new(
                "plugin archive contains an unsafe path",
            ));
        };
        if entry.flags & 0x1 != 0 {
            return Err(SandboxError::new(
                "encrypted plugin archives are not supported",
            ));
        }
        if entry.method != 0 && entry.method != 8 {
            return Err(SandboxError::new(
                "plugin archive uses an unsupported compression method",
            ));
        }
        if entry.uncompressed_size > MAX_PLUGIN_ENTRY_BYTES {
            return Err(SandboxError::new(format!(
                "plugin file is too large: {}",
                entry.name
            )));
        }
        let base = entry.name.rsplit('/').next().unwrap_or("");
        if base == "manifest.json" && entry.name.split('/').count() <= 2 {
            manifest_found = true;
        }
    }
    if !manifest_found {
        return Err(SandboxError::new(
            "archive does not contain an Artflow plugin (manifest.json not found)",
        ));
    }

    fs::create_dir_all(dest_dir).map_err(|error| SandboxError::new(error.to_string()))?;
    for entry in &entries {
        if is_noise_entry(&entry.name) {
            continue;
        }
        let Some(relative) = normalize_entry_path(&entry.name) else {
            return Err(SandboxError::new(
                "plugin archive contains an unsafe path",
            ));
        };
        let target = dest_dir.join(&relative);
        if !target.starts_with(dest_dir) {
            return Err(SandboxError::new(
                "plugin archive contains an unsafe path",
            ));
        }
        if entry.name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|error| SandboxError::new(error.to_string()))?;
            continue;
        }
        let bytes = inflate_entry(&archive, entry)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| SandboxError::new(error.to_string()))?;
        }
        fs::write(&target, bytes).map_err(|error| SandboxError::new(error.to_string()))?;
    }
    Ok(())
}

/// `resolvePluginSourceDir`
pub fn resolve_plugin_source_dir(extracted: &Path) -> Option<PathBuf> {
    if extracted.join("manifest.json").exists() {
        return Some(extracted.to_path_buf());
    }
    let dirs = list_dirs(extracted);
    if dirs.len() == 1 && dirs[0].join("manifest.json").exists() {
        return Some(dirs[0].clone());
    }
    None
}

/// `isPluginSourcePath` — 失败一律 false，不抛。
pub fn is_plugin_source_path(source_path: &str) -> bool {
    if source_path.is_empty() || utf16_len(source_path) > 4000 {
        return false;
    }
    let Ok(stat) = fs::metadata(source_path) else {
        return false;
    };
    if stat.is_file() {
        if !source_path.to_ascii_lowercase().ends_with(".zip") {
            return false;
        }
        let Ok(archive) = fs::read(source_path) else {
            return false;
        };
        if archive.len() as u64 > MAX_PLUGIN_ARCHIVE_BYTES {
            return false;
        }
        let Ok(entries) = zip_entries(&archive) else {
            return false;
        };
        return entries.iter().any(|entry| {
            let segments = entry.name.split('/').count();
            segments <= 2 && entry.name.rsplit('/').next() == Some("manifest.json")
        });
    }
    if stat.is_dir() {
        let path = Path::new(source_path);
        if path.join("manifest.json").exists() {
            return true;
        }
        let dirs = list_dirs(path);
        return dirs.len() == 1 && dirs[0].join("manifest.json").exists();
    }
    false
}

// ———————————————————————————— 宿主事件表（hostEvents.cjs） ————————————————————————————

pub type HostEmitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// `pluginId -> subscriptionId -> event names`，外加宿主侧投递函数。
#[derive(Default)]
pub struct HostEventBus {
    table: Mutex<HashMap<String, BTreeMap<String, Vec<String>>>>,
    emitter: Mutex<Option<HostEmitter>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeOutcome {
    pub subscription_id: String,
    pub events: Vec<String>,
    pub active: usize,
}

impl HostEventBus {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, BTreeMap<String, Vec<String>>>> {
        self.table.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn set_emitter(&self, next: Option<HostEmitter>) {
        *self.emitter.lock().unwrap_or_else(|error| error.into_inner()) = next;
    }

    pub fn clear_emitter(&self) {
        self.set_emitter(None);
    }

    /// 宿主代际更替：订阅表与投递函数一起失效。
    pub fn reset_for_new_host(&self) -> usize {
        let count = self.reset();
        self.clear_emitter();
        count
    }

    pub fn reset(&self) -> usize {
        let mut table = self.lock();
        let count: usize = table.values().map(|owned| owned.len()).sum();
        table.clear();
        count
    }

    pub fn subscription_count(&self) -> usize {
        self.lock().values().map(|owned| owned.len()).sum()
    }

    pub fn subscribe(
        &self,
        plugin_id: &str,
        subscription_id: &str,
        names: &Value,
    ) -> SandboxResult<SubscribeOutcome> {
        if plugin_id.is_empty() {
            return Err(SandboxError::new("plugin is not installed"));
        }
        if subscription_id.is_empty()
            || utf16_len(subscription_id) > MAX_SUBSCRIPTION_ID
            || !matches_subscription_id(subscription_id)
        {
            return Err(SandboxError::new("subscription id is invalid"));
        }
        let normalized = normalize_event_names(names).ok_or_else(|| {
            SandboxError::new(format!(
                "event names must be 1 to {MAX_NAMES_PER_SUBSCRIPTION} of: {}",
                EVENT_NAMES.join(", ")
            ))
        })?;
        let mut table = self.lock();
        let owned = table.entry(plugin_id.to_string()).or_default();
        if !owned.contains_key(subscription_id) && owned.len() >= MAX_SUBSCRIPTIONS_PER_PLUGIN {
            return Err(SandboxError::new(format!(
                "a plugin may hold at most {MAX_SUBSCRIPTIONS_PER_PLUGIN} subscriptions"
            )));
        }
        owned.insert(subscription_id.to_string(), normalized.clone());
        Ok(SubscribeOutcome {
            subscription_id: subscription_id.to_string(),
            events: normalized,
            active: owned.len(),
        })
    }

    /// 返回是否确实存在。
    pub fn unsubscribe(&self, plugin_id: &str, subscription_id: &str) -> SandboxResult<bool> {
        if subscription_id.is_empty() || utf16_len(subscription_id) > MAX_SUBSCRIPTION_ID {
            return Err(SandboxError::new("subscription id is invalid"));
        }
        let mut table = self.lock();
        let Some(owned) = table.get_mut(plugin_id) else {
            return Ok(false);
        };
        if owned.remove(subscription_id).is_none() {
            return Ok(false);
        }
        if owned.is_empty() {
            table.remove(plugin_id);
        }
        Ok(true)
    }

    pub fn remove_plugin(&self, plugin_id: &str) -> bool {
        self.lock().remove(plugin_id).is_some()
    }

    pub fn list_event_names(&self) -> Vec<String> {
        EVENT_NAMES.iter().map(|name| name.to_string()).collect()
    }

    pub fn describe(&self) -> Vec<Value> {
        let table = self.lock();
        let mut rows: Vec<Value> = Vec::new();
        for (plugin_id, owned) in table.iter() {
            for (subscription_id, names) in owned.iter() {
                rows.push(json!({
                    "pluginId": plugin_id,
                    "subscriptionId": subscription_id,
                    "events": names,
                }));
            }
        }
        rows
    }

    /// 宿主侧广播：返回投递份数。
    pub fn emit(&self, name: &str, payload: &Value) -> usize {
        if !EVENT_NAMES.contains(&name) {
            return 0;
        }
        if self.subscription_count() == 0 {
            return 0;
        }
        let Some(sanitized) = sanitize_payload(name, payload) else {
            return 0;
        };
        let Ok(encoded) = serde_json::to_string(&sanitized) else {
            return 0;
        };
        if encoded.len() > MAX_PAYLOAD_BYTES {
            return 0;
        }
        let emitter = self
            .emitter
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let Some(emitter) = emitter else {
            return 0;
        };
        let mut delivered = 0usize;
        let table = self.lock();
        for (plugin_id, owned) in table.iter() {
            for (subscription_id, names) in owned.iter() {
                if !names.iter().any(|entry| entry == name) {
                    continue;
                }
                delivered += 1;
                emitter(
                    plugin_id,
                    json!({
                        "subscriptionId": subscription_id,
                        "name": name,
                        "payload": sanitized,
                    }),
                );
            }
        }
        delivered
    }
}

fn matches_subscription_id(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'#' | b'-')
        })
}

fn normalize_event_names(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    if items.is_empty() || items.len() > MAX_NAMES_PER_SUBSCRIPTION {
        return None;
    }
    let mut names: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str()?;
        if !EVENT_NAMES.contains(&text) {
            return None;
        }
        if !names.iter().any(|existing| existing == text) {
            names.push(text.to_string());
        }
    }
    Some(names)
}

/// 逐字段重建，绝不转发内部行。
pub fn sanitize_payload(name: &str, payload: &Value) -> Option<Value> {
    let source = payload.as_object();
    let asset_source = source.and_then(|map| map.get("asset"));
    let asset = sanitize_asset_ref(asset_source)?;
    let mut event = Map::new();
    event.insert("type".to_string(), json!(name));
    event.insert("asset".to_string(), asset);
    let at = source
        .and_then(|map| map.get("at"))
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
        .unwrap_or_else(|| now_millis() as f64);
    event.insert("at".to_string(), json!(at));
    if name == "asset.renamed" {
        if let Some(previous) = source
            .and_then(|map| map.get("previousName"))
            .and_then(|value| value.as_str())
        {
            event.insert(
                "previousName".to_string(),
                json!(slice_chars(previous, MAX_NAME_CHARS)),
            );
        }
    }
    if name == "asset.removed" {
        if let Some(freed) = source
            .and_then(|map| map.get("freedBytes"))
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite())
        {
            event.insert("freedBytes".to_string(), json!(freed));
        }
    }
    Some(Value::Object(event))
}

fn sanitize_asset_ref(value: Option<&Value>) -> Option<Value> {
    let map = value?.as_object()?;
    let id = map.get("id").and_then(|value| value.as_str())?;
    if id.is_empty() || utf16_len(id) > MAX_ASSET_ID {
        return None;
    }
    let mut reference = Map::new();
    reference.insert("id".to_string(), json!(id));
    for (key, limit) in [("name", MAX_NAME_CHARS), ("kind", MAX_KIND_CHARS), ("mimeType", MAX_MIME_CHARS)] {
        if let Some(text) = map.get(key).and_then(|value| value.as_str()) {
            reference.insert(key.to_string(), json!(slice_chars(text, limit)));
        }
    }
    if let Some(size) = map
        .get("byteSize")
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
    {
        reference.insert("byteSize".to_string(), json!(size));
    }
    Some(Value::Object(reference))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ———————————————————————————— 内容寻址数据仓（pluginStoreController.cjs） ————————————————————————————

pub struct PluginStore {
    dir: PathBuf,
    max_stored_bytes: u64,
}

fn is_store_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl PluginStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            max_stored_bytes: MAX_STORED_BYTES,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 双层锚定：pluginId 子目录 + ref 文件名，两个正则都过才拼路径。
    pub fn plugin_path(&self, plugin_id: &str, reference: &str) -> SandboxResult<PathBuf> {
        if !matches_id_pattern(plugin_id) {
            return Err(SandboxError::new("plugin id was rejected"));
        }
        if !is_store_ref(reference) {
            return Err(SandboxError::new("stored data reference was rejected"));
        }
        Ok(self.dir.join(plugin_id).join(format!("{reference}.bin")))
    }

    /// 内容寻址落盘：同字节去重，`create_new` 失败视为已存在。
    pub fn store(&self, plugin_id: &str, bytes: &[u8]) -> SandboxResult<(String, usize)> {
        if !matches_id_pattern(plugin_id) {
            return Err(SandboxError::new("plugin id was rejected"));
        }
        if bytes.is_empty() {
            return Err(SandboxError::new("stored bytes are empty"));
        }
        if bytes.len() as u64 > self.max_stored_bytes {
            return Err(SandboxError::new(format!(
                "stored bytes are limited to {} MiB.",
                self.max_stored_bytes / 1024 / 1024
            )));
        }
        let reference = sha256_hex(bytes);
        let target = self.plugin_path(plugin_id, &reference)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| SandboxError::new(error.to_string()))?;
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|error| SandboxError::new(error.to_string()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(SandboxError::new(error.to_string())),
        }
        Ok((reference, bytes.len()))
    }

    pub fn read(&self, plugin_id: &str, reference: &str) -> SandboxResult<Vec<u8>> {
        let target = self.plugin_path(plugin_id, reference)?;
        let stat = fs::metadata(&target)
            .map_err(|_| SandboxError::new("stored data is missing"))?;
        if !stat.is_file() || stat.len() > self.max_stored_bytes {
            return Err(SandboxError::new("stored data is missing or too large"));
        }
        fs::read(&target).map_err(|_| SandboxError::new("stored data is missing"))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ———————————————————————————— 插件 data.json（pluginData.cjs） ————————————————————————————

pub fn plugin_data_path(plugin_dir: &Path) -> PathBuf {
    plugin_dir.join(DATA_FILE_NAME)
}

pub fn load_plugin_data(plugin_dir: &Path) -> SandboxResult<Option<Value>> {
    let target = plugin_data_path(plugin_dir);
    let text = match fs::read_to_string(&target) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(SandboxError::new(format!(
                "plugin data could not be read: {error}"
            )))
        }
    };
    serde_json::from_str(&text).map(Some).map_err(|_| {
        SandboxError::new(
            "plugin data.json is corrupted (not valid JSON); fix or delete it before saving again",
        )
    })
}

pub fn save_plugin_data(plugin_dir: &Path, data: &Value) -> SandboxResult<usize> {
    let encoded = serde_json::to_string(data)
        .map_err(|_| SandboxError::new("plugin data must be JSON serializable"))?;
    if encoded.len() > MAX_PLUGIN_DATA_BYTES {
        return Err(SandboxError::new(format!(
            "plugin data exceeds the {MAX_PLUGIN_DATA_BYTES} byte limit"
        )));
    }
    let target = plugin_data_path(plugin_dir);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| SandboxError::new(error.to_string()))?;
    }
    let temp = target.with_extension("json.tmp");
    fs::write(&temp, encoded.as_bytes()).map_err(|error| SandboxError::new(error.to_string()))?;
    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(SandboxError::new(format!(
            "plugin data could not be written: {error}"
        )));
    }
    Ok(encoded.len())
}

// ———————————————————————————— 宿主能力面（hostFacade.cjs） ————————————————————————————

/// 资产库在 Tauri 侧尚未接线（`project.rs` 仍是占位模块）。缺失时三条 `assets.*`
/// 一律返回上游的 "asset storage is unavailable"，不伪造空列表。
pub trait AssetStorage: Send + Sync {
    fn list_asset_inventory(
        &self,
        offset: usize,
        limit: usize,
        unreferenced_only: bool,
    ) -> SandboxResult<Vec<Value>>;

    fn rename_asset_names(&self, changes: &[(String, String)]) -> SandboxResult<(Vec<String>, Vec<String>)>;
}

pub struct HostServices {
    pub store: Option<Arc<PluginStore>>,
    pub storage: Option<Arc<dyn AssetStorage>>,
}

impl Default for HostServices {
    fn default() -> Self {
        Self {
            store: None,
            storage: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct OpOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl OpOutcome {
    fn ok(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            message: None,
        }
    }

    fn error(message: impl ToString) -> Self {
        Self {
            ok: false,
            result: None,
            message: Some(message.to_string()),
        }
    }
}

fn clamp_integer(value: Option<&Value>, fallback: usize, min: usize, max: usize) -> usize {
    let Some(number) = value.and_then(|value| value.as_f64()) else {
        return fallback;
    };
    if !number.is_finite() {
        return fallback;
    }
    (number as i64).clamp(min as i64, max as i64) as usize
}

fn to_asset_ref(item: &Value) -> Value {
    let text = |key: &str| -> String {
        item.get(key)
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    };
    let number = |key: &str| -> f64 {
        item.get(key)
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
    };
    json!({
        "id": item.get("id").map(|value| value.to_string().trim_matches('"').to_string()).unwrap_or_default(),
        "name": item.get("originalName").and_then(|value| value.as_str()).unwrap_or(""),
        "kind": text("kind"),
        "mimeType": text("mimeType"),
        "byteSize": number("byteSize"),
        "updatedAt": number("updatedAt"),
        "usage": item.get("usage").and_then(|value| value.as_str()).unwrap_or("none"),
    })
}

fn scan_inventory(
    storage: &dyn AssetStorage,
    offset: usize,
    limit: usize,
    unreferenced_only: bool,
) -> SandboxResult<Vec<Value>> {
    let mut items: Vec<Value> = Vec::new();
    let mut cursor = 0usize;
    while cursor < MAX_LIST_SCAN {
        let batch = storage.list_asset_inventory(cursor, MAX_LIST_BATCH, unreferenced_only)?;
        let received = batch.len();
        items.extend(batch);
        if received < MAX_LIST_BATCH || items.len() >= MAX_LIST_SCAN {
            break;
        }
        cursor += MAX_LIST_BATCH;
    }
    let end = offset.saturating_add(limit).min(items.len());
    if offset >= items.len() {
        return Ok(Vec::new());
    }
    Ok(items[offset..end].to_vec())
}

fn normalize_args(value: Option<&Value>) -> SandboxResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        return Err(SandboxError::new("host arguments must be an array"));
    };
    if items.len() > MAX_ARG_COUNT {
        return Err(SandboxError::new(format!(
            "host calls take at most {MAX_ARG_COUNT} arguments"
        )));
    }
    let encoded = serde_json::to_string(items)
        .map_err(|_| SandboxError::new("host arguments must be plain data"))?;
    if encoded.len() > MAX_HOST_REQUEST_BYTES {
        return Err(SandboxError::new("host arguments are too large"));
    }
    Ok(items.clone())
}

struct HostMethod {
    permission: &'static str,
    arity: usize,
}

fn host_method(namespace: &str, method: &str) -> Option<HostMethod> {
    let spec = match (namespace, method) {
        ("assets", "list") => HostMethod {
            permission: "assets.read",
            arity: 1,
        },
        ("assets", "get") => HostMethod {
            permission: "assets.read",
            arity: 1,
        },
        ("assets", "rename") => HostMethod {
            permission: "assets.write",
            arity: 1,
        },
        ("events", "list") => HostMethod {
            permission: "events.subscribe",
            arity: 0,
        },
        ("events", "subscribe") => HostMethod {
            permission: "events.subscribe",
            arity: 1,
        },
        ("events", "unsubscribe") => HostMethod {
            permission: "events.subscribe",
            arity: 1,
        },
        _ => return None,
    };
    Some(spec)
}

pub fn perform_host_call(
    package: &SandboxedPackage,
    services: &HostServices,
    request: &Value,
    events: &HostEventBus,
) -> OpOutcome {
    let Some(map) = request.as_object() else {
        return OpOutcome::error("host request is invalid");
    };
    let namespace = map.get("namespace").and_then(|value| value.as_str()).unwrap_or("");
    let method = map.get("method").and_then(|value| value.as_str()).unwrap_or("");
    let Some(spec) = host_method(namespace, method) else {
        if HOST_PENDING_NAMESPACES.contains(&namespace) {
            return OpOutcome::error(format!(
                "host namespace \"{namespace}\" is not available yet"
            ));
        }
        if host_method(namespace, "").is_none() && !namespace_known(namespace) {
            return OpOutcome::error(format!("unknown host namespace: {namespace}"));
        }
        if namespace_known(namespace) {
            return OpOutcome::error(format!("unknown host method: {namespace}.{method}"));
        }
        return OpOutcome::error(format!("unknown host namespace: {namespace}"));
    };
    if !package.grants(spec.permission) {
        return OpOutcome::error(format!(
            "permission denied: {} must be declared in manifest permissions.host",
            spec.permission
        ));
    }
    let args = match normalize_args(map.get("args")) {
        Ok(args) => args,
        Err(error) => return OpOutcome::error(error.message()),
    };
    if args.len() > spec.arity {
        return OpOutcome::error(format!(
            "host method {namespace}.{method} takes at most {} argument(s)",
            spec.arity
        ));
    }
    let outcome = match (namespace, method) {
        ("assets", "list") => {
            let raw = args.first().and_then(|value| value.as_object());
            let offset = clamp_integer(raw.and_then(|map| map.get("offset")), 0, 0, MAX_LIST_SCAN);
            let limit = clamp_integer(
                raw.and_then(|map| map.get("limit")),
                50,
                1,
                MAX_LIST_LIMIT,
            );
            let unreferenced_only = raw
                .and_then(|map| map.get("unreferencedOnly"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            match services.storage.as_deref() {
                None => Err(SandboxError::new("asset storage is unavailable")),
                Some(storage) => scan_inventory(storage, offset, limit, unreferenced_only)
                    .map(|items| json!({ "assets": items.iter().map(to_asset_ref).collect::<Vec<_>>() })),
            }
        }
        ("assets", "get") => {
            let id = args
                .first()
                .and_then(|value| value.get("id"))
                .or_else(|| args.first())
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if id.is_empty() || utf16_len(id) > MAX_ASSET_ID {
                Err(SandboxError::new("asset id is invalid"))
            } else {
                match services.storage.as_deref() {
                    None => Err(SandboxError::new("asset storage is unavailable")),
                    Some(storage) => scan_inventory(storage, 0, MAX_LIST_SCAN, false).map(|items| {
                        let found = items.iter().find(|item| {
                            item.get("id")
                                .and_then(|value| value.as_str())
                                .map(|value| value == id)
                                .unwrap_or(false)
                        });
                        json!({ "asset": found.map(to_asset_ref) })
                    }),
                }
            }
        }
        ("assets", "rename") => {
            let changes = args
                .first()
                .and_then(|value| value.as_object())
                .and_then(|map| map.get("changes"));
            let Some(items) = changes.and_then(|value| value.as_array()) else {
                return OpOutcome::error(format!(
                    "rename requires 1 to {MAX_RENAME_ITEMS} assets"
                ));
            };
            if items.is_empty() || items.len() > MAX_RENAME_ITEMS {
                return OpOutcome::error(format!(
                    "rename requires 1 to {MAX_RENAME_ITEMS} assets"
                ));
            }
            let mut pairs: Vec<(String, String)> = Vec::new();
            for item in items {
                let Some(entry) = item.as_object() else {
                    return OpOutcome::error("rename entries must be objects");
                };
                let id = entry.get("id").and_then(|value| value.as_str()).unwrap_or("");
                if id.is_empty() || utf16_len(id) > MAX_ASSET_ID {
                    return OpOutcome::error("asset id is invalid");
                }
                let name = entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() || utf16_len(&name) > MAX_ASSET_NAME {
                    return OpOutcome::error(format!(
                        "asset name must be 1 to {MAX_ASSET_NAME} characters"
                    ));
                }
                pairs.push((id.to_string(), name));
            }
            match services.storage.as_deref() {
                None => Err(SandboxError::new("asset storage is unavailable")),
                Some(storage) => storage
                    .rename_asset_names(&pairs)
                    .map(|(renamed, missing)| json!({ "renamed": renamed, "missing": missing })),
            }
        }
        ("events", "list") => Ok(json!({ "events": events.list_event_names() })),
        ("events", "subscribe") => {
            let raw = args.first().and_then(|value| value.as_object());
            let subscription_id = raw
                .and_then(|map| map.get("subscriptionId"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let names = raw
                .and_then(|map| map.get("names"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            events
                .subscribe(&package.id, subscription_id, &names)
                .map(|outcome| serde_json::to_value(outcome).unwrap_or(Value::Null))
        }
        ("events", "unsubscribe") => {
            let raw = args.first().and_then(|value| value.as_object());
            let subscription_id = raw
                .and_then(|map| map.get("subscriptionId"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            events
                .unsubscribe(&package.id, subscription_id)
                .map(|removed| json!({ "subscriptionId": subscription_id, "removed": removed }))
        }
        _ => Err(SandboxError::new("unknown host operation")),
    };
    match outcome {
        Ok(result) => OpOutcome::ok(result),
        Err(error) => OpOutcome::error(error.message()),
    }
}

fn namespace_known(namespace: &str) -> bool {
    matches!(namespace, "assets" | "events")
}

/// `performPluginHostOp` — 一条沙箱插件的宿主操作。
pub fn perform_plugin_host_op(
    package: &SandboxedPackage,
    services: &HostServices,
    request: &Value,
    input_bytes: Option<&[u8]>,
    events: &HostEventBus,
) -> OpOutcome {
    let Some(map) = request.as_object() else {
        return OpOutcome::error("host operation is invalid");
    };
    let op = map.get("op").and_then(|value| value.as_str()).unwrap_or("");
    match op {
        "host" => perform_host_call(package, services, request, events),
        "read" => {
            if package.permissions.read.is_empty() {
                return OpOutcome::error("file read is not permitted");
            }
            let path = map.get("path").and_then(|value| value.as_str()).unwrap_or("");
            // 上游把 `granted.read` 当 roots 传（不是请求里的 roots 字段）：能读的子树
            // 由 manifest 的 permissions.read 决定。
            let Some(target) = resolve_plugin_path(&package.dir, path, &package.permissions.read)
            else {
                return OpOutcome::error("path was rejected");
            };
            let Ok(stat) = fs::metadata(&target) else {
                return OpOutcome::error("file is missing");
            };
            if !stat.is_file() || stat.len() > MAX_FILE_BYTES {
                return OpOutcome::error("file is missing or too large");
            }
            match fs::read_to_string(&target) {
                Ok(text) => OpOutcome::ok(json!(text)),
                Err(_) => OpOutcome::error("file is missing"),
            }
        }
        "store" | "store-input" => {
            let Some(store) = services.store.as_ref() else {
                return OpOutcome::error("plugin data store is unavailable");
            };
            let bytes = if op == "store-input" {
                input_bytes.map(|bytes| bytes.to_vec())
            } else {
                json_bytes(map.get("bytes"))
            };
            let Some(bytes) = bytes else {
                return OpOutcome::error("stored bytes are empty");
            };
            match store.store(&package.id, &bytes) {
                Ok((reference, byte_size)) => {
                    OpOutcome::ok(json!({ "ref": reference, "byteSize": byte_size }))
                }
                Err(error) => OpOutcome::error(error.message()),
            }
        }
        "archive-open" => {
            let Some(store) = services.store.as_ref() else {
                return OpOutcome::error("archive service is unavailable");
            };
            // 上游这一步只吃 `request.inputBytes`（parse 暂存的原始字节），不看 request.bytes。
            let Some(bytes) = input_bytes else {
                return OpOutcome::error("stored bytes are empty");
            };
            let (reference, byte_size) = match store.store(&package.id, bytes) {
                Ok(stored) => stored,
                Err(error) => return OpOutcome::error(error.message()),
            };
            match list_archive_pages(bytes) {
                Ok(pages) => OpOutcome::ok(json!({
                    "ref": reference,
                    "byteSize": byte_size,
                    "pageNames": pages.iter().map(|page| page.name.clone()).collect::<Vec<_>>(),
                    "pageCount": pages.len(),
                })),
                Err(_) => OpOutcome::error("archive open failed"),
            }
        }
        "write" => {
            if package.permissions.write.is_empty() {
                return OpOutcome::error("file write is not permitted");
            }
            let path = map.get("path").and_then(|value| value.as_str()).unwrap_or("");
            // 上游：`typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES`
            // —— 空字符串合法（可用来清空文件），只有非字符串或超限才报错。
            let Some(text) = map.get("text").and_then(|value| value.as_str()) else {
                return OpOutcome::error("write is empty or too large");
            };
            if text.len() > MAX_FILE_BYTES as usize {
                return OpOutcome::error("write is empty or too large");
            }
            let roots = package.permissions.write.clone();
            let Some(target) = resolve_plugin_path(&package.dir, path, &roots) else {
                return OpOutcome::error("path was rejected");
            };
            let base = target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_string();
            let mut protected: Vec<String> = PROTECTED_FILES
                .iter()
                .map(|name| name.to_string())
                .collect();
            if package.entry != "plugin.js" {
                protected.push(package.entry.clone());
            }
            if protected.iter().any(|name| name == &base) {
                return OpOutcome::error("path was rejected");
            }
            if let Some(parent) = target.parent() {
                if fs::create_dir_all(parent).is_err() {
                    return OpOutcome::error("path was rejected");
                }
            }
            match fs::write(&target, text.as_bytes()) {
                Ok(()) => OpOutcome::ok(json!({ "ok": true })),
                Err(_) => OpOutcome::error("path was rejected"),
            }
        }
        "data-load" => match load_plugin_data(&package.dir) {
            Ok(data) => OpOutcome::ok(json!({ "data": data })),
            Err(error) => OpOutcome::error(error.message()),
        },
        "data-save" => {
            let data = map.get("data").cloned().unwrap_or(Value::Null);
            match save_plugin_data(&package.dir, &data) {
                Ok(bytes) => OpOutcome::ok(json!({ "bytes": bytes })),
                Err(error) => OpOutcome::error(error.message()),
            }
        }
        "fetch" => perform_fetch(map, &package.permissions.network),
        _ => OpOutcome::error("unknown host operation"),
    }
}

fn json_bytes(value: Option<&Value>) -> Option<Vec<u8>> {
    let value = value?;
    if let Some(items) = value.as_array() {
        let mut bytes = Vec::with_capacity(items.len());
        for item in items {
            let number = item.as_f64()?;
            if number.fract() != 0.0 || !(0.0..=255.0).contains(&number) {
                return None;
            }
            bytes.push(number as u8);
        }
        return Some(bytes);
    }
    if let Some(map) = value.as_object() {
        let mut bytes = Vec::with_capacity(map.len());
        for index in 0..map.len() {
            let item = map.get(&index.to_string())?;
            let number = item.as_f64()?;
            if number.fract() != 0.0 || !(0.0..=255.0).contains(&number) {
                return None;
            }
            bytes.push(number as u8);
        }
        return Some(bytes);
    }
    value.as_str().and_then(|text| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(text.as_bytes()).ok()
    })
}

/// `net.fetch`：校验链与上游逐条一致；**传输层不可用**时明确报错，不返回伪造的成功响应。
fn perform_fetch(map: &Map<String, Value>, network: &[String]) -> OpOutcome {
    let url = map.get("url").and_then(|value| value.as_str()).unwrap_or("");
    let Ok(parsed) = url::Url::parse(url) else {
        return OpOutcome::error("url is invalid");
    };
    if parsed.scheme() != "https" {
        return OpOutcome::error("only https is allowed");
    }
    let hostname = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    // 上游：`!granted.network.includes(hostname.toLowerCase())` —— 白名单同样来自 manifest。
    if !network
        .iter()
        .any(|entry| entry.to_ascii_lowercase() == hostname)
    {
        return OpOutcome::error("host is not permitted");
    }
    let method = match map.get("method").and_then(|value| value.as_str()) {
        Some(value) if value == "POST" || value == "GET" => value,
        _ => "GET",
    };
    // 上游只收 string 且 ≤1024 的头，非 string 静默丢弃；只有数量超限才报错。
    let mut accepted = 0usize;
    if let Some(headers) = map.get("headers").and_then(|value| value.as_object()) {
        for (_, value) in headers.iter() {
            if let Some(text) = value.as_str() {
                if text.len() <= 1024 {
                    accepted += 1;
                }
            }
        }
    }
    if accepted > 16 {
        return OpOutcome::error("too many headers");
    }
    let body = map
        .get("body")
        .and_then(|value| value.as_str())
        .filter(|text| text.len() <= 256 * 1024);
    if body.is_some() && method == "GET" {
        return OpOutcome::error("GET cannot carry a body");
    }
    OpOutcome::error(
        "net.fetch is unavailable in this build: the HTTP transport has no TLS backend",
    )
}

// ———————————————————————————— ZIP 页读取（与 comic.rs 同引擎语义） ————————————————————————————

#[derive(Debug, Clone)]
pub struct ArchivePage {
    pub name: String,
    pub mime_type: &'static str,
    entry: ZipEntry,
}

fn list_archive_pages(archive: &[u8]) -> SandboxResult<Vec<ArchivePage>> {
    let entries = zip_entries(archive)?;
    let mut pages: Vec<ArchivePage> = entries
        .into_iter()
        .filter_map(|entry| {
            if !crate::comic::is_page_entry(&entry.name) {
                return None;
            }
            let mime_type = crate::comic::page_mime_for(&entry.name)?;
            Some(ArchivePage {
                name: entry.name.clone(),
                mime_type,
                entry,
            })
        })
        .collect();
    pages.sort_by(|left, right| crate::comic::natural_cmp(&left.name, &right.name));
    Ok(pages)
}

/// 按 `(pluginId, ref)` 从内容寻址仓里取一页。
pub fn read_plugin_page(
    store: &PluginStore,
    plugin_id: &str,
    reference: &str,
    index: f64,
) -> SandboxResult<(Vec<u8>, &'static str)> {
    let bytes = store.read(plugin_id, reference)?;
    let pages = list_archive_pages(&bytes)?;
    if pages.is_empty() {
        return Err(SandboxError::new("this archive has no readable pages"));
    }
    if !index.is_finite() || index.fract() != 0.0 || index < 0.0 || index >= pages.len() as f64 {
        return Err(SandboxError::new("plugin page index is out of range"));
    }
    let page = &pages[index as usize];
    let decoded = inflate_entry(&bytes, &page.entry)?;
    Ok((decoded, page.mime_type))
}

// ———————————————————————————— 宿主生命周期状态机 ————————————————————————————

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildDecision {
    /// 立刻重建。
    Rebuild,
    /// 重建被拒（notifier 否决）。
    Vetoed,
    /// 还不知道 plugins 根，等下一次显式激活。
    Deferred,
    /// 重建预算耗尽。
    BudgetExhausted,
}

/// 与 Tauri 无关的纯状态机：ready 超时、崩溃、无响应宽限、重建预算都在这里判定，
/// 便于单元测试；窗口创建与销毁由 glue 层负责。
pub struct HostLifecycle {
    state: Mutex<LifecycleState>,
    ready_cv: std::sync::Condvar,
}

#[derive(Debug, Default)]
struct LifecycleState {
    ready: bool,
    dead: bool,
    dead_reason: Option<String>,
    notified: bool,
    unresponsive_deadline: Option<Instant>,
}

impl Default for HostLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl HostLifecycle {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(LifecycleState::default()),
            ready_cv: std::sync::Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LifecycleState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn is_ready(&self) -> bool {
        self.lock().ready
    }

    pub fn is_dead(&self) -> bool {
        self.lock().dead
    }

    pub fn dead_reason(&self) -> Option<String> {
        self.lock().dead_reason.clone()
    }

    pub fn mark_ready(&self) {
        let mut state = self.lock();
        if state.dead {
            return;
        }
        state.ready = true;
        state.unresponsive_deadline = None;
        self.ready_cv.notify_all();
    }

    /// 阻断到 ready 或 dead；`timeout` 到点仍未就绪则返回 `Err("ready-timeout")`。
    /// 状态机本身不杀窗口 —— 那是 watchog 线程的职责，这里只等。
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        loop {
            if state.dead {
                return Err(state
                    .dead_reason
                    .clone()
                    .unwrap_or_else(|| "destroyed".to_string()));
            }
            if state.ready {
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("ready-timeout".to_string());
            }
            let (next, _) = self
                .ready_cv
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
        }
    }

    /// 标记死亡；返回 `true` 表示这是第一次（用于"只通知一次"）。
    pub fn die(&self, reason: &str) -> bool {
        let mut state = self.lock();
        if state.dead {
            return false;
        }
        state.dead = true;
        state.dead_reason = Some(reason.to_string());
        state.unresponsive_deadline = None;
        let first_notice = !state.notified;
        state.notified = true;
        drop(state);
        self.ready_cv.notify_all();
        first_notice
    }

    /// 记录一次"调用超时 → 疑似无响应"，返回宽限截止时刻；已存在则沿用原截止点。
    pub fn note_unresponsive(&self, now: Instant) -> Instant {
        let mut state = self.lock();
        if let Some(deadline) = state.unresponsive_deadline {
            return deadline;
        }
        let deadline = now + Duration::from_millis(UNRESPONSIVE_GRACE_MS);
        state.unresponsive_deadline = Some(deadline);
        deadline
    }

    /// 收到任何回执 → 撤掉无响应判定。
    pub fn clear_unresponsive(&self) {
        self.lock().unresponsive_deadline = None;
    }

    /// 宽限期是否已过（过了就意味着要强制重建）。
    pub fn unresponsive_expired(&self, now: Instant) -> bool {
        let state = self.lock();
        if state.dead {
            return false;
        }
        state
            .unresponsive_deadline
            .map(|deadline| now >= deadline)
            .unwrap_or(false)
    }
}

/// 重建预算：`AUTO_REBUILD_WINDOW_MS` 内最多 `MAX_AUTO_REBUILDS` 次。
#[derive(Debug, Default)]
pub struct RebuildBudget {
    stamps: Vec<Instant>,
}

impl RebuildBudget {
    pub fn new() -> Self {
        Self::default()
    }

    fn prune(&mut self, now: Instant) {
        let window = Duration::from_millis(AUTO_REBUILD_WINDOW_MS);
        self.stamps
            .retain(|stamp| now.duration_since(*stamp) < window);
    }

    pub fn decision(&mut self, now: Instant, notifier_ok: bool, has_root: bool) -> RebuildDecision {
        if !notifier_ok {
            return RebuildDecision::Vetoed;
        }
        self.prune(now);
        if !has_root {
            return RebuildDecision::Deferred;
        }
        if self.stamps.len() >= MAX_AUTO_REBUILDS {
            return RebuildDecision::BudgetExhausted;
        }
        RebuildDecision::Rebuild
    }

    pub fn record(&mut self, now: Instant) {
        self.prune(now);
        self.stamps.push(now);
    }

    pub fn count(&self) -> usize {
        self.stamps.len()
    }
}

// ———————————————————————————— 宿主会话（pluginSandboxHost.cjs） ————————————————————————————

/// 一个宿主窗口的活体状态。
pub struct HostSession {
    pub label: String,
    pub lifecycle: Arc<HostLifecycle>,
    pending: Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>,
    seq: std::sync::atomic::AtomicU64,
}

impl HostSession {
    pub fn new(label: &str) -> Self {
        Self {
            label: label.to_string(),
            lifecycle: Arc::new(HostLifecycle::new()),
            pending: Mutex::new(HashMap::new()),
            seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn next_request_id(&self) -> u64 {
        self.seq
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    fn register(&self, request_id: u64) -> std::sync::mpsc::Receiver<Value> {
        let (sender, receiver) = std::sync::mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(request_id, sender);
        receiver
    }

    fn settle(&self, request_id: u64, payload: Value) -> bool {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&request_id);
        match sender {
            Some(sender) => sender.send(payload).is_ok(),
            None => false,
        }
    }

    /// 死亡时把所有在飞请求结清成 `{ok:false, message:"sandbox host is gone (reason)"}`。
    fn settle_all(&self, reason: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (_, sender) in pending.drain() {
            let _ = sender.send(json!({
                "ok": false,
                "message": format!("sandbox host is gone ({reason})"),
            }));
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }
}

/// 宿主窗口内 `sandboxHost` shim 投递入口的 JS 表达式前缀。
pub const DELIVER_FN: &str = "__ARTFLOW_SANDBOX_DELIVER__";

// ———————————————————————————— 注册表 ————————————————————————————

pub struct SandboxRegistry {
    app: tauri::AppHandle,
    events: Arc<HostEventBus>,
    store: Arc<PluginStore>,
    storage: Mutex<Option<Arc<dyn AssetStorage>>>,
    session: Mutex<Option<Arc<HostSession>>>,
    installed: Mutex<HashMap<String, SandboxedPackage>>,
    parse_inputs: Mutex<HashMap<String, Vec<u8>>>,
    plugins_root: Mutex<Option<PathBuf>>,
    budget: Mutex<RebuildBudget>,
    activation: Mutex<()>,
}

/// `init(app)` — 与 `comic::init` 同一模式（setup 里 `app.manage`）。
pub fn init(app: &tauri::AppHandle) -> Result<Arc<SandboxRegistry>, tauri::Error> {
    let data_dir = app.path().app_data_dir()?;
    let store = Arc::new(PluginStore::new(data_dir.join("plugin-store")));
    Ok(Arc::new(SandboxRegistry {
        app: app.clone(),
        events: Arc::new(HostEventBus::new()),
        store,
        storage: Mutex::new(None),
        session: Mutex::new(None),
        installed: Mutex::new(HashMap::new()),
        parse_inputs: Mutex::new(HashMap::new()),
        plugins_root: Mutex::new(None),
        budget: Mutex::new(RebuildBudget::new()),
        activation: Mutex::new(()),
    }))
}

impl SandboxRegistry {
    pub fn events(&self) -> Arc<HostEventBus> {
        self.events.clone()
    }

    pub fn store(&self) -> Arc<PluginStore> {
        self.store.clone()
    }

    /// Tauri 侧资产库接线点（`project.rs` 落地后由 Lead 注入）。
    pub fn set_asset_storage(&self, storage: Arc<dyn AssetStorage>) {
        *self.storage.lock().unwrap_or_else(|error| error.into_inner()) = Some(storage);
    }

    pub fn plugins_root(&self) -> PathBuf {
        if let Ok(dir) = self.app.path().app_data_dir() {
            return dir.join("plugins");
        }
        PathBuf::from("plugins")
    }

    fn services(&self) -> HostServices {
        HostServices {
            store: Some(self.store.clone()),
            storage: self
                .storage
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        }
    }

    fn session_of(&self) -> Option<Arc<HostSession>> {
        self.session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn installed_package(&self, plugin_id: &str) -> Option<SandboxedPackage> {
        self.installed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(plugin_id)
            .cloned()
    }

    /// 宿主窗口里的 `sandboxHost.reply` → 这里分派。
    pub fn handle_reply(&self, session: &Arc<HostSession>, payload: &Value) {
        session.lifecycle.clear_unresponsive();
        let Some(map) = payload.as_object() else {
            return;
        };
        let kind = map.get("type").and_then(|value| value.as_str()).unwrap_or("");
        match kind {
            "ready" => session.lifecycle.mark_ready(),
            "log" => {
                let level = map
                    .get("level")
                    .and_then(|value| value.as_str())
                    .filter(|level| matches!(*level, "log" | "info" | "warn" | "error"))
                    .unwrap_or("log");
                let plugin_id = map
                    .get("pluginId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let text = map
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(4000)
                    .collect::<String>();
                let line = format!("[plugin] {plugin_id} {text}");
                match level {
                    "warn" => eprintln!("{line}"),
                    "error" => eprintln!("{line}"),
                    _ => println!("{line}"),
                }
            }
            "host" => self.handle_host_call(session, payload),
            _ => {
                let Some(request_id) = map.get("requestId").and_then(|value| value.as_u64()) else {
                    return;
                };
                session.settle(request_id, payload.clone());
            }
        }
    }

    fn handle_host_call(&self, session: &Arc<HostSession>, payload: &Value) {
        let map = payload.as_object().cloned().unwrap_or_default();
        let request_id = map
            .get("requestId")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let plugin_id = map
            .get("pluginId")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let op = map
            .get("op")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let input_bytes = if op == "store-input" || op == "archive-open" {
            self.parse_inputs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&plugin_id)
                .cloned()
        } else {
            None
        };
        let outcome = match self.installed_package(&plugin_id) {
            None => OpOutcome::error("plugin is not installed"),
            Some(package) => {
                let services = self.services();
                perform_plugin_host_op(
                    &package,
                    &services,
                    payload,
                    input_bytes.as_deref(),
                    &self.events,
                )
            }
        };
        let reply = json!({
            "type": "host-result",
            "requestId": request_id,
            "ok": outcome.ok,
            "result": outcome.result,
            "message": outcome.message,
        });
        let _ = self.deliver_to(session, &reply);
    }

    /// 向宿主窗口投递一条消息（等价于 Electron 的 `webContents.send`）。
    fn deliver_to(&self, session: &Arc<HostSession>, message: &Value) -> Result<(), String> {
        if session.lifecycle.is_dead() {
            return Err("sandbox host is gone".to_string());
        }
        let Some(window) = self
            .app
            .get_webview_window(session.label.as_str())
        else {
            return Err("sandbox host is gone".to_string());
        };
        let encoded = serde_json::to_string(message).map_err(|error| error.to_string())?;
        window
            .eval(format!(
                "window.{DELIVER_FN} && window.{DELIVER_FN}({encoded});"
            ))
            .map_err(|error| error.to_string())
    }

    /// `call(message)` —— 与上游同一语义：等 ready → 发消息 → 等回执（20s）。
    pub fn call(&self, session: &Arc<HostSession>, message: Value) -> Result<Value, String> {
        session
            .lifecycle
            .wait_ready(Duration::from_millis(READY_TIMEOUT_MS))?;
        let request_id = session.next_request_id();
        let mut payload = message;
        if let Some(map) = payload.as_object_mut() {
            map.insert("requestId".to_string(), json!(request_id));
        }
        let receiver = session.register(request_id);
        if let Err(error) = self.deliver_to(session, &payload) {
            session.settle(request_id, json!({}));
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(CALL_TIMEOUT_MS)) {
            Ok(reply) => Ok(reply),
            Err(_) => {
                let deadline = session
                    .lifecycle
                    .note_unresponsive(Instant::now());
                self.spawn_unresponsive_watch(session.clone(), deadline);
                Err("sandbox timed out".to_string())
            }
        }
    }

    fn spawn_unresponsive_watch(&self, session: Arc<HostSession>, deadline: Instant) {
        let label = session.label.clone();
        let app = self.app.clone();
        std::thread::spawn(move || {
            let now = Instant::now();
            if deadline > now {
                std::thread::sleep(deadline - now);
            }
            if session.lifecycle.unresponsive_expired(Instant::now()) {
                eprintln!("[plugin-sandbox] host still unresponsive; forcing rebuild");
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
                session.lifecycle.die("unresponsive");
            }
        });
    }

    /// 创建宿主窗口（Electron 的 `createHost`）。
    fn create_session(&self) -> Result<Arc<HostSession>, String> {
        let session = Arc::new(HostSession::new(SANDBOX_WINDOW_LABEL));
        let url = format!("{SANDBOX_SCHEME}://localhost/guest.html");
        let _window = tauri::WebviewWindowBuilder::new(
            &self.app,
            SANDBOX_WINDOW_LABEL,
            tauri::WebviewUrl::CustomProtocol(
                url::Url::parse(&url).map_err(|error| error.to_string())?,
            ),
        )
        .title("Artflow plugin sandbox")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(480.0, 320.0)
        .initialization_script(sandbox_shim_script())
        .build()
        .map_err(|error| error.to_string())?;
        // hostEvents.setEmitter：窗口活着才投递，死掉直接丢。
        let app = self.app.clone();
        let label = SANDBOX_WINDOW_LABEL.to_string();
        let lifecycle = session.lifecycle.clone();
        self.events.set_emitter(Some(Arc::new(move |plugin_id: &str, event: Value| {
            if lifecycle.is_dead() {
                return;
            }
            let Some(window) = app.get_webview_window(&label) else {
                return;
            };
            let mut message = Map::new();
            message.insert("type".to_string(), json!("host-event"));
            message.insert("pluginId".to_string(), json!(plugin_id));
            if let Some(map) = event.as_object() {
                for (key, value) in map.iter() {
                    message.insert(key.clone(), value.clone());
                }
            }
            if let Ok(encoded) = serde_json::to_string(&Value::Object(message)) {
                let _ = window.eval(format!(
                    "window.{DELIVER_FN} && window.{DELIVER_FN}({encoded});"
                ));
            }
        })));
        let watchdog = session.lifecycle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(READY_TIMEOUT_MS));
            if !watchdog.is_ready() && !watchdog.is_dead() {
                eprintln!(
                    "[plugin-sandbox] host not ready within {READY_TIMEOUT_MS}ms; treating it as lost"
                );
                watchdog.die("ready-timeout");
            }
        });
        Ok(session)
    }

    fn ensure_session(&self) -> Result<Arc<HostSession>, String> {
        if let Some(session) = self.session_of() {
            if !session.lifecycle.is_dead() {
                return Ok(session);
            }
        }
        let session = self.create_session()?;
        *self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(session.clone());
        Ok(session)
    }

    /// `activateInstalledPlugins(root)` —— 返回渲染层要的 `plugins` 数组。
    pub fn activate_installed_plugins(&self, root: &Path) -> Vec<Value> {
        let _guard = self
            .activation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *self
            .plugins_root
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(root.to_path_buf());
        let Ok(session) = self.ensure_session() else {
            return Vec::new();
        };
        if session
            .lifecycle
            .wait_ready(Duration::from_millis(READY_TIMEOUT_MS))
            .is_err()
        {
            eprintln!(
                "[plugin-sandbox] activation aborted (host died before ready: {})",
                session
                    .lifecycle
                    .dead_reason()
                    .unwrap_or_else(|| "unknown".to_string())
            );
            return Vec::new();
        }
        self.events.reset();
        self.installed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let mut entries: Vec<Value> = Vec::new();
        for package in list_sandboxed_packages(root) {
            self.installed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(package.id.clone(), package.clone());
            if !package.host_compatible {
                entries.push(json!({
                    "id": package.id,
                    "name": package.name,
                    "error": format!(
                        "requires host API {}, this build provides {HOST_API_VERSION}",
                        package.min_host_version
                    ),
                    "formats": [],
                    "commands": [],
                    "panels": [],
                }));
                continue;
            }
            let source = match fs::read_to_string(&package.entry_path) {
                Ok(source) => source,
                Err(_) => {
                    entries.push(json!({
                        "id": package.id,
                        "name": package.name,
                        "error": "activation failed",
                        "formats": [],
                        "commands": [],
                        "panels": [],
                    }));
                    continue;
                }
            };
            let message = json!({
                "type": "activate",
                "pluginId": package.id,
                "source": source,
                "hostApiVersion": HOST_API_VERSION,
                "manifest": { "name": package.name, "version": "" },
            });
            let reply = self.call(&session, message).unwrap_or(Value::Null);
            let error = reply
                .get("error")
                .and_then(|value| value.as_str())
                .map(|text| text.to_string());
            let catalog = reply.get("catalog").filter(|value| value.is_object());
            if let Some(error) = error {
                entries.push(json!({
                    "id": package.id,
                    "name": package.name,
                    "error": error,
                    "formats": [],
                    "commands": [],
                    "panels": [],
                }));
                continue;
            }
            let Some(catalog) = catalog else {
                let message = reply
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("activation failed");
                entries.push(json!({
                    "id": package.id,
                    "name": package.name,
                    "error": message,
                    "formats": [],
                    "commands": [],
                    "panels": [],
                }));
                continue;
            };
            let mut entry = Map::new();
            entry.insert("id".to_string(), json!(package.id));
            entry.insert("name".to_string(), json!(package.name));
            if let Some(map) = catalog.as_object() {
                for (key, value) in map.iter() {
                    entry.insert(key.clone(), value.clone());
                }
            }
            entries.push(Value::Object(entry));
        }
        entries
    }

    /// 宿主丢失后的重建判定（`handleHostLost`）。
    pub fn handle_host_lost(&self, session: &Arc<HostSession>, reason: &str) {
        if session.lifecycle.die(reason) {
            session.settle_all(reason);
        }
        let is_current = self
            .session_of()
            .map(|current| Arc::ptr_eq(&current, session))
            .unwrap_or(false);
        if !is_current {
            return;
        }
        *self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.installed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.parse_inputs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.events.reset_for_new_host();
        eprintln!("[plugin-sandbox] host lost ({reason}); re-activation required");

        let notifier_ok = self.app.get_webview_window("main").is_some();
        if !notifier_ok {
            eprintln!("[plugin-sandbox] rebuild skipped (notifier vetoed: app quitting or no renderer)");
            return;
        }
        let _ = self.app.emit_to(
            tauri::EventTarget::webview_window("main"),
            HOST_RESTARTED_EVENT,
            json!({ "reason": reason }),
        );
        let root = self
            .plugins_root
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let now = Instant::now();
        let decision = self
            .budget
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .decision(now, notifier_ok, root.is_some());
        match decision {
            RebuildDecision::Vetoed => {
                eprintln!("[plugin-sandbox] rebuild skipped (notifier vetoed)");
            }
            RebuildDecision::Deferred => {
                eprintln!("[plugin-sandbox] rebuild deferred (no plugins root known yet; next activation will create it)");
            }
            RebuildDecision::BudgetExhausted => {
                eprintln!(
                    "[plugin-sandbox] auto rebuild budget exhausted ({MAX_AUTO_REBUILDS}/{AUTO_REBUILD_WINDOW_MS}ms); waiting for explicit activation"
                );
            }
            RebuildDecision::Rebuild => {
                self.budget
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .record(now);
                let Some(root) = root else {
                    return;
                };
                let registry = self as *const SandboxRegistry as usize;
                std::thread::spawn(move || {
                    // SAFETY: registry 由 `app.manage` 持有，生命周期与进程一致；
                    // 该指针只在此线程内用于一次激活调用。
                    let registry = unsafe { &*(registry as *const SandboxRegistry) };
                    let _ = registry.activate_installed_plugins(&root);
                });
            }
        }
    }

    /// 沙箱窗口被用户/CSP 意外销毁时的入口。
    pub fn notify_window_destroyed(&self, label: &str) {
        if label != SANDBOX_WINDOW_LABEL {
            return;
        }
        if let Some(session) = self.session_of() {
            self.handle_host_lost(&session, "destroyed");
        }
    }

    /// 外部（命令层）触发的沙箱插件调用。
    pub fn invoke_plugin(&self, message: &Value) -> OpOutcome {
        let Some(map) = message.as_object() else {
            return OpOutcome::error("plugin id is missing");
        };
        let plugin_id = map
            .get("pluginId")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if plugin_id.is_empty() {
            return OpOutcome::error("plugin id is missing");
        }
        let op = map.get("op").and_then(|value| value.as_str()).unwrap_or("");
        let Some(session) = self.session_of().filter(|session| !session.lifecycle.is_dead()) else {
            return OpOutcome::error("sandbox host is gone (no host)");
        };
        match op {
            "parse" => {
                let bytes = json_bytes(map.get("bytes")).unwrap_or_default();
                if bytes.is_empty() || bytes.len() > MAX_PARSE_BYTES {
                    return OpOutcome::error("file is empty or larger than 512MB");
                }
                self.parse_inputs
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(plugin_id.clone(), bytes.clone());
                let handler_id = map
                    .get("handlerId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let name = map
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|text| slice_chars(text, 180))
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "file".to_string());
                let mime_type = map
                    .get("mimeType")
                    .and_then(|value| value.as_str())
                    .map(|text| slice_chars(text, 120))
                    .unwrap_or_default();
                let payload = json!({
                    "type": "parse",
                    "pluginId": plugin_id,
                    "handlerId": handler_id,
                    "name": name,
                    "mimeType": mime_type,
                    "bytes": encode_bytes_base64(&bytes),
                    "bytesEncoding": "base64",
                });
                let outcome = match self.call(&session, payload) {
                    Ok(reply) => reply,
                    Err(message) => {
                        self.parse_inputs
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .remove(&plugin_id);
                        return OpOutcome::error(message);
                    }
                };
                self.parse_inputs
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&plugin_id);
                let ok = outcome
                    .get("ok")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                if !ok {
                    let message = outcome
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("parse failed");
                    return OpOutcome::error(message);
                }
                OpOutcome::ok(outcome.get("result").cloned().unwrap_or(Value::Null))
            }
            "command" | "panel-action" | "asset-probe" | "asset-submit" => {
                let payload = match op {
                    "command" => json!({
                        "type": "command",
                        "pluginId": plugin_id,
                        "commandId": map.get("commandId").and_then(|value| value.as_str()).unwrap_or(""),
                    }),
                    "panel-action" => json!({
                        "type": "panel-action",
                        "pluginId": plugin_id,
                        "panelId": map.get("panelId").and_then(|value| value.as_str()).unwrap_or(""),
                        "actionId": map.get("actionId").and_then(|value| value.as_str()).unwrap_or(""),
                        "values": match map.get("values") {
                            Some(Value::Object(values)) => Value::Object(values.clone()),
                            _ => json!({}),
                        },
                    }),
                    _ => json!({
                        "type": if op == "asset-probe" { "probe" } else { "submit" },
                        "pluginId": plugin_id,
                        "sourceId": map.get("sourceId").and_then(|value| value.as_str()).unwrap_or(""),
                        "submission": map.get("submission").cloned().unwrap_or(Value::Null),
                    }),
                };
                let fallback = match op {
                    "command" => "command failed",
                    "panel-action" => "panel action failed",
                    _ => "asset call failed",
                };
                let outcome = match self.call(&session, payload) {
                    Ok(reply) => reply,
                    Err(message) => return OpOutcome::error(message),
                };
                let ok = outcome
                    .get("ok")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                if !ok {
                    let message = outcome
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or(fallback);
                    return OpOutcome::error(message);
                }
                if op == "command" {
                    OpOutcome::ok(Value::Null)
                } else {
                    OpOutcome::ok(outcome.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => OpOutcome::error("unknown sandbox operation"),
        }
    }

    /// 沙箱窗口关闭（`closed`）→ 清会话。
    pub fn clear_session_if(&self, session: &Arc<HostSession>) {
        let mut current = self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(existing) = current.as_ref() {
            if Arc::ptr_eq(existing, session) {
                *current = None;
            }
        }
    }

    pub fn read_clients(&self, root: &Path) -> Vec<Value> {
        list_sandboxed_packages(root)
            .into_iter()
            .filter_map(|package| {
                let client_path = package.client_path.clone()?;
                let source = fs::read_to_string(client_path).ok()?;
                Some(json!({
                    "id": package.id,
                    "source": source,
                    "capabilities": package.capabilities,
                    "library": package.permissions.library.iter().any(|entry| entry == "rename"),
                }))
            })
            .collect()
    }
}

fn encode_bytes_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 供 `create_session` 内的 emitter 闭包调用的转发点；真正的窗口句柄由注册表在
/// 每次投递时重新解析，避免闭包持有过期 `WebviewWindow`。
fn registry_events_deliver(_plugin_id: &str, _message: Value) -> Result<(), String> {
    Ok(())
}

// ———————————————————————————— Tauri 命令 ————————————————————————————

fn trusted_url(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !cfg!(feature = "custom-protocol") {
        url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(4002)
    } else {
        (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none())
            || (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
    }
}

/// 与 `main.rs::authorized` 同义（`main.rs` 是 Lead 的文件，这里复制一份）。
fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

fn registry_of(window: &WebviewWindow) -> Option<Arc<SandboxRegistry>> {
    window
        .app_handle()
        .try_state::<Arc<SandboxRegistry>>()
        .map(|state| state.inner().clone())
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl PluginsReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }

    fn success(plugins: Vec<Value>) -> Self {
        Self {
            ok: true,
            plugins: Some(plugins),
            message: None,
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl InstallReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl InvokeReply {
    fn from_outcome(outcome: OpOutcome) -> Self {
        Self {
            ok: outcome.ok,
            result: outcome.result,
            message: outcome.message,
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl StoredReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientsReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    clients: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl ClientsReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRequest {
    plugin_id: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    plugin_id: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
    index: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    source_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallRequest {
    id: Option<String>,
}

fn temp_dir(label: &str) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = format!(
        "artflow-sandbox-{}-{}-{}",
        std::process::id(),
        label,
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    std::env::temp_dir().join(unique)
}

/// 把「文件或目录」来源装成插件：zip 先解包再按目录装。
fn install_from_source_path(
    source_path: &str,
    dest_root: &Path,
) -> SandboxResult<InstallOutcome> {
    if source_path.is_empty() || utf16_len(source_path) > 4000 {
        return Err(SandboxError::new("install path was rejected"));
    }
    let path = PathBuf::from(source_path);
    let Ok(stat) = fs::metadata(&path) else {
        return Err(SandboxError::new("path is not accessible"));
    };
    if stat.is_file() {
        if !source_path.to_ascii_lowercase().ends_with(".zip") {
            return Err(SandboxError::new(
                "only .zip archives and plugin folders are supported",
            ));
        }
        let scratch = temp_dir("extract");
        let outcome = (|| {
            extract_plugin_zip(&path, &scratch)?;
            let Some(source_dir) = resolve_plugin_source_dir(&scratch) else {
                return Err(SandboxError::new(
                    "archive does not contain an Artflow plugin (manifest.json not found)",
                ));
            };
            let inspection = inspect_plugin_directory(&source_dir)?;
            if inspection.needs_trust_confirmation && !confirm_trust(&inspection) {
                return Err(SandboxError::new("trust confirmation declined"));
            }
            install_plugin_directory(&source_dir, dest_root)
        })();
        let _ = fs::remove_dir_all(&scratch);
        return outcome;
    }
    if stat.is_dir() {
        let inspection = inspect_plugin_directory(&path)?;
        if inspection.needs_trust_confirmation && !confirm_trust(&inspection) {
            return Err(SandboxError::new("trust confirmation declined"));
        }
        return install_plugin_directory(&path, dest_root);
    }
    Err(SandboxError::new("not a file or directory"))
}

fn confirm_trust(inspection: &PluginInspection) -> bool {
    let labels = inspection.permissions.join(", ");
    let message = format!(
        "{} 请求以下权限：{}。只安装你信任来源的插件。",
        inspection.name,
        if labels.is_empty() { "无".to_string() } else { labels }
    );
    matches!(
        rfd::MessageDialog::new()
            .set_title("Artflow 插件安装")
            .set_description(message)
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show(),
        rfd::MessageDialogResult::Ok
    )
}

fn remove_plugin_with_retry(dest_root: &Path, plugin_id: &str) -> SandboxResult<()> {
    let mut last: Option<SandboxError> = None;
    for attempt in 0..4 {
        match uninstall_plugin(dest_root, plugin_id) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Some(error);
                std::thread::sleep(Duration::from_millis(250 * (attempt + 1) as u64));
            }
        }
    }
    Err(last.unwrap_or_else(|| SandboxError::new("failed to remove plugin files")))
}

#[tauri::command]
pub async fn tauri_list_sandboxed_plugins(window: WebviewWindow) -> PluginsReply {
    if !authorized(&window) {
        return PluginsReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return PluginsReply::error("sandbox registry is unavailable");
    };
    let root = registry.plugins_root();
    tauri::async_runtime::spawn_blocking(move || PluginsReply::success(registry.activate_installed_plugins(&root)))
        .await
        .unwrap_or_else(|error| PluginsReply::error(format!("plugin activation failed: {error}")))
}

#[tauri::command]
pub async fn tauri_install_external_plugin(window: WebviewWindow) -> InstallReply {
    if !authorized(&window) {
        return InstallReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return InstallReply::error("sandbox registry is unavailable");
    };
    let dock = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_parent(&dock)
            .set_title("安装外部插件")
            .add_filter("Artflow plugin", &["zip"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or(None);
    let Some(source) = picked else {
        return InstallReply::error("cancelled");
    };
    install_at(&registry, &source).await
}

#[tauri::command]
pub async fn tauri_install_external_plugin_from_path(
    window: WebviewWindow,
    request: PathRequest,
) -> InstallReply {
    if !authorized(&window) {
        return InstallReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return InstallReply::error("sandbox registry is unavailable");
    };
    let Some(source) = request.source_path else {
        return InstallReply::error("install path was rejected");
    };
    install_at(&registry, &source).await
}

async fn install_at(registry: &Arc<SandboxRegistry>, source: &str) -> InstallReply {
    let dest_root = registry.plugins_root();
    let source = source.to_string();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || install_from_source_path(&source, &dest_root))
            .await
            .unwrap_or_else(|error| Err(SandboxError::new(format!("install failed: {error}"))));
    match outcome {
        Ok(installed) => InstallReply {
            ok: true,
            id: Some(installed.id),
            mode: Some(installed.mode),
            message: None,
        },
        Err(error) => InstallReply::error(error.message()),
    }
}

#[tauri::command]
pub async fn tauri_is_plugin_source_path(window: WebviewWindow, request: PathRequest) -> bool {
    if !authorized(&window) {
        return false;
    }
    let Some(source) = request.source_path else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || is_plugin_source_path(&source))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn tauri_uninstall_external_plugin(
    window: WebviewWindow,
    request: UninstallRequest,
) -> InstallReply {
    if !authorized(&window) {
        return InstallReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return InstallReply::error("sandbox registry is unavailable");
    };
    let Some(plugin_id) = request.id else {
        return InstallReply::error("plugin id was rejected");
    };
    let dest_root = registry.plugins_root();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        remove_plugin_with_retry(&dest_root, &plugin_id)
    })
    .await
    .unwrap_or_else(|error| Err(SandboxError::new(format!("uninstall failed: {error}"))));
    match outcome {
        Ok(()) => InstallReply {
            ok: true,
            id: None,
            mode: None,
            message: None,
        },
        Err(error) => InstallReply::error(error.message()),
    }
}

#[tauri::command]
pub async fn tauri_invoke_sandboxed_plugin(
    window: WebviewWindow,
    request: Value,
) -> InvokeReply {
    if !authorized(&window) {
        return InvokeReply {
            message: Some("forbidden caller".to_string()),
            ..InvokeReply::default()
        };
    }
    let Some(registry) = registry_of(&window) else {
        return InvokeReply {
            message: Some("sandbox registry is unavailable".to_string()),
            ..InvokeReply::default()
        };
    };
    tauri::async_runtime::spawn_blocking(move || InvokeReply::from_outcome(registry.invoke_plugin(&request)))
        .await
        .unwrap_or_else(|error| InvokeReply {
            message: Some(format!("plugin call failed: {error}")),
            ..InvokeReply::default()
        })
}

#[tauri::command]
pub async fn tauri_read_plugin_clients(window: WebviewWindow) -> ClientsReply {
    if !authorized(&window) {
        return ClientsReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return ClientsReply::error("sandbox registry is unavailable");
    };
    let root = registry.plugins_root();
    let clients = tauri::async_runtime::spawn_blocking(move || registry.read_clients(&root))
        .await
        .unwrap_or_default();
    ClientsReply {
        ok: true,
        clients: Some(clients),
        message: None,
    }
}

#[tauri::command]
pub async fn tauri_read_stored(window: WebviewWindow, request: StoredRequest) -> StoredReply {
    if !authorized(&window) {
        return StoredReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return StoredReply::error("sandbox registry is unavailable");
    };
    let plugin_id = request.plugin_id.unwrap_or_default();
    let reference = request.reference.unwrap_or_default();
    let store = registry.store();
    let outcome = tauri::async_runtime::spawn_blocking(move || store.read(&plugin_id, &reference))
        .await
        .unwrap_or_else(|error| Err(SandboxError::new(format!("stored data read failed: {error}"))));
    match outcome {
        Ok(bytes) => StoredReply {
            ok: true,
            bytes: Some(bytes),
            mime_type: None,
            message: None,
        },
        Err(error) => StoredReply::error(error.message()),
    }
}

#[tauri::command]
pub async fn tauri_read_plugin_page(window: WebviewWindow, request: PageRequest) -> StoredReply {
    if !authorized(&window) {
        return StoredReply::error("forbidden caller");
    }
    let Some(registry) = registry_of(&window) else {
        return StoredReply::error("sandbox registry is unavailable");
    };
    let plugin_id = request.plugin_id.unwrap_or_default();
    let reference = request.reference.unwrap_or_default();
    let index = request.index.unwrap_or(f64::NAN);
    let store = registry.store();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        read_plugin_page(&store, &plugin_id, &reference, index)
    })
    .await
    .unwrap_or_else(|error| Err(SandboxError::new(format!("plugin page read failed: {error}"))));
    match outcome {
        Ok((bytes, mime_type)) => StoredReply {
            ok: true,
            bytes: Some(bytes),
            mime_type: Some(mime_type.to_string()),
            message: None,
        },
        Err(error) => StoredReply::error(error.message()),
    }
}

/// 沙箱窗口唯一被允许的命令：`sandboxHost.reply` 的接收端。
#[tauri::command]
pub async fn tauri_sandbox_reply(window: WebviewWindow, message: Value) -> bool {
    if window.label() != SANDBOX_WINDOW_LABEL {
        return false;
    }
    let Some(registry) = registry_of(&window) else {
        return false;
    };
    let Some(session) = registry.session_of() else {
        return false;
    };
    registry.handle_reply(&session, &message);
    true
}

/// 供 Lead 在 app 级协议处理器里用：`serve_sandbox_asset(root, "/guest.js")`。
pub fn serve_sandbox_asset(root: &Path, path: &str) -> Option<(&'static str, Vec<u8>)> {
    let relative = path.trim_start_matches('/');
    let relative = if relative.is_empty() { "guest.html" } else { relative };
    if relative.contains("..") || relative.contains('\\') {
        return None;
    }
    let target = root.join(relative);
    let content_type = match relative.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("cjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    fs::read(target).ok().map(|bytes| (content_type, bytes))
}

