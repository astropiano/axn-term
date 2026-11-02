//! Filesystem and OS-service commands: stat/open/reveal paths, clipboard,
//! fs-plugin scope widening, and font listing.

use std::path::PathBuf;
use tauri_plugin_fs::FsExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathStat {
    path: String,
    is_file: bool,
    is_dir: bool,
}

#[tauri::command]
pub(crate) fn stat_path(cwd: Option<String>, path: String) -> Option<PathStat> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest).to_string_lossy().into_owned(),
            None => path.clone(),
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
pub(crate) fn open_directory(path: String) -> Result<(), String> {
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
pub(crate) fn path_to_file_uri(path: &str) -> String {
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

/// Run a clipboard operation on the main thread with a fresh `arboard`
/// handle. tauri-plugin-clipboard-manager keeps one `arboard::Clipboard` for
/// the app's lifetime and drives it from tokio workers; on macOS that reuse of
/// an NSPasteboard handle off the main thread crashed in
/// `_NSPasteboardDeclareTypes` (EXC_BAD_ACCESS) after hours of OSC 52 copies.
pub(crate) async fn on_main_clipboard<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = arboard::Clipboard::new()
            .and_then(|mut clipboard| f(&mut clipboard))
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "clipboard operation was dropped".to_string())?
}

#[tauri::command]
pub(crate) async fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    on_main_clipboard(app, move |clipboard| clipboard.set_text(text)).await
}

/// Clipboard text, or `None` when the clipboard holds no text.
#[tauri::command]
pub(crate) async fn clipboard_read_text(app: tauri::AppHandle) -> Result<Option<String>, String> {
    on_main_clipboard(app, |clipboard| match clipboard.get_text() {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

/// `/select,"<path>"`: explorer.exe highlights the item in its parent
/// folder. Windows paths cannot contain `"`, so plain quoting is enough.
#[cfg(any(windows, test))]
pub(crate) fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('"', ""))
}

/// Reveal a file or directory in the OS file manager with the item selected.
#[tauri::command]
pub(crate) fn reveal_path(path: String) -> Result<(), String> {
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
        use std::os::windows::process::CommandExt;
        // Raw: Rust's argv quoting would turn the quotes into \", which
        // explorer.exe does not understand.
        std::process::Command::new("explorer")
            .raw_arg(explorer_select_arg(&path))
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


/// Widen the fs plugin scope by the user's `fileAccessRoots` setting — the
/// static capability only covers `$HOME`. Grants are additive: the fs scope
/// cannot revoke an allow without a permanent forbid, so a root removed from
/// the setting stays readable until restart.
#[tauri::command]
pub(crate) fn allow_file_roots(app: tauri::AppHandle, roots: Vec<String>) -> Result<(), String> {
    let scope = app.fs_scope();
    for root in roots {
        let root = root.trim();
        let path = match root.strip_prefix("~/") {
            Some(rest) => dirs::home_dir().ok_or("no home directory")?.join(rest),
            None if root == "~" => dirs::home_dir().ok_or("no home directory")?,
            None => PathBuf::from(root),
        };
        if !path.is_absolute() {
            return Err(format!("fileAccessRoots entry must be absolute: {}", root));
        }
        scope.allow_directory(&path, true).map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// Small persisted key-value store for UI-side caches (e.g. agent review
/// explanations). The store is a single JSON object at ~/.axn-term/kv.json.
#[tauri::command]
pub(crate) fn list_fonts() -> Vec<String> {
    use std::collections::BTreeSet;
    let mut names = BTreeSet::new();

    // macOS: real family names via AppKit's font manager (osascript wraps it
    // without a new crate dep).
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("osascript")
        .args([
            "-e",
            "use framework \"AppKit\"",
            "-e",
            "set f to NSFontManager's sharedFontManager()'s availableFontFamilies() as text",
            "-e",
            "return f",
        ])
        .output()
    {
        if out.status.success() {
            for name in String::from_utf8_lossy(&out.stdout).split(',') {
                let n = name.trim();
                if !n.is_empty() {
                    names.insert(n.to_string());
                }
            }
        }
    }

    // Linux: fc-list when fontconfig is present.
    #[cfg(all(unix, not(target_os = "macos")))]
    if names.is_empty() {
        if let Ok(out) = std::process::Command::new("fc-list")
            .args([":", "family"])
            .output()
        {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    for name in line.split(',') {
                        let n = name.trim();
                        if !n.is_empty() {
                            names.insert(n.to_string());
                        }
                    }
                }
            }
        }
    }

    // Fallback / Windows: font dir stems.
    if names.is_empty() {
        let mut dirs: Vec<std::path::PathBuf> = vec![
            "/Library/Fonts".into(),
            "/System/Library/Fonts".into(),
            "/usr/local/share/fonts".into(),
            "/usr/share/fonts".into(),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            let home = std::path::PathBuf::from(home);
            dirs.push(home.join("Library/Fonts"));
            dirs.push(home.join(".local/share/fonts"));
        }
        if let Ok(win) = std::env::var("WINDIR") {
            dirs.push(std::path::PathBuf::from(win).join("Fonts"));
        }
        const WEIGHT_SUFFIXES: &[&str] = &[
            "regular", "bold", "italic", "oblique", "light", "thin", "black",
            "medium", "semibold", "demibold", "extrabold", "ultrabold", "heavy",
            "book", "roman", "narrow", "condensed", "expanded", "ultralight",
            "extralight", "var", "vf",
        ];
        fn visit(path: &std::path::Path, names: &mut BTreeSet<String>, depth: u8) {
            if depth > 2 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(path) else { return };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    visit(&p, names, depth + 1);
                    continue;
                }
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase());
                if !matches!(ext.as_deref(), Some("ttf") | Some("otf") | Some("ttc")) {
                    continue;
                }
                let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let mut base = stem.to_string();
                if let Some(idx) = base.rfind(['-', '_']) {
                    if WEIGHT_SUFFIXES.contains(&base[idx + 1..].to_lowercase().as_str()) {
                        base.truncate(idx);
                    }
                }
                let base = base.trim().to_string();
                if !base.is_empty() {
                    names.insert(base);
                }
            }
        }
        for dir in &dirs {
            visit(dir, &mut names, 0);
        }
    }

    // Bundled webfonts always exist — offer them even if not installed.
    for bundled in ["Monaspace Neon", "Fira Code"] {
        names.insert(bundled.to_string());
    }
    names.into_iter().collect()
}

