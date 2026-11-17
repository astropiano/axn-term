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
//!
//! App-level lines (`axn-term command`) need no secret — the socket is the
//! user's own (0600), like `activate`. They go to one window
//! (`control-app-command`), which runs them only when the command declares
//! itself app-level (`appRun`); anything else is refused there.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
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

/// An app-level command line, for one window (default: the focused one).
#[derive(Serialize, Deserialize, Debug)]
pub struct AppRequest {
    pub line: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
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

    /// Revoke a closed terminal's secret.
    pub fn forget(&self, pty_id: &str) {
        if let Ok(mut secrets) = self.secrets.lock() {
            secrets.remove(pty_id);
        }
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

// The socket is Unix-only: Windows terminals get no PTY secret (pty.rs) and
// `axn-term session` reports the platform as unsupported (cli.rs).

/// `claim`'s outcome.
#[cfg(unix)]
pub enum Claim {
    /// The socket is ours; serve it with `serve`.
    Bound(UnixListener),
    /// A live axn-term instance already serves this state dir.
    Running,
}

/// Bind the socket unless another instance answers on it. A socket file
/// nobody answers on is left over from a crash and is replaced.
#[cfg(unix)]
pub fn claim(path: &Path) -> Result<Claim, String> {
    let bind = || UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()));
    let listener = match UnixListener::bind(path) {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if UnixStream::connect(path).is_ok() {
                return Ok(Claim::Running);
            }
            let _ = std::fs::remove_file(path);
            bind()?
        }
        Err(e) => return Err(format!("bind {}: {e}", path.display())),
    };
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(Claim::Bound(listener))
}

/// Serve requests on threads. `dispatch(request_id, pty_id, line)` hands a
/// verified line to the frontend, which answers via `ControlState::reply`;
/// `activate()` answers a second app launch (`activate`). `app(id, line,
/// window)` delivers an app-level line, or says why it cannot (no window).
#[cfg(unix)]
pub fn serve<F, A, P>(
    listener: UnixListener,
    state: Arc<ControlState>,
    timeout: Duration,
    dispatch: F,
    activate: A,
    app: P,
) where
    F: Fn(u64, &str, &str) + Send + Sync + 'static,
    A: Fn() -> bool + Send + Sync + 'static,
    P: Fn(u64, &str, Option<&str>) -> Result<(), String> + Send + Sync + 'static,
{
    let dispatch = Arc::new(dispatch);
    let activate = Arc::new(activate);
    let app = Arc::new(app);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = state.clone();
            let dispatch = dispatch.clone();
            let activate = activate.clone();
            let app = app.clone();
            std::thread::spawn(move || handle(stream, &state, timeout, &*dispatch, &*activate, &*app));
        }
    });
}

/// One request line: a terminal's command, or a second launch's hand-over.
#[derive(Deserialize)]
#[serde(untagged)]
enum Incoming {
    Command(ControlRequest),
    App { app: AppRequest },
    Activate { activate: bool },
}

