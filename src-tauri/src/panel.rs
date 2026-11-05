//! Popped-out panel windows (Phase 2-B).
//!
//! Upstream baseline: `main.cjs:1586-1628` (`ipcMain.handle(CHANNELS.openPanelWindow, …)`);
//! renderer bridge `preload.cjs:131-137`; consumer `plugin-runtime/panel-host.tsx:77-97`
//! and the pop-out host `components/PipPanelApp.tsx`.
//!
//! A popped-out panel is a second, fully independent renderer of the same bundle:
//! `index.tsx:101` branches on `location.hash.startsWith('#pip-panel')` and mounts
//! `PipPanelApp` instead of the workbench. The hash carries the panel id, so no
//! state has to cross the process boundary.
//!
//! Closing the window broadcasts `artflow-app:panel-window-closed` with the same
//! `{panelId}` payload Electron sent, which is what snaps the panel back in the
//! main window (`panel-host.tsx:93-97`). The event name and payload type live in
//! `window.rs`; this module reuses them instead of inventing a second vocabulary.

//! Until the Lead registers [`tauri_open_panel_window`] in `main.rs`'s
//! `generate_handler!`, the command and everything it reaches are unreachable
//! from `main`, so the whole module looks dead to the compiler. The allow goes
//! away with that registration.
#![allow(dead_code)]

use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

use crate::window::emit_panel_window_closed;

/// `main.cjs:1590` — `/^[\w.:-]{1,120}$/`. `\w` in JS is `[A-Za-z0-9_]`, and
/// without the `u` flag it is ASCII-only, which is what this mirrors.
pub const MAX_PANEL_ID_LEN: usize = 120;
/// `main.cjs:1591-1592` size clamps; the window minimums are separate.
pub const PANEL_MIN_WIDTH: f64 = 320.0;
pub const PANEL_MAX_WIDTH: f64 = 1600.0;
pub const PANEL_MIN_HEIGHT: f64 = 240.0;
pub const PANEL_MAX_HEIGHT: f64 = 1200.0;
/// Defaults used when the renderer sends nothing usable (`Number(x) || 480`).
pub const PANEL_DEFAULT_WIDTH: f64 = 480.0;
pub const PANEL_DEFAULT_HEIGHT: f64 = 640.0;
/// `main.cjs:1597-1598`
pub const PANEL_WINDOW_MIN_WIDTH: f64 = 300.0;
pub const PANEL_WINDOW_MIN_HEIGHT: f64 = 200.0;
/// `main.cjs:1609` — the interpunct is part of the title, keep it.
pub const PANEL_TITLE: &str = "Artflow · Panel";
/// `main.cjs:1607`
pub const PANEL_BACKGROUND: tauri::window::Color = tauri::window::Color(0x0a, 0x0a, 0x0a, 0xff);

/// Label prefix for popped-out windows. Tauri labels are process-global and must
/// be unique, so each window gets `panel-<n>`; the capability therefore has to
/// allow `panel-*` (see the delivery report — this module cannot edit it).
pub const PANEL_LABEL_PREFIX: &str = "panel-";

/// Fail-safe for the `ready-to-show` equivalent: if the pop-out renderer never
/// reports a finished page load (dropped dev server, crashed bundle), reveal the
/// window anyway instead of leaving an invisible window the user cannot close.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_millis(3_000);

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/// `typeof request.panelId === 'string' ? request.panelId : ''` followed by
/// `/^[\w.:-]{1,120}$/`. Non-strings collapse to `''` and are rejected, exactly
/// like upstream — numbers and objects are never coerced into ids.
pub fn panel_id(request: &Value) -> Result<String, &'static str> {
    let id = request.get("panelId").and_then(Value::as_str).unwrap_or("");
    let length = id.chars().count();
    if !(1..=MAX_PANEL_ID_LEN).contains(&length) {
        return Err("rejected: invalid panelId");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
    {
        return Err("rejected: invalid panelId");
    }
    Ok(id.to_string())
}

