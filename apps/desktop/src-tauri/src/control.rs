//! Local control socket — lets programs running inside an axn-term terminal
//! (an agent's Bash tool, a script) run `axn-*` commands for *their own*
//! session without typing into the PTY, which only works at a bare prompt.
//!
//! Every PTY is spawned with `AXN_TERM_PTY_ID` plus a random per-PTY
//! `AXN_TERM_PTY_SECRET`. `axn-term session …` sends both together with the
//! command line to `$AXN_TERM_STATE_DIR/control.sock` (mode 0600). The app
//! checks the secret against the one it minted for that PTY, then hands the
//! line to the frontend's hidden/plugin command dispatch (`control-command`
//! event); the window owning the PTY answers through `control_reply`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub const SOCKET_NAME: &str = "control.sock";
/// How long a request waits for the owning window's answer.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on one request line — a command line, not a payload channel.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
pub struct ControlRequest {
    pub pty: String,
    pub secret: String,
    pub line: String,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Clone)]
pub struct ControlReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ControlReply {
    fn error(msg: &str) -> Self {
        Self { ok: false, message: None, error: Some(msg.to_string()) }
    }
}

/// Minted PTY secrets and the requests waiting for a frontend answer.
#[derive(Default)]
pub struct ControlState {
    secrets: Mutex<HashMap<String, String>>,
    waiters: Mutex<HashMap<u64, mpsc::Sender<ControlReply>>>,
    next_id: AtomicU64,
}

impl ControlState {
    /// A fresh secret for a PTY about to spawn (replaces an earlier one).
    pub fn mint_secret(&self, pty_id: &str) -> Result<String, String> {
        let secret = random_hex(16)?;
        self.secrets
            .lock()
            .map_err(|e| e.to_string())?
            .insert(pty_id.to_string(), secret.clone());
        Ok(secret)
    }

    pub fn verify(&self, pty_id: &str, secret: &str) -> bool {
        let Ok(secrets) = self.secrets.lock() else { return false };
        match secrets.get(pty_id) {
            Some(known) => constant_time_eq(known.as_bytes(), secret.as_bytes()),
            None => false,
        }
    }

    fn register(&self) -> (u64, mpsc::Receiver<ControlReply>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.insert(id, tx);
        }
        (id, rx)
    }

    fn unregister(&self, id: u64) {
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.remove(&id);
        }
    }

    /// Deliver the frontend's answer; false when nobody waits (late/duplicate).
    pub fn reply(&self, id: u64, reply: ControlReply) -> bool {
        let tx = self.waiters.lock().ok().and_then(|mut w| w.remove(&id));
        tx.map(|tx| tx.send(reply).is_ok()).unwrap_or(false)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("no randomness: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn socket_path(state_dir: &Path) -> PathBuf {
    state_dir.join(SOCKET_NAME)
}

/// Bind the socket (replacing a stale one) and serve requests on threads.
/// `dispatch(request_id, pty_id, line)` hands a verified line to the
/// frontend, which answers via `ControlState::reply`.
pub fn serve<F>(
    path: &Path,
    state: Arc<ControlState>,
    timeout: Duration,
    dispatch: F,
) -> Result<(), String>
where
    F: Fn(u64, &str, &str) + Send + Sync + 'static,
{
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    let dispatch = Arc::new(dispatch);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = state.clone();
            let dispatch = dispatch.clone();
            std::thread::spawn(move || handle(stream, &state, timeout, &*dispatch));
        }
    });
    Ok(())
}

fn handle(stream: UnixStream, state: &ControlState, timeout: Duration, dispatch: &dyn Fn(u64, &str, &str)) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    let reply = match BufReader::new((&stream).take(MAX_REQUEST_BYTES)).read_line(&mut line) {
        Err(_) | Ok(0) => ControlReply::error("empty request"),
        Ok(_) => match serde_json::from_str::<ControlRequest>(&line) {
            Err(_) => ControlReply::error("malformed request"),
            Ok(req) if !state.verify(&req.pty, &req.secret) => {
                ControlReply::error("unknown terminal — run this inside an axn-term session")
            }
            Ok(req) => {
                let (id, rx) = state.register();
                dispatch(id, &req.pty, &req.line);
                let reply = rx
                    .recv_timeout(timeout)
                    .unwrap_or_else(|_| ControlReply::error("no axn-term window answered"));
                state.unregister(id);
                reply
            }
        },
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    out.push('\n');
    let _ = (&stream).write_all(out.as_bytes());
}

/// Client side (`axn-term session …`): one request, one reply line.
pub fn send(path: &Path, req: &ControlRequest) -> Result<ControlReply, String> {
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("cannot reach axn-term at {}: {e}", path.display()))?;
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(2)));
    let mut body = serde_json::to_string(req).map_err(|e| e.to_string())?;
    body.push('\n');
    stream.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| format!("bad reply from axn-term: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_socket(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("axn-ctl-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(SOCKET_NAME)
    }

    #[test]
    fn verified_lines_reach_dispatch_and_the_reply_comes_back() {
        let path = temp_socket("ok");
        let state = Arc::new(ControlState::default());
        let secret = state.mint_secret("pty-1").unwrap();
        let answering = state.clone();
        serve(&path, state.clone(), REPLY_TIMEOUT, move |id, pty, line| {
            assert_eq!(pty, "pty-1");
            answering.reply(id, ControlReply { ok: true, message: Some(line.to_string()), error: None });
        })
        .unwrap();
        let reply = send(&path, &ControlRequest { pty: "pty-1".into(), secret, line: "axn-session-summary hi".into() }).unwrap();
        assert_eq!(reply.message.as_deref(), Some("axn-session-summary hi"));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn a_wrong_secret_or_unknown_pty_never_reaches_dispatch() {
        let path = temp_socket("bad");
        let state = Arc::new(ControlState::default());
        let secret = state.mint_secret("pty-1").unwrap();
        serve(&path, state.clone(), REPLY_TIMEOUT, |_, _, _| panic!("dispatched")).unwrap();
        for (pty, secret) in [("pty-1", "nope".to_string()), ("pty-2", secret)] {
            let reply = send(&path, &ControlRequest { pty: pty.into(), secret, line: "axn-rename x".into() }).unwrap();
            assert!(!reply.ok);
        }
    }

    #[test]
    fn an_unanswered_request_times_out() {
        let path = temp_socket("timeout");
        let state = Arc::new(ControlState::default());
        let secret = state.mint_secret("pty-1").unwrap();
        serve(&path, state.clone(), Duration::from_millis(100), |_, _, _| {}).unwrap();
        let reply = send(&path, &ControlRequest { pty: "pty-1".into(), secret, line: "axn-x".into() }).unwrap();
        assert_eq!(reply.error.as_deref(), Some("no axn-term window answered"));
    }
}
