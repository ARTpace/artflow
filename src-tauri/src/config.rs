//! 配置卷 / 预设库 / 密钥加密（Tauri 侧 `window.artflowConfig` 桥的后端）。
//!
//! Ported from `main/configStore.cjs`, `main/presetLibrary.cjs`, `main/secretCodec.cjs` and
//! `main/safeMode.cjs`. Those four files are the single source of truth: every limit, error
//! string, branch order and quirk here mirrors them, because the renderer was written against
//! their exact behaviour (`plugin-runtime/preferences-store.ts`, `secrets-store.ts`,
//! `config-volume.ts`, `builtin-plugins/config-manager/*`).
//!
//! Three semantics must not be weakened:
//!
//! 1. **A failed write is reported, never swallowed.** `apply_changes` returns `ok:false` with a
//!    message the UI can print; nothing here degrades into a silent reset.
//! 2. **Backup before reset.** A corrupt primary file falls back to `<file>.backup` and marks
//!    `degraded`; it is never silently treated as "no config".
//! 3. **Degradation is visible.** Every fallback carries `degraded:true` plus a message.
//!
//! One deliberate divergence from Electron: Tauri has no synchronous IPC, so the synchronous
//! contract (`readStore()` at module-evaluation time) is served from a startup snapshot injected
//! by `config_script.rs`, while writes travel over `invoke`. `config_script.rs` documents exactly
//! what that can and cannot promise.
//!
//! `secrets` is the only encrypted volume: values are sealed per key with DPAPI (`enc:v1:` + the
//! standard base64 alphabet), so the file stays readable JSON and the storage panel can still
//! count keys. A value this build cannot decrypt is **preserved verbatim**, never dropped.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

// ———————————————————————————— limits (mirror configStore.cjs) ————————————————————————————

const MAX_KEY_LENGTH: usize = 120;
const MAX_STRING_LENGTH: usize = 100_000;
const MAX_ARRAY_LENGTH: usize = 5_000;
const MAX_DEPTH: usize = 12;
/// `__proto__` and friends would poison the prototype of the object the renderer spreads these
/// values into; upstream rejects them by name and so does this port.
const RESERVED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const CIPHER_PREFIX: &str = "enc:v1:";

/// Both messages embed the environment switch name, so a user reading the UI hint knows exactly
/// what to unset. Kept as literals because `const` cannot format.
const SAFE_MODE_READ_MESSAGE: &str = "安全模式：已忽略用户配置（ARTFLOW_SAFE_MODE=1）";
const SAFE_MODE_WRITE_REJECTED: &str =
    "安全模式：本次会话不写入用户数据（去掉 ARTFLOW_SAFE_MODE=1 后正常启动即可保存）";
const KEYCHAIN_ENCODE_FAILED: &str = "系统钥匙串不可用，密钥无法加密保存（本次未写入）";
const KEYCHAIN_DECODE_FAILED: &str = "系统钥匙串不可用，无法解密已保存的密钥";

const PRESET_KIND: &str = "artflow.preset";
const PRESET_SCHEMA_VERSION: i64 = 1;
const MAX_PRESET_NAME_LENGTH: usize = 64;
const MAX_PRESET_FILE_BYTES: u64 = 2 * 1024 * 1024;
const PRESET_NAME_ERROR: &str = "预设名只能包含字母/数字/._-，且不超过 64 个字符";
/// Same two volumes Electron puts in a preset: secrets and recent-files are deliberately
/// excluded (a preset is shared between machines; a saved API key is not).
pub const PRESET_VOLUMES: [&str; 2] = ["preferences", "workspace"];

const CONFIG_SCHEMA_VERSION: i64 = 1;

/// The five volumes `main.cjs:168-206` registers, in its order.
pub const VOLUME_NAMES: [&str; 5] = [
    "preferences",
    "workspace",
    "recent-files",
    "secrets",
    "ai-providers",
];

// ———————————————————————————— small primitives ————————————————————————————

/// JavaScript counts string length in UTF-16 code units; `str::len` counts bytes and
/// `chars().count()` counts scalar values. Both would let an emoji-heavy value slip past or fail
/// a limit the renderer computed differently, so every limit is checked in UTF-16 units.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — ASCII only, first byte alphanumeric.
fn is_key_pattern(value: &str) -> bool {
    let mut bytes = value.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || utf16_len(key) > MAX_KEY_LENGTH
        || !is_key_pattern(key)
        || RESERVED_KEYS.contains(&key)
    {
        return Err(format!("invalid config key: {key}"));
    }
    Ok(())
}

/// Only values that survive a JSON round trip unchanged: no `undefined`, functions, symbols,
/// bigint or `Date`. `serde_json::Value` already cannot carry those, so the checks that remain
/// are the ones JSON *does* allow but the store refuses (depth, size, reserved keys).
fn is_storable_value(value: &Value, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match value {
        Value::Null => true,
        Value::String(text) => utf16_len(text) <= MAX_STRING_LENGTH,
        Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(|number| number.is_finite()),
        Value::Array(items) => {
            items.len() <= MAX_ARRAY_LENGTH
                && items
                    .iter()
                    .all(|item| is_storable_value(item, depth + 1))
        }
        Value::Object(map) => map.iter().all(|(key, item)| {
            !RESERVED_KEYS.contains(&key.as_str()) && is_storable_value(item, depth + 1)
        }),
    }
}

/// Howard Hinnant's `civil_from_days`. `updatedAt` is `Date#toISOString()` upstream and the crate
/// has no date dependency; an offset table would drift, this algorithm does not.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn iso_from_system_time(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let millis = elapsed.subsec_millis();
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let clock = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        clock / 3_600,
        (clock % 3_600) / 60,
        clock % 60
    )
}

fn iso_timestamp_now() -> String {
    iso_from_system_time(SystemTime::now())
}

/// `String(line).slice(0, 1600)` slices UTF-16 code units; slicing bytes here could panic on a
/// multi-byte boundary, so the truncation is counted the same way JavaScript counts it.
fn truncate_utf16(value: &str, limit: usize) -> String {
    if utf16_len(value) <= limit {
        return value.to_string();
    }
    // `from_utf16_lossy` cannot panic on a split surrogate pair; it replaces the dangling half,
    // which only ever happens on the final character of an already-truncated log line.
    String::from_utf16_lossy(&value.encode_utf16().take(limit).collect::<Vec<u16>>())
}

fn read_if_exists(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

// ———————————————————————————— secret codec (DPAPI) ————————————————————————————

/// Self-description surfaced to the storage panel (`secret: { encrypted, scheme, prefix }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDescription {
    pub encrypted: bool,
    pub scheme: String,
    pub prefix: String,
}

#[derive(Clone, Copy)]
enum Backend {
    /// Windows DPAPI, user-scoped — the same primitive Chromium's `safeStorage` uses on Windows.
    Dpapi,
    /// No keychain: encryption is impossible and every `encode` must fail loudly.
    Unavailable,
    /// Deterministic stand-in so the round trip can be tested on any machine.
    #[cfg(test)]
    Reversible,
}

/// Value-level codec for the `secrets` volume.
///
/// Per key, not per file: whole-file encryption would make `stats()` unable to count keys, and
/// the storage panel renders exactly that. The prefix is self-describing, so a plaintext value
/// written by an older build still reads back (zero migration) and is upgraded on the next write.
#[derive(Clone, Copy)]
pub struct SecretCodec {
    backend: Backend,
    available: bool,
}

impl SecretCodec {
    /// Probes DPAPI once with a real round trip; a keychain that cannot decrypt what it just
    /// encrypted is not usable.
    pub fn system() -> Self {
        #[cfg(windows)]
        {
            let available = native::probe();
            Self {
                backend: if available {
                    Backend::Dpapi
                } else {
                    Backend::Unavailable
                },
                available,
            }
        }
        #[cfg(not(windows))]
        {
            Self {
                backend: Backend::Unavailable,
                available: false,
            }
        }
    }

    /// The honest "no keychain" codec: reads of plaintext still work, everything else refuses.
    #[cfg(test)]
    pub fn unavailable() -> Self {
        Self {
            backend: Backend::Unavailable,
            available: false,
        }
    }

    #[cfg(test)]
    pub fn reversible() -> Self {
        Self {
            backend: Backend::Reversible,
            available: true,
        }
    }

