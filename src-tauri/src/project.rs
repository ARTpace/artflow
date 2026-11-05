//! 托管项目存储（`artflowStorage`）的 Tauri 2 后端。
//!
//! 上游基线：`storage/projectRepository.cjs`（1739 行）、`main/projectStorageController.cjs`（323 行）、
//! `main/assetImportController.cjs`（232 行）、`main/assetDerivativeController.cjs`（273 行）、
//! `workers/assetPreviewWorker.cjs`（70 行）以及 `main.cjs` 里 `registerStorageIpc()` 的 19 个通道。
//!
//! 移植原则：文案、边界值、校验顺序、特例全部照搬。渲染层从不接触路径与完整哈希，命令的返回形状
//! 就是 `types.ts` 里的 `ArtflowStorageApi` 契约（camelCase），错误以 `Err(String)` 拒绝，
//! 与上游 `throw` 语义一致。
//!
//! 与上游的行为差异（均在交付报告中登记）：
//! 1. 预览派生用 Rust 端直接生成同一份 SVG（上游是 worker_threads 里的纯模板字符串，不读像素），
//!    省掉一个 worker 进程；`preview-card-v1` / `image/svg+xml` 与模板文本逐字节一致。
//! 2. 导入与预览共用一个后台工作线程（上游是两个各自 FIFO 的 controller）。单作业的持久化语义、
//!    状态机、进度、列表顺序与取消规则不变，只是两类作业之间的交错顺序不同。
//! 3. `openPluginDir` 的「应用根目录」在 Tauri 下取可执行文件所在目录（Electron 的 `__dirname`
//!    没有对应物）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::InvokeError;
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

// ———————————————————————————— 常量（与上游逐条对应） ————————————————————————————

/// `STORAGE_SCHEMA_VERSION`
const STORAGE_SCHEMA_VERSION: i64 = 6;
/// `PROJECT_DOCUMENT_FORMAT`
const PROJECT_DOCUMENT_FORMAT: &str = "artflow-project";
/// `PROJECT_DOCUMENT_VERSION`
const PROJECT_DOCUMENT_VERSION: i64 = 2;
/// `STORAGE_REF_PREFIX`
const STORAGE_REF_PREFIX: &str = "artflow-asset://sha256/";
/// `MAX_IMPORT_JOB_DRAFT_BYTES`
const MAX_IMPORT_JOB_DRAFT_BYTES: usize = 64 * 1024;
/// `DEFAULT_VIEWPORT_QUERY_LIMIT`
const DEFAULT_VIEWPORT_QUERY_LIMIT: i64 = 500;
/// `MAX_VIEWPORT_QUERY_LIMIT`
const MAX_VIEWPORT_QUERY_LIMIT: i64 = 5000;
/// `MAX_SPATIAL_COORDINATE`
const MAX_SPATIAL_COORDINATE: f64 = 1e30;
/// `MAX_IMPORT_BYTES`
const MAX_IMPORT_BYTES: usize = 128 * 1024 * 1024;
/// `MAX_DOCUMENT_BYTES`
const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
/// `MAX_VIEWPORT_QUERY_BYTES`
const MAX_VIEWPORT_QUERY_BYTES: usize = 4 * 1024;
/// `MAX_ASSET_INVENTORY_BYTES`
const MAX_ASSET_INVENTORY_BYTES: usize = 4 * 1024;
/// `MAX_ASSET_RECLAIM_BYTES`
const MAX_ASSET_RECLAIM_BYTES: usize = 256 * 1024;
/// `MAX_ASSET_RENAME_BYTES`
const MAX_ASSET_RENAME_BYTES: usize = 16 * 1024;
/// `MAX_IMPORT_ASSET_METADATA_BYTES`
const MAX_IMPORT_ASSET_METADATA_BYTES: usize = 64 * 1024;
/// `MAX_PREVIEW_INPUT_BYTES`
const MAX_PREVIEW_INPUT_BYTES: i64 = 64 * 1024 * 1024;
/// `PREVIEW_RECIPE`
const PREVIEW_RECIPE: &str = "preview-card-v1";
/// `PREVIEW_MIME_TYPE`
const PREVIEW_MIME_TYPE: &str = "image/svg+xml";
/// `MAX_LISTED_IMPORT_JOBS`
const MAX_LISTED_IMPORT_JOBS: usize = 25;
/// `MAX_RECENT_PROJECTS`
const MAX_RECENT_PROJECTS: usize = 12;
/// `RECENT_PROJECTS_KEY`
const RECENT_PROJECTS_KEY: &str = "recent.projects";
/// `RECENT_PROJECTS_VOLUME`
const RECENT_PROJECTS_VOLUME: &str = "recent-files";
/// `MAX_RECENT_PROJECT_PATH`
const MAX_RECENT_PROJECT_PATH: usize = 4096;
/// `SESSION_FILE_NAME`
const SESSION_FILE_NAME: &str = "banana-session.json";

const JOB_STATUSES: [&str; 5] = ["queued", "running", "completed", "cancelled", "failed"];
const TERMINAL_STATUSES: [&str; 3] = ["completed", "cancelled", "failed"];
const ACTIVE_STATUSES: [&str; 2] = ["queued", "running"];
const ASSET_KINDS: [&str; 6] = ["image", "video", "audio", "font", "model3d", "file"];

/// `ASSET_NODE_PROPERTY_FIELDS`
const ASSET_NODE_PROPERTY_FIELDS: [(&str, &[&str]); 6] = [
    ("image", &["href", "originalHref", "mimeType"]),
    ("video", &["href", "mimeType"]),
    ("audio", &["href", "mimeType"]),
    ("font", &["fontUrl", "format", "fileSize"]),
    ("model3d", &["fileUrl", "fileExtension", "fileSize"]),
    ("file", &["fileUrl", "fileExtension", "fileSize", "mimeType"]),
];

fn asset_node_fields(node_type: &str) -> Option<&'static [&'static str]> {
    ASSET_NODE_PROPERTY_FIELDS
        .iter()
        .find(|(name, _)| *name == node_type)
        .map(|(_, fields)| *fields)
}

fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

fn is_active(status: &str) -> bool {
    ACTIVE_STATUSES.contains(&status)
}

// ———————————————————————————— 错误 ————————————————————————————

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorKind {
    /// `ProjectStorageError`
    Storage,
    /// `StorageIntegrityError extends ProjectStorageError`
    Integrity,
    /// 非存储错误的内部失败（上游落在 `WORKER_ERROR` 的那些）
    Worker,
}

/// 上游 `ProjectStorageError` / `StorageIntegrityError` 的合并表示：两者都是「存储错误」，
/// 只有错误码同源的 `Worker` 分支需要单独区分（`STORAGE_ERROR` vs `WORKER_ERROR`）。
#[derive(Debug, Clone)]
pub struct StorageError {
    message: String,
    kind: ErrorKind,
}

impl From<StorageError> for InvokeError {
    fn from(error: StorageError) -> Self {
        InvokeError::from(error.to_string())
    }
}

impl StorageError {
    fn storage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ErrorKind::Storage,
        }
    }

    fn integrity(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ErrorKind::Integrity,
        }
    }

    fn worker(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ErrorKind::Worker,
        }
    }

    fn message(&self) -> &str {
        &self.message
    }

    /// `error instanceof ProjectStorageError ? 'STORAGE_ERROR' : 'WORKER_ERROR'`
    fn code(&self) -> &'static str {
        match self.kind {
            ErrorKind::Worker => "WORKER_ERROR",
            _ => "STORAGE_ERROR",
        }
    }
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        StorageError::storage(error.to_string())
    }
}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        StorageError::storage(error.to_string())
    }
}

type StorageResult<T> = Result<T, StorageError>;

fn wrap(prefix: &str, error: &dyn std::fmt::Display) -> StorageError {
    StorageError::storage(format!("{prefix}: {error}"))
}

// ———————————————————————————— JS 语义helper ————————————————————————————

fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis() as i64,
        Err(_) => 0,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut text = String::with_capacity(64);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

fn as_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

/// `Number.isInteger`
fn as_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            if let Some(int) = number.as_u64() {
                return i64::try_from(int).ok();
            }
            let float = number.as_f64()?;
            if float.is_finite() && float.fract() == 0.0 && float.abs() <= 9.007_199_254_740_992e15 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `Number.isSafeInteger`
fn as_safe_integer(value: &Value) -> Option<i64> {
    as_integer(value).filter(|int| int.abs() <= 9_007_199_254_740_991)
}

/// `String(value)` —— 只用于拼错误文案里的 `${String(x)}`。
fn js_display(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => "".to_string(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `JSON.stringify(value)` 的字节长度（`Buffer.byteLength(serialized)`）。
fn serialized_byte_length(value: &Value) -> Option<usize> {
    serde_json::to_string(value).ok().map(|text| text.len())
}

/// 上游 `asBuffer` 的 Tauri 传输侧等价物：真机走 IPC 时 `Uint8Array` 会被序列化成
/// 数字数组、数字键对象或 base64 字符串（与 `comic.rs` 的 `flexible_bytes` 同一个原因）。
fn as_transfer_bytes(value: Option<&Value>, max_bytes: usize) -> StorageResult<Vec<u8>> {
    let invalid = || StorageError::storage("import bytes must be an ArrayBuffer or typed array");
    let bytes = match value {
        Some(Value::Array(items)) => {
            let mut buffer = Vec::with_capacity(items.len());
            for item in items {
                let byte = match item {
                    Value::Number(number) => match number.as_i64() {
                        Some(int) if (0..=255).contains(&int) => int as u8,
                        _ => return Err(invalid()),
                    },
                    _ => return Err(invalid()),
                };
                buffer.push(byte);
            }
            buffer
        }
        Some(Value::Object(map)) => {
            let mut keyed: Vec<(usize, u8)> = Vec::with_capacity(map.len());
            for (key, item) in map {
                let Ok(index) = key.parse::<usize>() else {
                    return Err(invalid());
                };
                let Value::Number(number) = item else {
                    return Err(invalid());
                };
                let Some(int) = number.as_i64() else {
                    return Err(invalid());
                };
                if !(0..=255).contains(&int) {
                    return Err(invalid());
                }
                keyed.push((index, int as u8));
            }
            keyed.sort_by_key(|(index, _)| *index);
            keyed.into_iter().map(|(_, byte)| byte).collect()
        }
        Some(Value::String(text)) => decode_base64(text).ok_or_else(invalid)?,
        _ => return Err(invalid()),
    };
    if bytes.len() > max_bytes {
        return Err(StorageError::storage(format!(
            "asset import exceeds the {max_bytes} byte IPC limit"
        )));
    }
    Ok(bytes)
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn value_of(character: u8) -> Option<u8> {
        match character {
            b'A'..=b'Z' => Some(character - b'A'),
            b'a'..=b'z' => Some(character - b'a' + 26),
            b'0'..=b'9' => Some(character - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() || cleaned.len() % 4 != 0 {
        return None;
    }
    let mut output = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let mut values = [0u8; 4];
        let mut padding = 0usize;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                if index < 2 {
                    return None;
                }
                padding += 1;
                values[index] = 0;
            } else {
                values[index] = value_of(*byte)?;
            }
        }
        let combined = ((values[0] as u32) << 18)
            | ((values[1] as u32) << 12)
            | ((values[2] as u32) << 6)
            | values[3] as u32;
        output.push((combined >> 16) as u8);
        if padding < 2 {
            output.push((combined >> 8) as u8);
        }
        if padding < 1 {
            output.push(combined as u8);
        }
    }
    Some(output)
}

// ———————————————————————————— 资产记录校验 ————————————————————————————

fn assert_asset_id(value: Option<&Value>) -> StorageResult<String> {
    match value.and_then(|item| item.as_str()) {
        Some(text) if !text.trim().is_empty() => Ok(text.to_string()),
        _ => Err(StorageError::storage("asset id must be a non-empty string")),
    }
}

fn assert_hash(value: &str) -> StorageResult<String> {
    let valid = value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if valid {
        Ok(value.to_string())
    } else {
        Err(StorageError::storage(
            "content hash must be a lower-case SHA-256 hex digest",
        ))
    }
}

fn assert_job_id(value: Option<&Value>, label: &str) -> StorageResult<String> {
    let text = value.and_then(|item| item.as_str()).unwrap_or_default();
    let parts: Vec<&str> = text.split('-').collect();
    let shape_ok = parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts.iter().all(|part| {
            part.bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    if shape_ok {
        Ok(text.to_string())
    } else {
        Err(StorageError::storage(format!(
            "{label} must be a lower-case UUID"
        )))
    }
}

fn assert_job_status(value: Option<&Value>, label: &str) -> StorageResult<String> {
    match value.and_then(|item| item.as_str()) {
        Some(text) if JOB_STATUSES.contains(&text) => Ok(text.to_string()),
        _ => Err(StorageError::storage(format!(
            "unsupported {label} status: {}",
            js_display(value)
        ))),
    }
}

fn assert_job_progress(value: Option<&Value>, label: &str) -> StorageResult<f64> {
    match value.and_then(as_number) {
        Some(number) if (0.0..=1.0).contains(&number) => Ok(number),
        _ => Err(StorageError::storage(format!(
            "{label} progress must be a finite number from 0 through 1"
        ))),
    }
}

fn is_safe_mime_type(mime_type: &str) -> bool {
    let mut parts = mime_type.split('/');
    let (Some(head), Some(tail), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let token_ok = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte)
            })
    };
    token_ok(head) && token_ok(tail)
}

/// controller 侧允许 `; charset=` 后缀，repository 侧不允许（两处正则不同，保持原样）。
fn is_controller_mime_type(mime_type: &str) -> bool {
    let (head, charset) = match mime_type.split_once(';') {
        Some((head, rest)) => (head, Some(rest)),
        None => (mime_type, None),
    };
    if !is_safe_mime_type(head.trim()) {
        return false;
    }
    match charset {
        None => true,
        Some(rest) => {
            let Some(value) = rest.trim_start().strip_prefix("charset=") else {
                return false;
            };
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        }
    }
}

fn normalize_mime_type(value: Option<&Value>) -> String {
    match value.and_then(|item| item.as_str()).map(str::trim) {
        Some(text) if !text.is_empty() && is_controller_mime_type(text) => text.to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn create_storage_ref(hash: &str) -> StorageResult<String> {
    Ok(format!("{STORAGE_REF_PREFIX}{}", assert_hash(hash)?))
}

fn content_hash_from_storage_ref(reference: &Value) -> Option<String> {
    let text = reference.as_str()?;
    let remainder = text.strip_prefix(STORAGE_REF_PREFIX)?;
    assert_hash(remainder).ok()
}

/// `assertAssetRecord`
fn assert_asset_record(asset: &Value) -> StorageResult<()> {
    if !asset.is_object() {
        return Err(StorageError::storage("asset record is required"));
    }
    let id = assert_asset_id(asset.get("id"))?;
    let kind = asset.get("kind").and_then(|item| item.as_str());
    match kind {
        Some(name) if ASSET_KINDS.contains(&name) => {}
        _ => {
            return Err(StorageError::storage(format!(
                "unsupported asset kind: {}",
                js_display(asset.get("kind"))
            )))
        }
    }
    if !asset.get("locator").is_some_and(is_plain_object) {
        return Err(StorageError::storage(format!(
            "asset {id} must include a locator object"
        )));
    }
    if let Some(metadata) = asset.get("metadata") {
        if !metadata.is_null() && !is_plain_object(metadata) {
            return Err(StorageError::storage(format!(
                "asset {id} metadata must be an object"
            )));
        }
    }
    Ok(())
}

fn string_field(map: &Value, key: &str) -> Option<String> {
    map.get(key).and_then(|item| item.as_str()).map(str::to_string)
}

/// `managedLocator`
fn managed_locator(asset: &Value, storage_ref: &str, byte_size: usize) -> Value {
    let source = asset.get("locator");
    let mut locator = Map::new();
    if let Some(mime_type) = source.and_then(|item| string_field(item, "mimeType")) {
        locator.insert("mimeType".into(), Value::String(mime_type));
    }
    if let Some(extension) = source.and_then(|item| string_field(item, "extension")) {
        locator.insert("extension".into(), Value::String(extension));
    }
    if let Some(format) = source.and_then(|item| string_field(item, "format")) {
        locator.insert("format".into(), Value::String(format));
    }
    locator.insert("byteSize".into(), json!(byte_size));
    if asset.get("kind").and_then(|item| item.as_str()) == Some("image") {
        locator.insert("previewRef".into(), Value::String(storage_ref.to_string()));
        locator.insert("originalRef".into(), Value::String(storage_ref.to_string()));
    } else {
        locator.insert("fileRef".into(), Value::String(storage_ref.to_string()));
    }
    Value::Object(locator)
}

/// `managedAssetRecord`
fn managed_asset_record(asset: &Value, content_hash: &str, byte_size: usize) -> Value {
    let storage_ref = format!("{STORAGE_REF_PREFIX}{content_hash}");
    let metadata = match asset.get("metadata") {
        Some(value) if value.is_object() => value.clone(),
        _ => Value::Object(Map::new()),
    };
    json!({
        "id": asset.get("id").cloned().unwrap_or(Value::Null),
        "kind": asset.get("kind").cloned().unwrap_or(Value::Null),
        "sourceKind": "managed-store",
        "locator": managed_locator(asset, &storage_ref, byte_size),
        "metadata": metadata,
    })
}

/// `importDraftFromAsset`：返回（草稿, 序列化结果）。
fn import_draft_from_asset(asset: &Value) -> StorageResult<(Value, String)> {
    assert_asset_record(asset)?;
    let id = asset
        .get("id")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string();
    let metadata = match asset.get("metadata") {
        Some(value) if value.is_object() => value.clone(),
        _ => Value::Object(Map::new()),
    };
    if metadata.as_object().is_none() {
        return Err(StorageError::storage(format!(
            "import asset {id} metadata must be JSON serializable"
        )));
    }
    let source = asset.get("locator");
    let mut locator = Map::new();
    if let Some(mime_type) = source.and_then(|item| string_field(item, "mimeType")) {
        locator.insert("mimeType".into(), Value::String(mime_type));
    }
    if let Some(extension) = source.and_then(|item| string_field(item, "extension")) {
        locator.insert("extension".into(), Value::String(extension));
    }
    if let Some(format) = source.and_then(|item| string_field(item, "format")) {
        locator.insert("format".into(), Value::String(format));
    }
    let draft = json!({
        "id": asset.get("id").cloned().unwrap_or(Value::Null),
        "kind": asset.get("kind").cloned().unwrap_or(Value::Null),
        "locator": Value::Object(locator),
        "metadata": metadata,
    });
    let serialized = serde_json::to_string(&draft).map_err(|error| {
        StorageError::storage(format!(
            "import asset {id} draft must be JSON serializable: {error}"
        ))
    })?;
    if serialized.len() > MAX_IMPORT_JOB_DRAFT_BYTES {
        return Err(StorageError::storage(format!(
            "import asset {id} draft exceeds the {MAX_IMPORT_JOB_DRAFT_BYTES} byte limit"
        )));
    }
    Ok((draft, serialized))
}

/// `importDraftFromJson`
fn import_draft_from_json(serialized: &str) -> StorageResult<Value> {
    let parsed: Value = serde_json::from_str(serialized).map_err(|error| {
        StorageError::integrity(format!("import job draft is not valid JSON: {error}"))
    })?;
    if let Err(error) = assert_asset_record(&parsed) {
        return Err(StorageError::integrity(format!(
            "import job draft is invalid: {}",
            error.message()
        )));
    }
    if let Some(locator) = parsed.get("locator").and_then(|item| item.as_object()) {
        for key in locator.keys() {
            if !matches!(key.as_str(), "mimeType" | "extension" | "format") {
                return Err(StorageError::integrity(
                    "import job draft contains a renderer reference",
                ));
            }
        }
    }
    match import_draft_from_asset(&parsed) {
        Ok((draft, _)) => Ok(draft),
        Err(error) => Err(StorageError::integrity(format!(
            "import job draft is invalid: {}",
            error.message()
        ))),
    }
}

/// `assertAssetDisplayName`
fn assert_asset_display_name(value: Option<&Value>) -> StorageResult<String> {
    let Some(name) = value.and_then(|item| item.as_str()) else {
        return Err(StorageError::storage("asset name must be a string"));
    };
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 180 {
        return Err(StorageError::storage(
            "asset name must be 1 to 180 characters",
        ));
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\\' || character == '/')
    {
        return Err(StorageError::storage("asset name cannot include a path"));
    }
    Ok(trimmed.to_string())
}

/// `assertImportOriginalName`：`undefined`/`null`/`''` 归一成 `None`。
fn assert_import_original_name(value: Option<&Value>) -> StorageResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= 255 => Ok(Some(text.clone())),
        _ => Err(StorageError::storage(
            "import original name must be a string no longer than 255 characters",
        )),
    }
}

/// `assertOriginalName`（controller 侧，`undefined` 原样透传）
fn assert_controller_original_name(value: Option<&Value>) -> StorageResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= 255 => Ok(Some(text.clone())),
        _ => Err(StorageError::storage(
            "original name must be a string no longer than 255 characters",
        )),
    }
}