/// `Number(value)` over a JSON document. `None` means `NaN`; the caller applies
/// the `|| default` fallback for NaN **and** 0, like JS does.
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // `Number('') === 0`; the falsy `|| default` then applies.
                return Some(0.0);
            }
            trimmed.parse::<f64>().ok()
        }
        // Number([]) === 0, Number([5]) === 5, longer arrays are NaN.
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number(Some(&items[0])),
            _ => None,
        },
        _ => None,
    }
}

/// `Math.round(Math.max(320, Math.min(Number(value) || 480, 1600)))`.
///
/// Two JS details are load-bearing: `|| fallback` catches NaN **and** 0, and
/// `Math.round` rounds halves towards +Infinity (Rust's `f64::round` would too
/// for these positive values, but the floor form makes the rule explicit).
/// Infinities survive the clamp instead of collapsing to the default, which is
/// what `Math.min(Infinity, 1600)` does upstream.
fn clamp_dimension(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    let number = match js_number(value) {
        Some(number) if number.is_nan() || number == 0.0 => fallback,
        Some(number) => number,
        None => fallback,
    };
    let clamped = number.max(min).min(max);
    (clamped + 0.5).floor()
}

/// Everything the window needs, validated up front so the command body stays a
/// straight sequence of fallible steps.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelRequest {
    pub panel_id: String,
    pub width: f64,
    pub height: f64,
}

/// `main.cjs:1588-1592`. `Err` carries the exact upstream `message`.
pub fn parse(request: Option<&Value>) -> Result<PanelRequest, &'static str> {
    let Some(request) = request else {
        return Err("rejected: request required");
    };
    if !request.is_object() {
        // Upstream only tested `typeof request !== 'object'`, so arrays slipped
        // through to the panelId check and failed there. Same outcome, but the
        // reason is spelled out instead of accidental.
        return Err(if request.is_array() {
            "rejected: invalid panelId"
        } else {
            "rejected: request required"
        });
    }
    Ok(PanelRequest {
        panel_id: panel_id(request)?,
        width: clamp_dimension(
            request.get("width"),
            PANEL_DEFAULT_WIDTH,
            PANEL_MIN_WIDTH,
            PANEL_MAX_WIDTH,
        ),
        height: clamp_dimension(
            request.get("height"),
            PANEL_DEFAULT_HEIGHT,
            PANEL_MIN_HEIGHT,
            PANEL_MAX_HEIGHT,
        ),
    })
}

/// `pip-panel=${encodeURIComponent(panelId)}` (`main.cjs:1617`).
///
/// `encodeURIComponent` leaves `A-Za-z0-9-_.!~*'()` alone and percent-encodes
/// everything else. The panelId grammar allows only `._:-` plus alphanumerics,
/// so `:` is the sole character that can actually differ.
pub fn panel_hash(panel_id: &str) -> String {
    let mut encoded = String::with_capacity(panel_id.len());
    for byte in panel_id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => encoded.push(byte as char),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    format!("pip-panel={encoded}")
}

/// The URL a panel window loads.
///
/// Upstream loaded `${devUrl}/#${hash}` in dev and `dist/index.html` + `{hash}`
/// when packaged. Tauri resolves `WebviewUrl::App` against `devUrl` in dev and
/// `frontendDist` when packaged (`tauri manager/webview.rs:469-486`), so one call
/// covers both — but the hash has to travel inside the URL, because
/// `WebviewUrl::App` joins a path and drops fragments.
pub fn panel_url(dev_url: Option<&str>, panel_id: &str) -> Result<WebviewUrl, String> {
    let hash = panel_hash(panel_id);
    match dev_url {
        Some(dev_url) if !dev_url.trim().is_empty() => {
            let trimmed = dev_url.trim().trim_end_matches('/');
            let url = Url::parse(&format!("{trimmed}/#{hash}"))
                .map_err(|error| format!("rejected: invalid dev server url: {error}"))?;
            Ok(WebviewUrl::External(url))
        }
        _ => Ok(WebviewUrl::App(format!("index.html#{hash}").into())),
    }
}

