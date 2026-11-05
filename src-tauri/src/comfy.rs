//! Restricted ComfyUI proxy (Phase 2-B).
//!
//! Upstream baseline: `main/comfyProxy.cjs` (161 lines) plus the IPC registration
//! at `main.cjs:759-766`; the renderer bridge is `preload.cjs:175-177`
//! (`window.artflowAi.comfyRequest(request)`).
//!
//! Two hard constraints inherited from the Electron implementation:
//!
//! 1. Only the fixed op whitelist below exists. There is no `(method, url)` form,
//!    so this channel can never degrade into a generic HTTP bridge
//!    (`types.ts` spells that out as a contract, not a preference).
//! 2. Upstream used `node:http` instead of `fetch` on purpose: `fetch` reads the
//!    system proxy settings and gets hijacked by a local loopback proxy. The
//!    reqwest client here therefore calls `.no_proxy()` explicitly — dropping it
//!    silently changes which endpoint answers.
//!
//! Reply shapes are byte-for-byte the Electron ones so the renderer's
//! `result.ok` / `result.status` branches keep working unchanged:
//!
//! | op          | method/path                | reply                                     |
//! |-------------|----------------------------|-------------------------------------------|
//! | `stats`     | GET `/system_stats`        | `{ok, status, data}`                      |
//! | `objectInfo`| GET `/object_info`         | `{ok, status, data}`                      |
//! | `submit`    | POST `/prompt`             | `{ok, status, data}`                      |
//! | `history`   | GET `/history/<id>`        | `{ok, status, data}`                      |
//! | `view`      | GET `/view?<query>`        | `{ok, status, contentType, bytes}`        |
//! | `interrupt` | POST `/interrupt`          | `{ok, status, data}`                      |
//!
//! Everything else is `{ok:false, message}` with the exact upstream wording.
#![allow(dead_code)] // 部分常量与纯函数只被单测引用，模块对外只暴露命令。

use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

/// `comfyProxy.cjs:15-21` — every one of these is load-bearing; do not "tidy" them.
pub const COMFY_HOST: &str = "127.0.0.1";
pub const COMFY_PORT: u16 = 8188;
pub const COMFY_ENDPOINT: &str = "http://127.0.0.1:8188";
pub const COMFY_TIMEOUT_MS: u64 = 30_000;
pub const COMFY_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const COMFY_ID_MAX_LEN: usize = 64;
pub const COMFY_VIEW_TYPES: [&str; 3] = ["input", "output", "temp"];

/// Submit / view run a matting workflow that inlines a base64 source image, so
/// upstream widens those two to two minutes (`comfyProxy.cjs:119,130`).
const COMFY_HEAVY_TIMEOUT: Duration = Duration::from_millis(120_000);
const COMFY_DEFAULT_TIMEOUT: Duration = Duration::from_millis(COMFY_TIMEOUT_MS);

const RESPONSE_TOO_LARGE: &str = "response too large";
const TIMEOUT: &str = "comfy timeout";
const INVALID_REQUEST: &str = "rejected: invalid request";

