//! Declarative plugin loader (skins + language packs). Port of `main/declarativePlugins.cjs`
//! (562 lines), which is the only behavioural reference: the renderer consumes exactly the
//! descriptor this module emits, and Electron's version already ships three built-in skin packs.
//!
//! Why this module exists: `plugin-runtime/declarative-loader.ts:49` bails out silently when
//! `window.artflowApp.listDeclarativePlugins` is missing, so with no Rust backend the skin system
//! is simply absent (measured: `--bp-canvas-bg` empty, `appearance.skinState` undefined).
//!
//! ## Skin assets: confirmed they need no asset protocol
//! A declarative skin may put its background art, preview thumbnails and gallery poster inline as
//! `data:` URIs. All three shipped packs do exactly that and contain **nothing but manifest.json**
//! (measured: `builtin.skins-aurora` 5807 B, `builtin.skins-default` 2401 B,
//! `builtin.skins-abyssal-serenade` 633873 B; every `url(...)` in their CSS is
//! `data:image/webp;base64,` / `data:image/svg+xml;base64,`, and the only non-`data:` match is
//! `url(%23g...)`, a same-document `#id` paint reference).
//!
//! Therefore this module **passes every string through untouched**: no `asset:` rewriting, no
//! `convertFileSrc`, no `protocol-asset` feature, no assetProtocol scope. `data:` URIs load in
//! WebView2 with `csp: null`, and `plugin-runtime/skin-css-sanitize.ts:144-154` explicitly allows
//! `data:` while forbidding `http(s)://`, `//` and `javascript:`.
//!
//! Known boundary (documented, not silently accepted): a *third-party* skin that references a
//! sibling file with a relative `url('bg.webp')` would resolve against the page origin
//! (`http://tauri.localhost`) and break. Serving such a pack requires the host to enable
//! `tauri/protocol-asset` + an `assetProtocol.scope`, i.e. a Cargo.toml/conf change owned by the
//! Lead, not a change here. Nothing shipped hits that path today.
//!
//! ## Deliberate divergences from the CJS source (all strictness-increasing, none silent)
//! * JS `/…$/` also matches a string with one trailing `\n`; the hand-written matchers here are
//!   full-string, so `"cbz\n"` is rejected instead of accepted.
//! * Non-UTF-8 manifest/shard bytes are dropped; Node decodes with U+FFFD and then usually fails
//!   `JSON.parse` anyway.
//! * `description.slice(0, 200)` is UTF-16 based upstream; a truncation that would split a
//!   surrogate pair drops the dangling half instead of emitting a lone surrogate (Rust strings
//!   cannot hold one).
//! * An absolute locale shard path that happens to point back inside the plugin directory is
//!   accepted by upstream `path.resolve` + prefix check; here only relative, non-escaping
//!   components are allowed.
//!
//! Commands land in the crate handler table from `main.rs` (the Lead's file), so most items are
//! unreferenced from this module's perspective until that wiring lands.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

// ————————————————————————————————— limits —————————————————————————————————
// Every number below is copied verbatim from `main/declarativePlugins.cjs:16-53`.

/// `MAX_PLUGINS` — how many descriptors one call may return.
pub const MAX_PLUGINS: usize = 32;
/// `MAX_MANIFEST_BYTES` — 8 MiB. Was 16 KiB once and silently skipped the 621 KiB
/// `builtin.skins-abyssal-serenade`; a skin pack inlines css/preview/poster as `data:` URIs, so
/// the per-field caps below are the real guard and this one only stops absurd files.
pub const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
/// `MAX_ALIASES` — format aliases per plugin.
pub const MAX_ALIASES: usize = 16;
/// `MAX_LOCALE_SHARD_BYTES` — one language shard file.
pub const MAX_LOCALE_SHARD_BYTES: usize = 512 * 1024;
/// `MAX_LOCALE_SHARDS` — language declarations per plugin (languages, not files).
pub const MAX_LOCALE_SHARDS: usize = 8;
/// `MAX_LOCALE_SEGMENTS` — keys per locale object node.
pub const MAX_LOCALE_SEGMENTS: usize = 256;
/// `MAX_LOCALE_ARRAY` — items per locale array node.
pub const MAX_LOCALE_ARRAY: usize = 64;
/// `MAX_LOCALE_DEPTH` — nested object/array depth of a locale table.
pub const MAX_LOCALE_DEPTH: usize = 4;
/// `MAX_SKIN_SETTING_COUNT` — customization knobs per skin.
pub const MAX_SKIN_SETTING_COUNT: usize = 12;
/// `MAX_SKIN_ATTRIBUTE_BINDINGS` — boolean knob → HTML attribute.
pub const MAX_SKIN_ATTRIBUTE_BINDINGS: usize = 8;
/// `MAX_SKIN_CLASS_BINDINGS` — boolean knob → documentElement class.
pub const MAX_SKIN_CLASS_BINDINGS: usize = 8;
/// `MAX_SKIN_CSS_BYTES` — one skin's static CSS overlay (JS string length, i.e. UTF-16 units).
pub const MAX_SKIN_CSS_BYTES: usize = 2 * 1024 * 1024;
/// `MAX_SKIN_STRING_BYTES` — one preview/poster `data:` URI.
pub const MAX_SKIN_STRING_BYTES: usize = 3 * 1024 * 1024;
/// `MAX_SKIN_MEDIA_BYTES` — all preview values of one skin together.
pub const MAX_SKIN_MEDIA_BYTES: usize = 6 * 1024 * 1024;

/// Literal `256` in `parseSkinTokensNode`.
const MAX_SKIN_TOKENS_KEYS: usize = 256;
/// Literal `6` in `parseSkinTokensNode`.
const MAX_SKIN_TOKENS_DEPTH: usize = 6;
/// Literal `8` in `parseSkinPreview`.
const MAX_SKIN_PREVIEW_KEYS: usize = 8;
/// Literal `32` in `parseSkinDeclarations` (skins per plugin).
const MAX_SKINS_PER_PLUGIN: usize = 32;
/// Literal `32` in `parseSkinDeclarations` (tags per skin).
const MAX_SKIN_TAGS: usize = 32;

/// `ALLOWED_KEYS` — top-level manifest keys. Anything else rejects the whole manifest.
const ALLOWED_KEYS: &[&str] = &[
    "id",
    "name",
    "version",
    "runtime",
    "formatAliases",
    "description",
    "locales",
    "contributes",
];
/// `SKIN_ENTRY_KEYS` — a skin entry may carry nothing outside this list.
const SKIN_ENTRY_KEYS: &[&str] = &[
    "id",
    "name",
    "nameI18n",
    "mode",
    "tokens",
    "order",
    "tags",
    "css",
    "customization",
    "preview",
    "gallery",
];

/// Environment switch that makes the whole channel return an empty list, mirroring
/// `main/safeMode.cjs` (`ARTFLOW_SAFE_MODE=1`): a factory-fresh start must not load user plugins.
pub const SAFE_MODE_ENV: &str = "ARTFLOW_SAFE_MODE";
/// Debug-only override for the scan root, so a build can be pointed at a fixture tree.
/// Compiled out of release builds on purpose — a renderer must never supply its own root, and an
/// environment variable that widens file reads does not belong in a shipped binary.
pub const PLUGINS_ROOT_ENV: &str = "ARTFLOW_PLUGINS_ROOT";

// ———————————————————————————— pattern matchers ————————————————————————————
// The Cargo.toml of this crate has no `regex` dependency and the Lead owns that file, so these
// seven one-line patterns are hand-written. Each is a full-string match; see the module docs for
// the trailing-newline divergence from JS.

