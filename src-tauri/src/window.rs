//! Window-level capabilities for the desktop host (Phase 1-D).
//!
//! Contract source of truth: `preload.cjs:112-168` (parameter shapes) plus the
//! real handler bodies in `main.cjs:1522-1735` (validation, replies, limits).
//! Every reply keeps the exact Electron shape so the renderer's existing
//! `isRejected(result)` / `result.ok` branches keep working unchanged:
//!
//! | renderer call                     | command                    | reply                       |
//! |-----------------------------------|----------------------------|-----------------------------|
//! | `restartApp()`                    | `tauri_restart_app`        | `{ok, message?}`            |
//! | `setAlwaysOnTop(enabled)`         | `tauri_set_always_on_top`  | `boolean | string`          |
//! | `setWindowOpacity(opacity)`       | `tauri_set_window_opacity` | `number | string`           |
//! | `setWindowBackground(color)`      | `tauri_set_window_background` | `string`                 |
//! | `setIgnoreMouseEvents(ignore)`    | `tauri_set_ignore_mouse_events` | `boolean | string`     |
//! | `windowControl(action)`           | `tauri_window_control`     | `{ok, maximized?, message?}`|
//! | `windowMove(request)`             | `tauri_window_move`        | `{ok, message?}`            |
//! | `getWindowState()`                | `tauri_get_window_state`   | `{ok, maximized?, minimized?, message?}` |
//! | `isFramelessWindow` (+ `decorated`) | `tauri_window_platform`  | `{ok, isFramelessWindow, decorated, ...}` |
//!
//! Events pushed by the host (payload matches what Electron sent):
//! - `artflow-app:window-state-changed` → `{maximized: boolean}`
//! - `artflow-app:panel-window-closed`  → `{panelId: string}` (Phase 2 producer)
//!
//! `handle_window_event` is the only thing the Lead has to register; it keeps
//! those events flowing and re-applies the layered-window alpha that tao drops
//! whenever it rewrites the extended window style.

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Electron channel names, reused verbatim so the renderer keeps one vocabulary.
pub const WINDOW_STATE_CHANGED_EVENT: &str = "artflow-app:window-state-changed";
pub const PANEL_WINDOW_CLOSED_EVENT: &str = "artflow-app:panel-window-closed";

/// `main.cjs:1532` rejects anything outside `[0.1, 1]`.
pub const MIN_OPACITY: f64 = 0.1;
pub const MAX_OPACITY: f64 = 1.0;

/// `main.cjs:1695` bounds a single gesture coordinate.
const MAX_GESTURE_COORD: f64 = 1_000_000.0;
/// `main.cjs:1724` bounds the travel of one drag session.
const MAX_GESTURE_TRAVEL: f64 = 8192.0;
/// `main.cjs:1723` expires stale sessions.
const GESTURE_TIMEOUT: Duration = Duration::from_secs(15);
/// `main.cjs:1669` delays the relaunch so the IPC reply is delivered first.
const RESTART_DELAY: Duration = Duration::from_millis(150);

const FORBIDDEN: &str = "forbidden caller";
const INVALID_GESTURE: &str = "rejected: invalid window gesture";

/// Desired window alpha (1.0 = fully opaque). Kept in a process-wide slot
/// because tao has no opacity API: it is applied through Win32 layered-window
/// attributes and must be re-applied after any tao style rewrite.
static ALPHA: Mutex<f64> = Mutex::new(1.0);
/// `main.cjs:1651` serialises restarts.
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);
/// The single in-flight drag session (one main window).
static MOVE_SESSION: Mutex<Option<MoveSession>> = Mutex::new(None);
/// Last known non-maximized bounds `(x, y, width, height)`: needed to place the
/// window correctly when a drag starts while it is maximized.
static LAST_RESTORED: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None);
/// Last maximized state broadcast to the renderer, to emit on transitions only.
static LAST_MAXIMIZED: Mutex<Option<bool>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Pure validation helpers (unit-tested without a window or an event loop)
// ---------------------------------------------------------------------------

/// `main.cjs:1570` action whitelist. Anything else is a rejection, never a no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
}

