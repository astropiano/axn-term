//! axn-term-hmr — a dev-tooling variant of the app: the same Rust backend
//! and PTY stack, but session windows load a vite dev server spawned in a
//! user-picked checkout (repo or worktree), so frontend changes hot-reload
//! inside the real app without rebuilding it.
//!
//! Enabled when the binary is named `axn-term-hmr` (the bundled dev product,
//! `tauri build -c tauri.term-hmr.conf.json`) or `AXN_TERM_HMR=1` is set — the
//! env flag is how a plain `pnpm dev:desktop` run exercises the same code.
//! In dev mode `state_dir()` is `~/.axn-term-hmr` and window state is kept
//! in memory only (persist.rs), so nothing the dev app does touches the
//! real app's state.json — yet a page reload still finds its state.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use crate::persist;

const LOG_CAP: usize = 400;

/// True for the axn-term-hmr product and for `AXN_TERM_HMR=1` runs.
pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        if std::env::var_os("AXN_TERM_HMR").is_some() {
            return true;
        }
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .map(|stem| stem == "axn-term-hmr")
            .unwrap_or(false)
    })
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ViteStatus {
    #[default]
    Idle,
    Installing,
    Starting,
    Running,
    Exited,
}

#[derive(Default)]
pub(crate) struct DevHmrState {
    /// vite child process and its output ring buffer.
    child: Mutex<Option<Child>>,
    log: Mutex<VecDeque<String>>,
    status: Mutex<ViteStatus>,
    /// Error text for the settings page (spawn/readiness failures).
    error: Mutex<Option<String>>,
    /// The port our running vite serves on — the external webview origin.
    /// `None` until vite is ready and again once it exits.
    port: Mutex<Option<u16>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevHmrStatus {
    enabled: bool,
    repo: Option<String>,
    vite: ViteStatus,
    port: Option<u16>,
    error: Option<String>,
    log: Vec<String>,
}

fn config_file() -> Result<PathBuf, String> {
    Ok(persist::state_dir()?.join("dev-hmr.json"))
}

pub(crate) fn configured_repo() -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_file().ok()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let repo = v.get("repo")?.as_str()?;
    let path = PathBuf::from(repo);
    path.is_dir().then_some(path)
}

fn write_config(repo: Option<&Path>) -> Result<(), String> {
    let dir = persist::state_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::json!({ "repo": repo });
    persist::atomic_write(&config_file()?, json.to_string().as_bytes())
}

fn push_log(state: &DevHmrState, line: String) {
    let mut log = state.log.lock().unwrap();
    if log.len() >= LOG_CAP {
        log.pop_front();
    }
    log.push_back(line);
}

fn set_status(app: &AppHandle, state: &DevHmrState, vite: ViteStatus, error: Option<String>) {
    *state.status.lock().unwrap() = vite;
    *state.error.lock().unwrap() = error;
    emit_status(app, state);
}

fn emit_status(app: &AppHandle, state: &DevHmrState) {
    let payload = status_of(app, state);
    let _ = app.emit("dev-hmr-status", payload);
}

fn status_of(app: &AppHandle, state: &DevHmrState) -> DevHmrStatus {
    let _ = app;
    DevHmrStatus {
        enabled: true,
        repo: configured_repo().map(|p| p.to_string_lossy().into_owned()),
        vite: *state.status.lock().unwrap(),
        port: *state.port.lock().unwrap(),
        error: state.error.lock().unwrap().clone(),
        log: state.log.lock().unwrap().iter().cloned().collect(),
    }
}

/// `pnpm` — plain PATH first, then a login shell (Finder-launched apps get
/// a minimal PATH), then the usual install locations.
fn resolve_pnpm() -> Option<String> {
    static PNPM: OnceLock<Option<String>> = OnceLock::new();
    PNPM
        .get_or_init(|| {
            if Command::new("pnpm")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Some("pnpm".to_string());
            }
            #[cfg(unix)]
            for shell in ["/bin/zsh", "/bin/bash"] {
                if let Ok(out) = Command::new(shell)
                    .args(["-lic", "command -v pnpm"])
                    .output()
                {
                    if out.status.success() {
                        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !p.is_empty() {
                            return Some(p);
                        }
                    }
                }
            }
            if let Some(home) = dirs::home_dir() {
                for p in [
                    home.join(".local/share/pnpm/pnpm"),
                    PathBuf::from("/opt/homebrew/bin/pnpm"),
                    PathBuf::from("/usr/local/bin/pnpm"),
                ] {
                    if p.is_file() {
                        return Some(p.to_string_lossy().into_owned());
                    }
                }
            }
            None
        })
        .clone()
}