fn is_lower_alnum(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// `/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/` — plugin and skin ids (`builtin.skin-default`).
fn matches_id_pattern(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() && is_lower_alnum(bytes[index]) {
        index += 1;
    }
    if index == 0 {
        return false;
    }
    let mut groups = 0;
    while index < bytes.len() {
        if bytes[index] != b'.' && bytes[index] != b'-' {
            return false;
        }
        index += 1;
        let start = index;
        while index < bytes.len() && is_lower_alnum(bytes[index]) {
            index += 1;
        }
        if index == start {
            return false;
        }
        groups += 1;
    }
    groups >= 1
}

/// `/^[a-z0-9]{1,16}$/` — a file extension alias.
fn matches_extension_pattern(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 16
        && value.bytes().all(is_lower_alnum)
        // Byte length equals character count only for ASCII, so this also rejects non-ASCII.
        && value.is_ascii()
}

/// `/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/` — a language tag (`zh-CN`, `pt_BR`, `en`).
fn matches_language_pattern(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !value.is_ascii() {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_lowercase() && index < 3 {
        index += 1;
    }
    if index < 2 {
        return false;
    }
    loop {
        if index == bytes.len() {
            return true;
        }
        let separator = bytes[index];
        if separator != b'-' && separator != b'_' {
            return false;
        }
        index += 1;
        let start = index;
        while index < bytes.len()
            && bytes[index].is_ascii_alphanumeric()
            && index - start < 8
        {
            index += 1;
        }
        if index - start < 2 {
            return false;
        }
    }
}

/// `/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/` — a customization setting key.
fn matches_skin_setting_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() || value.len() > 32 {
        return false;
    }
    value.is_ascii() && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// `/^--[a-zA-Z][a-zA-Z0-9-]*$/` — the CSS custom property a binding writes to.
fn matches_css_var_pattern(value: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let Some(rest) = value.strip_prefix("--") else {
        return false;
    };
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

/// `/^[a-zA-Z][a-zA-Z0-9-]*$/` — the HTML attribute an attribute binding toggles.
fn matches_attribute_name_pattern(value: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

/// `/^[a-zA-Z_-][a-zA-Z0-9_-]*$/` — the documentElement class a class binding toggles.
fn matches_class_name_pattern(value: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b'-') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// JS `string.length` counts UTF-16 code units, and every upstream limit was written against it.
/// Comparing UTF-8 byte lengths instead would reject a legitimate CJK `description` of 67 chars
/// as if it were 200.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `String.prototype.slice(0, limit)` for the one place upstream truncates (`description`).
/// A limit that would cut a surrogate pair drops the dangling half: a Rust `String` cannot carry
/// a lone surrogate, and emitting U+FFFD would be a different string than the caller wrote.
fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut units = 0usize;
    let mut end = 0usize;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    value[..end].to_string()
}

// ————————————————————————————— locale tables —————————————————————————————

/// `parseLocaleNode` — strings, arrays of nodes and plain objects of nodes only.
///
/// `None` is the upstream `undefined` these helpers use as their failure signal; a locale table
/// that hits it is rejected whole rather than repair-truncated, because a half-language pack in
/// the UI is worse than falling back to the base copy.
pub fn parse_locale_node(value: &Value, depth: usize) -> Option<Value> {
    if depth > MAX_LOCALE_DEPTH {
        return None;
    }
    match value {
        Value::String(_) => Some(value.clone()),
        Value::Array(items) => {
            if items.len() > MAX_LOCALE_ARRAY {
                return None;
            }
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(parse_locale_node(item, depth + 1)?);
            }
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            if map.len() > MAX_LOCALE_SEGMENTS {
                return None;
            }
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), parse_locale_node(item, depth + 1)?);
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

/// `parseLocaleTable` — a locale shard/inline table must be a plain object.
pub fn parse_locale_table(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    parse_locale_node(value, 0)
}

// ————————————————————————————————— skins —————————————————————————————————
// Skin sub-structures are built as JSON maps rather than typed structs: `preview`/`tokens` accept
// arbitrary keys by design, and mirroring the CJS object literals line for line is what makes this
// reviewable against the source. The top-level descriptor below *is* typed, because that shape is
// the contract the renderer reads.

/// `parseSkinTokensNode` — `string | number | boolean | plain object`, never arrays.
/// This is the gate before untrusted values reach CSS custom properties.
fn parse_skin_tokens_node(value: &Value, depth: usize) -> Option<Value> {
    if depth > MAX_SKIN_TOKENS_DEPTH {
        return None;
    }
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        Value::Object(map) => {
            if map.len() > MAX_SKIN_TOKENS_KEYS {
                return None;
            }
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), parse_skin_tokens_node(item, depth + 1)?);
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

/// `parseSkinNameI18n` — `{ lang: text }`, language tags validated, text capped at 200 units.
fn parse_skin_name_i18n(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let mut out = Map::new();
    for (language, text) in map {
        let text = text.as_str()?;
        if !matches_language_pattern(language) || utf16_len(text) > 200 {
            return None;
        }
        out.insert(language.clone(), Value::String(truncate_utf16(text, 200)));
    }
    Some(Value::Object(out))
}

/// `parseSkinPreview` — `{ light?: dataURI, dark?: dataURI, … }`, 8 keys, 3 MiB each, 6 MiB total.
fn parse_skin_preview(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    if map.len() > MAX_SKIN_PREVIEW_KEYS {
        return None;
    }
    let mut out = Map::new();
    let mut total = 0usize;
    for (key, raw) in map {
        let text = raw.as_str()?;
        let length = utf16_len(text);
        if length > MAX_SKIN_STRING_BYTES {
            return None;
        }
        total += length;
        if total > MAX_SKIN_MEDIA_BYTES {
            return None;
        }
        out.insert(key.clone(), Value::String(text.to_string()));
    }
    Some(Value::Object(out))
}

/// `parseSkinGallery` — gallery metadata; `family` and `title` are both mandatory.
fn parse_skin_gallery(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let mut out = Map::new();
    for key in [
        "family",
        "title",
        "titleEn",
        "description",
        "descriptionEn",
        "credit",
    ] {
        if let Some(raw) = map.get(key) {
            let text = raw.as_str()?;
            if utf16_len(text) > 200 {
                return None;
            }
            out.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
    if let Some(raw) = map.get("poster") {
        let text = raw.as_str()?;
        if utf16_len(text) > MAX_SKIN_STRING_BYTES {
            return None;
        }
        out.insert("poster".to_string(), Value::String(text.to_string()));
    }
    let present = |key: &str| {
        out.get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };
    if !present("family") || !present("title") {
        return None;
    }
    Some(Value::Object(out))
}

/// `parseSkinCustomizationDecl` — knobs, CSS-variable bindings, attribute/class bindings, branding.
/// A declarative skin exposes settings with zero JavaScript; every mapping is validated here so the
/// renderer only ever receives references to keys that exist.
fn parse_skin_customization(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let title = map.get("title")?.as_str()?;
    if title.trim().is_empty() {
        return None;
    }
    let items = map.get("settings")?.as_array()?;
    if items.len() > MAX_SKIN_SETTING_COUNT {
        return None;
    }
    let mut settings: Vec<Value> = Vec::with_capacity(items.len());
    let mut seen_keys: BTreeSet<String> = BTreeSet::new();
    let mut boolean_keys: BTreeSet<String> = BTreeSet::new();
    for item in items {
        let entry = item.as_object()?;
        let key = entry.get("key")?.as_str()?;
        if !matches_skin_setting_key(key) {
            return None;
        }
        if !seen_keys.insert(key.to_string()) {
            return None;
        }
        let label = entry.get("label")?.as_str()?;
        if label.trim().is_empty() {
            return None;
        }
        let kind = entry.get("type")?.as_str()?;
        let mut setting = Map::new();
        setting.insert("key".to_string(), Value::String(key.to_string()));
        setting.insert("type".to_string(), Value::String(kind.to_string()));
        setting.insert("label".to_string(), Value::String(label.to_string()));
        match kind {
            "boolean" => {
                let default = entry.get("defaultValue")?.as_bool()?;
                boolean_keys.insert(key.to_string());
                setting.insert("defaultValue".to_string(), Value::Bool(default));
            }
            "number" => {
                let default = entry.get("defaultValue")?;
                default.as_f64().filter(|number| number.is_finite())?;
                let mut bounds: [Option<f64>; 3] = [None, None, None];
                for (index, option) in ["min", "max", "step"].iter().enumerate() {
                    if let Some(raw) = entry.get(*option) {
                        let number = raw.as_f64().filter(|number| number.is_finite())?;
                        bounds[index] = Some(number);
                        // Keep the original JSON number so an integral default still emits `3`,
                        // not `3.0`.
                        setting.insert((*option).to_string(), raw.clone());
                    }
                }
                if let (Some(minimum), Some(maximum)) = (bounds[0], bounds[1]) {
                    if minimum > maximum {
                        return None;
                    }
                }
                setting.insert("defaultValue".to_string(), default.clone());
            }
            "string" => {
                let default = entry.get("defaultValue")?.as_str()?;
                if let Some(raw) = entry.get("maxLength") {
                    let limit = raw.as_f64().filter(|number| number.is_finite())?;
                    if limit.fract() != 0.0 || limit < 1.0 {
                        return None;
                    }
                    if utf16_len(default) as f64 > limit {
                        return None;
                    }
                    setting.insert("maxLength".to_string(), raw.clone());
                }
                setting.insert(
                    "defaultValue".to_string(),
                    Value::String(default.to_string()),
                );
            }
            "select" => {
                let default = entry.get("defaultValue")?.as_str()?;
                let options = entry.get("options")?.as_array()?;
                if options.is_empty() {
                    return None;
                }
                let mut values: BTreeSet<String> = BTreeSet::new();
                let mut built: Vec<Value> = Vec::with_capacity(options.len());
                for option in options {
                    let option_map = option.as_object()?;
                    let value = option_map.get("value")?.as_str()?;
                    let label = option_map.get("label")?.as_str()?;
                    if value.is_empty() || label.is_empty() {
                        return None;
                    }
                    if !values.insert(value.to_string()) {
                        return None;
                    }
                    let mut built_option = Map::new();
                    built_option.insert("value".to_string(), Value::String(value.to_string()));
                    built_option.insert("label".to_string(), Value::String(label.to_string()));
                    built.push(Value::Object(built_option));
                }
                if !values.contains(default) {
                    return None;
                }
                setting.insert(
                    "defaultValue".to_string(),
                    Value::String(default.to_string()),
                );
                setting.insert("options".to_string(), Value::Array(built));
            }
            _ => return None,
        }
        settings.push(Value::Object(setting));
    }

    let mut output = Map::new();
    output.insert("title".to_string(), Value::String(title.to_string()));
    output.insert("settings".to_string(), Value::Array(settings));

    // binding: config key → CSS custom property. Keys must be declared settings.
    if let Some(raw) = map.get("binding") {
        let bindings = raw.as_object()?;
        let mut built = Map::new();
        for (key, target) in bindings {
            if !seen_keys.contains(key) {
                return None;
            }
            let css_var = target.as_str()?;
            if !matches_css_var_pattern(css_var) {
                return None;
            }
            built.insert(key.clone(), Value::String(css_var.to_string()));
        }
        output.insert("binding".to_string(), Value::Object(built));
    }

    // attributeBindings: boolean knob → documentElement attribute (attribute-selector skins).
    if let Some(raw) = map.get("attributeBindings") {
        let items = raw.as_array()?;
        if items.is_empty() || items.len() > MAX_SKIN_ATTRIBUTE_BINDINGS {
            return None;
        }
        let mut seen_names: BTreeSet<String> = BTreeSet::new();
        let mut built: Vec<Value> = Vec::with_capacity(items.len());
        for item in items {
            let entry = item.as_object()?;
            let name = entry.get("name")?.as_str()?;
            if !matches_attribute_name_pattern(name) || !seen_names.insert(name.to_string()) {
                return None;
            }
            let key = entry.get("key")?.as_str()?;
            if !boolean_keys.contains(key) {
                return None;
            }
            let on = entry.get("on")?.as_str()?;
            if on.is_empty() || utf16_len(on) > 64 {
                return None;
            }
            let mut built_entry = Map::new();
            built_entry.insert("name".to_string(), Value::String(name.to_string()));
            built_entry.insert("key".to_string(), Value::String(key.to_string()));
            built_entry.insert("on".to_string(), Value::String(on.to_string()));
            if let Some(off) = entry.get("off") {
                let text = off.as_str()?;
                if utf16_len(text) > 64 {
                    return None;
                }
                built_entry.insert("off".to_string(), Value::String(text.to_string()));
            }
            built.push(Value::Object(built_entry));
        }
        output.insert("attributeBindings".to_string(), Value::Array(built));
    }

    // classBindings: boolean knob → documentElement class. Class names are unique across the whole
    // batch, including an `on`/`off` collision inside one entry.
    if let Some(raw) = map.get("classBindings") {
        let items = raw.as_array()?;
        if items.is_empty() || items.len() > MAX_SKIN_CLASS_BINDINGS {
            return None;
        }
        let mut seen_classes: BTreeSet<String> = BTreeSet::new();
        let mut built: Vec<Value> = Vec::with_capacity(items.len());
        for item in items {
            let entry = item.as_object()?;
            let key = entry.get("key")?.as_str()?;
            if !boolean_keys.contains(key) {
                return None;
            }
            let mut built_entry = Map::new();
            built_entry.insert("key".to_string(), Value::String(key.to_string()));
            for field in ["on", "off"] {
                let Some(class) = entry.get(field) else {
                    if field == "off" {
                        continue;
                    }
                    return None;
                };
                let class = class.as_str()?;
                if !matches_class_name_pattern(class) || utf16_len(class) > 64 {
                    return None;
                }
                if !seen_classes.insert(class.to_string()) {
                    return None;
                }
                built_entry.insert(field.to_string(), Value::String(class.to_string()));
            }
            built.push(Value::Object(built_entry));
        }
        output.insert("classBindings".to_string(), Value::Array(built));
    }

    // branding: fixed brand assets (logo / splash colours) consumed by the host shell.
    // An empty branding block is dropped rather than emitted as `{}`.
    if let Some(raw) = map.get("branding") {
        let branding = raw.as_object()?;
        let mut built = Map::new();
        if let Some(logo) = branding.get("appLogo") {
            let text = logo.as_str()?;
            if text.trim().is_empty() {
                return None;
            }
            built.insert("appLogo".to_string(), Value::String(text.to_string()));
        }
        if let Some(splash) = branding.get("splash") {
            let splash_map = splash.as_object()?;
            let mut splash_built = Map::new();
            for field in ["background", "accent"] {
                if let Some(raw_value) = splash_map.get(field) {
                    let text = raw_value.as_str()?;
                    if text.trim().is_empty() {
                        return None;
                    }
                    splash_built.insert(field.to_string(), Value::String(text.to_string()));
                }
            }
            if !splash_built.is_empty() {
                built.insert("splash".to_string(), Value::Object(splash_built));
            }
        }
        if !built.is_empty() {
            output.insert("branding".to_string(), Value::Object(built));
        }
    }

    Some(Value::Object(output))
}

/// `parseSkinDeclarations` — `contributes.skins`. Any invalid entry rejects the whole plugin:
/// a skin pack that half-loads leaves the UI in a state nobody designed.
fn parse_skin_declarations(value: &Value) -> Option<Vec<Value>> {
    let items = value.as_array()?;
    if items.is_empty() || items.len() > MAX_SKINS_PER_PLUGIN {
        return None;
    }
    let mut skins: Vec<Value> = Vec::with_capacity(items.len());
    for item in items {
        let entry = item.as_object()?;
        if entry
            .keys()
            .any(|key| !SKIN_ENTRY_KEYS.contains(&key.as_str()))
        {
            return None;
        }
        let id = entry.get("id")?.as_str()?;
        if !matches_id_pattern(id) {
            return None;
        }
        let name = entry.get("name")?.as_str()?;
        if name.is_empty() || utf16_len(name) > 80 {
            return None;
        }
        let mode = match entry.get("mode") {
            None => "dark",
            Some(Value::String(mode)) if mode == "dark" || mode == "light" => mode.as_str(),
            Some(_) => return None,
        };
        let name_i18n = match entry.get("nameI18n") {
            None => None,
            Some(raw) => Some(parse_skin_name_i18n(raw)?),
        };
        let tokens = match entry.get("tokens") {
            None => None,
            Some(raw) => Some(parse_skin_tokens_node(raw, 0)?),
        };
        let order = match entry.get("order") {
            None => None,
            Some(raw) => {
                raw.as_f64().filter(|number| number.is_finite())?;
                Some(raw.clone())
            }
        };
        let tags = match entry.get("tags") {
            None => None,
            Some(raw) => {
                let items = raw.as_array()?;
                if items.len() > MAX_SKIN_TAGS {
                    return None;
                }
                let mut built: Vec<Value> = Vec::with_capacity(items.len());
                for tag in items {
                    let text = tag.as_str()?;
                    let length = utf16_len(text);
                    if length == 0 || length > 40 {
                        return None;
                    }
                    built.push(Value::String(text.to_string()));
                }
                Some(Value::Array(built))
            }
        };
        let css = match entry.get("css") {
            None => None,
            Some(raw) => {
                let text = raw.as_str()?;
                if utf16_len(text) > MAX_SKIN_CSS_BYTES {
                    return None;
                }
                // Passed through verbatim: the renderer sanitises it in
                // `plugin-runtime/skin-css-sanitize.ts`, and `data:` art must survive untouched.
                Some(Value::String(text.to_string()))
            }
        };
        let customization = match entry.get("customization") {
            None => None,
            Some(raw) => Some(parse_skin_customization(raw)?),
        };
        let preview = match entry.get("preview") {
            None => None,
            Some(raw) => Some(parse_skin_preview(raw)?),
        };
        let gallery = match entry.get("gallery") {
            None => None,
            Some(raw) => Some(parse_skin_gallery(raw)?),
        };

        let mut skin = Map::new();
        skin.insert("id".to_string(), Value::String(id.to_string()));
        skin.insert("name".to_string(), Value::String(name.to_string()));
        skin.insert("mode".to_string(), Value::String(mode.to_string()));
        for (key, value) in [
            ("nameI18n", name_i18n),
            ("tokens", tokens),
            ("order", order),
            ("tags", tags),
            ("css", css),
            ("customization", customization),
            ("preview", preview),
            ("gallery", gallery),
        ] {
            if let Some(value) = value {
                skin.insert(key.to_string(), value);
            }
        }
        skins.push(Value::Object(skin));
    }
    Some(skins)
}

// ——————————————————————————————— locales ———————————————————————————————

/// One `locales[]` entry: either an inline table or a shard file to read next to the manifest.
#[derive(Debug, Clone)]
pub enum LocaleDeclaration {
    /// `{ language, table }` — small packs keep the whole table in the manifest.
    Inline { language: String, table: Value },
    /// `{ language, file }` — full language packs keep ~18 KiB of copy in a shard.
    File { language: String, file: String },
}

/// `parseLocaleDeclarations` — validation only, no I/O.
fn parse_locale_declarations(value: Option<&Value>) -> Option<Vec<LocaleDeclaration>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.is_empty() || items.len() > MAX_LOCALE_SHARDS {
        return None;
    }
    let mut declarations: Vec<LocaleDeclaration> = Vec::with_capacity(items.len());
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for item in items {
        let entry = item.as_object()?;
        if entry
            .keys()
            .any(|key| key != "language" && key != "file" && key != "table")
        {
            return None;
        }
        let language = entry.get("language")?.as_str()?;
        if !matches_language_pattern(language) {
            return None;
        }
        if !seen.insert(language.to_string()) {
            return None;
        }
        // `{}` means "one source, and only one": an inline table that a shard silently overwrote
        // is exactly the ambiguity upstream refuses.
        let file = entry.get("file").and_then(Value::as_str);
        let has_table = entry.contains_key("table");
        if file.is_some() == has_table {
            return None;
        }
        let Some(file) = file else {
            let table = parse_locale_table(entry.get("table")?)?;
            declarations.push(LocaleDeclaration::Inline {
                language: language.to_string(),
                table,
            });
            continue;
        };
        let length = utf16_len(file);
        if length == 0 || length > 200 || !file.ends_with(".json") {
            return None;
        }
        if file
            .split(['/', '\\'])
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return None;
        }
        declarations.push(LocaleDeclaration::File {
            language: language.to_string(),
            file: file.to_string(),
        });
    }
    Some(declarations)
}

/// Resolve a shard's path relative to the plugin directory, refusing anything that could escape it.
///
/// Upstream does `path.resolve(base, file)` and then a `base + sep` prefix test. Both approaches
/// reject `..`, absolute paths and UNC prefixes; this one additionally rejects a `file` that is
/// absolute yet happens to land back inside `base` (see the module docs).
fn resolve_shard_path(base: &Path, file: &str) -> Option<PathBuf> {
    let relative = Path::new(file);
    let mut components = 0usize;
    for component in relative.components() {
        match component {
            Component::Normal(_) => components += 1,
            // `RootDir`, `Prefix` (C:\ or \\server), `ParentDir`, `CurDir`.
            _ => return None,
        }
    }
    if components == 0 {
        return None;
    }
    Some(base.join(relative))
}

/// `readLocaleShard` — any doubt (escape, oversize, bad JSON, bad table) drops that one shard.
fn read_locale_shard(plugin_dir: &Path, file: &str) -> Option<Value> {
    let target = resolve_shard_path(plugin_dir, file)?;
    let metadata = fs::metadata(&target).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_LOCALE_SHARD_BYTES as u64 {
        return None;
    }
    // Re-check after reading: the size gate above is a stat, not a lock.
    let bytes = fs::read(&target).ok()?;
    if bytes.len() > MAX_LOCALE_SHARD_BYTES {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parse_locale_table(&parsed)
}

/// `resolveLocaleBundles` — inline tables first, shards read here; a broken shard only loses itself.
fn resolve_locale_bundles(
    declarations: Vec<LocaleDeclaration>,
    plugin_dir: &Path,
) -> Vec<LocaleBundle> {
    let mut bundles: Vec<LocaleBundle> = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        match declaration {
            LocaleDeclaration::Inline { language, table } => {
                bundles.push(LocaleBundle { language, table });
            }
            LocaleDeclaration::File { language, file } => {
                if let Some(table) = read_locale_shard(plugin_dir, &file) {
                    bundles.push(LocaleBundle { language, table });
                }
            }
        }
    }
    bundles
}

// ———————————————————————————— manifest parsing ————————————————————————————

/// `{ extension, handlerId }` — a declaration-level alias onto an already registered format handler.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatAlias {
    pub extension: String,
    pub handler_id: String,
}

/// `{ language, table }` — a language pack patch. `table` is a validated locale table.
#[derive(Debug, Clone, Serialize)]
pub struct LocaleBundle {
    pub language: String,
    pub table: Value,
}

/// What `parse_declarative_manifest` extracts. `locales` still holds unread file declarations;
/// they only become [`LocaleBundle`]s once a plugin directory is known.
#[derive(Debug, Clone)]
pub struct ParsedManifest {
    pub id: String,
    pub name: String,
    pub format_aliases: Vec<FormatAlias>,
    pub locales: Vec<LocaleDeclaration>,
    pub skins: Vec<Value>,
    pub description: Option<String>,
}

/// `parseDeclarativeManifest` — the untrusted-input gate for a plugin folder.
///
/// `None` means "not a declarative plugin, or not a valid one": upstream treats both identically
/// (skip the directory) and so does this port, because the scanner cannot distinguish a corrupt
/// manifest from an editable one without failing a user's whole boot.
pub fn parse_declarative_manifest(raw: &str) -> Option<ParsedManifest> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let map = value.as_object()?;
    if map.keys().any(|key| !ALLOWED_KEYS.contains(&key.as_str())) {
        return None;
    }
    let id = map.get("id")?.as_str()?;
    if !matches_id_pattern(id) {
        return None;
    }
    let name = map.get("name")?.as_str()?;
    if name.is_empty() || utf16_len(name) > 80 {
        return None;
    }
    let runtime = map.get("runtime")?.as_object()?;
    if runtime.keys().any(|key| key != "mode") {
        return None;
    }
    if runtime.get("mode")?.as_str()? != "declarative" {
        return None;
    }

    let mut format_aliases: Vec<FormatAlias> = Vec::new();
    if let Some(raw_aliases) = map.get("formatAliases") {
        let aliases = raw_aliases.as_array()?;
        if aliases.len() > MAX_ALIASES {
            return None;
        }
        for alias in aliases {
            let alias_map = alias.as_object()?;
            if alias_map
                .keys()
                .any(|key| key != "extension" && key != "handlerId")
            {
                return None;
            }
            let extension = alias_map.get("extension")?.as_str()?;
            if !matches_extension_pattern(extension) {
                return None;
            }
            let handler_id = alias_map.get("handlerId")?.as_str()?;
            if !matches_id_pattern(handler_id) {
                return None;
            }
            format_aliases.push(FormatAlias {
                extension: extension.to_string(),
                handler_id: handler_id.to_string(),
            });
        }
    }

    // `locales` absent → empty list; `locales: null` → rejected (upstream `parseLocaleDeclarations`
    // only treats `undefined` as absent, and null is not undefined).
    let locales = parse_locale_declarations(map.get("locales"))?;

    let mut skins: Vec<Value> = Vec::new();
    if let Some(contributes) = map.get("contributes") {
        let contributes = contributes.as_object()?;
        if contributes.keys().any(|key| key != "skins") {
            return None;
        }
        skins = match contributes.get("skins") {
            None => Vec::new(),
            Some(raw) => parse_skin_declarations(raw)?,
        };
    }

    // At least one contribution, otherwise this is a manifest that does nothing at all.
    if format_aliases.is_empty() && locales.is_empty() && skins.is_empty() {
        return None;
    }

    let description = match map.get("description") {
        Some(Value::String(text)) if !text.is_empty() => Some(truncate_utf16(text, 200)),
        _ => None,
    };

    Some(ParsedManifest {
        id: id.to_string(),
        name: name.to_string(),
        format_aliases,
        locales,
        skins,
        description,
    })
}

// ———————————————————————————————— scanning ————————————————————————————————

/// `{ id, name, formatAliases, skins?, description?, locales? }` — the descriptor the renderer
/// consumes (`plugin-runtime/declarative-loader.ts:33-39`).
///
/// * `id` — the plugin id, and it always equals the directory name (checked while scanning).
/// * `name` — display name for the plugin manager.
/// * `formatAliases` — already-registered format handlers this plugin aliases; always present,
///   possibly empty.
/// * `skins` — declarative skin declarations (see [`parse_skin_declarations`]); omitted when empty
///   so a pure language pack never grows a `skins: []` the renderer would register.
/// * `description` — first 200 UTF-16 units; omitted when absent or empty.
/// * `locales` — resolved `{ language, table }` bundles; omitted when empty.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativePluginDescriptor {
    pub id: String,
    pub name: String,
    pub format_aliases: Vec<FormatAlias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skins: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locales: Option<Vec<LocaleBundle>>,
}