/// Electron read `VITE_DEV_SERVER_URL` (`main.cjs:1618`); `tauri dev` exports the
/// same variable, so the two hosts agree on which renderer to load.
fn dev_server_url() -> Option<String> {
    std::env::var("VITE_DEV_SERVER_URL").ok()
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// `window.artflowApp.openPanelWindow({ panelId, width, height })`
///
/// Async because `build()` round-trips through the event loop
/// (`tauri-runtime-wry` `create_window` blocks on a channel), and that must not
/// happen inside a synchronous command on the caller's dispatch.
#[tauri::command]
pub async fn tauri_open_panel_window(window: WebviewWindow, request: Option<Value>) -> Value {
    if !crate::authorized(&window) {
        return json!({ "ok": false, "message": "forbidden caller" });
    }
    let PanelRequest {
        panel_id,
        width,
        height,
    } = match parse(request.as_ref()) {
        Ok(parsed) => parsed,
        Err(message) => return json!({ "ok": false, "message": message }),
    };

    let app = window.app_handle().clone();
    let label = next_label(app.webview_windows().keys().map(String::as_str));
    let url = match panel_url(dev_server_url().as_deref(), &panel_id) {
        Ok(url) => url,
        Err(message) => return json!({ "ok": false, "message": message }),
    };

    // A popped-out panel is a second renderer of the same bundle: frameless on
    // Windows (the renderer paints its own drag strip in PipPanelApp's header),
    // 300x200 floor, dark background so the first frame cannot flash white.
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(PANEL_TITLE)
        .inner_size(width, height)
        .min_inner_size(PANEL_WINDOW_MIN_WIDTH, PANEL_WINDOW_MIN_HEIGHT)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .background_color(PANEL_BACKGROUND)
        // Same synchronous `readStore()` contract as the main window: the pop-out
        // renderer is the same bundle, and `plugin-runtime/config-volume.ts` reads
        // the config volumes during module evaluation, before React exists. Without
        // this script the panel window dies during bootstrap.
        .initialization_script(crate::config_script::initialization_script(
            &crate::config::startup_cache(&app),
        ))
        .visible(false);
    if cfg!(windows) {
        builder = builder.decorations(false);
    }
    // `ready-to-show` equivalent: reveal once the pop-out document finished
    // loading, so the user never sees an unpainted window.
    builder = builder.on_page_load(|webview, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = webview.show();
        }
    });
    let built = match builder.build() {
        Ok(built) => built,
        Err(error) => {
            return json!({
                "ok": false,
                "message": format!("rejected: cannot open panel window: {error}"),
            })
        }
    };

    // `closed` → broadcast `{panelId}` back so the main window snaps the panel
    // into place again (`panel-host.tsx:93-97`). Tauri emits app-wide; the main
    // window is the only listener, so this matches "send to the opener".
    let closed_app = app.clone();
    let closed_id = panel_id.clone();
    built.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            emit_panel_window_closed(&closed_app, &closed_id);
        }
    });

    // Never leave an invisible-but-undeletable window behind.
    let fallback_app = app.clone();
    let fallback_label = label.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        if let Some(window) = fallback_app.get_webview_window(&fallback_label) {
            if !window.is_visible().unwrap_or(false) {
                let _ = window.show();
            }
        }
    });

    json!({ "ok": true })
}