/// The vite dev server's port — FIXED, not picked at spawn: the IPC ACL
/// (`frontendDist` in tauri.term-hmr.conf.json, `remote.urls` in
/// capabilities/dev-hmr.json) is declared at build time and must name the
/// exact origin, so a dynamically assigned port would never match.
/// `--strictPort` fails loudly when it is taken — the log shows it.
pub(crate) const AXN_HMR_PORT: u16 = 5914;

/// The host vite binds (`--host`) and windows load — the literal loopback
/// address, never `localhost`: that name may resolve to `::1` first, where
/// vite is not listening and any other local process could be.
pub(crate) const AXN_HMR_HOST: &str = "127.0.0.1";

/// `'…'` quoting for the login-shell spawn.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run `command` inside a login shell in `dir` — a GUI app's own PATH is
/// minimal (`env: node: No such file or directory` for the pnpm shebang),
/// so toolchains living in nvm/volta/homebrew only resolve through the
/// user's shell startup files.
#[cfg(unix)]
fn login_shell_command(dir: &Path, command: &str) -> Command {
    let mut c = Command::new("/bin/zsh");
    c.args(["-lic", command]).current_dir(dir);
    c
}

#[cfg(not(unix))]
fn login_shell_command(dir: &Path, command: &str) -> Command {
    let mut c = Command::new("cmd");
    c.args(["/C", command]).current_dir(dir);
    c
}

/// Spawn as the leader of a new session (and so process group): the vite
/// server runs as a grandchild (zsh → pnpm → node), and killing only the
/// wrapper left it holding the port. `setsid` rather than a bare process
/// group: the interactive login shell must not find a controlling terminal
/// (an app started from a terminal) and stop itself on SIGTTIN.
#[cfg(unix)]
fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe and touches no parent state.
    unsafe {
        cmd.pre_exec(|| nix::unistd::setsid().map(|_| ()).map_err(std::io::Error::from));
    }
}

#[cfg(not(unix))]
fn own_process_group(_cmd: &mut Command) {}

/// Kill `child` and everything in its process group, then reap it. The
/// child is still unreaped while the group is signalled, so its pid (the
/// group id) cannot have been reused.
fn kill_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn vite_dir(repo: &Path) -> PathBuf {
    repo.join("apps/desktop")
}

/// The origin session windows load in dev mode — set once vite announced
/// itself on its port and cleared when it exits, so no window is pointed at
/// a port some other process holds.
pub(crate) fn vite_origin(state: &DevHmrState) -> Option<tauri::Url> {
    let port = (*state.port.lock().unwrap())?;
    tauri::Url::parse(&format!("http://{AXN_HMR_HOST}:{port}")).ok()
}