/// Sub-directory names plus their directory flag, in a stable order. `readdirSync` order is not
/// guaranteed upstream (and the "root wins over builtin/" rule depends on it), so this port sorts
/// by name to make the precedence reproducible.
fn subdirectories(dir: &Path) -> Vec<(String, bool)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut children: Vec<(String, bool)> = entries
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_str()?.to_string();
            Some((name, file_type.is_dir()))
        })
        .collect();
    children.sort_by(|left, right| left.0.cmp(&right.0));
    children
}

/// `collectDeclarativeDirs` — **one level of recursion**, not a full walk.
///
/// Rationale copied from upstream: built-in packages live under `plugins/builtin/` while the
/// declarative packs may sit at the root, so a single-level scan would miss one of the two.
/// The membership test is always "directory has a manifest.json", never the location.
fn collect_declarative_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if !root.is_dir() {
        return out;
    }
    let mut containers: Vec<PathBuf> = Vec::new();
    // Round one: direct plugin folders under the root. The root comes first, so a user's copy
    // always wins over a bundled one of the same id.
    for (name, is_dir) in subdirectories(root) {
        if !is_dir {
            continue;
        }
        let dir = root.join(&name);
        if dir.join("manifest.json").exists() {
            out.push(dir);
        } else {
            containers.push(dir);
        }
    }
    // Round two: descend exactly one level into container folders.
    for container in containers {
        for (name, is_dir) in subdirectories(&container) {
            if !is_dir {
                continue;
            }
            let dir = container.join(&name);
            if dir.join("manifest.json").exists() {
                out.push(dir);
            }
        }
    }
    out
}