/// One validated request. Produced by [`plan`] without touching the network so
/// the whole whitelist (and every rejection) is unit-testable.
#[derive(Debug, Clone, PartialEq)]
pub struct ComfyPlan {
    /// `GET` or `POST` — the only two methods upstream ever issues.
    pub method: &'static str,
    /// Path plus query string, appended verbatim to [`COMFY_ENDPOINT`].
    pub path: String,
    /// Serialised as the JSON body; `None` sends no body and no content type.
    pub payload: Option<Value>,
    pub timeout: Duration,
    /// Which reply shape the response feeds into.
    pub kind: PlanKind,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlanKind {
    /// `comfyJsonResult`: `{ok, status, data}` / `{ok:false, status, message}`.
    Json,
    /// `view`: `{ok, status, contentType, bytes}`.
    View,
}

#[derive(Debug)]
struct ComfyResponse {
    status: u16,
    content_type: String,
    buffer: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/// `COMFY_ID_PATTERN.test(value)` — `/^[A-Za-z0-9_-]{1,64}$/`, anchored.
fn is_comfy_id(value: &str) -> bool {
    let length = value.chars().count();
    (1..=COMFY_ID_MAX_LEN).contains(&length)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `comfyViewField(value)` (`comfyProxy.cjs:76-80`): an untrusted ComfyUI-side
/// filename must never be able to climb out of the ComfyUI temp folder or
/// inject extra query parameters.
fn is_view_field(value: &str) -> bool {
    let length = value.chars().count();
    (1..=260).contains(&length)
        && !value.contains("..")
        && !value.contains('\\')
        && !value.contains('\0')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '-' | '/'))
}

/// `URLSearchParams.toString()` — application/x-www-form-urlencoded, which is
/// what ComfyUI expects. Hand-rolled so `/` is percent-encoded like the JS
/// implementation does; `url`'s form serializer leaves it alone.
fn form_urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `comfyViewQuery(request)` (`comfyProxy.cjs:82-95`), same field order, same
/// early returns, same wording. `undefined | null | ''` are skipped, anything
/// else must pass [`is_view_field`].
fn view_query(request: &Value) -> Result<String, String> {
    let mut params: Vec<(&str, &str)> = Vec::new();
    for field in ["filename", "subfolder", "type"] {
        let Some(value) = request.get(field) else {
            continue;
        };
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        let Some(text) = value.as_str() else {
            return Err(format!("rejected: invalid {field}"));
        };
        if !is_view_field(text) {
            return Err(format!("rejected: invalid {field}"));
        }
        params.push((field, text));
    }
    if !params.iter().any(|(field, _)| *field == "filename") {
        return Err("rejected: filename required".to_string());
    }
    if let Some((_, kind)) = params.iter().find(|(field, _)| *field == "type") {
        if !COMFY_VIEW_TYPES.contains(kind) {
            return Err("rejected: invalid type".to_string());
        }
    }
    Ok(params
        .iter()
        .map(|(field, value)| format!("{field}={}", form_urlencode(value)))
        .collect::<Vec<_>>()
        .join("&"))
}

/// `handleComfyRequest(request)` minus the transport: what to call, and how the
/// answer is shaped. `Err` carries the exact upstream `message` string.
pub fn plan(request: &Value) -> Result<ComfyPlan, String> {
    if !request.is_object() {
        // Arrays reached the `rejected: invalid request` branch upstream too
        // (`typeof [] === 'object'` but the op lookup then fell to `default`,
        // and `handleComfyRequest` rejected non-objects up front).
        return Err(INVALID_REQUEST.to_string());
    }
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "stats" => Ok(json_plan("/system_stats", COMFY_DEFAULT_TIMEOUT)),
        "objectInfo" => Ok(json_plan("/object_info", COMFY_DEFAULT_TIMEOUT)),
        "submit" => {
            let workflow = request.get("workflow");
            let Some(workflow) = workflow.filter(|value| value.is_object()) else {
                return Err("rejected: invalid workflow".to_string());
            };
            let mut payload = json!({ "prompt": workflow });
            if let Some(client_id) = request.get("clientId").and_then(Value::as_str) {
                if is_comfy_id(client_id) {
                    payload["client_id"] = json!(client_id);
                }
            }
            Ok(ComfyPlan {
                method: "POST",
                path: "/prompt".to_string(),
                payload: Some(payload),
                timeout: COMFY_HEAVY_TIMEOUT,
                kind: PlanKind::Json,
            })
        }
        "history" => {
            let prompt_id = request.get("promptId").and_then(Value::as_str).unwrap_or("");
            if !is_comfy_id(prompt_id) {
                return Err("rejected: invalid prompt id".to_string());
            }
            Ok(json_plan(
                &format!("/history/{prompt_id}"),
                COMFY_DEFAULT_TIMEOUT,
            ))
        }
        "view" => {
            let query = view_query(request)?;
            Ok(ComfyPlan {
                method: "GET",
                path: format!("/view?{query}"),
                payload: None,
                timeout: COMFY_HEAVY_TIMEOUT,
                kind: PlanKind::View,
            })
        }
        "interrupt" => Ok(ComfyPlan {
            method: "POST",
            path: "/interrupt".to_string(),
            payload: Some(json!({})),
            timeout: COMFY_DEFAULT_TIMEOUT,
            kind: PlanKind::Json,
        }),
        _ => Err("rejected: unsupported op".to_string()),
    }
}