pub fn parse_window_action(action: &str) -> Result<WindowAction, &'static str> {
    match action {
        "minimize" => Ok(WindowAction::Minimize),
        "toggle-maximize" => Ok(WindowAction::ToggleMaximize),
        "close" => Ok(WindowAction::Close),
        _ => Err("rejected: invalid window action"),
    }
}

pub fn parse_window_action_value(value: &Value) -> Result<WindowAction, &'static str> {
    value
        .as_str()
        .ok_or("rejected: invalid window action")
        .and_then(parse_window_action)
}

/// `main.cjs:1532`: reject, don't clamp — the renderer treats a string result as
/// "not applied" and keeps its own state (`tools-canvas/index.tsx:252`). Clamping
/// would silently disagree with that state, so out-of-range values are refused.
pub fn validate_opacity(value: &Value) -> Result<f64, &'static str> {
    const MESSAGE: &str = "rejected: opacity must be within [0.1, 1]";
    let Some(raw) = value.as_f64() else {
        return Err(MESSAGE);
    };
    if !raw.is_finite() || !(MIN_OPACITY..=MAX_OPACITY).contains(&raw) {
        return Err(MESSAGE);
    }
    Ok(raw)
}

/// `main.cjs:1542` accepts exactly `#rrggbb` (no shorthand, case-insensitive).
pub fn validate_background_color(value: &Value) -> Result<[u8; 3], &'static str> {
    const MESSAGE: &str = "rejected: color must be #rrggbb";
    let Some(text) = value.as_str() else {
        return Err(MESSAGE);
    };
    let bytes = text.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return Err(MESSAGE);
    }
    let mut rgb = [0u8; 3];
    for (index, chunk) in bytes[1..].chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| MESSAGE)?;
        if !pair.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MESSAGE);
        }
        rgb[index] = u8::from_str_radix(pair, 16).map_err(|_| MESSAGE)?;
    }
    Ok(rgb)
}

/// One `windowMove` request: `{phase:'start'|'update', screenX, screenY}` or
/// `{phase:'end'}` (see `types.ts:733`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MoveGesture {
    End,
    Start { x: f64, y: f64 },
    Update { x: f64, y: f64 },
}

pub fn parse_move_request(request: Option<&Value>) -> Result<MoveGesture, &'static str> {
    let Some(Value::Object(map)) = request else {
        return Err(INVALID_GESTURE);
    };
    let Some(phase) = map.get("phase").and_then(Value::as_str) else {
        return Err(INVALID_GESTURE);
    };
    if phase == "end" {
        return Ok(MoveGesture::End);
    }
    if phase != "start" && phase != "update" {
        return Err(INVALID_GESTURE);
    }
    let axis = |key: &str| -> Result<f64, &'static str> {
        let Some(raw) = map.get(key).and_then(Value::as_f64) else {
            return Err(INVALID_GESTURE);
        };
        if !raw.is_finite() || raw.abs() > MAX_GESTURE_COORD {
            return Err(INVALID_GESTURE);
        }
        Ok(raw)
    };
    let x = axis("screenX")?;
    let y = axis("screenY")?;
    Ok(if phase == "start" {
        MoveGesture::Start { x, y }
    } else {
        MoveGesture::Update { x, y }
    })
}

/// What one `update` frame should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveOutcome {
    /// Move the window's outer origin here.
    Move(i32, i32),
    /// The session has no anchor yet (drag began while maximized and the
    /// restored bounds were never observed): anchor on the live position and
    /// swallow this frame instead of jumping to a guessed corner.
    Reanchor,
}

#[derive(Debug)]
pub struct MoveSession {
    start_x: f64,
    start_y: f64,
    anchor: Option<(i32, i32)>,
    started: Instant,
}

impl MoveSession {
    pub fn new(start_x: f64, start_y: f64, anchor: Option<(i32, i32)>, started: Instant) -> Self {
        Self {
            start_x,
            start_y,
            anchor,
            started,
        }
    }