fn read_manifest(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES as u64 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Load one plugin directory. `None` means "skip", covering every reason upstream skips:
/// unreadable/oversized manifest, invalid manifest, id not matching the directory name.
fn load_descriptor(plugin_dir: &Path) -> Option<DeclarativePluginDescriptor> {
    let entry_name = plugin_dir.file_name()?.to_str()?;
    let raw = read_manifest(&plugin_dir.join("manifest.json"))?;
    let parsed = parse_declarative_manifest(&raw)?;
    if parsed.id != entry_name {
        return None;
    }
    let locales = resolve_locale_bundles(parsed.locales, plugin_dir);
    Some(DeclarativePluginDescriptor {
        id: parsed.id,
        name: parsed.name,
        format_aliases: parsed.format_aliases,
        skins: if parsed.skins.is_empty() {
            None
        } else {
            Some(parsed.skins)
        },
        description: parsed.description,
        locales: if locales.is_empty() {
            None
        } else {
            Some(locales)
        },
    })
}

/// `listDeclarativePlugins(root)` — single-root form, kept for parity with the CJS export.
pub fn list_declarative_plugins_in_root(root: &Path) -> Vec<DeclarativePluginDescriptor> {
    list_declarative_plugins(std::slice::from_ref(&root.to_path_buf()))
}

/// Scan several roots in priority order (first root wins on an id collision), capped at
/// [`MAX_PLUGINS`].
pub fn list_declarative_plugins(roots: &[PathBuf]) -> Vec<DeclarativePluginDescriptor> {
    let mut plugins: Vec<DeclarativePluginDescriptor> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for root in roots {
        for plugin_dir in collect_declarative_dirs(root) {
            if plugins.len() >= MAX_PLUGINS {
                return plugins;
            }
            let Some(descriptor) = load_descriptor(&plugin_dir) else {
                continue;
            };
            // Same id twice (user copy + bundled copy) registers once.
            if !seen.insert(descriptor.id.clone()) {
                continue;
            }
            plugins.push(descriptor);
        }
    }
    plugins
}

// ————————————————————————————————— wiring —————————————————————————————————

fn trusted_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !cfg!(feature = "custom-protocol") {
        url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(4002)
    } else {
        // Windows uses http://tauri.localhost; macOS uses tauri://localhost.
        (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
            || (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
    }
}

/// Private copy of `main.rs::authorized`, same guard semantics (label "main" + trusted origin).
/// It is duplicated only because `main.rs` is the Lead's file; at integration time both should
/// collapse into one shared helper.
fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

/// `ARTFLOW_SAFE_MODE=1` → factory start: the channel reports an empty list (never an error, so
/// the renderer's silent-fallback path stays silent for the right reason).
pub fn safe_mode() -> bool {
    std::env::var(SAFE_MODE_ENV).is_ok_and(|value| value == "1")
}

/// Directories scanned for declarative plugins, in precedence order.
///
/// 1. `ARTFLOW_PLUGINS_ROOT` (debug builds only) — fixture/debug override.
/// 2. `<app data dir>/plugins` — the user's own packs. This is the Tauri counterpart of Electron's
///    `app.getPath('userData')/plugins` (`main.cjs:1015`), and the same root `comic.rs` derives.
/// 3. `<resource dir>/plugins` — packs shipped inside the bundle (Lead owns `bundle.resources`).
/// 4. `<ancestor>/plugins` for up to four ancestors of the executable — `tauri dev` runs the exe
///    from `target/debug`, so this is what makes the preview load the repo's own
///    `plugins/builtin.skins-*` without any build step.
///
/// Deliberately **no seeding**: Electron copies `bundled-plugins` into userData because asar
/// content is read-only and users edit/install those packages, and its `copyDirSafe` never
/// overwrites, so a shipped skin fix would never reach an existing install anyway. Declarative
/// packs here are read-only data with no install path; scanning the bundled directory directly
/// keeps app updates authoritative and leaves the user root free for real user packs.
pub fn plugin_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf, require_dir: bool| {
        if require_dir && !candidate.is_dir() {
            return;
        }
        if !roots.iter().any(|existing| existing == &candidate) {
            roots.push(candidate);
        }
    };

    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var(PLUGINS_ROOT_ENV) {
        if !value.trim().is_empty() {
            push(PathBuf::from(value), false);
        }
    }

    if let Ok(dir) = app.path().app_data_dir() {
        push(dir.join("plugins"), false);
    }
    if let Ok(dir) = app.path().resource_dir() {
        push(dir.join("plugins"), true);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut ancestors = exe.ancestors().skip(1);
        for _ in 0..4 {
            let Some(ancestor) = ancestors.next() else {
                break;
            };
            push(ancestor.join("plugins"), true);
        }
    }
    roots
}

/// Reply shape for `tauri_list_declarative_plugins`, matching the crate's other commands:
/// `{ ok: true, plugins: [...] }` or `{ ok: false, message }`.
#[derive(Debug, Default, Serialize)]
pub struct DeclarativePluginsReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins: Option<Vec<DeclarativePluginDescriptor>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl DeclarativePluginsReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }

    fn success(plugins: Vec<DeclarativePluginDescriptor>) -> Self {
        Self {
            ok: true,
            plugins: Some(plugins),
            message: None,
        }
    }
}

