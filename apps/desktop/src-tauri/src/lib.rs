pub mod cli;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewUrl, Wry};
use tauri_plugin_fs::FsExt;

#[derive(Deserialize)]
struct LogPayload {
    level: LogLevel,
    target: String,
    message: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    fn to_level(self) -> log::Level {
        match self {
            LogLevel::Error => log::Level::Error,
            LogLevel::Warn => log::Level::Warn,
            LogLevel::Info => log::Level::Info,
            LogLevel::Debug => log::Level::Debug,
            LogLevel::Trace => log::Level::Trace,
        }
    }
}

struct AppState {
    sessions: Mutex<HashMap<String, Session>>,
    state_file_lock: Mutex<()>,
    window_counter: AtomicU64,
    /// Keep a bounded output tail per session — only read by the
    /// remote-control server, so only kept while it runs.
    capture_output: bool,
}

impl AppState {
    fn new(capture_output: bool) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            state_file_lock: Mutex::new(()),
            window_counter: AtomicU64::new(0),
            capture_output,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ShellState {
    windows: Vec<JsonValue>,
}

fn state_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("AXN_TERM_STATE_DIR") {
        let path = PathBuf::from(override_dir);
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let home = dirs::home_dir().ok_or("could not determine home directory".to_string())?;
    Ok(home.join(".axn-term"))
}

fn state_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("state.json"))
}

fn backup_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("state.json.bak"))
}

fn failed_state_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("state.json.failed"))
}

fn legacy_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("sessions.json"))
}

fn plugins_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("plugins.yaml"))
}

fn config_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("config.yaml"))
}

#[derive(Default)]
struct LoadedShellState {
    state: ShellState,
    /// state.json was unreadable and the last-good backup was loaded instead.
    restored_from_backup: bool,
    /// Name of the file the failed state was preserved as, for diagnosis.
    failed_file: Option<String>,
    /// The state came from a parseable state.json — the next save may rotate
    /// it into the backup without parsing it again.
    current_valid: bool,
}

fn read_shell_state() -> Result<LoadedShellState, String> {
    let path = state_file()?;
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(state) => return Ok(LoadedShellState {
                    state,
                    current_valid: true,
                    ..Default::default()
                }),
                Err(e) => eprintln!("state.json is corrupt ({}), trying backup", e),
            },
            Err(e) => eprintln!("failed to read state.json ({}), trying backup", e),
        }

        // Preserve the failed file as state.json.failed so the user can
        // inspect what could not be loaded, then fall back to the backup of
        // the last successfully written state.
        let failed = failed_state_file()?;
        if let Err(e) = std::fs::rename(&path, &failed) {
            eprintln!("could not preserve failed state.json as {:?}: {}", failed, e);
        }
        let backup = backup_file()?;
        if backup.exists() {
            match std::fs::read_to_string(&backup) {
                Ok(raw) => match serde_json::from_str(&raw) {
                    Ok(state) => {
                        eprintln!("restored state from backup state.json.bak");
                        return Ok(LoadedShellState {
                            state,
                            restored_from_backup: true,
                            failed_file: Some("state.json.failed".to_string()),
                            current_valid: false,
                        });
                    }
                    Err(e) => eprintln!("state.json.bak is corrupt: {}", e),
                },
                Err(e) => eprintln!("failed to read state.json.bak: {}", e),
            }
        }
    }

    let legacy = legacy_file()?;
    if legacy.exists() {
        match std::fs::read_to_string(&legacy) {
            Ok(raw) => match serde_json::from_str::<JsonValue>(&raw) {
                Ok(mut value) => {
                    let mut window = serde_json::json!({
                        "id": "main",
                        "name": "main",
                    });
                    if let Some(obj) = value.as_object_mut() {
                        for key in ["workspaces", "sessions", "selectedWorkspaceId", "selectedSessionId"] {
                            if let Some(v) = obj.remove(key) {
                                if let Some(w) = window.as_object_mut() {
                                    w.insert(key.to_string(), v);
                                }
                            }
                        }
                    }
                    return Ok(LoadedShellState {
                        state: ShellState { windows: vec![window] },
                        ..Default::default()
                    });
                }
                Err(e) => eprintln!("legacy sessions.json is corrupt: {}", e),
            },
            Err(e) => eprintln!("failed to read legacy sessions.json: {}", e),
        }
    }

    Ok(LoadedShellState::default())
}

/// `<path><suffix>` — sibling temp/backup names (`state.json.tmp`).
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Create/truncate `path`, write `contents` and fsync it.
fn write_synced(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

/// fsync `path`'s directory so a rename into it survives a crash. Best
/// effort: not every platform/filesystem supports syncing a directory.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(dir) = std::fs::File::open(dir) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Replace `path` with `contents` atomically: write and fsync
/// `<path>.tmp`, rename it over `path`, fsync the directory. A crash or
/// failed write leaves the previous file intact — readers (the ~1.5 s
/// config/plugins watchers, kv_get) never see a half-written file.
fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let tmp = with_suffix(path, ".tmp");
    write_synced(&tmp, contents)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("failed to write {}: {}", path.display(), e)
        })?;
    sync_parent_dir(path);
    Ok(())
}

/// Atomically point `backup` at the current contents of `current`: a hard
/// link (no copy of a multi-MB state file; the inode stays with the backup
/// once `current` is replaced by rename) or, where links are unsupported, a
/// synced copy — staged as `<backup>.tmp` and renamed into place so the
/// backup is never half-written.
fn rotate_backup(current: &Path, backup: &Path) -> std::io::Result<()> {
    let tmp = with_suffix(backup, ".tmp");
    let _ = std::fs::remove_file(&tmp);
    if std::fs::hard_link(current, &tmp).is_err() {
        std::fs::copy(current, &tmp)?;
        std::fs::File::open(&tmp)?.sync_all()?;
    }
    std::fs::rename(&tmp, backup)
}

/// Persist shell_state durably: write and fsync state.json.tmp, rotate the
/// current state.json into state.json.bak (the last known-good backup),
/// rename the temp file into place and fsync the directory. A failure
/// before the rename leaves both state.json and the backup untouched, so
/// the previous good state always survives a failed save.
///
/// `current_valid` says state.json was just parsed successfully (see
/// `LoadedShellState::current_valid`); otherwise it is parsed here — only a
/// still-valid state.json is rotated, never poisoning the backup with a
/// corrupt file.
fn write_shell_state(shell_state: &ShellState, current_valid: bool) -> Result<(), String> {
    let path = state_file()?;
    let json = serde_json::to_string_pretty(shell_state).map_err(|e| e.to_string())?;
    let tmp = with_suffix(&path, ".tmp");
    write_synced(&tmp, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    let still_valid = current_valid
        || std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ShellState>(&raw).ok())
            .is_some();
    if still_valid && path.exists() {
        let backup = backup_file()?;
        if let Err(e) = rotate_backup(&path, &backup) {
            eprintln!("could not rotate state backup {:?}: {}", backup, e);
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        format!("failed to rename {} -> {}: {}", tmp.display(), path.display(), e)
    })?;
    sync_parent_dir(&path);
    Ok(())
}

fn next_window_id(counter: &AtomicU64, is_used: impl Fn(&str) -> bool) -> String {
    loop {
        let n = counter.fetch_add(1, Ordering::SeqCst);
        let id = format!("w-{}", n);
        // Restored windows predate this process's counter. Reserve a fresh
        // candidate atomically and skip any label already in the window map.
        if !is_used(&id) {
            return id;
        }
    }
}

fn create_window_internal<M: Manager<Wry>>(manager: &M, label: &str) -> Result<(), String> {
    let window = tauri::WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .title("axn-term")
        .inner_size(800.0, 600.0)
        .visible(false)
        // The app has no native file-drop target; the default wry drop
        // handler registers the webview as an OS-level drop destination,
        // which on macOS overlays a phantom "+" copy badge on internal HTML5
        // drags and can consume the drop before the JS handlers see it.
        // (On Windows it fully blocks HTML5 drag and drop.)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;

    // On Wayland, tao unconditionally installs a GtkHeaderBar as the window
    // titlebar, forcing GTK client-side decorations — a tall, icon-less bar
    // that looks foreign on KDE. Removing it lets GTK use the compositor's
    // server-side decorations (native KWin titlebar on KDE/Wayland) and
    // falls back to GTK's plain titlebar on compositors without SSD.
    // Both calls run on the GTK main thread; this function may be reached
    // from the remote-control HTTP thread.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let window2 = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(gtk_window) = window2.gtk_window() {
                gtk_window.set_titlebar(None::<&gtk::Widget>);
            }
            let _ = window2.show();
        });
    }
    #[cfg(not(target_os = "linux"))]
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Shared so writers can release the session map before blocking I/O.
    writer: PtyWriter,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    shell_pid: u32,
    /// Recent decoded output for remote-control `GET /sessions/<id>`;
    /// `None` unless the remote-control server is enabled.
    output: Option<Arc<Mutex<OutputTail>>>,
    /// Set for sub-shell PTYs: the session they belong to. Closing the parent
    /// cascades to its sub-shells. Mutable so a PTY can be promoted to a main
    /// session or detached into its own session after spawn (the exit watcher
    /// reads the live value to decide between `session-exited` and
    /// `subshell-exited`).
    parent_id: Arc<Mutex<Option<String>>>,
}

/// Cap of a session's `OutputTail` in bytes (≤ chars) — the frontend
/// scrollback is capped at 200,000 characters as well.
const OUTPUT_TAIL_MAX: usize = 200_000;