    /// `main.cjs:1722-1734`: expire stale sessions after 15s and reject travel
    /// beyond 8192px so a re-entering cursor can never teleport the window.
    pub fn projection(&self, x: f64, y: f64, now: Instant) -> Result<MoveOutcome, &'static str> {
        let expired = now.saturating_duration_since(self.started) > GESTURE_TIMEOUT;
        let out_of_bounds = (x - self.start_x).abs() > MAX_GESTURE_TRAVEL
            || (y - self.start_y).abs() > MAX_GESTURE_TRAVEL;
        if expired || out_of_bounds {
            return Err("rejected: expired or out-of-bounds gesture");
        }
        Ok(match self.anchor {
            Some((base_x, base_y)) => MoveOutcome::Move(
                base_x + (x - self.start_x).round() as i32,
                base_y + (y - self.start_y).round() as i32,
            ),
            None => MoveOutcome::Reanchor,
        })
    }

    pub fn reanchor(&mut self, x: f64, y: f64, anchor: (i32, i32), now: Instant) {
        self.start_x = x;
        self.start_y = y;
        self.anchor = Some(anchor);
        self.started = now;
    }
}

// ---------------------------------------------------------------------------
// Replies (shapes copied from the Electron handlers)
// ---------------------------------------------------------------------------

/// `setAlwaysOnTop` / `setIgnoreMouseEvents` return `boolean | string`.
#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum BoolOrReject {
    Bool(bool),
    Reject(String),
}

/// `setWindowOpacity` returns `number | string`.
#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum NumberOrReject {
    Number(f64),
    Reject(String),
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SimpleReply {
    fn success() -> Self {
        Self {
            ok: true,
            message: None,
        }
    }

    fn reject(message: impl ToString) -> Self {
        Self {
            ok: false,
            message: Some(message.to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformReply {
    pub ok: bool,
    /// Same meaning as `preload.cjs:127` (`process.platform === 'win32'`): the
    /// renderer only paints its own title bar / drag strip on Windows.
    pub is_frameless_window: bool,
    /// Runtime truth for the Lead's `decorations` decision — the conf value and
    /// this can disagree until `tauri.conf.json` is switched to `false`.
    pub decorated: bool,
    pub opacity: bool,
    pub ignore_mouse_events: bool,
    pub restart: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowStatePayload {
    maximized: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelClosedPayload {
    panel_id: String,
}

// ---------------------------------------------------------------------------
// Native helpers
// ---------------------------------------------------------------------------

/// Applies a whole-window alpha through a layered Win32 window.
///
/// tao has no opacity API, so this flips `WS_EX_LAYERED` on and uses
/// `LWA_ALPHA`. tao rewrites the extended style whenever it re-applies window
/// flags (click-through, decorations, always-on-top, fullscreen), which clears
/// the layered bit; [`reapply_alpha`] restores it from the event hook.
#[cfg(windows)]
fn apply_alpha(hwnd: windows::Win32::Foundation::HWND, alpha: f64) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };

    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let layered = style | WS_EX_LAYERED.0 as isize;
    if layered != style {
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, layered) };
    }
    let value = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
    unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), value, LWA_ALPHA) }
        .map_err(|error| format!("rejected: cannot apply window opacity: {error}"))
}

#[cfg(not(windows))]
fn apply_alpha(_hwnd: (), _alpha: f64) -> Result<(), String> {
    Err("rejected: window opacity is only implemented on Windows".to_string())
}

/// The subset of window operations this module needs, so the same helpers
/// serve both the command layer (`&WebviewWindow`) and the event hook
/// (`&tauri::Window`), which have no common borrow API.
trait WindowTarget {
    #[cfg(windows)]
    fn handle(&self) -> Result<windows::Win32::Foundation::HWND, String>;
    fn maximized(&self) -> bool;
    fn origin(&self) -> Option<(i32, i32)>;
    fn extent(&self) -> Option<(u32, u32)>;
    fn broadcast_state(&self, maximized: bool);
}

impl WindowTarget for WebviewWindow {
    #[cfg(windows)]
    fn handle(&self) -> Result<windows::Win32::Foundation::HWND, String> {
        self.hwnd().map_err(|error| format!("rejected: {error}"))
    }
    fn maximized(&self) -> bool {
        self.is_maximized().unwrap_or(false)
    }
    fn origin(&self) -> Option<(i32, i32)> {
        self.outer_position().ok().map(|position| (position.x, position.y))
    }
    fn extent(&self) -> Option<(u32, u32)> {
        self.outer_size().ok().map(|size| (size.width, size.height))
    }
    fn broadcast_state(&self, maximized: bool) {
        let _ = self.emit(WINDOW_STATE_CHANGED_EVENT, WindowStatePayload { maximized });
    }
}