/// `assertV2Document`
fn assert_v2_document(document: &Value) -> StorageResult<()> {
    let shape_ok = document.is_object()
        && document.get("format").and_then(|item| item.as_str()) == Some(PROJECT_DOCUMENT_FORMAT)
        && as_integer(document.get("version").unwrap_or(&Value::Null))
            == Some(PROJECT_DOCUMENT_VERSION)
        && document.get("assets").is_some_and(|item| item.is_array())
        && document.get("boards").is_some_and(|item| item.is_array())
        && document.get("nodes").is_some_and(|item| item.is_array());
    if shape_ok {
        Ok(())
    } else {
        Err(StorageError::storage(
            "expected a artflow-project v2 document",
        ))
    }
}

/// `operationAssetIds`
fn collect_operation_asset_ids(operation: &Value, target: &mut HashSet<String>) {
    let Some(changes) = operation.get("changes").and_then(|item| item.as_array()) else {
        return;
    };
    for change in changes {
        for key in ["before", "after"] {
            if let Some(id) = change
                .get(key)
                .and_then(|node| node.get("assetId"))
                .and_then(|id| id.as_str())
            {
                target.insert(id.to_string());
            }
        }
    }
}

/// `referencedAssetIds`
fn referenced_asset_ids(document: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Some(nodes) = document.get("nodes").and_then(|item| item.as_array()) {
        for node in nodes {
            if let Some(id) = node.get("assetId").and_then(|item| item.as_str()) {
                ids.insert(id.to_string());
            }
        }
    }
    if let Some(boards) = document.get("boards").and_then(|item| item.as_array()) {
        for board in boards {
            let operations = board
                .get("operationHistory")
                .and_then(|item| item.as_array())
                .cloned()
                .unwrap_or_default();
            for operation in &operations {
                collect_operation_asset_ids(operation, &mut ids);
            }
        }
    }
    ids
}

/// `assertManagedNode`
fn assert_managed_node(
    node: &Value,
    asset_by_id: &HashSet<String>,
    context: &str,
) -> StorageResult<()> {
    if !node.is_object() {
        return Err(StorageError::storage(format!(
            "{context} is not a node record"
        )));
    }
    let node_type = node.get("nodeType").and_then(|item| item.as_str());
    let asset_id = node.get("assetId").and_then(|item| item.as_str());
    let Some(fields) = node_type.and_then(asset_node_fields) else {
        if asset_id.is_some() {
            return Err(StorageError::storage(format!(
                "{context} has an asset id but is not an asset-backed node"
            )));
        }
        return Ok(());
    };
    match asset_id {
        Some(id) if asset_by_id.contains(id) => {}
        _ => {
            return Err(StorageError::storage(format!(
                "{context} references an unmanaged asset"
            )))
        }
    }
    let Some(properties) = node.get("properties") else {
        return Err(StorageError::storage(format!(
            "{context} must contain a properties object"
        )));
    };
    if !is_plain_object(properties) {
        return Err(StorageError::storage(format!(
            "{context} must contain a properties object"
        )));
    }
    for field in fields {
        if properties.get(*field).is_some() {
            return Err(StorageError::storage(format!(
                "{context} leaks asset field {field} into node properties"
            )));
        }
    }
    Ok(())
}

// ———————————————————————————— 空间投影（R-tree） ————————————————————————————

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

#[derive(Debug, Clone)]
struct SpatialEntry {
    board_id: String,
    node_id: String,
    node_type: String,
    parent_id: Option<String>,
    z_index: i64,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

fn assert_spatial_string(value: Option<&Value>, label: &str) -> StorageResult<String> {
    match value.and_then(|item| item.as_str()) {
        Some(text) if !text.is_empty() => Ok(text.to_string()),
        _ => Err(StorageError::storage(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_spatial_number(value: Option<&Value>, label: &str) -> StorageResult<f64> {
    match value.and_then(as_number) {
        Some(number) if number.abs() <= MAX_SPATIAL_COORDINATE => Ok(number),
        _ => Err(StorageError::storage(format!(
            "{label} must be a finite number within the supported R-tree range"
        ))),
    }
}

fn assert_spatial_dimension(value: Option<&Value>, label: &str) -> StorageResult<f64> {
    match value {
        None | Some(Value::Null) => Ok(0.0),
        other => {
            let number = assert_spatial_number(other, label)?;
            if number < 0.0 {
                return Err(StorageError::storage(format!("{label} must be non-negative")));
            }
            Ok(number)
        }
    }
}

fn spatial_bounds(object: &Value, label: &str) -> StorageResult<Bounds> {
    let min_x = assert_spatial_number(object.get("x"), &format!("{label}.x"))?;
    let min_y = assert_spatial_number(object.get("y"), &format!("{label}.y"))?;
    let width = assert_spatial_dimension(object.get("width"), &format!("{label}.width"))?;
    let height = assert_spatial_dimension(object.get("height"), &format!("{label}.height"))?;
    let max_x = assert_spatial_number(Some(&json!(min_x + width)), &format!("{label}.x + width"))?;
    let max_y = assert_spatial_number(
        Some(&json!(min_y + height)),
        &format!("{label}.y + height"),
    )?;
    Ok(Bounds {
        min_x,
        min_y,
        max_x,
        max_y,
    })
}

fn point_bounds(points: &[Value], label: &str) -> StorageResult<Bounds> {
    let mut bounds = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for (index, point) in points.iter().enumerate() {
        if !is_plain_object(point) {
            return Err(StorageError::storage(format!(
                "{label}[{index}] must be a point object"
            )));
        }
        let x = assert_spatial_number(point.get("x"), &format!("{label}[{index}].x"))?;
        let y = assert_spatial_number(point.get("y"), &format!("{label}[{index}].y"))?;
        bounds.min_x = bounds.min_x.min(x);
        bounds.min_y = bounds.min_y.min(y);
        bounds.max_x = bounds.max_x.max(x);
        bounds.max_y = bounds.max_y.max(y);
    }
    Ok(bounds)
}

/// `ownSpatialBounds`
fn own_spatial_bounds(node: &Value, label: &str) -> StorageResult<Bounds> {
    let Some(properties) = node.get("properties") else {
        return Err(StorageError::storage(format!(
            "{label}.properties must be an object"
        )));
    };
    if !is_plain_object(properties) {
        return Err(StorageError::storage(format!(
            "{label}.properties must be an object"
        )));
    }
    let fallback = || spatial_bounds(node, label);
    let node_type = node
        .get("nodeType")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    if !matches!(node_type, "path" | "arrow" | "line") {
        return fallback();
    }
    let Some(points_value) = properties.get("points") else {
        return if node_type == "path" {
            spatial_bounds(&json!({
                "x": node.get("x").cloned().unwrap_or(Value::Null),
                "y": node.get("y").cloned().unwrap_or(Value::Null),
                "width": 0,
                "height": 0,
            }), label)
        } else {
            spatial_bounds(&json!({
                "x": node.get("x").cloned().unwrap_or(Value::Null),
                "y": node.get("y").cloned().unwrap_or(Value::Null),
                "width": 10,
                "height": 10,
            }), label)
        };
    };
    let Some(points) = points_value.as_array() else {
        return Err(StorageError::storage(format!(
            "{label}.properties.points must be an array"
        )));
    };
    let minimum = if node_type == "path" { 1 } else { 2 };
    if points.len() < minimum {
        return if node_type == "path" {
            spatial_bounds(&json!({
                "x": node.get("x").cloned().unwrap_or(Value::Null),
                "y": node.get("y").cloned().unwrap_or(Value::Null),
                "width": 0,
                "height": 0,
            }), label)
        } else {
            spatial_bounds(&json!({
                "x": node.get("x").cloned().unwrap_or(Value::Null),
                "y": node.get("y").cloned().unwrap_or(Value::Null),
                "width": 10,
                "height": 10,
            }), label)
        };
    }
    let slice: &[Value] = if node_type == "path" {
        points.as_slice()
    } else {
        &points[..2]
    };
    point_bounds(slice, &format!("{label}.properties.points"))
}

fn key_for(board_id: &str, node_id: &str) -> String {
    format!("{board_id}\u{0}{node_id}")
}

struct PendingEntry {
    node: Value,
    board_id: String,
    node_id: String,
    node_type: String,
    parent_id: Option<String>,
    z_index: i64,
    key: String,
    label: String,
}

/// `spatialEntriesFromDocument`
fn spatial_entries_from_document(document: &Value) -> StorageResult<Vec<SpatialEntry>> {
    let empty = Vec::new();
    let boards = document
        .get("boards")
        .and_then(|item| item.as_array())
        .unwrap_or(&empty);
    let mut board_ids: HashSet<String> = HashSet::new();
    for board in boards {
        let board_id = assert_spatial_string(board.get("id"), "board id")?;
        if !board_ids.insert(board_id.clone()) {
            return Err(StorageError::storage(format!(
                "duplicate board id: {board_id}"
            )));
        }
    }

    let nodes = document
        .get("nodes")
        .and_then(|item| item.as_array())
        .unwrap_or(&empty);
    let mut entries: Vec<PendingEntry> = Vec::with_capacity(nodes.len());
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for node in nodes {
        let label = format!("node {}", js_display(node.get("id")));
        let board_id = assert_spatial_string(node.get("boardId"), &format!("{label}.boardId"))?;
        let node_id = assert_spatial_string(node.get("id"), &format!("{label}.id"))?;
        if !board_ids.contains(&board_id) {
            return Err(StorageError::storage(format!(
                "{label} references an unknown board: {board_id}"
            )));
        }
        let node_type = assert_spatial_string(node.get("nodeType"), &format!("{label}.nodeType"))?;
        let z_value = assert_spatial_number(node.get("zIndex"), &format!("{label}.zIndex"))?;
        if as_integer(&json!(z_value)).is_none() {
            return Err(StorageError::storage(format!(
                "{label}.zIndex must be an integer"
            )));
        }
        let parent_id = match node.get("parentId") {
            None | Some(Value::Null) => None,
            _ => Some(assert_spatial_string(
                node.get("parentId"),
                &format!("{label}.parentId"),
            )?),
        };
        let key = key_for(&board_id, &node_id);
        if by_key.contains_key(&key) {
            return Err(StorageError::storage(format!(
                "duplicate node id for board {board_id}: {node_id}"
            )));
        }
        by_key.insert(key.clone(), entries.len());
        entries.push(PendingEntry {
            node: node.clone(),
            board_id,
            node_id,
            node_type,
            parent_id,
            z_index: z_value as i64,
            key,
            label,
        });
    }

    // 只有当父节点确实存在且自己是 group 时才建立父子关系（上游同）。
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(parent_id) = &entry.parent_id else {
            continue;
        };
        let parent_key = key_for(&entry.board_id, parent_id);
        if let Some(&parent_index) = by_key.get(&parent_key) {
            if entries[parent_index].node_type == "group" {
                children.entry(parent_key).or_default().push(index);
            }
        }
    }

    let mut states: HashMap<usize, u8> = HashMap::new();
    let mut cache: HashMap<usize, Bounds> = HashMap::new();
    let mut result = Vec::with_capacity(entries.len());
    for index in 0..entries.len() {
        let bounds = resolve_bounds(index, &entries, &children, &mut states, &mut cache)?;
        let entry = &entries[index];
        result.push(SpatialEntry {
            board_id: entry.board_id.clone(),
            node_id: entry.node_id.clone(),
            node_type: entry.node_type.clone(),
            parent_id: entry.parent_id.clone(),
            z_index: entry.z_index,
            min_x: bounds.min_x,
            min_y: bounds.min_y,
            max_x: bounds.max_x,
            max_y: bounds.max_y,
        });
    }
    Ok(result)
}

fn resolve_bounds(
    index: usize,
    entries: &[PendingEntry],
    children: &HashMap<String, Vec<usize>>,
    states: &mut HashMap<usize, u8>,
    cache: &mut HashMap<usize, Bounds>,
) -> StorageResult<Bounds> {
    match states.get(&index).copied() {
        Some(1) => {
            return Err(StorageError::storage(format!(
                "group parent cycle includes node {}",
                entries[index].node_id
            )))
        }
        Some(2) => {
            if let Some(bounds) = cache.get(&index) {
                return Ok(*bounds);
            }
        }
        _ => {}
    }
    states.insert(index, 1);
    let entry = &entries[index];
    let children_of = children.get(&entry.key).cloned().unwrap_or_default();
    let bounds = if children_of.is_empty() {
        own_spatial_bounds(&entry.node, &entry.label)?
    } else {
        let mut union = Bounds {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        };
        for child in &children_of {
            let child_bounds = resolve_bounds(*child, entries, children, states, cache)?;
            union.min_x = union.min_x.min(child_bounds.min_x);
            union.min_y = union.min_y.min(child_bounds.min_y);
            union.max_x = union.max_x.max(child_bounds.max_x);
            union.max_y = union.max_y.max(child_bounds.max_y);
        }
        union
    };
    states.insert(index, 2);
    cache.insert(index, bounds);
    Ok(bounds)
}

fn canonical_viewport_rect(bounds: Bounds) -> Map<String, Value> {
    let mut rect = Map::new();
    rect.insert("x".into(), json!(bounds.min_x));
    rect.insert("y".into(), json!(bounds.min_y));
    rect.insert("width".into(), json!(bounds.max_x - bounds.min_x));
    rect.insert("height".into(), json!(bounds.max_y - bounds.min_y));
    rect
}

fn same_spatial_bounds(left: Bounds, right: Bounds) -> bool {
    left.min_x == right.min_x
        && left.min_y == right.min_y
        && left.max_x == right.max_x
        && left.max_y == right.max_y
}

#[derive(Debug, Clone)]
struct ViewportCursor {
    snapshot_revision: i64,
    after_z: i64,
    after_id: String,
}

#[derive(Debug, Clone)]
struct ViewportQuery {
    board_id: String,
    limit: i64,
    rect: Map<String, Value>,
    bounds: Bounds,
    cursor: Option<ViewportCursor>,
}

fn normalize_viewport_cursor(
    cursor: &Value,
    board_id: &str,
    bounds: Bounds,
) -> StorageResult<ViewportCursor> {
    if !is_plain_object(cursor) {
        return Err(StorageError::storage(
            "viewport query cursor must be an object",
        ));
    }
    let revision = cursor
        .get("snapshotRevision")
        .and_then(as_safe_integer)
        .filter(|value| *value >= 0)
        .ok_or_else(|| {
            StorageError::storage(
                "viewport query cursor snapshotRevision must be a non-negative safe integer",
            )
        })?;
    if cursor.get("boardId").and_then(|item| item.as_str()) != Some(board_id) {
        return Err(StorageError::storage(
            "viewport query cursor boardId does not match request",
        ));
    }
    let Some(rect) = cursor.get("rect") else {
        return Err(StorageError::storage(
            "viewport query cursor rect must be an object",
        ));
    };
    if !is_plain_object(rect) {
        return Err(StorageError::storage(
            "viewport query cursor rect must be an object",
        ));
    }
    let cursor_bounds = spatial_bounds(rect, "viewport query cursor rect")?;
    if !same_spatial_bounds(cursor_bounds, bounds) {
        return Err(StorageError::storage(
            "viewport query cursor rect does not match request",
        ));
    }
    let Some(after) = cursor.get("after") else {
        return Err(StorageError::storage(
            "viewport query cursor after must be an object",
        ));
    };
    if !is_plain_object(after) {
        return Err(StorageError::storage(
            "viewport query cursor after must be an object",
        ));
    }
    let z_value = assert_spatial_number(after.get("zIndex"), "viewport query cursor after.zIndex")?;
    if as_integer(&json!(z_value)).is_none() {
        return Err(StorageError::storage(
            "viewport query cursor after.zIndex must be an integer",
        ));
    }
    Ok(ViewportCursor {
        snapshot_revision: revision,
        after_z: z_value as i64,
        after_id: assert_spatial_string(after.get("id"), "viewport query cursor after.id")?,
    })
}

fn normalize_viewport_query(request: &Value) -> StorageResult<ViewportQuery> {
    if !is_plain_object(request) {
        return Err(StorageError::storage(
            "viewport query request must be an object",
        ));
    }
    let board_id = assert_spatial_string(request.get("boardId"), "viewport query boardId")?;
    if board_id.chars().count() > 512 {
        return Err(StorageError::storage(
            "viewport query boardId exceeds 512 characters",
        ));
    }
    let Some(rect_value) = request.get("rect") else {
        return Err(StorageError::storage(
            "viewport query rect must be an object",
        ));
    };
    if !is_plain_object(rect_value) {
        return Err(StorageError::storage(
            "viewport query rect must be an object",
        ));
    }
    let bounds = spatial_bounds(rect_value, "viewport query rect")?;
    let limit = match request.get("limit") {
        None | Some(Value::Null) => DEFAULT_VIEWPORT_QUERY_LIMIT,
        Some(value) => as_integer(value)
            .filter(|limit| (1..=MAX_VIEWPORT_QUERY_LIMIT).contains(limit))
            .ok_or_else(|| {
                StorageError::storage(
                    "viewport query limit must be an integer from 1 through 5000",
                )
            })?,
    };
    let cursor = match request.get("cursor") {
        None | Some(Value::Null) => None,
        Some(value) => Some(normalize_viewport_cursor(value, &board_id, bounds)?),
    };
    Ok(ViewportQuery {
        board_id,
        limit,
        rect: canonical_viewport_rect(bounds),
        bounds,
        cursor,
    })
}

fn rtree_epsilon(value: f64) -> f64 {
    let scaled = value.abs() * 1e-7;
    if scaled > 1e-6 {
        scaled
    } else {
        1e-6
    }
}

fn rtree_lower_bound(value: f64) -> f64 {
    if value.is_finite() {
        value - rtree_epsilon(value)
    } else {
        value
    }
}

fn rtree_upper_bound(value: f64) -> f64 {
    if value.is_finite() {
        value + rtree_epsilon(value)
    } else {
        value
    }
}
// ———————————————————————————— 仓储（ProjectRepository） ————————————————————————————

/// `ProjectRepository`：SQLite 元数据 + 内容寻址 blob。
///
/// 上游用 `node:sqlite` 的同步 API；这里用 `rusqlite`（bundled SQLite），同一个文件布局、同一套
/// DDL、同一套语句顺序。所有公开方法内部只锁一次连接，避免事务里重入。
pub struct ProjectRepository {
    project_root: PathBuf,
    storage_root: PathBuf,
    blob_root: PathBuf,
    derivative_root: PathBuf,
    import_staging_root: PathBuf,
    #[allow(dead_code)]
    metadata_path: PathBuf,
    conn: Mutex<Connection>,
    closed: AtomicBool,
}

/// `removeIfPresent`：只忽略 `ENOENT`。
fn remove_if_present(path: &Path) -> StorageResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StorageError::storage(error.to_string())),
    }
}

trait IgnoreMissing {
    fn ignore_missing(self) -> bool;
}

impl IgnoreMissing for std::io::Result<()> {
    fn ignore_missing(self) -> bool {
        match self {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        }
    }
}

fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{}-{}-{}", std::process::id(), nanos, count)
}

