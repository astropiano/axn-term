//! Process inspection commands: foreground process, cwd, tty, and
//! system/session memory statistics (platform-specific readers).

use tauri::{AppHandle, Manager};
use crate::pty::{session_shell_pid, with_state_blocking};
use crate::AppState;

#[cfg(target_os = "macos")]
pub(crate) fn run_command_with_fallbacks(binaries: &[&str], args: &[&str]) -> Option<String> {
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
pub(crate) fn argv_basename(token: &str) -> String {
    let name = token.trim().trim_start_matches('-');
    std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string()
}

pub(crate) const SCRIPT_EXTS: [&str; 8] = ["py", "js", "mjs", "cjs", "ts", "sh", "rb", "pl"];

pub(crate) fn strip_script_ext(name: String) -> String {
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
pub(crate) fn is_interpreter(name: &str) -> bool {
    let stem = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    matches!(
        stem,
        "python" | "node" | "bun" | "deno" | "ruby" | "perl" | "sh" | "bash" | "zsh" | "fish"
    )
}

/// Derive the process identity from argv: scripts run through an
/// interpreter resolve to the script name (`vibe`, `cli`), `python -m pkg`
/// to the module name. Everything else is the argv0 basename.
pub(crate) fn process_identity(argv: &[String]) -> Option<String> {
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

pub(crate) fn process_name(pid: u32) -> Option<String> {
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
        // Exact argv tokens — needed to unwrap interpreter scripts (comm
        // alone reports e.g. `python` for `vibe`). Processes of another user
        // refuse KERN_PROCARGS2; proc_name still yields their comm.
        macos_argv(pid)
            .and_then(|argv| process_identity(&argv))
            .or_else(|| macos_comm(pid))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

pub(crate) fn process_cwd(pid: u32) -> Option<String> {
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
        macos_cwd(pid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// argv out of a `KERN_PROCARGS2` buffer: a native-endian `int argc`, the
/// NUL-terminated exec path, NUL padding, then `argc` NUL-terminated
/// strings (the environment follows and is ignored).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn parse_procargs2(buf: &[u8]) -> Option<Vec<String>> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?);
    if argc <= 0 {
        return None;
    }
    let rest = &buf[4..];
    let mut start = rest.iter().position(|b| *b == 0)?;
    while rest.get(start) == Some(&0) {
        start += 1;
    }
    let argv: Vec<String> = rest[start..]
        .split(|b| *b == 0)
        .take(argc as usize)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    (argv.len() == argc as usize).then_some(argv)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_argv(pid: u32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: mib names a c_int sysctl and len matches the out buffer.
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut argmax as *mut libc::c_int).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if !ok || argmax <= 0 {
        return None;
    }
    let mut buf = vec![0u8; argmax as usize];
    let mut size = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: buf is `size` bytes long; the kernel writes at most that much.
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if !ok {
        return None;
    }
    buf.truncate(size);
    parse_procargs2(&buf)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_comm(pid: u32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: buf is 256 bytes; proc_name writes a NUL-terminated name.
    let n = unsafe { libc::proc_name(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let name = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    (!name.is_empty()).then(|| argv_basename(&name))
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_cwd(pid: u32) -> Option<String> {
    // SAFETY: proc_vnodepathinfo is plain old data; zeroed is a valid value.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer is exactly `size` bytes.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size,
        )
    };
    if n != size {
        return None;
    }
    let path = &info.pvi_cdir.vip_path;
    // SAFETY: vip_path is a MAXPATHLEN c_char array, viewed as bytes.
    let bytes = unsafe {
        std::slice::from_raw_parts(path.as_ptr().cast::<u8>(), std::mem::size_of_val(path))
    };
    let cwd = std::ffi::CStr::from_bytes_until_nul(bytes).ok()?.to_string_lossy();
    (!cwd.is_empty()).then(|| cwd.into_owned())
}

// Polled ~1/s per terminal — process_name/process_cwd read /proc (Linux) or
// call sysctl/proc_pidinfo (macOS) and never spawn a process.
#[tauri::command]
pub(crate) async fn get_foreground_process(
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
            // The shell itself in the foreground means an idle prompt — the
            // comm name comparison lives in the frontend but wrappers
            // (login shims, `exec` chains) make it unreliable, so answer
            // the identity question here where the shell pid is known.
            let shell_pid = session.shell_pid as i32;
            drop(sessions);
            if pid == shell_pid {
                return Ok(None);
            }
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
pub(crate) fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_session_cwd(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
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
pub(crate) fn process_tty(pid: u32) -> Option<String> {
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
pub(crate) async fn get_session_tty(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
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
pub(crate) struct SessionMemory {
    session_id: String,
    rss_kb: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryStats {
    total_kb: u64,
    available_kb: u64,
    swap_total_kb: u64,
    swap_free_kb: u64,
    app_rss_kb: u64,
    sessions: Vec<SessionMemory>,
}

/// (pid, ppid, rss_kb) for every process. `ps` is used so the same code works
/// on Linux and macOS.
pub(crate) fn process_table() -> Vec<(u32, u32, u64)> {
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
pub(crate) fn rss_of_tree(
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
pub(crate) fn system_memory() -> (u64, u64, u64, u64) {
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
pub(crate) fn system_memory() -> (u64, u64, u64, u64) {
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
pub(crate) fn system_memory() -> (u64, u64, u64, u64) {
    (0, 0, 0, 0)
}

/// RAM usage of the whole app process tree plus every session's process tree,
/// and system-wide memory pressure for the rail indicator.
// Polled while a memory-usage plugin is enabled; process_table() spawns
// `ps` and blocks, so run off the main thread.
#[tauri::command]
pub(crate) async fn get_memory_stats(app: AppHandle) -> Result<MemoryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        memory_stats_blocking(state.inner())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn memory_stats_blocking(state: &AppState) -> Result<MemoryStats, String> {
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

    fn procargs2(exec: &str, args: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buf = (args.len() as i32).to_ne_bytes().to_vec();
        buf.extend_from_slice(exec.as_bytes());
        buf.extend_from_slice(&[0, 0, 0, 0]);
        for s in args.iter().chain(env) {
            buf.extend_from_slice(s.as_bytes());
            buf.push(0);
        }
        buf
    }

    #[test]
    fn procargs2_keeps_tokens_with_spaces() {
        let buf = procargs2(
            "/usr/bin/python3",
            &["python3", "/Users/me/My Tools/bin/vibe", "--x"],
            &["HOME=/Users/me"],
        );
        let parsed = parse_procargs2(&buf).unwrap();
        assert_eq!(parsed, vec!["python3", "/Users/me/My Tools/bin/vibe", "--x"]);
        assert_eq!(process_identity(&parsed).as_deref(), Some("vibe"));
    }

    #[test]
    fn procargs2_rejects_truncated_buffers() {
        assert_eq!(parse_procargs2(&[1, 0]), None);
        assert_eq!(parse_procargs2(&procargs2("/bin/sh", &[], &[])), None);
        let mut short = procargs2("/bin/sh", &["sh", "-c"], &[]);
        short.truncate(short.len() - 4);
        assert_eq!(parse_procargs2(&short), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_own_argv_and_cwd_without_spawning() {
        let pid = std::process::id();
        let argv = macos_argv(pid).expect("own argv");
        assert_eq!(argv.len(), std::env::args().count());
        assert!(process_name(pid).is_some());
        let cwd = process_cwd(pid).expect("own cwd");
        assert_eq!(
            std::fs::canonicalize(cwd).unwrap(),
            std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap()
        );
    }
}