impl<R: tauri::Runtime> WindowTarget for tauri::Window<R> {
    #[cfg(windows)]
    fn handle(&self) -> Result<windows::Win32::Foundation::HWND, String> {
        self.hwnd().map_err(|error| format!("rejected: {error}"))
    }
    fn maximized(&self) -> bool {
        self.is_maximized().unwrap_or(false)
    }
    fn origin(&self) -> Option<(i32, i32)> {
        self.outer_position().ok().map(|position| (position.x, position.y))
    }
    fn extent(&self) -> Option<(u32, u32)> {
        self.outer_size().ok().map(|size| (size.width, size.height))
    }
    fn broadcast_state(&self, maximized: bool) {
        let _ = self.emit(WINDOW_STATE_CHANGED_EVENT, WindowStatePayload { maximized });
    }
}

fn set_alpha<T: WindowTarget>(window: &T, alpha: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_alpha(window.handle()?, alpha)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        apply_alpha((), alpha)
    }
}

/// Re-applies a non-default alpha after something rewrote the ex-style.
fn reapply_alpha<T: WindowTarget>(window: &T) {
    let alpha = *ALPHA.lock().unwrap_or_else(|poison| poison.into_inner());
    if alpha >= 1.0 {
        return;
    }
    #[cfg(windows)]
    if let Ok(hwnd) = window.handle() {
        let _ = apply_alpha(hwnd, alpha);
    }
    #[cfg(not(windows))]
    let _ = window;
}