    pub fn available(&self) -> bool {
        self.available
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        match self.backend {
            Backend::Dpapi => {
                #[cfg(windows)]
                {
                    native::protect(plain)
                }
                #[cfg(not(windows))]
                {
                    let _ = plain;
                    Err("DPAPI 在该平台上不可用".to_string())
                }
            }
            Backend::Unavailable => Err(KEYCHAIN_ENCODE_FAILED.to_string()),
            #[cfg(test)]
            Backend::Reversible => Ok(reversible_xor(plain)),
        }
    }

    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        match self.backend {
            Backend::Dpapi => {
                #[cfg(windows)]
                {
                    native::unprotect(sealed)
                }
                #[cfg(not(windows))]
                {
                    let _ = sealed;
                    Err("DPAPI 在该平台上不可用".to_string())
                }
            }
            Backend::Unavailable => Err(KEYCHAIN_DECODE_FAILED.to_string()),
            #[cfg(test)]
            Backend::Reversible => Ok(reversible_xor(sealed)),
        }
    }

    /// Before writing: strings are sealed; anything else (which should not appear) passes through.
    /// Unavailable keychain => `Err`, never plaintext on disk.
    pub fn encode(&self, value: &Value) -> Result<Value, String> {
        match value {
            Value::String(text) if !text.is_empty() => {
                if !self.available {
                    return Err(KEYCHAIN_ENCODE_FAILED.to_string());
                }
                let sealed = self.seal(text.as_bytes())?;
                Ok(Value::String(format!(
                    "{CIPHER_PREFIX}{}",
                    STANDARD.encode(sealed)
                )))
            }
            other => Ok(other.clone()),
        }
    }

    /// After reading: no prefix means a legacy plaintext value, returned untouched. A prefixed
    /// value this machine cannot decrypt is an error, and `read_file` preserves the ciphertext.
    pub fn decode(&self, value: &Value) -> Result<Value, String> {
        let Value::String(text) = value else {
            return Ok(value.clone());
        };
        let Some(payload) = text.strip_prefix(CIPHER_PREFIX) else {
            return Ok(value.clone());
        };
        if !self.available {
            return Err(KEYCHAIN_DECODE_FAILED.to_string());
        }
        let sealed = STANDARD
            .decode(payload)
            .map_err(|error| format!("密文编码无法识别：{error}"))?;
        let plain = self.open(&sealed)?;
        match String::from_utf8(plain) {
            Ok(text) => Ok(Value::String(text)),
            Err(_) => Err("解密结果不是字符串".to_string()),
        }
    }

    pub fn describe(&self) -> SecretDescription {
        SecretDescription {
            encrypted: self.available,
            // Chromium's `safeStorage` on Windows *is* DPAPI, so the label is accurate, not a lie.
            scheme: if self.available {
                "safe-storage".to_string()
            } else {
                "plaintext".to_string()
            },
            prefix: CIPHER_PREFIX.to_string(),
        }
    }
}

#[cfg(test)]
fn reversible_xor(bytes: &[u8]) -> Vec<u8> {
    // Deliberately not encryption: the test only needs "the file must not contain the plaintext".
    bytes.iter().map(|byte| byte ^ 0x5a).collect()
}

#[cfg(windows)]
mod native {
    use windows::{
        core::PCWSTR,
        Win32::Foundation::{LocalFree, HLOCAL},
        Win32::Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
        },
    };

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// Copies DPAPI's `LocalAlloc` buffer out and frees it; leaking would grow on every key write.
    unsafe fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = if blob.pbData.is_null() || blob.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
        };
        if !blob.pbData.is_null() {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
        }
        bytes
    }

    pub(super) fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // `CRYPTPROTECT_UI_FORBIDDEN`: never pop a prompt out of a background write.
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| format!("DPAPI 加密失败：{error}"))?;
            Ok(take(output))
        }
    }

    pub(super) fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed);
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| format!("DPAPI 解密失败：{error}"))?;
            Ok(take(output))
        }
    }

    pub(super) fn probe() -> bool {
        let probe = b"artflow-keychain-probe";
        protect(probe)
            .and_then(|sealed| unprotect(&sealed))
            .is_ok_and(|plain| plain == probe)
    }
}

// ———————————————————————————— reply shapes ————————————————————————————

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub ok: bool,
    pub values: Map<String, Value>,
    /// `file` | `backup` | `none` | `unreadable` | `safe-mode`
    pub source: String,
    pub schema_version: i64,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<i64>,
}