fn sql_error(message: &str, error: rusqlite::Error) -> StorageError {
    StorageError::storage(format!("{message}: {error}"))
}

fn run_in_transaction<T>(
    conn: &Connection,
    immediate: bool,
    work: impl FnOnce(&Connection) -> StorageResult<T>,
) -> StorageResult<T> {
    conn.execute_batch(if immediate { "BEGIN IMMEDIATE" } else { "BEGIN" })?;
    match work(conn) {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

impl ProjectRepository {
    /// `ProjectRepository.open(projectRoot)`
    pub fn open(project_root: &Path) -> StorageResult<Self> {
        let resolved = if project_root.is_absolute() {
            project_root.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(project_root))
                .unwrap_or_else(|_| project_root.to_path_buf())
        };
        let storage_root = resolved.join(".artflow");
        let blob_root = storage_root.join("blobs").join("sha256");
        let derivative_root = storage_root.join("derivatives").join("sha256");
        let import_staging_root = storage_root.join("import-staging").join("sha256");
        let metadata_path = storage_root.join("metadata.sqlite");
        for directory in [&blob_root, &derivative_root, &import_staging_root] {
            if let Err(error) = fs::create_dir_all(directory) {
                return Err(wrap("failed to open project repository", &error));
            }
        }
        let connection = match Connection::open(&metadata_path) {
            Ok(connection) => connection,
            Err(error) => return Err(wrap("failed to open project repository", &error)),
        };
        let repository = Self {
            project_root: resolved,
            storage_root,
            blob_root,
            derivative_root,
            import_staging_root,
            metadata_path,
            conn: Mutex::new(connection),
            closed: AtomicBool::new(false),
        };
        if let Err(error) = repository.migrate() {
            return Err(error);
        }
        Ok(repository)
    }

    fn assert_open(&self) -> StorageResult<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(StorageError::storage("project repository is closed"));
        }
        Ok(())
    }

    fn lock(&self) -> StorageResult<std::sync::MutexGuard<'_, Connection>> {
        match self.conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => Ok(poisoned.into_inner()),
        }
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    fn get_blob_path(&self, hash: &str) -> StorageResult<PathBuf> {
        Ok(content_path(&self.blob_root, &assert_hash(hash)?))
    }

    fn get_derivative_path(&self, hash: &str) -> StorageResult<PathBuf> {
        Ok(content_path(&self.derivative_root, &assert_hash(hash)?))
    }

    fn get_import_staging_path(&self, hash: &str) -> StorageResult<PathBuf> {
        Ok(content_path(&self.import_staging_root, &assert_hash(hash)?))
    }

    fn migrate(&self) -> StorageResult<()> {
        let guard = self.lock()?;
        let conn = &*guard;
        let _: String =
            conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_metadata (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT,
  extension TEXT,
  format_name TEXT,
  original_name TEXT,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_metadata_by_content_hash ON asset_metadata(content_hash);
CREATE TABLE IF NOT EXISTS project_documents (
  document_key TEXT PRIMARY KEY CHECK (document_key = 'main'),
  format TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS derivative_metadata (
  asset_id TEXT NOT NULL,
  recipe TEXT NOT NULL,
  derivative_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, recipe),
  FOREIGN KEY (asset_id) REFERENCES asset_metadata(asset_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS derivative_metadata_by_hash ON derivative_metadata(derivative_hash);
CREATE TABLE IF NOT EXISTS derivative_job_metadata (
  job_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  recipe TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
  error_code TEXT,
  derivative_hash TEXT,
  derivative_mime_type TEXT,
  derivative_byte_size INTEGER CHECK (derivative_byte_size IS NULL OR derivative_byte_size >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (derivative_hash IS NULL AND derivative_mime_type IS NULL AND derivative_byte_size IS NULL)
    OR (derivative_hash IS NOT NULL AND derivative_mime_type IS NOT NULL AND derivative_byte_size IS NOT NULL)
  ),
  FOREIGN KEY (asset_id) REFERENCES asset_metadata(asset_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS derivative_job_metadata_by_status_created
  ON derivative_job_metadata(status, created_at, job_id);
CREATE TABLE IF NOT EXISTS import_job_metadata (
  job_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  original_name TEXT,
  staging_hash TEXT NOT NULL,
  staging_byte_size INTEGER NOT NULL CHECK (staging_byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
  error_code TEXT,
  result_content_hash TEXT,
  result_byte_size INTEGER CHECK (result_byte_size IS NULL OR result_byte_size >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (result_content_hash IS NULL AND result_byte_size IS NULL)
    OR (result_content_hash IS NOT NULL AND result_byte_size IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS import_job_metadata_by_status_created
  ON import_job_metadata(status, created_at, job_id);
CREATE TABLE IF NOT EXISTS board_node_spatial_metadata (
  spatial_id INTEGER PRIMARY KEY,
  board_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  parent_id TEXT,
  z_index INTEGER NOT NULL,
  min_x REAL NOT NULL,
  max_x REAL NOT NULL,
  min_y REAL NOT NULL,
  max_y REAL NOT NULL,
  UNIQUE (board_id, node_id)
);
CREATE INDEX IF NOT EXISTS board_node_spatial_by_board_order
  ON board_node_spatial_metadata(board_id, z_index, node_id);
CREATE VIRTUAL TABLE IF NOT EXISTS board_node_spatial_index
  USING rtree(spatial_id, min_x, max_x, min_y, max_y);
CREATE TABLE IF NOT EXISTS spatial_projection_metadata (
  projection_key TEXT PRIMARY KEY CHECK (projection_key = 'main'),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);",
        )?;

        let schema_row: Option<String> = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let existing_version = match &schema_row {
            None => None,
            Some(raw) => {
                let parsed: Option<i64> = raw.trim().parse::<i64>().ok();
                match parsed {
                    Some(value) if value <= STORAGE_SCHEMA_VERSION => Some(value),
                    _ => {
                        return Err(StorageError::storage(format!(
                            "unsupported storage schema version: {raw}"
                        )))
                    }
                }
            }
        };

        let document_row: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM project_documents WHERE document_key = 'main'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        run_in_transaction(conn, true, |conn| {
            let needs_backfill = existing_version
                .map(|version| version < STORAGE_SCHEMA_VERSION)
                .unwrap_or(true);
            if needs_backfill {
                if let Some(payload) = &document_row {
                    let document: Value = serde_json::from_str(payload).map_err(|error| {
                        StorageError::integrity(format!(
                            "cannot backfill spatial index from stored project document: {error}"
                        ))
                    })?;
                    if let Err(error) = assert_managed_document(conn, &document) {
                        return Err(StorageError::integrity(format!(
                            "cannot backfill spatial index from stored project document: {}",
                            error.message()
                        )));
                    }
                    let entries =
                        spatial_entries_from_document(&document).map_err(|error| {
                            StorageError::integrity(format!(
                                "cannot backfill spatial index from stored project document: {}",
                                error.message()
                            ))
                        })?;
                    replace_spatial_index(conn, &entries)?;
                }
            }
            seed_spatial_revision(conn, i64::from(document_row.is_some()))?;
            match existing_version {
                None => {
                    conn.execute(
                        "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?1)",
                        params![STORAGE_SCHEMA_VERSION.to_string()],
                    )?;
                }
                Some(version) if version < STORAGE_SCHEMA_VERSION => {
                    conn.execute(
                        "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                        params![STORAGE_SCHEMA_VERSION.to_string()],
                    )?;
                }
                Some(_) => {}
            }
            Ok(())
        })
    }

    // ———————————————— 资产 ————————————————

    /// `putAsset`
    pub fn put_asset(
        &self,
        asset: &Value,
        bytes: &[u8],
        original_name: Option<&str>,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        assert_asset_record(asset)?;
        let content_hash = sha256_hex(bytes);
        let blob_created = self.materialize_content(
            &self.blob_root,
            &content_hash,
            bytes,
            "blob",
        )?;
        let now = now_ms();
        let managed = managed_asset_record(asset, &content_hash, bytes.len());
        let id = assert_asset_id(asset.get("id"))?;
        let kind = asset
            .get("kind")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let locator = managed.get("locator").cloned().unwrap_or(Value::Null);
        let mime_type = string_field(&locator, "mimeType");
        let extension = string_field(&locator, "extension");
        let format = string_field(&locator, "format");
        let metadata_json = serde_json::to_string(
            managed.get("metadata").unwrap_or(&Value::Null),
        )
        .unwrap_or_else(|_| "{}".to_string());
        let stored_name = original_name.filter(|name| !name.is_empty()).map(str::to_string);
        let guard = self.lock()?;
        let conn = &*guard;
        conn.execute(
            "INSERT INTO asset_metadata(asset_id, kind, content_hash, byte_size, mime_type, extension, format_name, original_name, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(asset_id) DO UPDATE SET
               kind = excluded.kind,
               content_hash = excluded.content_hash,
               byte_size = excluded.byte_size,
               mime_type = excluded.mime_type,
               extension = excluded.extension,
               format_name = excluded.format_name,
               original_name = excluded.original_name,
               metadata_json = excluded.metadata_json,
               updated_at = excluded.updated_at",
            params![
                id,
                kind,
                content_hash,
                bytes.len() as i64,
                mime_type,
                extension,
                format,
                stored_name,
                metadata_json,
                now,
                now
            ],
        )
        .map_err(|error| sql_error(&format!("failed to record asset {id}"), error))?;
        Ok(json!({
            "asset": managed,
            "contentHash": content_hash,
            "byteSize": bytes.len(),
            "blobCreated": blob_created,
        }))
    }

    /// `#metadataFromRow` 的结果（`getAsset` 的返回形状）
    fn metadata_from_row(&self, row: Option<AssetRow>) -> StorageResult<Option<Value>> {
        let Some(row) = row else {
            return Ok(None);
        };
        let metadata: Value = serde_json::from_str(&row.metadata_json).map_err(|error| {
            StorageError::integrity(format!(
                "metadata for asset {} is not valid JSON: {error}",
                row.asset_id
            ))
        })?;
        let mut locator = Map::new();
        if let Some(mime_type) = &row.mime_type {
            locator.insert("mimeType".into(), Value::String(mime_type.clone()));
        }
        if let Some(extension) = &row.extension {
            locator.insert("extension".into(), Value::String(extension.clone()));
        }
        if let Some(format) = &row.format_name {
            locator.insert("format".into(), Value::String(format.clone()));
        }
        let asset = json!({
            "id": row.asset_id,
            "kind": row.kind,
            "locator": Value::Object(locator),
            "metadata": metadata,
        });
        let managed = managed_asset_record(&asset, &row.content_hash, row.byte_size.max(0) as usize);
        let mut payload = Map::new();
        payload.insert("asset".into(), managed);
        payload.insert("contentHash".into(), Value::String(row.content_hash));
        payload.insert("byteSize".into(), json!(row.byte_size));
        if let Some(original_name) = row.original_name.filter(|name| !name.is_empty()) {
            payload.insert("originalName".into(), Value::String(original_name));
        }
        payload.insert("createdAt".into(), json!(row.created_at));
        payload.insert("updatedAt".into(), json!(row.updated_at));
        Ok(Some(Value::Object(payload)))
    }

    pub fn get_asset(&self, asset_id: Option<&Value>) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let id = assert_asset_id(asset_id)?;
        let guard = self.lock()?;
        let conn = &*guard;
        let row = load_asset_row(conn, &id)?;
        self.metadata_from_row(row)
    }

    fn get_asset_by_content_hash(&self, hash: &str) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let hash = assert_hash(hash)?;
        let guard = self.lock()?;
        let conn = &*guard;
        let row = conn
            .query_row(
                "SELECT asset_id, kind, content_hash, byte_size, mime_type, extension, format_name, original_name, metadata_json, created_at, updated_at
                 FROM asset_metadata WHERE content_hash = ?1
                 ORDER BY CASE WHEN mime_type IS NULL OR mime_type = 'application/octet-stream' THEN 1 ELSE 0 END,
                          updated_at DESC, asset_id ASC LIMIT 1",
                params![hash],
                asset_row_from_sql,
            )
            .optional()?;
        self.metadata_from_row(row)
    }

    /// `readBlob`
    fn read_blob(&self, hash: &str) -> StorageResult<Vec<u8>> {
        let path = self.get_blob_path(hash)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(StorageError::integrity(format!("blob {hash} is missing")))
            }
            Err(error) => return Err(wrap(&format!("failed to read blob {hash}"), &error)),
        };
        if sha256_hex(&bytes) != hash {
            return Err(StorageError::integrity(format!(
                "blob {hash} failed content hash verification"
            )));
        }
        Ok(bytes)
    }

    /// `readAssetBytes`
    pub fn read_asset_bytes(&self, asset_id: Option<&Value>) -> StorageResult<Vec<u8>> {
        self.assert_open()?;
        let id = assert_asset_id(asset_id)?;
        let Some(stored) = self.get_asset(Some(&Value::String(id.clone())))? else {
            return Err(StorageError::storage(format!("unknown asset id: {id}")));
        };
        let hash = stored
            .get("contentHash")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        self.read_blob(&hash)
    }

    // ———————————————— 内容寻址写入 ————————————————

    /// `#materializeContent`
    fn materialize_content(
        &self,
        root: &Path,
        content_hash: &str,
        bytes: &[u8],
        label: &str,
    ) -> StorageResult<bool> {
        let final_path = content_path(root, content_hash);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::read(&final_path) {
            Ok(existing) => {
                if sha256_hex(&existing) != content_hash {
                    return Err(StorageError::integrity(format!(
                        "existing {label} {content_hash} does not match its path hash"
                    )));
                }
                return Ok(false);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(wrap(
                    &format!("failed to inspect {label} {content_hash}"),
                    &error,
                ))
            }
        }
        let temporary = final_path.with_file_name(format!(
            "{}.tmp-{}",
            final_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            unique_suffix()
        ));
        {
            use std::io::Write;
            let mut handle = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(handle) => handle,
                Err(error) => {
                    return Err(wrap(
                        &format!("failed to atomically materialize {label} {content_hash}"),
                        &error,
                    ))
                }
            };
            if let Err(error) = handle.write_all(bytes) {
                let _ = fs::remove_file(&temporary);
                return Err(wrap(
                    &format!("failed to atomically materialize {label} {content_hash}"),
                    &error,
                ));
            }
        }
        match fs::rename(&temporary, &final_path) {
            Ok(()) => Ok(true),
            Err(error) => {
                let winner = fs::read(&final_path).ok();
                let _ = remove_if_present(&temporary);
                match winner {
                    Some(existing) if sha256_hex(&existing) == content_hash => Ok(false),
                    _ => Err(wrap(
                        &format!("failed to atomically materialize {label} {content_hash}"),
                        &error,
                    )),
                }
            }
        }
    }

    // ———————————————— 派生（derivative） ————————————————

    fn assert_derivative_recipe(value: Option<&Value>) -> StorageResult<String> {
        let text = value.and_then(|item| item.as_str()).unwrap_or_default();
        let bytes = text.as_bytes();
        let valid = !bytes.is_empty()
            && bytes.len() <= 64
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..].iter().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        if valid {
            Ok(text.to_string())
        } else {
            Err(StorageError::storage(
                "derivative recipe must be a safe identifier",
            ))
        }
    }

    /// `putDerivative`
    pub fn put_derivative(
        &self,
        asset_id: Option<&Value>,
        recipe: Option<&Value>,
        bytes: &[u8],
        mime_type: Option<&Value>,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        let asset_id = assert_asset_id(asset_id)?;
        let recipe = Self::assert_derivative_recipe(recipe)?;
        if self.get_asset(Some(&Value::String(asset_id.clone())))?.is_none() {
            return Err(StorageError::storage(format!(
                "unknown asset id: {asset_id}"
            )));
        }
        let mime_type = mime_type.and_then(|item| item.as_str()).unwrap_or_default();
        if !is_safe_mime_type(mime_type) {
            return Err(StorageError::storage("derivative MIME type is invalid"));
        }
        let content_hash = sha256_hex(bytes);
        let blob_created = self.materialize_content(
            &self.derivative_root,
            &content_hash,
            bytes,
            "derivative",
        )?;
        let now = now_ms();
        let guard = self.lock()?;
        let conn = &*guard;
        conn.execute(
            "INSERT INTO derivative_metadata(asset_id, recipe, derivative_hash, mime_type, byte_size, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(asset_id, recipe) DO UPDATE SET
               derivative_hash = excluded.derivative_hash,
               mime_type = excluded.mime_type,
               byte_size = excluded.byte_size,
               updated_at = excluded.updated_at",
            params![
                asset_id,
                recipe,
                content_hash,
                mime_type,
                bytes.len() as i64,
                now,
                now
            ],
        )
        .map_err(|error| {
            sql_error(&format!("failed to record derivative for {asset_id}"), error)
        })?;
        Ok(json!({
            "assetId": asset_id,
            "recipe": recipe,
            "contentHash": content_hash,
            "mimeType": mime_type,
            "byteSize": bytes.len(),
            "blobCreated": blob_created,
        }))
    }

    /// `getDerivative(assetId, recipe)`
    pub fn get_derivative(
        &self,
        asset_id: Option<&Value>,
        recipe: Option<&Value>,
    ) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let asset_id = assert_asset_id(asset_id)?;
        let recipe = Self::assert_derivative_recipe(recipe)?;
        let guard = self.lock()?;
        let conn = &*guard;
        let row = conn
            .query_row(
                "SELECT asset_id, recipe, derivative_hash, mime_type, byte_size, created_at, updated_at
                 FROM derivative_metadata WHERE asset_id = ?1 AND recipe = ?2",
                params![asset_id, recipe],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(asset_id, recipe, hash, mime_type, byte_size, created_at, updated_at)| {
            json!({
                "assetId": asset_id,
                "recipe": recipe,
                "contentHash": hash,
                "mimeType": mime_type,
                "byteSize": byte_size,
                "createdAt": created_at,
                "updatedAt": updated_at,
            })
        }))
    }

    /// `readDerivative`
    #[allow(dead_code)]
    fn read_derivative(&self, asset_id: &str, recipe: &str) -> StorageResult<Vec<u8>> {
        let Some(record) = self.get_derivative(
            Some(&Value::String(asset_id.to_string())),
            Some(&Value::String(recipe.to_string())),
        )?
        else {
            return Err(StorageError::storage(format!(
                "unknown derivative: {asset_id}/{recipe}"
            )));
        };
        let hash = record
            .get("contentHash")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let path = self.get_derivative_path(&hash)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(StorageError::integrity(format!(
                    "derivative {hash} is missing"
                )))
            }
            Err(error) => {
                return Err(wrap(&format!("failed to read derivative {hash}"), &error))
            }
        };
        if sha256_hex(&bytes) != hash {
            return Err(StorageError::integrity(format!(
                "derivative {hash} failed content hash verification"
            )));
        }
        Ok(bytes)
    }

    // ———————————————— 派生作业 ————————————————

    pub fn get_derivative_job(&self, job_id: Option<&Value>) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let job_id = assert_job_id(job_id, "derivative job id")?;
        let guard = self.lock()?;
        let conn = &*guard;
        Ok(load_derivative_job(conn, &job_id)?
            .map(|row| row.into_value()))
    }

    pub fn list_derivative_jobs(&self) -> StorageResult<Vec<Value>> {
        self.assert_open()?;
        let guard = self.lock()?;
        let conn = &*guard;
        let mut statement = conn.prepare(
            "SELECT job_id, asset_id, recipe, status, progress, error_code, derivative_hash,
                    derivative_mime_type, derivative_byte_size, created_at, updated_at
             FROM derivative_job_metadata ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = statement.query_map([], derivative_job_from_sql)?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row?.into_value());
        }
        Ok(jobs)
    }

    pub fn create_derivative_job(
        &self,
        job_id: &str,
        asset_id: Option<&Value>,
        recipe: Option<&Value>,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        let job_id = assert_job_id(Some(&Value::String(job_id.to_string())), "derivative job id")?;
        let asset_id = assert_asset_id(asset_id)?;
        let recipe = Self::assert_derivative_recipe(recipe)?;
        if self.get_asset(Some(&Value::String(asset_id.clone())))?.is_none() {
            return Err(StorageError::storage(format!(
                "unknown asset id: {asset_id}"
            )));
        }
        let now = now_ms();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "INSERT INTO derivative_job_metadata(job_id, asset_id, recipe, status, progress, error_code,
                    derivative_hash, derivative_mime_type, derivative_byte_size, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'queued', 0, NULL, NULL, NULL, NULL, ?4, ?4)",
                params![job_id, asset_id, recipe, now],
            )
            .map_err(|error| {
                sql_error(&format!("failed to create derivative job {job_id}"), error)
            })?;
        }
        self.get_derivative_job(Some(&Value::String(job_id)))
            .map(|job| job.unwrap_or(Value::Null))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_derivative_job(
        &self,
        job_id: Option<&Value>,
        status: Option<&Value>,
        progress: Option<&Value>,
        error_code: Option<&Value>,
        derivative: Option<&Value>,
        has_derivative: bool,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        let job_id = assert_job_id(job_id, "derivative job id")?;
        let current = self
            .get_derivative_job(Some(&Value::String(job_id.clone())))?
            .ok_or_else(|| {
                StorageError::storage(format!("unknown derivative job: {job_id}"))
            })?;
        let status = assert_job_status(status, "derivative job")?;
        let progress = assert_job_progress(progress, "derivative job")?;
        let error_code = match error_code {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 128 => {
                Some(text.clone())
            }
            Some(_) => {
                return Err(StorageError::storage(
                    "derivative job error code is invalid",
                ))
            }
        };
        let asset_id = current
            .get("assetId")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let recipe = current
            .get("recipe")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let next_derivative: Option<(String, String, i64)> = if has_derivative {
            normalize_derivative_job_derivative(derivative, &asset_id, &recipe)?
        } else {
            current.get("derivative").and_then(|value| {
                if value.is_null() {
                    None
                } else {
                    Some((
                        value
                            .get("contentHash")
                            .and_then(|item| item.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        value
                            .get("mimeType")
                            .and_then(|item| item.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        value.get("byteSize").and_then(as_integer).unwrap_or(0),
                    ))
                }
            })
        };
        let (hash, mime_type, byte_size) = match &next_derivative {
            Some((hash, mime_type, byte_size)) => {
                (Some(hash.clone()), Some(mime_type.clone()), Some(*byte_size))
            }
            None => (None, None, None),
        };
        let now = now_ms();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "UPDATE derivative_job_metadata SET status = ?1, progress = ?2, error_code = ?3,
                    derivative_hash = ?4, derivative_mime_type = ?5, derivative_byte_size = ?6,
                    updated_at = ?7 WHERE job_id = ?8",
                params![status, progress, error_code, hash, mime_type, byte_size, now, job_id],
            )
            .map_err(|error| {
                sql_error(&format!("failed to update derivative job {job_id}"), error)
            })?;
        }
        self.get_derivative_job(Some(&Value::String(job_id)))
            .map(|job| job.unwrap_or(Value::Null))
    }

    /// `recoverDerivativeJobs`
    pub fn recover_derivative_jobs(&self) -> StorageResult<Vec<Value>> {
        self.assert_open()?;
        let now = now_ms();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "UPDATE derivative_job_metadata SET status = 'queued', progress = 0,
                    error_code = NULL, updated_at = ?1 WHERE status = 'running'",
                params![now],
            )
            .map_err(|error| sql_error("failed to recover derivative jobs", error))?;
        }
        self.list_derivative_jobs()
    }

    // ———————————————— 导入作业 ————————————————

    pub fn get_import_job(&self, job_id: Option<&Value>) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let job_id = assert_job_id(job_id, "import job id")?;
        let guard = self.lock()?;
        let conn = &*guard;
        match load_import_job(conn, &job_id)? {
            Some(row) => Ok(Some(row.into_value()?)),
            None => Ok(None),
        }
    }

    pub fn list_import_jobs(&self) -> StorageResult<Vec<Value>> {
        self.assert_open()?;
        let guard = self.lock()?;
        let conn = &*guard;
        let mut statement = conn.prepare(
            "SELECT job_id, asset_id, asset_json, original_name, staging_hash, staging_byte_size,
                    status, progress, error_code, result_content_hash, result_byte_size,
                    created_at, updated_at
             FROM import_job_metadata ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = statement.query_map([], import_job_from_sql)?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row?.into_value()?);
        }
        Ok(jobs)
    }

    /// `stageImport`
    pub fn stage_import(
        &self,
        job_id: &str,
        asset: &Value,
        bytes: &[u8],
        original_name: Option<&str>,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        let job_id = assert_job_id(Some(&Value::String(job_id.to_string())), "import job id")?;
        let (draft, serialized) = import_draft_from_asset(asset)?;
        let staging_hash = sha256_hex(bytes);
        self.materialize_content(
            &self.import_staging_root,
            &staging_hash,
            bytes,
            "import staging",
        )?;
        let now = now_ms();
        let draft_id = draft
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "INSERT INTO import_job_metadata(job_id, asset_id, asset_json, original_name, staging_hash,
                    staging_byte_size, status, progress, error_code, result_content_hash, result_byte_size,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, NULL, NULL, NULL, ?7, ?7)",
                params![
                    job_id,
                    draft_id,
                    serialized,
                    original_name.map(str::to_string),
                    staging_hash,
                    bytes.len() as i64,
                    now
                ],
            )
            .map_err(|error| sql_error(&format!("failed to create import job {job_id}"), error))?;
        }
        self.get_import_job(Some(&Value::String(job_id)))
            .map(|job| job.unwrap_or(Value::Null))
    }

    /// `updateImportJob`
    pub fn update_import_job(
        &self,
        job_id: Option<&Value>,
        status: Option<&Value>,
        progress: Option<&Value>,
        error_code: Option<&Value>,
        result: Option<&Value>,
        has_result: bool,
    ) -> StorageResult<Value> {
        self.assert_open()?;
        let job_id = assert_job_id(job_id, "import job id")?;
        let current = self
            .get_import_job(Some(&Value::String(job_id.clone())))?
            .ok_or_else(|| StorageError::storage(format!("unknown import job: {job_id}")))?;
        let status = assert_job_status(status, "import job")?;
        let progress = assert_job_progress(progress, "import job")?;
        let error_code = match error_code {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 128 => {
                Some(text.clone())
            }
            Some(_) => {
                return Err(StorageError::storage("import job error code is invalid"))
            }
        };
        let next_result: Option<(String, i64)> = if has_result {
            normalize_import_job_result(result, &current)?
        } else {
            current
                .get("result")
                .and_then(|value| {
                    if value.is_null() {
                        None
                    } else {
                        Some((
                            value
                                .get("contentHash")
                                .and_then(|item| item.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            value.get("byteSize").and_then(as_integer).unwrap_or(0),
                        ))
                    }
                })
        };
        if status == "completed" && (next_result.is_none() || progress != 1.0 || error_code.is_some())
        {
            return Err(StorageError::storage(
                "completed import job must have a result, progress 1 and no error code",
            ));
        }
        if status != "completed" && next_result.is_some() {
            return Err(StorageError::storage(
                "only a completed import job may have a result",
            ));
        }
        let (hash, byte_size) = match &next_result {
            Some((hash, byte_size)) => (Some(hash.clone()), Some(*byte_size)),
            None => (None, None),
        };
        let now = now_ms();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "UPDATE import_job_metadata SET status = ?1, progress = ?2, error_code = ?3,
                    result_content_hash = ?4, result_byte_size = ?5, updated_at = ?6
                 WHERE job_id = ?7",
                params![status, progress, error_code, hash, byte_size, now, job_id],
            )
            .map_err(|error| sql_error(&format!("failed to update import job {job_id}"), error))?;
        }
        self.get_import_job(Some(&Value::String(job_id)))
            .map(|job| job.unwrap_or(Value::Null))
    }

    /// `recoverImportJobs`
    pub fn recover_import_jobs(&self) -> StorageResult<Vec<Value>> {
        self.assert_open()?;
        let now = now_ms();
        {
            let guard = self.lock()?;
            let conn = &*guard;
            conn.execute(
                "UPDATE import_job_metadata SET status = 'queued', progress = 0,
                    error_code = NULL, updated_at = ?1 WHERE status = 'running'",
                params![now],
            )
            .map_err(|error| sql_error("failed to recover import jobs", error))?;
        }
        self.list_import_jobs()
    }

    /// `readImportJobBytes`
    pub fn read_import_job_bytes(&self, job_id: Option<&Value>) -> StorageResult<Vec<u8>> {
        self.assert_open()?;
        let job_id_text = assert_job_id(job_id, "import job id")?;
        let Some(job) = self.get_import_job(Some(&Value::String(job_id_text.clone())))? else {
            return Err(StorageError::storage(format!(
                "unknown import job: {job_id_text}"
            )));
        };
        let hash = job
            .get("stagingHash")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let expected_size = job.get("stagingByteSize").and_then(as_integer).unwrap_or(-1);
        let path = self.get_import_staging_path(&hash)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(StorageError::integrity(format!(
                    "import staging {hash} is missing"
                )))
            }
            Err(error) => {
                return Err(wrap(
                    &format!("failed to read import staging {hash}"),
                    &error,
                ))
            }
        };
        if bytes.len() as i64 != expected_size || sha256_hex(&bytes) != hash {
            return Err(StorageError::integrity(format!(
                "import staging {hash} failed integrity verification"
            )));
        }
        Ok(bytes)
    }

    // ———————————————— 文档 ————————————————

    /// `saveProjectDocument`
    pub fn save_project_document(&self, document: &Value) -> StorageResult<()> {
        self.assert_open()?;
        let guard = self.lock()?;
        let conn = &*guard;
        if let Err(error) = assert_managed_document(conn, document) {
            return Err(error);
        }
        let payload = serde_json::to_string(document)
            .map_err(|error| StorageError::storage(error.to_string()))?;
        let entries = spatial_entries_from_document(document)?;
        run_in_transaction(conn, true, |conn| {
            conn.execute(
                "INSERT INTO project_documents(document_key, format, version, payload_json, updated_at)
                 VALUES ('main', ?1, ?2, ?3, ?4)
                 ON CONFLICT(document_key) DO UPDATE SET
                   format = excluded.format,
                   version = excluded.version,
                   payload_json = excluded.payload_json,
                   updated_at = excluded.updated_at",
                params![
                    PROJECT_DOCUMENT_FORMAT,
                    PROJECT_DOCUMENT_VERSION,
                    payload,
                    now_ms()
                ],
            )
            .map_err(|error| {
                StorageError::storage(format!(
                    "failed to save project document and spatial index: {error}"
                ))
            })?;
            replace_spatial_index(conn, &entries).map_err(|error| {
                StorageError::storage(format!(
                    "failed to save project document and spatial index: {}",
                    error.message()
                ))
            })?;
            advance_spatial_revision(conn).map_err(|error| {
                StorageError::storage(format!(
                    "failed to save project document and spatial index: {}",
                    error.message()
                ))
            })?;
            Ok(())
        })
    }

    /// `loadProjectDocument`
    pub fn load_project_document(&self) -> StorageResult<Option<Value>> {
        self.assert_open()?;
        let guard = self.lock()?;
        let conn = &*guard;
        let payload: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM project_documents WHERE document_key = 'main'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(payload) = payload else {
            return Ok(None);
        };
        let document: Value = serde_json::from_str(&payload).map_err(|error| {
            StorageError::integrity(format!(
                "stored project document is not valid JSON: {error}"
            ))
        })?;
        assert_managed_document(conn, &document)?;
        Ok(Some(document))
    }

    // ———————————————— 视口查询 ————————————————

    pub fn query_viewport(&self, request: &Value) -> StorageResult<Value> {
        self.assert_open()?;
        let query = normalize_viewport_query(request)?;
        let guard = self.lock()?;
        let conn = &*guard;
        run_in_transaction(conn, false, |conn| {
            let snapshot_revision = read_spatial_revision(conn)?;
            if let Some(cursor) = &query.cursor {
                if cursor.snapshot_revision != snapshot_revision {
                    return Err(StorageError::storage(
                        "viewport query cursor snapshot is stale; restart from the first page",
                    ));
                }
            }
            let bounds = query.bounds;
            let base = "SELECT metadata.node_id, metadata.board_id, metadata.node_type,
                               metadata.parent_id, metadata.z_index, metadata.min_x, metadata.max_x,
                               metadata.min_y, metadata.max_y
                        FROM board_node_spatial_metadata AS metadata
                        INNER JOIN board_node_spatial_index AS rtree
                          ON rtree.spatial_id = metadata.spatial_id
                        WHERE metadata.board_id = ?1
                          AND rtree.max_x >= ?2 AND rtree.min_x <= ?3
                          AND rtree.max_y >= ?4 AND rtree.min_y <= ?5
                          AND metadata.max_x >= ?6 AND metadata.min_x <= ?7
                          AND metadata.max_y >= ?8 AND metadata.min_y <= ?9";
            let mut rows: Vec<ViewportRow> = Vec::new();
            match &query.cursor {
                Some(cursor) => {
                    let sql = format!(
                        "{base} AND (metadata.z_index > ?10 OR (metadata.z_index = ?11 AND metadata.node_id > ?12)) ORDER BY metadata.z_index ASC, metadata.node_id ASC LIMIT ?13"
                    );
                    let mut statement = conn.prepare(&sql)?;
                    let mapped = statement.query_map(
                        params![
                            query.board_id,
                            rtree_lower_bound(bounds.min_x),
                            rtree_upper_bound(bounds.max_x),
                            rtree_lower_bound(bounds.min_y),
                            rtree_upper_bound(bounds.max_y),
                            bounds.min_x,
                            bounds.max_x,
                            bounds.min_y,
                            bounds.max_y,
                            cursor.after_z,
                            cursor.after_z,
                            cursor.after_id,
                            query.limit + 1
                        ],
                        viewport_row_from_sql,
                    )?;
                    for row in mapped {
                        rows.push(row?);
                    }
                }
                None => {
                    let sql =
                        format!("{base} ORDER BY metadata.z_index ASC, metadata.node_id ASC LIMIT ?10");
                    let mut statement = conn.prepare(&sql)?;
                    let mapped = statement.query_map(
                        params![
                            query.board_id,
                            rtree_lower_bound(bounds.min_x),
                            rtree_upper_bound(bounds.max_x),
                            rtree_lower_bound(bounds.min_y),
                            rtree_upper_bound(bounds.max_y),
                            bounds.min_x,
                            bounds.max_x,
                            bounds.min_y,
                            bounds.max_y,
                            query.limit + 1
                        ],
                        viewport_row_from_sql,
                    )?;
                    for row in mapped {
                        rows.push(row?);
                    }
                }
            }
            let limit = query.limit.max(0) as usize;
            let truncated = rows.len() > limit;
            let page_rows: Vec<ViewportRow> = rows.iter().take(limit).cloned().collect();
            let nodes: Vec<Value> = page_rows
                .iter()
                .map(|row| {
                    let mut node = Map::new();
                    node.insert("id".into(), Value::String(row.node_id.clone()));
                    node.insert("boardId".into(), Value::String(row.board_id.clone()));
                    node.insert("nodeType".into(), Value::String(row.node_type.clone()));
                    if let Some(parent_id) = &row.parent_id {
                        node.insert("parentId".into(), Value::String(parent_id.clone()));
                    }
                    node.insert("zIndex".into(), json!(row.z_index));
                    node.insert(
                        "bounds".into(),
                        json!({
                            "x": row.min_x,
                            "y": row.min_y,
                            "width": row.max_x - row.min_x,
                            "height": row.max_y - row.min_y,
                        }),
                    );
                    Value::Object(node)
                })
                .collect();
            let next_cursor = match (truncated, page_rows.last()) {
                (true, Some(last)) => json!({
                    "snapshotRevision": snapshot_revision,
                    "boardId": query.board_id,
                    "rect": Value::Object(query.rect.clone()),
                    "after": { "zIndex": last.z_index, "id": last.node_id },
                }),
                _ => Value::Null,
            };
            Ok(json!({
                "nodes": nodes,
                "truncated": truncated,
                "snapshotRevision": snapshot_revision,
                "nextCursor": next_cursor,
            }))
        })
    }

    // ———————————————— 资产清单 / 重命名 / 回收 ————————————————

    fn usage_sets(&self, conn: &Connection) -> StorageResult<(HashSet<String>, HashSet<String>)> {
        let mut document_ids = HashSet::new();
        let payload: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM project_documents WHERE document_key = 'main'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(payload) = payload {
            let document: Value = serde_json::from_str(&payload).map_err(|error| {
                StorageError::integrity(format!(
                    "stored project document is not valid JSON: {error}"
                ))
            })?;
            assert_managed_document(conn, &document)?;
            if let Some(assets) = document.get("assets").and_then(|item| item.as_array()) {
                for asset in assets {
                    if let Some(id) = asset.get("id").and_then(|item| item.as_str()) {
                        document_ids.insert(id.to_string());
                    }
                }
            }
        }
        let mut import_ids = HashSet::new();
        let mut statement = conn.prepare(
            "SELECT asset_id FROM import_job_metadata WHERE status IN ('queued', 'running')",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            import_ids.insert(row?);
        }
        Ok((document_ids, import_ids))
    }

    fn fill_protected(
        conn: &Connection,
        document_ids: &HashSet<String>,
        import_ids: &HashSet<String>,
    ) -> StorageResult<()> {
        conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS inventory_protected (asset_id TEXT PRIMARY KEY)")?;
        conn.execute("DELETE FROM inventory_protected", [])?;
        let mut statement =
            conn.prepare("INSERT OR IGNORE INTO inventory_protected(asset_id) VALUES (?1)")?;
        for id in document_ids {
            statement.execute(params![id])?;
        }
        for id in import_ids {
            statement.execute(params![id])?;
        }
        Ok(())
    }

    /// `listAssetInventory`
    pub fn list_asset_inventory(&self, request: &Value) -> StorageResult<Value> {
        self.assert_open()?;
        let offset = match request.get("offset") {
            None | Some(Value::Null) => 0,
            Some(value) => as_integer(value)
                .filter(|offset| (0..=100_000).contains(offset))
                .ok_or_else(|| {
                    StorageError::storage(
                        "asset inventory offset must be an integer from 0 to 100000",
                    )
                })?,
        };
        let limit = match request.get("limit") {
            None | Some(Value::Null) => 50,
            Some(value) => as_integer(value)
                .filter(|limit| (1..=100).contains(limit))
                .ok_or_else(|| {
                    StorageError::storage("asset inventory limit must be an integer from 1 to 100")
                })?,
        };
        let unreferenced_only = match request.get("unreferencedOnly") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                return Err(StorageError::storage(
                    "asset inventory unreferencedOnly must be a boolean",
                ))
            }
        };
        let guard = self.lock()?;
        let conn = &*guard;
        let (document_ids, import_ids) = self.usage_sets(conn)?;
        Self::fill_protected(conn, &document_ids, &import_ids)?;
        let where_clause = if unreferenced_only {
            "WHERE NOT EXISTS (SELECT 1 FROM inventory_protected protected WHERE protected.asset_id = asset_metadata.asset_id)"
        } else {
            ""
        };
        let (total_assets, unique_blobs): (i64, i64) = conn.query_row(
            "SELECT COUNT(*) AS assets, COUNT(DISTINCT content_hash) AS blobs FROM asset_metadata",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let unique_bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM (SELECT MAX(byte_size) AS byte_size FROM asset_metadata GROUP BY content_hash)",
            [],
            |row| row.get(0),
        )?;
        let unreferenced_assets: i64 = conn.query_row(
            "SELECT COUNT(*) AS assets FROM asset_metadata WHERE NOT EXISTS (SELECT 1 FROM inventory_protected protected WHERE protected.asset_id = asset_metadata.asset_id)",
            [],
            |row| row.get(0),
        )?;
        let sql = format!(
            "SELECT asset_id, kind, byte_size, mime_type, original_name, content_hash, updated_at
             FROM asset_metadata
             {where_clause}
             ORDER BY updated_at DESC, asset_id ASC
             LIMIT ?1 OFFSET ?2"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params![limit, offset], |row| {
            Ok(InventoryRow {
                asset_id: row.get(0)?,
                kind: row.get(1)?,
                byte_size: row.get(2)?,
                mime_type: row.get(3)?,
                original_name: row.get(4)?,
                content_hash: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        let mut items = Vec::new();
        for row in rows {
            let row = row?;
            let usage = if document_ids.contains(&row.asset_id) {
                "document"
            } else if import_ids.contains(&row.asset_id) {
                "import"
            } else {
                "none"
            };
            items.push(json!({
                "id": row.asset_id,
                "kind": row.kind,
                "byteSize": row.byte_size,
                "mimeType": row.mime_type.unwrap_or_default(),
                "originalName": row.original_name.unwrap_or_default(),
                "hashPrefix": row.content_hash.chars().take(12).collect::<String>(),
                "updatedAt": row.updated_at,
                "usage": usage,
            }));
        }
        Ok(json!({
            "totalAssets": total_assets,
            "uniqueBlobs": unique_blobs,
            "uniqueBytes": unique_bytes,
            "unreferencedAssets": unreferenced_assets,
            "items": items,
        }))
    }

    /// `renameAssetNames`
    pub fn rename_asset_names(&self, request: &Value) -> StorageResult<Value> {
        self.assert_open()?;
        let Some(changes) = request.get("changes").and_then(|item| item.as_array()) else {
            return Err(StorageError::storage("rename requires 1 to 40 assets"));
        };
        if changes.is_empty() || changes.len() > 40 {
            return Err(StorageError::storage("rename requires 1 to 40 assets"));
        }
        let mut planned: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for change in changes {
            if !is_plain_object(change) {
                return Err(StorageError::storage("rename change must be an object"));
            }
            let id = assert_asset_id(change.get("id"))?;
            if !seen.insert(id.clone()) {
                return Err(StorageError::storage("duplicate asset id"));
            }
            let name = assert_asset_display_name(change.get("name"))?;
            planned.push((id, name));
        }
        let guard = self.lock()?;
        let conn = &*guard;
        let now = now_ms();
        let mut renamed = Vec::new();
        let mut missing = Vec::new();
        run_in_transaction(conn, true, |conn| {
            for (id, name) in &planned {
                let exists: Option<String> = conn
                    .query_row(
                        "SELECT asset_id FROM asset_metadata WHERE asset_id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    missing.push(id.clone());
                    continue;
                }
                conn.execute(
                    "UPDATE asset_metadata SET original_name = ?1, updated_at = ?2 WHERE asset_id = ?3",
                    params![name, now, id],
                )?;
                renamed.push(id.clone());
            }
            Ok(())
        })?;
        Ok(json!({ "renamed": renamed, "missing": missing }))
    }

    /// `reclaimUnreferencedAssets`
    pub fn reclaim_unreferenced_assets(&self, request: &Value) -> StorageResult<Value> {
        self.assert_open()?;
        let Some(asset_ids) = request.get("assetIds").and_then(|item| item.as_array()) else {
            return Err(StorageError::storage("reclaim requires 1 to 40 asset ids"));
        };
        if asset_ids.is_empty() || asset_ids.len() > 40 {
            return Err(StorageError::storage("reclaim requires 1 to 40 asset ids"));
        }
        let protect_ids_is_valid = match request.get("protectIds") {
            None | Some(Value::Null) => true,
            Some(Value::Array(items)) => items.len() <= 8000,
            Some(_) => false,
        };
        if !protect_ids_is_valid {
            return Err(StorageError::storage(
                "protect ids must be an array of at most 8000 ids",
            ));
        }
        let requested: Vec<String> = asset_ids
            .iter()
            .map(|id| assert_asset_id(Some(id)))
            .collect::<StorageResult<_>>()?;
        let mut extra: HashSet<String> = HashSet::new();
        if let Some(Value::Array(ids)) = request.get("protectIds") {
            for id in ids {
                extra.insert(assert_asset_id(Some(id))?);
            }
        }
        let guard = self.lock()?;
        let conn = &*guard;
        let (document_ids, import_ids) = self.usage_sets(conn)?;
        let mut removed: Vec<String> = Vec::new();
        let mut kept: Vec<String> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let mut files: Vec<PathBuf> = Vec::new();
        let mut freed_bytes: i64 = 0;
        let outcome: StorageResult<()> = run_in_transaction(conn, true, |conn| {
            for id in &requested {
                let Some(row) = load_asset_row(conn, id)? else {
                    missing.push(id.clone());
                    continue;
                };
                if document_ids.contains(id) || import_ids.contains(id) || extra.contains(id) {
                    kept.push(id.clone());
                    continue;
                }
                let mut derivative_hashes: Vec<String> = Vec::new();
                {
                    let mut statement = conn.prepare(
                        "SELECT derivative_hash FROM derivative_metadata WHERE asset_id = ?1",
                    )?;
                    let rows =
                        statement.query_map(params![id], |row| row.get::<_, String>(0))?;
                    for hash in rows {
                        derivative_hashes.push(hash?);
                    }
                }
                conn.execute("DELETE FROM asset_metadata WHERE asset_id = ?1", params![id])?;
                let remaining: i64 = conn.query_row(
                    "SELECT COUNT(*) AS total FROM asset_metadata WHERE content_hash = ?1",
                    params![row.content_hash],
                    |result| result.get(0),
                )?;
                if remaining == 0 {
                    files.push(self.get_blob_path(&row.content_hash)?);
                    freed_bytes += row.byte_size;
                }
                for hash in &derivative_hashes {
                    let remaining: i64 = conn.query_row(
                        "SELECT COUNT(*) AS total FROM derivative_metadata WHERE derivative_hash = ?1",
                        params![hash],
                        |result| result.get(0),
                    )?;
                    if remaining == 0 {
                        files.push(self.get_derivative_path(hash)?);
                    }
                }
                removed.push(id.clone());
            }
            Ok(())
        });
        if let Err(error) = outcome {
            return Err(error);
        }
        for path in &files {
            remove_if_present(path)?;
        }
        Ok(json!({
            "removed": removed,
            "kept": kept,
            "missing": missing,
            "freedBytes": freed_bytes,
        }))
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // `Connection` 归 `Mutex` 所有，`close()` 需要按值取出，所以先换成一个空连接再关。
        let placeholder = match Connection::open_in_memory() {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let owned = match self.conn.lock() {
            Ok(mut guard) => std::mem::replace(&mut *guard, placeholder),
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                std::mem::replace(&mut *guard, placeholder)
            }
        };
        let _ = owned.close();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

fn content_path(root: &Path, hash: &str) -> PathBuf {
    let prefix: String = hash.chars().take(2).collect();
    root.join(prefix).join(hash)
}

#[derive(Debug, Clone)]
struct AssetRow {
    asset_id: String,
    kind: String,
    content_hash: String,
    byte_size: i64,
    mime_type: Option<String>,
    extension: Option<String>,
    format_name: Option<String>,
    original_name: Option<String>,
    metadata_json: String,
    created_at: i64,
    updated_at: i64,
}

fn asset_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        asset_id: row.get(0)?,
        kind: row.get(1)?,
        content_hash: row.get(2)?,
        byte_size: row.get(3)?,
        mime_type: row.get(4)?,
        extension: row.get(5)?,
        format_name: row.get(6)?,
        original_name: row.get(7)?,
        metadata_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn load_asset_row(conn: &Connection, asset_id: &str) -> StorageResult<Option<AssetRow>> {
    Ok(conn
        .query_row(
            "SELECT asset_id, kind, content_hash, byte_size, mime_type, extension, format_name,
                    original_name, metadata_json, created_at, updated_at
             FROM asset_metadata WHERE asset_id = ?1",
            params![asset_id],
            asset_row_from_sql,
        )
        .optional()?)
}

#[derive(Debug, Clone)]
struct InventoryRow {
    asset_id: String,
    kind: String,
    byte_size: i64,
    mime_type: Option<String>,
    original_name: Option<String>,
    content_hash: String,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct ViewportRow {
    node_id: String,
    board_id: String,
    node_type: String,
    parent_id: Option<String>,
    z_index: i64,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn viewport_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<ViewportRow> {
    Ok(ViewportRow {
        node_id: row.get(0)?,
        board_id: row.get(1)?,
        node_type: row.get(2)?,
        parent_id: row.get(3)?,
        z_index: row.get(4)?,
        min_x: row.get(5)?,
        max_x: row.get(6)?,
        min_y: row.get(7)?,
        max_y: row.get(8)?,
    })
}

struct DerivativeJobRow {
    job_id: String,
    asset_id: String,
    recipe: String,
    status: String,
    progress: f64,
    error_code: Option<String>,
    derivative_hash: Option<String>,
    derivative_mime_type: Option<String>,
    derivative_byte_size: Option<i64>,
}

impl DerivativeJobRow {
    fn into_value(self) -> Value {
        let derivative = match self.derivative_hash {
            Some(hash) => json!({
                "assetId": self.asset_id,
                "recipe": self.recipe,
                "contentHash": hash,
                "mimeType": self.derivative_mime_type,
                "byteSize": self.derivative_byte_size,
            }),
            None => Value::Null,
        };
        json!({
            "id": self.job_id,
            "assetId": self.asset_id,
            "recipe": self.recipe,
            "status": self.status,
            "progress": self.progress,
            "errorCode": match self.error_code {
                Some(code) if !code.is_empty() => Value::String(code),
                _ => Value::Null,
            },
            "derivative": derivative,
        })
    }
}

fn derivative_job_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<DerivativeJobRow> {
    Ok(DerivativeJobRow {
        job_id: row.get(0)?,
        asset_id: row.get(1)?,
        recipe: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        error_code: row.get(5)?,
        derivative_hash: row.get(6)?,
        derivative_mime_type: row.get(7)?,
        derivative_byte_size: row.get(8)?,
    })
}

fn load_derivative_job(conn: &Connection, job_id: &str) -> StorageResult<Option<DerivativeJobRow>> {
    Ok(conn
        .query_row(
            "SELECT job_id, asset_id, recipe, status, progress, error_code, derivative_hash,
                    derivative_mime_type, derivative_byte_size, created_at, updated_at
             FROM derivative_job_metadata WHERE job_id = ?1",
            params![job_id],
            derivative_job_from_sql,
        )
        .optional()?)
}

fn normalize_derivative_job_derivative(
    derivative: Option<&Value>,
    asset_id: &str,
    recipe: &str,
) -> StorageResult<Option<(String, String, i64)>> {
    let Some(value) = derivative else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !is_plain_object(value) {
        return Err(StorageError::storage(
            "derivative job result must be an object or null",
        ));
    }
    if value.get("assetId").and_then(|item| item.as_str()) != Some(asset_id)
        || value.get("recipe").and_then(|item| item.as_str()) != Some(recipe)
    {
        return Err(StorageError::storage(
            "derivative job result does not match its asset/recipe",
        ));
    }
    let hash = assert_hash(
        value
            .get("contentHash")
            .and_then(|item| item.as_str())
            .unwrap_or_default(),
    )?;
    let mime_type = value.get("mimeType").and_then(|item| item.as_str()).unwrap_or_default();
    if !is_safe_mime_type(mime_type) {
        return Err(StorageError::storage(
            "derivative job result MIME type is invalid",
        ));
    }
    let byte_size = value
        .get("byteSize")
        .and_then(as_integer)
        .filter(|size| *size >= 0)
        .ok_or_else(|| StorageError::storage("derivative job result byte size is invalid"))?;
    Ok(Some((hash, mime_type.to_string(), byte_size)))
}

struct ImportJobRow {
    job_id: String,
    asset_id: String,
    asset_json: String,
    original_name: Option<String>,
    staging_hash: String,
    staging_byte_size: i64,
    status: String,
    progress: f64,
    error_code: Option<String>,
    result_content_hash: Option<String>,
    result_byte_size: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

impl ImportJobRow {
    fn into_value(self) -> StorageResult<Value> {
        let draft = import_draft_from_json(&self.asset_json)?;
        if draft.get("id").and_then(|item| item.as_str()) != Some(self.asset_id.as_str()) {
            return Err(StorageError::integrity(format!(
                "import job {} asset id does not match its draft",
                self.job_id
            )));
        }
        let result = match &self.result_content_hash {
            Some(hash) => json!({
                "asset": managed_asset_record(
                    &draft,
                    hash,
                    self.result_byte_size.unwrap_or(0).max(0) as usize,
                ),
                "contentHash": hash,
                "byteSize": self.result_byte_size,
            }),
            None => Value::Null,
        };
        let mut value = Map::new();
        value.insert("id".into(), Value::String(self.job_id));
        value.insert("assetId".into(), Value::String(self.asset_id));
        value.insert("draft".into(), draft);
        if let Some(name) = self.original_name.filter(|name| !name.is_empty()) {
            value.insert("originalName".into(), Value::String(name));
        }
        value.insert("stagingHash".into(), Value::String(self.staging_hash));
        value.insert("stagingByteSize".into(), json!(self.staging_byte_size));
        value.insert("status".into(), Value::String(self.status));
        value.insert("progress".into(), json!(self.progress));
        value.insert(
            "errorCode".into(),
            match self.error_code {
                Some(code) if !code.is_empty() => Value::String(code),
                _ => Value::Null,
            },
        );
        value.insert("result".into(), result);
        value.insert("createdAt".into(), json!(self.created_at));
        value.insert("updatedAt".into(), json!(self.updated_at));
        Ok(Value::Object(value))
    }
}

fn import_job_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportJobRow> {
    Ok(ImportJobRow {
        job_id: row.get(0)?,
        asset_id: row.get(1)?,
        asset_json: row.get(2)?,
        original_name: row.get(3)?,
        staging_hash: row.get(4)?,
        staging_byte_size: row.get(5)?,
        status: row.get(6)?,
        progress: row.get(7)?,
        error_code: row.get(8)?,
        result_content_hash: row.get(9)?,
        result_byte_size: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn load_import_job(conn: &Connection, job_id: &str) -> StorageResult<Option<ImportJobRow>> {
    Ok(conn
        .query_row(
            "SELECT job_id, asset_id, asset_json, original_name, staging_hash, staging_byte_size,
                    status, progress, error_code, result_content_hash, result_byte_size,
                    created_at, updated_at
             FROM import_job_metadata WHERE job_id = ?1",
            params![job_id],
            import_job_from_sql,
        )
        .optional()?)
}

fn normalize_import_job_result(
    result: Option<&Value>,
    current: &Value,
) -> StorageResult<Option<(String, i64)>> {
    let Some(value) = result else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !is_plain_object(value) {
        return Err(StorageError::storage(
            "import job result must be an object or null",
        ));
    }
    let hash = assert_hash(
        value
            .get("contentHash")
            .and_then(|item| item.as_str())
            .unwrap_or_default(),
    )?;
    let byte_size = value
        .get("byteSize")
        .and_then(as_integer)
        .filter(|size| *size >= 0)
        .ok_or_else(|| StorageError::storage("import job result byte size is invalid"))?;
    let staging_hash = current
        .get("stagingHash")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let staging_byte_size = current
        .get("stagingByteSize")
        .and_then(as_integer)
        .unwrap_or(-1);
    if hash != staging_hash || byte_size != staging_byte_size {
        return Err(StorageError::storage(
            "import job result does not match its staged bytes",
        ));
    }
    if let Some(asset) = value.get("asset") {
        if !asset.is_null() {
            let draft = current.get("draft").cloned().unwrap_or(Value::Null);
            let same_id = asset.get("id").and_then(|item| item.as_str())
                == current.get("assetId").and_then(|item| item.as_str());
            let same_kind = asset.get("kind").and_then(|item| item.as_str())
                == draft.get("kind").and_then(|item| item.as_str());
            if !same_id || !same_kind {
                return Err(StorageError::storage(
                    "import job result asset does not match its draft",
                ));
            }
        }
    }
    Ok(Some((hash, byte_size)))
}

/// `#assertManagedDocument`
fn assert_managed_document(conn: &Connection, document: &Value) -> StorageResult<()> {
    assert_v2_document(document)?;
    let empty = Vec::new();
    let assets = document
        .get("assets")
        .and_then(|item| item.as_array())
        .unwrap_or(&empty);
    let mut asset_by_id: HashSet<String> = HashSet::new();
    for asset in assets {
        let id = assert_asset_id(asset.get("id"))?;
        if !asset_by_id.insert(id.clone()) {
            return Err(StorageError::storage(format!(
                "duplicate document asset id: {id}"
            )));
        }
        if asset.get("sourceKind").and_then(|item| item.as_str()) != Some("managed-store") {
            return Err(StorageError::storage(format!(
                "document asset {id} is not managed by the content store"
            )));
        }
        let kind = asset.get("kind").and_then(|item| item.as_str()).unwrap_or_default();
        let locator = asset.get("locator").cloned().unwrap_or(Value::Null);
        let reference = if kind == "image" {
            locator.get("originalRef").cloned().unwrap_or(Value::Null)
        } else {
            locator.get("fileRef").cloned().unwrap_or(Value::Null)
        };
        let Some(content_hash) = content_hash_from_storage_ref(&reference) else {
            return Err(StorageError::storage(format!(
                "document asset {id} has no canonical managed storage reference"
            )));
        };
        let stored = load_asset_row(conn, &id)?;
        let Some(stored) = stored else {
            return Err(StorageError::storage(format!(
                "document asset {id} is not backed by matching metadata"
            )));
        };
        if stored.content_hash != content_hash {
            return Err(StorageError::storage(format!(
                "document asset {id} is not backed by matching metadata"
            )));
        }
        let locator_byte_size = locator.get("byteSize").and_then(as_integer);
        if locator_byte_size != Some(stored.byte_size) {
            return Err(StorageError::storage(format!(
                "document asset {id} byte size does not match metadata"
            )));
        }
        for key in ["previewRef", "originalRef", "fileRef"] {
            if let Some(value) = locator.get(key) {
                if !value.is_null() && content_hash_from_storage_ref(value).is_none() {
                    return Err(StorageError::storage(format!(
                        "document asset {id} contains a non-canonical storage locator"
                    )));
                }
            }
        }
        if kind == "image" {
            let preview = locator
                .get("previewRef")
                .and_then(content_hash_from_storage_ref);
            if preview != Some(content_hash.clone()) {
                return Err(StorageError::storage(format!(
                    "managed image {id} must use the same original and preview storage reference"
                )));
            }
        }
    }
    let nodes = document
        .get("nodes")
        .and_then(|item| item.as_array())
        .unwrap_or(&empty);
    for node in nodes {
        assert_managed_node(node, &asset_by_id, &format!("node {}", js_display(node.get("id"))))?;
    }
    let boards = document
        .get("boards")
        .and_then(|item| item.as_array())
        .unwrap_or(&empty);
    for board in boards {
        let Some(operations) = board.get("operationHistory").and_then(|item| item.as_array()) else {
            return Err(StorageError::storage(format!(
                "board {} has invalid operation history",
                js_display(board.get("id"))
            )));
        };
        for operation in operations {
            let Some(changes) = operation.get("changes").and_then(|item| item.as_array()) else {
                return Err(StorageError::storage(format!(
                    "operation {} has invalid changes",
                    js_display(operation.get("id"))
                )));
            };
            for change in changes {
                for key in ["before", "after"] {
                    if let Some(node) = change.get(key) {
                        let context = format!(
                            "operation {} {key} node {}",
                            js_display(operation.get("id")),
                            js_display(node.get("id"))
                        );
                        assert_managed_node(node, &asset_by_id, &context)?;
                    }
                }
            }
        }
    }
    for id in referenced_asset_ids(document) {
        if !asset_by_id.contains(&id) {
            return Err(StorageError::storage(format!(
                "document references missing asset {id}"
            )));
        }
    }
    Ok(())
}

fn replace_spatial_index(conn: &Connection, entries: &[SpatialEntry]) -> StorageResult<()> {
    conn.execute_batch(
        "DELETE FROM board_node_spatial_index;
DELETE FROM board_node_spatial_metadata;",
    )?;
    let mut metadata_statement = conn.prepare(
        "INSERT INTO board_node_spatial_metadata(spatial_id, board_id, node_id, node_type, parent_id,
            z_index, min_x, max_x, min_y, max_y) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    let mut index_statement = conn.prepare(
        "INSERT INTO board_node_spatial_index(spatial_id, min_x, max_x, min_y, max_y)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (offset, entry) in entries.iter().enumerate() {
        let spatial_id = offset as i64 + 1;
        metadata_statement.execute(params![
            spatial_id,
            entry.board_id,
            entry.node_id,
            entry.node_type,
            entry.parent_id,
            entry.z_index,
            entry.min_x,
            entry.max_x,
            entry.min_y,
            entry.max_y
        ])?;
        index_statement.execute(params![
            spatial_id,
            entry.min_x,
            entry.max_x,
            entry.min_y,
            entry.max_y
        ])?;
    }
    Ok(())
}

fn seed_spatial_revision(conn: &Connection, revision: i64) -> StorageResult<()> {
    if revision < 0 || revision > 9_007_199_254_740_991 {
        return Err(StorageError::storage(
            "initial spatial projection revision must be a non-negative safe integer",
        ));
    }
    conn.execute(
        "INSERT OR IGNORE INTO spatial_projection_metadata(projection_key, revision) VALUES ('main', ?1)",
        params![revision],
    )?;
    Ok(())
}

fn read_spatial_revision(conn: &Connection) -> StorageResult<i64> {
    let value: Option<i64> = conn
        .query_row(
            "SELECT revision FROM spatial_projection_metadata WHERE projection_key = 'main'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    match value {
        Some(revision) if revision >= 0 => Ok(revision),
        _ => Err(StorageError::integrity(
            "spatial projection revision metadata is invalid",
        )),
    }
}

fn advance_spatial_revision(conn: &Connection) -> StorageResult<()> {
    let current = read_spatial_revision(conn)?;
    if current >= 9_007_199_254_740_991 {
        return Err(StorageError::storage(
            "spatial projection revision exceeds the safe integer range",
        ));
    }
    conn.execute(
        "UPDATE spatial_projection_metadata SET revision = ?1 WHERE projection_key = 'main'",
        params![current + 1],
    )?;
    Ok(())
}
// ———————————————————————————— 控制器（ProjectStorageController） ————————————————————————————

/// 导入作业的运行时形态（`runtimeJob`）。
#[derive(Clone)]
struct ImportJob {
    id: String,
    asset_id: String,
    draft: Value,
    original_name: Option<String>,
    status: String,
    progress: f64,
    error_code: Option<String>,
    result: Option<Value>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    cancel_requested: bool,
}

/// 预览作业的运行时形态（`runtimeJob`）。
#[derive(Clone)]
struct PreviewJob {
    id: String,
    asset_id: String,
    recipe: String,
    status: String,
    progress: f64,
    error_code: Option<String>,
    derivative: Option<Value>,
    cancel_requested: bool,
}

fn opt_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(as_integer)
}

impl ImportJob {
    fn from_record(record: &Value) -> TrackingResult<Self> {
        let id = record
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(Self {
            id,
            asset_id: record
                .get("assetId")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            draft: record.get("draft").cloned().unwrap_or(Value::Null),
            original_name: record
                .get("originalName")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            status: record
                .get("status")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            progress: record.get("progress").and_then(as_number).unwrap_or(0.0),
            error_code: record
                .get("errorCode")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            result: match record.get("result") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.clone()),
            },
            created_at: opt_i64(record.get("createdAt")),
            updated_at: opt_i64(record.get("updatedAt")),
            cancel_requested: false,
        })
    }

    /// `displayNameFor`
    fn display_name(&self) -> String {
        let candidate = match &self.original_name {
            Some(name) => name.clone(),
            None => match self
                .draft
                .get("metadata")
                .and_then(|metadata| metadata.get("originalName"))
                .and_then(|name| name.as_str())
            {
                Some(name) => name.to_string(),
                None => self.asset_id.clone(),
            },
        };
        let basename = candidate
            .split(|character| character == '\\' || character == '/')
            .filter(|part| !part.is_empty())
            .next_back();
        match basename {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => self.asset_id.clone(),
        }
    }

    /// `snapshot`
    fn snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "assetId": self.asset_id,
            "displayName": self.display_name(),
            "status": self.status,
            "progress": self.progress,
            "errorCode": match &self.error_code {
                Some(code) if !code.is_empty() => Value::String(code.clone()),
                _ => Value::Null,
            },
            "result": self.result.clone().unwrap_or(Value::Null),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
}

impl PreviewJob {
    fn from_record(record: &Value) -> Self {
        Self {
            id: record
                .get("id")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            asset_id: record
                .get("assetId")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            recipe: record
                .get("recipe")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            status: record
                .get("status")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            progress: record.get("progress").and_then(as_number).unwrap_or(0.0),
            error_code: record
                .get("errorCode")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            derivative: match record.get("derivative") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.clone()),
            },
            cancel_requested: false,
        }
    }

    fn snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "assetId": self.asset_id,
            "recipe": self.recipe,
            "status": self.status,
            "progress": self.progress,
            "errorCode": match &self.error_code {
                Some(code) if !code.is_empty() => Value::String(code.clone()),
                _ => Value::Null,
            },
            "derivative": self.derivative.clone().unwrap_or(Value::Null),
        })
    }
}

type TrackingResult<T> = Result<T, StorageError>;

/// 取消信号：上游用 `ImportCancelledError` / `JobCancelledError` 两个类；这里共用一个标记。
struct Cancelled;

impl std::fmt::Debug for Cancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Cancelled")
    }
}