fn restored_bounds() -> Option<(i32, i32, u32, u32)> {
    *LAST_RESTORED.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Remembers the last non-maximized geometry so a drag that starts while the
/// window is maximized can place the restored window under the cursor.
fn record_restored<T: WindowTarget>(window: &T) {
    if window.maximized() {
        return;
    }
    let (Some((x, y)), Some((width, height))) = (window.origin(), window.extent()) else {
        return;
    };
    let mut slot = LAST_RESTORED.lock().unwrap_or_else(|poison| poison.into_inner());
    *slot = Some((x, y, width, height));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `restartApp()`: reply first, relaunch 150ms later (`main.cjs:1652-1671`).
///
/// Tauri has no single-instance lock in this app, so there is nothing to release
/// before the new process starts (the Electron path released one).
#[tauri::command]
pub fn tauri_restart_app(window: WebviewWindow) -> SimpleReply {
    if !crate::authorized(&window) {
        return SimpleReply::reject(FORBIDDEN);
    }
    if RESTART_PENDING.swap(true, Ordering::SeqCst) {
        return SimpleReply::reject("rejected: restart already in progress");
    }
    let app: AppHandle = window.app_handle().clone();
    std::thread::spawn(move || {
        // Let the invoke reply leave the process before the run loop unwinds.
        std::thread::sleep(RESTART_DELAY);
        app.request_restart();
    });
    SimpleReply::success()
}

#[tauri::command]
pub fn tauri_set_always_on_top(window: WebviewWindow, enabled: Value) -> BoolOrReject {
    if !crate::authorized(&window) {
        return BoolOrReject::Reject(FORBIDDEN.to_string());
    }
    let Some(enabled) = enabled.as_bool() else {
        return BoolOrReject::Reject("rejected: enabled must be boolean".to_string());
    };
    if let Err(error) = window.set_always_on_top(enabled) {
        return BoolOrReject::Reject(format!("rejected: cannot set always-on-top: {error}"));
    }
    reapply_alpha(&window);
    BoolOrReject::Bool(window.is_always_on_top().unwrap_or(enabled))
}

#[tauri::command]
pub fn tauri_set_window_opacity(window: WebviewWindow, opacity: Value) -> NumberOrReject {
    if !crate::authorized(&window) {
        return NumberOrReject::Reject(FORBIDDEN.to_string());
    }
    let alpha = match validate_opacity(&opacity) {
        Ok(alpha) => alpha,
        Err(message) => return NumberOrReject::Reject(message.to_string()),
    };
    if let Err(message) = set_alpha(&window, alpha) {
        return NumberOrReject::Reject(message);
    }
    *ALPHA.lock().unwrap_or_else(|poison| poison.into_inner()) = alpha;
    NumberOrReject::Number(alpha)
}

/// `setWindowBackground(color)`: paints the WebView2/window background so a
/// skin switch plus resize never flashes white (`skin-engine.ts:837`).
#[tauri::command]
pub fn tauri_set_window_background(window: WebviewWindow, color: Value) -> String {
    if !crate::authorized(&window) {
        return FORBIDDEN.to_string();
    }
    let rgb = match validate_background_color(&color) {
        Ok(rgb) => rgb,
        Err(message) => return message.to_string(),
    };
    if let Err(error) =
        window.set_background_color(Some(tauri::window::Color(rgb[0], rgb[1], rgb[2], 255)))
    {
        return format!("rejected: cannot set window background: {error}");
    }
    // Electron echoed the input string, not a normalised colour.
    color.as_str().unwrap_or_default().to_string()
}

/// `setIgnoreMouseEvents(ignore)`: clicks fall through, keyboard/state kept.
///
/// Divergence: Electron used `{forward: true}` so the renderer kept receiving
/// mousemove while clicks passed through. Tauri/tao exposes no forward option,
/// so the window stops receiving mouse input entirely while ignored. The
/// renderer only needs the flag to toggle back (`tools-canvas/index.tsx:344`),
/// which is driven by a keyboard shortcut, so the capability is still usable.
#[tauri::command]
pub fn tauri_set_ignore_mouse_events(window: WebviewWindow, ignore: Value) -> BoolOrReject {
    if !crate::authorized(&window) {
        return BoolOrReject::Reject(FORBIDDEN.to_string());
    }
    let Some(ignore) = ignore.as_bool() else {
        return BoolOrReject::Reject("rejected: ignore must be boolean".to_string());
    };
    if let Err(error) = window.set_ignore_cursor_events(ignore) {
        return BoolOrReject::Reject(format!("rejected: cannot set mouse pass-through: {error}"));
    }
    // tao rewrote the ex-style; restore a custom alpha if one is set.
    reapply_alpha(&window);
    BoolOrReject::Bool(ignore)
}

#[tauri::command]
pub fn tauri_window_control(window: WebviewWindow, action: Value) -> ControlReply {
    if !crate::authorized(&window) {
        return ControlReply {
            message: Some(FORBIDDEN.to_string()),
            ..ControlReply::default()
        };
    }
    let action = match parse_window_action_value(&action) {
        Ok(action) => action,
        Err(message) => {
            return ControlReply {
                message: Some(message.to_string()),
                ..ControlReply::default()
            }
        }
    };
    match action {
        WindowAction::Minimize => {
            if let Err(error) = window.minimize() {
                return ControlReply {
                    message: Some(format!("rejected: cannot minimize: {error}")),
                    ..ControlReply::default()
                };
            }
            ControlReply {
                ok: true,
                maximized: Some(window.is_maximized().unwrap_or(false)),
                message: None,
            }
        }
        WindowAction::ToggleMaximize => {
            let restore = window.is_maximized().unwrap_or(false);
            let result = if restore {
                window.unmaximize()
            } else {
                window.maximize()
            };
            if let Err(error) = result {
                return ControlReply {
                    message: Some(format!("rejected: cannot toggle maximize: {error}")),
                    ..ControlReply::default()
                };
            }
            record_restored(&window);
            reapply_alpha(&window);
            // tao applies the flag asynchronously; report the state we just set
            // instead of a racy read-back.
            ControlReply {
                ok: true,
                maximized: Some(!restore),
                message: None,
            }
        }
        WindowAction::Close => {
            // Close goes through the normal close request (same as Electron).
            // The sender may be gone before the reply lands; that is a normal exit.
            if let Err(error) = window.close() {
                return ControlReply {
                    message: Some(format!("rejected: cannot close: {error}")),
                    ..ControlReply::default()
                };
            }
            ControlReply {
                ok: true,
                maximized: Some(false),
                message: None,
            }
        }
    }
}

#[tauri::command]
pub fn tauri_get_window_state(window: WebviewWindow) -> StateReply {
    if !crate::authorized(&window) {
        return StateReply {
            message: Some(FORBIDDEN.to_string()),
            ..StateReply::default()
        };
    }
    let Ok(maximized) = window.is_maximized() else {
        return StateReply {
            message: Some("rejected: window not found".to_string()),
            ..StateReply::default()
        };
    };
    let minimized = window.is_minimized().unwrap_or(false);
    if !maximized {
        record_restored(&window);
    }
    StateReply {
        ok: true,
        maximized: Some(maximized),
        minimized: Some(minimized),
        message: None,
    }
}

/// Frameless/capability probe used by the renderer bridge instead of a
/// hard-coded `isFramelessWindow: false`.
#[tauri::command]
pub fn tauri_window_platform(window: WebviewWindow) -> PlatformReply {
    let authorized = crate::authorized(&window);
    PlatformReply {
        ok: authorized,
        // `preload.cjs:127`: the custom chrome is a Windows-only affordance.
        is_frameless_window: cfg!(windows),
        decorated: window.is_decorated().unwrap_or(true),
        opacity: cfg!(windows),
        ignore_mouse_events: true,
        restart: authorized,
    }
}

/// `windowMove(request)`: right-drag moves only this window, never a
/// renderer-supplied target or an unbounded displacement (`main.cjs:1681-1735`).
///
/// Only the outer position is written, and tao's `set_outer_position` uses
/// `SetWindowPos(.., SWP_NOSIZE ..)`, so the size can never drift the way it did
/// with Electron's per-frame `setPosition` (frameless re-frame added ~1px/frame;
/// see the comment at `main.cjs:1676`).
#[tauri::command]
pub fn tauri_window_move(window: WebviewWindow, request: Option<Value>) -> SimpleReply {
    if !crate::authorized(&window) {
        return SimpleReply::reject(FORBIDDEN);
    }
    if !cfg!(windows) {
        return SimpleReply::reject("rejected: window not movable");
    }
    let gesture = match parse_move_request(request.as_ref()) {
        Ok(gesture) => gesture,
        Err(message) => return SimpleReply::reject(message),
    };
    let mut slot = MOVE_SESSION.lock().unwrap_or_else(|poison| poison.into_inner());
    match gesture {
        MoveGesture::End => {
            *slot = None;
            SimpleReply::success()
        }
        MoveGesture::Start { x, y } => {
            let was_maximized = window.is_maximized().unwrap_or(false);
            let maximized_bounds = if was_maximized {
                Some((window.outer_position().ok(), window.outer_size().ok()))
            } else {
                None
            };
            if was_maximized {
                if let Err(error) = window.unmaximize() {
                    *slot = None;
                    return SimpleReply::reject(format!("rejected: cannot restore: {error}"));
                }
            }
            // Anchor: the current outer origin, or — after a restore — the
            // remembered non-maximized origin placed under the cursor using the
            // same 5%..95% clamp Electron used (`main.cjs:1704-1711`).
            let anchor = match maximized_bounds {
                Some((Some(max_position), Some(max_size))) => {
                    match restored_bounds() {
                        // Only the restored extent matters: Electron re-placed
                        // the window under the cursor, it never reused the old
                        // origin (`main.cjs:1704-1713`).
                        Some((_, _, width, height)) => {
                            let fraction_x = clamp_fraction(
                                (x - max_position.x as f64) / max_size.width.max(1) as f64,
                            );
                            let fraction_y = clamp_fraction(
                                (y - max_position.y as f64) / max_size.height.max(1) as f64,
                            );
                            let target_x = (x - width as f64 * fraction_x).round() as i32;
                            let target_y = (y - height as f64 * fraction_y).round() as i32;
                            if let Err(error) = window
                                .set_position(tauri::PhysicalPosition::new(target_x, target_y))
                            {
                                *slot = None;
                                return SimpleReply::reject(format!(
                                    "rejected: cannot restore position: {error}"
                                ));
                            }
                            // The position we just asked for is the anchor; no
                            // read-back (the move is applied asynchronously).
                            Some((target_x, target_y))
                        }
                        // Restored geometry never observed yet: un-maximize and
                        // let the first update re-anchor instead of guessing a
                        // corner and teleporting the window.
                        None => None,
                    }
                }
                // Could not read the maximized bounds: same fallback.
                Some(_) => None,
                None => window.outer_position().ok().map(|position| (position.x, position.y)),
            };
            *slot = Some(MoveSession::new(x, y, anchor, Instant::now()));
            SimpleReply::success()
        }
        MoveGesture::Update { x, y } => {
            let now = Instant::now();
            let Some(session) = slot.as_mut() else {
                return SimpleReply::reject("rejected: expired or out-of-bounds gesture");
            };
            match session.projection(x, y, now) {
                Ok(MoveOutcome::Move(target_x, target_y)) => {
                    let result =
                        window.set_position(tauri::PhysicalPosition::new(target_x, target_y));
                    if let Err(error) = result {
                        *slot = None;
                        return SimpleReply::reject(format!(
                            "rejected: cannot move window: {error}"
                        ));
                    }
                    SimpleReply::success()
                }
                Ok(MoveOutcome::Reanchor) => {
                    match window.outer_position() {
                        Ok(position) => {
                            session.reanchor(x, y, (position.x, position.y), now);
                            SimpleReply::success()
                        }
                        Err(error) => {
                            *slot = None;
                            SimpleReply::reject(format!("rejected: cannot read position: {error}"))
                        }
                    }
                }
                Err(message) => {
                    *slot = None;
                    SimpleReply::reject(message)
                }
            }
        }
    }
}

fn clamp_fraction(value: f64) -> f64 {
    // `Math.min(Math.max(n, 0.05), 0.95)` in `main.cjs:1706`: NaN has no
    // meaningful side to clamp to, so centre it; infinities clamp normally.
    if value.is_nan() {
        return 0.5;
    }
    value.clamp(0.05, 0.95)
}

// ---------------------------------------------------------------------------
// Window event hook (the Lead registers this once)
// ---------------------------------------------------------------------------

/// Keeps `artflow-app:window-state-changed` flowing and re-applies the layered
/// alpha tao drops whenever it rewrites the extended window style.
///
/// Register in `main.rs`:
/// `.on_window_event(|window, event| window::handle_window_event(window, event))`
pub fn handle_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            record_restored(window);
            reapply_alpha(window);
            report_maximized(window);
        }
        tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ThemeChanged(_) => {
            reapply_alpha(window);
            report_maximized(window);
        }
        tauri::WindowEvent::ScaleFactorChanged { .. } => {
            reapply_alpha(window);
        }
        tauri::WindowEvent::Destroyed => {
            *MOVE_SESSION.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
            *LAST_RESTORED.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
        }
        _ => {}
    }
}

