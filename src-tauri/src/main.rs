#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};
use tauri::{Manager, WebviewWindow};
use url::Url;

mod comic;
mod comfy;
mod config;
mod config_script;
mod declarative;
mod mcp;
mod panel;
mod perf;
mod project;
mod sandbox;
mod window;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveRequest {
    default_name: String,
    title: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Default, Serialize)]
struct CommandReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl CommandReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }

    fn success() -> Self {
        Self {
            ok: true,
            ..Self::default()
        }
    }
}

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
            || (url.scheme() == "tauri"
                && url.host_str() == Some("localhost")
                && url.port().is_none())
    }
}

fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

fn safe_default_name(name: &str) -> &str {
    // A suggested name must never become a caller-controlled path.
    name.rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty() && *part != "." && *part != "..")
        .unwrap_or("artflow-export")
}

fn video_url(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("only HTTP(S) URLs without credentials are allowed");
    }
    Ok(url)
}

#[tauri::command]
async fn tauri_save_bytes(window: WebviewWindow, request: SaveRequest) -> CommandReply {
    if !authorized(&window) {
        return CommandReply::error("forbidden caller");
    }
    // ponytail: only a user-selected path is written; no general filesystem bridge.
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_parent(&window)
            .set_file_name(safe_default_name(&request.default_name));
        if let Some(title) = &request.title {
            dialog = dialog.set_title(title);
        }
        let Some(path) = dialog.save_file() else {
            return CommandReply::error("cancelled");
        };
        match fs::write(&path, &request.bytes) {
            Ok(()) => CommandReply {
                path: Some(path.to_string_lossy().into_owned()),
                ..CommandReply::success()
            },
            Err(error) => CommandReply::error(error),
        }
    })
    .await
    .unwrap_or_else(CommandReply::error)
}

#[tauri::command]
async fn tauri_open_artflow(window: WebviewWindow) -> CommandReply {
    if !authorized(&window) {
        return CommandReply::error("forbidden caller");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("Open Artflow")
            .add_filter("Artflow document", &["artflow"])
            .pick_file()
        else {
            return CommandReply::error("cancelled");
        };
        if !is_artflow(&path) {
            return CommandReply::error("only .artflow files are allowed");
        }
        match fs::read(&path) {
            Ok(bytes) => CommandReply {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned()),
                bytes: Some(bytes),
                ..CommandReply::success()
            },
            Err(error) => CommandReply::error(error),
        }
    })
    .await
    .unwrap_or_else(CommandReply::error)
}

fn is_artflow(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("artflow"))
}

#[tauri::command]
async fn tauri_open_video_link(window: WebviewWindow, url: String) -> CommandReply {
    if !authorized(&window) {
        return CommandReply::error("forbidden caller");
    }
    let url = match video_url(&url) {
        Ok(url) => url,
        Err(message) => return CommandReply::error(message),
    };
    tauri::async_runtime::spawn_blocking(move || match webbrowser::open(url.as_str()) {
        Ok(()) => CommandReply::success(),
        Err(error) => CommandReply::error(error),
    })
    .await
    .unwrap_or_else(CommandReply::error)
}

#[derive(Default, Serialize)]
struct PerfMetricsReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    metrics: Option<Vec<perf::PerfMetricEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[tauri::command]
async fn tauri_perf_metrics(window: WebviewWindow) -> PerfMetricsReply {
    if !authorized(&window) {
        return PerfMetricsReply {
            message: Some("forbidden caller".to_string()),
            ..PerfMetricsReply::default()
        };
    }
    // Sampling sleeps twice (CPU delta + counter settle); keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(perf::collect)
        .await
        .unwrap_or_else(|error| Err(format!("perf sampling failed: {error}")))
        .map_or_else(
            |message| PerfMetricsReply {
                message: Some(message),
                ..PerfMetricsReply::default()
            },
            |metrics| PerfMetricsReply {
                ok: true,
                metrics: Some(metrics),
                message: None,
            },
        )
}