#[derive(Debug)]
enum JobFailure {
    Cancelled,
    Storage(StorageError),
}

impl From<StorageError> for JobFailure {
    fn from(error: StorageError) -> Self {
        JobFailure::Storage(error)
    }
}

struct StorageState {
    project_root: Option<PathBuf>,
    repository: Option<Arc<ProjectRepository>>,
    import_jobs: HashMap<String, ImportJob>,
    import_order: Vec<String>,
    import_queue: VecDeque<String>,
    import_draining: bool,
    preview_jobs: HashMap<String, PreviewJob>,
    preview_queue: VecDeque<String>,
    preview_draining: bool,
    safe_mode: bool,
}

/// 托管工程存储的进程级状态。
///
/// 上游是两个 `ProjectStorageController` 各持一个 repository 与两个 controller；这里合并成一个
/// 可共享状态：repository 唯一，两个 FIFO 队列（导入 / 预览）各自串行，语义与上游逐条对应。
pub struct ProjectStorage {
    inner: Mutex<StorageState>,
    session_path: Option<PathBuf>,
}

impl std::fmt::Debug for ProjectStorage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ProjectStorage")
    }
}

impl ProjectStorage {
    fn new(session_path: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(StorageState {
                project_root: None,
                repository: None,
                import_jobs: HashMap::new(),
                import_order: Vec::new(),
                import_queue: VecDeque::new(),
                import_draining: false,
                preview_jobs: HashMap::new(),
                preview_queue: VecDeque::new(),
                preview_draining: false,
                safe_mode: false,
            }),
            session_path,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StorageState> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn require_repository(&self) -> TrackingResult<Arc<ProjectRepository>> {
        let state = self.lock();
        state
            .repository
            .clone()
            .ok_or_else(|| StorageError::storage("no managed project is open"))
    }

    /// 适配 `sandbox::AssetStorage`：把项目资产清单请求转给已打开的仓库。
    pub fn list_asset_inventory(&self, request: &Value) -> StorageResult<Value> {
        self.require_repository()?.list_asset_inventory(request)
    }

    /// 适配 `sandbox::AssetStorage`：把资产重命名请求转给已打开的仓库。
    pub fn rename_asset_names(&self, request: &Value) -> StorageResult<Value> {
        self.require_repository()?.rename_asset_names(request)
    }

    /// `status`
    fn status(&self) -> Value {
        let state = self.lock();
        let is_open = state.repository.is_some();
        let project_name = match &state.project_root {
            None => Value::Null,
            Some(root) => {
                let text = root.to_string_lossy().into_owned();
                match root.file_name().map(|name| name.to_string_lossy().into_owned()) {
                    Some(name) if !name.is_empty() => Value::String(name),
                    _ => Value::String(text),
                }
            }
        };
        json!({ "isOpen": is_open, "projectName": project_name })
    }

    // ———————————————— 会话文件 ————————————————

    fn read_persisted_session(&self) -> Option<String> {
        let path = self.session_path.as_ref()?;
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                eprintln!("Failed to read Artflow project session: {error}");
                return None;
            }
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(data) => data
                .get("lastProjectRoot")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string),
            Err(error) => {
                eprintln!("Failed to read Artflow project session: {error}");
                None
            }
        }
    }

    fn persist_session(&self, project_root: &Path) -> Option<()> {
        let path = self.session_path.as_ref()?;
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("Failed to persist Artflow project session: {error}");
                return None;
            }
        }
        let payload = json!({
            "lastProjectRoot": project_root.to_string_lossy(),
            "savedAt": now_ms(),
        });
        let text = serde_json::to_string_pretty(&payload).ok()?;
        if let Err(error) = fs::write(path, text) {
            eprintln!("Failed to persist Artflow project session: {error}");
            return None;
        }
        Some(())
    }

    fn clear_persisted_session(&self) {
        let Some(path) = self.session_path.as_ref() else {
            return;
        };
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Failed to clear Artflow project session: {error}"),
        }
    }

    /// `restoreLastSession`
    fn restore_last_session(&self) {
        let Some(last_root) = self.read_persisted_session() else {
            return;
        };
        if !Path::new(&last_root).exists() {
            self.clear_persisted_session();
            return;
        }
        if let Err(error) = self.open_project(Path::new(&last_root)) {
            eprintln!("Failed to restore project from last session: {}", error.message());
        }
    }

    // ———————————————— 打开工程 ————————————————

    /// `openProject`：新仓储 + 恢复两个控制器 → 交换 → 落盘会话 → 关旧仓储。
    fn open_project(&self, project_root: &Path) -> TrackingResult<Value> {
        if project_root.as_os_str().is_empty() {
            return Err(StorageError::storage("project root must be a non-empty path"));
        }
        let next_repository = Arc::new(
            ProjectRepository::open(project_root)
                .map_err(|error| wrap("failed to open project repository", &error.message()))?,
        );
        let recovered_imports = match next_repository.recover_import_jobs() {
            Ok(jobs) => jobs,
            Err(error) => {
                next_repository.close();
                return Err(error);
            }
        };
        let recovered_previews = match next_repository.recover_derivative_jobs() {
            Ok(jobs) => jobs,
            Err(error) => {
                next_repository.close();
                return Err(error);
            }
        };
        let mut import_jobs: HashMap<String, ImportJob> = HashMap::new();
        let mut import_order: Vec<String> = Vec::new();
        let mut import_queue: VecDeque<String> = VecDeque::new();
        for record in &recovered_imports {
            let job = ImportJob::from_record(record)?;
            if job.status == "queued" {
                import_queue.push_back(job.id.clone());
            }
            import_order.push(job.id.clone());
            import_jobs.insert(job.id.clone(), job);
        }
        let mut preview_jobs: HashMap<String, PreviewJob> = HashMap::new();
        let mut preview_queue: VecDeque<String> = VecDeque::new();
        for record in &recovered_previews {
            let job = PreviewJob::from_record(record);
            if job.status == "queued" {
                preview_queue.push_back(job.id.clone());
            }
            preview_jobs.insert(job.id.clone(), job);
        }
        let resolved_root = next_repository.project_root().to_path_buf();
        let previous = {
            let mut state = self.lock();
            let previous = state.repository.take();
            state.project_root = Some(resolved_root.clone());
            state.repository = Some(next_repository.clone());
            state.import_jobs = import_jobs;
            state.import_order = import_order;
            state.import_queue = import_queue;
            state.import_draining = false;
            state.preview_jobs = preview_jobs;
            state.preview_queue = preview_queue;
            state.preview_draining = false;
            previous
        };
        self.persist_session(&resolved_root);
        if let Some(previous) = previous {
            previous.close();
        }
        Ok(self.status())
    }

    // ———————————————— 导入 ————————————————

    /// `listJobs`：活跃作业保持持久化 FIFO 顺序，终态按更新时间倒序排在后面。
    fn list_import_jobs(&self) -> Value {
        let state = self.lock();
        let mut active: Vec<&ImportJob> = Vec::new();
        let mut terminal: Vec<&ImportJob> = Vec::new();
        for id in &state.import_order {
            let Some(job) = state.import_jobs.get(id) else {
                continue;
            };
            if is_active(&job.status) {
                active.push(job);
            } else {
                terminal.push(job);
            }
        }
        terminal.sort_by(|left, right| {
            right
                .updated_at
                .unwrap_or(0)
                .cmp(&left.updated_at.unwrap_or(0))
                .then(right.created_at.unwrap_or(0).cmp(&left.created_at.unwrap_or(0)))
                .then(left.id.cmp(&right.id))
        });
        let mut ordered: Vec<&ImportJob> = active;
        ordered.extend(terminal);
        Value::Array(
            ordered
                .into_iter()
                .take(MAX_LISTED_IMPORT_JOBS)
                .map(|job| job.snapshot())
                .collect(),
        )
    }

    fn spawn_import_drain(self: &Arc<Self>) {
        let should_start = {
            let mut state = self.lock();
            if state.import_draining || state.repository.is_none() {
                false
            } else {
                state.import_draining = true;
                true
            }
        };
        if !should_start {
            return;
        }
        let storage = self.clone();
        std::thread::spawn(move || storage.drain_imports());
    }

    fn drain_imports(self: Arc<Self>) {
        loop {
            let (job_id, repository) = {
                let mut state = self.lock();
                match state.repository.clone() {
                    None => {
                        state.import_draining = false;
                        return;
                    }
                    Some(repository) => match state.import_queue.pop_front() {
                        Some(id) => (id, repository),
                        None => {
                            state.import_draining = false;
                            return;
                        }
                    },
                }
            };
            let skip = {
                let state = self.lock();
                match state.import_jobs.get(&job_id) {
                    None => true,
                    Some(job) => job.status == "cancelled",
                }
            };
            if skip {
                continue;
            }
            let failure = self.run_import_job(&job_id, &repository);
            if let Err(failure) = failure {
                if repository.is_closed() {
                    continue;
                }
                if let Some(mut job) = self.lock().import_jobs.get(&job_id).cloned() {
                    match failure {
                        JobFailure::Cancelled => {
                            job.status = "cancelled".into();
                            job.error_code = None;
                        }
                        JobFailure::Storage(_) if job.cancel_requested => {
                            job.status = "cancelled".into();
                            job.error_code = None;
                        }
                        JobFailure::Storage(error) => {
                            job.status = "failed".into();
                            job.error_code = Some(error.code().to_string());
                        }
                    }
                    if let Err(error) = self.persist_import_job(&repository, &mut job) {
                        eprintln!("import job persist failed: {}", error.message());
                    }
                    let mut state = self.lock();
                    state.import_jobs.insert(job_id.clone(), job);
                }
            }
        }
    }

    fn persist_import_job(
        &self,
        repository: &Arc<ProjectRepository>,
        job: &mut ImportJob,
    ) -> TrackingResult<()> {
        let stored = repository.update_import_job(
            Some(&Value::String(job.id.clone())),
            Some(&Value::String(job.status.clone())),
            Some(&json!(job.progress)),
            Some(&json!(match &job.error_code {
                Some(code) => Value::String(code.clone()),
                None => Value::Null,
            })),
            Some(&job.result.clone().unwrap_or(Value::Null)),
            true,
        )?;
        job.status = stored
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        job.progress = stored.get("progress").and_then(as_number).unwrap_or(0.0);
        job.error_code = stored
            .get("errorCode")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        job.result = match stored.get("result") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.clone()),
        };
        job.created_at = opt_i64(stored.get("createdAt"));
        job.updated_at = opt_i64(stored.get("updatedAt"));
        Ok(())
    }

    fn run_import_job(
        &self,
        job_id: &str,
        repository: &Arc<ProjectRepository>,
    ) -> Result<(), JobFailure> {
        let mut job = {
            let state = self.lock();
            match state.import_jobs.get(job_id) {
                Some(job) => job.clone(),
                None => return Ok(()),
            }
        };
        if job.cancel_requested {
            return Err(JobFailure::Cancelled);
        }
        if repository.is_closed() {
            return Ok(());
        }
        job.status = "running".into();
        job.progress = 0.05;
        job.error_code = None;
        self.persist_import_job(repository, &mut job)?;
        self.store_import_job(job.clone());
        let bytes = repository.read_import_job_bytes(Some(&Value::String(job.id.clone())))?;
        job = match self.lock().import_jobs.get(job_id) {
            Some(current) => current.clone(),
            None => return Ok(()),
        };
        if job.cancel_requested {
            return Err(JobFailure::Cancelled);
        }
        if repository.is_closed() {
            return Ok(());
        }
        let result = repository.put_asset(
            &job.draft,
            &bytes,
            job.original_name.as_deref(),
        )?;
        if repository.is_closed() {
            return Ok(());
        }
        job.result = Some(result);
        job.status = "completed".into();
        job.progress = 1.0;
        job.error_code = None;
        self.persist_import_job(repository, &mut job)?;
        self.store_import_job(job);
        Ok(())
    }

    fn store_import_job(&self, job: ImportJob) {
        let mut state = self.lock();
        state.import_jobs.insert(job.id.clone(), job);
    }

    // ———————————————— 预览 ————————————————

    fn persist_preview_job(
        &self,
        repository: &Arc<ProjectRepository>,
        job: &mut PreviewJob,
    ) -> TrackingResult<()> {
        let blob_created = job
            .derivative
            .as_ref()
            .and_then(|derivative| derivative.get("blobCreated"))
            .cloned();
        let stored = repository.update_derivative_job(
            Some(&Value::String(job.id.clone())),
            Some(&Value::String(job.status.clone())),
            Some(&json!(job.progress)),
            Some(&json!(match &job.error_code {
                Some(code) => Value::String(code.clone()),
                None => Value::Null,
            })),
            Some(&job.derivative.clone().unwrap_or(Value::Null)),
            true,
        )?;
        job.status = stored
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        job.progress = stored.get("progress").and_then(as_number).unwrap_or(0.0);
        job.error_code = stored
            .get("errorCode")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        job.derivative = match stored.get("derivative") {
            None | Some(Value::Null) => None,
            Some(derivative) => {
                let mut merged = derivative.clone();
                if let Some(blob_created) = &blob_created {
                    if let Some(map) = merged.as_object_mut() {
                        map.insert("blobCreated".into(), blob_created.clone());
                    }
                }
                Some(merged)
            }
        };
        Ok(())
    }

    fn spawn_preview_drain(self: &Arc<Self>) {
        let should_start = {
            let mut state = self.lock();
            if state.preview_draining || state.repository.is_none() {
                false
            } else {
                state.preview_draining = true;
                true
            }
        };
        if !should_start {
            return;
        }
        let storage = self.clone();
        std::thread::spawn(move || storage.drain_previews());
    }

    fn drain_previews(self: Arc<Self>) {
        loop {
            let (job_id, repository) = {
                let mut state = self.lock();
                match state.repository.clone() {
                    None => {
                        state.preview_draining = false;
                        return;
                    }
                    Some(repository) => match state.preview_queue.pop_front() {
                        Some(id) => (id, repository),
                        None => {
                            state.preview_draining = false;
                            return;
                        }
                    },
                }
            };
            let skip = {
                let state = self.lock();
                match state.preview_jobs.get(&job_id) {
                    None => true,
                    Some(job) => is_terminal(&job.status),
                }
            };
            if skip {
                continue;
            }
            let failure = self.run_preview_job(&job_id, &repository);
            if let Err(failure) = failure {
                if repository.is_closed() {
                    continue;
                }
                if let Some(mut job) = self.lock().preview_jobs.get(&job_id).cloned() {
                    match failure {
                        JobFailure::Cancelled => {
                            job.status = "cancelled".into();
                            job.error_code = None;
                        }
                        JobFailure::Storage(_) if job.cancel_requested => {
                            job.status = "cancelled".into();
                            job.error_code = None;
                        }
                        JobFailure::Storage(error) => {
                            job.status = "failed".into();
                            job.error_code = Some(error.code().to_string());
                        }
                    }
                    if let Err(error) = self.persist_preview_job(&repository, &mut job) {
                        eprintln!(
                            "preview job persist failed: {}",
                            error.message()
                        );
                    }
                    self.lock().preview_jobs.insert(job_id.clone(), job);
                }
            }
        }
    }

    fn run_preview_job(
        &self,
        job_id: &str,
        repository: &Arc<ProjectRepository>,
    ) -> Result<(), JobFailure> {
        let mut job = {
            let state = self.lock();
            match state.preview_jobs.get(job_id) {
                Some(job) => job.clone(),
                None => return Ok(()),
            }
        };
        if job.cancel_requested {
            return Err(JobFailure::Cancelled);
        }
        if repository.is_closed() {
            return Ok(());
        }
        job.status = "running".into();
        job.progress = 0.01;
        job.error_code = None;
        self.persist_preview_job(repository, &mut job)?;
        self.store_preview_job(job.clone());
        let asset_id_value = Value::String(job.asset_id.clone());
        let Some(asset) = repository.get_asset(Some(&asset_id_value))? else {
            return Err(JobFailure::Storage(StorageError::storage(format!(
                "asset disappeared before derivative work: {}",
                job.asset_id
            ))));
        };
        let byte_size = asset.get("byteSize").and_then(as_integer).unwrap_or(0);
        if byte_size > MAX_PREVIEW_INPUT_BYTES {
            return Err(JobFailure::Storage(StorageError::storage(format!(
                "preview input exceeds the {MAX_PREVIEW_INPUT_BYTES} byte worker limit"
            ))));
        }
        let bytes = repository.read_asset_bytes(Some(&asset_id_value))?;
        if bytes.len() as i64 > MAX_PREVIEW_INPUT_BYTES {
            return Err(JobFailure::Storage(StorageError::storage(format!(
                "preview input exceeds the {MAX_PREVIEW_INPUT_BYTES} byte worker limit"
            ))));
        }
        if self.job_cancelled(job_id, repository) {
            return Err(JobFailure::Cancelled);
        }
        // 预览派生是纯模板渲染（上游 worker 不读像素）；进度分段与上游一致：起始 0，首块与末块上报。
        let chunk_size = 64 * 1024usize;
        let total = bytes.len().max(1);
        let mut offset = 0usize;
        while offset < bytes.len() {
            if self.job_cancelled(job_id, repository) {
                return Err(JobFailure::Cancelled);
            }
            if offset == 0 || offset + chunk_size >= bytes.len() {
                let ratio = (offset + chunk_size) as f64 / total as f64;
                let next_progress = job.progress.max(0.9_f64.min(ratio));
                if next_progress > job.progress {
                    job.progress = next_progress;
                    self.persist_preview_job(repository, &mut job)?;
                    self.store_preview_job(job.clone());
                }
            }
            offset += chunk_size;
        }
        let (kind, mime_type) = (
            asset
                .get("asset")
                .and_then(|item| item.get("kind"))
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            asset
                .get("asset")
                .and_then(|item| item.get("locator"))
                .and_then(|item| item.get("mimeType"))
                .and_then(|item| item.as_str())
                .map(str::to_string),
        );
        let svg = preview_svg(&job.asset_id, &kind, mime_type.as_deref(), bytes.len() as i64);
        if self.job_cancelled(job_id, repository) {
            return Err(JobFailure::Cancelled);
        }
        let derivative = repository.put_derivative(
            Some(&asset_id_value),
            Some(&Value::String(PREVIEW_RECIPE.to_string())),
            svg.as_bytes(),
            Some(&Value::String(PREVIEW_MIME_TYPE.to_string())),
        )?;
        if repository.is_closed() {
            return Ok(());
        }
        job.derivative = Some(derivative);
        job.progress = 1.0;
        job.status = "completed".into();
        job.error_code = None;
        self.persist_preview_job(repository, &mut job)?;
        self.store_preview_job(job);
        Ok(())
    }

    fn job_cancelled(&self, job_id: &str, repository: &Arc<ProjectRepository>) -> bool {
        let state = self.lock();
        match state.preview_jobs.get(job_id) {
            Some(job) => job.cancel_requested || repository.is_closed(),
            None => true,
        }
    }

    fn store_preview_job(&self, job: PreviewJob) {
        let mut state = self.lock();
        state.preview_jobs.insert(job.id.clone(), job);
    }
}