/// File name for a dropped file inside its drop directory: the last path
/// component, without control characters, never empty, `.` or `..`.
fn dropped_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    match clean.trim() {
        "" | "." | ".." => "dropped-file".to_string(),
        _ => clean,
    }
}

/// `%XX` decoding of the `x-file-name` header (the frontend sends
/// `encodeURIComponent(name)`; headers are ASCII-only).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Write a dropped file to `<root>/axn-term-drops/<unique>/<name>` and
/// return its path. The directories are created owner-only.
fn write_dropped_file(root: &std::path::Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = root.join("axn-term-drops").join(format!(
        "{}-{}-{}",
        std::process::id(),
        stamp,
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(dropped_file_name(name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Save the contents of a file dropped onto a terminal where the webview
/// gave the page only its bytes (macOS/Windows), and return the copy's path
/// for the frontend to paste. Raw IPC body = the bytes, header `x-file-name`
/// = the percent-encoded name. The runtime dir (`$XDG_RUNTIME_DIR` on Linux,
/// else the per-user temp dir) is private and cleared on logout/reboot.
#[tauri::command]
pub(crate) fn save_dropped_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes as a raw body".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let root = dirs::runtime_dir().unwrap_or_else(std::env::temp_dir);
    let path = write_dropped_file(&root, &name, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod file_drop_tests {
    use super::*;

    #[test]
    fn dropped_file_names_stay_inside_the_drop_dir() {
        assert_eq!(dropped_file_name("shot.png"), "shot.png");
        assert_eq!(dropped_file_name("../../etc/passwd"), "passwd");
        assert_eq!(dropped_file_name("C:\\x\\y.jpg"), "y.jpg");
        assert_eq!(dropped_file_name(".."), "dropped-file");
        assert_eq!(dropped_file_name(""), "dropped-file");
        assert_eq!(dropped_file_name("a\nb.png"), "ab.png");
    }

    #[test]
    fn file_name_header_is_percent_decoded() {
        assert_eq!(percent_decode("my%20shot%20%C3%A4.png"), "my shot ä.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz.png"), "%zz.png");
    }

    #[test]
    fn dropped_files_are_written_owner_only() {
        let root = std::env::temp_dir().join(format!("axn-drop-test-{}", std::process::id()));
        let path = write_dropped_file(&root, "pixel.png", &[0x89, b'P', b'N', b'G']).unwrap();
        assert_eq!(path.file_name().unwrap(), "pixel.png");
        assert_eq!(std::fs::read(&path).unwrap(), vec![0x89, b'P', b'N', b'G']);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::explorer_select_arg;

    #[test]
    fn explorer_gets_one_quoted_select_argument() {
        assert_eq!(
            explorer_select_arg(r"C:\Program Files\my app\a b.txt"),
            r#"/select,"C:\Program Files\my app\a b.txt""#
        );
        assert_eq!(explorer_select_arg(r#"C:\x"y"#), r#"/select,"C:\xy""#);
    }
}