fn json_plan(path: &str, timeout: Duration) -> ComfyPlan {
    ComfyPlan {
        method: "GET",
        path: path.to_string(),
        payload: None,
        timeout,
        kind: PlanKind::Json,
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Process-wide client: one connection pool, no automatic proxy lookup, and no
/// client-level timeout (each plan carries its own, exactly like upstream's
/// per-request `request.setTimeout`).
fn client() -> Result<reqwest::blocking::Client, String> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let built = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(None::<Duration>)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// Reads at most `limit` bytes, failing loudly the moment the peer exceeds it
/// (`comfyProxy.cjs:41-44` used `request.destroy(new Error('response too large'))`).
/// Exactly `limit` bytes is allowed, matching `if (size > COMFY_MAX_BODY_BYTES)`.
fn read_capped<R: Read>(reader: &mut R, limit: usize) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                return Err(TIMEOUT.to_string())
            }
            Err(error) => return Err(error.to_string()),
        };
        if read == 0 {
            return Ok(buffer);
        }
        if buffer.len() + read > limit {
            return Err(RESPONSE_TOO_LARGE.to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

/// `comfyCall(pathname, { method, timeoutMs, payload })`. `Err` is the text that
/// upstream appended to `'comfy unreachable: '`.
fn request(
    base: &str,
    method: &str,
    path: &str,
    payload: Option<&Value>,
    timeout: Duration,
) -> Result<ComfyResponse, String> {
    let client = client()?;
    let url = format!("{base}{path}");
    let mut builder = match method {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };
    builder = builder.timeout(timeout);
    if let Some(payload) = payload {
        // content-length is added by the transport layer; upstream set it by
        // hand only because node:http does not.
        let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        builder = builder
            .header("content-type", "application/json")
            .body(body);
    }
    let mut response = builder.send().map_err(|error| {
        if error.is_timeout() {
            TIMEOUT.to_string()
        } else {
            error.to_string()
        }
    })?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let buffer = read_capped(&mut response, COMFY_MAX_BODY_BYTES)?;
    Ok(ComfyResponse {
        status,
        content_type,
        buffer,
    })
}

fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

/// `comfyJsonResult(response)` (`comfyProxy.cjs:64-73`).
fn json_result(response: &ComfyResponse) -> Value {
    if !is_success(response.status) {
        return json!({
            "ok": false,
            "status": response.status,
            "message": format!("comfy http {}", response.status),
        });
    }
    match serde_json::from_slice::<Value>(&response.buffer) {
        Ok(data) => json!({ "ok": true, "status": response.status, "data": data }),
        // JSON.parse('') throws too, so an empty body lands here as well.
        Err(_) => json!({
            "ok": false,
            "status": response.status,
            "message": "comfy returned invalid json",
        }),
    }
}

/// The `view` reply. `bytes` crosses Tauri IPC as a plain number array (there is
/// no structured clone), so the renderer adapter re-wraps it into an ArrayBuffer.
fn view_result(response: &ComfyResponse) -> Value {
    if !is_success(response.status) {
        return json!({
            "ok": false,
            "status": response.status,
            "message": format!("comfy http {}", response.status),
        });
    }
    json!({
        "ok": true,
        "status": response.status,
        "contentType": response.content_type,
        "bytes": response.buffer,
    })
}

fn unreachable(message: String) -> Value {
    json!({ "ok": false, "message": format!("comfy unreachable: {message}") })
}

fn rejected(message: impl ToString) -> Value {
    json!({ "ok": false, "message": message.to_string() })
}

/// Runs one validated plan and folds the answer into the Electron reply shape.
pub fn execute(plan: &ComfyPlan) -> Value {
    let response = match request(
        COMFY_ENDPOINT,
        plan.method,
        &plan.path,
        plan.payload.as_ref(),
        plan.timeout,
    ) {
        Ok(response) => response,
        Err(message) => return unreachable(message),
    };
    match plan.kind {
        PlanKind::Json => json_result(&response),
        PlanKind::View => view_result(&response),
    }
}

/// `window.artflowAi.comfyRequest(request)`
#[tauri::command]
pub async fn tauri_comfy_request(window: tauri::WebviewWindow, request: Option<Value>) -> Value {
    if !crate::authorized(&window) {
        return rejected("forbidden caller");
    }
    let Some(request) = request else {
        return rejected(INVALID_REQUEST);
    };
    let plan = match plan(&request) {
        Ok(plan) => plan,
        Err(message) => return rejected(message),
    };
    // Blocking HTTP must never sit on the async runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || execute(&plan))
        .await
        .unwrap_or_else(|error| unreachable(format!("comfy request failed: {error}")))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, content_type: &str, buffer: &[u8]) -> ComfyResponse {
        ComfyResponse {
            status,
            content_type: content_type.to_string(),
            buffer: buffer.to_vec(),
        }
    }

    #[test]
    fn endpoint_constants_match_the_upstream_module() {
        assert_eq!(COMFY_HOST, "127.0.0.1");
        assert_eq!(COMFY_PORT, 8188);
        assert_eq!(COMFY_ENDPOINT, format!("http://{COMFY_HOST}:{COMFY_PORT}"));
        assert_eq!(COMFY_TIMEOUT_MS, 30000);
        assert_eq!(COMFY_MAX_BODY_BYTES, 64 * 1024 * 1024);
        assert_eq!(COMFY_VIEW_TYPES, ["input", "output", "temp"]);
    }

    #[test]
    fn non_object_requests_are_rejected_with_the_upstream_wording() {
        for value in [
            Value::Null,
            json!("stats"),
            json!(42),
            json!([{"op": "stats"}]),
            json!(true),
        ] {
            assert_eq!(plan(&value).unwrap_err(), "rejected: invalid request");
        }
        // A bare object is a valid request object without a known op.
        assert_eq!(
            plan(&json!({})).unwrap_err(),
            "rejected: unsupported op"
        );
    }

    #[test]
    fn the_whitelist_has_exactly_six_json_ops_and_one_view_op() {
        let stats = plan(&json!({"op": "stats"})).expect("stats");
        assert_eq!(
            stats,
            json_plan("/system_stats", COMFY_DEFAULT_TIMEOUT)
        );

        let object_info = plan(&json!({"op": "objectInfo"})).expect("objectInfo");
        assert_eq!(object_info.path, "/object_info");
        assert_eq!(object_info.method, "GET");
        assert!(object_info.payload.is_none());

        let interrupt = plan(&json!({"op": "interrupt"})).expect("interrupt");
        assert_eq!(interrupt.method, "POST");
        assert_eq!(interrupt.path, "/interrupt");
        assert_eq!(interrupt.payload, Some(json!({})));
        assert_eq!(interrupt.kind, PlanKind::Json);

        let history = plan(&json!({"op": "history", "promptId": "abc-123_X"})).expect("history");
        assert_eq!(history.path, "/history/abc-123_X");
        assert_eq!(history.timeout, COMFY_DEFAULT_TIMEOUT);

        let view = plan(&json!({"op": "view", "filename": "ComfyUI_0001.png"})).expect("view");
        assert_eq!(view.path, "/view?filename=ComfyUI_0001.png");
        assert_eq!(view.kind, PlanKind::View);
        assert_eq!(view.timeout, COMFY_HEAVY_TIMEOUT);

        for op in ["Stats", "object_info", "queue", "cancel", "openExternal"] {
            assert_eq!(
                plan(&json!({ "op": op })).unwrap_err(),
                "rejected: unsupported op",
                "{op}"
            );
        }
    }

    #[test]
    fn submit_wraps_the_workflow_and_only_forwards_a_well_formed_client_id() {
        let workflow = json!({"3": {"class_type": "KSampler", "inputs": {"seed": 1}}});
        let plain = plan(&json!({"op": "submit", "workflow": workflow})).expect("submit");
        assert_eq!(plain.method, "POST");
        assert_eq!(plain.path, "/prompt");
        assert_eq!(plain.timeout, COMFY_HEAVY_TIMEOUT);
        assert_eq!(plain.payload, Some(json!({"prompt": workflow})));

        let with_id = plan(&json!({
            "op": "submit",
            "workflow": workflow,
            "clientId": "artflow_client-1",
        }))
        .expect("submit");
        assert_eq!(
            with_id.payload,
            Some(json!({"prompt": workflow, "client_id": "artflow_client-1"}))
        );

        // Upstream silently omits a malformed clientId instead of failing.
        for client_id in ["", "has space", "a/b", &"x".repeat(65)] {
            let plan = plan(&json!({
                "op": "submit",
                "workflow": workflow,
                "clientId": client_id,
            }))
            .expect("submit");
            assert_eq!(plan.payload, Some(json!({"prompt": workflow})), "{client_id}");
        }

        for workflow in [Value::Null, json!([]), json!("workflow"), json!(3)] {
            assert_eq!(
                plan(&json!({"op": "submit", "workflow": workflow})).unwrap_err(),
                "rejected: invalid workflow"
            );
        }
        assert_eq!(
            plan(&json!({"op": "submit"})).unwrap_err(),
            "rejected: invalid workflow"
        );
    }

    #[test]
    fn history_requires_an_id_that_matches_the_upstream_pattern() {
        for prompt_id in [
            Value::Null,
            json!(""),
            json!("has space"),
            json!("a/b"),
            json!(42),
            json!("x".repeat(65)),
        ] {
            assert_eq!(
                plan(&json!({"op": "history", "promptId": prompt_id})).unwrap_err(),
                "rejected: invalid prompt id",
                "{prompt_id}"
            );
        }
        assert_eq!(
            plan(&json!({"op": "history"})).unwrap_err(),
            "rejected: invalid prompt id"
        );
    }

    #[test]
    fn view_field_matrix_matches_the_upstream_guards() {
        // Every rejection the Electron proxy performs, in the same order.
        let cases: [(&str, &str); 6] = [
            ("..", "rejected: invalid filename"),
            ("a\\b.png", "rejected: invalid filename"),
            ("a\0b.png", "rejected: invalid filename"),
            ("a?b=1", "rejected: invalid filename"),
            ("a#b", "rejected: invalid filename"),
            ("a&b", "rejected: invalid filename"),
        ];
        for (filename, expected) in cases {
            assert_eq!(
                plan(&json!({"op": "view", "filename": filename})).unwrap_err(),
                expected,
                "{filename:?}"
            );
        }
        // Length is bounded at 260 characters, inclusive.
        assert!(plan(&json!({"op": "view", "filename": "x".repeat(260)})).is_ok());
        assert_eq!(
            plan(&json!({"op": "view", "filename": "x".repeat(261)})).unwrap_err(),
            "rejected: invalid filename"
        );
        // Non-string values are rejected, and only `''` is treated as absent.
        assert_eq!(
            plan(&json!({"op": "view", "filename": 5})).unwrap_err(),
            "rejected: invalid filename"
        );
        assert_eq!(
            plan(&json!({"op": "view", "filename": "a.png", "subfolder": 7})).unwrap_err(),
            "rejected: invalid subfolder"
        );
        assert_eq!(
            plan(&json!({"op": "view", "filename": ""})).unwrap_err(),
            "rejected: filename required"
        );
        assert_eq!(
            plan(&json!({"op": "view", "subfolder": "x"})).unwrap_err(),
            "rejected: filename required"
        );
        // type blank/absent is fine; anything outside the whitelist is not.
        assert_eq!(
            plan(&json!({"op": "view", "filename": "a.png", "type": ""}))
                .expect("blank type")
                .path,
            "/view?filename=a.png"
        );
        assert_eq!(
            plan(&json!({"op": "view", "filename": "a.png", "type": "Input"})).unwrap_err(),
            "rejected: invalid type"
        );
        for kind in COMFY_VIEW_TYPES {
            assert!(plan(&json!({"op": "view", "filename": "a.png", "type": kind})).is_ok());
        }
        // null behaves like undefined.
        assert_eq!(
            plan(&json!({"op": "view", "filename": "a.png", "subfolder": null}))
                .expect("null subfolder")
                .path,
            "/view?filename=a.png"
        );
    }

    #[test]
    fn view_query_is_form_encoded_in_upstream_field_order() {
        let plan = plan(&json!({
            "op": "view",
            "type": "output",
            "subfolder": "sub dir/2024",
            "filename": "ComfyUI_0001.png",
        }))
        .expect("view");
        assert_eq!(
            plan.path,
            "/view?filename=ComfyUI_0001.png&subfolder=sub+dir%2F2024&type=output"
        );
        assert_eq!(form_urlencode("a b"), "a+b");
        assert_eq!(form_urlencode("a/b"), "a%2Fb");
        assert_eq!(form_urlencode("Keep-_.*"), "Keep-_.*");
        assert_eq!(form_urlencode("é"), "%C3%A9");
    }

    #[test]
    fn json_results_carry_the_electron_status_and_wording() {
        let ok = json_result(&response(200, "application/json", br#"{"system":{"os":"nt"}}"#));
        assert_eq!(
            ok,
            json!({"ok": true, "status": 200, "data": {"system": {"os": "nt"}}})
        );

        let http_error = json_result(&response(500, "text/plain", b"boom"));
        assert_eq!(
            http_error,
            json!({"ok": false, "status": 500, "message": "comfy http 500"})
        );

        let invalid = json_result(&response(200, "application/json", b"not json"));
        assert_eq!(
            invalid,
            json!({"ok": false, "status": 200, "message": "comfy returned invalid json"})
        );

        // An empty body is invalid JSON upstream too (`JSON.parse('')` throws).
        assert_eq!(
            json_result(&response(204, "", b"")),
            json!({"ok": false, "status": 204, "message": "comfy returned invalid json"})
        );

        // A literal `null` document parses fine.
        assert_eq!(
            json_result(&response(200, "application/json", b"null")),
            json!({"ok": true, "status": 200, "data": null})
        );
    }

    #[test]
    fn view_results_are_bytes_plus_content_type() {
        let ok = view_result(&response(200, "image/png", &[0x89, b'P', b'N', b'G']));
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["status"], json!(200));
        assert_eq!(ok["contentType"], json!("image/png"));
        assert_eq!(ok["bytes"], json!([0x89, 80, 78, 71]));
        assert!(ok.get("data").is_none());

        assert_eq!(
            view_result(&response(404, "text/plain", b"missing")),
            json!({"ok": false, "status": 404, "message": "comfy http 404"})
        );
    }

    #[test]
    fn a_body_over_the_cap_fails_immediately_instead_of_being_truncated() {
        // Exactly the cap is allowed, one byte more is an error (upstream used
        // `size > COMFY_MAX_BODY_BYTES`, not `>=`).
        let exactly = vec![7u8; 1024];
        assert_eq!(
            read_capped(&mut exactly.as_slice(), 1024).expect("exactly the cap"),
            exactly
        );
        let over = vec![7u8; 1025];
        assert_eq!(
            read_capped(&mut over.as_slice(), 1024).unwrap_err(),
            RESPONSE_TOO_LARGE
        );
        // An endless reader stops at the cap instead of growing without bound;
        // the cap itself is the 64 MiB upstream documents.
        assert_eq!(COMFY_MAX_BODY_BYTES, 64 * 1024 * 1024);
        assert_eq!(
            read_capped(&mut std::io::repeat(1), 4096).unwrap_err(),
            RESPONSE_TOO_LARGE
        );
    }

    #[test]
    fn a_silent_peer_times_out_with_the_upstream_message() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(Duration::from_millis(2_000));
                drop(stream);
            }
        });
        let error = request(
            &format!("http://127.0.0.1:{port}"),
            "GET",
            "/system_stats",
            None,
            Duration::from_millis(150),
        )
        .err()
        .expect("timeout");
        assert_eq!(error, TIMEOUT);
        assert_eq!(
            unreachable(error),
            json!({"ok": false, "message": "comfy unreachable: comfy timeout"})
        );
    }

    #[test]
    fn an_unreachable_endpoint_reports_the_upstream_prefix() {
        // Bind then drop so the port is (almost certainly) closed: connect fails
        // immediately instead of waiting on a timeout.
        let port = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
            listener.local_addr().expect("addr").port()
        };
        let error = request(
            &format!("http://127.0.0.1:{port}"),
            "GET",
            "/system_stats",
            None,
            Duration::from_millis(500),
        )
        .err()
        .expect("unreachable");
        let reply = unreachable(error);
        assert_eq!(reply["ok"], json!(false));
        assert!(reply["message"]
            .as_str()
            .expect("message")
            .starts_with("comfy unreachable: "));
    }

    #[test]
    fn a_live_peer_is_read_with_its_status_and_content_type() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let body = br#"{"ok":1}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        let response = request(
            &format!("http://127.0.0.1:{port}"),
            "GET",
            "/system_stats",
            None,
            Duration::from_millis(2_000),
        )
        .expect("response");
        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        assert_eq!(response.buffer, br#"{"ok":1}"#);
    }
}
