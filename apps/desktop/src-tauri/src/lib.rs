mod announce;
pub mod cli;
#[cfg(unix)]
pub mod control;
mod devhmr;
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
    /// axn-term-hmr only: the window state that normally lives in
    /// `~/.axn-term/state.json` — in-memory so the dev app never touches
    /// the real app's state (a page reload still finds it).
    pub(crate) mem_shell_state: Mutex<persist::ShellState>,
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
            mem_shell_state: Mutex::new(persist::ShellState::default()),
        }
    }
}

/// The app menu.
///
/// macOS uses Tauri's default menu set with a customized "About axn-term"
/// (it also shows the build time: "Version 0.1.0 (built 2026-10-20 17:30
/// UTC)"), Preferences… in the app menu, and an added View submenu.
///
/// Linux/Windows get a small custom menu instead — the stock default only
/// wires About (every other predefined item does nothing) and its Edit
/// accelerators (Ctrl+C/X/V/A, Ctrl+Z/Y, Ctrl+M) would be swallowed before
/// the PTY ever sees them. The bar starts hidden on every window
/// (window.rs); tapping Alt toggles it Thunderbird-style (toggle_menu)
/// and picking an item hides it again (on_menu_event). Accelerators stay
/// live while the bar is hidden.
fn app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let info = handle.package_info();
    let config = handle.config();
    // View menu — UI zoom (frontend listens for the "menu-zoom" event).
    let zoom_in = MenuItem::with_id(handle, "axn-zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "axn-zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_sep1 = PredefinedMenuItem::separator(handle)?;
    let zoom_reset =
        MenuItem::with_id(handle, "axn-zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let zoom_sep2 = PredefinedMenuItem::separator(handle)?;
    let reload = MenuItem::with_id(handle, "axn-reload", "Reload", true, Some("CmdOrCtrl+Shift+R"))?;
    let zoom_items: [&dyn IsMenuItem<tauri::Wry>; 6] =
        [&zoom_in, &zoom_out, &zoom_sep1, &zoom_reset, &zoom_sep2, &reload];
    #[cfg(target_os = "macos")]
    {
        let menu = Menu::default(handle)?;
        if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) =
            menu.items()?.into_iter().next()
        {
            let about = PredefinedMenuItem::about(
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
            let prefs = MenuItem::with_id(
                handle,
                "axn-preferences",
                "Preferences\u{2026}",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            app_menu.insert(&prefs, 2)?;
            app_menu.insert(&PredefinedMenuItem::separator(handle)?, 3)?;
        }
        // View menu — UI zoom (frontend listens for the "menu-zoom" event).
        menu.append(&Submenu::with_items(handle, "View", true, &zoom_items)?)?;
        Ok(menu)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let about = PredefinedMenuItem::about(
            handle,
            Some(&format!("About {}", info.name)),
            Some(tauri::menu::AboutMetadata {
                name: Some(info.name.clone()),
                version: Some(format!("{} (built {})", info.version, env!("AXN_BUILD_DATE"))),
                copyright: config.bundle.copyright.clone(),
                ..Default::default()
            }),
        )?;
        // Quit is a custom item: the predefined one binds Ctrl+Q on
        // accelerators-capable platforms, which terminals need for XON.
        let file = Submenu::with_items(
            handle,
            "&File",
            true,
            &[
                &MenuItem::with_id(
                    handle,
                    "axn-preferences",
                    "Preferences\u{2026}",
                    true,
                    Some("CmdOrCtrl+,"),
                )?,
                &PredefinedMenuItem::separator(handle)?,
                &MenuItem::with_id(handle, "axn-quit", "Quit", true, None::<&str>)?,
            ],
        )?;
        let view = Submenu::with_items(handle, "&View", true, &zoom_items)?;
        let help = Submenu::with_items(handle, "&Help", true, &[&about])?;
        Menu::with_items(handle, &[&file, &view, &help])
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
        .menu(|handle| app_menu(handle))
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
                    // One way to settings: the in-app dialog of a shell
                    // window — the one the rail's gear opens. The focused
                    // shell window toggles it ("menu-settings", targeted at
                    // that window only); see window::settings_target for
                    // the choice when none is focused. The standalone
                    // settings window below stays as the fallback for when
                    // no shell window is open.
                    let open: Vec<(String, bool)> = app
                        .webview_windows()
                        .iter()
                        .map(|(label, w)| (label.clone(), w.is_focused().unwrap_or(false)))
                        .collect();
                    let target = window::settings_target(
                        open.iter().map(|(label, focused)| (label.as_str(), *focused)),
                    )
                    .map(str::to_owned);
                    if let Some(label) = target {
                        if let Some(w) = app.get_webview_window(&label) {
                            let _ = w.set_focus();
                        }
                        let _ = app.emit_to(label.as_str(), "menu-settings", ());
                    } else if let Some(w) = app.get_webview_window("settings") {
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
                "axn-quit" => {
                    app.exit(0);
                }
                _ => {}
            }
            // Auto-hide the Alt-revealed menu bar once an item was picked
            // (Thunderbird-style — it is only up because Alt showed it).
            // Also covers a just-created settings window.
            #[cfg(not(target_os = "macos"))]
            for window in app.webview_windows().values() {
                let _ = window.hide_menu();
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
    let builder = if devhmr::enabled() {
        builder
            .register_uri_scheme_protocol("axn", devhmr::axn_protocol)
            .manage(devhmr::DevHmrState::default())
    } else {
        builder
    };
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
            let handle = app.handle().clone();
            if devhmr::enabled() {
                // axn-term-hmr: no persisted windows to restore — the dev
                // settings window opens always, the main window follows
                // once the checkout's vite server is up.
                devhmr::setup(&handle);
            } else {
                let shell_state = persist::read_shell_state()
                    .map(|l| l.state)
                    .unwrap_or_else(|e| {
                        eprintln!("setup persist::read_shell_state error: {}", e);
                        persist::ShellState::default()
                    });
                if shell_state.windows.is_empty() {
                    let _ = window::create_window_internal(&handle, "main");
                } else {
                    for w in shell_state.windows {
                        if let Some(label) = w.get("id").and_then(|v| v.as_str()) {
                            let _ = window::create_window_internal(&handle, label);
                        }
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
                    pty::kill_all_sessions(&handle.state::<AppState>());
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
            window::allow_frame_origin,
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
            files::fs_read_text,
            files::fs_read_bytes,
            files::fs_read_dir,
            files::fs_exists,
            files::open_directory,
            files::reveal_path,
            files::clipboard_write_text,
            files::clipboard_write_image,
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
            persist::list_user_themes,
            persist::read_external_plugin_file,
            pty::create_subshell,
            pty::set_subshell_parent,
            exec::plugin_exec,
            window::create_window,
            window::toggle_menu,
            window::set_titlebar_color,
            files::save_dropped_file,
            persist::secure_get,
            remote::remote_auth_report,
            remote::remote_fetch,
            announce::remote_announce,
            persist::secure_set,
            logfile::set_log_level,
            logfile::log_dir,
            devhmr::dev_hmr_status,
            devhmr::dev_hmr_set_repo,
            devhmr::dev_hmr_set_real_state,
            devhmr::dev_hmr_start,
            devhmr::dev_hmr_stop,
            devhmr::dev_hmr_install,
            devhmr::dev_hmr_open_main,
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
            if let tauri::RunEvent::ExitRequested { ref api, code, .. } = event {
                let windows = app_handle.webview_windows().len();
                log::info!("ExitRequested (code={:?}, windows={})", code, windows);
                if windows > 0 {
                    api.prevent_exit();
                    let _ = app_handle.emit("os-shutdown", ());
                    // Watchdog: a hung frontend must not stall the quit —
                    // same 15 s budget the SIGTERM/SIGHUP path uses.
                    let code = code.unwrap_or(0);
                    let app = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(15));
                        log::warn!("exit watchdog: windows never closed — exiting");
                        pty::kill_all_sessions(&app.state::<AppState>());
                        std::process::exit(code);
                    });
                } else {
                    log::info!("last window closed — exiting");
                }
            }
            // The event loop is done — the process exits next. No PTY or
            // spawned helper (the axn-term-hmr vite server) may outlive it:
            // a webview destroyed without React teardown never released its
            // sessions, and process::exit skips every destructor.
            if let tauri::RunEvent::Exit = event {
                pty::kill_all_sessions(&app_handle.state::<AppState>());
                if let Some(state) = app_handle.try_state::<devhmr::DevHmrState>() {
                    devhmr::stop_vite(&state);
                }
            }
        });
}
