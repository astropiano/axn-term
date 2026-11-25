//! Filesystem and OS-service commands: stat/open/reveal paths, clipboard,
//! fs-plugin scope widening, and font listing.

use std::path::PathBuf;
use tauri_plugin_fs::FsExt;

/// Resolve a frontend-supplied path: `~/` expands to the home directory,
/// relative paths join `cwd` (absolute paths win). Returns `None` for a
/// relative path without a usable cwd.
fn resolve_fs_path(cwd: Option<&str>, path: &str) -> Option<PathBuf> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => PathBuf::from(path),
        }
    } else {
        PathBuf::from(path)
    };
    if expanded.is_absolute() {
        Some(expanded)
    } else {
        match cwd {
            Some(c) if !c.is_empty() => Some(std::path::Path::new(c).join(&expanded)),
            _ => None,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathStat {
    path: String,
    is_file: bool,
    is_dir: bool,
    modified_at: Option<u64>,
}

#[tauri::command]
pub(crate) fn stat_path(cwd: Option<String>, path: String) -> Option<PathStat> {
    let resolved = resolve_fs_path(cwd.as_deref(), &path)?;
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_file() && !meta.is_dir() {
        return None;
    }
    Some(PathStat {
        path: resolved.to_string_lossy().to_string(),
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        modified_at: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
    })
}

/// `readdir` entry for `fs_read_dir` — serialized like the frontend's
/// `DirEntry` (name/isFile/isDirectory/isSymlink).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsDirEntry {
    name: String,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
}

// Unscoped reads. The fs-plugin scope ($HOME + fileAccessRoots) only remains
// as a write rail: the app is a terminal — the webview already reads
// anything via the PTY (`cat`), so gating reads only produced
// `forbidden path` errors for previews and browsed paths outside $HOME
// (/tmp, /Volumes, ...). writeFile/mkdir stay on the plugin scope.

/// Only regular files may be read whole: a device or FIFO would block or
/// stream forever. `metadata` follows symlinks, like the read itself.
fn require_regular_file(p: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::metadata(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file", p.display()));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn fs_read_text(cwd: Option<String>, path: String) -> Result<String, String> {
    let p = resolve_fs_path(cwd.as_deref(), &path).ok_or("path is not absolute")?;
    require_regular_file(&p)?;
    std::fs::read_to_string(&p).map_err(|e| format!("{}: {}", p.display(), e))
}

/// Raw IPC response (no JSON/base64 copy) — previews read multi-MB images.
#[tauri::command]
pub(crate) fn fs_read_bytes(
    cwd: Option<String>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let p = resolve_fs_path(cwd.as_deref(), &path).ok_or("path is not absolute")?;
    require_regular_file(&p)?;
    std::fs::read(&p)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{}: {}", p.display(), e))
}

#[tauri::command]
pub(crate) fn fs_read_dir(cwd: Option<String>, path: String) -> Result<Vec<FsDirEntry>, String> {
    let p = resolve_fs_path(cwd.as_deref(), &path).ok_or("path is not absolute")?;
    let rd = std::fs::read_dir(&p).map_err(|e| format!("{}: {}", p.display(), e))?;
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        out.push(FsDirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_file: ft.is_file(),
            is_directory: ft.is_dir(),
            is_symlink: ft.is_symlink(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn fs_exists(cwd: Option<String>, path: String) -> bool {
    resolve_fs_path(cwd.as_deref(), &path)
        .map(|p| p.exists())
        .unwrap_or(false)
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

/// macOS: a fresh `arboard` handle per call. tauri-plugin-clipboard-manager
/// keeps one `arboard::Clipboard` for the app's lifetime and drives it from
/// tokio workers; that reuse of an NSPasteboard handle off the main thread
/// crashed in `_NSPasteboardDeclareTypes` (EXC_BAD_ACCESS) after hours of
/// OSC 52 copies.
#[cfg(target_os = "macos")]
fn with_clipboard<T>(
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    arboard::Clipboard::new().and_then(|mut cb| f(&mut cb))
}

/// Other platforms: one `arboard` handle for the process. On X11 copied data
/// lives only in the selection owner, which arboard destroys when the last
/// `Clipboard` drops — desktops without a clipboard manager (the common
/// case) would lose every copy the moment the call returned.
#[cfg(not(target_os = "macos"))]
fn with_clipboard<T>(
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    static CLIPBOARD: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);
    let mut guard = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new()?);
    }
    f(guard.as_mut().unwrap())
}

/// Run a clipboard operation on the main thread.
pub(crate) async fn on_main_clipboard<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(with_clipboard(f).map_err(|e| e.to_string()));
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

/// Copy an image to the clipboard. Raw IPC body = RGBA8888 pixel bytes,
/// `x-width`/`x-height` headers = the pixel size. The webview rasterizes to
/// RGBA itself (canvas `getImageData`), so no image-decode crate is needed
/// and every format the webview can draw (png/jpg/gif/webp/svg…) works.
#[tauri::command]
pub(crate) async fn clipboard_write_image(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected RGBA pixels as the raw body".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| format!("missing/invalid {name} header"))
    };
    let (width, height) = (header("x-width")?, header("x-height")?);
    if width
        .checked_mul(height)
        .and_then(|px| px.checked_mul(4))
        != Some(bytes.len())
    {
        return Err("RGBA byte length does not match width × height".into());
    }
    let image = arboard::ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(bytes.clone()),
    };
    on_main_clipboard(app, move |clipboard| clipboard.set_image(image)).await
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
/// the setting stays readable until restart. Each root is canonicalized and
/// checked by `file_access_root` first; rejected roots are skipped (the
/// others are still granted) and reported in the error.
#[tauri::command]
pub(crate) fn allow_file_roots(app: tauri::AppHandle, roots: Vec<String>) -> Result<(), String> {
    let scope = app.fs_scope();
    let home = dirs::home_dir().ok_or("no home directory")?;
    let mut rejected = Vec::new();
    for root in roots {
        match file_access_root(&root, &home) {
            Ok(path) => scope.allow_directory(&path, true).map_err(|e| e.to_string())?,
            Err(e) => rejected.push(e),
        }
    }
    if rejected.is_empty() {
        Ok(())
    } else {
        Err(rejected.join("; "))
    }
}

/// System locations a `fileAccessRoots` entry may not be (or be inside):
/// granting them would let the webview write OS files through the fs plugin.
/// `/var` is deliberately absent — macOS keeps per-user temp dirs
/// (`$TMPDIR`) under `/var/folders`.
const FORBIDDEN_FILE_ROOTS: &[&str] = &[
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/root",
    "/run", "/sbin", "/sys", "/usr", "/System", "/Library", "/private/etc",
];

/// One `fileAccessRoots` entry → the directory to grant: `~` expanded, no
/// `..`, symlinks resolved (a not-yet-existing tail — an unmounted volume —
/// is kept as written below its nearest existing ancestor), and never a
/// filesystem root, an ancestor of `$HOME` (`/home`, `/Users`) or a system
/// directory.
pub(crate) fn file_access_root(raw: &str, home: &std::path::Path) -> Result<PathBuf, String> {
    use std::path::Component;
    let root = raw.trim();
    let path = match root.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if root == "~" => home.to_path_buf(),
        None => PathBuf::from(root),
    };
    if !path.is_absolute() {
        return Err(format!("fileAccessRoots entry must be absolute: {root}"));
    }
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("fileAccessRoots entry must not contain `..`: {root}"));
    }
    let path = canonicalize_existing_prefix(&path);
    let home = canonicalize_existing_prefix(home);
    if path.parent().is_none() {
        return Err(format!("fileAccessRoots entry must not be a filesystem root: {root}"));
    }
    if home.starts_with(&path) && path != home {
        return Err(format!("fileAccessRoots entry must not contain the home directory: {root}"));
    }
    if FORBIDDEN_FILE_ROOTS.iter().any(|dir| path.starts_with(dir)) {
        return Err(format!("fileAccessRoots entry is a system directory: {root} ({})", path.display()));
    }
    Ok(path)
}