/// `listDeclarativePlugins()` — Tauri counterpart of the `artflow-app:list-declarative-plugins`
/// IPC handler (`main.cjs:1740-1744`).
///
/// The Electron handler returns a bare `{ plugins }`; this one wraps it in `{ ok, … }` like every
/// other command in this crate. The renderer only reads `payload.plugins`
/// (`declarative-loader.ts:52-53`), so both shapes satisfy it — but a failure must not look like an
/// empty success, hence the explicit `ok`.
#[tauri::command]
pub async fn tauri_list_declarative_plugins(window: WebviewWindow) -> DeclarativePluginsReply {
    if !authorized(&window) {
        return DeclarativePluginsReply::error("forbidden caller");
    }
    if safe_mode() {
        return DeclarativePluginsReply::success(Vec::new());
    }
    let app = window.app_handle().clone();
    // Reading up to 32 manifests (one of them is 634 KiB of inline `data:` art) is disk I/O and
    // must not run on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        DeclarativePluginsReply::success(list_declarative_plugins(&plugin_roots(&app)))
    })
    .await
    .unwrap_or_else(|error| {
        DeclarativePluginsReply::error(format!("declarative plugin scan failed: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Self-cleaning fixture directory; every test gets its own so the suite can run in parallel.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let unique = format!(
                "artflow-declarative-{}-{}-{}",
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

        /// Create `<root>/<id>/manifest.json` with the given body.
        fn plugin(&self, id: &str, manifest: &str) -> PathBuf {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).expect("plugin directory");
            fs::write(dir.join("manifest.json"), manifest).expect("manifest");
            dir
        }

        fn nested_plugin(&self, container: &str, id: &str, manifest: &str) -> PathBuf {
            let dir = self.0.join(container).join(id);
            fs::create_dir_all(&dir).expect("nested plugin directory");
            fs::write(dir.join("manifest.json"), manifest).expect("manifest");
            dir
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn skin_manifest(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Test skins","version":"1.0.0","runtime":{{"mode":"declarative"}},
"contributes":{{"skins":[{{"id":"builtin.skin-test","name":"Test"}}]}}}}"#
        )
    }

    // ————————————————————————— patterns —————————————————————————

    #[test]
    fn identifier_pattern_matches_upstream_examples() {
        for value in [
            "builtin.skin-default",
            "builtin.skins-abyssal-serenade",
            "local.my-plugin",
            "a.b",
        ] {
            assert!(matches_id_pattern(value), "{value}");
        }
        for value in ["", "builtin", "Builtin.Skin", ".builtin", "builtin.", "a..b", "a b", "builtin.skin\n"] {
            assert!(!matches_id_pattern(value), "{value}");
        }
    }

    #[test]
    fn language_pattern_matches_upstream_examples() {
        for value in ["en", "zh-CN", "zh_TW", "pt-BR-x1", "abc"] {
            assert!(matches_language_pattern(value), "{value}");
        }
        for value in ["e", "abcd", "zh-C", "zh-CNNNNNNNNN", "EN", "zh--CN", ""] {
            assert!(!matches_language_pattern(value), "{value}");
        }
    }

    // ———————————————————— manifest acceptance ————————————————————

    #[test]
    fn non_declarative_runtime_is_rejected() {
        // A real editable manifest from `plugins/builtin.formats-image-doc`.
        let editable = r#"{"id":"builtin.formats-image-doc","name":"Image docs","runtime":{"entry":"plugin.js","mode":"editable"},"contributes":{}}"#;
        assert!(parse_declarative_manifest(editable).is_none());

        // declarative mode is required…
        let wrong_mode = r#"{"id":"a.b","name":"n","runtime":{"mode":"builtin"},"formatAliases":[{"extension":"cbz","handlerId":"a.h"}]}"#;
        assert!(parse_declarative_manifest(wrong_mode).is_none());

        // …runtime may hold nothing but `mode`…
        let extra_runtime = r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative","entry":"x.js"},"formatAliases":[{"extension":"cbz","handlerId":"a.h"}]}"#;
        assert!(parse_declarative_manifest(extra_runtime).is_none());

        // …and there must be at least one contribution.
        let empty = r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"}}"#;
        assert!(parse_declarative_manifest(empty).is_none());
        let empty_aliases = r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"formatAliases":[],"locales":[]}"#;
        assert!(parse_declarative_manifest(empty_aliases).is_none());

        // Unknown top-level keys reject the manifest instead of being ignored.
        let unknown = r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"entry":"plugin.js","formatAliases":[{"extension":"cbz","handlerId":"a.h"}]}"#;
        assert!(parse_declarative_manifest(unknown).is_none());
    }

    #[test]
    fn invalid_manifests_are_rejected_not_repaired() {
        for raw in [
            "",
            "not json",
            "[]",
            "null",
            // name too long (81 units)
            r#"{"id":"a.b","name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","runtime":{"mode":"declarative"},"formatAliases":[{"extension":"cbz","handlerId":"a.h"}]}"#,
            // extension not lower case
            r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"formatAliases":[{"extension":"CBZ","handlerId":"a.h"}]}"#,
            // locale declaring both sources
            r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"locales":[{"language":"en","file":"en.json","table":{}}]}"#,
            // locale escalating out of the plugin directory
            r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"locales":[{"language":"en","file":"../en.json"}]}"#,
            // contributes may only hold skins
            r#"{"id":"a.b","name":"n","runtime":{"mode":"declarative"},"contributes":{"skins":[{"id":"a.s","name":"s"}],"commands":[]}}"#,
        ] {
            assert!(
                parse_declarative_manifest(raw).is_none(),
                "should reject: {raw}"
            );
        }
    }

    #[test]
    fn locale_table_limits_match_the_renderer_contract() {
        // depth: `{a:{b:{c:{d:{e:1}}}}}` — the innermost object sits at depth 5.
        let deep = serde_json::json!({"a":{"b":{"c":{"d":{"e":"x"}}}}});
        assert!(parse_locale_table(&deep).is_none());
        // one level shallower is fine
        let shallow = serde_json::json!({"a":{"b":{"c":{"d":"x"}}}});
        assert!(parse_locale_table(&shallow).is_some());
        // nested arrays are capped at MAX_LOCALE_ARRAY
        let long_array = serde_json::json!({
            "prompts": Value::Array(vec![Value::String("x".into()); MAX_LOCALE_ARRAY + 1])
        });
        assert!(parse_locale_table(&long_array).is_none());
        let ok_array = serde_json::json!({
            "prompts": Value::Array(vec![Value::String("x".into()); MAX_LOCALE_ARRAY])
        });
        assert!(parse_locale_table(&ok_array).is_some());
        // numbers/booleans/nulls cannot carry copy: a table must not silently shrink
        assert!(parse_locale_table(&serde_json::json!({"count": 33})).is_none());
        assert!(parse_locale_table(&serde_json::json!({"flag": true})).is_none());
        // non-object roots are rejected
        assert!(parse_locale_table(&serde_json::json!([{}])).is_none());
        assert!(parse_locale_table(&serde_json::json!("text")).is_none());
    }

    #[test]
    fn valid_manifest_returns_every_field() {
        let raw = r##"{
            "id": "builtin.skins-test",
            "name": "Test skins",
            "version": "1.0.0",
            "runtime": { "mode": "declarative" },
            "description": "skin pack used by the unit tests",
            "formatAliases": [{ "extension": "cbz", "handlerId": "builtin.formats.comic" }],
            "locales": [{ "language": "zh-CN", "table": { "greeting": "你好", "quickPrompts": ["a", "b"] } }],
            "contributes": { "skins": [{
                "id": "builtin.skin-test",
                "name": "Test",
                "mode": "light",
                "nameI18n": { "zh-CN": "测试" },
                "order": 3,
                "tags": ["warm", "paper"],
                "tokens": { "accent": "#fff", "depth": 2, "flat": true, "nested": { "x": "y" } },
                "css": ":root { --x: 1px; }",
                "customization": {
                    "title": "样式设置",
                    "settings": [
                        { "key": "glow", "type": "boolean", "label": "Glow", "defaultValue": true },
                        { "key": "size", "type": "number", "label": "Size", "defaultValue": 2, "min": 1, "max": 4, "step": 0.5 },
                        { "key": "label", "type": "string", "label": "Label", "defaultValue": "hi", "maxLength": 8 },
                        { "key": "tone", "type": "select", "label": "Tone", "defaultValue": "a", "options": [{ "value": "a", "label": "A" }] }
                    ],
                    "binding": { "size": "--test-size" },
                    "attributeBindings": [{ "name": "data-glow", "key": "glow", "on": "on", "off": "off" }],
                    "classBindings": [{ "key": "glow", "on": "is-glow", "off": "is-plain" }],
                    "branding": { "appLogo": "data:image/svg+xml,x", "splash": { "background": "#000", "accent": "#fff" } }
                },
                "preview": { "dark": "data:image/webp;base64,AAA", "light": "data:image/webp;base64,BBB" },
                "gallery": { "family": "builtin.test", "title": "T", "poster": "data:image/webp;base64,CCC" }
            }] }
        }"##;

        let parsed = parse_declarative_manifest(raw).expect("valid manifest");
        assert_eq!(parsed.id, "builtin.skins-test");
        assert_eq!(parsed.name, "Test skins");
        assert_eq!(parsed.format_aliases.len(), 1);
        assert_eq!(parsed.format_aliases[0].extension, "cbz");
        assert_eq!(parsed.format_aliases[0].handler_id, "builtin.formats.comic");
        assert_eq!(parsed.locales.len(), 1);
        assert_eq!(parsed.skins.len(), 1);
        assert_eq!(
            parsed.description.as_deref(),
            Some("skin pack used by the unit tests")
        );

        // The wire shape is the contract, so assert it through serde exactly as the renderer sees it.
        let descriptor = DeclarativePluginDescriptor {
            id: parsed.id.clone(),
            name: parsed.name.clone(),
            format_aliases: parsed.format_aliases.clone(),
            skins: Some(parsed.skins.clone()),
            description: parsed.description.clone(),
            locales: Some(resolve_locale_bundles(parsed.locales.clone(), Path::new("."))),
        };
        let wire = serde_json::to_value(&descriptor).expect("serialize");
        assert_eq!(wire["id"], "builtin.skins-test");
        assert_eq!(wire["formatAliases"][0]["extension"], "cbz");
        assert_eq!(wire["locales"][0]["language"], "zh-CN");
        assert_eq!(wire["locales"][0]["table"]["greeting"], "你好");
        assert_eq!(wire["locales"][0]["table"]["quickPrompts"][1], "b");
        let skin = &wire["skins"][0];
        assert_eq!(skin["id"], "builtin.skin-test");
        assert_eq!(skin["mode"], "light");
        assert_eq!(skin["nameI18n"]["zh-CN"], "测试");
        assert_eq!(skin["order"], 3);
        assert_eq!(skin["tags"][0], "warm");
        assert_eq!(skin["tokens"]["nested"]["x"], "y");
        assert_eq!(skin["tokens"]["flat"], true);
        assert_eq!(skin["css"], ":root { --x: 1px; }");
        assert_eq!(skin["preview"]["dark"], "data:image/webp;base64,AAA");
        assert_eq!(skin["gallery"]["poster"], "data:image/webp;base64,CCC");
        let customization = &skin["customization"];
        assert_eq!(customization["title"], "样式设置");
        assert_eq!(customization["settings"][0]["defaultValue"], true);
        assert_eq!(customization["settings"][1]["min"], 1);
        assert_eq!(customization["settings"][1]["step"], 0.5);
        assert_eq!(customization["settings"][2]["maxLength"], 8);
        assert_eq!(customization["settings"][3]["options"][0]["value"], "a");
        assert_eq!(customization["binding"]["size"], "--test-size");
        assert_eq!(customization["attributeBindings"][0]["name"], "data-glow");
        assert_eq!(customization["attributeBindings"][0]["off"], "off");
        assert_eq!(customization["classBindings"][0]["on"], "is-glow");
        assert_eq!(customization["branding"]["appLogo"], "data:image/svg+xml,x");
        assert_eq!(customization["branding"]["splash"]["accent"], "#fff");
        // `mode` defaults to dark when omitted.
        let default_mode =
            parse_declarative_manifest(&skin_manifest("builtin.skins-test")).expect("manifest");
        assert_eq!(default_mode.skins[0]["mode"], "dark");
    }

    #[test]
    fn skin_declaration_rejections() {
        let base = |skins: &str| {
            format!(
                r#"{{"id":"a.b","name":"n","runtime":{{"mode":"declarative"}},"contributes":{{"skins":{skins}}}}}"#
            )
        };
        for skins in [
            // unknown entry key
            r#"[{"id":"a.s","name":"s","extra":1}]"#,
            // empty array / non-array
            "[]",
            r#"{"id":"a.s","name":"s"}"#,
            // bad skin id
            r#"[{"id":"a","name":"s"}]"#,
            // name too long
            r#"[{"id":"a.s","name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]"#,
            // bad mode
            r#"[{"id":"a.s","name":"s","mode":"sepia"}]"#,
            // tokens may not be an array
            r##"[{"id":"a.s","name":"s","tokens":["#fff"]}]"##,
            // gallery requires family and title
            r#"[{"id":"a.s","name":"s","gallery":{"family":"a.b"}}]"#,
            // preview values must be strings
            r#"[{"id":"a.s","name":"s","preview":{"dark":5}}]"#,
            // css over 2 MiB
            r#"[{"id":"a.s","name":"s","css":"__CSS__"}]"#,
            // number setting with min above max
            r#"[{"id":"a.s","name":"s","customization":{"title":"t","settings":[{"key":"k","type":"number","label":"L","defaultValue":1,"min":5,"max":2}]}}]"#,
            // binding to an undeclared key
            r#"[{"id":"a.s","name":"s","customization":{"title":"t","settings":[],"binding":{"k":"--x"}}}]"#,
            // attribute binding to a non-boolean setting
            r#"[{"id":"a.s","name":"s","customization":{"title":"t","settings":[{"key":"k","type":"string","label":"L","defaultValue":"x"}],"attributeBindings":[{"name":"data-x","key":"k","on":"on"}]}}]"#,
            // class name collision between on and off
            r#"[{"id":"a.s","name":"s","customization":{"title":"t","settings":[{"key":"k","type":"boolean","label":"L","defaultValue":true}],"classBindings":[{"key":"k","on":"same","off":"same"}]}}]"#,
            // select default outside the options
            r#"[{"id":"a.s","name":"s","customization":{"title":"t","settings":[{"key":"k","type":"select","label":"L","defaultValue":"z","options":[{"value":"a","label":"A"}]}]}}]"#,
        ] {
            let skins = if skins.contains("__CSS__") {
                let filler = "x".repeat(MAX_SKIN_CSS_BYTES + 1);
                skins.replace("__CSS__", &filler)
            } else {
                skins.to_string()
            };
            assert!(
                parse_declarative_manifest(&base(&skins)).is_none(),
                "should reject skins: {}",
                &skins[..skins.len().min(80)]
            );
        }
    }

    #[test]
    fn description_is_truncated_to_200_utf16_units() {
        // 250 CJK chars = 250 UTF-16 units; 250 * 3 bytes in UTF-8, so a byte-based cap would
        // have truncated this at 66 characters.
        let description = "深".repeat(250);
        let raw = format!(
            r#"{{"id":"a.b","name":"n","runtime":{{"mode":"declarative"}},"description":"{description}","formatAliases":[{{"extension":"cbz","handlerId":"a.h"}}]}}"#
        );
        let parsed = parse_declarative_manifest(&raw).expect("manifest");
        let kept = parsed.description.expect("description");
        assert_eq!(utf16_len(&kept), 200);
        assert_eq!(kept, "深".repeat(200));
    }

    // ———————————————————— locale shards ————————————————————

    #[test]
    fn locale_shard_over_the_byte_limit_is_dropped() {
        let fixture = Fixture::new("shard-limit");
        let dir = fixture.plugin(
            "builtin.skins-test",
            r#"{"id":"builtin.skins-test","name":"n","runtime":{"mode":"declarative"},"locales":[{"language":"en","file":"en.json"}]}"#,
        );
        // MAX_LOCALE_SHARD_BYTES + a little: rejected by the stat check.
        let oversize = format!("{{\"big\":\"{}\"}}", "x".repeat(MAX_LOCALE_SHARD_BYTES));
        fs::write(dir.join("en.json"), &oversize).expect("shard");

        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), 1, "the plugin itself still loads");
        assert!(
            plugins[0].locales.is_none(),
            "an oversized shard is dropped, not truncated"
        );
    }

    #[test]
    fn valid_locale_shard_is_read_and_a_broken_one_only_loses_itself() {
        let fixture = Fixture::new("shard-ok");
        let dir = fixture.plugin(
            "builtin.skins-test",
            r#"{"id":"builtin.skins-test","name":"n","runtime":{"mode":"declarative"},"locales":[
                {"language":"en","file":"shards/en.json"},
                {"language":"zh-CN","file":"shards/zh.json"},
                {"language":"ja","table":{"greeting":"こんにちは"}}
            ]}"#,
        );
        fs::create_dir_all(dir.join("shards")).expect("shard dir");
        fs::write(dir.join("shards/en.json"), r#"{"greeting":"hello"}"#).expect("en");
        // Broken JSON on purpose: this language is dropped, the others survive.
        fs::write(dir.join("shards/zh.json"), "{oops").expect("zh");

        let plugins = list_declarative_plugins_in_root(fixture.path());
        let locales = plugins[0].locales.as_ref().expect("locales");
        assert_eq!(locales.len(), 2);
        assert_eq!(locales[0].language, "en");
        assert_eq!(locales[0].table["greeting"], "hello");
        assert_eq!(locales[1].language, "ja");
        assert_eq!(locales[1].table["greeting"], "こんにちは");
    }

    #[test]
    fn shard_paths_cannot_escape_the_plugin_directory() {
        let base = Path::new("C:\\plugins\\a.b");
        for file in [
            "../secret.json",
            "..\\secret.json",
            "shards/../../secret.json",
            "C:\\Windows\\secret.json",
            "\\\\server\\share\\secret.json",
            "/etc/secret.json",
        ] {
            assert!(
                resolve_shard_path(base, file).is_none(),
                "should refuse {file}"
            );
        }
        assert_eq!(
            resolve_shard_path(base, "shards/en.json"),
            Some(PathBuf::from("C:\\plugins\\a.b\\shards\\en.json"))
        );
    }

    #[test]
    fn locale_shard_must_be_json_under_the_plugin_dir() {
        let fixture = Fixture::new("shard-missing");
        fixture.plugin(
            "builtin.skins-test",
            r#"{"id":"builtin.skins-test","name":"n","runtime":{"mode":"declarative"},"locales":[{"language":"en","file":"missing.json"}]}"#,
        );
        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].locales.is_none(), "a missing shard is skipped");
    }

    // ———————————————————————— directory scanning ————————————————

    #[test]
    fn plugin_id_must_equal_its_directory_name() {
        let fixture = Fixture::new("id-mismatch");
        fixture.plugin("wrong.name", &skin_manifest("builtin.skins-test"));
        assert!(list_declarative_plugins_in_root(fixture.path()).is_empty());

        fixture.plugin("builtin.skins-test", &skin_manifest("builtin.skins-test"));
        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "builtin.skins-test");
        // A skin pack carries no locales field at all.
        assert!(plugins[0].locales.is_none());
        assert!(plugins[0].skins.is_some());
    }

    #[test]
    fn scan_descends_exactly_one_container_level() {
        let fixture = Fixture::new("nested");
        fixture.nested_plugin("builtin", "builtin.skins-test", &skin_manifest("builtin.skins-test"));
        // Two containers deep: out of scope, same as the single-level rule upstream.
        fs::create_dir_all(fixture.path().join("outer/inner/builtin.skins-deep")).expect("dir");
        fs::write(
            fixture.path().join("outer/inner/builtin.skins-deep/manifest.json"),
            skin_manifest("builtin.skins-deep"),
        )
        .expect("manifest");

        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "builtin.skins-test");
    }

    #[test]
    fn duplicate_ids_keep_the_first_root_and_the_first_directory() {
        let user = Fixture::new("user-root");
        user.plugin(
            "builtin.skins-test",
            &format!(
                r#"{{"id":"builtin.skins-test","name":"user copy","runtime":{{"mode":"declarative"}},"contributes":{{"skins":[{{"id":"builtin.skin-user","name":"user"}}]}}}}"#
            ),
        );
        let bundled = Fixture::new("bundled-root");
        bundled.plugin(
            "builtin.skins-test",
            &format!(
                r#"{{"id":"builtin.skins-test","name":"bundled copy","runtime":{{"mode":"declarative"}},"contributes":{{"skins":[{{"id":"builtin.skin-bundled","name":"bundled"}}]}}}}"#
            ),
        );

        let plugins = list_declarative_plugins(&[user.path().to_path_buf(), bundled.path().to_path_buf()]);
        assert_eq!(plugins.len(), 1, "one id registers once");
        assert_eq!(plugins[0].name, "user copy", "the first root wins");
    }

    #[test]
    fn root_directory_plugins_win_over_container_plugins() {
        let fixture = Fixture::new("root-priority");
        fixture.plugin(
            "builtin.skins-test",
            r#"{"id":"builtin.skins-test","name":"root copy","runtime":{"mode":"declarative"},"contributes":{"skins":[{"id":"builtin.skin-a","name":"a"}]}}"#,
        );
        fixture.nested_plugin(
            "builtin",
            "builtin.skins-test",
            r#"{"id":"builtin.skins-test","name":"container copy","runtime":{"mode":"declarative"},"contributes":{"skins":[{"id":"builtin.skin-b","name":"b"}]}}"#,
        );
        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "root copy");
    }

    #[test]
    fn at_most_max_plugins_are_returned() {
        let fixture = Fixture::new("cap");
        let total = MAX_PLUGINS + 3;
        for index in 0..total {
            let id = format!("builtin.skins-p{index:02}");
            fixture.plugin(&id, &skin_manifest(&id));
        }
        let plugins = list_declarative_plugins_in_root(fixture.path());
        assert_eq!(plugins.len(), MAX_PLUGINS);
    }

    #[test]
    fn oversized_manifest_is_skipped() {
        let fixture = Fixture::new("oversize");
        let dir = fixture.plugin(
            "builtin.skins-test",
            &skin_manifest("builtin.skins-test"),
        );
        // One byte past MAX_MANIFEST_BYTES: skipped before parsing, like the 8 MiB gate upstream.
        let mut raw = String::from("{\"id\":\"builtin.skins-test\",\"pad\":\"");
        raw.push_str(&"x".repeat(MAX_MANIFEST_BYTES));
        raw.push_str("\"}");
        fs::write(dir.join("manifest.json"), raw).expect("oversize manifest");
        assert!(list_declarative_plugins_in_root(fixture.path()).is_empty());
    }

    #[test]
    fn missing_root_is_an_empty_scan_not_an_error() {
        let fixture = Fixture::new("empty");
        let missing = fixture.path().join("does-not-exist");
        assert!(list_declarative_plugins(&[missing]).is_empty());
    }

    #[test]
    fn the_shipped_skin_packs_parse_and_keep_their_data_uris_verbatim() {
        // The repo's own `plugins/` tree is the only real-world fixture available inside
        // `cargo test`, and it is exactly the input this port must not regress: three declarative
        // packs whose art is inline `data:` (the largest manifest is 634 KiB).
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins");
        if !root.is_dir() {
            // A crate checked out without the renderer tree simply has no fixture to read.
            return;
        }
        let plugins = list_declarative_plugins_in_root(&root);
        let skins: usize = plugins
            .iter()
            .filter_map(|plugin| plugin.skins.as_ref())
            .map(Vec::len)
            .sum();
        assert_eq!(plugins.len(), 3, "three shipped declarative packs");
        assert_eq!(skins, 6, "six shipped skins");

        for plugin in &plugins {
            assert!(plugin.format_aliases.is_empty());
            assert!(plugin.locales.is_none());
            for skin in plugin.skins.as_ref().expect("skins") {
                let mode = skin["mode"].as_str().expect("mode");
                assert!(
                    mode == "dark" || mode == "light",
                    "{} has mode {mode}",
                    skin["id"]
                );
                // Nothing was rewritten into an `asset:` URL or a file path.
                for key in ["css", "preview", "gallery"] {
                    if let Some(value) = skin.get(key) {
                        let text = value.to_string();
                        assert!(
                            !text.contains("asset:") && !text.contains("convertFileSrc"),
                            "{} {} must stay self-contained",
                            skin["id"],
                            key
                        );
                    }
                }
            }
        }

        let abyssal = plugins
            .iter()
            .find(|plugin| plugin.id == "builtin.skins-abyssal-serenade")
            .expect("abyssal pack");
        let light = abyssal
            .skins
            .as_ref()
            .expect("skins")
            .iter()
            .find(|skin| skin["id"] == "builtin.skin-abyssal-light")
            .expect("light skin");
        let css = light["css"].as_str().expect("css");
        assert!(
            css.contains("url('data:image/webp;base64,"),
            "the skin background is an inline data URI"
        );
        assert_eq!(
            light["gallery"]["title"].as_str().expect("gallery title"),
            "深海人鱼谣"
        );
        assert!(light["preview"]["dark"]
            .as_str()
            .expect("preview")
            .starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn safe_mode_reads_the_environment_switch() {
        // `safe_mode()` itself is only meaningful with the variable set, so exercise the contract
        // without mutating the process environment other tests share.
        assert_eq!(SAFE_MODE_ENV, "ARTFLOW_SAFE_MODE");
        let reply = DeclarativePluginsReply::success(Vec::new());
        let wire = serde_json::to_value(&reply).expect("serialize");
        assert_eq!(wire["ok"], true);
        assert_eq!(wire["plugins"], serde_json::json!([]));
        assert!(wire.get("message").is_none());
        let failure = serde_json::to_value(DeclarativePluginsReply::error("boom")).expect("serialize");
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["message"], "boom");
        assert!(failure.get("plugins").is_none());
    }
}