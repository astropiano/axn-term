//! ACP (Agent Client Protocol) agent pipes: shell-less agent processes —
//! spawned children with piped stdio carrying newline-delimited JSON-RPC.
//! Stdout lines and the exit code go out on `acp-event-<id>`; stderr is
//! inherited so it lands in the app log.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

struct AcpProcess {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
}

static ACP_PROCESSES: LazyLock<Mutex<HashMap<String, AcpProcess>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ACP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum AcpEvent {
    Line { line: String },
    Exit { code: Option<i32> },
}

#[tauri::command]
pub fn acp_spawn(
    app: AppHandle,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // GUI launches inherit launchd's minimal PATH — agent binaries installed
    // per-user (`~/.local/bin/vibe-acp`, Homebrew, npm globals) would not
    // resolve. Reuse the login-shell PATH captured for plugin_exec.
    #[cfg(unix)]
    if let Some(path) = crate::exec::login_shell_path() {
        cmd.env("PATH", path);
    }
    if let Some(dir) = cwd.as_deref() {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn {command}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let id = format!("acp-{}", ACP_COUNTER.fetch_add(1, Ordering::Relaxed));
    ACP_PROCESSES
        .lock()
        .unwrap()
        .insert(id.clone(), AcpProcess { stdin, child });
    let event = format!("acp-event-{id}");
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if app2.emit(&event, AcpEvent::Line { line: l }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let code = ACP_PROCESSES
            .lock()
            .unwrap()
            .get_mut(&id2)
            .and_then(|p| p.child.wait().ok())
            .and_then(|s| s.code());
        ACP_PROCESSES.lock().unwrap().remove(&id2);
        let _ = app2.emit(&event, AcpEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn acp_write(id: String, line: String) -> Result<(), String> {
    let mut map = ACP_PROCESSES.lock().unwrap();
    let p = map.get_mut(&id).ok_or("no such acp process")?;
    writeln!(p.stdin, "{line}").map_err(|e| e.to_string())?;
    p.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_close(id: String) -> Result<(), String> {
    let mut map = ACP_PROCESSES.lock().unwrap();
    if let Some(mut p) = map.remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(())
}