/// `workers/assetPreviewWorker.cjs` 的 `escapeXml`。
fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\'' => escaped.push_str("&apos;"),
            '"' => escaped.push_str("&quot;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// `workers/assetPreviewWorker.cjs` 的 `formatBytes`（`toFixed(1)` 语义：四舍五入到 1 位小数）。
fn format_bytes(byte_size: i64) -> String {
    if byte_size < 1024 {
        return format!("{byte_size} B");
    }
    if byte_size < 1024 * 1024 {
        return format!("{} KB", one_decimal(byte_size as f64 / 1024.0));
    }
    format!("{} MB", one_decimal(byte_size as f64 / (1024.0 * 1024.0)))
}

fn one_decimal(value: f64) -> String {
    let scaled = (value * 10.0).round() / 10.0;
    format!("{scaled:.1}")
}

/// `workers/assetPreviewWorker.cjs` 的 `previewSvg`，逐字节同款模板。
fn preview_svg(asset_id: &str, kind: &str, mime_type: Option<&str>, byte_size: i64) -> String {
    let upper = kind.to_uppercase();
    let label = format!("{upper} • {}", format_bytes(byte_size));
    let display_mime = match mime_type {
        Some(value) if !value.is_empty() => value,
        _ => "application/octet-stream",
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\" viewBox=\"0 0 640 360\" role=\"img\" aria-label=\"{}\">\n  <rect width=\"640\" height=\"360\" fill=\"#111827\"/>\n  <rect x=\"32\" y=\"32\" width=\"576\" height=\"296\" rx=\"18\" fill=\"#1f2937\" stroke=\"#374151\"/>\n  <circle cx=\"96\" cy=\"112\" r=\"32\" fill=\"#facc15\"/>\n  <text x=\"144\" y=\"106\" fill=\"#f9fafb\" font-family=\"system-ui, sans-serif\" font-size=\"26\" font-weight=\"700\">{}</text>\n  <text x=\"144\" y=\"140\" fill=\"#9ca3af\" font-family=\"system-ui, sans-serif\" font-size=\"17\">{}</text>\n  <text x=\"64\" y=\"248\" fill=\"#e5e7eb\" font-family=\"ui-monospace, monospace\" font-size=\"16\">{}</text>\n  <text x=\"64\" y=\"282\" fill=\"#9ca3af\" font-family=\"system-ui, sans-serif\" font-size=\"16\">{}</text>\n</svg>",
        escape_xml(&label),
        escape_xml(&upper),
        escape_xml(display_mime),
        escape_xml(asset_id),
        escape_xml(&label),
    )
}

// ———————————————————————————— 最近工程 ————————————————————————————

fn iso_timestamp_ms() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.subsec_millis() as i64;
    let total_seconds = now.as_secs() as i64;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant 的 civil_from_days：与 `Date#toISOString` 的日历一致。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn recent_projects_store(paths: &crate::config::ConfigPaths, safe_mode: bool) -> Option<crate::config::ConfigStore> {
    crate::config::ConfigStore::for_volume(paths, RECENT_PROJECTS_VOLUME, safe_mode)
}

/// `readRecentProjects`
fn read_recent_projects(paths: &crate::config::ConfigPaths, safe_mode: bool) -> Vec<Value> {
    let Some(store) = recent_projects_store(paths, safe_mode) else {
        return Vec::new();
    };
    let snapshot = store.read();
    let Some(Value::Array(entries)) = snapshot.values.get(RECENT_PROJECTS_KEY) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let path = entry.get("path").and_then(|item| item.as_str())?;
            let name = entry.get("name").and_then(|item| item.as_str())?;
            let opened_at = match entry.get("openedAt") {
                Some(Value::String(text)) => Value::String(text.clone()),
                _ => Value::Null,
            };
            Some(json!({
                "path": path,
                "name": name,
                "openedAt": opened_at,
                "missing": !Path::new(path).exists(),
            }))
        })
        .collect()
}

