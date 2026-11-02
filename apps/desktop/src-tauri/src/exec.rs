//! `plugin_exec`/`git_exec`: bounded shell exec for plugins and views —
//! concurrent stdout/stderr drain, output cap, process-group kill on timeout.

use std::path::Path;
#[cfg(unix)]
use crate::pty::resolve_shell;
use std::time::Duration;

/// Large enough for `glab api graphql` MR overviews (~90 KB with busy review
/// threads); still bounds what a runaway command can push over IPC.
pub(crate) const PLUGIN_EXEC_MAX_OUTPUT: usize = 1024 * 1024;

/// Upper bound for a plugin_exec child — only reaps hung processes, so it is
/// generous: dev-workflow `run-in: headless` actions and git-inspect
/// "Explain" run whole agent turns (`devin -p …`) through plugin_exec.
pub(crate) const PLUGIN_EXEC_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Upper bound for a git_exec child; `commit` runs the repo's hooks.
pub(crate) const GIT_EXEC_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Cut `text` to at most `max` bytes at a char boundary (`String::truncate`
/// panics inside a multibyte char) and say so explicitly at the end.
pub(crate) fn truncate_output(mut text: String, max: usize) -> String {
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
pub(crate) fn exec_cwd(cwd: Option<&str>) -> Result<Option<&str>, String> {
    match cwd {
        None | Some("") => Ok(None),
        Some(dir) if Path::new(dir).is_dir() => Ok(Some(dir)),
        Some(dir) => Err(format!("cwd is not a directory: {}", dir)),
    }
}

/// A finished `output_with_timeout` command. `*_truncated`: that stream hit
/// the cap and the command was stopped.
#[derive(Debug)]
pub(crate) struct ExecOutput {
    pub(crate) status: std::process::ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

/// Read `pipe` to EOF, keeping at most `cap` bytes. Past the cap `over` is
/// called once (it kills the command) and the rest is read and dropped, so
/// the writer never blocks on a full pipe.
pub(crate) fn read_capped(mut pipe: impl std::io::Read, cap: usize, over: impl FnOnce()) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut over = Some(over);
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let room = cap.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
        if n > room {
            if let Some(over) = over.take() {
                over();
            }
        }
    }
    (kept, over.is_none())
}

/// Kill the command with everything it started: they would otherwise keep
/// the output pipes open.
#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The child leads its own process group (`process_group(0)`).
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// A GUI app spawning console programs (git, cmd) opens a console window for
/// each one unless told not to.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `cmd.output()` with a deadline and an optional cap per stream. A timeout
/// or an output past `max_output` kills the command and its descendants.
pub(crate) fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
    max_output: Option<usize>,
) -> Result<ExecOutput, String> {
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::sync::Arc;

    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();

    let (done_tx, done_rx) = channel::<()>();
    let timed_out = Arc::new(AtomicBool::new(false));
    let watchdog_flag = Arc::clone(&timed_out);
    std::thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = done_rx.recv_timeout(timeout) {
            watchdog_flag.store(true, Ordering::SeqCst);
            kill_tree(pid);
        }
    });

    let cap = max_output.unwrap_or(usize::MAX);
    let stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || match stderr_pipe {
        Some(pipe) => read_capped(pipe, cap, || kill_tree(pid)),
        None => (Vec::new(), false),
    });
    let (stdout, stdout_truncated) = match child.stdout.take() {
        Some(pipe) => read_capped(pipe, cap, || kill_tree(pid)),
        None => (Vec::new(), false),
    };
    let status = child.wait();
    drop(done_tx);
    let (stderr, stderr_truncated) = stderr_reader.join().unwrap_or_default();
    if timed_out.load(Ordering::SeqCst) {
        return Err(format!("command timed out after {} s", timeout.as_secs()));
    }
    Ok(ExecOutput {
        status: status.map_err(|e| e.to_string())?,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

/// Output cut at the cap while the command was still writing.
pub(crate) fn stopped_output(mut text: String, max: usize) -> String {
    let mut cut = max.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str(&format!("\n[axn-term: output truncated to {} bytes; the command was stopped]", cut));
    text
}

// Async command + spawn_blocking: plugins run arbitrary subprocesses here
// (e.g. `glab api` network calls that can take seconds). A synchronous
// command would block the main thread and freeze the whole UI for the
// duration of the child process.
#[tauri::command]
pub(crate) async fn plugin_exec(cwd: Option<String>, command: String) -> Result<String, String> {
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
pub(crate) fn login_shell_path() -> Option<String> {
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

pub(crate) fn plugin_exec_blocking(cwd: Option<String>, command: String) -> Result<String, String> {
    #[cfg(unix)]
    let mut cmd = std::process::Command::new("sh");
    #[cfg(unix)]
    cmd.arg("-c").arg(&command);
    #[cfg(windows)]
    let mut cmd = std::process::Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Pass the line verbatim: Rust's argv quoting would escape the
        // command's own quotes, which cmd.exe does not unescape.
        cmd.arg("/C").raw_arg(&command);
    }
    #[cfg(unix)]
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
    if let Some(dir) = exec_cwd(cwd.as_deref())? {
        cmd.current_dir(dir);
    }
    let output = output_with_timeout(cmd, PLUGIN_EXEC_TIMEOUT, Some(PLUGIN_EXEC_MAX_OUTPUT))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.stdout_truncated {
        // Stopped for its output, so the exit status says nothing.
        return Ok(stopped_output(stdout, PLUGIN_EXEC_MAX_OUTPUT));
    }
    let stdout = truncate_output(stdout, PLUGIN_EXEC_MAX_OUTPUT);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if output.stderr_truncated {
            stopped_output(stderr, PLUGIN_EXEC_MAX_OUTPUT)
        } else {
            truncate_output(stderr, PLUGIN_EXEC_MAX_OUTPUT)
        };
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
pub(crate) async fn git_exec(cwd: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_exec_blocking(cwd, args))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn git_exec_blocking(cwd: String, args: Vec<String>) -> Result<String, String> {
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
    let output = output_with_timeout(cmd, GIT_EXEC_TIMEOUT, None)?;
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
        let output = output_with_timeout(cmd, Duration::from_secs(10), None).unwrap();
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
        assert_eq!(output.status.code(), Some(3));
    }

    #[cfg(unix)]
    #[test]
    fn a_runaway_command_is_stopped_at_the_cap() {
        let start = std::time::Instant::now();
        let mut cmd = std::process::Command::new("sh");
        // The background `sleep` holds the pipes too: the whole group must go.
        cmd.args(["-c", "sleep 60 & yes"]);
        let output = output_with_timeout(cmd, Duration::from_secs(60), Some(4096)).unwrap();
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(output.stdout_truncated && !output.stderr_truncated);
        assert_eq!(output.stdout.len(), 4096);
        assert!(output.stdout.starts_with(b"y\ny\n"));
        let result = plugin_exec_blocking(None, "yes".into()).unwrap();
        assert!(result.starts_with("y\ny\n") && result.len() < PLUGIN_EXEC_MAX_OUTPUT + 100);
        assert!(result.ends_with("the command was stopped]"));
        assert!(start.elapsed() < Duration::from_secs(20));
    }

    #[cfg(unix)]
    #[test]
    fn output_under_the_cap_is_complete() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "printf 1234"]);
        let output = output_with_timeout(cmd, Duration::from_secs(10), Some(4)).unwrap();
        assert_eq!(output.stdout, b"1234");
        assert!(!output.stdout_truncated && output.status.success());
    }

    #[test]
    fn capped_reads_drain_the_rest_and_report_once() {
        let mut calls = 0;
        let (kept, over) = read_capped(&[7u8; 200_000][..], 1000, || calls += 1);
        assert_eq!((kept.len(), over, calls), (1000, true, 1));
        let (kept, over) = read_capped(&b"abc"[..], 3, || panic!("not over"));
        assert_eq!((kept, over), (b"abc".to_vec(), false));
    }

    #[test]
    fn stopped_output_is_flagged_and_cut_at_a_char_boundary() {
        let out = stopped_output("ééé".into(), 3);
        assert_eq!(out, "é\n[axn-term: output truncated to 2 bytes; the command was stopped]");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_whole_process_group() {
        let mut cmd = std::process::Command::new("sh");
        // The background `sleep` inherits stdout: without a group kill the
        // pipe would stay open for 30 s after `sh` itself died.
        cmd.args(["-c", "sleep 30 & sleep 30"]);
        let start = std::time::Instant::now();
        let err = output_with_timeout(cmd, Duration::from_millis(300), None).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