/// Incremental UTF-8 decoder for raw PTY reads: a multibyte character split
/// across two reads is carried over into the next chunk instead of failing
/// the whole chunk; invalid bytes decode to U+FFFD.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::with_capacity(self.pending.len());
        let mut pos = 0;
        while pos < self.pending.len() {
            match std::str::from_utf8(&self.pending[pos..]) {
                Ok(text) => {
                    out.push_str(text);
                    pos = self.pending.len();
                }
                Err(e) => {
                    let valid = pos + e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[pos..valid]).unwrap_or_default());
                    match e.error_len() {
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            pos = valid + len;
                        }
                        // Incomplete sequence at the end: wait for more bytes.
                        None => {
                            pos = valid;
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..pos);
        out
    }
}

/// Bounded tail of a session's decoded output. Trimming starts once the text
/// exceeds the cap by a quarter, so the front `drain` is amortized instead of
/// shifting ~200 KB for every 4 KB read.
#[derive(Default)]
struct OutputTail {
    text: String,
    decoder: Utf8Stream,
}

impl OutputTail {
    fn push_bytes(&mut self, bytes: &[u8]) {
        let chunk = self.decoder.decode(bytes);
        self.text.push_str(&chunk);
        if self.text.len() > OUTPUT_TAIL_MAX + OUTPUT_TAIL_MAX / 4 {
            let mut cut = self.text.len() - OUTPUT_TAIL_MAX;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
        }
    }

    fn as_str(&self) -> &str {
        &self.text
    }
}

#[derive(Clone, Serialize)]
struct ShellOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct SubshellExited {
    id: String,
    exit_code: Option<u32>,
}

fn resolve_shell(shell: Option<String>) -> String {
    if let Some(s) = shell {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return s;
        }
    }

    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return s;
        }
    }

    for fallback in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
        if std::path::Path::new(fallback).exists() {
            return fallback.to_string();
        }
    }

    "/bin/sh".to_string()
}

#[tauri::command]
fn get_default_shell() -> String {
    resolve_shell(None)
}

/// How long an exited PTY's exit event waits for its reader to drain the
/// remaining output. A background job that still holds the PTY open keeps
/// the reader from reaching EOF — the exit is reported anyway after this.
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

/// Poll `try_wait` until the child exits, then wait for the reader to hit
/// EOF (all `reader_done` senders dropped), at most `drain_timeout`.
/// Returns the exit code, `None` when the status could not be read.
fn wait_exit_then_drain(
    mut try_wait: impl FnMut() -> std::io::Result<Option<u32>>,
    reader_done: &std::sync::mpsc::Receiver<()>,
    poll: Duration,
    drain_timeout: Duration,
) -> Option<u32> {
    let exit_code = loop {
        match try_wait() {
            Ok(None) => std::thread::sleep(poll),
            Ok(Some(code)) => break Some(code),
            Err(_) => break None,
        }
    };
    let _ = reader_done.recv_timeout(drain_timeout);
    exit_code
}

/// Initial PTY size, clamped to a sensible minimum so programs that read the
/// PTY size (e.g. Terminal.Gui's ansi driver) don't start with a 0x0 screen.
fn initial_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        rows: rows.unwrap_or(24).max(1),
        cols: cols.unwrap_or(80).max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Spawn `cmd` on a new PTY and register it under `id`. When `parent_id` is
/// set the PTY is a sub-shell of that session: its exit is reported via
/// `subshell-exited` (with the exit code) instead of `session-exited`, and it
/// is killed when the parent session closes.
fn spawn_pty(
    app: &AppHandle,
    state: &AppState,
    session_id: String,
    mut cmd: CommandBuilder,
    cwd: Option<String>,
    size: PtySize,
    parent_id: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        if let Some(fd) = pair.master.as_raw_fd() {
            use nix::sys::termios::{SetArg, SpecialCharacterIndices, tcgetattr, tcsetattr};
            use std::os::fd::BorrowedFd;
            let fd = unsafe { BorrowedFd::borrow_raw(fd) };
            if let Ok(mut termios) = tcgetattr(fd) {
                termios.control_chars[SpecialCharacterIndices::VERASE as usize] = 0x7f;
                let _ = tcsetattr(fd, SetArg::TCSANOW, &termios);
            }
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Agent hooks receive JSON on stdin and may run without a controlling
    // terminal. Carry the PTY identity through the agent into its hooks.
    cmd.env("AXN_TERM_PTY_ID", &session_id);
    if let Ok(dir) = state_dir() {
        cmd.env("AXN_TERM_STATE_DIR", dir);
    }
    if cmd.get_env("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(cwd) = cwd {
        let path = std::path::PathBuf::from(&cwd);
        if path.is_dir() {
            cmd.cwd(path);
            cmd.env("PWD", &cwd);
        } else if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        } else {
            cmd.cwd(std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")));
        }
    } else if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    } else {
        cmd.cwd(std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")));
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let child = Arc::new(Mutex::new(child));
    let shell_pid = child.lock().unwrap().process_id().unwrap_or(0);

    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;

    let output = state
        .capture_output
        .then(|| Arc::new(Mutex::new(OutputTail::default())));
    let reader_output = output.clone();

    let parent_link = Arc::new(Mutex::new(parent_id));
    let session = Session {
        master: Mutex::new(pair.master),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::clone(&child),
        shell_pid,
        output,
        parent_id: Arc::clone(&parent_link),
    };

    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(session_id.clone(), session);
    }

    // The reader drops its end on EOF, so the exit watcher can hold the
    // exit event back until the last output has been emitted.
    let (reader_done_tx, reader_done_rx) = std::sync::mpsc::channel::<()>();

    let session_id_exit = session_id.clone();
    let child_for_exit = Arc::clone(&child);
    let exit_handle = app.clone();
    std::thread::spawn(move || {
        let exit_code = wait_exit_then_drain(
            || child_for_exit.lock().unwrap().try_wait().map(|s| s.map(|s| s.exit_code())),
            &reader_done_rx,
            Duration::from_millis(100),
            READER_DRAIN_TIMEOUT,
        );
        // Read the parent link at exit time: a promoted or detached
        // sub-shell reports `session-exited`, a demoted main shell or
        // regular sub-shell reports `subshell-exited`.
        if parent_link.lock().unwrap().is_some() {
            let _ = exit_handle.emit(
                "subshell-exited",
                SubshellExited {
                    id: session_id_exit,
                    exit_code,
                },
            );
        } else {
            let _ = exit_handle.emit("session-exited", session_id_exit);
        }
    });

    let session_id_reader = session_id;
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = BASE64.encode(&buf[..n]);
                    let payload = ShellOutput {
                        session_id: session_id_reader.clone(),
                        data,
                    };
                    let _ = app_handle.emit("shell-output", payload);
                    if let Some(Ok(mut out)) = reader_output.as_ref().map(|o| o.lock()) {
                        out.push_bytes(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        drop(reader_done_tx);
    });

    Ok(())
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<bool, String> {
    // Reattach: a live PTY already registered under this id (e.g. a detached
    // sub-shell adopted as its own session) is reused instead of respawned —
    // reported as `false` so the caller does not treat it as a fresh spawn.
    {
        let sessions = state.sessions.lock().unwrap();
        if sessions
            .get(&session_id)
            .is_some_and(|s| matches!(s.child.lock().unwrap().try_wait(), Ok(None)))
        {
            return Ok(false);
        }
    }

    let shell = resolve_shell(shell);

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("SHELL", &shell);

    spawn_pty(
        &app,
        &state,
        session_id,
        cmd,
        cwd,
        initial_pty_size(cols, rows),
        None,
    )?;
    Ok(true)
}

/// Spawn a sub-shell PTY belonging to `parent_session_id`: `sh -c <command>`
/// for a one-shot command, or the default shell for an interactive sub-shell.
/// Runs in `cwd` when given, else the parent's live working directory.
// The parameters are the JS-facing command arguments.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_subshell(
    app: AppHandle,
    state: State<AppState>,
    parent_session_id: String,
    subshell_id: String,
    command: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    let parent_pid = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // A live PTY under this id is attached to, not respawned (e.g. a
        // demoted main shell shown as a sub-shell tab). Refresh its parent
        // link so exit reporting follows the current owner.
        if let Some(existing) = sessions.get(&subshell_id) {
            if matches!(existing.child.lock().unwrap().try_wait(), Ok(None)) {
                *existing.parent_id.lock().unwrap() = Some(parent_session_id);
                return Ok(());
            }
        }
        // Re-spawning an existing id (re-run) replaces the dead child.
        if let Some(old) = sessions.remove(&subshell_id) {
            let _ = old.child.lock().unwrap().kill();
        }
        let parent = sessions
            .get(&parent_session_id)
            .ok_or("session not found")?;
        parent.shell_pid
    };
    // Outside the session map lock: process_cwd spawns `lsof` on macOS.
    let cwd = cwd.or_else(|| process_cwd(parent_pid));

    let shell = resolve_shell(None);
    let mut cmd = match command.filter(|c| !c.trim().is_empty()) {
        Some(command) => {
            let mut c = CommandBuilder::new("sh");
            c.arg("-c");
            c.arg(command);
            // `sh -c` is not a login shell and inherits the app's GUI-launch
            // PATH; reuse the login-shell PATH captured for plugin_exec so
            // Homebrew tools (docker, glab, …) resolve in command tabs too.
            #[cfg(unix)]
            if let Some(path) = login_shell_path() {
                c.env("PATH", path);
            }
            c
        }
        // Same spawn path as the main session PTY: the user's login shell
        // (argv0 `-shell`), so profile-sourced PATH/env apply to sub-shells.
        None => CommandBuilder::new_default_prog(),
    };
    cmd.env("SHELL", &shell);
    cmd.env("AXN_SESSION_ID", &parent_session_id);
    if let Some(cwd) = &cwd {
        cmd.env("AXN_SESSION_PWD", cwd);
    }

    spawn_pty(
        &app,
        &state,
        subshell_id,
        cmd,
        cwd,
        initial_pty_size(cols, rows),
        Some(parent_session_id),
    )
}