/// `recordRecentProject`：同路径去重（小写比较）→ 置顶 → 保留 12 条。
fn record_recent_project(paths: &crate::config::ConfigPaths, safe_mode: bool, project_root: &str) {
    if safe_mode {
        return;
    }
    let Some(store) = recent_projects_store(paths, false) else {
        return;
    };
    let snapshot = store.read();
    let existing = match snapshot.values.get(RECENT_PROJECTS_KEY) {
        Some(Value::Array(entries)) => entries.clone(),
        _ => Vec::new(),
    };
    let name = Path::new(project_root)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| project_root.to_string());
    let lowered = project_root.to_lowercase();
    let mut entries: Vec<Value> = vec![json!({
        "path": project_root,
        "name": name,
        "openedAt": iso_timestamp_ms(),
    })];
    for entry in existing {
        let Some(path) = entry.get("path").and_then(|item| item.as_str()) else {
            continue;
        };
        if path.to_lowercase() == lowered {
            continue;
        }
        entries.push(entry);
    }
    entries.truncate(MAX_RECENT_PROJECTS);
    let result = store.set(RECENT_PROJECTS_KEY, Value::Array(entries));
    if !result.ok {
        if let Some(message) = result.message {
            eprintln!("最近工程记录失败：{message}");
        } else {
            eprintln!("最近工程记录失败");
        }
    }
}