/// Spawn `pnpm exec vite --port N --strictPort` in `<repo>/apps/desktop`,
/// piping output into the log ring. Marks the state Running when vite
/// announces itself, then opens the main window.
pub(crate) fn start_vite(app: AppHandle, state: &DevHmrState) -> Result<(), String> {
    let repo = configured_repo().ok_or("no checkout configured")?;
    if !vite_dir(&repo).join("package.json").is_file() {
        return Err(format!(
            "{} does not look like an axn-term checkout (apps/desktop missing)",
            repo.display()
        ));
    }
    let pnpm = resolve_pnpm().ok_or(
        "pnpm not found — install it or ensure it is resolvable from a login shell",
    )?;
    let port = AXN_HMR_PORT;

    stop_vite(state);
    set_status(&app, state, ViteStatus::Starting, None);
    push_log(state, format!("$ pnpm exec vite --port {port} --strictPort ({})", repo.display()));

    let mut command = login_shell_command(
        &repo,
        &format!(
            "{} --dir {} exec vite --host {} --port {} --strictPort",
            shq(&pnpm),
            shq(&vite_dir(&repo).to_string_lossy()),
            AXN_HMR_HOST,
            port
        ),
    );
    own_process_group(&mut command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| {
            set_status(&app, state, ViteStatus::Exited, Some(e.to_string()));
            format!("failed to spawn vite: {e}")
        })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(child);

    let streams: Vec<Box<dyn std::io::Read + Send>> = [
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    for stream in streams {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if line.contains("ready in") || line.contains("Local:") {
                    let state = app.state::<DevHmrState>();
                    if *state.status.lock().unwrap() == ViteStatus::Starting {
                        // Only now is the port known to be OUR vite — a
                        // squatter makes `--strictPort` exit before this line.
                        *state.port.lock().unwrap() = Some(port);
                        set_status(&app, &state, ViteStatus::Running, None);
                        open_main_window(&app);
                    }
                }
                let state = app.state::<DevHmrState>();
                push_log(&state, line);
                emit_status(&app, &state);
            }
        });
    }

    // Exit watcher.
    let app2 = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let state = app2.state::<DevHmrState>();
            let done = {
                let mut guard = state.child.lock().unwrap();
                let exited = match guard.as_mut() {
                    Some(c) => c.try_wait().ok().flatten().is_some(),
                    None => true, // stop_vite took it (and cleared the port)
                };
                if exited && guard.take().is_some() {
                    // vite is gone: forget its origin under the same lock, so
                    // no window is pointed at whatever binds the port next.
                    *state.port.lock().unwrap() = None;
                }
                exited
            };
            if done {
                if *state.status.lock().unwrap() != ViteStatus::Idle {
                    set_status(&app2, &state, ViteStatus::Exited, None);
                }
                break;
            }
        }
    });
    Ok(())
}

pub(crate) fn stop_vite(state: &DevHmrState) {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        kill_process_group(&mut child);
    }
    *state.status.lock().unwrap() = ViteStatus::Idle;
    *state.port.lock().unwrap() = None;
}

/// `pnpm install` in the configured checkout — logged into the ring.
fn install_deps(app: AppHandle, state: &DevHmrState) -> Result<(), String> {
    let repo = configured_repo().ok_or("no checkout configured")?;
    let pnpm = resolve_pnpm().ok_or("pnpm not found")?;
    stop_vite(state);
    set_status(&app, state, ViteStatus::Installing, None);
    std::thread::spawn(move || {
        {
            let state = app.state::<DevHmrState>();
            push_log(&state, format!("$ pnpm install ({})", repo.display()));
        }
        let out = login_shell_command(
            &repo,
            &format!("{} --dir {} install", shq(&pnpm), shq(&repo.to_string_lossy())),
        )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let state = app.state::<DevHmrState>();
        match out {
            Ok(o) => {
                push_log(&state, String::from_utf8_lossy(&o.stdout).to_string());
                push_log(&state, String::from_utf8_lossy(&o.stderr).to_string());
                if o.status.success() {
                    set_status(&app, &state, ViteStatus::Idle, None);
                } else {
                    set_status(&app, &state, ViteStatus::Exited, Some(format!("pnpm install exited {}", o.status)));
                }
            }
            Err(e) => set_status(&app, &state, ViteStatus::Exited, Some(e.to_string())),
        }
    });
    Ok(())
}

/// The main session window at the vite origin (or a hint when vite is not
/// running yet — the settings window explains it).
fn open_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
        return;
    }
    let _ = crate::window::create_window_internal(app, "main");
}

/// The dev-settings page, served over the `axn` custom protocol. With
/// `frontendDist` pointed at the vite origin, the app bundles no frontend —
/// so the control page is embedded in the binary and always loads, vite or
/// no vite, on any worktree. Custom protocols count as `is_local`, so IPC
/// needs no remote-capability grant.
pub(crate) fn axn_protocol(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    _req: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<&'static [u8]> {
    tauri::http::Response::builder()
        .header("content-type", "text/html; charset=utf-8")
        .body(include_str!("dev_settings.html").as_bytes())
        .unwrap()
}