impl ConfigSnapshot {
    fn failure(message: impl ToString) -> Self {
        Self {
            ok: false,
            values: Map::new(),
            source: "unreadable".to_string(),
            schema_version: CONFIG_SCHEMA_VERSION,
            degraded: true,
            message: Some(message.to_string()),
            migrated_from: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ConfigWriteResult {
    fn ok() -> Self {
        Self {
            ok: true,
            count: None,
            bytes: None,
            message: None,
        }
    }

    fn written(count: usize, bytes: usize) -> Self {
        Self {
            ok: true,
            count: Some(count),
            bytes: Some(bytes),
            message: None,
        }
    }

    fn failed(message: impl ToString) -> Self {
        Self {
            ok: false,
            count: None,
            bytes: None,
            message: Some(message.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStoreStats {
    pub file_path: String,
    pub exists: bool,
    pub bytes: u64,
    pub key_count: usize,
    pub schema_version: i64,
    pub source: String,
    pub degraded: bool,
    pub updated_at: Option<String>,
    pub safe_mode: bool,
    pub encrypted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_preset: Option<bool>,
}

/// `ConfigPaths` — everything is derived from the app data dir, exactly like
/// `app.getPath('userData')` upstream. Windows resolves it per bundle identifier, so an existing
/// Electron install (`%APPDATA%\artflow-zho\config`) is **not** read here; see the task report.
#[derive(Debug, Clone)]
pub struct ConfigPaths {
    pub data_root: PathBuf,
    pub config_root: PathBuf,
    pub preset_root: PathBuf,
    pub cache_root: PathBuf,
    pub log_root: PathBuf,
}

impl ConfigPaths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let data_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        Ok(Self::under(&data_root))
    }

    /// Same layout for any data dir: `config/`, `config/presets/`, `temp/`, `logs/`.
    /// Split out from `resolve` so tests can build the tree without a running `AppHandle`.
    pub fn under(data_root: &Path) -> Self {
        let config_root = data_root.join("config");
        Self {
            preset_root: config_root.join("presets"),
            log_root: data_root.join("logs"),
            cache_root: data_root.join("temp"),
            config_root,
            data_root: data_root.to_path_buf(),
        }
    }
}

// ———————————————————————————— the store ————————————————————————————

/// Disk snapshot **before** decoding: internal consistency checks need the real content, or a
/// "file comes from a newer build" would be swallowed by the safe-mode short circuit.
struct FileSnapshot {
    ok: bool,
    values: Map<String, Value>,
    preserved: Map<String, Value>,
    source: &'static str,
    schema_version: i64,
    degraded: bool,
    message: Option<String>,
}

impl FileSnapshot {
    fn into_snapshot(self) -> ConfigSnapshot {
        ConfigSnapshot {
            ok: self.ok,
            values: self.values,
            source: self.source.to_string(),
            schema_version: self.schema_version,
            degraded: self.degraded,
            message: self.message,
            migrated_from: None,
        }
    }
}

/// Parsed envelope: `{ schemaVersion, values: {} }`. Extra fields are ignored on purpose so a
/// newer build can add metadata without this one refusing to read the file.
struct ParsedEnvelope {
    values: Map<String, Value>,
    schema_version: Option<i64>,
}

fn parse_envelope(raw: &str) -> Option<ParsedEnvelope> {
    if raw.trim().is_empty() {
        return None;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let values = match object.get("values") {
        Some(Value::Object(values)) => values.clone(),
        _ => return None,
    };
    let schema_version = match object.get("schemaVersion") {
        None => None,
        Some(Value::Number(number)) => {
            let value = number.as_f64()?;
            // `Number.isInteger`: 1.0 is an integer, 1.5 is not.
            if !value.is_finite() || value.fract() != 0.0 {
                return None;
            }
            Some(value as i64)
        }
        Some(_) => return None,
    };
    Some(ParsedEnvelope {
        values,
        schema_version,
    })
}

pub struct ConfigStore {
    file_path: PathBuf,
    backup_path: PathBuf,
    temp_path: PathBuf,
    schema_version: i64,
    safe_mode: bool,
    codec: Option<SecretCodec>,
    restrict_permissions: bool,
}

impl ConfigStore {
    pub fn new(
        file_path: PathBuf,
        safe_mode: bool,
        codec: Option<SecretCodec>,
        restrict_permissions: bool,
    ) -> Self {
        let backup_path = PathBuf::from(format!("{}.backup", file_path.display()));
        let temp_path = PathBuf::from(format!("{}.tmp", file_path.display()));
        Self {
            file_path,
            backup_path,
            temp_path,
            schema_version: CONFIG_SCHEMA_VERSION,
            safe_mode,
            codec,
            restrict_permissions,
        }
    }

    /// The store for a whitelisted volume name, or `None` for anything else. Unknown names are
    /// rejected by the command layer, never mapped onto a default file.
    pub fn for_volume(paths: &ConfigPaths, name: &str, safe_mode: bool) -> Option<Self> {
        let spec = volume_spec(name)?;
        let codec = spec.encrypted.then(SecretCodec::system);
        Some(Self::new(
            paths.config_root.join(spec.file),
            safe_mode,
            codec,
            spec.restrict_permissions,
        ))
    }

    fn encrypted(&self) -> bool {
        self.codec.is_some()
    }

    fn read_raw_file(&self) -> FileSnapshot {
        let primary_raw = read_if_exists(&self.file_path);
        let Some(primary_raw) = primary_raw else {
            // Distinguish "never written" (a normal first start) from "present but unreadable"
            // — the second one must warn instead of looking like a clean slate.
            if !self.file_path.exists() {
                return FileSnapshot {
                    ok: true,
                    values: Map::new(),
                    preserved: Map::new(),
                    source: "none",
                    schema_version: self.schema_version,
                    degraded: false,
                    message: None,
                };
            }
            return FileSnapshot {
                ok: false,
                values: Map::new(),
                preserved: Map::new(),
                source: "unreadable",
                schema_version: self.schema_version,
                degraded: true,
                message: Some(format!("无法读取 {}", self.file_path.display())),
            };
        };

        if let Some(primary) = parse_envelope(&primary_raw) {
            let file_version = primary.schema_version.unwrap_or(self.schema_version);
            if file_version > self.schema_version {
                // Values are readable but must not be written back: an old build overwriting a
                // newer file would downgrade the user's config for good.
                return FileSnapshot {
                    ok: false,
                    values: primary.values,
                    preserved: Map::new(),
                    source: "file",
                    schema_version: file_version,
                    degraded: true,
                    message: Some(format!(
                        "配置文件版本 {file_version} 高于当前支持的 {}，已只读载入",
                        self.schema_version
                    )),
                };
            }
            // No volume declares a migration (same as `main.cjs`), so an older file loads as-is
            // carrying its own version number, which is what upstream does without `migrate`.
            return FileSnapshot {
                ok: true,
                values: primary.values,
                preserved: Map::new(),
                source: "file",
                schema_version: file_version,
                degraded: false,
                message: None,
            };
        }

        // A corrupt primary falls back to the last usable snapshot instead of reading as empty.
        if let Some(backup) = read_if_exists(&self.backup_path).and_then(|raw| parse_envelope(&raw)) {
            return FileSnapshot {
                ok: false,
                values: backup.values,
                preserved: Map::new(),
                source: "backup",
                schema_version: self.schema_version,
                degraded: true,
                message: Some("配置文件损坏，已回退到上次可用快照".to_string()),
            };
        }

        FileSnapshot {
            ok: false,
            values: Map::new(),
            preserved: Map::new(),
            source: "unreadable",
            schema_version: self.schema_version,
            degraded: true,
            message: Some("配置文件与备份均无法解析".to_string()),
        }
    }

    /// Decoding wrapper. Keys this machine cannot decrypt are **removed from `values`** (the
    /// renderer must not see ciphertext) but their raw text goes into `preserved` and is written
    /// back untouched — "could not decrypt this time" must never become "secret deleted".
    fn read_file(&self) -> FileSnapshot {
        let mut snapshot = self.read_raw_file();
        let Some(codec) = self.codec else {
            return snapshot;
        };
        let mut values = Map::new();
        let mut preserved = Map::new();
        let mut undecodable: Vec<String> = Vec::new();
        for (key, raw) in std::mem::take(&mut snapshot.values) {
            match codec.decode(&raw) {
                Ok(decoded) => {
                    values.insert(key, decoded);
                }
                Err(_) => {
                    undecodable.push(key.clone());
                    preserved.insert(key, raw);
                }
            }
        }
        snapshot.values = values;
        snapshot.preserved = preserved;
        if !undecodable.is_empty() {
            snapshot.degraded = true;
            let head = snapshot
                .message
                .as_ref()
                .map(|message| format!("{message}；"))
                .unwrap_or_default();
            snapshot.message = Some(format!(
                "{head}有 {} 项密钥无法解密（{}）",
                undecodable.len(),
                undecodable.join(", ")
            ));
        }
        snapshot
    }

    /// Public read. Safe mode does **not** consume user data and is not a failure: empty values
    /// with `degraded:false`, because nothing is broken — the user asked for a factory start.
    pub fn read(&self) -> ConfigSnapshot {
        if self.safe_mode {
            return ConfigSnapshot {
                ok: true,
                values: Map::new(),
                source: "safe-mode".to_string(),
                schema_version: self.schema_version,
                degraded: false,
                message: Some(SAFE_MODE_READ_MESSAGE.to_string()),
                migrated_from: None,
            };
        }
        self.read_file().into_snapshot()
    }

    fn envelope(&self, values: Map<String, Value>) -> Value {
        let mut envelope = Map::new();
        envelope.insert(
            "schemaVersion".to_string(),
            Value::Number(self.schema_version.into()),
        );
        envelope.insert("updatedAt".to_string(), Value::String(iso_timestamp_now()));
        envelope.insert("values".to_string(), Value::Object(values));
        Value::Object(envelope)
    }

    fn write_envelope(
        &self,
        values: Map<String, Value>,
        preserved: Map<String, Value>,
    ) -> ConfigWriteResult {
        let mut stored = values.clone();
        if let Some(codec) = self.codec {
            // `preserved` entries are already ciphertext; encoding them again would double-seal
            // them and lose the value forever.
            let mut next = preserved;
            for (key, value) in std::mem::take(&mut stored) {
                if next.contains_key(&key) {
                    continue;
                }
                match codec.encode(&value) {
                    Ok(encoded) => {
                        next.insert(key, encoded);
                    }
                    Err(message) => {
                        return ConfigWriteResult::failed(format!("配置加密失败（{key}）：{message}"));
                    }
                }
            }
            stored = next;
        }

        let serialized = match serde_json::to_string_pretty(&self.envelope(stored)) {
            Ok(serialized) => serialized,
            Err(error) => return ConfigWriteResult::failed(format!("配置序列化失败：{error}")),
        };

        if let Some(parent) = self.file_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return ConfigWriteResult::failed(error);
            }
        }

        // Back up the last *usable* content, so a rollback lands on a good state rather than the
        // half-written thing.
        if let Some(current) = read_if_exists(&self.file_path) {
            if parse_envelope(&current).is_some() {
                let _ = fs::write(&self.backup_path, current.as_bytes());
            }
        }

        if let Err(error) = fs::write(&self.temp_path, serialized.as_bytes()) {
            let _ = fs::remove_file(&self.temp_path);
            return ConfigWriteResult::failed(error);
        }
        if let Err(error) = fs::rename(&self.temp_path, &self.file_path) {
            let _ = fs::remove_file(&self.temp_path);
            return ConfigWriteResult::failed(error);
        }
        if self.restrict_permissions {
            // On POSIX this is "nobody else can read it"; on Windows `chmod` is a no-op and
            // DPAPI does the real work. Failing to tighten is not a reason to call the write
            // failed.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.file_path, fs::Permissions::from_mode(0o600));
            }
        }

        ConfigWriteResult::written(values.len(), serialized.len())
    }

    /// Validate, read, merge, write. Order matters: a file from a newer build and an unreadable
    /// file are both refused **before** anything is overwritten.
    fn apply_changes(
        &self,
        changes: Vec<(String, Value)>,
        remove: Vec<String>,
    ) -> ConfigWriteResult {
        if self.safe_mode {
            return ConfigWriteResult::failed(SAFE_MODE_WRITE_REJECTED);
        }
        for (key, value) in &changes {
            if let Err(message) = check_key(key) {
                return ConfigWriteResult::failed(message);
            }
            if !is_storable_value(value, 0) {
                return ConfigWriteResult::failed(format!(
                    "值必须是 JSON 可序列化的原始值或普通对象：{key}"
                ));
            }
        }

        let snapshot = self.read_file();
        if snapshot.schema_version > self.schema_version {
            return ConfigWriteResult {
                ok: false,
                count: None,
                bytes: None,
                message: snapshot.message,
            };
        }
        if !snapshot.ok
            && snapshot.source == "unreadable"
            && snapshot
                .message
                .as_deref()
                .is_some_and(|message| message.contains("均无法解析"))
        {
            return ConfigWriteResult::failed("配置文件不可读，拒绝覆盖（请先人工检查该文件）");
        }

        let mut next = snapshot.values;
        let mut preserved = snapshot.preserved;
        for key in &remove {
            next.remove(key);
            preserved.remove(key);
        }
        for (key, value) in changes {
            next.insert(key, value);
        }
        self.write_envelope(next, preserved)
    }

    pub fn set(&self, key: &str, value: Value) -> ConfigWriteResult {
        self.apply_changes(vec![(key.to_string(), value)], Vec::new())
    }

    pub fn patch(&self, values: Map<String, Value>) -> ConfigWriteResult {
        self.apply_changes(values.into_iter().collect(), Vec::new())
    }

    /// `keys: None` clears the volume including preserved ciphertext; `Some(keys)` removes exactly
    /// those keys.
    pub fn reset(&self, keys: Option<Vec<String>>) -> ConfigWriteResult {
        match keys {
            Some(keys) => self.apply_changes(Vec::new(), keys),
            None => {
                let snapshot = self.read_file();
                let mut all: Vec<String> = snapshot.values.keys().cloned().collect();
                all.extend(snapshot.preserved.keys().cloned());
                self.apply_changes(Vec::new(), all)
            }
        }
    }

    pub fn stats(&self, safe_mode: bool) -> ConfigStoreStats {
        let snapshot = self.read_file();
        let mut bytes = 0u64;
        let mut updated_at = None;
        let mut key_count = snapshot.values.len() + snapshot.preserved.len();
        if let Ok(metadata) = fs::metadata(&self.file_path) {
            bytes = metadata.len();
            // Count what is **on disk**, not what decoded: undecryptable keys are still stored
            // keys, and the storage panel tells the user how much is in the file.
            if let Ok(raw) = fs::read_to_string(&self.file_path) {
                if let Ok(document) = serde_json::from_str::<Value>(&raw) {
                    if let Some(Value::Object(values)) = document.get("values") {
                        key_count = values.len();
                    }
                    updated_at = document
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
        }
        ConfigStoreStats {
            file_path: self.file_path.display().to_string(),
            exists: self.file_path.exists(),
            bytes,
            key_count,
            schema_version: snapshot.schema_version,
            source: snapshot.source.to_string(),
            degraded: snapshot.degraded,
            updated_at,
            safe_mode,
            encrypted: self.encrypted(),
            in_preset: None,
        }
    }
}

struct VolumeSpec {
    name: &'static str,
    file: &'static str,
    encrypted: bool,
    restrict_permissions: bool,
}

/// The whitelist itself. An unknown name returns `None`; the command layer turns that into
/// `unknown config store` rather than guessing a file, because a mis-mapped name would write the
/// wrong volume.
fn volume_spec(name: &str) -> Option<VolumeSpec> {
    let (name, file) = match name {
        "preferences" => ("preferences", "preferences.json"),
        "workspace" => ("workspace", "workspace.json"),
        "recent-files" => ("recent-files", "recent-files.json"),
        "secrets" => ("secrets", "secrets.json"),
        "ai-providers" => ("ai-providers", "ai-providers.json"),
        _ => return None,
    };
    let encrypted = name == "secrets";
    Some(VolumeSpec {
        name,
        file,
        encrypted,
        // The secrets file is the only one worth tightening: it stays ciphertext either way, but
        // a 0600 mode keeps the key material off other accounts on POSIX.
        restrict_permissions: encrypted,
    })
}

// ———————————————————————————— preset library ————————————————————————————

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSummary {
    pub name: String,
    pub bytes: u64,
    pub updated_at: String,
    pub volumes: Vec<String>,
    pub exported_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedVolume {
    pub ok: bool,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub struct PresetLibrary {
    dir_path: PathBuf,
}

fn assert_preset_name(name: &str) -> Result<(), String> {
    // The whitelist has no path separators, which removes path traversal at the root.
    if name.is_empty()
        || utf16_len(name) > MAX_PRESET_NAME_LENGTH
        || !is_key_pattern(name)
    {
        return Err(PRESET_NAME_ERROR.to_string());
    }
    Ok(())
}

impl PresetLibrary {
    pub fn new(dir_path: PathBuf) -> Self {
        Self { dir_path }
    }

    fn file_of(&self, name: &str) -> Result<PathBuf, String> {
        assert_preset_name(name)?;
        Ok(self.dir_path.join(format!("{name}.json")))
    }

    fn read_json(&self, path: &Path) -> Result<Value, String> {
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_PRESET_FILE_BYTES {
            return Err("预设文件过大（>2MB）".to_string());
        }
        let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| error.to_string())
    }

    /// A file that fails to parse is skipped, not reported: it still exists on disk for the user
    /// to deal with, and one bad file must not hide the others.
    pub fn list(&self) -> Vec<PresetSummary> {
        let Ok(entries) = fs::read_dir(&self.dir_path) else {
            return Vec::new();
        };
        let mut presets = Vec::new();
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = file_name.strip_suffix(".json").map(str::to_string) else {
                continue;
            };
            if !entry.path().is_file() || !is_key_pattern(&name) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(document) = self.read_json(&entry.path()) else {
                continue;
            };
            // Only this module's own shape: a random JSON file dropped in the folder must not be
            // listed as a preset and invite a click that is guaranteed to fail.
            if !document.is_object() || document.get("kind").and_then(Value::as_str) != Some(PRESET_KIND)
            {
                continue;
            }
            let volumes = document
                .get("volumes")
                .and_then(Value::as_object)
                .map(|volumes| volumes.keys().cloned().collect())
                .unwrap_or_default();
            let exported_at = document
                .get("exportedAt")
                .and_then(Value::as_str)
                .map(str::to_string);
            presets.push(PresetSummary {
                name,
                bytes: metadata.len(),
                updated_at: metadata
                    .modified()
                    .map(iso_from_system_time)
                    .unwrap_or_else(|_| String::new()),
                volumes,
                exported_at,
            });
        }
        presets.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        presets
    }

    pub fn write(
        &self,
        name: &str,
        volumes: &Map<String, Value>,
        app_version: Option<&str>,
    ) -> ConfigWriteResult {
        if let Err(message) = assert_preset_name(name) {
            return ConfigWriteResult::failed(message);
        }
        if volumes.is_empty() {
            return ConfigWriteResult::failed("预设内容为空：没有可导出的配置");
        }
        let mut document = Map::new();
        document.insert("kind".to_string(), Value::String(PRESET_KIND.to_string()));
        document.insert(
            "schemaVersion".to_string(),
            Value::Number(PRESET_SCHEMA_VERSION.into()),
        );
        document.insert(
            "exportedAt".to_string(),
            Value::String(iso_timestamp_now()),
        );
        let mut app = Map::new();
        app.insert(
            "version".to_string(),
            app_version.map_or(Value::Null, |version| Value::String(version.to_string())),
        );
        document.insert("app".to_string(), Value::Object(app));
        document.insert("volumes".to_string(), Value::Object(volumes.clone()));

        let file_path = match self.file_of(name) {
            Ok(file_path) => file_path,
            Err(message) => return ConfigWriteResult::failed(message),
        };
        let temp_path = PathBuf::from(format!("{}.tmp", file_path.display()));
        let Ok(serialized) = serde_json::to_string_pretty(&Value::Object(document)) else {
            return ConfigWriteResult::failed("预设序列化失败");
        };
        if serialized.len() as u64 > MAX_PRESET_FILE_BYTES {
            return ConfigWriteResult::failed("预设过大（>2MB）");
        }
        if let Err(error) = fs::create_dir_all(&self.dir_path) {
            return ConfigWriteResult::failed(error);
        }
        let result = fs::write(&temp_path, serialized.as_bytes())
            .and_then(|()| fs::rename(&temp_path, &file_path));
        match result {
            Ok(()) => ConfigWriteResult::written(volumes.len(), serialized.len()),
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                ConfigWriteResult::failed(error)
            }
        }
    }

    /// Returns the preset's `volumes` map; a shape mismatch is an explicit error so half a
    /// document never reaches the stores.
    pub fn read(&self, name: &str) -> Result<Map<String, Value>, String> {
        let file_path = self.file_of(name)?;
        let document = self
            .read_json(&file_path)
            .map_err(|error| format!("无法读取预设：{error}"))?;
        if document.get("kind").and_then(Value::as_str) != Some(PRESET_KIND) {
            return Err("不是 Artflow 预设文件（kind 不匹配）".to_string());
        }
        match document.get("volumes") {
            Some(Value::Object(volumes)) => Ok(volumes.clone()),
            _ => Err("预设内容缺失（volumes 不是对象）".to_string()),
        }
    }

    pub fn remove(&self, name: &str) -> ConfigWriteResult {
        let file_path = match self.file_of(name) {
            Ok(file_path) => file_path,
            Err(message) => return ConfigWriteResult::failed(message),
        };
        if file_path.exists() {
            if let Err(error) = fs::remove_file(&file_path) {
                return ConfigWriteResult::failed(error);
            }
        }
        ConfigWriteResult::ok()
    }

    pub fn dir_path(&self) -> &Path {
        &self.dir_path
    }

    /// Volumes worth putting in a preset: the same two Electron collects, and only when the
    /// volume actually holds something.
    pub fn collect(&self, paths: &ConfigPaths, safe_mode: bool) -> Map<String, Value> {
        let mut volumes = Map::new();
        for name in PRESET_VOLUMES {
            let Some(store) = ConfigStore::for_volume(paths, name, safe_mode) else {
                continue;
            };
            let snapshot = store.read_file();
            if !snapshot.values.is_empty() {
                volumes.insert(name.to_string(), Value::Object(snapshot.values));
            }
        }
        volumes
    }

    /// Apply a preset's volumes. Every volume is patched independently so one failure does not
    /// hide the others, and the caller gets a per-volume report.
    pub fn apply(
        &self,
        volumes: &Map<String, Value>,
        paths: &ConfigPaths,
        safe_mode: bool,
    ) -> (usize, BTreeMap<String, AppliedVolume>) {
        let mut applied = BTreeMap::new();
        let mut failed = 0usize;
        for name in PRESET_VOLUMES {
            let Some(Value::Object(values)) = volumes.get(name) else {
                continue;
            };
            let Some(store) = ConfigStore::for_volume(paths, name, safe_mode) else {
                continue;
            };
            let result = store.patch(values.clone());
            if !result.ok {
                failed += 1;
            }
            applied.insert(
                name.to_string(),
                AppliedVolume {
                    ok: result.ok,
                    count: values.len(),
                    message: result.message,
                },
            );
        }
        (failed, applied)
    }
}

// ———————————————————————————— directory helpers ————————————————————————————

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            total += directory_size(&entry.path());
        } else {
            total += metadata.len();
        }
    }
    total
}

/// `clearCache`. The guard is not decoration: a wrong `temp` would delete user documents, so the
/// resolved path must still be `<data>/temp` before anything is removed.
fn clear_cache(paths: &ConfigPaths) -> Result<PathBuf, String> {
    let target = paths.cache_root.clone();
    let is_temp = target.file_name().is_some_and(|name| name == "temp");
    let inside_data = target.starts_with(&paths.data_root);
    if !is_temp || !inside_data {
        return Err(format!("拒绝清空非缓存目录：{}", target.display()));
    }
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    Ok(target)
}

// ———————————————————————————— caller check ————————————————————————————

// Same rule as `main.rs` / `declarative.rs`: only the `main` webview on a trusted origin may
// touch user data.
fn trusted_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !cfg!(feature = "custom-protocol") {
        url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(4002)
    } else {
        (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none())
            || (url.scheme() == "tauri"
                && url.host_str() == Some("localhost")
                && url.port().is_none())
    }
}

fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

// ———————————————————————————— commands ————————————————————————————

#[derive(Debug, Deserialize)]
pub struct ConfigWriteRequest {
    #[serde(default)]
    pub store: String,
    #[serde(default)]
    pub op: String,
    /// Everything else exactly as the renderer sent it. Parsed by hand because
    /// `Option<Value>` cannot distinguish an absent `value` (→ `undefined`, which must be
    /// rejected) from an explicit `null` (a legal value).
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetRequest {
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StorageRequest {
    #[serde(default)]
    pub op: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<PresetSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<BTreeMap<String, AppliedVolume>>,
}

impl ConfigReply {
    fn failed(message: impl ToString) -> Self {
        Self {
            ok: false,
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub ok: bool,
    pub config_root: String,
    pub volumes: BTreeMap<String, ConfigStoreStats>,
    pub cache: CacheOverview,
    pub presets: Vec<PresetSummary>,
    pub presets_dir: String,
    pub secret: SecretDescription,
    pub safe_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheOverview {
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
}

/// `storageOverview()` resolves to the overview object itself, so success is the plain struct and
/// failure is `{ ok: false, message }` — hence the untagged representation.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum StorageReply {
    Overview(StorageOverview),
    Failed(ConfigReply),
}

fn paths_of(window: &WebviewWindow) -> Result<ConfigPaths, String> {
    ConfigPaths::resolve(&window.app_handle().clone())
}

// ———————————————————————————— volume operations (shared by commands and the sync channel) ————————————————————————————

/// Unknown names answer with the exact shape Electron's read handler returns for a bad volume, so
/// the renderer's `snapshot.ok === false` path is exercised identically on both hosts.
pub(crate) fn read_volume(paths: &ConfigPaths, safe_mode: bool, store: &str) -> ConfigSnapshot {
    match ConfigStore::for_volume(paths, store, safe_mode) {
        Some(target) => target.read(),
        None => ConfigSnapshot {
            ok: false,
            values: Map::new(),
            source: "unreadable".to_string(),
            schema_version: CONFIG_SCHEMA_VERSION,
            degraded: true,
            message: Some("unknown config store".to_string()),
            migrated_from: None,
        },
    }
}

/// `payload` is the renderer's `{ op, key?, value?, values?, keys? }` object. Parsed by hand for
/// the same reason `ConfigWriteRequest` flattens: `Option<Value>` cannot tell an absent `value`
/// (→ `undefined`, rejected) from an explicit `null` (a legal stored value).
pub(crate) fn write_volume(
    paths: &ConfigPaths,
    safe_mode: bool,
    store: &str,
    payload: &Map<String, Value>,
) -> ConfigWriteResult {
    let Some(target) = ConfigStore::for_volume(paths, store, safe_mode) else {
        return ConfigWriteResult::failed("unknown config store");
    };
    let op = payload.get("op").and_then(Value::as_str).unwrap_or_default();
    match op {
        "set" => {
            let key = match payload.get("key") {
                Some(Value::String(key)) => key.clone(),
                Some(other) => {
                    return ConfigWriteResult::failed(format!("invalid config key: {other}"))
                }
                None => return ConfigWriteResult::failed("invalid config key: undefined"),
            };
            let Some(value) = payload.get("value") else {
                return ConfigWriteResult::failed(format!("值不可序列化（undefined）：{key}"));
            };
            target.set(&key, value.clone())
        }
        "patch" => match payload.get("values") {
            Some(Value::Object(values)) => target.patch(values.clone()),
            _ => ConfigWriteResult::failed("patch 需要一个普通对象"),
        },
        "reset" => match payload.get("keys") {
            None => target.reset(None),
            Some(Value::Array(keys)) => {
                let mut names = Vec::with_capacity(keys.len());
                for key in keys {
                    match key {
                        Value::String(name) => names.push(name.clone()),
                        other => {
                            return ConfigWriteResult::failed(format!(
                                "reset 的 keys 必须是数组：{other}"
                            ))
                        }
                    }
                }
                target.reset(Some(names))
            }
            Some(_) => ConfigWriteResult::failed("reset 的 keys 必须是数组"),
        },
        other => ConfigWriteResult::failed(format!("unsupported config op: {other}")),
    }
}

fn stats_volume(
    paths: &ConfigPaths,
    safe_mode: bool,
    store: &str,
) -> Option<ConfigStoreStats> {
    let target = ConfigStore::for_volume(paths, store, safe_mode)?;
    Some(target.stats(safe_mode))
}

// ———————————————————————————— commands ————————————————————————————

#[tauri::command]
pub fn tauri_config_read(window: WebviewWindow, store: String) -> ConfigSnapshot {
    if !authorized(&window) {
        return ConfigSnapshot::failure("untrusted renderer");
    }
    let Ok(paths) = paths_of(&window) else {
        return ConfigSnapshot::failure("无法定位应用数据目录");
    };
    read_volume(&paths, crate::declarative::safe_mode(), &store)
}

#[tauri::command]
pub fn tauri_config_write(window: WebviewWindow, request: ConfigWriteRequest) -> ConfigWriteResult {
    if !authorized(&window) {
        return ConfigWriteResult::failed("untrusted renderer");
    }
    let Ok(paths) = paths_of(&window) else {
        return ConfigWriteResult::failed("无法定位应用数据目录");
    };
    // `op` is a named field on the request, so `#[serde(flatten)] rest` never contains it —
    // hand it back to the payload the hand-rolled parser expects.
    let mut payload = request.rest;
    payload.insert("op".to_string(), Value::String(request.op));
    write_volume(
        &paths,
        crate::declarative::safe_mode(),
        &request.store,
        &payload,
    )
}

#[tauri::command]
pub fn tauri_config_stats(window: WebviewWindow, store: String) -> Option<ConfigStoreStats> {
    if !authorized(&window) {
        return None;
    }
    let paths = paths_of(&window).ok()?;
    stats_volume(&paths, crate::declarative::safe_mode(), &store)
}

#[tauri::command]
pub async fn tauri_config_presets(window: WebviewWindow, request: PresetRequest) -> ConfigReply {
    if !authorized(&window) {
        return ConfigReply::failed("untrusted renderer");
    }
    let Ok(paths) = paths_of(&window) else {
        return ConfigReply::failed("无法定位应用数据目录");
    };
    let safe_mode = crate::declarative::safe_mode();
    let library = PresetLibrary::new(paths.preset_root.clone());

    if matches!(request.op.as_str(), "save" | "load" | "import-from") && safe_mode {
        return ConfigReply::failed(SAFE_MODE_WRITE_REJECTED);
    }

    match request.op.as_str() {
        "list" => ConfigReply {
            ok: true,
            presets: Some(library.list()),
            ..ConfigReply::default()
        },
        "save" => {
            let name = request.name.clone().unwrap_or_default();
            let volumes = library.collect(&paths, safe_mode);
            let app = window.app_handle().clone();
            let version = app.package_info().version.to_string();
            let result = library.write(&name, &volumes, Some(version.as_str()));
            ConfigReply {
                ok: result.ok,
                message: result.message,
                file_path: library
                    .file_of(&name)
                    .ok()
                    .map(|path| path.display().to_string())
                    .filter(|_| result.ok),
                bytes: result.bytes,
                ..ConfigReply::default()
            }
        }
        "load" => {
            let name = request.name.clone().unwrap_or_default();
            let volumes = match library.read(&name) {
                Ok(volumes) => volumes,
                Err(message) => return ConfigReply::failed(message),
            };
            let (failed, applied) = library.apply(&volumes, &paths, safe_mode);
            if applied.is_empty() {
                return ConfigReply {
                    ok: false,
                    message: Some("预设里没有可应用的配置".to_string()),
                    applied: Some(applied),
                    ..ConfigReply::default()
                };
            }
            ConfigReply {
                ok: failed == 0,
                message: (failed > 0).then(|| "部分配置写入失败，详见日志".to_string()),
                applied: Some(applied),
                ..ConfigReply::default()
            }
        }
        "remove" => {
            let name = request.name.clone().unwrap_or_default();
            let result = library.remove(&name);
            ConfigReply {
                ok: result.ok,
                message: result.message,
                ..ConfigReply::default()
            }
        }
        "export-to" => {
            let volumes = library.collect(&paths, safe_mode);
            if volumes.is_empty() {
                return ConfigReply::failed("没有可导出的配置");
            }
            let mut document = Map::new();
            document.insert("kind".to_string(), Value::String(PRESET_KIND.to_string()));
            document.insert(
                "schemaVersion".to_string(),
                Value::Number(PRESET_SCHEMA_VERSION.into()),
            );
            document.insert("exportedAt".to_string(), Value::String(iso_timestamp_now()));
            let mut app = Map::new();
            app.insert(
                "version".to_string(),
                Value::String(window.app_handle().package_info().version.to_string()),
            );
            document.insert("app".to_string(), Value::Object(app));
            document.insert("volumes".to_string(), Value::Object(volumes));
            let Ok(serialized) = serde_json::to_string_pretty(&Value::Object(document)) else {
                return ConfigReply::failed("预设序列化失败");
            };
            let default_name = format!("artflow-preset-{}.json", iso_timestamp_now()[..10].to_string());
            tauri::async_runtime::spawn_blocking(move || {
                let Some(path) = rfd::FileDialog::new()
                    .set_parent(&window)
                    .set_title("导出设置预设")
                    .set_file_name(&default_name)
                    .add_filter("Artflow preset", &["json"])
                    .save_file()
                else {
                    return ConfigReply {
                        ok: false,
                        canceled: Some(true),
                        ..ConfigReply::default()
                    };
                };
                match fs::write(&path, serialized.as_bytes()) {
                    Ok(()) => ConfigReply {
                        ok: true,
                        file_path: Some(path.display().to_string()),
                        ..ConfigReply::default()
                    },
                    Err(error) => ConfigReply::failed(error),
                }
            })
            .await
            .unwrap_or_else(ConfigReply::failed)
        }
        "import-from" => {
            let picked = tauri::async_runtime::spawn_blocking(move || {
                rfd::FileDialog::new()
                    .set_parent(&window)
                    .set_title("导入设置预设")
                    .add_filter("Artflow preset", &["json"])
                    .pick_file()
            })
            .await
            .unwrap_or(None);
            let Some(path) = picked else {
                return ConfigReply {
                    ok: false,
                    canceled: Some(true),
                    ..ConfigReply::default()
                };
            };
            if fs::metadata(&path)
                .map(|metadata| metadata.len() > MAX_PRESET_FILE_BYTES)
                .unwrap_or(false)
            {
                return ConfigReply::failed("预设文件过大（>2MB）");
            }
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(error) => return ConfigReply::failed(format!("无法读取该文件：{error}")),
            };
            let document: Value = match serde_json::from_str(&raw) {
                Ok(document) => document,
                Err(error) => return ConfigReply::failed(format!("无法读取该文件：{error}")),
            };
            let volumes = match document.get("volumes") {
                Some(Value::Object(volumes))
                    if document.get("kind").and_then(Value::as_str) == Some(PRESET_KIND) =>
                {
                    volumes.clone()
                }
                _ => return ConfigReply::failed("不是 Artflow 预设文件"),
            };
            let (failed, applied) = library.apply(&volumes, &paths, safe_mode);
            if applied.is_empty() {
                return ConfigReply {
                    ok: false,
                    message: Some("预设里没有可应用的配置".to_string()),
                    applied: Some(applied),
                    ..ConfigReply::default()
                };
            }
            ConfigReply {
                ok: failed == 0,
                message: (failed > 0).then(|| "部分配置写入失败，详见日志".to_string()),
                applied: Some(applied),
                ..ConfigReply::default()
            }
        }
        other => ConfigReply::failed(format!("不支持的预设操作：{other}")),
    }
}

#[tauri::command]
pub async fn tauri_config_storage(window: WebviewWindow, request: StorageRequest) -> StorageReply {
    if !authorized(&window) {
        return StorageReply::Failed(ConfigReply::failed("untrusted renderer"));
    }
    let Ok(paths) = paths_of(&window) else {
        return StorageReply::Failed(ConfigReply::failed("无法定位应用数据目录"));
    };
    let safe_mode = crate::declarative::safe_mode();
    match request.op.as_str() {
        "overview" => {
            let library = PresetLibrary::new(paths.preset_root.clone());
            let mut volumes = BTreeMap::new();
            for name in VOLUME_NAMES {
                let Some(store) = ConfigStore::for_volume(&paths, name, safe_mode) else {
                    continue;
                };
                let mut stats = store.stats(safe_mode);
                stats.in_preset = Some(PRESET_VOLUMES.contains(&name));
                volumes.insert(name.to_string(), stats);
            }
            StorageReply::Overview(StorageOverview {
                ok: true,
                config_root: paths.config_root.display().to_string(),
                volumes,
                cache: CacheOverview {
                    path: paths.cache_root.display().to_string(),
                    bytes: directory_size(&paths.cache_root),
                    exists: paths.cache_root.exists(),
                },
                presets: library.list(),
                presets_dir: paths.preset_root.display().to_string(),
                secret: SecretCodec::system().describe(),
                safe_mode,
            })
        }
        "clear-cache" => {
            if safe_mode {
                return StorageReply::Failed(ConfigReply::failed(SAFE_MODE_WRITE_REJECTED));
            }
            // `clear_cache` only needs the roots, and it walks a directory tree — keep that off
            // the webview thread so a large cache cannot freeze the window.
            let cache_paths = paths.clone();
            let removed = tauri::async_runtime::spawn_blocking(move || clear_cache(&cache_paths))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            match removed {
                Ok(path) => StorageReply::Failed(ConfigReply {
                    ok: true,
                    path: Some(path.display().to_string()),
                    ..ConfigReply::default()
                }),
                Err(message) => StorageReply::Failed(ConfigReply::failed(message)),
            }
        }
        other => StorageReply::Failed(ConfigReply::failed(format!(
            "不支持的存储操作：{other}"
        ))),
    }
}

#[tauri::command]
pub fn tauri_config_boot_log(window: WebviewWindow, payload: Value) {
    if !authorized(&window) {
        return;
    }
    let Ok(paths) = paths_of(&window) else {
        return;
    };
    let Some(line) = boot_log_line(&payload, &paths.config_root) else {
        return;
    };
    append_log(&paths.log_root, &line);
}

#[tauri::command]
pub fn tauri_config_boot_error(window: WebviewWindow, line: String) {
    if !authorized(&window) {
        return;
    }
    let Ok(paths) = paths_of(&window) else {
        return;
    };
    append_log(
        &paths.log_root,
        &format!("[启动错误] {}", truncate_utf16(&line, 1600)),
    );
}

fn boot_log_line(payload: &Value, config_root: &Path) -> Option<String> {
    let Value::Object(payload) = payload else {
        return None;
    };
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let degraded = payload
        .get("degraded")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let key_count = payload
        .get("keyCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let safe_mode = payload
        .get("safeMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || source == "host-safe-mode";
    let mut line = format!(
        "用户配置：来源={source}{} 键={key_count} 根={}",
        if degraded { "（降级）" } else { "" },
        config_root.display()
    );
    if safe_mode {
        line.push_str("\n  安全模式：已忽略用户配置，本次会话不写入用户数据");
    }
    if let Some(Value::Array(adopted)) = payload.get("adoptedLegacyKeys") {
        let keys: Vec<String> = adopted
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        if !keys.is_empty() {
            line.push_str(&format!("\n  已从旧 localStorage 采纳：{}", keys.join(", ")));
        }
    }
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        if !message.is_empty() {
            line.push_str(&format!("\n  [警告] 配置异常：{message}"));
        }
    }
    Some(line)
}

fn append_log(log_root: &Path, line: &str) {
    if fs::create_dir_all(log_root).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_root.join("tauri.log"))
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

// ———————————————————————————— startup cache for the injection script ————————————————————————————

/// Per-volume entry inside the injected cache: the snapshot the renderer reads synchronously plus
/// the stats `stats(store)` must answer from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedVolume {
    #[serde(flatten)]
    pub snapshot: ConfigSnapshot,
    pub stats: ConfigStoreStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupCache {
    pub schema_version: i64,
    pub safe_mode: bool,
    pub config_root: String,
    pub volumes: BTreeMap<String, CachedVolume>,
    pub secret: SecretDescription,
}

/// Reads every whitelisted volume once, before the webview exists, so `readStore()` can be
/// synchronous in the renderer.
pub fn startup_cache(app: &AppHandle) -> StartupCache {
    let safe_mode = crate::declarative::safe_mode();
    match ConfigPaths::resolve(app) {
        Ok(paths) => cache_for_paths(&paths, safe_mode),
        Err(_) => StartupCache {
            schema_version: CONFIG_SCHEMA_VERSION,
            safe_mode,
            config_root: String::new(),
            volumes: BTreeMap::new(),
            secret: SecretCodec::system().describe(),
        },
    }
}

fn cache_for_paths(paths: &ConfigPaths, safe_mode: bool) -> StartupCache {
    let secret = SecretCodec::system();
    let mut volumes = BTreeMap::new();
    for name in VOLUME_NAMES {
        let Some(store) = ConfigStore::for_volume(paths, name, safe_mode) else {
            continue;
        };
        volumes.insert(
            name.to_string(),
            CachedVolume {
                snapshot: store.read(),
                stats: store.stats(safe_mode),
            },
        );
    }
    StartupCache {
        schema_version: CONFIG_SCHEMA_VERSION,
        safe_mode,
        config_root: paths.config_root.display().to_string(),
        volumes,
        secret: secret.describe(),
    }
}

/// Test seam for `config_script`: the injected script is generated from a `StartupCache`, and
/// building one must not require a running `AppHandle`.
#[cfg(test)]
pub(crate) fn startup_cache_for_tests(data_root: &Path, safe_mode: bool) -> StartupCache {
    cache_for_paths(&ConfigPaths::under(data_root), safe_mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Self-cleaning temporary directory; every test gets its own so the suite can run in
    /// parallel.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let unique = format!(
                "artflow-config-{}-{}-{}",
                std::process::id(),
                label,
                COUNTER.fetch_add(1, Ordering::SeqCst)
            );
            let path = std::env::temp_dir().join(unique);
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("fixture root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(fixture: &Fixture, codec: Option<SecretCodec>) -> ConfigStore {
        ConfigStore::new(fixture.path().join("config").join("vol.json"), false, codec, false)
    }

    fn object(entries: &[(&str, Value)]) -> Map<String, Value> {
        let mut map = Map::new();
        for (key, value) in entries {
            map.insert((*key).to_string(), value.clone());
        }
        map
    }

    // ————————————————————————— keys and values —————————————————————————

    #[test]
    fn reserved_keys_are_rejected_before_they_can_pollute_prototypes() {
        for key in ["", "__proto__", "constructor", "prototype", "bad key", "-lead", "键"] {
            let error = check_key(key).expect_err(key);
            assert!(error.starts_with("invalid config key:"), "{key} => {error}");
        }
        let too_long = "a".repeat(MAX_KEY_LENGTH + 1);
        assert!(check_key(&too_long).is_err());
        assert!(check_key(&"a".repeat(MAX_KEY_LENGTH)).is_ok());
        for key in ["general.language", "canvas.view", "perf.hud.pos", "a_b-c.1"] {
            assert!(check_key(key).is_ok(), "{key}");
        }
    }

    #[test]
    fn storable_values_reject_what_the_file_could_not_round_trip() {
        assert!(is_storable_value(&Value::Null, 0));
        assert!(is_storable_value(&Value::Bool(true), 0));
        assert!(is_storable_value(&Value::from(1.5), 0));
        assert!(is_storable_value(&Value::String("zho".into()), 0));
        assert!(is_storable_value(&Value::String("a".repeat(MAX_STRING_LENGTH)), 0));
        assert!(!is_storable_value(
            &Value::String("a".repeat(MAX_STRING_LENGTH + 1)),
            0
        ));
        // Limits are counted in UTF-16 code units, like `String#length`.
        assert!(!is_storable_value(
            &Value::String("😀".repeat(MAX_STRING_LENGTH / 2 + 1)),
            0
        ));
        let long_array = Value::Array(vec![Value::Null; MAX_ARRAY_LENGTH + 1]);
        assert!(!is_storable_value(&long_array, 0));
        // A reserved key nested inside a value is just as dangerous as a top-level one.
        assert!(!is_storable_value(
            &Value::Object(object(&[("__proto__", Value::Bool(true))])),
            0
        ));
        let mut deep = Value::Null;
        for _ in 0..=MAX_DEPTH {
            deep = Value::Object(object(&[("next", deep)]));
        }
        assert!(!is_storable_value(&deep, 0));
    }

    // ————————————————————————— envelopes —————————————————————————

    #[test]
    fn a_file_from_a_newer_build_is_read_only() {
        let fixture = Fixture::new("newer");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("vol.json"),
            r#"{"schemaVersion":9,"updatedAt":"2030-01-01T00:00:00.000Z","values":{"a":1}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(dir.join("vol.json"), false, None, false);

        let snapshot = store.read();
        assert!(!snapshot.ok);
        assert!(snapshot.degraded);
        assert_eq!(snapshot.source, "file");
        assert_eq!(snapshot.schema_version, 9);
        assert_eq!(snapshot.values.get("a"), Some(&Value::from(1)));
        assert!(snapshot.message.unwrap().contains("高于当前支持的"));

        // Writing must be refused with the same message: downgrading a newer file would discard
        // whatever the newer build stored.
        let write = store.set("b", Value::from(2));
        assert!(!write.ok);
        assert!(write.message.unwrap().contains("高于当前支持的"));
    }

    #[test]
    fn a_corrupt_primary_falls_back_to_the_backup_snapshot() {
        let fixture = Fixture::new("backup");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vol.json"), "{not json").unwrap();
        fs::write(
            dir.join("vol.json.backup"),
            r#"{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","values":{"kept":true}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(dir.join("vol.json"), false, None, false);

        let snapshot = store.read();
        assert!(!snapshot.ok);
        assert!(snapshot.degraded);
        assert_eq!(snapshot.source, "backup");
        assert_eq!(snapshot.values.get("kept"), Some(&Value::Bool(true)));
        assert_eq!(snapshot.message.unwrap(), "配置文件损坏，已回退到上次可用快照");
    }

    #[test]
    fn an_unreadable_file_refuses_to_be_overwritten() {
        let fixture = Fixture::new("unreadable");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vol.json"), "{not json").unwrap();
        let store = ConfigStore::new(dir.join("vol.json"), false, None, false);

        let write = store.set("a", Value::from(1));
        assert!(!write.ok);
        assert_eq!(
            write.message.unwrap(),
            "配置文件不可读，拒绝覆盖（请先人工检查该文件）"
        );
        // The original bytes are untouched.
        assert_eq!(
            fs::read_to_string(dir.join("vol.json")).unwrap(),
            "{not json"
        );
    }

    #[test]
    fn writes_round_trip_and_keep_the_previous_snapshot_as_a_backup() {
        let fixture = Fixture::new("round-trip");
        let store = store(&fixture, None);

        assert!(store.read().ok);
        assert_eq!(store.read().source, "none");

        let first = store.set("general.language", Value::String("zho".into()));
        assert!(first.ok);
        assert_eq!(first.count, Some(1));
        assert!(first.bytes.unwrap() > 0);
        assert_eq!(
            store.read().values.get("general.language"),
            Some(&Value::String("zho".into()))
        );

        let second = store.patch(object(&[("a", Value::from(1)), ("b", Value::Bool(false))]));
        assert!(second.ok);
        let snapshot = store.read();
        assert_eq!(snapshot.values.len(), 3);
        // The backup holds the *previous* good content, not the just-written one.
        let backup = fs::read_to_string(format!(
            "{}.backup",
            fixture.path().join("config").join("vol.json").display()
        ))
        .unwrap();
        let parsed = parse_envelope(&backup).expect("backup envelope");
        assert_eq!(parsed.values.len(), 1);
        assert_eq!(
            parsed.values.get("general.language"),
            Some(&Value::String("zho".into()))
        );

        assert!(store.reset(Some(vec!["a".into()])).ok);
        assert!(store.read().values.get("a").is_none());
        assert!(store.reset(None).ok);
        assert!(store.read().values.is_empty());
    }

    #[test]
    fn stats_reports_the_persisted_envelope() {
        let fixture = Fixture::new("stats");
        let store = store(&fixture, None);
        store.set("a", Value::from(1));
        store.set("b", Value::from(2));

        let stats = store.stats(false);
        assert!(stats.exists);
        assert!(stats.bytes > 0);
        assert_eq!(stats.key_count, 2);
        assert_eq!(stats.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(stats.source, "file");
        assert!(!stats.degraded);
        assert!(!stats.safe_mode);
        assert!(!stats.encrypted);
        let updated_at = stats.updated_at.expect("updatedAt is present in the file");
        assert!(
            updated_at.len() == 24 && updated_at.ends_with('Z'),
            "{updated_at}"
        );
        assert_eq!(
            &updated_at[4..5],
            "-",
            "timestamp shape must match JS toISOString()"
        );
    }

    #[test]
    fn iso_timestamps_match_the_javascript_shape() {
        let now = iso_timestamp_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.is_ascii());
        assert!(now.ends_with('Z'));
        let bytes = now.as_bytes();
        assert_eq!(bytes[10], b'T');
        assert_eq!(bytes[19], b'.');
        // A known instant, so the calendar conversion is pinned, not just its formatting.
        let epoch = UNIX_EPOCH + std::time::Duration::from_millis(1_600_000_000_123);
        assert_eq!(iso_from_system_time(epoch), "2020-09-13T12:26:40.123Z");
    }

    // ————————————————————————— safe mode —————————————————————————

    #[test]
    fn safe_mode_reads_nothing_and_refuses_every_write() {
        let fixture = Fixture::new("safe-mode");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("vol.json"),
            r#"{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","values":{"a":1}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(dir.join("vol.json"), true, None, false);

        let snapshot = store.read();
        assert!(snapshot.ok, "a factory start is not a failure");
        assert!(!snapshot.degraded, "nothing is broken, so no warning banner");
        assert!(snapshot.values.is_empty());
        assert_eq!(snapshot.source, "safe-mode");
        assert_eq!(snapshot.message.as_deref(), Some(SAFE_MODE_READ_MESSAGE));

        let write = store.set("a", Value::from(2));
        assert!(!write.ok);
        assert_eq!(write.message.as_deref(), Some(SAFE_MODE_WRITE_REJECTED));
        // The file still holds the user's value: safe mode never rewrites or deletes.
        assert!(fs::read_to_string(dir.join("vol.json"))
            .unwrap()
            .contains("\"a\""));

        assert!(SAFE_MODE_READ_MESSAGE.contains(crate::declarative::SAFE_MODE_ENV));
        assert!(SAFE_MODE_WRITE_REJECTED.contains(crate::declarative::SAFE_MODE_ENV));
    }

    // ————————————————————————— secrets —————————————————————————

    #[test]
    fn a_missing_keychain_refuses_to_write_plaintext() {
        let codec = SecretCodec::unavailable();
        let error = codec
            .encode(&Value::String("sk-secret".into()))
            .expect_err("plaintext must never be written");
        assert_eq!(error, KEYCHAIN_ENCODE_FAILED);

        // Reading a legacy plaintext value keeps working.
        assert_eq!(
            codec.decode(&Value::String("legacy".into())).unwrap(),
            Value::String("legacy".into())
        );
        // A ciphertext this machine cannot open is an error, not a value.
        let error = codec
            .decode(&Value::String(format!("{CIPHER_PREFIX}AAAA")))
            .expect_err("undecryptable ciphertext must not pass as a value");
        assert_eq!(error, KEYCHAIN_DECODE_FAILED);
        // Non-strings pass through untouched.
        assert_eq!(codec.encode(&Value::from(7)).unwrap(), Value::from(7));

        let description = codec.describe();
        assert!(!description.encrypted);
        assert_eq!(description.scheme, "plaintext");
        assert_eq!(description.prefix, CIPHER_PREFIX);
    }

    #[test]
    fn secrets_are_sealed_per_value_and_read_back() {
        let fixture = Fixture::new("secrets");
        let store = store(&fixture, Some(SecretCodec::reversible()));
        let secret = "ai.provider.config.provider-1.apiKey";

        let write = store.set(secret, Value::String("sk-plain-value".into()));
        assert!(write.ok, "{:?}", write.message);

        let raw = fs::read_to_string(fixture.path().join("config").join("vol.json")).unwrap();
        assert!(!raw.contains("sk-plain-value"), "plaintext reached the disk");
        assert!(raw.contains(CIPHER_PREFIX));

        let snapshot = store.read();
        assert!(snapshot.ok);
        assert!(!snapshot.degraded);
        assert_eq!(
            snapshot.values.get(secret),
            Some(&Value::String("sk-plain-value".into()))
        );

        let description = SecretCodec::reversible().describe();
        assert!(description.encrypted);
        assert_eq!(description.scheme, "safe-storage");
    }

    #[test]
    fn undecryptable_secrets_are_preserved_instead_of_deleted() {
        let fixture = Fixture::new("preserved");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        // `//4=` decodes to the bytes FF FE, which no string can become: the codec is healthy, the
        // *value* is what this machine cannot open (moved profile, rotated key, hand-edited file).
        let ciphertext = format!("{CIPHER_PREFIX}//4=");
        let original = format!(
            r#"{{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","values":{{"gone":"{ciphertext}","kept":"plain"}}}}"#
        );
        fs::write(dir.join("vol.json"), &original).unwrap();
        let store = ConfigStore::new(
            dir.join("vol.json"),
            false,
            Some(SecretCodec::reversible()),
            false,
        );

        let snapshot = store.read();
        assert!(snapshot.degraded);
        assert!(snapshot.values.get("gone").is_none(), "ciphertext must not leak to the renderer");
        assert_eq!(
            snapshot.values.get("kept"),
            Some(&Value::String("plain".into()))
        );
        assert!(snapshot.message.unwrap().contains("1 项密钥无法解密"));

        // Writing another key must put the untouched ciphertext back verbatim.
        let write = store.set("added", Value::String("plain2".into()));
        assert!(write.ok, "{:?}", write.message);
        let raw = fs::read_to_string(dir.join("vol.json")).unwrap();
        assert!(
            raw.contains(&ciphertext),
            "an unreadable secret was dropped from the file"
        );
    }

    #[test]
    fn a_dead_keychain_refuses_writes_and_leaves_the_file_alone() {
        let fixture = Fixture::new("dead-keychain");
        let dir = fixture.path().join("config");
        fs::create_dir_all(&dir).unwrap();
        let ciphertext = format!("{CIPHER_PREFIX}ARBORIGINALCIPHERTEXT==");
        let original = format!(
            r#"{{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","values":{{"gone":"{ciphertext}"}}}}"#
        );
        fs::write(dir.join("vol.json"), &original).unwrap();
        let store = ConfigStore::new(
            dir.join("vol.json"),
            false,
            Some(SecretCodec::unavailable()),
            false,
        );

        // Every string in this volume has to be sealed, so a dead keychain fails the whole write
        // instead of silently downgrading the secret to plaintext.
        let write = store.set("added", Value::String("plain2".into()));
        assert!(!write.ok);
        assert!(write.message.unwrap().contains("系统钥匙串不可用"));
        assert_eq!(
            fs::read_to_string(dir.join("vol.json")).unwrap(),
            original,
            "a refused write must not touch the file"
        );
    }

    // ————————————————————————— presets —————————————————————————

    #[test]
    fn presets_list_write_read_and_remove() {
        let fixture = Fixture::new("presets");
        let library = PresetLibrary::new(fixture.path().join("presets"));
        assert!(library.list().is_empty());

        let volumes = object(&[("preferences", Value::Object(object(&[("a", Value::from(1))])))]);
        let write = library.write("dark-setup", &volumes, Some("0.1.8"));
        assert!(write.ok, "{:?}", write.message);

        let listed = library.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "dark-setup");
        assert_eq!(listed[0].volumes, vec!["preferences".to_string()]);
        assert!(listed[0].bytes > 0);
        assert!(listed[0].exported_at.is_some());
        assert!(listed[0].updated_at.ends_with('Z'));

        let read = library.read("dark-setup").expect("preset volumes");
        assert_eq!(read.len(), 1);
        assert!(library.read("missing").unwrap_err().starts_with("无法读取预设："));

        assert!(library.remove("dark-setup").ok);
        assert!(library.list().is_empty());
        // Removing something that is already gone is not an error.
        assert!(library.remove("dark-setup").ok);
    }

    #[test]
    fn presets_reject_names_and_documents_they_did_not_write() {
        let fixture = Fixture::new("preset-guards");
        let dir = fixture.path().join("presets");
        let library = PresetLibrary::new(dir.clone());

        assert_eq!(
            library
                .write("../escape", &object(&[("a", Value::from(1))]), None)
                .message
                .unwrap(),
            PRESET_NAME_ERROR
        );
        assert_eq!(
            library.write("empty", &Map::new(), None).message.unwrap(),
            "预设内容为空：没有可导出的配置"
        );

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("foreign.json"), r#"{"kind":"something.else","volumes":{}}"#).unwrap();
        assert!(library.list().is_empty(), "a foreign file is not a preset");
        assert_eq!(
            library.read("foreign").unwrap_err(),
            "不是 Artflow 预设文件（kind 不匹配）"
        );

        fs::write(dir.join("novolumes.json"), r#"{"kind":"artflow.preset"}"#).unwrap();
        assert_eq!(
            library.read("novolumes").unwrap_err(),
            "预设内容缺失（volumes 不是对象）"
        );
    }

    #[test]
    fn a_preset_only_collects_the_volumes_electron_collects() {
        let fixture = Fixture::new("preset-collect");
        let config_root = fixture.path().join("config");
        fs::create_dir_all(&config_root).unwrap();
        let envelope = |values: &str| {
            format!(r#"{{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","values":{values}}}"#)
        };
        fs::write(config_root.join("preferences.json"), envelope(r#"{"a":1}"#)).unwrap();
        fs::write(config_root.join("workspace.json"), envelope(r#"{"b":2}"#)).unwrap();
        fs::write(config_root.join("secrets.json"), envelope(r#"{"c":"enc:v1:AAAA"}"#)).unwrap();
        fs::write(config_root.join("recent-files.json"), envelope(r#"{"d":4}"#)).unwrap();

        let paths = ConfigPaths {
            data_root: fixture.path().to_path_buf(),
            config_root,
            preset_root: fixture.path().join("presets"),
            cache_root: fixture.path().join("temp"),
            log_root: fixture.path().join("logs"),
        };
        let library = PresetLibrary::new(paths.preset_root.clone());
        let volumes = library.collect(&paths, false);
        let mut names: Vec<&str> = volumes.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["preferences", "workspace"]);
    }

    // ————————————————————————— directories —————————————————————————

    #[test]
    fn clear_cache_refuses_to_remove_a_non_cache_directory() {
        let fixture = Fixture::new("clear-cache");
        // A config root pretending to be the cache root must be refused.
        let paths = ConfigPaths {
            data_root: fixture.path().to_path_buf(),
            config_root: fixture.path().join("config"),
            preset_root: fixture.path().join("presets"),
            cache_root: fixture.path().join("config"),
            log_root: fixture.path().join("logs"),
        };
        fs::create_dir_all(&paths.config_root).unwrap();
        assert!(clear_cache(&paths)
            .unwrap_err()
            .starts_with("拒绝清空非缓存目录："));
        assert!(paths.config_root.exists(), "the refused directory was removed");

        let cache_root = fixture.path().join("temp");
        fs::create_dir_all(cache_root.join("nested")).unwrap();
        fs::write(cache_root.join("nested").join("blob.bin"), vec![0u8; 16]).unwrap();
        let paths = ConfigPaths {
            cache_root: cache_root.clone(),
            ..paths
        };
        assert_eq!(directory_size(&cache_root), 16);
        assert!(clear_cache(&paths).is_ok());
        assert!(!cache_root.exists());
    }

    #[test]
    fn volume_names_match_the_electron_whitelist() {
        assert_eq!(
            VOLUME_NAMES,
            ["preferences", "workspace", "recent-files", "secrets", "ai-providers"]
        );
        for name in VOLUME_NAMES {
            let spec = volume_spec(name).expect(name);
            assert_eq!(spec.name, name);
            assert!(spec.file.ends_with(".json"));
        }
        assert_eq!(volume_spec("secrets").unwrap().encrypted, true);
        assert_eq!(volume_spec("secrets").unwrap().restrict_permissions, true);
        assert_eq!(volume_spec("preferences").unwrap().encrypted, false);
        assert!(volume_spec("logs").is_none());
        assert!(volume_spec("../../etc/passwd").is_none());
    }

    #[test]
    fn boot_log_lines_say_what_went_wrong() {
        let config_root = Path::new("C:/data/config");
        let payload = serde_json::json!({
            "source": "host-safe-mode",
            "degraded": false,
            "keyCount": 0,
            "safeMode": true,
            "adoptedLegacyKeys": ["general.language"],
            "message": "配置文件版本 2 高于当前支持的 1，已只读载入"
        });
        let line = boot_log_line(&payload, config_root).expect("line");
        assert!(line.starts_with("用户配置：来源=host-safe-mode 键=0 根="));
        assert!(line.contains("安全模式"));
        assert!(line.contains("已从旧 localStorage 采纳：general.language"));
        assert!(line.contains("[警告] 配置异常："));
        assert!(boot_log_line(&Value::String("nope".into()), config_root).is_none());
    }
}
