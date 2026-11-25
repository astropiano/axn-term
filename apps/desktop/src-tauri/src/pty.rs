//! PTY lifecycle and IO: spawn, reader/emitter threads, session map,
//! sub-shell bookkeeping, and the session commands.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use crate::persist::state_dir;
#[cfg(unix)]
use crate::exec::login_shell_path;
use crate::procinfo::process_cwd;
use crate::{AppState, OutputChannels, OutputSink, TRANSPORT_HIGH_WATERMARK};
use tauri::Manager;
#[cfg(unix)]
use crate::control;

pub(crate) type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub(crate) struct Session {
    pub(crate) master: Mutex<Box<dyn MasterPty + Send>>,
    /// Shared so writers can release the session map before blocking I/O.
    pub(crate) writer: PtyWriter,
    /// Keystrokes for this PTY's writer thread (`write_session`): in order,
    /// and never blocking the main thread on a full PTY input buffer.
    pub(crate) input: std::sync::mpsc::Sender<Vec<u8>>,
    /// Output flow control (`pause_session` / `resume_session`).
    pub(crate) flow: Arc<FlowGate>,
    pub(crate) child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub(crate) shell_pid: u32,
    /// Recent decoded output for remote-control `GET /sessions/<id>`;
    /// `None` unless the remote-control server is enabled.
    pub(crate) output: Option<Arc<Mutex<OutputTail>>>,
    /// Set for sub-shell PTYs: the session they belong to. Closing the parent
    /// cascades to its sub-shells. Mutable so a PTY can be promoted to a main
    /// session or detached into its own session after spawn (the exit watcher
    /// reads the live value to decide between `session-exited` and
    /// `subshell-exited`).
    pub(crate) parent_id: Arc<Mutex<Option<String>>>,
}

/// Cap of a session's `OutputTail` in bytes (≤ chars) — the frontend
/// scrollback is capped at 200,000 characters as well.
pub(crate) const OUTPUT_TAIL_MAX: usize = 200_000;
/// PTY read size; the tty layer usually hands out less per read anyway.
pub(crate) const OUTPUT_READ_BUF: usize = 64 * 1024;
/// Upper bound for one coalesced output message.
pub(crate) const OUTPUT_BATCH_MAX: usize = 256 * 1024;
/// Read-ahead between the PTY reader and the emitter, in reads (usually
/// a few KB each).
pub(crate) const OUTPUT_QUEUE_CHUNKS: usize = 64;

/// Waits for the next PTY chunk, then appends whatever else is already
/// queued (up to `OUTPUT_BATCH_MAX`) without waiting for more. `None` once
/// the reader has finished and everything was handed out.
pub(crate) fn next_output_batch(rx: &std::sync::mpsc::Receiver<Vec<u8>>) -> Option<Vec<u8>> {
    let mut batch = rx.recv().ok()?;
    while batch.len() < OUTPUT_BATCH_MAX {
        match rx.try_recv() {
            Ok(more) => batch.extend_from_slice(&more),
            Err(_) => break,
        }
    }
    Some(batch)
}

/// Incremental UTF-8 decoder for raw PTY reads: a multibyte character split
/// across two reads is carried over into the next chunk instead of failing
/// the whole chunk; invalid bytes decode to U+FFFD.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
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
pub(crate) struct OutputTail {
    text: String,
    decoder: Utf8Stream,
}