/// `path` with every symlink in its longest existing prefix resolved; the
/// missing remainder (no `..` left — the caller rejects those) is appended
/// unchanged.
fn canonicalize_existing_prefix(path: &std::path::Path) -> PathBuf {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            return tail.iter().rev().fold(real, |acc: PathBuf, part| acc.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
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
mod file_root_tests {
    use super::file_access_root;
    use std::path::{Path, PathBuf};

    #[test]
    fn roots_are_expanded_and_canonicalized() {
        let tmp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let home = tmp.join(format!("axn-root-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join("repos")).unwrap();
        assert_eq!(file_access_root("~", &home).unwrap(), home);
        assert_eq!(file_access_root(" ~/repos ", &home).unwrap(), home.join("repos"));
        // Not mounted yet: kept as written under its existing ancestor.
        assert_eq!(
            file_access_root(&home.join("vol/later").to_string_lossy(), &home).unwrap(),
            home.join("vol/later")
        );
        #[cfg(unix)]
        {
            let link = home.join("etc-link");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink("/etc", &link).unwrap();
            assert!(file_access_root(&link.to_string_lossy(), &home).is_err());
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn broad_relative_and_system_roots_are_rejected() {
        let home = PathBuf::from("/home/axn-root-test-user");
        for bad in [
            "/",
            "relative/dir",
            "/tmp/../etc",
            "~/../..",
            "/home",
            "/etc",
            "/etc/ssh",
            "/usr/local",
            "/System/Library",
            "/Library/LaunchDaemons",
        ] {
            assert!(file_access_root(bad, &home).is_err(), "{bad}");
        }
        assert!(file_access_root("/Volumes/external/repos", Path::new("/Users/me")).is_ok());
        assert!(file_access_root("/mnt/data", &home).is_ok());
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

#[cfg(test)]
mod fs_read_tests {
    use super::*;

    #[test]
    fn resolves_absolute_tilde_and_cwd_relative_paths() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            resolve_fs_path(None, "/abs/x"),
            Some(PathBuf::from("/abs/x"))
        );
        assert_eq!(resolve_fs_path(None, "~/x"), Some(home.join("x")));
        assert_eq!(
            resolve_fs_path(Some("/tmp/base"), "rel/x"),
            Some(PathBuf::from("/tmp/base/rel/x"))
        );
        // A relative path without a cwd cannot resolve.
        assert_eq!(resolve_fs_path(None, "rel/x"), None);
        assert_eq!(resolve_fs_path(Some(""), "rel/x"), None);
        // An absolute path wins over a cwd.
        assert_eq!(
            resolve_fs_path(Some("/tmp/base"), "/abs/x"),
            Some(PathBuf::from("/abs/x"))
        );
    }

    #[test]
    fn reads_regular_files_but_not_directories_or_devices() {
        let dir = std::env::temp_dir().join(format!("axn-fs-read-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "hello").unwrap();

        assert_eq!(
            fs_read_text(None, file.to_string_lossy().into_owned()).as_deref(),
            Ok("hello")
        );
        assert!(fs_read_bytes(None, file.to_string_lossy().into_owned()).is_ok());
        assert!(fs_exists(None, file.to_string_lossy().into_owned()));
        assert!(!fs_exists(None, dir.join("missing").to_string_lossy().into_owned()));

        // A directory is not a regular file; a device would stream forever.
        assert!(fs_read_text(None, dir.to_string_lossy().into_owned()).is_err());
        assert!(fs_read_bytes(None, dir.to_string_lossy().into_owned()).is_err());
        #[cfg(unix)]
        assert!(fs_read_bytes(None, "/dev/null".to_string()).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_dir_reports_entry_kinds() {
        let dir = std::env::temp_dir().join(format!("axn-fs-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a.txt", dir.join("link")).unwrap();

        let entries = fs_read_dir(None, dir.to_string_lossy().into_owned()).unwrap();
        let get = |name: &str| entries.iter().find(|e| e.name == name).unwrap();
        assert!(get("a.txt").is_file);
        assert!(get("sub").is_directory);
        #[cfg(unix)]
        assert!(get("link").is_symlink);

        std::fs::remove_dir_all(&dir).ok();
    }
}
