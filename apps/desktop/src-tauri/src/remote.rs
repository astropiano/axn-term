//! Remote control: the token-gated localhost socket (`axn-term session
//! ...` / remote-command surface) and the remote-auth snapshot command.

use std::io::Write;
#[cfg(unix)]
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::persist::read_shell_state;
#[cfg(unix)]
use crate::persist::state_dir;
use crate::pty::session_writer;
use crate::persist::delete_window_state_sync;
use crate::window::{create_window_internal, next_window_id};
use crate::AppState;
#[cfg(unix)]
use crate::control;

#[tauri::command]
pub(crate) fn remote_auth_report(state: State<'_, AppState>, snapshot: String) {
    log::info!("remote-auth snapshot: {}", snapshot);
    if let Ok(mut guard) = state.remote_auth.lock() {
        *guard = Some(snapshot);
    }
}


/// The remote-control HTTP server the flow tests drive the app through.
/// Enabled by `AXN_TERM_REMOTE_CONTROL_PORT` and only together with
/// `AXN_TERM_REMOTE_CONTROL_TOKEN`: it can type into any session, so every
/// request except `GET /health` must carry `Authorization: Bearer <token>`,
/// and the Host header must name the listener itself — a webpage reaching
/// 127.0.0.1 through DNS rebinding sends its own hostname.
pub(crate) struct RemoteControl {
    host: String,
    port: u16,
    token: String,
}

impl RemoteControl {
    /// Read the settings and drop the token from the process env, so PTYs
    /// and exec'd commands never inherit it. Call before other threads run.
    pub(crate) fn from_env() -> Option<Self> {
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

    pub(crate) fn host_allowed(&self, host: &str) -> bool {
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
    pub(crate) fn check(
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
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Take the control socket before any window opens. One app per state dir:
/// when another instance already serves it, this launch brings that
/// instance's window to the front and exits instead of starting a second
/// GUI (which would take over `axn-term session` and rewrite the same
/// state.json). `None`: no socket (logged), the app still starts.
#[cfg(unix)]
pub(crate) fn claim_control_socket_or_exit() -> Option<std::os::unix::net::UnixListener> {
    let path = match state_dir() {
        Ok(dir) => control::socket_path(&dir),
        Err(e) => {
            log::warn!("control socket disabled: {}", e);
            return None;
        }
    };
    match control::claim(&path) {
        Ok(control::Claim::Bound(listener)) => Some(listener),
        Ok(control::Claim::Running) => {
            let shown = control::activate(&path);
            log::warn!(
                "axn-term is already running for {} ({}); not starting a second instance \
                 (set AXN_TERM_STATE_DIR to another directory for a separate one)",
                path.parent().unwrap_or(&path).display(),
                match &shown {
                    Ok(reply) if reply.ok => "brought its window to the front".to_string(),
                    Ok(reply) => reply.error.clone().unwrap_or_default(),
                    Err(e) => e.clone(),
                }
            );
            log::logger().flush();
            std::process::exit(if matches!(shown, Ok(ref r) if r.ok) { 0 } else { 1 });
        }
        Err(e) => {
            log::warn!("control socket disabled: {}", e);
            None
        }
    }
}

/// Serve `axn-term session …` requests from programs inside our terminals
/// (control.rs); verified lines go to the frontend as `control-command`.
#[cfg(unix)]
pub(crate) fn start_control_socket(app_handle: AppHandle, listener: std::os::unix::net::UnixListener) {
    let Some(state) = app_handle.try_state::<Arc<control::ControlState>>() else { return };
    let state = state.inner().clone();
    let handle = app_handle.clone();
    let front = app_handle.clone();
    control::serve(
        listener,
        state,
        control::REPLY_TIMEOUT,
        move |id, pty, line| {
            let _ = handle.emit(
                "control-command",
                serde_json::json!({ "requestId": id, "ptyId": pty, "line": line }),
            );
        },
        move || bring_to_front(&front),
    );
}

/// A second launch: show and focus an app window, or open one if none is
/// left.
#[cfg(unix)]
fn bring_to_front(app: &AppHandle) -> bool {
    let windows = app.webview_windows();
    let window = windows
        .get("main")
        .or_else(|| windows.values().find(|w| w.label() != "settings"))
        .or_else(|| windows.values().next())
        .cloned();
    let Some(window) = window else {
        let id = next_window_id(&app.state::<AppState>().window_counter, |id| {
            app.get_webview_window(id).is_some()
        });
        return create_window_internal(app, &id).is_ok();
    };
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().is_ok()
}

/// The owning window's answer to a `control-command`.
#[cfg(unix)]
#[tauri::command]
pub(crate) fn control_reply(
    request_id: u64,
    reply: control::ControlReply,
    state: State<'_, Arc<control::ControlState>>,
) -> bool {
    state.reply(request_id, reply)
}

#[cfg(not(unix))]
#[tauri::command]
pub(crate) fn control_reply(_request_id: u64, _reply: serde_json::Value) -> bool {
    false
}

pub(crate) fn start_remote_control_server(app_handle: AppHandle, rc: RemoteControl) -> Result<(), String> {
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

pub(crate) fn handle_remote_control_request(
    req: &mut tiny_http::Request,
    app_handle: AppHandle,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    use tiny_http::{Method, Response};

    let state = app_handle.state::<AppState>();
    let url = req.url().to_string();

    match (req.method(), url.as_str()) {
        (Method::Get, "/health") => Response::from_string("ok"),

        (Method::Get, "/remote-auth") => {
            match state.remote_auth.lock() {
                Ok(guard) => Response::from_string(
                    guard.clone().unwrap_or_else(|| "null".to_string()),
                ),
                Err(e) => Response::from_string(format!("lock error: {}", e)),
            }
        }

        (Method::Post, "/remote-auth") => {
            // Trigger signIn() inside the webview — the real remoteAuth path
            // (plugin_exec curl hop), so flow tests exercise the same code
            // a user pressing "Sign in…" runs.
            let windows = app_handle.webview_windows();
            match windows.values().next() {
                Some(w) => {
                    let _ = w.eval("window.__axnRemoteAuth?.signIn?.({ openBrowser: false })");
                    Response::from_string("ok")
                }
                None => Response::from_string("no webview window"),
            }
        }

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
            log::info!("remote-control: closing window {:?}", id);
            let _ = app_handle.emit("close-window", &id);
            // Give the window's frontend a moment to run removeAndClose —
            // its close_session invokes land here and finish in Rust even
            // after the webview is gone. Skipping the wait orphans the
            // window's PTYs until process exit.
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = delete_window_state_sync(&state, &id);
            let windows = app_handle.webview_windows();
            if let Some(w) = windows.get(&id) {
                let _ = w.destroy();
            }
            Response::from_string("ok")
        }

        (Method::Post, "/close") => {
            log::info!("remote-control: /close requested — emitting close-now");
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
                crate::pty::kill_all_sessions(&app.state::<crate::AppState>());
                std::process::exit(0);
            });
            Response::from_string("ok")
        }

        _ => Response::from_string("not found"),
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