/// Emits only on a real transition, like Electron's maximize/unmaximize
/// listeners (`main.cjs:935-941`) — the renderer re-renders on every event.
fn report_maximized<T: WindowTarget>(window: &T) {
    let maximized = window.maximized();
    let mut last = LAST_MAXIMIZED
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if *last == Some(maximized) {
        return;
    }
    *last = Some(maximized);
    window.broadcast_state(maximized);
}

/// Phase 2 hook: broadcast `{panelId}` when a popped-out panel window closes,
/// matching `main.cjs:1622-1626`.
pub fn emit_panel_window_closed(app: &AppHandle, panel_id: &str) {
    let _ = app.emit(
        PANEL_WINDOW_CLOSED_EVENT,
        PanelClosedPayload {
            panel_id: panel_id.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_control_accepts_only_the_electron_whitelist() {
        assert_eq!(
            parse_window_action("minimize").unwrap(),
            WindowAction::Minimize
        );
        assert_eq!(
            parse_window_action("toggle-maximize").unwrap(),
            WindowAction::ToggleMaximize
        );
        assert_eq!(parse_window_action("close").unwrap(), WindowAction::Close);
        for rejected in [
            "maximize",
            "unmaximize",
            "restore",
            "fullscreen",
            "Close",
            "minimize ",
            "__proto__",
            "",
        ] {
            assert!(
                parse_window_action(rejected).is_err(),
                "{rejected} must be rejected"
            );
        }
        assert!(parse_window_action_value(&json!(42)).is_err());
        assert!(parse_window_action_value(&json!(null)).is_err());
    }

    #[test]
    fn opacity_is_rejected_outside_the_electron_range() {
        // In range (inclusive bounds, as `main.cjs:1532`).
        assert_eq!(validate_opacity(&json!(0.1)).unwrap(), 0.1);
        assert_eq!(validate_opacity(&json!(0.55)).unwrap(), 0.55);
        assert_eq!(validate_opacity(&json!(1)).unwrap(), 1.0);
        // Out of range or not a number: rejected, never clamped.
        for rejected in [json!(0.05), json!(0.0999), json!(1.0001), json!(2), json!(0), json!(-0.5)] {
            assert!(validate_opacity(&rejected).is_err(), "{rejected}");
        }
        for rejected in [json!("0.5"), json!(null), json!(true), json!([0.5])] {
            assert!(validate_opacity(&rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn background_color_needs_an_exact_six_digit_hex() {
        assert_eq!(validate_background_color(&json!("#111827")).unwrap(), [0x11, 0x18, 0x27]);
        assert_eq!(validate_background_color(&json!("#0A0A0A")).unwrap(), [0x0a, 0x0a, 0x0a]);
        for rejected in [
            json!("#fff"),
            json!("111827"),
            json!("#11182"),
            json!("#1118277"),
            json!("#11 827"),
            json!("#gggggg"),
            json!("red"),
            json!("#"),
            json!(null),
            json!(0x111827),
        ] {
            assert!(
                validate_background_color(&rejected).is_err(),
                "{rejected} must be rejected"
            );
        }
    }

    #[test]
    fn move_requests_are_validated_like_the_main_process() {
        assert_eq!(
            parse_move_request(Some(&json!({"phase": "end"}))).unwrap(),
            MoveGesture::End
        );
        assert_eq!(
            parse_move_request(Some(&json!({"phase": "start", "screenX": 10, "screenY": -20})))
                .unwrap(),
            MoveGesture::Start { x: 10.0, y: -20.0 }
        );
        assert_eq!(
            parse_move_request(Some(&json!({"phase": "update", "screenX": 0, "screenY": 0})))
                .unwrap(),
            MoveGesture::Update { x: 0.0, y: 0.0 }
        );
        for rejected in [
            None,
            Some(json!(null)),
            Some(json!("start")),
            Some(json!({"phase": "move", "screenX": 1, "screenY": 1})),
            Some(json!({"phase": "start", "screenY": 1})),
            Some(json!({"phase": "start", "screenX": "1", "screenY": 1})),
            Some(json!({"phase": "start", "screenX": 2_000_000, "screenY": 0})),
            Some(json!({"phase": "update", "screenX": 0, "screenY": -2_000_000})),
        ] {
            assert!(parse_move_request(rejected.as_ref()).is_err(), "{rejected:?}");
        }
    }

    #[test]
    fn move_sessions_expire_and_stay_bounded() {
        let start = Instant::now();
        let session = MoveSession::new(100.0, 100.0, Some((500, 300)), start);
        assert_eq!(
            session
                .projection(140.0, 100.0, start + Duration::from_millis(16))
                .unwrap(),
            MoveOutcome::Move(540, 300)
        );
        // Travel beyond 8192px is refused.
        assert!(session
            .projection(100.0 + MAX_GESTURE_TRAVEL + 1.0, 100.0, start)
            .is_err());
        // Sessions older than 15s are refused.
        assert!(session
            .projection(110.0, 110.0, start + GESTURE_TIMEOUT + Duration::from_millis(1))
            .is_err());
        // No anchor yet: the caller re-anchors instead of jumping.
        let unanchored = MoveSession::new(10.0, 10.0, None, start);
        assert_eq!(
            unanchored.projection(12.0, 11.0, start).unwrap(),
            MoveOutcome::Reanchor
        );
    }

    #[test]
    fn restore_fraction_is_clamped_into_the_window() {
        assert_eq!(clamp_fraction(0.0), 0.05);
        assert_eq!(clamp_fraction(1.0), 0.95);
        assert_eq!(clamp_fraction(0.5), 0.5);
        assert_eq!(clamp_fraction(f64::NAN), 0.5);
        assert_eq!(clamp_fraction(f64::INFINITY), 0.95);
    }
}