pub(crate) fn open_dev_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("dev-settings") {
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "dev-settings",
        WebviewUrl::CustomProtocol("axn://localhost/dev-settings".parse().unwrap()),
    )
    .title("axn-term-hmr")
    .inner_size(640.0, 560.0)
    .build();
}

/// Startup path for the dev product: settings window always; vite + main
/// window when a checkout is already configured.
pub(crate) fn setup(app: &AppHandle) {
    open_dev_settings(app);
    if configured_repo().is_some() {
        let state = app.state::<DevHmrState>();
        if let Err(e) = start_vite(app.clone(), &state) {
            set_status(app, &state, ViteStatus::Exited, Some(e));
        }
    }
}

/// `DevHmrState` is only managed in HMR mode, but the `dev_hmr_*` commands
/// are registered in every build — so a release build gets an error, not a
/// panic, when something invokes them.
fn hmr_state<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, DevHmrState>, String> {
    app.try_state::<DevHmrState>()
        .ok_or_else(|| "dev HMR mode is not enabled".to_string())
}

#[tauri::command]
pub(crate) fn dev_hmr_status(app: AppHandle) -> Result<DevHmrStatus, String> {
    let state = hmr_state(&app)?;
    Ok(status_of(&app, &state))
}

#[tauri::command]
pub(crate) fn dev_hmr_set_repo(app: AppHandle, repo: Option<String>) -> Result<(), String> {
    // Check the mode before writing, so a non-HMR build never touches the config.
    let state = hmr_state(&app)?;
    let path = repo.map(PathBuf::from).filter(|p| p.is_dir());
    write_config(path.as_deref())?;
    emit_status(&app, &state);
    Ok(())
}

#[tauri::command]
pub(crate) fn dev_hmr_start(app: AppHandle) -> Result<(), String> {
    let state = hmr_state(&app)?;
    start_vite(app.clone(), &state)
}

#[tauri::command]
pub(crate) fn dev_hmr_stop(app: AppHandle) -> Result<(), String> {
    let state = hmr_state(&app)?;
    stop_vite(&state);
    emit_status(&app, &state);
    Ok(())
}

#[tauri::command]
pub(crate) fn dev_hmr_install(app: AppHandle) -> Result<(), String> {
    let state = hmr_state(&app)?;
    install_deps(app.clone(), &state)
}

#[tauri::command]
pub(crate) fn dev_hmr_open_main(app: AppHandle) -> Result<(), String> {
    open_main_window(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmr_state_errors_instead_of_panicking_when_not_managed() {
        let app = tauri::test::mock_app();
        assert_eq!(hmr_state(app.handle()).err().as_deref(), Some("dev HMR mode is not enabled"));
        app.manage(DevHmrState::default());
        assert!(hmr_state(app.handle()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn stopping_kills_the_grandchild_too() {
        use std::time::{Duration, Instant};
        // Same shape as vite: a wrapper whose grandchild does the work.
        let pidfile = std::env::temp_dir().join(format!("axn-devhmr-test-{}", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let mut command = Command::new("sh");
        command.args(["-c", &format!("sh -c 'echo $$ > {}; exec sleep 100' & wait", pidfile.display())]);
        own_process_group(&mut command);
        let mut child = command.spawn().unwrap();

        let started = Instant::now();
        let grandchild = loop {
            if let Some(pid) = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
                break nix::unistd::Pid::from_raw(pid);
            }
            assert!(started.elapsed() < Duration::from_secs(5), "grandchild never started");
            std::thread::sleep(Duration::from_millis(20));
        };

        kill_process_group(&mut child);

        let started = Instant::now();
        // The grandchild is reparented to init (or a subreaper), which reaps
        // it; signal 0 then fails with ESRCH.
        while nix::sys::signal::kill(grandchild, None).is_ok() {
            assert!(started.elapsed() < Duration::from_secs(5), "grandchild survived the stop");
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&pidfile);
    }
}