/// The session's PTY writer, cloned out of the session map so the map lock
/// is released before the write: `write_all` blocks once the PTY input
/// buffer is full (child not reading) and must not stall every other
/// session command meanwhile.
fn session_writer(state: &AppState, session_id: &str) -> Result<PtyWriter, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(session_id).ok_or("session not found")?;
    Ok(Arc::clone(&session.writer))
}

fn session_shell_pid(state: &AppState, session_id: &str) -> Result<u32, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(session_id).ok_or("session not found")?;
    Ok(session.shell_pid)
}

/// Run `f` against the app state on the blocking pool — for commands that
/// spawn `ps`/`lsof` and must neither run on the main thread nor hold the
/// session map while they wait.
async fn with_state_blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(app.state::<AppState>().inner()))
        .await
        .map_err(|e| e.to_string())?
}

// Stays a synchronous command: the main thread serializes keystroke writes.
#[tauri::command]
fn write_session(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    let writer = session_writer(&state, &session_id)?;
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_session(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or("session not found")?;
    let master = session.master.lock().unwrap();
    // Guard against xterm.js resize events that may briefly report 0 cols/rows.
    let cols = cols.max(1);
    let rows = rows.max(1);
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn run_command_with_fallbacks(binaries: &[&str], args: &[&str]) -> Option<String> {
    for binary in binaries {
        let mut cmd = std::process::Command::new(binary);
        for arg in args {
            cmd.arg(arg);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Ok(s) = String::from_utf8(output.stdout) {
                    let s = s.trim();
                    if !s.is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Basename of an argv token — strips leading hyphens from login-shell
/// argv0 names (e.g. "-zsh" -> "zsh") and reduces paths to the file name.
fn argv_basename(token: &str) -> String {
    let name = token.trim().trim_start_matches('-');
    std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string()
}

const SCRIPT_EXTS: [&str; 8] = ["py", "js", "mjs", "cjs", "ts", "sh", "rb", "pl"];

fn strip_script_ext(name: String) -> String {
    if let Some((stem, ext)) = name.rsplit_once('.') {
        if SCRIPT_EXTS.contains(&ext) {
            return stem.to_string();
        }
    }
    name
}

/// Interpreters/launchers whose real program sits in a later argv slot —
/// `python3.13 /x/bin/vibe` should identify as `vibe`, not `python3.13`,
/// or process-bound plugins (`processPattern`) and session icons miss.
fn is_interpreter(name: &str) -> bool {
    let stem = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    matches!(
        stem,
        "python" | "node" | "bun" | "deno" | "ruby" | "perl" | "sh" | "bash" | "zsh" | "fish"
    )
}

/// Derive the process identity from argv: scripts run through an
/// interpreter resolve to the script name (`vibe`, `cli`), `python -m pkg`
/// to the module name. Everything else is the argv0 basename.
fn process_identity(argv: &[String]) -> Option<String> {
    let first = argv_basename(argv.first()?);
    if is_interpreter(&first) {
        match argv.get(1).map(String::as_str) {
            Some("-m") => {
                if let Some(module) = argv.get(2) {
                    return Some(module.clone());
                }
            }
            Some(arg) if arg.contains('/') => {
                return Some(strip_script_ext(argv_basename(arg)));
            }
            _ => {}
        }
    }
    Some(first)
}

fn process_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // /proc/<pid>/cmdline carries NUL-separated argv — exact tokens.
        let argv: Vec<String> = std::fs::read(format!("/proc/{}/cmdline", pid))
            .ok()?
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        process_identity(&argv).or_else(|| {
            std::fs::read_to_string(format!("/proc/{}/comm", pid))
                .ok()
                .map(|s| argv_basename(&s))
        })
    }
    #[cfg(target_os = "macos")]
    {
        // `command=` prints full argv — needed to unwrap interpreter
        // scripts (comm alone reports e.g. `python` for `vibe`).
        run_command_with_fallbacks(
            &["/bin/ps", "/usr/bin/ps", "ps"],
            &["-p", &pid.to_string(), "-o", "command="],
        )
        .and_then(|s| {
            let argv: Vec<String> = s.split_whitespace().map(String::from).collect();
            process_identity(&argv)
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn process_cwd(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        run_command_with_fallbacks(
            &["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"],
            &["-p", &pid.to_string(), "-a", "-d", "cwd", "-Fn"],
        )
        .and_then(|s| {
            s.lines()
                .find_map(|line| line.strip_prefix('n').map(|p| p.to_string()))
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

// Polled ~1/s per terminal; process_name spawns `ps` on macOS.
#[tauri::command]
async fn get_foreground_process(
    app: AppHandle,
    session_id: String,
) -> Result<Option<String>, String> {
    with_state_blocking(app, move |state| {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&session_id).ok_or("session not found")?;

        #[cfg(unix)]
        {
            let pid = {
                let master = session.master.lock().map_err(|e| e.to_string())?;
                master.process_group_leader().ok_or("no process group leader")?
            };
            drop(sessions);
            Ok(process_name(pid as u32))
        }
        #[cfg(not(unix))]
        {
            let _ = session;
            Ok(None)
        }
    })
    .await
}

/// Path of the running axn-term binary — the `axn-install` hidden command uses
/// it so `axn-term install` works in dev builds too, where the binary may not
/// be on PATH.
#[tauri::command]
fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// process_cwd spawns `lsof` on macOS.
#[tauri::command]
async fn get_session_cwd(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    with_state_blocking(app, move |state| {
        Ok(process_cwd(session_shell_pid(state, &session_id)?))
    })
    .await
}

/// Controlling terminal of the session's PTY (`/dev/ttysNNN`, `/dev/pts/N`) —
/// lets plugins correlate out-of-band events written by processes running in
/// that PTY (e.g. agent hooks keyed by `tty`). `None` when the tty cannot be
/// determined.
#[cfg(unix)]
fn process_tty(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let tty = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // `??` (no controlling terminal) or empty means no tty; `pts/N` and
    // `ttysNNN` are relative to /dev.
    if tty.is_empty() || tty.starts_with('?') {
        return None;
    }
    Some(if tty.starts_with("/dev/") {
        tty
    } else {
        format!("/dev/{}", tty)
    })
}

// process_tty spawns `ps`.
#[tauri::command]
async fn get_session_tty(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    with_state_blocking(app, move |state| {
        let pid = session_shell_pid(state, &session_id)?;
        #[cfg(unix)]
        {
            Ok(process_tty(pid))
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            Ok(None)
        }
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMemory {
    session_id: String,
    rss_kb: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryStats {
    total_kb: u64,
    available_kb: u64,
    swap_total_kb: u64,
    swap_free_kb: u64,
    app_rss_kb: u64,
    sessions: Vec<SessionMemory>,
}

/// (pid, ppid, rss_kb) for every process. `ps` is used so the same code works
/// on Linux and macOS.
fn process_table() -> Vec<(u32, u32, u64)> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid=", "-o", "rss="])
        .output()
    else {
        return Vec::new();
    };
    let Ok(text) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let pid = cols.next()?.parse().ok()?;
            let ppid = cols.next()?.parse().ok()?;
            let rss = cols.next()?.parse().ok()?;
            Some((pid, ppid, rss))
        })
        .collect()
}

/// Sum the RSS of `root` and all its descendants in the process table.
fn rss_of_tree(
    root: u32,
    children: &std::collections::HashMap<u32, Vec<u32>>,
    rss: &std::collections::HashMap<u32, u64>,
) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        total += rss.get(&pid).copied().unwrap_or(0);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids);
        }
    }
    total
}

/// (total, available, swap_total, swap_free) in kB.
#[cfg(target_os = "linux")]
fn system_memory() -> (u64, u64, u64, u64) {
    let mut total = 0u64;
    let mut avail = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;
    if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
        for line in meminfo.lines() {
            let mut cols = line.split_whitespace();
            let Some(key) = cols.next() else { continue };
            let Ok(val) = cols.next().unwrap_or("0").parse::<u64>() else { continue };
            match key {
                "MemTotal:" => total = val,
                "MemAvailable:" => avail = val,
                "SwapTotal:" => swap_total = val,
                "SwapFree:" => swap_free = val,
                _ => {}
            }
        }
    }
    (total, avail, swap_total, swap_free)
}

/// (total, available, swap_total, swap_free) in kB.
#[cfg(target_os = "macos")]
fn system_memory() -> (u64, u64, u64, u64) {
    let total = run_command_with_fallbacks(&["sysctl"], &["-n", "hw.memsize"])
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        / 1024;
    let page = run_command_with_fallbacks(&["sysctl"], &["-n", "vm.pagesize"])
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(4096);
    // Approximate "available" as free + inactive pages, like MemAvailable.
    let mut avail_pages = 0u64;
    if let Some(vm) = run_command_with_fallbacks(&["vm_stat"], &[]) {
        for line in vm.lines() {
            if line.contains("Pages free") || line.contains("Pages inactive") {
                if let Some(n) = line
                    .split_whitespace()
                    .last()
                    .and_then(|s| s.trim_end_matches('.').parse::<u64>().ok())
                {
                    avail_pages += n;
                }
            }
        }
    }
    (total, avail_pages * page / 1024, 0, 0)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_memory() -> (u64, u64, u64, u64) {
    (0, 0, 0, 0)
}

/// RAM usage of the whole app process tree plus every session's process tree,
/// and system-wide memory pressure for the rail indicator.
// Polled while a memory-usage plugin is enabled; process_table() spawns
// `ps` and blocks, so run off the main thread.
#[tauri::command]
async fn get_memory_stats(app: AppHandle) -> Result<MemoryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        memory_stats_blocking(state.inner())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn memory_stats_blocking(state: &AppState) -> Result<MemoryStats, String> {
    let session_pids: Vec<(String, u32)> = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(id, s)| (id.clone(), s.shell_pid))
        .collect();
    let table = process_table();
    let mut children = std::collections::HashMap::<u32, Vec<u32>>::new();
    let mut rss = std::collections::HashMap::<u32, u64>::new();
    for (pid, ppid, r) in table {
        rss.insert(pid, r);
        children.entry(ppid).or_default().push(pid);
    }
    let session_stats = session_pids
        .into_iter()
        .map(|(session_id, pid)| SessionMemory {
            rss_kb: rss_of_tree(pid, &children, &rss),
            session_id,
        })
        .collect();
    let app_rss_kb = rss_of_tree(std::process::id(), &children, &rss);
    let (total_kb, available_kb, swap_total_kb, swap_free_kb) = system_memory();
    Ok(MemoryStats {
        total_kb,
        available_kb,
        swap_total_kb,
        swap_free_kb,
        app_rss_kb,
        sessions: session_stats,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PathStat {
    path: String,
    is_file: bool,
    is_dir: bool,
}

#[tauri::command]
fn stat_path(cwd: Option<String>, path: String) -> Option<PathStat> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        match std::env::var("HOME") {
            Ok(home) => format!("{}/{}", home, rest),
            Err(_) => path.clone(),
        }
    } else {
        path
    };
    let p = std::path::PathBuf::from(&expanded);
    let resolved = if p.is_absolute() {
        p
    } else {
        match cwd {
            Some(c) if !c.is_empty() => std::path::Path::new(&c).join(&p),
            _ => return None,
        }
    };
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_file() && !meta.is_dir() {
        return None;
    }
    Some(PathStat {
        path: resolved.to_string_lossy().to_string(),
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
    })
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["open"]
    } else if cfg!(target_os = "windows") {
        &["explorer"]
    } else {
        // Linux and other Unix-like systems. xdg-open is the generic default,
        // kde-open is a tighter match on KDE desktops if xdg-open fails.
        &["xdg-open", "kde-open", "kde-open5", "gio", "gnome-open"]
    };

    let mut last_err: Option<String> = None;
    for &program in candidates {
        let result = if program == "gio" {
            std::process::Command::new(program)
                .arg("open")
                .arg(&path)
                .spawn()
                .map(|_| ())
        } else {
            std::process::Command::new(program)
                .arg(&path)
                .spawn()
                .map(|_| ())
        };

        match result {
            Ok(_) => return Ok(()),
            Err(e) => last_err = Some(format!("{}: {}", program, e)),
        }
    }

    Err(format!(
        "could not open directory {}. {}",
        path,
        last_err.unwrap_or_default()
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn path_to_file_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Reveal a file or directory in the OS file manager with the item selected.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open -R {}: {}", path, e))
    }
    #[cfg(target_os = "windows")]
    {
        // explorer /select,"<path>" highlights the item in its parent folder.
        std::process::Command::new("explorer")
            .arg(format!("/select,\"{}\"", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer {}: {}", path, e))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // freedesktop FileManager1.ShowItems highlights the item in any
        // compliant manager (Nautilus, Dolphin, Nemo, ...). Fall back to
        // opening the containing directory when no manager answers.
        let uri = path_to_file_uri(&path);
        let shown = std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--type=method_call",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{}", uri),
                "string:",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if shown {
            Ok(())
        } else {
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path);
            open_directory(parent)
        }
    }
}

/// Re-parent (or detach, with `parent_id: None`) a PTY after spawn. Used when
/// a sub-shell is promoted to the session's main shell (the old main shell is
/// demoted to a sub-shell) or when a sub-shell is turned into its own session.
/// The exit watcher reads the link at exit time, so this also switches which
/// exit event the PTY emits.
#[tauri::command]
fn set_subshell_parent(
    state: State<AppState>,
    subshell_id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&subshell_id)
        .ok_or("session not found")?;
    *session.parent_id.lock().unwrap() = parent_id;
    Ok(())
}

#[tauri::command]
fn close_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    // Sub-shells die with their parent session.
    let child_ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.parent_id.lock().unwrap().as_deref() == Some(session_id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();
    for id in child_ids {
        if let Some(sub) = sessions.remove(&id) {
            let _ = sub.child.lock().unwrap().kill();
        }
    }
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.child.lock().unwrap().kill();
        Ok(())
    } else {
        Err("session not found".to_string())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoInfo {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    group: Option<String>,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: bool,
    untracked: u32,
    remote_branch_missing: bool,
    root: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    remote: Option<String>,
}

fn run_git(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_git_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let without_git = url.strip_suffix(".git").unwrap_or(url);
    let path = if let Some(at) = without_git.find('@') {
        let after_host = &without_git[at + 1..];
        after_host
            .find([':', '/'])
            .map(|i| &after_host[i + 1..])?
    } else if let Some(scheme) = without_git.find("://") {
        let after_scheme = &without_git[scheme + 3..];
        after_scheme.find('/').map(|i| &after_scheme[i + 1..])?
    } else {
        without_git
    };
    path.rsplit_once('/').map(|(g, n)| (g.to_string(), n.to_string()))
}

fn parse_git_status(
    output: &str,
    name: String,
    group: Option<String>,
    root: String,
    remote: Option<String>,
) -> Option<RepoInfo> {
    let mut lines = output.lines();
    let branch_line = lines.next()?;
    let rest = branch_line.strip_prefix("## ")?;

    // An unborn branch (fresh `git init`) is reported as `No commits yet on
    // <branch>` (`Initial commit on <branch>` before git 2.16).
    let rest = rest
        .strip_prefix("No commits yet on ")
        .or_else(|| rest.strip_prefix("Initial commit on "))
        .unwrap_or(rest);

    let branch: Option<String>;
    let mut remote_branch_missing = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    // Detached HEAD is exactly `HEAD (no branch)` — a prefix match would
    // also swallow branches named e.g. `HEAD-fix`.
    if rest.starts_with("HEAD (no branch)") {
        branch = None;
    } else if let Some(dots) = rest.find("...") {
        branch = Some(rest[..dots].to_string());
        let tracking = &rest[dots + 3..];
        if tracking.contains("[gone]") {
            remote_branch_missing = true;
        }
        if let Some(pos) = tracking.find("ahead ") {
            let s = &tracking[pos + 6..];
            let n = s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>();
            ahead = n.parse::<u32>().unwrap_or(0);
        }
        if let Some(pos) = tracking.find("behind ") {
            let s = &tracking[pos + 7..];
            let n = s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>();
            behind = n.parse::<u32>().unwrap_or(0);
        }
    } else {
        branch = Some(rest.split_whitespace().next()?.to_string());
        remote_branch_missing = true;
    }

    let mut dirty = false;
    let mut untracked = 0u32;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("??") {
            untracked += 1;
        } else {
            dirty = true;
        }
    }

    Some(RepoInfo {
        name,
        group,
        branch,
        ahead,
        behind,
        dirty,
        untracked,
        remote_branch_missing,
        root,
        remote,
    })
}

// `git status --porcelain --untracked-files=all` can take seconds on large
// repos — run off the main thread so repo refreshes cannot freeze the UI.
#[tauri::command]
async fn get_git_repo(cwd: String) -> Result<Option<RepoInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_repo_blocking(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn get_git_repo_blocking(cwd: String) -> Result<Option<RepoInfo>, String> {
    let path = std::path::PathBuf::from(cwd);
    if !path.is_dir() {
        return Ok(None);
    }
    let toplevel = match run_git(&path, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(None),
    };
    if toplevel.is_empty() {
        return Ok(None);
    }
    let repo_root = std::path::Path::new(&toplevel);
    let name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let remote = run_git(&path, &["remote", "get-url", "origin"]).ok();
    let group = remote
        .as_deref()
        .and_then(parse_git_remote)
        .map(|(g, _)| g);

    let status_output = match run_git(
        &path,
        &["status", "--porcelain", "--branch", "--untracked-files=all"],
    ) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    match parse_git_status(&status_output, name, group, toplevel, remote) {
        Some(info) => Ok(Some(info)),
        None => Ok(None),
    }
}

// state.json can reach several MB (per-session scrollback is capped at
// 200k chars) — parse/merge off the main thread.
#[tauri::command]
async fn load_window_state(
    app: AppHandle,
    window_id: String,
) -> Result<Option<JsonValue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        load_window_state_blocking(state.inner(), window_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn load_window_state_blocking(
    state: &AppState,
    window_id: String,
) -> Result<Option<JsonValue>, String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;
    let loaded = read_shell_state().map_err(|e| {
        eprintln!("load_window_state read error: {}", e);
        e
    })?;
    let target = JsonValue::String(window_id);
    let mut window = loaded
        .state
        .windows
        .into_iter()
        .find(|w| w.get("id") == Some(&target));
    // When the backup was loaded, tell the frontend so it can surface a
    // notice and point at the preserved failed file.
    if loaded.restored_from_backup {
        if let Some(obj) = window.as_mut().and_then(|w| w.as_object_mut()) {
            obj.insert("restoredFromBackup".to_string(), JsonValue::Bool(true));
            if let Some(failed) = &loaded.failed_file {
                obj.insert(
                    "failedStateFile".to_string(),
                    JsonValue::String(failed.clone()),
                );
            }
        }
    }
    Ok(window)
}

// Runs on the frontend's dirty-state flush; serializing and writing a
// multi-MB state file on the main thread would stutter the UI.
#[tauri::command]
async fn save_window_state(
    app: AppHandle,
    window_id: String,
    window_state: JsonValue,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        save_window_state_blocking(state.inner(), window_id, window_state)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn save_window_state_blocking(
    state: &AppState,
    window_id: String,
    mut window_state: JsonValue,
) -> Result<(), String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;

    if let Some(obj) = window_state.as_object_mut() {
        obj.insert("id".to_string(), JsonValue::String(window_id.clone()));
        // Backup-restore markers are load-time diagnostics, never persisted.
        obj.remove("restoredFromBackup");
        obj.remove("failedStateFile");
    }

    let dir = state_dir().map_err(|e| {
        eprintln!("save_window_state state_dir error: {}", e);
        e
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("save_window_state create_dir_all error: {}", e);
        return Err(e.to_string());
    }

    let loaded = read_shell_state().unwrap_or_default();
    let mut shell_state = loaded.state;
    let target = JsonValue::String(window_id);
    shell_state.windows.retain(|w| w.get("id") != Some(&target));
    shell_state.windows.push(window_state);

    if let Err(e) = write_shell_state(&shell_state, loaded.current_valid) {
        eprintln!("save_window_state write error: {}", e);
        return Err(e);
    }
    Ok(())
}

fn delete_window_state_sync(state: &AppState, window_id: &str) -> Result<(), String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;
    let dir = state_dir().map_err(|e| {
        eprintln!("delete_window_state state_dir error: {}", e);
        e
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("delete_window_state create_dir_all error: {}", e);
        return Err(e.to_string());
    }

    let loaded = read_shell_state().unwrap_or_default();
    let mut shell_state = loaded.state;
    let target = JsonValue::String(window_id.to_string());
    shell_state.windows.retain(|w| w.get("id") != Some(&target));

    if let Err(e) = write_shell_state(&shell_state, loaded.current_valid) {
        eprintln!("delete_window_state write error: {}", e);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
async fn delete_window_state(app: AppHandle, window_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        delete_window_state_sync(state.inner(), &window_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_plugins() -> Result<Option<String>, String> {
    let path = plugins_file()?;
    if !path.is_file() {
        return Ok(None);
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) => {
            eprintln!("read_plugins error for {:?}: {}", path, e);
            Err(e.to_string())
        }
    }
}

fn external_plugins_dir() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("plugins"))
}

#[tauri::command]
fn list_external_plugins() -> Result<Vec<String>, String> {
    let dir = external_plugins_dir()?;
    let mut names = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("mjs") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_external_plugin(name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid plugin file name".to_string());
    }
    let path = external_plugins_dir()?.join(&name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn valid_plugin_segment(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && s != ".." && s != "."
}

/// Sandboxed plugin packages: directories under plugins/ containing a
/// plugin.json manifest (plus plugin.mjs logic and an optional index.html
/// view). Returns directory names only.
#[tauri::command]
fn list_external_plugin_dirs() -> Result<Vec<String>, String> {
    let dir = external_plugins_dir()?;
    let mut names = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("plugin.json").is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_external_plugin_file(dir: String, name: String) -> Result<String, String> {
    if !valid_plugin_segment(&dir) || !valid_plugin_segment(&name) {
        return Err("invalid plugin path".to_string());
    }
    let path = external_plugins_dir()?.join(&dir).join(&name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Large enough for `glab api graphql` MR overviews (~90 KB with busy review
/// threads); still bounds what a runaway command can push over IPC.
const PLUGIN_EXEC_MAX_OUTPUT: usize = 1024 * 1024;

/// Upper bound for a plugin_exec child — only reaps hung processes, so it is
/// generous: dev-workflow `run-in: headless` actions and git-inspect
/// "Explain" run whole agent turns (`devin -p …`) through plugin_exec.
const PLUGIN_EXEC_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Upper bound for a git_exec child; `commit` runs the repo's hooks.
const GIT_EXEC_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Cut `text` to at most `max` bytes at a char boundary (`String::truncate`
/// panics inside a multibyte char) and say so explicitly at the end.
fn truncate_output(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let total = text.len();
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str(&format!("\n[axn-term: output truncated to {} of {} bytes]", cut, total));
    text
}

/// `cwd` for an exec command: absent/empty means the app's own cwd, anything
/// else must be an existing directory — never silently run elsewhere.
fn exec_cwd(cwd: Option<&str>) -> Result<Option<&str>, String> {
    match cwd {
        None | Some("") => Ok(None),
        Some(dir) if Path::new(dir).is_dir() => Ok(Some(dir)),
        Some(dir) => Err(format!("cwd is not a directory: {}", dir)),
    }
}

/// `cmd.output()` with a deadline. The child gets its own process group so a
/// timeout kills `sh -c`'s descendants too — they would otherwise keep the
/// output pipes open.
#[cfg(unix)]
fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::{channel, RecvTimeoutError};

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pgid = nix::unistd::Pid::from_raw(child.id() as i32);

    let (done_tx, done_rx) = channel::<()>();
    let timed_out = Arc::new(AtomicBool::new(false));
    let watchdog_flag = Arc::clone(&timed_out);
    std::thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = done_rx.recv_timeout(timeout) {
            watchdog_flag.store(true, Ordering::SeqCst);
            let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
        }
    });

    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let mut stdout = Vec::new();
    if let Some(pipe) = child.stdout.as_mut() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    let status = child.wait();
    drop(done_tx);
    let stderr = stderr_reader.join().unwrap_or_default();
    if timed_out.load(Ordering::SeqCst) {
        return Err(format!("command timed out after {} s", timeout.as_secs()));
    }
    Ok(std::process::Output {
        status: status.map_err(|e| e.to_string())?,
        stdout,
        stderr,
    })
}

#[cfg(not(unix))]
fn output_with_timeout(
    mut cmd: std::process::Command,
    _timeout: Duration,
) -> Result<std::process::Output, String> {
    cmd.output().map_err(|e| e.to_string())
}

// Async command + spawn_blocking: plugins run arbitrary subprocesses here
// (e.g. `glab api` network calls that can take seconds). A synchronous
// command would block the main thread and freeze the whole UI for the
// duration of the child process.
#[tauri::command]
async fn plugin_exec(cwd: Option<String>, command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || plugin_exec_blocking(cwd, command))
        .await
        .map_err(|e| e.to_string())?
}

/// PATH as an interactive login shell would see it. GUI-launched macOS apps
/// inherit launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which
/// misses Homebrew (`/opt/homebrew/bin`) and anything the user's profile
/// adds — so `sh -c glab ...` fails with "command not found" while session
/// PTYs work (portable-pty runs them as login shells). Captured once, lazily.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let output = std::process::Command::new(resolve_shell(None))
            .args(["-l", "-i", "-c", "env"])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("PATH="))
            .rfind(|p| !p.is_empty())
            .map(|p| p.to_string())
    })
    .clone()
}

fn plugin_exec_blocking(cwd: Option<String>, command: String) -> Result<String, String> {
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c").arg(&command);
    #[cfg(unix)]
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
    if let Some(dir) = exec_cwd(cwd.as_deref())? {
        cmd.current_dir(dir);
    }
    let output = output_with_timeout(cmd, PLUGIN_EXEC_TIMEOUT)?;
    let stdout = truncate_output(
        String::from_utf8_lossy(&output.stdout).to_string(),
        PLUGIN_EXEC_MAX_OUTPUT,
    );
    if !output.status.success() {
        let stderr = truncate_output(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
            PLUGIN_EXEC_MAX_OUTPUT,
        );
        return Err(if stderr.is_empty() {
            format!("command failed with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(stdout.trim_end().to_string())
}

/// `git` with an explicit argv — no shell involved, so paths and commit
/// messages with spaces or quotes cannot break quoting (unlike plugin_exec's
/// `sh -c`). Async + spawn_blocking: status/log can take seconds on large
/// repos. Used by the git inspect view (`editors[].kind === 'git'`).
#[tauri::command]
async fn git_exec(cwd: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_exec_blocking(cwd, args))
        .await
        .map_err(|e| e.to_string())?
}

fn git_exec_blocking(cwd: String, args: Vec<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(&args);
    #[cfg(unix)]
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("cwd is not a directory: {}", cwd));
    }
    cmd.current_dir(&cwd);
    let output = output_with_timeout(cmd, GIT_EXEC_TIMEOUT)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git exited with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn write_plugins(content: String) -> Result<(), String> {
    let dir = state_dir().map_err(|e| {
        eprintln!("write_plugins state_dir error: {}", e);
        e
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("write_plugins create_dir_all error: {}", e);
        return Err(e.to_string());
    }
    let path = plugins_file()?;
    if let Err(e) = atomic_write(&path, content.as_bytes()) {
        eprintln!("write_plugins write error: {}", e);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
fn read_config() -> Result<Option<String>, String> {
    let path = config_file()?;
    if !path.is_file() {
        return Ok(None);
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) => {
            eprintln!("read_config error for {:?}: {}", path, e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn write_config(content: String) -> Result<(), String> {
    let dir = state_dir().map_err(|e| {
        eprintln!("write_config state_dir error: {}", e);
        e
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("write_config create_dir_all error: {}", e);
        return Err(e.to_string());
    }
    let path = config_file()?;
    if let Err(e) = atomic_write(&path, content.as_bytes()) {
        eprintln!("write_config write error: {}", e);
        return Err(e);
    }
    Ok(())
}

fn kv_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("kv.json"))
}

fn read_kv_store() -> serde_json::Map<String, JsonValue> {
    let Ok(path) = kv_file() else {
        return serde_json::Map::new();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<JsonValue>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_kv_store(store: &serde_json::Map<String, JsonValue>) -> Result<(), String> {
    let dir = state_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    atomic_write(&kv_file()?, json.as_bytes())
}

/// Small persisted key-value store for UI-side caches (e.g. agent review
/// explanations). The store is a single JSON object at ~/.axn-term/kv.json.
#[tauri::command]
fn kv_get(key: String) -> Result<Option<String>, String> {
    Ok(read_kv_store()
        .get(&key)
        .and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[tauri::command]
fn kv_set(key: String, value: Option<String>) -> Result<(), String> {
    let mut store = read_kv_store();
    match value {
        Some(v) => {
            store.insert(key, JsonValue::String(v));
        }
        None => {
            store.remove(&key);
        }
    }
    write_kv_store(&store)
}

#[tauri::command]
fn create_window(app: AppHandle) -> Result<String, String> {
    let id = next_window_id(&app.state::<AppState>().window_counter, |id| {
        app.get_webview_window(id).is_some()
    });
    create_window_internal(&app, &id)?;
    Ok(id)
}

/// The remote-control HTTP server the flow tests drive the app through.
/// Enabled by `AXN_TERM_REMOTE_CONTROL_PORT` and only together with
/// `AXN_TERM_REMOTE_CONTROL_TOKEN`: it can type into any session, so every
/// request except `GET /health` must carry `Authorization: Bearer <token>`,
/// and the Host header must name the listener itself — a webpage reaching
/// 127.0.0.1 through DNS rebinding sends its own hostname.
struct RemoteControl {
    host: String,
    port: u16,
    token: String,
}

impl RemoteControl {
    /// Read the settings and drop the token from the process env, so PTYs
    /// and exec'd commands never inherit it. Call before other threads run.
    fn from_env() -> Option<Self> {
        let token = std::env::var("AXN_TERM_REMOTE_CONTROL_TOKEN")
            .ok()
            .filter(|t| !t.is_empty());
        std::env::remove_var("AXN_TERM_REMOTE_CONTROL_TOKEN");
        let port = std::env::var("AXN_TERM_REMOTE_CONTROL_PORT").ok()?.parse().ok()?;
        let Some(token) = token else {
            eprintln!(
                "AXN_TERM_REMOTE_CONTROL_PORT is set but AXN_TERM_REMOTE_CONTROL_TOKEN is not — remote control server disabled"
            );
            return None;
        };
        let host = std::env::var("AXN_TERM_REMOTE_CONTROL_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        Some(Self { host, port, token })
    }

    fn host_allowed(&self, host: &str) -> bool {
        let configured = if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        };
        [
            format!("127.0.0.1:{}", self.port),
            format!("localhost:{}", self.port),
            configured,
        ]
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host))
    }

    /// `Err((status, message))` when the request must be rejected.
    fn check(
        &self,
        url: &str,
        host: Option<&str>,
        authorization: Option<&str>,
    ) -> Result<(), (u16, &'static str)> {
        if !host.is_some_and(|h| self.host_allowed(h)) {
            return Err((403, "forbidden host"));
        }
        if url == "/health" {
            return Ok(());
        }
        let presented = authorization.and_then(|value| {
            let (scheme, token) = value.trim().split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
        });
        match presented {
            Some(token) if constant_time_eq(token.as_bytes(), self.token.as_bytes()) => Ok(()),
            _ => Err((401, "unauthorized")),
        }
    }
}

/// Compare without an early exit on the first differing byte (the length
/// is not secret — tokens have a fixed size).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn start_remote_control_server(app_handle: AppHandle, rc: RemoteControl) -> Result<(), String> {
    let addr = format!("{}:{}", rc.host, rc.port);
    let server = tiny_http::Server::http(&addr).map_err(|e| e.to_string())?;
    for mut request in server.incoming_requests() {
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.as_str().to_string())
        };
        let verdict = rc.check(
            request.url(),
            header("Host").as_deref(),
            header("Authorization").as_deref(),
        );
        let response = match verdict {
            Ok(()) => handle_remote_control_request(&mut request, app_handle.clone()),
            Err((status, message)) => {
                let response = tiny_http::Response::from_string(message).with_status_code(status);
                match tiny_http::Header::from_bytes(&b"WWW-Authenticate"[..], &b"Bearer"[..]) {
                    Ok(h) if status == 401 => response.with_header(h),
                    _ => response,
                }
            }
        };
        if let Err(e) = request.respond(response) {
            eprintln!("remote control response failed: {}", e);
        }
    }
    Ok(())
}

fn handle_remote_control_request(
    req: &mut tiny_http::Request,
    app_handle: AppHandle,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    use tiny_http::{Method, Response};

    let state = app_handle.state::<AppState>();
    let url = req.url().to_string();

    match (req.method(), url.as_str()) {
        (Method::Get, "/health") => Response::from_string("ok"),

        (Method::Get, "/state") => match read_shell_state() {
            Ok(loaded) => match serde_json::to_string(&loaded.state) {
                Ok(json) => Response::from_string(json),
                Err(e) => Response::from_string(format!("serialization error: {}", e)),
            },
            Err(e) => Response::from_string(format!("read error: {}", e)),
        },

        (Method::Get, "/windows") => {
            let windows = app_handle.webview_windows();
            let ids: Vec<&String> = windows.keys().collect();
            match serde_json::to_string(&ids) {
                Ok(json) => Response::from_string(json),
                Err(e) => Response::from_string(format!("serialization error: {}", e)),
            }
        }

        (Method::Get, "/sessions") => match state.sessions.lock() {
            Ok(sessions) => {
                let ids: Vec<&String> = sessions.keys().collect();
                match serde_json::to_string(&ids) {
                    Ok(json) => Response::from_string(json),
                    Err(e) => Response::from_string(format!("serialization error: {}", e)),
                }
            }
            Err(e) => Response::from_string(format!("lock error: {}", e)),
        },

        (Method::Get, _) if url.starts_with("/sessions/") => {
            let rest = url.strip_prefix("/sessions/").unwrap_or(url.as_str());
            let id = rest.split('/').next().unwrap_or(rest);
            match state.sessions.lock() {
                Ok(sessions) => match sessions.get(id) {
                    Some(session) => match session.output.as_ref().map(|o| o.lock()) {
                        Some(Ok(output)) => match serde_json::to_string(&serde_json::json!({
                            "id": id,
                            "output": output.as_str(),
                        })) {
                            Ok(json) => Response::from_string(json),
                            Err(e) => Response::from_string(format!("serialization error: {}", e)),
                        },
                        Some(Err(e)) => Response::from_string(format!("lock error: {}", e)),
                        None => Response::from_string("output capture disabled"),
                    },
                    None => Response::from_string(format!("session {} not found", id)),
                },
                Err(e) => Response::from_string(format!("lock error: {}", e)),
            }
        }

        (Method::Post, _) if url.starts_with("/sessions/") => {
            let rest = url.strip_prefix("/sessions/").unwrap_or(url.as_str());
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 2 && parts[1] == "write" {
                let id = parts[0];
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let text = match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(v) => v.get("text").and_then(|t| t.as_str()).unwrap_or(&body).to_string(),
                    Err(_) => body,
                };
                match session_writer(&state, id) {
                    Ok(writer) => match writer.lock() {
                        Ok(mut writer) => {
                            let _ = writer.write_all(text.as_bytes());
                            let _ = writer.flush();
                            Response::from_string("ok")
                        }
                        Err(e) => Response::from_string(format!("lock error: {}", e)),
                    },
                    Err(_) => Response::from_string(format!("session {} not found", id)),
                }
            } else if parts.len() >= 2 && parts[1] == "command" {
                // A whole input line for the frontend's hidden/plugin command
                // dispatch (axn-*, plugin commands) — unlike /write it is not
                // typed into the PTY raw but routed through the same
                // interception a typed line sees.
                let id = parts[0];
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let line = match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(v) => v.get("line").and_then(|t| t.as_str()).unwrap_or(&body).to_string(),
                    Err(_) => body,
                };
                let _ = app_handle.emit(
                    "remote-command",
                    serde_json::json!({ "id": id, "line": line }),
                );
                Response::from_string("ok")
            } else {
                Response::from_string("unknown session action")
            }
        }

        (Method::Post, "/windows") => {
            let id = next_window_id(&state.window_counter, |id| {
                app_handle.get_webview_window(id).is_some()
            });
            match create_window_internal(&app_handle, &id) {
                Ok(()) => match serde_json::to_string(&serde_json::json!({"id": id})) {
                    Ok(json) => Response::from_string(json),
                    Err(e) => Response::from_string(format!("serialization error: {}", e)),
                },
                Err(e) => Response::from_string(format!("create window failed: {}", e)),
            }
        }

        (Method::Post, _) if url.starts_with("/windows/") => {
            let id = url.strip_prefix("/windows/").unwrap_or(url.as_str()).to_string();
            let _ = app_handle.emit("close-window", &id);
            let _ = delete_window_state_sync(&state, &id);
            let windows = app_handle.webview_windows();
            if let Some(w) = windows.get(&id) {
                let _ = w.destroy();
            }
            Response::from_string("ok")
        }

        (Method::Post, "/close") => {
            let _ = app_handle.emit("close-now", &());
            let app = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let windows = app.webview_windows();
                    if windows.is_empty() {
                        return;
                    }
                }
                // Force-destroy any windows that never reacted to close-now so
                // the test process can actually exit.  Leave state.json as it is
                // (the main window already saved before it destroyed).
                let windows = app.webview_windows();
                for w in windows.values() {
                    let _ = w.destroy();
                }
                std::process::exit(0);
            });
            Response::from_string("ok")
        }

        _ => Response::from_string("not found"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, while the process is still single-threaded: it edits the env.
    let remote_control = RemoteControl::from_env();

    // Send frontend log events to the Rust logger. This lets `LOG_LEVEL=debug`
    // show what the TypeScript side (e.g. the devin task plugin) is doing.
    env_logger::Builder::from_env(env_logger::Env::new().filter("LOG_LEVEL"))
        .format_target(false)
        .format_timestamp_nanos()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new(remote_control.is_some()))
        .setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
            app.listen("log", |event| {
                if let Ok(p) = serde_json::from_str::<LogPayload>(event.payload()) {
                    log::log!(p.level.to_level(), "[{}] {}", p.target, p.message);
                }
            });
            if let Ok(dir) = state_dir() {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    eprintln!("failed to create state dir {:?}: {}", dir, e);
                }
                // Recursive $HOME globs intentionally exclude hidden paths.
                // Grant only the bridge's own data and agent config paths.
                let scope = app.fs_scope();
                scope.allow_file(&dir)?;
                for agent in ["claude", "codex", "gemini"] {
                    scope.allow_directory(dir.join(format!("{}-events", agent)), true)?;
                }
                let agent_home = std::env::var_os("AXN_TERM_AGENT_CONFIG_ROOT")
                    .map(PathBuf::from)
                    .or_else(dirs::home_dir);
                if let Some(home) = agent_home {
                    scope.allow_file(home.join(".axn-term"))?;
                    scope.allow_file(home.join(".axn-term/agent-hook.sh"))?;
                    for (agent, file) in [("claude", "settings.json"), ("codex", "hooks.json"), ("gemini", "settings.json")] {
                        scope.allow_file(home.join(format!(".{}", agent)))?;
                        scope.allow_file(home.join(format!(".{}/{}", agent, file)))?;
                    }
                }
            }
            let shell_state = read_shell_state()
                .map(|l| l.state)
                .unwrap_or_else(|e| {
                    eprintln!("setup read_shell_state error: {}", e);
                    ShellState::default()
                });
            let handle = app.handle().clone();
            if shell_state.windows.is_empty() {
                let _ = create_window_internal(&handle, "main");
            } else {
                for w in shell_state.windows {
                    if let Some(label) = w.get("id").and_then(|v| v.as_str()) {
                        let _ = create_window_internal(&handle, label);
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
                    let _ = handle.emit("os-shutdown", ());
                    std::thread::sleep(Duration::from_secs(15));
                    std::process::exit(0);
                });
            }
            if let Some(rc) = remote_control {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = start_remote_control_server(handle, rc) {
                        eprintln!("remote control server failed: {}", e);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_shell,
            create_session,
            write_session,
            resize_session,
            get_foreground_process,
            current_exe_path,
            get_session_cwd,
            get_session_tty,
            get_memory_stats,
            stat_path,
            open_directory,
            reveal_path,
            get_git_repo,
            git_exec,
            close_session,
            load_window_state,
            save_window_state,
            delete_window_state,
            read_plugins,
            write_plugins,
            read_config,
            write_config,
            kv_get,
            kv_set,
            list_external_plugins,
            read_external_plugin,
            list_external_plugin_dirs,
            read_external_plugin_file,
            create_subshell,
            set_subshell_parent,
            plugin_exec,
            create_window,
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
                if !app_handle.webview_windows().is_empty() {
                    api.prevent_exit();
                    let _ = app_handle.emit("os-shutdown", ());
                    // Watchdog: a hung frontend must not stall the quit —
                    // same 15 s budget the SIGTERM/SIGHUP path uses.
                    let code = code.unwrap_or(0);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(15));
                        std::process::exit(code);
                    });
                }
            }
        });
}

#[cfg(test)]
mod process_identity_tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plain_binary_uses_argv0_basename() {
        assert_eq!(
            process_identity(&argv(&["/usr/local/bin/devin", "-p", "x"])).as_deref(),
            Some("devin")
        );
    }

    #[test]
    fn login_shell_strips_dash() {
        assert_eq!(
            process_identity(&argv(&["-zsh"])).as_deref(),
            Some("zsh")
        );
    }

    #[test]
    fn python_script_resolves_to_script_name() {
        // uv tool script: kernel runs <venv python> <script path>
        assert_eq!(
            process_identity(&argv(&[
                "/home/x/.local/share/uv/tools/mistral-vibe/bin/python",
                "/home/x/.local/bin/vibe",
            ]))
            .as_deref(),
            Some("vibe")
        );
    }

    #[test]
    fn versioned_interpreter_and_script_extension() {
        assert_eq!(
            process_identity(&argv(&["/usr/bin/python3.13", "/x/tool.py"])).as_deref(),
            Some("tool")
        );
        assert_eq!(
            process_identity(&argv(&["node", "/x/cli.js"])).as_deref(),
            Some("cli")
        );
    }

    #[test]
    fn python_module_flag_uses_module_name() {
        assert_eq!(
            process_identity(&argv(&["python", "-m", "http.server"])).as_deref(),
            Some("http.server")
        );
    }

    #[test]
    fn bare_interpreter_stays() {
        assert_eq!(
            process_identity(&argv(&["python3"])).as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_identity(&argv(&["bash", "-c", "echo hi"])).as_deref(),
            Some("bash")
        );
    }
}

#[cfg(test)]
mod state_backup_tests {
    use super::*;

    /// Exercises the whole backup/fallback lifecycle in one test — the
    /// AXN_TERM_STATE_DIR env override is process-global, so these steps must
    /// not run in parallel with other state tests.
    #[test]
    fn corrupt_state_falls_back_to_last_good_backup() {
        let dir = std::env::temp_dir().join(format!(
            "axn-term-state-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("AXN_TERM_STATE_DIR", &dir);
        std::fs::create_dir_all(&dir).unwrap();

        let state_file = dir.join("state.json");
        let backup = dir.join("state.json.bak");
        let failed = dir.join("state.json.failed");

        let v1 = ShellState {
            windows: vec![serde_json::json!({"id": "main", "sessions": [{"id": "s1"}]})],
        };
        write_shell_state(&v1, false).unwrap();
        assert!(state_file.exists());
        assert!(!backup.exists(), "no backup before the second save");

        let v2 = ShellState {
            windows: vec![serde_json::json!({"id": "main", "sessions": [{"id": "s2"}]})],
        };
        write_shell_state(&v2, false).unwrap();
        let session_in = |path: &Path| -> JsonValue {
            let raw = std::fs::read_to_string(path).unwrap();
            serde_json::from_str::<JsonValue>(&raw).unwrap()["windows"][0]["sessions"][0]["id"]
                .clone()
        };
        assert_eq!(session_in(&backup), serde_json::json!("s1"), "backup holds the previous state");
        assert_eq!(session_in(&state_file), serde_json::json!("s2"));
        assert!(!dir.join("state.json.tmp").exists());
        assert!(!dir.join("state.json.bak.tmp").exists());

        // A save that cannot write its temp file fails without touching
        // state.json or the backup.
        std::fs::create_dir(dir.join("state.json.tmp")).unwrap();
        let v3 = ShellState {
            windows: vec![serde_json::json!({"id": "main", "sessions": [{"id": "s3"}]})],
        };
        assert!(write_shell_state(&v3, true).is_err());
        assert_eq!(session_in(&state_file), serde_json::json!("s2"), "failed save kept the state");
        assert_eq!(session_in(&backup), serde_json::json!("s1"), "failed save kept the backup");
        std::fs::remove_dir(dir.join("state.json.tmp")).unwrap();

        // A corrupt state.json is replaced but never rotated into the backup.
        std::fs::write(&state_file, "{ corrupt").unwrap();
        write_shell_state(&v3, false).unwrap();
        assert_eq!(session_in(&backup), serde_json::json!("s1"), "corrupt file not rotated");
        assert_eq!(session_in(&state_file), serde_json::json!("s3"));
        write_shell_state(&v2, true).unwrap();
        assert_eq!(session_in(&backup), serde_json::json!("s3"));

        // A failed/corrupt current state is quarantined and the backup loads.
        std::fs::write(&state_file, "{ not json").unwrap();
        let loaded = read_shell_state().unwrap();
        assert!(loaded.restored_from_backup);
        assert_eq!(loaded.failed_file.as_deref(), Some("state.json.failed"));
        assert_eq!(
            loaded.state.windows[0]["sessions"][0]["id"],
            serde_json::json!("s3"),
            "backup contains the last good state, not the failed one"
        );
        assert!(failed.exists(), "failed attempt preserved for diagnosis");
        assert_eq!(
            std::fs::read_to_string(&failed).unwrap(),
            "{ not json"
        );
        assert!(!state_file.exists(), "corrupt file was quarantined");

        // With no backup either, the read falls through to a default state.
        std::fs::write(&state_file, "still broken").unwrap();
        std::fs::remove_file(&backup).unwrap();
        let loaded = read_shell_state().unwrap();
        assert!(!loaded.restored_from_backup);
        assert!(loaded.state.windows.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_replaces_or_keeps_the_file() {
        let dir = std::env::temp_dir().join(format!(
            "axn-term-atomic-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kv.json");

        atomic_write(&path, b"{\"a\":\"1\"}").unwrap();
        atomic_write(&path, b"{\"a\":\"2\"}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":\"2\"}");
        assert!(!dir.join("kv.json.tmp").exists(), "temp file renamed away");

        // The temp file cannot be created: the error surfaces and the
        // previous contents survive untouched.
        std::fs::create_dir(dir.join("kv.json.tmp")).unwrap();
        assert!(atomic_write(&path, b"{}").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":\"2\"}");

        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod output_tail_tests {
    use super::*;

    #[test]
    fn split_multibyte_char_is_carried_over() {
        let bytes = "aé€😀b".as_bytes();
        let mut stream = Utf8Stream::default();
        // Feed one byte at a time: every multibyte char is split.
        let decoded: String = bytes.iter().map(|b| stream.decode(&[*b])).collect();
        assert_eq!(decoded, "aé€😀b");
        assert!(stream.pending.is_empty());
    }

    #[test]
    fn invalid_bytes_become_replacement_chars() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.decode(b"a\xffb\x80c"), "a\u{fffd}b\u{fffd}c");
        // An incomplete trailing sequence waits for the next chunk.
        assert_eq!(stream.decode(b"x\xe2\x82"), "x");
        assert_eq!(stream.decode(b"\xac"), "€");
    }

    #[test]
    fn tail_stays_bounded_at_a_char_boundary() {
        let mut tail = OutputTail::default();
        let chunk = "é".repeat(2000); // 4000 bytes, two per char
        for _ in 0..200 {
            tail.push_bytes(chunk.as_bytes());
        }
        assert!(tail.as_str().len() <= OUTPUT_TAIL_MAX + OUTPUT_TAIL_MAX / 4);
        assert!(tail.as_str().len() >= OUTPUT_TAIL_MAX);
        assert!(tail.as_str().chars().all(|c| c == 'é'));
        tail.push_bytes(b"END");
        assert!(tail.as_str().ends_with("END"), "newest output is kept");
    }
}

#[cfg(test)]
mod exec_tests {
    use super::*;

    #[test]
    fn truncation_respects_char_boundaries_and_is_flagged() {
        assert_eq!(truncate_output("short".into(), 10), "short");
        // 'é' is two bytes: a cut at byte 3 would land inside the second one.
        let out = truncate_output("éééé".into(), 3);
        assert!(out.starts_with("é\n"), "{out}");
        assert!(out.ends_with("[axn-term: output truncated to 2 of 8 bytes]"), "{out}");
    }

    #[test]
    fn missing_cwd_is_an_error() {
        assert_eq!(exec_cwd(None), Ok(None));
        assert_eq!(exec_cwd(Some("")), Ok(None));
        let tmp = std::env::temp_dir();
        assert_eq!(exec_cwd(tmp.to_str()), Ok(tmp.to_str()));
        assert!(exec_cwd(Some("/nonexistent/axn-term-test")).is_err());
        assert!(plugin_exec_blocking(Some("/nonexistent/axn-term-test".into()), "true".into()).is_err());
        assert!(git_exec_blocking("/nonexistent/axn-term-test".into(), vec!["status".into()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exec_collects_output_and_status() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo out; echo err >&2; exit 3"]);
        let output = output_with_timeout(cmd, Duration::from_secs(10)).unwrap();
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
        assert_eq!(output.status.code(), Some(3));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_whole_process_group() {
        let mut cmd = std::process::Command::new("sh");
        // The background `sleep` inherits stdout: without a group kill the
        // pipe would stay open for 30 s after `sh` itself died.
        cmd.args(["-c", "sleep 30 & sleep 30"]);
        let start = std::time::Instant::now();
        let err = output_with_timeout(cmd, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}

#[cfg(all(test, unix))]
mod session_lock_tests {
    use super::*;

    #[test]
    fn writer_is_usable_without_holding_the_session_map() {
        let pair = native_pty_system().openpty(initial_pty_size(None, None)).unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "sleep 5"]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        let writer = pair.master.take_writer().unwrap();
        let state = AppState::new(false);
        state.sessions.lock().unwrap().insert(
            "s".into(),
            Session {
                master: Mutex::new(pair.master),
                writer: Arc::new(Mutex::new(writer)),
                child: Arc::new(Mutex::new(child)),
                shell_pid: 0,
                output: None,
                parent_id: Arc::new(Mutex::new(None)),
            },
        );

        assert!(session_writer(&state, "missing").is_err());
        let writer = session_writer(&state, "s").unwrap();
        let _held = writer.lock().unwrap();
        // A write in flight (writer locked) leaves the map free for others.
        assert!(state.sessions.try_lock().is_ok());
        assert_eq!(session_shell_pid(&state, "s"), Ok(0));

        let session = state.sessions.lock().unwrap().remove("s").unwrap();
        let _ = session.child.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod exit_order_tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Instant;

    #[test]
    fn exit_waits_for_the_reader_to_finish() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = channel::<()>();
        let reader_events = Arc::clone(&events);
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            reader_events.lock().unwrap().push("output");
            drop(tx);
        });
        // The child has already exited; the reader is still draining.
        let code = wait_exit_then_drain(
            || Ok(Some(7)),
            &rx,
            Duration::from_millis(1),
            Duration::from_secs(5),
        );
        events.lock().unwrap().push("exit");
        reader.join().unwrap();
        assert_eq!(code, Some(7));
        assert_eq!(*events.lock().unwrap(), vec!["output", "exit"]);
    }

    #[test]
    fn stuck_reader_is_capped() {
        let (_tx, rx) = channel::<()>();
        let mut polls = 0;
        let start = Instant::now();
        let code = wait_exit_then_drain(
            || {
                polls += 1;
                Ok((polls > 2).then_some(0))
            },
            &rx,
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        assert_eq!(code, Some(0));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn unreadable_status_reports_no_code() {
        let (tx, rx) = channel::<()>();
        drop(tx);
        let code = wait_exit_then_drain(
            || Err(std::io::Error::other("gone")),
            &rx,
            Duration::from_millis(1),
            Duration::from_secs(5),
        );
        assert_eq!(code, None);
    }
}

#[cfg(test)]
mod remote_control_tests {
    use super::*;

    fn rc() -> RemoteControl {
        RemoteControl {
            host: "127.0.0.1".into(),
            port: 4711,
            token: "s3cret-token".into(),
        }
    }

    #[test]
    fn requires_the_bearer_token() {
        let rc = rc();
        let host = Some("127.0.0.1:4711");
        assert_eq!(rc.check("/sessions", host, Some("Bearer s3cret-token")), Ok(()));
        assert_eq!(rc.check("/sessions", host, Some("bearer  s3cret-token ")), Ok(()));
        assert_eq!(rc.check("/sessions", host, None), Err((401, "unauthorized")));
        assert_eq!(rc.check("/sessions/x/write", host, Some("Bearer wrong")), Err((401, "unauthorized")));
        assert_eq!(rc.check("/close", host, Some("Basic s3cret-token")), Err((401, "unauthorized")));
        assert_eq!(rc.check("/sessions", host, Some("Bearer s3cret-token-longer")), Err((401, "unauthorized")));
        // Liveness needs no token.
        assert_eq!(rc.check("/health", host, None), Ok(()));
    }

    #[test]
    fn rejects_foreign_host_headers() {
        let rc = rc();
        let auth = Some("Bearer s3cret-token");
        assert_eq!(rc.check("/sessions", Some("localhost:4711"), auth), Ok(()));
        assert_eq!(rc.check("/sessions", Some("LOCALHOST:4711"), auth), Ok(()));
        // DNS rebinding: the attacker's name resolves to 127.0.0.1.
        assert_eq!(rc.check("/sessions", Some("evil.example:4711"), auth), Err((403, "forbidden host")));
        assert_eq!(rc.check("/health", Some("evil.example:4711"), None), Err((403, "forbidden host")));
        assert_eq!(rc.check("/sessions", Some("127.0.0.1:80"), auth), Err((403, "forbidden host")));
        assert_eq!(rc.check("/sessions", None, auth), Err((403, "forbidden host")));
    }

    #[test]
    fn configured_ipv6_host_is_bracketed() {
        let rc = RemoteControl { host: "::1".into(), ..rc() };
        assert!(rc.host_allowed("[::1]:4711"));
        assert!(rc.host_allowed("127.0.0.1:4711"));
        assert!(!rc.host_allowed("::1:4711"));
    }

    #[test]
    fn constant_time_eq_matches_only_equal_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }
}

#[cfg(test)]
mod window_id_tests {
    use super::*;

    #[test]
    fn skips_restored_labels_with_a_fresh_counter() {
        let counter = AtomicU64::new(0);
        let restored = ["main", "w-0", "w-1", "w-3"];
        assert_eq!(next_window_id(&counter, |id| restored.contains(&id)), "w-2");
        assert_eq!(next_window_id(&counter, |id| restored.contains(&id)), "w-4");
    }

    #[test]
    fn concurrent_creators_reserve_distinct_labels() {
        let counter = AtomicU64::new(0);
        let ids = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16).map(|_| {
                scope.spawn(|| next_window_id(&counter, |id| id == "w-0"))
            }).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect::<std::collections::HashSet<_>>()
        });
        assert_eq!(ids.len(), 16);
        assert!(!ids.contains("w-0"));
    }
}

#[cfg(test)]
mod git_status_tests {
    use super::*;

    fn parse(output: &str) -> RepoInfo {
        parse_git_status(output, "r".into(), None, "/r".into(), None).unwrap()
    }

    #[test]
    fn tracking_branch_with_counts() {
        let info = parse("## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!((info.ahead, info.behind), (2, 1));
        assert!(info.dirty);
        assert_eq!(info.untracked, 1);
        assert!(!info.remote_branch_missing);
    }

    #[test]
    fn detached_head_has_no_branch() {
        assert_eq!(parse("## HEAD (no branch)\n").branch, None);
    }

    #[test]
    fn head_prefixed_branch_name_is_a_branch() {
        let info = parse("## HEAD-fix\n");
        assert_eq!(info.branch.as_deref(), Some("HEAD-fix"));
        assert!(info.remote_branch_missing);
    }

    #[test]
    fn unborn_branch_reports_its_name() {
        assert_eq!(parse("## No commits yet on main\n").branch.as_deref(), Some("main"));
        assert_eq!(parse("## Initial commit on master\n").branch.as_deref(), Some("master"));
    }
}