// ———————————————————————————— 目录打开（openPluginDir） ————————————————————————————

fn plugin_roots(app: &AppHandle) -> StorageResult<(PathBuf, PathBuf)> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| StorageError::storage(format!("{error}")))?;
    let plugins_root = data_root.join("plugins");
    let builtin_root = plugins_root.join("builtin");
    Ok((plugins_root, builtin_root))
}

fn is_builtin_dir_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("builtin.") else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    // ^builtin\.[a-z0-9]+(?:[.-][a-z0-9]+)*$
    for part in rest.split(['.', '-']) {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()) {
            return false;
        }
    }
    true
}

/// `path.resolve(base, ...segments)` 的字典序等价物（不碰文件系统、不解析符号链接）。
fn lexical_resolve(base: &Path, segments: &[&str]) -> PathBuf {
    let mut result = base.to_path_buf();
    for segment in segments {
        for component in Path::new(segment).components() {
            match component {
                Component::ParentDir => {
                    result.pop();
                }
                Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
                Component::Normal(part) => result.push(part),
            }
        }
    }
    result
}

fn is_within(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root.join(""))
}

fn open_dir_with_hint(target: &Path) -> Value {
    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(_) => return Value::String("rejected: directory not found".into()),
    };
    if !metadata.is_dir() {
        return Value::String("rejected: not a directory".into());
    }
    match std::process::Command::new("explorer").arg(target).spawn() {
        Ok(_) => Value::Null,
        Err(error) => Value::String(error.to_string()),
    }
}

fn resolve_builtin_package_dir(builtin_root: &Path, plugins_root: &Path, id: &str) -> PathBuf {
    let preferred = builtin_root.join(id);
    if preferred.exists() {
        return preferred;
    }
    let legacy = plugins_root.join(id);
    if legacy.exists() {
        return legacy;
    }
    preferred
}

fn open_plugin_dir(app: &AppHandle, rel_path: Option<&Value>) -> Value {
    let invalid = Value::String("rejected: invalid path".into());
    let Some(rel_path) = rel_path.and_then(|item| item.as_str()) else {
        return invalid;
    };
    let characters = rel_path.chars().count();
    if characters == 0 || characters > 200 {
        return invalid;
    }
    let Ok((plugins_root, builtin_root)) = plugin_roots(app) else {
        return Value::String("rejected: directory not found".into());
    };
    if let Some(id) = rel_path.strip_prefix("editable:") {
        if !is_builtin_dir_id(id) {
            return Value::String("rejected: invalid editable plugin id".into());
        }
        let allowed = [lexical_resolve(&builtin_root, &[]), lexical_resolve(&plugins_root, &[])];
        let target = lexical_resolve(&resolve_builtin_package_dir(&builtin_root, &plugins_root, id), &[]);
        if !allowed.iter().any(|root| is_within(root, &target)) {
            return Value::String("rejected: path escapes plugins root".into());
        }
        return open_dir_with_hint(&target);
    }
    let segments: Vec<&str> = rel_path
        .split(|character| character == '\\' || character == '/')
        .collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Value::String(
            "rejected: path must be relative without \".\" or \"..\" segments".into(),
        );
    }
    // Electron 的 `__dirname` 是安装目录；Tauri 下没有对应物，取可执行文件所在目录。
    let app_root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let target = lexical_resolve(&app_root, &segments);
    if target != app_root && !is_within(&app_root, &target) {
        return Value::String("rejected: path escapes application root".into());
    }
    open_dir_with_hint(&target)
}
// ———————————————————————————— Tauri 命令层 ————————————————————————————

/// Same caller guard as `main.rs::authorized` (label `main` + trusted origin).
/// Duplicated on purpose while `main.rs` is the Lead's file — integrate into one helper later.
fn trusted_url(url: &Url) -> bool {
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

fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

fn storage_of(window: &WebviewWindow) -> Option<Arc<ProjectStorage>> {
    window
        .app_handle()
        .try_state::<Arc<ProjectStorage>>()
        .map(|state| state.inner().clone())
}

/// Managed-state constructor for `main.rs`:
/// `app.manage(project::init(app.handle()));`
pub fn init(app: &AppHandle) -> Arc<ProjectStorage> {
    let session_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(SESSION_FILE_NAME));
    let storage = Arc::new(ProjectStorage::new(session_path));
    {
        let mut state = storage.lock();
        state.safe_mode = crate::declarative::safe_mode();
    }
    // 上游在 `whenReady()` 末尾 `await storageController.restoreLastSession()`：启动即尝试恢复上次
    // 工程；路径不存在就清掉会话、打开失败只打警告（与上游 catch 同一行为）。
    storage.restore_last_session();
    storage
}

fn forbidden() -> StorageError {
    StorageError::storage("forbidden caller")
}

fn unavailable() -> StorageError {
    StorageError::storage("managed project storage is unavailable")
}

fn app_paths(window: &WebviewWindow) -> StorageResult<crate::config::ConfigPaths> {
    crate::config::ConfigPaths::resolve(&window.app_handle().clone())
        .map_err(StorageError::storage)
}

/// `serializedByteLength(value, label, limit)`
fn serialized_byte_length_checked(value: &Value, label: &str, limit: usize) -> StorageResult<()> {
    let length = serialized_byte_length(value)
        .ok_or_else(|| StorageError::storage(format!("{label} must be JSON serializable")))?;
    if length > limit {
        return Err(StorageError::storage(format!(
            "{label} exceeds the {limit} byte IPC limit"
        )));
    }
    Ok(())
}

fn object_or_error(value: Option<&Value>, message: &str) -> StorageResult<Value> {
    match value {
        Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
        _ => Err(StorageError::storage(message)),
    }
}

/// `window.artflowStorage.chooseProject()`
#[tauri::command]
pub async fn tauri_storage_choose_project(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Open Artflow managed project")
            .pick_folder()
    })
    .await
    .map_err(|error| {
        StorageError::storage(format!("project selection failed: {error}"))
    })?;
    let Some(directory) = selected else {
        // 上游：取消选择返回 `null`（不写最近列表、不开工程）。
        return Ok(Value::Null);
    };
    let paths = app_paths(&window)?;
    let safe_mode = crate::declarative::safe_mode();
    let opened = storage.open_project(&directory)?;
    record_recent_project(&paths, safe_mode, &directory.to_string_lossy());
    Ok(opened)
}

/// `window.artflowStorage.getStatus()`
#[tauri::command]
pub fn tauri_storage_status(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    Ok(storage.status())
}

/// `window.artflowStorage.importAsset({ asset, bytes, originalName })`
#[tauri::command]
pub async fn tauri_storage_import_asset(
    window: WebviewWindow,
    request: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let request = object_or_error(Some(&request), "asset import request must be an object")?;
    // 上游顺序：bytes → originalName → asset metadata 体积。
    let bytes = as_transfer_bytes(request.get("bytes"), MAX_IMPORT_BYTES)?;
    let original_name = assert_controller_original_name(request.get("originalName"))?;
    serialized_byte_length_checked(
        request.get("asset").unwrap_or(&Value::Null),
        "asset metadata",
        MAX_IMPORT_ASSET_METADATA_BYTES,
    )?;
    let repository = storage.require_repository()?;
    let asset = request.get("asset").cloned().unwrap_or(Value::Null);
    tauri::async_runtime::spawn_blocking(move || {
        repository.put_asset(&asset, &bytes, original_name.as_deref())
    })
    .await
    .map_err(|error| StorageError::worker(format!("asset import failed: {error}")))?
}

/// `window.artflowStorage.requestImport({ asset, bytes, originalName })`
#[tauri::command]
pub async fn tauri_storage_request_import(
    window: WebviewWindow,
    request: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let request = object_or_error(Some(&request), "import job request must be an object")?;
    let bytes = as_transfer_bytes(request.get("bytes"), MAX_IMPORT_BYTES)?;
    let original_name = assert_controller_original_name(request.get("originalName"))?;
    let asset = request.get("asset").cloned().unwrap_or(Value::Null);
    let repository = storage.require_repository()?;
    let job_id = uuid_v4_hex();
    let record = tauri::async_runtime::spawn_blocking(move || {
        repository.stage_import(&job_id, &asset, &bytes, original_name.as_deref())
    })
    .await
    .map_err(|error| StorageError::worker(format!("import staging failed: {error}")))??;
    let job = ImportJob::from_record(&record)?;
    let snapshot = job.snapshot();
    let job_key = job.id.clone();
    {
        let mut state = storage.lock();
        state.import_order.push(job_key.clone());
        state.import_jobs.insert(job_key.clone(), job);
        state.import_queue.push_back(job_key);
    }
    storage.spawn_import_drain();
    Ok(snapshot)
}