/// `panel-1`, `panel-2`, … — the first free index. Deterministic, and never
/// reuses a live label (Tauri rejects duplicate labels outright).
///
/// The panelId is deliberately not embedded: it may contain `:` or `.`, and a
/// label that varies per panel would make the capability glob unpredictable.
fn next_label<'a>(existing: impl Iterator<Item = &'a str>) -> String {
    let taken: Vec<&str> = existing
        .filter(|label| label.starts_with(PANEL_LABEL_PREFIX))
        .collect();
    let mut index = 1;
    loop {
        let candidate = format!("{PANEL_LABEL_PREFIX}{index}");
        if !taken.iter().any(|label| *label == candidate) {
            return candidate;
        }
        index += 1;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_electron_handler() {
        assert_eq!(MAX_PANEL_ID_LEN, 120);
        assert_eq!((PANEL_MIN_WIDTH, PANEL_MAX_WIDTH), (320.0, 1600.0));
        assert_eq!((PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT), (240.0, 1200.0));
        assert_eq!((PANEL_DEFAULT_WIDTH, PANEL_DEFAULT_HEIGHT), (480.0, 640.0));
        assert_eq!(
            (PANEL_WINDOW_MIN_WIDTH, PANEL_WINDOW_MIN_HEIGHT),
            (300.0, 200.0)
        );
        assert_eq!(PANEL_TITLE, "Artflow · Panel");
        assert_eq!(PANEL_BACKGROUND, tauri::window::Color(10, 10, 10, 255));
    }

    #[test]
    fn panel_id_grammar_matches_the_upstream_regex() {
        for valid in [
            "cards",
            "builtin.cards",
            "plugin:panel",
            "a-b_c.d:e",
            "A",
            "9",
        ] {
            assert!(panel_id(&json!({ "panelId": valid })).is_ok(), "{valid}");
        }
        // 120 characters is the cap, 121 is not.
        assert!(panel_id(&json!({ "panelId": "x".repeat(120) })).is_ok());
        for invalid in [
            "",
            " ",
            "has space",
            "slash/inside",
            "back\\slash",
            "quote\"",
            "hash#",
            "star*",
            "新面板",
            &"x".repeat(121),
        ] {
            assert_eq!(
                panel_id(&json!({ "panelId": invalid })),
                Err("rejected: invalid panelId"),
                "{invalid:?}"
            );
        }
        // Non-strings collapse to '' and are rejected, never coerced.
        for value in [Value::Null, json!(7), json!(["cards"]), json!({"id": "cards"})] {
            assert_eq!(
                panel_id(&json!({ "panelId": value })),
                Err("rejected: invalid panelId"),
                "{value}"
            );
        }
        assert_eq!(panel_id(&json!({})), Err("rejected: invalid panelId"));
    }

    #[test]
    fn dimensions_follow_the_js_round_and_falsy_fallback() {
        // Defaults.
        assert_eq!(clamp_dimension(None, 480.0, 320.0, 1600.0), 480.0);
        // 0 and NaN both fall back (JS `0 || 480`).
        assert_eq!(clamp_dimension(Some(&json!(0)), 480.0, 320.0, 1600.0), 480.0);
        assert_eq!(
            clamp_dimension(Some(&json!("abc")), 480.0, 320.0, 1600.0),
            480.0
        );
        assert_eq!(clamp_dimension(Some(&json!("")), 480.0, 320.0, 1600.0), 480.0);
        // Clamps.
        assert_eq!(clamp_dimension(Some(&json!(1)), 480.0, 320.0, 1600.0), 320.0);
        assert_eq!(
            clamp_dimension(Some(&json!(99_999)), 480.0, 320.0, 1600.0),
            1600.0
        );
        assert_eq!(clamp_dimension(Some(&json!(-5)), 480.0, 240.0, 1200.0), 240.0);
        // Numeric strings are accepted (Number('800')), like upstream.
        assert_eq!(
            clamp_dimension(Some(&json!("800")), 480.0, 320.0, 1600.0),
            800.0
        );
        // Math.round: halves round up.
        assert_eq!(
            clamp_dimension(Some(&json!(480.4)), 480.0, 320.0, 1600.0),
            480.0
        );
        assert_eq!(
            clamp_dimension(Some(&json!(480.5)), 480.0, 320.0, 1600.0),
            481.0
        );
        // Booleans follow Number(true)=1 → clamped to the floor.
        assert_eq!(
            clamp_dimension(Some(&json!(true)), 480.0, 320.0, 1600.0),
            320.0
        );
        // Infinity clamps instead of falling back, matching Math.min(Infinity, 1600).
        assert_eq!(
            clamp_dimension(Some(&json!("Infinity")), 480.0, 320.0, 1600.0),
            1600.0
        );
    }

    #[test]
    fn parse_reports_the_upstream_rejections_in_order() {
        assert_eq!(parse(None), Err("rejected: request required"));
        assert_eq!(
            parse(Some(&json!("cards"))),
            Err("rejected: request required")
        );
        assert_eq!(parse(Some(&json!(7))), Err("rejected: request required"));
        assert_eq!(
            parse(Some(&json!([{ "panelId": "cards" }]))),
            Err("rejected: invalid panelId")
        );
        assert_eq!(parse(Some(&json!({}))), Err("rejected: invalid panelId"));
        assert_eq!(
            parse(Some(&json!({ "panelId": "" }))),
            Err("rejected: invalid panelId")
        );

        let parsed =
            parse(Some(&json!({ "panelId": "builtin.cards", "width": 500 }))).expect("parsed");
        assert_eq!(parsed.panel_id, "builtin.cards");
        assert_eq!(parsed.width, 500.0);
        // height absent → upstream default 640.
        assert_eq!(parsed.height, 640.0);
    }

    #[test]
    fn parse_applies_both_dimension_clamps_from_one_request() {
        let small = parse(Some(&json!({
            "panelId": "cards",
            "width": 10,
            "height": 10,
        })))
        .expect("parsed");
        assert_eq!((small.width, small.height), (320.0, 240.0));

        let large = parse(Some(&json!({
            "panelId": "cards",
            "width": 9000,
            "height": 9000,
        })))
        .expect("parsed");
        assert_eq!((large.width, large.height), (1600.0, 1200.0));

        // The renderer clamps height to 320..720 before calling, but a hostile
        // caller gets the same floor/ceiling as Electron.
        let typical = parse(Some(&json!({
            "panelId": "cards",
            "width": 480,
            "height": 560,
        })))
        .expect("parsed");
        assert_eq!((typical.width, typical.height), (480.0, 560.0));
    }

    #[test]
    fn hash_encoding_matches_encode_uri_component() {
        assert_eq!(panel_hash("cards"), "pip-panel=cards");
        assert_eq!(panel_hash("builtin.cards"), "pip-panel=builtin.cards");
        assert_eq!(panel_hash("plugin:panel"), "pip-panel=plugin%3Apanel");
        assert_eq!(panel_hash("a-b_c.d:e"), "pip-panel=a-b_c.d%3Ae");
    }

    #[test]
    fn panel_url_carries_the_hash_for_both_host_modes() {
        let packaged = panel_url(None, "builtin.cards").expect("packaged url");
        match packaged {
            WebviewUrl::App(path) => {
                assert_eq!(path.to_string_lossy(), "index.html#pip-panel=builtin.cards")
            }
            other => panic!("expected an app url, got {other:?}"),
        }

        let dev = panel_url(Some("http://localhost:4002"), "plugin:panel").expect("dev url");
        match dev {
            WebviewUrl::External(url) => {
                assert_eq!(url.as_str(), "http://localhost:4002/#pip-panel=plugin%3Apanel")
            }
            other => panic!("expected an external url, got {other:?}"),
        }

        // Upstream stripped trailing slashes from VITE_DEV_SERVER_URL.
        let trailing = panel_url(Some("http://localhost:4002///"), "cards").expect("dev url");
        match trailing {
            WebviewUrl::External(url) => {
                assert_eq!(url.as_str(), "http://localhost:4002/#pip-panel=cards")
            }
            other => panic!("expected an external url, got {other:?}"),
        }

        // A malformed dev url is reported, never silently swapped for packaged.
        assert!(panel_url(Some("not a url"), "cards").is_err());
        // A blank dev url behaves like "packaged".
        assert!(matches!(
            panel_url(Some("   "), "cards").expect("blank"),
            WebviewUrl::App(_)
        ));
    }

    #[test]
    fn labels_are_sequential_and_skip_live_ones() {
        let none: [&str; 0] = [];
        assert_eq!(next_label(none.iter().copied()), "panel-1");
        assert_eq!(next_label(["main"].into_iter()), "panel-1");
        assert_eq!(next_label(["main", "panel-1"].into_iter()), "panel-2");
        assert_eq!(
            next_label(["panel-1", "panel-2", "panel-7"].into_iter()),
            "panel-3"
        );
    }
}