impl OutputTail {
    pub(crate) fn push_bytes(&mut self, bytes: &[u8]) {
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

    pub(crate) fn as_str(&self) -> &str {
        &self.text
    }
}

/// One output frame: big-endian u16 id length, the session id, the bytes.
/// Raw bytes skip the base64 + JSON + script-eval cost of an event.
pub(crate) fn output_frame(session_id: &str, data: &[u8]) -> Vec<u8> {
    let id = &session_id.as_bytes()[..session_id.len().min(u16::MAX as usize)];
    let mut frame = Vec::with_capacity(2 + id.len() + data.len());
    frame.extend_from_slice(&(id.len() as u16).to_be_bytes());
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    frame
}

pub(crate) fn send_output(channels: &OutputChannels, session_id: &str, data: &[u8]) {
    let frame = output_frame(session_id, data);
    let mut channels = match channels.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    // A failed send drops the channel. Sends to a closed webview still
    // succeed, so `detach_output` drops those on `WindowEvent::Destroyed`.
    channels.retain(|_, sink| {
        sink.unacked += frame.len();
        sink.channel.send(InvokeResponseBody::Raw(frame.clone())).is_ok()
    });
}

/// Forget a closed webview's output channel. Its `unacked` would only grow
/// and make `wait_for_transport` stall every PTY for `FLOW_PAUSE_MAX`.
pub(crate) fn detach_output(channels: &OutputChannels, label: &str) -> bool {
    channels.lock().is_ok_and(|mut c| c.remove(label).is_some())
}

/// Blocks while some webview is more than `TRANSPORT_HIGH_WATERMARK` behind.
/// A webview that stops acknowledging (hung) is let go after
/// `FLOW_PAUSE_MAX` so it cannot stall output for every window.
pub(crate) fn wait_for_transport(channels: &OutputChannels) {
    let start = std::time::Instant::now();
    loop {
        {
            let Ok(mut sinks) = channels.lock() else { return };
            if sinks.values().all(|s| s.unacked <= TRANSPORT_HIGH_WATERMARK) {
                return;
            }
            if start.elapsed() >= FLOW_PAUSE_MAX {
                for sink in sinks.values_mut() {
                    sink.unacked = 0;
                }
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The webview took `bytes` of output off its channel.
#[tauri::command]
pub(crate) async fn ack_output(webview: tauri::Webview, state: State<'_, AppState>, bytes: usize) -> Result<(), String> {
    if let Ok(mut sinks) = state.output_channels.lock() {
        if let Some(sink) = sinks.get_mut(webview.label()) {
            sink.unacked = sink.unacked.saturating_sub(bytes);
        }
    }
    Ok(())
}

/// Called once per webview (the frontend's session backend) before it
/// creates sessions; a reload replaces the window's previous channel.
/// Sync on purpose: it runs in order with `create_session`, so no early
/// output is missed.
#[tauri::command]
pub(crate) fn attach_output(webview: tauri::Webview, state: State<AppState>, channel: Channel<InvokeResponseBody>) {
    if let Ok(mut channels) = state.output_channels.lock() {
        channels.insert(webview.label().to_string(), OutputSink { channel, unacked: 0 });
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct SubshellExited {
    id: String,
    exit_code: Option<u32>,
}

pub(crate) fn resolve_shell(shell: Option<String>) -> String {
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

    default_shell()
}

#[cfg(unix)]
fn default_shell() -> String {
    for fallback in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
        if std::path::Path::new(fallback).exists() {
            return fallback.to_string();
        }
    }

    "/bin/sh".to_string()
}

/// Windows has no `$SHELL`: PowerShell 7 if installed, else the inbox
/// Windows PowerShell, else `%COMSPEC%` (cmd.exe).
#[cfg(windows)]
fn default_shell() -> String {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        candidates.push(std::path::PathBuf::from(pf).join("PowerShell\\7\\pwsh.exe"));
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        candidates.push(
            std::path::PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
        );
    }
    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[tauri::command]
pub(crate) fn get_default_shell() -> String {
    resolve_shell(None)
}

/// How long an exited PTY's exit event waits for its reader to drain the
/// remaining output. A background job that still holds the PTY open keeps
/// the reader from reaching EOF — the exit is reported anyway after this.
pub(crate) const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
/// Upper bound for that wait while output is still flowing.
pub(crate) const READER_DRAIN_MAX: Duration = Duration::from_secs(30);

/// Poll `try_wait` until the child exits, then wait for the reader to hit
/// EOF (all `reader_done` senders dropped). Every message on `reader_done`
/// is a heartbeat — output still going out, which flow control can stretch
/// — and restarts the `drain_timeout` wait, up to `READER_DRAIN_MAX`.
/// Returns the exit code, `None` when the status could not be read.
pub(crate) fn wait_exit_then_drain(
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
    let start = std::time::Instant::now();
    while reader_done.recv_timeout(drain_timeout).is_ok() {
        if start.elapsed() >= READER_DRAIN_MAX {
            break;
        }
    }
    exit_code
}

/// True when `id` now names a different PTY than the one owning `child` —
/// the id was re-spawned, so the old process's exit belongs to nobody.
/// The child handle is the generation token: each spawn has its own.
pub(crate) fn is_superseded(
    sessions: &std::collections::HashMap<String, Session>,
    id: &str,
    child: &Arc<Mutex<Box<dyn Child + Send + Sync>>>,
) -> bool {
    sessions.get(id).is_some_and(|s| !Arc::ptr_eq(&s.child, child))
}

/// Initial PTY size, clamped to a sensible minimum so programs that read the
/// PTY size (e.g. Terminal.Gui's ansi driver) don't start with a 0x0 screen.
pub(crate) fn initial_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
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
pub(crate) fn spawn_pty(
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
    if crate::devhmr::enabled() {
        if let Ok(dir) = crate::devhmr::control_dir() {
            cmd.env("AXN_TERM_CONTROL_DIR", dir);
        }
    }
    // `axn-term session …` from inside this terminal authenticates as this
    // PTY with the secret (control.rs); AXN_TERM_CLI finds the binary even
    // when the .app is not on PATH.
    #[cfg(unix)]
    if let Some(control) = app.try_state::<Arc<control::ControlState>>() {
        match control.mint_secret(&session_id) {
            Ok(secret) => {
                cmd.env("AXN_TERM_PTY_SECRET", secret);
            }
            Err(e) => log::warn!("control: no secret for {}: {}", session_id, e),
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("AXN_TERM_CLI", exe);
    }
    if cmd.get_env("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(cwd) = cwd {
        let path = std::path::PathBuf::from(&cwd);
        if path.is_dir() {
            cmd.cwd(path);
            cmd.env("PWD", &cwd);
        } else if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        } else {
            cmd.cwd(std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")));
        }
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    } else {
        cmd.cwd(std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")));
    }

    #[cfg(windows)]
    expand_subshell_command(&mut cmd);
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

    let writer: PtyWriter = Arc::new(Mutex::new(writer));
    let input = spawn_input_writer(Arc::clone(&writer));
    let flow = Arc::new(FlowGate::default());
    let emitter_flow = Arc::clone(&flow);

    let parent_link = Arc::new(Mutex::new(parent_id));
    let session = Session {
        master: Mutex::new(pair.master),
        writer,
        input,
        flow,
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
    // The emitter also sends a heartbeat per batch (one slot: a stale one
    // is dropped, so nothing piles up over a session's lifetime).
    let (reader_done_tx, reader_done_rx) = std::sync::mpsc::sync_channel::<()>(1);

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
        // Re-run under the same id (create_subshell): the map now holds a
        // newer PTY, and this exit must not be reported as its exit.
        if let Some(state) = exit_handle.try_state::<AppState>() {
            if let Ok(sessions) = state.sessions.lock() {
                if is_superseded(&sessions, &session_id_exit, &child_for_exit) {
                    return;
                }
            }
        }
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

    // The reader only reads; a separate emitter thread sends the output to
    // the webviews. While a send is in flight, further reads pile up in the
    // queue and go out together in the next message, so a burst (`cat` of a
    // big file) becomes a few large messages instead of thousands of 4 KB
    // ones — without delaying a lone keystroke echo.
    // Bounded: while the emitter is paused (flow control) the reader stops,
    // the kernel PTY buffer fills and the producing process blocks.
    let (chunk_tx, chunk_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE_CHUNKS);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; OUTPUT_READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if chunk_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let session_id_emitter = session_id;
    let channels = Arc::clone(&state.output_channels);
    std::thread::spawn(move || {
        loop {
            emitter_flow.wait_open(FLOW_PAUSE_MAX);
            let Some(batch) = next_output_batch(&chunk_rx) else { break };
            wait_for_transport(&channels);
            if let Some(Ok(mut out)) = reader_output.as_ref().map(|o| o.lock()) {
                out.push_bytes(&batch);
            }
            send_output(&channels, &session_id_emitter, &batch);
            let _ = reader_done_tx.try_send(());
        }
        // Dropped only after the last output went out, so the exit watcher
        // never reports the exit ahead of it.
        drop(reader_done_tx);
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn create_session(
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
pub(crate) fn create_subshell(
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
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // A live PTY under this id is attached to, not respawned (e.g. a
        // demoted main shell shown as a sub-shell tab). Refresh its parent
        // link so exit reporting follows the current owner.
        if let Some(existing) = sessions.get(&subshell_id) {
            if matches!(existing.child.lock().unwrap().try_wait(), Ok(None)) {
                *existing.parent_id.lock().unwrap() = Some(parent_session_id);
                return Ok(());
            }
        }
        // Re-spawning an existing id (re-run) replaces the dead child. It
        // stays in the map until spawn_pty's insert replaces it, so its exit
        // watcher never sees the id vacant and reports a stale exit.
        if let Some(old) = sessions.get(&subshell_id) {
            old.flow.set_paused(false);
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
            #[cfg(unix)]
            let mut c = CommandBuilder::new("sh");
            #[cfg(unix)]
            c.arg("-c");
            #[cfg(unix)]
            c.arg(command);
            #[cfg(windows)]
            let c = windows_cmd(&command);
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

/// Env var that carries a sub-shell's command line to `cmd /C`.
#[cfg(any(windows, test))]
const SUBSHELL_COMMAND_VAR: &str = "AXN_TERM_SUBSHELL_COMMAND";

/// `cmd /C <command>` with the line passed verbatim. portable-pty quotes
/// every argument Windows-style (`\"`), which cmd.exe does not unescape, and
/// has no raw argument. So the line goes in an env var that cmd expands
/// before parsing it (`expand_subshell_command` does the line's own
/// `%VAR%` references first).
#[cfg(any(windows, test))]
fn windows_cmd(command: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new("cmd");
    c.arg("/C");
    c.arg(format!("%{}%", SUBSHELL_COMMAND_VAR));
    c.env(SUBSHELL_COMMAND_VAR, command);
    c
}

/// Expand `%VAR%` in a `windows_cmd` line against the final environment,
/// as cmd would have when given the line directly.
#[cfg(any(windows, test))]
fn expand_subshell_command(cmd: &mut CommandBuilder) {
    let Some(line) = cmd.get_env(SUBSHELL_COMMAND_VAR) else { return };
    let line = line.to_string_lossy().into_owned();
    let expanded = expand_cmd_vars(&line, |name| {
        cmd.get_env(name).map(|v| v.to_string_lossy().into_owned())
    });
    cmd.env(SUBSHELL_COMMAND_VAR, expanded);
}

/// cmd.exe's command-line `%NAME%` expansion: defined names are replaced,
/// anything else is kept as typed.
#[cfg(any(windows, test))]
fn expand_cmd_vars(line: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => match Some(&after[..end]).filter(|n| !n.is_empty()).and_then(&lookup) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                // Not a variable: keep this `%`, the next one may open one.
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The session's PTY writer, cloned out of the session map so the map lock
/// is released before the write: `write_all` blocks once the PTY input
/// buffer is full (child not reading) and must not stall every other
/// session command meanwhile.
pub(crate) fn session_writer(state: &AppState, session_id: &str) -> Result<PtyWriter, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(session_id).ok_or("session not found")?;
    Ok(Arc::clone(&session.writer))
}

pub(crate) fn session_shell_pid(state: &AppState, session_id: &str) -> Result<u32, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(session_id).ok_or("session not found")?;
    Ok(session.shell_pid)
}

/// Run `f` against the app state on the blocking pool — for commands that
/// spawn `ps`/`lsof` and must neither run on the main thread nor hold the
/// session map while they wait.
pub(crate) async fn with_state_blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(app.state::<AppState>().inner()))
        .await
        .map_err(|e| e.to_string())?
}

/// Lets the frontend stop reading a PTY while its terminal is behind, so a
/// flood (`seq 1 1000000000`, a runaway log) blocks the producer instead of
/// piling megabytes into xterm — Ctrl-C then takes effect on screen at once.
/// A pause lifts by itself after `FLOW_PAUSE_MAX`, so a frontend that never
/// resumes cannot hang a session for good.
#[derive(Default)]
pub(crate) struct FlowGate {
    paused: Mutex<bool>,
    cv: std::sync::Condvar,
}

pub(crate) const FLOW_PAUSE_MAX: Duration = Duration::from_secs(5);

impl FlowGate {
    pub(crate) fn set_paused(&self, paused: bool) {
        if let Ok(mut p) = self.paused.lock() {
            *p = paused;
        }
        self.cv.notify_all();
    }

    /// Blocks while paused, at most `max`.
    pub(crate) fn wait_open(&self, max: Duration) {
        let Ok(mut paused) = self.paused.lock() else { return };
        let deadline = std::time::Instant::now() + max;
        while *paused {
            let now = std::time::Instant::now();
            if now >= deadline {
                *paused = false;
                break;
            }
            paused = match self.cv.wait_timeout(paused, deadline - now) {
                Ok((guard, _)) => guard,
                Err(_) => return,
            };
        }
    }
}

#[tauri::command]
pub(crate) fn pause_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    set_session_paused(&state, &session_id, true)
}

#[tauri::command]
pub(crate) fn resume_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    set_session_paused(&state, &session_id, false)
}

pub(crate) fn set_session_paused(state: &AppState, session_id: &str, paused: bool) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(session_id).ok_or("session not found")?;
    session.flow.set_paused(paused);
    Ok(())
}

/// Writes queued keystrokes to the PTY in order. Ends once the session is
/// dropped (its sender goes away).
pub(crate) fn spawn_input_writer(writer: PtyWriter) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in rx {
            let Ok(mut w) = writer.lock() else { break };
            let _ = w.write_all(&data).and_then(|_| w.flush());
        }
    });
    tx
}

// Stays a synchronous command so keystrokes keep their order, but only
// queues: a large paste into a process that isn't reading would otherwise
// block the main thread (and with it every window) until the PTY drains.
#[tauri::command]
pub(crate) fn write_session(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&session_id).ok_or("session not found")?;
    session
        .input
        .send(data.into_bytes())
        .map_err(|_| "session closed".to_string())
}

/// Write once the slave tty has entered raw mode (ECHO or ICANON cleared).
/// Emulator replies to queries — OSC 10/11/12 color reports, DA/CPR answers —
/// must not land while the tty is still cooked+echo or the kernel echoes
/// them as visible text and the canonical line buffer flushes them into the
/// asker's input at the next mode flip. Waiting on termios is deterministic;
/// a timer is not (a TUI still loading past the delay leaks the reply).
/// Resolves only once the write happened (or was dropped at the cap) so the
/// caller's ordered input queue can hold later replies — devin's DA1
/// sentinel — behind it. `timeout_ms` bounds the wait (default 4 s).
#[cfg(unix)]
#[tauri::command]
pub(crate) async fn write_when_raw(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
    timeout_ms: Option<u64>,
) -> Result<bool, String> {
    let (fd, input) = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&session_id).ok_or("session not found")?;
        let fd = session.master.lock().map_err(|e| e.to_string())?.as_raw_fd();
        (fd, session.input.clone())
    };
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(4_000));
    tauri::async_runtime::spawn_blocking(move || {
        write_when_slave_raw(fd, timeout, move || {
            let _ = input.send(data.into_bytes());
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Poll the slave's termios until it leaves cooked+echo mode (ECHO or ICANON
/// cleared), then run `write`. An OSC color report only has a useful reader
/// on a raw tty — if `timeout` expires while the slave is still cooked, the
/// write is DROPPED: the asker either exited (the shell would echo the reply
/// as `11;rgb:…` into its input line) or never went raw (same echo inside a
/// cooked program's input). Unreadable termios (fd gone / not a tty) still
/// writes — there is no cooked line to corrupt. Split out of
/// `write_when_raw` so the gate can be exercised against a real PTY in tests.
/// Returns whether `write` ran — false when the slave was still cooked at the
/// deadline and the report was dropped.
#[cfg(unix)]
fn write_when_slave_raw(
    raw_fd: Option<std::os::fd::RawFd>,
    timeout: std::time::Duration,
    write: impl FnOnce(),
) -> bool {
    use nix::sys::termios::{LocalFlags, tcgetattr};
    use std::os::fd::BorrowedFd;

    if let Some(raw_fd) = raw_fd {
        let deadline = std::time::Instant::now() + timeout;
        let mut cooked = true;
        while cooked && std::time::Instant::now() < deadline {
            let borrowed = unsafe { BorrowedFd::borrow_raw(raw_fd) };
            match tcgetattr(borrowed) {
                Ok(t) if !t.local_flags.contains(LocalFlags::ECHO)
                    || !t.local_flags.contains(LocalFlags::ICANON) => cooked = false,
                Ok(_) => std::thread::sleep(std::time::Duration::from_millis(15)),
                Err(_) => cooked = false, // fd gone or not a tty — write anyway
            }
        }
        if cooked {
            return false; // still cooked at the deadline — drop the report
        }
    }
    write();
    true
}

#[tauri::command]
pub(crate) fn resize_session(
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


/// Re-parent (or detach, with `parent_id: None`) a PTY after spawn. Used when
/// a sub-shell is promoted to the session's main shell (the old main shell is
/// demoted to a sub-shell) or when a sub-shell is turned into its own session.
/// The exit watcher reads the link at exit time, so this also switches which
/// exit event the PTY emits.
#[tauri::command]
pub(crate) fn set_subshell_parent(
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
pub(crate) fn close_session(app: AppHandle, state: State<AppState>, session_id: String) -> Result<(), String> {
    let closed = take_session_tree(&state, &session_id)?;
    for (id, session) in closed {
        // The terminal's control secret must not outlive it.
        #[cfg(unix)]
        if let Some(control) = app.try_state::<Arc<control::ControlState>>() {
            control.forget(&id);
        }
        #[cfg(not(unix))]
        let _ = (&app, id);
        end_session(session);
    }
    Ok(())
}

/// Remove a session and its sub-shells — transitively, a sub-shell's own
/// sub-shells included (they die with it) — from the map.
pub(crate) fn take_session_tree(state: &AppState, session_id: &str) -> Result<Vec<(String, Session)>, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if !sessions.contains_key(session_id) {
        return Err("session not found".to_string());
    }
    let mut taken = vec![session_id.to_string()];
    let mut next = 0;
    while next < taken.len() {
        let parent = taken[next].clone();
        next += 1;
        for (id, s) in sessions.iter() {
            if s.parent_id.lock().unwrap().as_deref() == Some(parent.as_str()) && !taken.contains(id) {
                taken.push(id.clone());
            }
        }
    }
    Ok(taken
        .into_iter()
        .filter_map(|id| sessions.remove(&id).map(|s| (id, s)))
        .collect())
}

/// Kill every session still in the map — SIGHUP, SIGKILL after
/// `CLOSE_GRACE` — and wait for the kill passes to land (≤ `CLOSE_GRACE`,
/// the killers run concurrently). Called on every process-exit path so no
/// PTY child outlives the app: a window destroyed without React teardown,
/// or a frontend the watchdogs had to bypass, would otherwise leave its
/// shells running as orphans reparented to init.
pub(crate) fn kill_all_sessions(state: &AppState) {
    let sessions: Vec<Session> = match state.sessions.lock() {
        Ok(mut map) => map.drain().map(|(_, s)| s).collect(),
        Err(_) => return,
    };
    if sessions.is_empty() {
        return;
    }
    log::info!("killing {} leftover session PTY(s) before exit", sessions.len());
    let waits: Vec<_> = sessions.into_iter().map(end_session).collect();
    for wait in waits {
        let _ = wait.join();
    }
}

/// How long a closed session's processes get to exit after SIGHUP.
#[cfg(unix)]
pub(crate) const CLOSE_GRACE: Duration = Duration::from_millis(500);

/// End a removed session for good, off the calling thread. The reader holds
/// its own copy of the PTY master, so the terminal is never hung up by the
/// kernel: a shell or job that ignores SIGHUP would keep it streaming. So
/// SIGHUP the shell and the foreground job, then SIGKILL their process
/// groups after `CLOSE_GRACE`.
pub(crate) fn end_session(session: Session) -> std::thread::JoinHandle<()> {
    // A paused reader must drain to EOF so the exit is reported.
    session.flow.set_paused(false);
    #[cfg(unix)]
    let foreground = session.master.lock().ok().and_then(|m| m.process_group_leader());
    let child = Arc::clone(&session.child);
    #[cfg(unix)]
    let shell_pid = session.shell_pid;
    drop(session);
    std::thread::spawn(move || {
        #[cfg(unix)]
        hang_up(&child, shell_pid, foreground, CLOSE_GRACE);
        #[cfg(not(unix))]
        let _ = child.lock().map(|mut c| c.kill());
    })
}

#[cfg(unix)]
fn hang_up(
    child: &Mutex<Box<dyn Child + Send + Sync>>,
    shell_pid: u32,
    foreground: Option<i32>,
    grace: Duration,
) {
    use nix::sys::signal::{kill, killpg, Signal};
    use nix::unistd::Pid;
    let running = || matches!(child.lock().map(|mut c| c.try_wait()), Ok(Ok(None)));
    let shell = (shell_pid > 0).then(|| Pid::from_raw(shell_pid as i32));
    let foreground = foreground.filter(|&g| g > 0).map(Pid::from_raw);
    // The shell's own group holds its children when job control is off.
    let groups: Vec<Pid> = shell.into_iter().chain(foreground).collect();
    if let Some(shell) = shell.filter(|_| running()) {
        let _ = kill(shell, Signal::SIGHUP);
    }
    if let Some(fg) = foreground.filter(|&g| Some(g) != shell) {
        let _ = killpg(fg, Signal::SIGHUP);
    }
    let alive = || running() || groups.iter().any(|&g| killpg(g, None).is_ok());
    let deadline = std::time::Instant::now() + grace;
    while alive() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !alive() {
        return;
    }
    for &group in &groups {
        let _ = killpg(group, Signal::SIGKILL);
    }
    if running() {
        let _ = child.lock().map(|mut c| c.kill());
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
                input: std::sync::mpsc::channel().0,
                flow: Default::default(),
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
    fn exit_keeps_waiting_while_output_still_flows() {
        let (tx, rx) = channel::<()>();
        let emitter = std::thread::spawn(move || {
            // Heartbeats for 300 ms — longer than the drain timeout — then EOF.
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(50));
                tx.send(()).unwrap();
            }
        });
        let start = Instant::now();
        wait_exit_then_drain(|| Ok(Some(0)), &rx, Duration::from_millis(1), Duration::from_millis(120));
        emitter.join().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(280));
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
mod output_batch_tests {
    use super::{next_output_batch, output_frame, OUTPUT_BATCH_MAX};

    #[test]
    fn an_output_frame_carries_the_session_id_then_the_bytes() {
        let frame = output_frame("s-1", b"hi");
        assert_eq!(frame, [&[0u8, 3][..], b"s-1", b"hi"].concat());
    }

    #[test]
    fn queued_chunks_go_out_together_in_order() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(b"ab".to_vec()).unwrap();
        tx.send(b"cd".to_vec()).unwrap();
        tx.send(b"e".to_vec()).unwrap();
        assert_eq!(next_output_batch(&rx).unwrap(), b"abcde");
        drop(tx);
        assert!(next_output_batch(&rx).is_none());
    }

    #[test]
    fn a_batch_stops_growing_at_the_cap() {
        let (tx, rx) = std::sync::mpsc::channel();
        for _ in 0..5 {
            tx.send(vec![b'x'; OUTPUT_BATCH_MAX / 2]).unwrap();
        }
        drop(tx);
        let mut sizes = Vec::new();
        while let Some(b) = next_output_batch(&rx) {
            sizes.push(b.len());
        }
        assert_eq!(sizes, vec![OUTPUT_BATCH_MAX, OUTPUT_BATCH_MAX, OUTPUT_BATCH_MAX / 2]);
    }
}


#[cfg(test)]
mod input_writer_tests {
    use super::spawn_input_writer;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn queued_keystrokes_reach_the_pty_in_order() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer: super::PtyWriter = Arc::new(Mutex::new(Box::new(Sink(Arc::clone(&seen)))));
        let tx = spawn_input_writer(writer);
        for key in ["l", "s", " ", "-", "l", "\r"] {
            tx.send(key.as_bytes().to_vec()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while seen.lock().unwrap().len() < 6 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(&*seen.lock().unwrap(), b"ls -l\r");
    }
}


#[cfg(test)]
mod flow_gate_tests {
    use super::FlowGate;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn an_open_gate_does_not_block() {
        let gate = FlowGate::default();
        let t = Instant::now();
        gate.wait_open(Duration::from_secs(5));
        assert!(t.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn resume_releases_a_waiting_reader() {
        let gate = Arc::new(FlowGate::default());
        gate.set_paused(true);
        let g = Arc::clone(&gate);
        let waiter = std::thread::spawn(move || {
            let t = Instant::now();
            g.wait_open(Duration::from_secs(10));
            t.elapsed()
        });
        std::thread::sleep(Duration::from_millis(100));
        gate.set_paused(false);
        let waited = waiter.join().unwrap();
        assert!(waited >= Duration::from_millis(90) && waited < Duration::from_secs(5));
    }

    #[test]
    fn a_pause_lifts_by_itself_after_the_limit() {
        let gate = FlowGate::default();
        gate.set_paused(true);
        let t = Instant::now();
        gate.wait_open(Duration::from_millis(150));
        assert!(t.elapsed() >= Duration::from_millis(140));
        assert!(!*gate.paused.lock().unwrap());
    }
}


#[cfg(test)]
mod output_sink_tests {
    use super::*;
    use std::time::Instant;

    fn sink() -> OutputSink {
        OutputSink { channel: Channel::new(|_| Ok(())), unacked: 0 }
    }

    #[test]
    fn a_closed_window_no_longer_holds_up_output() {
        let channels: OutputChannels = Arc::default();
        channels.lock().unwrap().insert("main".into(), sink());
        channels.lock().unwrap().insert("w-1".into(), sink());
        // Both webviews fall behind; only `main` keeps acknowledging.
        send_output(&channels, "s", &vec![b'x'; TRANSPORT_HIGH_WATERMARK + 1]);
        channels.lock().unwrap().get_mut("main").unwrap().unacked = 0;

        // w-1 was closed: sends still succeed, so only detaching drops it.
        assert!(detach_output(&channels, "w-1"));
        assert!(!detach_output(&channels, "w-1"));
        let start = Instant::now();
        wait_for_transport(&channels);
        assert!(start.elapsed() < Duration::from_millis(500));
        assert_eq!(channels.lock().unwrap().keys().collect::<Vec<_>>(), ["main"]);
    }
}


#[cfg(all(test, unix))]
mod close_tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn spawn(script: &str, parent: Option<&str>) -> (Session, Box<dyn Read + Send>) {
        let pair = native_pty_system().openpty(initial_pty_size(None, None)).unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", script]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let shell_pid = child.process_id().unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let session = Session {
            master: Mutex::new(pair.master),
            writer: Arc::new(Mutex::new(writer)),
            input: channel().0,
            flow: Default::default(),
            child: Arc::new(Mutex::new(child)),
            shell_pid,
            output: None,
            parent_id: Arc::new(Mutex::new(parent.map(String::from))),
        };
        (session, reader)
    }

    /// Reads until EOF/EIO on a thread; `Ok` once nothing holds the terminal.
    fn eof(mut reader: Box<dyn Read + Send>, until: &str) -> std::sync::mpsc::Receiver<()> {
        let (seen_tx, seen_rx) = channel();
        let (eof_tx, eof_rx) = channel();
        let until = until.to_string();
        std::thread::spawn(move || {
            let mut text = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        text.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if text.contains(&until) {
                            let _ = seen_tx.send(());
                        }
                    }
                }
            }
            let _ = eof_tx.send(());
        });
        seen_rx.recv_timeout(Duration::from_secs(10)).expect("shell never started");
        eof_rx
    }

    #[test]
    fn a_shell_and_job_ignoring_sighup_still_end() {
        // `trap '' HUP` is inherited by `sleep`, which also holds the tty.
        let (session, reader) = spawn("trap '' HUP; echo ready; sleep 100; :", None);
        let done = eof(reader, "ready");
        end_session(session).join().unwrap();
        done.recv_timeout(Duration::from_secs(5)).expect("terminal still held open");
    }

    #[test]
    fn kill_all_sessions_empties_the_map_and_ends_every_process() {
        let state = AppState::new(false);
        let mut done = Vec::new();
        for (id, parent) in [("a", None), ("a-sub", Some("a")), ("b", None)] {
            let (session, reader) = spawn("echo ready; sleep 100", parent);
            done.push(eof(reader, "ready"));
            state.sessions.lock().unwrap().insert(id.into(), session);
        }
        kill_all_sessions(&state);
        assert!(state.sessions.lock().unwrap().is_empty());
        // Dead children close the slave side — every reader hits EOF/EIO.
        for rx in done {
            rx.recv_timeout(Duration::from_secs(5)).expect("terminal still held open");
        }
    }

    #[test]
    fn a_respawned_id_supersedes_the_old_child() {
        let mut sessions = std::collections::HashMap::new();
        let (old, _) = spawn("sleep 100", Some("p"));
        let old_child = Arc::clone(&old.child);
        sessions.insert("t".to_string(), old);
        assert!(!is_superseded(&sessions, "t", &old_child));
        let (new, _) = spawn("sleep 100", Some("p"));
        let replaced = sessions.insert("t".to_string(), new).unwrap();
        assert!(is_superseded(&sessions, "t", &old_child));
        // A closed id (not in the map) still reports its exit.
        let current = sessions.remove("t").unwrap();
        assert!(!is_superseded(&sessions, "t", &old_child));
        for session in [replaced, current] {
            end_session(session).join().unwrap();
        }
    }

    #[test]
    fn closing_takes_the_sub_shells_and_nothing_else() {
        let state = AppState::new(false);
        for (id, parent) in [
            ("a", None),
            ("a-sub", Some("a")),
            ("a-sub-sub", Some("a-sub")),
            ("b", None),
            ("b-sub", Some("b")),
        ] {
            let (session, _) = spawn("sleep 100", parent);
            state.sessions.lock().unwrap().insert(id.into(), session);
        }
        assert!(take_session_tree(&state, "missing").is_err());
        let mut closed: Vec<_> = take_session_tree(&state, "a").unwrap();
        closed.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(closed.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["a", "a-sub", "a-sub-sub"]);
        let mut left: Vec<_> = state.sessions.lock().unwrap().keys().cloned().collect();
        left.sort();
        assert_eq!(left, ["b", "b-sub"]);
        let rest: Vec<_> = state.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for session in closed.into_iter().map(|(_, s)| s).chain(rest) {
            end_session(session).join().unwrap();
        }
    }
}


#[cfg(test)]
mod windows_cmd_tests {
    use super::*;

    #[test]
    fn the_command_reaches_cmd_unquoted() {
        let c = windows_cmd(r#"echo "hi" && dir "C:\Program Files\""#);
        let argv: Vec<_> = c.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // No spaces or quotes: portable-pty passes these through as they are.
        assert_eq!(argv, ["cmd", "/C", "%AXN_TERM_SUBSHELL_COMMAND%"]);
        assert!(argv.iter().all(|a| !a.contains([' ', '"', '\t'])));
        assert_eq!(
            c.get_env(SUBSHELL_COMMAND_VAR).unwrap().to_string_lossy(),
            r#"echo "hi" && dir "C:\Program Files\""#
        );
    }

    #[test]
    fn the_line_expands_against_the_final_environment() {
        let mut c = windows_cmd("cd %AXN_SESSION_PWD% & echo %NOPE%");
        c.env("AXN_SESSION_PWD", "C:\\work");
        expand_subshell_command(&mut c);
        assert_eq!(c.get_env(SUBSHELL_COMMAND_VAR).unwrap().to_string_lossy(), "cd C:\\work & echo %NOPE%");
    }

    #[test]
    fn percent_references_expand_like_cmd() {
        let lookup = |name: &str| (name == "HOME").then(|| "C:\\Users\\me".to_string());
        assert_eq!(expand_cmd_vars("cd %HOME% && echo ok", lookup), "cd C:\\Users\\me && echo ok");
        assert_eq!(expand_cmd_vars("50% off %HOME%", lookup), "50% off C:\\Users\\me");
        assert_eq!(expand_cmd_vars("%NOPE% %% 100%", lookup), "%NOPE% %% 100%");
    }
}

#[cfg(all(test, unix))]
mod raw_gate_tests {
    use super::*;
    use nix::sys::termios::{LocalFlags, SetArg, tcgetattr, tcsetattr};
    use portable_pty::PtySize;
    use std::io::{Read, Write};
    use std::os::fd::{BorrowedFd, RawFd};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
    use std::time::{Duration, Instant};

    /// What xterm.js answers to `OSC 11 ; ?` — the bytes devin's query echoes
    /// at the prompt when they land while the tty is still cooked+echo.
    const OSC11_REPORT: &[u8] = b"\x1b]11;rgb:fdfd/f6f6/e3e3\x07";
    const SIZE: PtySize = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };

    fn spawn_reader(mut reader: Box<dyn Read + Send>) -> Receiver<Vec<u8>> {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        rx
    }

    /// Termios is a property of the pty line — flipping it via the master fd
    /// is exactly what `write_when_slave_raw` polls on.
    fn go_raw(master_fd: RawFd) {
        let borrowed = unsafe { BorrowedFd::borrow_raw(master_fd) };
        let mut t = tcgetattr(borrowed).unwrap();
        t.local_flags.remove(LocalFlags::ECHO | LocalFlags::ICANON);
        tcsetattr(borrowed, SetArg::TCSANOW, &t).unwrap();
    }

    /// Control: proves the rig reproduces the bug — a report written while the
    /// slave is cooked+echo IS echoed back by the kernel as visible text.
    #[test]
    fn cooked_tty_echoes_the_report_back() {
        let pair = native_pty_system().openpty(SIZE).unwrap();
        let _slave = pair.slave; // keep the slave fd open so the line stays cooked
        let output = spawn_reader(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();

        writer.write_all(OSC11_REPORT).unwrap();

        let echoed = output
            .recv_timeout(Duration::from_secs(2))
            .expect("cooked+echo tty must echo input back");
        assert!(
            String::from_utf8_lossy(&echoed).contains("rgb:"),
            "expected the kernel echo of the report, got {echoed:?}"
        );
    }

    /// The gate: while the slave stays cooked the write is held; once it goes
    /// raw the write lands — and because ECHO is cleared, nothing is echoed.
    #[test]
    fn gated_write_waits_for_raw_mode_and_is_not_echoed() {
        let pair = native_pty_system().openpty(SIZE).unwrap();
        let _slave = pair.slave;
        let master_fd = pair.master.as_raw_fd();
        let output = spawn_reader(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();

        let (wrote_tx, wrote_rx) = channel();
        let gate = std::thread::spawn(move || {
            write_when_slave_raw(master_fd, Duration::from_secs(4), move || {
                writer.write_all(OSC11_REPORT).unwrap();
                let _ = wrote_tx.send(());
            });
        });

        // Held while cooked: neither the write nor a kernel echo shows up.
        assert_eq!(wrote_rx.recv_timeout(Duration::from_millis(300)), Err(RecvTimeoutError::Timeout));
        assert_eq!(output.recv_timeout(Duration::from_millis(150)), Err(RecvTimeoutError::Timeout));

        go_raw(master_fd.unwrap());

        wrote_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("gate must release once the tty is raw");
        // ECHO is cleared in raw mode — the report must NOT come back.
        assert_eq!(
            output.recv_timeout(Duration::from_millis(400)),
            Err(RecvTimeoutError::Timeout),
            "report echoed back despite raw mode"
        );
        gate.join().unwrap();
    }

    /// A tty still cooked at the deadline drops the write — a report with no
    /// raw reader would only be echoed back as visible text.
    #[test]
    fn gated_write_drops_after_the_deadline() {
        let pair = native_pty_system().openpty(SIZE).unwrap();
        let _slave = pair.slave;
        let master_fd = pair.master.as_raw_fd();

        let (wrote_tx, wrote_rx) = channel();
        let start = Instant::now();
        write_when_slave_raw(master_fd, Duration::from_millis(120), move || {
            let _ = wrote_tx.send(());
        });
        assert_eq!(
            wrote_rx.recv_timeout(Duration::from_secs(1)),
            Err(RecvTimeoutError::Disconnected),
            "a report into a still-cooked tty must be dropped"
        );
        assert!(start.elapsed() >= Duration::from_millis(100), "dropped before the deadline?");
    }

    /// No fd (backend could not resolve one) → write immediately.
    #[test]
    fn gated_write_with_no_fd_writes_immediately() {
        let (wrote_tx, wrote_rx) = channel();
        write_when_slave_raw(None, Duration::from_secs(4), move || {
            let _ = wrote_tx.send(());
        });
        assert!(wrote_rx.recv_timeout(Duration::from_millis(50)).is_ok());
    }
}
