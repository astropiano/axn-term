pub mod cli;
#[cfg(unix)]
pub mod control;
mod exec;
mod files;
mod git;
mod logfile;
mod persist;
mod procinfo;
mod pty;
mod remote;
mod window;

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_fs::FsExt;

use crate::pty::Session;
use tauri::ipc::{Channel, InvokeResponseBody};
#[cfg(unix)]
use std::sync::atomic::Ordering;

#[derive(Deserialize)]
pub(crate) struct LogPayload {
    level: LogLevel,
    target: String,
    message: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub(crate) fn to_level(self) -> log::Level {
        match self {
            LogLevel::Error => log::Level::Error,
            LogLevel::Warn => log::Level::Warn,
            LogLevel::Info => log::Level::Info,
            LogLevel::Debug => log::Level::Debug,
            LogLevel::Trace => log::Level::Trace,
        }
    }
}

pub(crate) struct AppState {
    pub(crate) sessions: Mutex<HashMap<String, Session>>,
    pub(crate) state_file_lock: Mutex<()>,
    pub(crate) window_counter: AtomicU64,
    /// Keep a bounded output tail per session — only read by the
    /// remote-control server, so only kept while it runs.
    pub(crate) capture_output: bool,
    /// Last remoteAuth snapshot the frontend reported — only read by the
    /// remote-control `GET /remote-auth` endpoint.
    pub(crate) remote_auth: Mutex<Option<String>>,
    /// Per-webview output channels (`attach_output`), keyed by label. Every
    /// window receives every session's output, as with a broadcast event.
    pub(crate) output_channels: OutputChannels,
}

pub(crate) type OutputChannels = Arc<Mutex<HashMap<String, OutputSink>>>;

/// A webview's output channel plus the bytes it has not acknowledged yet
/// (`ack_output`). Channel sends never block, so without this a flood
/// queues up in the IPC layer faster than the webview can take it.
pub(crate) struct OutputSink {
    pub(crate) channel: Channel<InvokeResponseBody>,
    pub(crate) unacked: usize,
}

/// Emitters wait while a webview has more than this unacknowledged.
pub(crate) const TRANSPORT_HIGH_WATERMARK: usize = 1024 * 1024;