#[cfg(unix)]
fn handle(
    stream: UnixStream,
    state: &ControlState,
    timeout: Duration,
    dispatch: &dyn Fn(u64, &str, &str),
    activate: &dyn Fn() -> bool,
    app: &dyn Fn(u64, &str, Option<&str>) -> Result<(), String>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    let reply = match BufReader::new((&stream).take(MAX_REQUEST_BYTES)).read_line(&mut line) {
        Err(_) | Ok(0) => ControlReply::error("empty request"),
        Ok(_) => match serde_json::from_str::<Incoming>(&line) {
            Err(_) | Ok(Incoming::Activate { activate: false }) => ControlReply::error("malformed request"),
            Ok(Incoming::Activate { activate: true }) => {
                if activate() {
                    ControlReply { ok: true, ..Default::default() }
                } else {
                    ControlReply::error("no window to show")
                }
            }
            Ok(Incoming::App { app: req }) if !req.line.trim_start().starts_with("axn-") => {
                ControlReply::error("not an axn-term command")
            }
            Ok(Incoming::App { app: req }) => {
                let (id, rx) = state.register();
                let reply = match app(id, req.line.trim(), req.window.as_deref()) {
                    Err(e) => ControlReply::error(&e),
                    Ok(()) => rx
                        .recv_timeout(timeout)
                        .unwrap_or_else(|_| ControlReply::error("no axn-term window answered")),
                };
                state.unregister(id);
                reply
            }
            Ok(Incoming::Command(req)) if !state.verify(&req.pty, &req.secret) => {
                ControlReply::error("unknown terminal — run this inside an axn-term session")
            }
            Ok(Incoming::Command(req)) => {
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
#[cfg(unix)]
pub fn send(path: &Path, req: &ControlRequest) -> Result<ControlReply, String> {
    send_body(path, &serde_json::to_string(req).map_err(|e| e.to_string())?)
}

/// Client side (`axn-term command …`): an app-level line, one reply line.
#[cfg(unix)]
pub fn send_app(path: &Path, req: &AppRequest) -> Result<ControlReply, String> {
    send_body(path, &serde_json::json!({ "app": req }).to_string())
}

/// A second launch asks the running instance to show a window.
#[cfg(unix)]
pub fn activate(path: &Path) -> Result<ControlReply, String> {
    send_body(path, r#"{"activate":true}"#)
}

#[cfg(unix)]
fn send_body(path: &Path, body: &str) -> Result<ControlReply, String> {
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("cannot reach axn-term at {}: {e}", path.display()))?;
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(2)));
    stream
        .write_all(format!("{body}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| format!("bad reply from axn-term: {e}"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn temp_socket(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("axn-ctl-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(SOCKET_NAME)
    }

    fn bound(path: &Path) -> UnixListener {
        match claim(path).unwrap() {
            Claim::Bound(listener) => listener,
            Claim::Running => panic!("socket taken"),
        }
    }

    #[test]
    fn a_live_socket_is_kept_and_a_stale_one_replaced() {
        let path = temp_socket("claim");
        let _ = std::fs::remove_file(&path);
        // Left behind by a crashed instance: a socket file nobody accepts on.
        // (Not a dropped UnixListener: a process another test forks at that
        // moment can briefly hold its fd, so connect() would still succeed.)
        drop(std::os::unix::net::UnixDatagram::bind(&path).unwrap());
        assert!(path.exists());
        let listener = bound(&path);
        // A second launch must not take over the live socket.
        assert!(matches!(claim(&path).unwrap(), Claim::Running));
        serve(listener, Arc::new(ControlState::default()), REPLY_TIMEOUT, |_, _, _| {}, || true, |_, _, _| Err("no".into()));
        assert!(matches!(claim(&path).unwrap(), Claim::Running));
        assert!(activate(&path).unwrap().ok);
        // Not a socket at all.
        let other = temp_socket("claim-file");
        std::fs::write(&other, "x").unwrap();
        drop(bound(&other));
    }

    #[test]
    fn verified_lines_reach_dispatch_and_the_reply_comes_back() {
        let path = temp_socket("ok");
        let state = Arc::new(ControlState::default());
        let secret = state.mint_secret("pty-1").unwrap();
        let answering = state.clone();
        serve(bound(&path), state.clone(), REPLY_TIMEOUT, move |id, pty, line| {
            assert_eq!(pty, "pty-1");
            answering.reply(id, ControlReply { ok: true, message: Some(line.to_string()), error: None });
        }, || false, |_, _, _| Err("no".into()));
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
        serve(bound(&path), state.clone(), REPLY_TIMEOUT, |_, _, _| panic!("dispatched"), || panic!("activated"), |_, _, _| panic!("app"));
        for (pty, secret) in [("pty-1", "nope".to_string()), ("pty-2", secret)] {
            let reply = send(&path, &ControlRequest { pty: pty.into(), secret, line: "axn-rename x".into() }).unwrap();
            assert!(!reply.ok);
        }
    }

    #[test]
    fn a_forgotten_secret_no_longer_verifies() {
        let state = ControlState::default();
        let secret = state.mint_secret("pty-1").unwrap();
        assert!(state.verify("pty-1", &secret));
        state.forget("pty-1");
        assert!(!state.verify("pty-1", &secret));
    }

    #[test]
    fn an_unanswered_request_times_out() {
        let path = temp_socket("timeout");
        let state = Arc::new(ControlState::default());
        let secret = state.mint_secret("pty-1").unwrap();
        serve(bound(&path), state.clone(), Duration::from_millis(100), |_, _, _| {}, || false, |_, _, _| Err("no".into()));
        let reply = send(&path, &ControlRequest { pty: "pty-1".into(), secret, line: "axn-x".into() }).unwrap();
        assert_eq!(reply.error.as_deref(), Some("no axn-term window answered"));
    }
    #[test]
    fn app_lines_reach_the_app_dispatch_without_a_secret() {
        let path = temp_socket("app");
        let state = Arc::new(ControlState::default());
        let answering = state.clone();
        serve(bound(&path), state.clone(), REPLY_TIMEOUT, |_, _, _| panic!("pty dispatch"), || false,
            move |id, line, window| {
                assert_eq!(window, Some("w-2"));
                answering.reply(id, ControlReply { ok: true, message: Some(line.to_string()), error: None });
                Ok(())
            });
        let reply = send_app(&path, &AppRequest { line: "axn-views current".into(), window: Some("w-2".into()) }).unwrap();
        assert_eq!(reply.message.as_deref(), Some("axn-views current"));
    }

    #[test]
    fn an_app_dispatch_error_is_the_reply() {
        let path = temp_socket("app-err");
        serve(bound(&path), Arc::new(ControlState::default()), REPLY_TIMEOUT, |_, _, _| {}, || false,
            |_, _, _| Err("no axn-term window".into()));
        let reply = send_app(&path, &AppRequest { line: "axn-views current".into(), window: None }).unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.as_deref(), Some("no axn-term window"));
    }

    #[test]
    fn an_app_line_must_be_an_axn_command() {
        let path = temp_socket("app-bad");
        serve(bound(&path), Arc::new(ControlState::default()), REPLY_TIMEOUT, |_, _, _| {}, || false,
            |_, _, _| panic!("dispatched"));
        let reply = send_app(&path, &AppRequest { line: "rm -rf /".into(), window: None }).unwrap();
        assert!(!reply.ok);
    }

}