fn main() {
    tauri::Builder::default()
        // Remote navigation is denied, not converted to an automatic external open.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("local-navigation")
                .on_navigation(|webview, url| webview.label() == "main" && trusted_url(url))
                .build(),
        )
        // 漫画档案仓是进程级状态（内容寻址落盘 + 中央目录/页字节 LRU），启动时建一次。
        // 主窗口也在这里代码创建：配置卷的读取是同步契约（config-volume.ts 在模块求值期
        // 调 readStore），而 Tauri 没有同步 IPC —— 只能把启动快照用 initialization_script
        // 在 HTML 解析前注入，这要求窗口由我们建而不是由 conf 自动建（conf 里 "create": false）。
        .setup(|app| {
            let vault = comic::init(app.handle())?;
            app.manage(vault);
            // Phase 2 托管状态：工程存储仓 + 沙箱插件注册表，均为进程级单例（与 comic 同模式）。
            // 沙箱资产库接线点（set_asset_storage）在二者就位后注入，使 sandbox 能回查 project 资产。
            let project = project::init(app.handle());
            app.manage(project.clone());
            let sandbox = sandbox::init(app.handle())?;
            sandbox.set_asset_storage(Arc::new(ProjectAssetAdapter {
                storage: project.clone(),
            }));
            app.manage(sandbox);
            let handle = app.handle().clone();
            let window_config = handle.config().app.windows[0].clone();
            let cache = config::startup_cache(&handle);
            tauri::WebviewWindowBuilder::from_config(&handle, &window_config)?
                .initialization_script(config_script::initialization_script(&cache))
                .build()?;
            Ok(())
        })
        // 窗口事件：状态翻转推送 + 每次 tao 重写扩展样式后重放 layered alpha。
        .on_window_event(|window, event| window::handle_window_event(window, event))
        .invoke_handler(tauri::generate_handler![
            tauri_save_bytes,
            tauri_open_artflow,
            tauri_open_video_link,
            tauri_perf_metrics,
            comic::tauri_comic_import,
            comic::tauri_comic_get_page,
            declarative::tauri_list_declarative_plugins,
            window::tauri_restart_app,
            window::tauri_set_always_on_top,
            window::tauri_set_window_opacity,
            window::tauri_set_window_background,
            window::tauri_set_ignore_mouse_events,
            window::tauri_window_control,
            window::tauri_get_window_state,
            window::tauri_window_platform,
            window::tauri_window_move,
            config::tauri_config_read,
            config::tauri_config_write,
            config::tauri_config_stats,
            config::tauri_config_presets,
            config::tauri_config_storage,
            config::tauri_config_boot_log,
            config::tauri_config_boot_error,
            project::tauri_storage_choose_project,
            project::tauri_storage_status,
            project::tauri_storage_import_asset,
            project::tauri_storage_request_import,
            project::tauri_storage_get_import_job,
            project::tauri_storage_list_import_jobs,
            project::tauri_storage_cancel_import_job,
            project::tauri_storage_save_project,
            project::tauri_storage_load_project,
            project::tauri_storage_list_recent_projects,
            project::tauri_storage_open_recent_project,
            project::tauri_storage_clear_recent_projects,
            project::tauri_storage_query_viewport,
            project::tauri_storage_list_asset_inventory,
            project::tauri_storage_reclaim_assets,
            project::tauri_storage_request_preview,
            project::tauri_storage_get_preview_job,
            project::tauri_storage_cancel_preview_job,
            project::tauri_open_plugin_dir,
            panel::tauri_open_panel_window,
            comfy::tauri_comfy_request,
            sandbox::tauri_list_sandboxed_plugins,
            sandbox::tauri_install_external_plugin,
            sandbox::tauri_install_external_plugin_from_path,
            sandbox::tauri_is_plugin_source_path,
            sandbox::tauri_uninstall_external_plugin,
            sandbox::tauri_invoke_sandboxed_plugin,
            sandbox::tauri_read_plugin_clients,
            sandbox::tauri_read_stored,
            sandbox::tauri_read_plugin_page,
            sandbox::tauri_sandbox_reply
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Artflow Tauri preview");
}

/// 适配器：把 `ProjectStorage` 的 `&Value` 资产接口桥接为 sandbox 宿主契约要求的
/// `AssetStorage` trait。两边签名不同（project 走 request 对象、sandbox 走 offset/limit/
/// unreferenced_only + 扁平 `Vec<Value>`），故在装配层做翻译，不污染任一 teammate 模块。
/// project 的 `listAssetInventory` 返回 `{ items: [...] }`，这里取 `items` 子数组满足 sandbox 的
/// 扁平遍历（scan_inventory 自带 offset/limit 分页，与 project 内部的 offset/limit 语义一致）。
struct ProjectAssetAdapter {
    storage: Arc<project::ProjectStorage>,
}

impl sandbox::AssetStorage for ProjectAssetAdapter {
    fn list_asset_inventory(
        &self,
        offset: usize,
        limit: usize,
        unreferenced_only: bool,
    ) -> sandbox::SandboxResult<Vec<Value>> {
        let request = json!({
            "offset": offset,
            "limit": limit,
            "unreferencedOnly": unreferenced_only,
        });
        let response = self
            .storage
            .list_asset_inventory(&request)
            .map_err(|error| sandbox::SandboxError::new(error.to_string()))?;
        let items = response
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items)
    }

    fn rename_asset_names(
        &self,
        changes: &[(String, String)],
    ) -> sandbox::SandboxResult<(Vec<String>, Vec<String>)> {
        let changes: Vec<Value> = changes
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect();
        let response = self
            .storage
            .rename_asset_names(&json!({ "changes": changes }))
            .map_err(|error| sandbox::SandboxError::new(error.to_string()))?;
        let renamed = response
            .get("renamed")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|value| value.as_str().map(|text| text.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let missing = response
            .get("missing")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|value| value.as_str().map(|text| text.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok((renamed, missing))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_are_web_only_and_credential_free() {
        assert!(video_url("https://example.com/watch?v=1").is_ok());
        assert!(video_url("http://example.com").is_ok());
        for value in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "data:text/html,hi",
            "https://user@example.com",
            "https://:secret@example.com",
            "not a url",
        ] {
            assert!(video_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn process_tree_is_classified_from_the_command_line() {
        let root = 1000;
        assert_eq!(perf::classify(root, root, ""), "Browser");
        assert_eq!(
            perf::classify(
                1001,
                root,
                "msedgewebview2.exe --type=gpu-process --user-data-dir=x"
            ),
            "GPU"
        );
        assert_eq!(
            perf::classify(
                1002,
                root,
                "msedgewebview2.exe --type=renderer --noerrdialogs"
            ),
            "Renderer"
        );
        assert_eq!(
            perf::classify(1003, root, "msedgewebview2.exe --type=utility --utility-sub-type=x"),
            "Utility"
        );
        // An unknown/absent marker must not be reported as a renderer or GPU.
        assert_eq!(perf::classify(1004, root, "artifact.exe --flag"), "Utility");
    }

    #[test]
    fn native_metrics_report_this_process_without_fabrication() {
        let metrics = perf::collect().expect("metrics");
        assert!(!metrics.is_empty());
        let root = std::process::id();
        let own = metrics
            .iter()
            .find(|entry| entry.pid == root)
            .expect("own process must be sampled");
        assert!(own.working_set_kb > 0);
        assert!(own.cpu_percent.is_finite() && own.cpu_percent >= 0.0);
        // Every sampled pid belongs to our own tree, never another app's WebView2.
        for entry in &metrics {
            assert!(["Browser", "GPU", "Renderer", "Utility"].contains(&entry.kind));
        }
    }

    #[test]
    fn cpu_usage_tracks_real_work_instead_of_reporting_zero() {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let burner = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                std::hint::black_box(std::time::Instant::now());
            }
        });

        let metrics = perf::collect().expect("metrics");
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        burner.join().expect("burner");

        let own = metrics
            .iter()
            .find(|entry| entry.pid == std::process::id())
            .expect("own process must be sampled");
        // A fully busy thread must show up as a measurable share of the machine.
        assert!(
            own.cpu_percent > 1.0,
            "expected real CPU usage while burning, got {}",
            own.cpu_percent
        );
    }

    #[test]
    fn native_file_scope_is_user_mediated() {
        assert_eq!(safe_default_name("C:\\private\\drawing.png"), "drawing.png");
        assert_eq!(
            safe_default_name("../../drawing.artflow"),
            "drawing.artflow"
        );
        assert_eq!(safe_default_name(""), "artflow-export");
        assert!(is_artflow(Path::new("drawing.ARTFLOW")));
        assert!(!is_artflow(Path::new("drawing.artflow.exe")));
    }

    #[test]
    fn caller_origin_is_not_an_arbitrary_remote_page() {
        let expected = if cfg!(feature = "custom-protocol") {
            "http://tauri.localhost/"
        } else {
            "http://localhost:4002/"
        };
        assert!(trusted_url(&Url::parse(expected).unwrap()));
        for value in [
            "https://example.com",
            "http://localhost:4003",
            "http://localhost:4002.evil.com",
            "http://user@localhost:4002",
            "file:///index.html",
        ] {
            if let Ok(url) = Url::parse(value) {
                assert!(!trusted_url(&url), "{value}");
            }
        }
    }
}