/// `window.artflowStorage.getImportJob(jobId)`
#[tauri::command]
pub fn tauri_storage_get_import_job(
    window: WebviewWindow,
    job_id: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let key = job_id.as_str().unwrap_or_default().to_string();
    let state = storage.lock();
    Ok(match state.import_jobs.get(&key) {
        Some(job) => job.snapshot(),
        None => Value::Null,
    })
}

/// `window.artflowStorage.listImportJobs()`
#[tauri::command]
pub fn tauri_storage_list_import_jobs(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    Ok(storage.list_import_jobs())
}

/// `window.artflowStorage.cancelImportJob(jobId)`
#[tauri::command]
pub fn tauri_storage_cancel_import_job(
    window: WebviewWindow,
    job_id: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let key = job_id.as_str().unwrap_or_default().to_string();
    let mut job = {
        let state = storage.lock();
        match state.import_jobs.get(&key) {
            Some(job) => job.clone(),
            None => return Err(StorageError::storage(format!("unknown import job: {key}"))),
        }
    };
    if is_terminal(&job.status) {
        return Ok(job.snapshot());
    }
    job.cancel_requested = true;
    if job.status == "queued" {
        job.status = "cancelled".into();
        job.error_code = None;
        let repository = storage.require_repository()?;
        storage.persist_import_job(&repository, &mut job)?;
    }
    // 运行中的落盘提交没有安全的中断点；`run_import_job` 在提升状态前自检（与上游注释一致）。
    let snapshot = job.snapshot();
    storage.lock().import_jobs.insert(key, job);
    Ok(snapshot)
}

/// `window.artflowStorage.saveProject(document)`
#[tauri::command]
pub async fn tauri_storage_save_project(
    window: WebviewWindow,
    document: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    serialized_byte_length_checked(&document, "project document", MAX_DOCUMENT_BYTES)?;
    let repository = storage.require_repository()?;
    tauri::async_runtime::spawn_blocking(move || repository.save_project_document(&document))
        .await
        .map_err(|error| StorageError::worker(format!("project save failed: {error}")))??;
    Ok(Value::Null)
}

/// `window.artflowStorage.loadProject()`
#[tauri::command]
pub async fn tauri_storage_load_project(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let repository = storage.require_repository()?;
    let document =
        tauri::async_runtime::spawn_blocking(move || repository.load_project_document())
            .await
            .map_err(|error| StorageError::worker(format!("project load failed: {error}")))??;
    Ok(document.unwrap_or(Value::Null))
}

/// `window.artflowStorage.listRecentProjects()`
#[tauri::command]
pub fn tauri_storage_list_recent_projects(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let paths = app_paths(&window)?;
    let safe_mode = crate::declarative::safe_mode();
    Ok(json!({
        "ok": true,
        "projects": read_recent_projects(&paths, safe_mode),
    }))
}

/// `window.artflowStorage.openRecentProject(projectRoot)`
#[tauri::command]
pub async fn tauri_storage_open_recent_project(
    window: WebviewWindow,
    project_root: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let invalid = || StorageError::storage("Invalid recent project path");
    let Some(path) = project_root.as_str() else {
        return Err(invalid());
    };
    if path.is_empty() || path.chars().count() > MAX_RECENT_PROJECT_PATH {
        return Err(invalid());
    }
    let paths = app_paths(&window)?;
    let safe_mode = crate::declarative::safe_mode();
    // 打开失败会在这里抛出（目录被删/改名/无权限），条目留在列表里供用户重试（上游同）。
    let opened = storage.open_project(Path::new(path))?;
    record_recent_project(&paths, safe_mode, path);
    Ok(opened)
}

/// `window.artflowStorage.clearRecentProjects()`
#[tauri::command]
pub fn tauri_storage_clear_recent_projects(window: WebviewWindow) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let paths = app_paths(&window)?;
    let safe_mode = crate::declarative::safe_mode();
    if safe_mode {
        return Ok(json!({
            "ok": false,
            "message": "安全模式：本次会话不写入用户数据（去掉 ARTFLOW_SAFE_MODE=1 后正常启动即可保存）",
        }));
    }
    let store = recent_projects_store(&paths, false)
        .ok_or_else(|| StorageError::storage("recent-files store is unavailable"))?;
    let result = store.reset(Some(vec![RECENT_PROJECTS_KEY.to_string()]));
    Ok(serde_json::to_value(result).unwrap_or_else(|error| {
        json!({ "ok": false, "message": error.to_string() })
    }))
}

/// `window.artflowStorage.queryViewport(request)`
#[tauri::command]
pub async fn tauri_storage_query_viewport(
    window: WebviewWindow,
    request: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    serialized_byte_length_checked(&request, "viewport query request", MAX_VIEWPORT_QUERY_BYTES)?;
    let repository = storage.require_repository()?;
    tauri::async_runtime::spawn_blocking(move || repository.query_viewport(&request))
        .await
        .map_err(|error| StorageError::worker(format!("viewport query failed: {error}")))?
}

/// `window.artflowStorage.listAssetInventory(request)`
#[tauri::command]
pub async fn tauri_storage_list_asset_inventory(
    window: WebviewWindow,
    request: Option<Value>,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let request = match request {
        None | Some(Value::Null) => json!({}),
        Some(value) => value,
    };
    serialized_byte_length_checked(&request, "asset inventory request", MAX_ASSET_INVENTORY_BYTES)?;
    let repository = storage.require_repository()?;
    tauri::async_runtime::spawn_blocking(move || repository.list_asset_inventory(&request))
        .await
        .map_err(|error| StorageError::worker(format!("asset inventory failed: {error}")))?
}

/// `window.artflowStorage.reclaimUnreferencedAssets(request)`
#[tauri::command]
pub async fn tauri_storage_reclaim_assets(
    window: WebviewWindow,
    request: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    serialized_byte_length_checked(&request, "asset reclaim request", MAX_ASSET_RECLAIM_BYTES)?;
    let repository = storage.require_repository()?;
    tauri::async_runtime::spawn_blocking(move || {
        repository.reclaim_unreferenced_assets(&request)
    })
    .await
    .map_err(|error| StorageError::worker(format!("asset reclaim failed: {error}")))?
}

/// `window.artflowStorage.requestPreview(assetId)`
#[tauri::command]
pub fn tauri_storage_request_preview(
    window: WebviewWindow,
    asset_id: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let repository = storage.require_repository()?;
    let asset_id = assert_asset_id(Some(&asset_id))?;
    if repository
        .get_asset(Some(&Value::String(asset_id.clone())))?
        .is_none()
    {
        return Err(StorageError::storage(format!("unknown asset id: {asset_id}")));
    }
    let job_id = uuid_v4_hex();
    let record = repository.create_derivative_job(
        &job_id,
        Some(&Value::String(asset_id)),
        Some(&Value::String(PREVIEW_RECIPE.to_string())),
    )?;
    let job = PreviewJob::from_record(&record);
    let snapshot = job.snapshot();
    {
        let mut state = storage.lock();
        state.preview_jobs.insert(job.id.clone(), job);
        state.preview_queue.push_back(job_id);
    }
    storage.spawn_preview_drain();
    Ok(snapshot)
}

/// `window.artflowStorage.getPreviewJob(jobId)`
#[tauri::command]
pub fn tauri_storage_get_preview_job(
    window: WebviewWindow,
    job_id: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let key = job_id.as_str().unwrap_or_default().to_string();
    let state = storage.lock();
    Ok(match state.preview_jobs.get(&key) {
        Some(job) => job.snapshot(),
        None => Value::Null,
    })
}

/// `window.artflowStorage.cancelPreviewJob(jobId)`
#[tauri::command]
pub fn tauri_storage_cancel_preview_job(
    window: WebviewWindow,
    job_id: Value,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    let storage = storage_of(&window).ok_or_else(unavailable)?;
    let key = job_id.as_str().unwrap_or_default().to_string();
    let mut job = {
        let state = storage.lock();
        match state.preview_jobs.get(&key) {
            Some(job) => job.clone(),
            None => {
                return Err(StorageError::storage(format!(
                    "unknown derivative job: {key}"
                )))
            }
        }
    };
    if is_terminal(&job.status) {
        return Ok(job.snapshot());
    }
    job.cancel_requested = true;
    if job.status == "queued" {
        job.status = "cancelled".into();
        job.error_code = None;
        let repository = storage.require_repository()?;
        storage.persist_preview_job(&repository, &mut job)?;
    }
    let snapshot = job.snapshot();
    storage.lock().preview_jobs.insert(key, job);
    Ok(snapshot)
}

/// `window.artflowApp.openPluginDir(relPath)`：`null` = 成功，字符串 = 拒绝原因。
#[tauri::command]
pub fn tauri_open_plugin_dir(
    window: WebviewWindow,
    rel_path: Option<Value>,
) -> Result<Value, StorageError> {
    if !authorized(&window) {
        return Err(forbidden());
    }
    Ok(open_plugin_dir(
        &window.app_handle().clone(),
        rel_path.as_ref(),
    ))
}

/// 与 `crypto.randomUUID()` 形状一致的 v4 UUID（小写）。
fn uuid_v4_hex() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
        ^ ((COUNTER.fetch_add(1, Ordering::Relaxed) as u128) << 32)
        ^ (std::process::id() as u128);
    let mut hasher = Sha256::new();
    hasher.update(seed.to_le_bytes());
    hasher.update(unique_suffix().as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

// ———————————————————————————— 测试 ————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("artflow-project-{label}-{}", unique_suffix()));
        fs::create_dir_all(&base).expect("temp dir");
        base
    }

    fn asset_record(id: &str, kind: &str, mime: &str) -> Value {
        json!({
            "id": id,
            "kind": kind,
            "sourceKind": "data-url",
            "locator": { "mimeType": mime },
            "metadata": { "originalName": "cat.png" },
        })
    }

    #[test]
    fn schema_version_and_layout_are_created() {
        let root = temp_root("schema");
        let repository = ProjectRepository::open(&root).expect("open");
        assert!(root.join(".artflow/blobs/sha256").is_dir());
        assert!(root.join(".artflow/derivatives/sha256").is_dir());
        assert!(root.join(".artflow/import-staging/sha256").is_dir());
        assert!(root.join(".artflow/metadata.sqlite").exists());
        let revision = {
            let guard = repository.lock().expect("lock");
            read_spatial_revision(&guard).expect("revision")
        };
        assert_eq!(revision, 0);
        repository.close();
    }

    #[test]
    fn put_asset_materializes_blob_and_records_metadata() {
        let root = temp_root("asset");
        let repository = ProjectRepository::open(&root).expect("open");
        let bytes = b"hello-artflow";
        let stored = repository
            .put_asset(
                &asset_record("asset-1", "image", "image/png"),
                bytes,
                Some("cat.png"),
            )
            .expect("put asset");
        assert_eq!(
            stored
                .get("contentHash")
                .and_then(|value| value.as_str())
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            stored.get("byteSize").and_then(|v| v.as_i64()),
            Some(bytes.len() as i64)
        );
        assert_eq!(stored.get("blobCreated"), Some(&Value::Bool(true)));
        let again = repository
            .put_asset(
                &asset_record("asset-1", "image", "image/png"),
                bytes,
                Some("cat.png"),
            )
            .expect("put asset again");
        assert_eq!(again.get("blobCreated"), Some(&Value::Bool(false)));
        let loaded = repository
            .get_asset(Some(&json!("asset-1")))
            .expect("get asset")
            .expect("present");
        assert_eq!(
            loaded.get("byteSize").and_then(|v| v.as_i64()),
            Some(bytes.len() as i64)
        );
        assert_eq!(
            loaded
                .get("asset")
                .and_then(|value| value.get("sourceKind"))
                .and_then(|value| value.as_str()),
            Some("managed-store")
        );
        repository.close();
    }

    #[test]
    fn derivative_recipe_and_preview_svg_match_upstream() {
        let svg = preview_svg("asset-1", "image", Some("image/png"), 1536);
        assert!(svg.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\" viewBox=\"0 0 640 360\" role=\"img\" aria-label=\"IMAGE • 1.5 KB\">"));
        assert!(svg.contains("<text x=\"144\" y=\"106\" fill=\"#f9fafb\" font-family=\"system-ui, sans-serif\" font-size=\"26\" font-weight=\"700\">IMAGE</text>"));
        assert!(svg.contains("<text x=\"64\" y=\"248\" fill=\"#e5e7eb\" font-family=\"ui-monospace, monospace\" font-size=\"16\">asset-1</text>"));
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert!(ProjectRepository::assert_derivative_recipe(Some(&json!("preview-card-v1"))).is_ok());
        assert!(ProjectRepository::assert_derivative_recipe(Some(&json!("Preview"))).is_err());
        assert!(ProjectRepository::assert_derivative_recipe(Some(&json!(""))).is_err());
    }

    #[test]
    fn save_and_load_document_round_trip() {
        let root = temp_root("document");
        let repository = ProjectRepository::open(&root).expect("open");
        let bytes = b"pixels";
        repository
            .put_asset(&asset_record("asset-1", "image", "image/png"), bytes, None)
            .expect("put asset");
        let hash = sha256_hex(bytes);
        let reference = format!("{STORAGE_REF_PREFIX}{hash}");
        let document = json!({
            "format": PROJECT_DOCUMENT_FORMAT,
            "version": PROJECT_DOCUMENT_VERSION,
            "assets": [{
                "id": "asset-1",
                "kind": "image",
                "sourceKind": "managed-store",
                "locator": {
                    "mimeType": "image/png",
                    "byteSize": bytes.len(),
                    "previewRef": reference,
                    "originalRef": reference,
                },
                "metadata": {},
            }],
            "boards": [{ "id": "board-1", "operationHistory": [] }],
            "nodes": [{
                "id": "node-1",
                "boardId": "board-1",
                "nodeType": "image",
                "assetId": "asset-1",
                "zIndex": 1,
                "x": 10, "y": 20, "width": 100, "height": 50,
                "properties": {},
            }],
        });
        repository.save_project_document(&document).expect("save");
        let loaded = repository
            .load_project_document()
            .expect("load")
            .expect("present");
        assert_eq!(loaded.get("version").and_then(|v| v.as_i64()), Some(2));
        let page = repository
            .query_viewport(&json!({
                "boardId": "board-1",
                "rect": { "x": 0, "y": 0, "width": 500, "height": 500 },
            }))
            .expect("query");
        assert_eq!(page.get("truncated"), Some(&Value::Bool(false)));
        assert_eq!(page.get("snapshotRevision").and_then(|v| v.as_i64()), Some(1));
        let nodes = page
            .get("nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].get("id").and_then(|v| v.as_str()), Some("node-1"));
        // 第二次保存推高版本号，旧游标必须被拒。
        repository.save_project_document(&document).expect("save again");
        let stale = repository.query_viewport(&json!({
            "boardId": "board-1",
            "rect": { "x": 0, "y": 0, "width": 500, "height": 500 },
            "cursor": {
                "snapshotRevision": 1,
                "boardId": "board-1",
                "rect": { "x": 0, "y": 0, "width": 500, "height": 500 },
                "after": { "zIndex": 1, "id": "node-1" },
            },
        }));
        assert!(stale.is_err());
        repository.close();
    }

    #[test]
    fn import_job_round_trip_rejects_mismatched_results() {
        let root = temp_root("import");
        let repository = Arc::new(ProjectRepository::open(&root).expect("open"));
        let storage = Arc::new(ProjectStorage::new(None));
        {
            let mut state = storage.lock();
            state.repository = Some(repository.clone());
        }
        let job_id = uuid_v4_hex();
        let bytes = b"import-bytes";
        let record = repository
            .stage_import(
                &job_id,
                &asset_record("asset-9", "file", "text/plain"),
                bytes,
                Some("a.txt"),
            )
            .expect("stage");
        assert_eq!(record.get("status").and_then(|v| v.as_str()), Some("queued"));
        assert_eq!(
            record.get("id").and_then(|v| v.as_str()),
            Some(job_id.as_str())
        );
        let staging = repository
            .read_import_job_bytes(Some(&json!(job_id)))
            .expect("staging bytes");
        assert_eq!(staging, bytes);
        let wrong = repository.update_import_job(
            Some(&json!(job_id)),
            Some(&json!("completed")),
            Some(&json!(1)),
            Some(&Value::Null),
            Some(&json!({ "contentHash": sha256_hex(b"other"), "byteSize": bytes.len() })),
            true,
        );
        assert!(wrong.is_err());
        let ok = repository
            .update_import_job(
                Some(&json!(job_id)),
                Some(&json!("completed")),
                Some(&json!(1)),
                Some(&Value::Null),
                Some(&json!({ "contentHash": sha256_hex(bytes), "byteSize": bytes.len() })),
                true,
            )
            .expect("complete");
        assert_eq!(ok.get("status").and_then(|v| v.as_str()), Some("completed"));
        assert!(!ok.get("result").unwrap_or(&Value::Null).is_null());
    }

    #[test]
    fn inventory_and_reclaim_respect_usage() {
        let root = temp_root("inventory");
        let repository = ProjectRepository::open(&root).expect("open");
        repository
            .put_asset(&asset_record("asset-a", "file", "text/plain"), b"aaa", None)
            .expect("put a");
        repository
            .put_asset(&asset_record("asset-b", "file", "text/plain"), b"bbb", None)
            .expect("put b");
        let inventory = repository
            .list_asset_inventory(&json!({ "limit": 10 }))
            .expect("inventory");
        assert_eq!(
            inventory.get("totalAssets").and_then(|v| v.as_i64()),
            Some(2)
        );
        assert_eq!(
            inventory.get("uniqueBlobs").and_then(|v| v.as_i64()),
            Some(2)
        );
        let items = inventory
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].get("usage").and_then(|v| v.as_str()),
            Some("none")
        );
        assert_eq!(
            items[0]
                .get("hashPrefix")
                .and_then(|v| v.as_str())
                .map(str::len),
            Some(12)
        );
        let reclaimed = repository
            .reclaim_unreferenced_assets(&json!({
                "assetIds": ["asset-a", "missing-1"],
                "protectIds": [],
            }))
            .expect("reclaim");
        assert_eq!(
            reclaimed
                .get("removed")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            reclaimed
                .get("missing")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            reclaimed.get("freedBytes").and_then(|v| v.as_i64()),
            Some(3)
        );
        let renamed = repository
            .rename_asset_names(&json!({ "changes": [{ "id": "asset-b", "name": "  renamed.txt  " }] }))
            .expect("rename");
        assert_eq!(
            renamed
                .get("renamed")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
        repository.close();
    }

    #[test]
    fn transfer_bytes_accept_every_ipc_encoding() {
        assert_eq!(
            as_transfer_bytes(Some(&json!([104, 105])), 16).expect("array"),
            b"hi".to_vec()
        );
        assert_eq!(
            as_transfer_bytes(Some(&json!({ "0": 104, "1": 105 })), 16).expect("object"),
            b"hi".to_vec()
        );
        assert_eq!(
            as_transfer_bytes(Some(&json!("aGk=")), 16).expect("base64"),
            b"hi".to_vec()
        );
        assert!(as_transfer_bytes(Some(&json!("aGk=")), 1).is_err());
        assert!(as_transfer_bytes(Some(&json!(null)), 16).is_err());
    }

    #[test]
    fn recent_project_timestamp_is_rfc3339_utc() {
        let stamp = iso_timestamp_ms();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn builtin_dir_ids_follow_the_upstream_pattern() {
        assert!(is_builtin_dir_id("builtin.skins-neon"));
        assert!(is_builtin_dir_id("builtin.a1.b2-c3"));
        assert!(!is_builtin_dir_id("builtin."));
        assert!(!is_builtin_dir_id("builtin.Skins"));
        assert!(!is_builtin_dir_id("builtin.a..b"));
        assert!(!is_builtin_dir_id("other.skins"));
    }
}