impl AppState {
    pub(crate) fn new(capture_output: bool) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            state_file_lock: Mutex::new(()),
            window_counter: AtomicU64::new(0),
            capture_output,
            remote_auth: Mutex::new(None),
            output_channels: Arc::default(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, while the process is still single-threaded: it edits the env.
    let remote_control = remote::RemoteControl::from_env();

    // stderr + rotating file logger (level from LOG_LEVEL env, then
    // `logLevel` in config.yaml, else info; `set_log_level` changes it live).
    // Frontend "log" events are forwarded to it in setup(), so LOG_LEVEL
    // and the file cover the TypeScript side too.
    logfile::init();

    // Exits here when another instance serves this state dir.
    #[cfg(unix)]
    let control_listener = remote::claim_control_socket_or_exit();

    let builder = tauri::Builder::default()
        // Default menu, but "About axn-term" (macOS app menu) also shows the
        // build time: "Version 0.1.0 (built 2026-10-20 17:30 UTC)".
        .menu(|handle| {
            let menu = tauri::menu::Menu::default(handle)?;
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) =
                menu.items()?.into_iter().next()
            {
                let info = handle.package_info();
                let config = handle.config();
                let about = tauri::menu::PredefinedMenuItem::about(
                    handle,
                    None,
                    Some(tauri::menu::AboutMetadata {
                        name: Some(info.name.clone()),
                        // macOS shows "Version {short_version} ({version})".
                        short_version: Some(info.version.to_string()),
                        version: Some(format!("built {}", env!("AXN_BUILD_DATE"))),
                        copyright: config.bundle.copyright.clone(),
                        ..Default::default()
                    }),
                )?;
                app_menu.remove_at(0)?;
                app_menu.insert(&about, 0)?;
                let prefs = tauri::menu::MenuItem::with_id(
                    handle,
                    "axn-preferences",
                    "Preferences\u{2026}",
                    true,
                    Some("CmdOrCtrl+,"),
                )?;
                app_menu.insert(&prefs, 2)?;
                app_menu.insert(&tauri::menu::PredefinedMenuItem::separator(handle)?, 3)?;
            }
            #[cfg(target_os = "macos")]
            {
                // View menu — UI zoom (frontend listens for the "menu-zoom" event).
                use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};
                let view = Submenu::with_items(
                    handle,
                    "View",
                    true,
                    &[
                        &MenuItem::with_id(handle, "axn-zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?,
                        &MenuItem::with_id(handle, "axn-zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
                        &PredefinedMenuItem::separator(handle)?,
                        &MenuItem::with_id(handle, "axn-zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
                        &PredefinedMenuItem::separator(handle)?,
                        &MenuItem::with_id(handle, "axn-reload", "Reload", true, Some("CmdOrCtrl+Shift+R"))?,
                    ],
                )?;
                menu.append(&view)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            match event.id().0.as_str() {
                "axn-zoom-in" => {
                    let _ = app.emit("menu-zoom", "in");
                }
                "axn-zoom-out" => {
                    let _ = app.emit("menu-zoom", "out");
                }
                "axn-zoom-reset" => {
                    let _ = app.emit("menu-zoom", "reset");
                }
                "axn-reload" => {
                    let _ = app.emit("menu-reload", ());
                }
                "axn-preferences" => {
                    if let Some(w) = app.get_webview_window("settings") {
                        let _ = w.set_focus();
                    } else {
                        let _ = tauri::WebviewWindowBuilder::new(
                            app,
                            "settings",
                            tauri::WebviewUrl::App("index.html#axn-settings".into()),
                        )
                        .title("axn-term — Settings")
                        .inner_size(720.0, 780.0)
                        .build();
                    }
                }
                _ => {}
            }
        })
        // Every window type (main, w-*, tear-offs, settings): a closed
        // webview takes no more output.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                pty::detach_output(&window.state::<AppState>().output_channels, window.label());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new(remote_control.is_some()));
    #[cfg(unix)]
    let builder = builder.manage(Arc::new(control::ControlState::default()));
    builder
        .setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
            app.listen("log", |event| {
                if let Ok(p) = serde_json::from_str::<LogPayload>(event.payload()) {
                    log::log!(p.level.to_level(), "[{}] {}", p.target, p.message);
                }
            });
            if let Ok(dir) = persist::state_dir() {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    eprintln!("failed to create state dir {:?}: {}", dir, e);
                }
                // Recursive $HOME globs intentionally exclude hidden paths.
                // Grant only the bridge's own data and agent config paths.
                let scope = app.fs_scope();
                scope.allow_file(&dir)?;
                for agent in ["claude", "codex", "antigravity"] {
                    scope.allow_directory(dir.join(format!("{}-events", agent)), true)?;
                }
                let agent_home = std::env::var_os("AXN_TERM_AGENT_CONFIG_ROOT")
                    .map(PathBuf::from)
                    .or_else(dirs::home_dir);
                if let Some(home) = agent_home {
                    scope.allow_file(home.join(".axn-term"))?;
                    scope.allow_file(home.join(".axn-term/agent-hook.sh"))?;
                    scope.allow_file(home.join(".axn-term/agy-hook.sh"))?;
                    for (agent, file) in [("claude", "settings.json"), ("codex", "hooks.json")] {
                        scope.allow_file(home.join(format!(".{}", agent)))?;
                        scope.allow_file(home.join(format!(".{}/{}", agent, file)))?;
                    }
                    // Antigravity CLI hooks live in ~/.gemini/config/hooks.json.
                    scope.allow_file(home.join(".gemini"))?;
                    scope.allow_file(home.join(".gemini/config"))?;
                    scope.allow_file(home.join(".gemini/config/hooks.json"))?;
                }
            }
            let shell_state = persist::read_shell_state()
                .map(|l| l.state)
                .unwrap_or_else(|e| {
                    eprintln!("setup persist::read_shell_state error: {}", e);
                    persist::ShellState::default()
                });
            let handle = app.handle().clone();
            if shell_state.windows.is_empty() {
                let _ = window::create_window_internal(&handle, "main");
            } else {
                for w in shell_state.windows {
                    if let Some(label) = w.get("id").and_then(|v| v.as_str()) {
                        let _ = window::create_window_internal(&handle, label);
                    }
                }
            }
            // When the OS tears the session down (logout / restart /
            // shutdown), systemd and the session manager terminate apps with
            // SIGTERM. Turn it into an `os-shutdown` event so the frontend
            // can run its normal close path — collecting plugin session
            // state (e.g. the devin resume name) and saving — instead of
            // dying instantly or opening a confirm modal nobody will see.
            // A watchdog exits if the frontend never finishes, so shutdown
            // is never stalled.
            #[cfg(unix)]
            {
                use signal_hook::consts::signal::{SIGHUP, SIGTERM};
                use std::sync::atomic::AtomicBool;
                let stopping = Arc::new(AtomicBool::new(false));
                for sig in [SIGTERM, SIGHUP] {
                    signal_hook::flag::register(sig, stopping.clone())?;
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    while !stopping.load(Ordering::Acquire) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    log::info!("SIGTERM/SIGHUP received — emitting os-shutdown");
                    let _ = handle.emit("os-shutdown", ());
                    std::thread::sleep(Duration::from_secs(15));
                    log::warn!("shutdown watchdog: frontend never closed — exiting");
                    std::process::exit(0);
                });
            }
            #[cfg(unix)]
            if let Some(listener) = control_listener {
                remote::start_control_socket(app.handle().clone(), listener);
            }
            if let Some(rc) = remote_control {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = remote::start_remote_control_server(handle, rc) {
                        eprintln!("remote control server failed: {}", e);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::attach_output,
            pty::ack_output,
            remote::control_reply,
            files::allow_file_roots,
            pty::get_default_shell,
            pty::create_session,
            pty::write_session,
            #[cfg(unix)]
            pty::write_when_raw,
            pty::pause_session,
            pty::resume_session,
            pty::resize_session,
            procinfo::get_foreground_process,
            procinfo::current_exe_path,
            procinfo::get_session_cwd,
            procinfo::get_session_tty,
            procinfo::get_memory_stats,
            files::stat_path,
            files::open_directory,
            files::reveal_path,
            files::clipboard_write_text,
            files::clipboard_read_text,
            git::get_git_repo,
            exec::git_exec,
            pty::close_session,
            persist::load_window_state,
            persist::save_window_state,
            persist::delete_window_state,
            persist::read_plugins,
            persist::write_plugins,
            persist::read_config,
            persist::write_config,
            files::list_fonts,
            persist::kv_get,
            persist::kv_set,
            persist::list_external_plugins,
            persist::read_external_plugin,
            persist::list_external_plugin_dirs,
            persist::read_external_plugin_file,
            pty::create_subshell,
            pty::set_subshell_parent,
            exec::plugin_exec,
            window::create_window,
            files::save_dropped_file,
            persist::secure_get,
            remote::remote_auth_report,
            persist::secure_set,
            logfile::set_log_level,
            logfile::log_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // App-level quit (Cmd+Q, menu Quit, app.exit) arrives as
            // ExitRequested while the windows are still alive — Tauri does
            // not route it through per-window CloseRequested, so frontends
            // would never run their collect-and-close path (plugin onClose,
            // resume-hint capture, final state save). Intercept while
            // windows remain and turn it into the same `os-shutdown` event
            // the SIGTERM path uses; every window then flushes state and
            // destroys itself, and the resulting last-window-closed
            // ExitRequested (windows empty) is allowed to proceed.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let windows = app_handle.webview_windows().len();
                log::info!("ExitRequested (code={:?}, windows={})", code, windows);
                if windows > 0 {
                    api.prevent_exit();
                    let _ = app_handle.emit("os-shutdown", ());
                    // Watchdog: a hung frontend must not stall the quit —
                    // same 15 s budget the SIGTERM/SIGHUP path uses.
                    let code = code.unwrap_or(0);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(15));
                        log::warn!("exit watchdog: windows never closed — exiting");
                        std::process::exit(code);
                    });
                } else {
                    log::info!("last window closed — exiting");
                }
            }
        });
}
