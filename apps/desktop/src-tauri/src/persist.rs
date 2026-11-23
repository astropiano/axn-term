//! Persistence commands and the ~/.axn-term file layout: window state
//! (state.json + backup/quarantine), plugins.yaml, config.yaml, kv.json,
//! keychain entries, and external plugin files.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use crate::AppState;

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ShellState {
    pub(crate) windows: Vec<JsonValue>,
}

pub(crate) fn state_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("AXN_TERM_STATE_DIR") {
        let path = PathBuf::from(override_dir);
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let home = dirs::home_dir().ok_or("could not determine home directory".to_string())?;
    // axn-term-hmr gets its own config/plugins/kv dir — never the real app's.
    if crate::devhmr::enabled() {
        return Ok(home.join(".axn-term-hmr"));
    }
    Ok(home.join(".axn-term"))
}

pub(crate) fn state_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("state.json"))
}

pub(crate) fn backup_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("state.json.bak"))
}

/// Move a file that could not be parsed aside as `<name>.failed` — or
/// `<name>.failed.<n>` when that name is taken — so it is kept for diagnosis
/// and never overwrites an earlier quarantined file. Returns the new file
/// name. The hard link fails atomically on an existing name, so a
/// quarantine never clobbers another; where links are unsupported a plain
/// rename to a free name is used.
pub(crate) fn quarantine_file(path: &Path) -> Result<String, String> {
    let mut n = 0u32;
    let target = loop {
        let target = if n == 0 {
            with_suffix(path, ".failed")
        } else {
            with_suffix(path, &format!(".failed.{}", n))
        };
        n += 1;
        match std::fs::hard_link(path, &target) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_file(path) {
                    eprintln!("could not remove quarantined {}: {}", path.display(), e);
                }
                break target;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) if target.symlink_metadata().is_err() => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Err(format!("could not quarantine {}: {}", path.display(), e));
                }
                std::fs::rename(path, &target).map_err(|e| {
                    format!("could not quarantine {} as {}: {}", path.display(), target.display(), e)
                })?;
                break target;
            }
            Err(_) => continue,
        }
    };
    sync_parent_dir(path);
    Ok(target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default())
}

/// Read `path` as text: `Ok(None)` when it does not exist, `Err` for any
/// other I/O error (EMFILE, permissions, …) — callers must not mistake a
/// transient read failure for a missing or corrupt file and write over it.
pub(crate) fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read {}: {}", path.display(), e)),
    }
}

pub(crate) fn legacy_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("sessions.json"))
}

pub(crate) fn plugins_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("plugins.yaml"))
}

pub(crate) fn config_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("config.yaml"))
}

#[derive(Default)]
pub(crate) struct LoadedShellState {
    pub(crate) state: ShellState,
    /// state.json was unreadable and the last-good backup was loaded instead.
    pub(crate) restored_from_backup: bool,
    /// Name of the file the failed state was preserved as, for diagnosis.
    pub(crate) failed_file: Option<String>,
    /// The state came from a parseable state.json — the next save may rotate
    /// it into the backup without parsing it again.
    pub(crate) current_valid: bool,
}

/// Load state.json. A missing file falls through to the legacy
/// sessions.json, then to an empty state. A file that cannot be parsed is
/// quarantined under a unique name and the last-good backup is loaded. Any
/// other I/O error is returned as `Err` without touching a file — callers
/// that save must abort rather than overwrite state they could not read.
pub(crate) fn read_shell_state() -> Result<LoadedShellState, String> {
    let path = state_file()?;
    if let Some(raw) = read_optional(&path)? {
        match serde_json::from_str(&raw) {
            Ok(state) => return Ok(LoadedShellState {
                state,
                current_valid: true,
                ..Default::default()
            }),
            Err(e) => eprintln!("state.json is corrupt ({}), trying backup", e),
        }

        // Read the backup of the last successfully written state first: an
        // I/O error there aborts before anything is moved.
        let backup = match read_optional(&backup_file()?)? {
            Some(raw) => match serde_json::from_str::<ShellState>(&raw) {
                Ok(state) => Some(state),
                Err(e) => {
                    eprintln!("state.json.bak is corrupt: {}", e);
                    None
                }
            },
            None => None,
        };
        // Preserve the corrupt file so the user can inspect what could not
        // be loaded; if it cannot be moved aside, fail rather than let the
        // next save overwrite it.
        let failed = quarantine_file(&path)?;
        eprintln!("quarantined corrupt state.json as {}", failed);
        if let Some(state) = backup {
            eprintln!("restored state from backup state.json.bak");
            return Ok(LoadedShellState {
                state,
                restored_from_backup: true,
                failed_file: Some(failed),
                current_valid: false,
            });
        }
    }

    if let Some(raw) = read_optional(&legacy_file()?)? {
        match serde_json::from_str::<JsonValue>(&raw) {
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
        }
    }

    Ok(LoadedShellState::default())
}

/// `<path><suffix>` — sibling temp/backup names (`state.json.tmp`).
pub(crate) fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Create/truncate `path`, write `contents` and fsync it.
pub(crate) fn write_synced(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

/// fsync `path`'s directory so a rename into it survives a crash. Best
/// effort: not every platform/filesystem supports syncing a directory.
pub(crate) fn sync_parent_dir(path: &Path) {
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
pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
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
pub(crate) fn rotate_backup(current: &Path, backup: &Path) -> std::io::Result<()> {
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
pub(crate) fn write_shell_state(shell_state: &ShellState, current_valid: bool) -> Result<(), String> {
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


// state.json can reach several MB (per-session scrollback is capped at
// 200k chars) — parse/merge off the main thread.
#[tauri::command]
pub(crate) async fn load_window_state(
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

pub(crate) fn load_window_state_blocking(
    state: &AppState,
    window_id: String,
) -> Result<Option<JsonValue>, String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;
    // axn-term-hmr never touches disk — the window state lives in memory for
    // the process lifetime (a page reload still finds it), nothing survives
    // an app restart.
    if crate::devhmr::enabled() {
        let mem = state.mem_shell_state.lock().map_err(|e| e.to_string())?;
        let target = JsonValue::String(window_id);
        return Ok(mem
            .windows
            .iter()
            .find(|w| w.get("id") == Some(&target))
            .cloned());
    }
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
pub(crate) async fn save_window_state(
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

pub(crate) fn save_window_state_blocking(
    state: &AppState,
    window_id: String,
    mut window_state: JsonValue,
) -> Result<(), String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;

    if let Some(obj) = window_state.as_object_mut() {
        obj.insert("id".to_string(), JsonValue::String(window_id.clone()));
    }
    if crate::devhmr::enabled() {
        let mut mem = state.mem_shell_state.lock().map_err(|e| e.to_string())?;
        let target = JsonValue::String(window_id);
        mem.windows.retain(|w| w.get("id") != Some(&target));
        mem.windows.push(window_state);
        return Ok(());
    }

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

    // A failed read must abort the save: merging into an empty or older
    // state would drop or roll back the other windows.
    let loaded = read_shell_state().map_err(|e| {
        eprintln!("save_window_state read error: {}", e);
        e
    })?;
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

pub(crate) fn delete_window_state_sync(state: &AppState, window_id: &str) -> Result<(), String> {
    let _guard = state.state_file_lock.lock().map_err(|e| e.to_string())?;
    if crate::devhmr::enabled() {
        let mut mem = state.mem_shell_state.lock().map_err(|e| e.to_string())?;
        let target = JsonValue::String(window_id.to_string());
        mem.windows.retain(|w| w.get("id") != Some(&target));
        return Ok(());
    }
    let dir = state_dir().map_err(|e| {
        eprintln!("delete_window_state state_dir error: {}", e);
        e
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("delete_window_state create_dir_all error: {}", e);
        return Err(e.to_string());
    }

    // A failed read must abort the save: merging into an empty or older
    // state would drop or roll back the other windows.
    let loaded = read_shell_state().map_err(|e| {
        eprintln!("delete_window_state read error: {}", e);
        e
    })?;
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
pub(crate) async fn delete_window_state(app: AppHandle, window_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        delete_window_state_sync(state.inner(), &window_id)
    })
    .await
    .map_err(|e| e.to_string())?
}


#[tauri::command]
pub(crate) fn read_plugins() -> Result<Option<String>, String> {
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

pub(crate) fn external_plugins_dir() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("plugins"))
}

#[tauri::command]
pub(crate) fn list_external_plugins() -> Result<Vec<String>, String> {
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
pub(crate) fn read_external_plugin(name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid plugin file name".to_string());
    }
    let path = external_plugins_dir()?.join(&name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub(crate) fn valid_plugin_segment(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && s != ".." && s != "."
}

/// Sandboxed plugin packages: directories under plugins/ containing a
/// plugin.json manifest (plus plugin.mjs logic and an optional index.html
/// view). Returns directory names only.
#[tauri::command]
pub(crate) fn list_external_plugin_dirs() -> Result<Vec<String>, String> {
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
pub(crate) fn read_external_plugin_file(dir: String, name: String) -> Result<String, String> {
    if !valid_plugin_segment(&dir) || !valid_plugin_segment(&name) {
        return Err("invalid plugin path".to_string());
    }
    let path = external_plugins_dir()?.join(&dir).join(&name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}


/// Folder for user themes: `<state dir>/themes` (`~/.axn-term/themes`).
pub(crate) fn user_themes_dir() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("themes"))
}

/// Largest theme file read — a theme is a few KB; anything bigger is not one.
const MAX_THEME_FILE_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
pub(crate) struct ThemeFile {
    name: String,
    content: String,
}

/// User theme files: every `*.yaml`/`*.yml`/`*.json` directly in the themes
/// folder, sorted by name, with their text. A missing folder is no themes;
/// unreadable or oversized files are skipped.
#[tauri::command]
pub(crate) fn list_user_themes() -> Result<Vec<ThemeFile>, String> {
    let dir = user_themes_dir()?;
    let mut files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("yaml" | "yml" | "json")) || !path.is_file() {
                continue;
            }
            if entry.metadata().map(|m| m.len() > MAX_THEME_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
                continue;
            };
            if let Ok(content) = std::fs::read_to_string(&path) {
                files.push(ThemeFile { name, content });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub(crate) fn write_plugins(content: String) -> Result<(), String> {
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
pub(crate) fn read_config() -> Result<Option<String>, String> {
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
pub(crate) fn write_config(content: String) -> Result<(), String> {
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

pub(crate) fn kv_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("kv.json"))
}

/// Load kv.json. A missing file is an empty store; a file that does not
/// hold a JSON object is quarantined under a unique name (kept for
/// diagnosis) and treated as empty. Any other I/O error is returned, so
/// `kv_set` never writes a store it could not read over the real one.
pub(crate) fn read_kv_store() -> Result<serde_json::Map<String, JsonValue>, String> {
    let path = kv_file()?;
    let Some(raw) = read_optional(&path)? else {
        return Ok(serde_json::Map::new());
    };
    match serde_json::from_str::<JsonValue>(&raw) {
        Ok(JsonValue::Object(map)) => Ok(map),
        parsed => {
            let reason = match parsed {
                Err(e) => e.to_string(),
                Ok(_) => "not a JSON object".to_string(),
            };
            let failed = quarantine_file(&path)?;
            eprintln!("kv.json is corrupt ({}), quarantined as {}", reason, failed);
            Ok(serde_json::Map::new())
        }
    }
}

pub(crate) fn write_kv_store(store: &serde_json::Map<String, JsonValue>) -> Result<(), String> {
    let dir = state_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    atomic_write(&kv_file()?, json.as_bytes())
}


#[tauri::command]
pub(crate) fn kv_get(key: String) -> Result<Option<String>, String> {
    Ok(read_kv_store()?
        .get(&key)
        .and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[tauri::command]
pub(crate) fn kv_set(key: String, value: Option<String>) -> Result<(), String> {
    let mut store = read_kv_store()?;
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

/// OS-keychain backed secret store (macOS Keychain, Windows Credential
/// Manager, Linux Secret Service) — used for the remote-auth refresh token.
pub(crate) const SECURE_SERVICE: &str = "dev.axn-term.axn-term";

#[tauri::command]
pub(crate) fn secure_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECURE_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}


#[tauri::command]
pub(crate) fn secure_set(key: String, value: Option<String>) -> Result<(), String> {
    let entry = keyring::Entry::new(SECURE_SERVICE, &key).map_err(|e| e.to_string())?;
    match value {
        Some(v) => entry.set_password(&v).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[cfg(test)]
mod state_backup_tests {
    use super::*;

    /// AXN_TERM_STATE_DIR is process-global: tests that set it hold this
    /// lock so they never run against each other's directory.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A fresh temp dir set as the state dir; the guard serializes callers.
    fn temp_state_dir(tag: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "axn-term-{}-test-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("AXN_TERM_STATE_DIR", &dir);
        (guard, dir)
    }

    /// Exercises the whole backup/fallback lifecycle in one test — the
    /// AXN_TERM_STATE_DIR env override is process-global, so these steps must
    /// not run in parallel with other state tests.
    #[test]
    fn corrupt_state_falls_back_to_last_good_backup() {
        let (_guard, dir) = temp_state_dir("state");

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
        // The second corrupt file gets its own name — the first is kept.
        std::fs::write(&state_file, "still broken").unwrap();
        std::fs::remove_file(&backup).unwrap();
        let loaded = read_shell_state().unwrap();
        assert!(!loaded.restored_from_backup);
        assert!(loaded.state.windows.is_empty());
        assert_eq!(std::fs::read_to_string(&failed).unwrap(), "{ not json");
        assert_eq!(
            std::fs::read_to_string(dir.join("state.json.failed.1")).unwrap(),
            "still broken"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn state_read_error_aborts_save_without_touching_files() {
        let (_guard, dir) = temp_state_dir("state-io");
        let app = crate::AppState::new(false);
        let state_file = dir.join("state.json");

        save_window_state_blocking(&app, "a".into(), serde_json::json!({"n": 1})).unwrap();
        save_window_state_blocking(&app, "b".into(), serde_json::json!({"n": 2})).unwrap();
        let good = std::fs::read_to_string(&state_file).unwrap();

        // Simulate an I/O error that is not NotFound (EMFILE, EACCES, …):
        // state.json is moved aside and a directory sits in its place.
        let saved = dir.join("state.json.saved");
        std::fs::rename(&state_file, &saved).unwrap();
        std::fs::create_dir(&state_file).unwrap();

        assert!(read_shell_state().is_err());
        assert!(load_window_state_blocking(&app, "a".into()).is_err());
        assert!(
            save_window_state_blocking(&app, "a".into(), serde_json::json!({"n": 3})).is_err(),
            "a save must not merge into a state it could not read"
        );
        assert!(delete_window_state_sync(&app, "b").is_err());
        assert!(state_file.is_dir(), "nothing written over the unreadable state");
        assert!(!dir.join("state.json.failed").exists(), "an I/O error is not corruption");

        // Once readable again, both windows are still there.
        std::fs::remove_dir(&state_file).unwrap();
        std::fs::rename(&saved, &state_file).unwrap();
        assert_eq!(std::fs::read_to_string(&state_file).unwrap(), good);
        assert_eq!(
            load_window_state_blocking(&app, "b".into()).unwrap().unwrap()["n"],
            serde_json::json!(2)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kv_store_missing_corrupt_and_unreadable() {
        let (_guard, dir) = temp_state_dir("kv");
        let kv = dir.join("kv.json");

        // Missing file: empty store, first write creates it.
        assert_eq!(kv_get("a".into()).unwrap(), None);
        kv_set("a".into(), Some("1".into())).unwrap();
        kv_set("b".into(), Some("2".into())).unwrap();
        assert_eq!(kv_get("a".into()).unwrap().as_deref(), Some("1"));
        kv_set("b".into(), None).unwrap();
        assert_eq!(kv_get("b".into()).unwrap(), None);

        // Unreadable (not NotFound): reads and writes fail, nothing replaced.
        let saved = dir.join("kv.json.saved");
        std::fs::rename(&kv, &saved).unwrap();
        std::fs::create_dir(&kv).unwrap();
        assert!(kv_get("a".into()).is_err());
        assert!(kv_set("c".into(), Some("3".into())).is_err());
        assert!(kv.is_dir(), "kv_set did not write over an unreadable store");
        assert!(!dir.join("kv.json.failed").exists(), "an I/O error is not corruption");
        std::fs::remove_dir(&kv).unwrap();
        std::fs::rename(&saved, &kv).unwrap();
        assert_eq!(kv_get("a".into()).unwrap().as_deref(), Some("1"), "store survived");

        // Corrupt: quarantined under a unique name, store starts empty.
        std::fs::write(&kv, "{ broken").unwrap();
        kv_set("c".into(), Some("3".into())).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("kv.json.failed")).unwrap(), "{ broken");
        assert_eq!(kv_get("c".into()).unwrap().as_deref(), Some("3"));
        assert_eq!(kv_get("a".into()).unwrap(), None);

        // Valid JSON that is not an object is corrupt too; the earlier
        // quarantined file is kept.
        std::fs::write(&kv, "[1]").unwrap();
        assert_eq!(kv_get("c".into()).unwrap(), None);
        assert_eq!(std::fs::read_to_string(dir.join("kv.json.failed")).unwrap(), "{ broken");
        assert_eq!(std::fs::read_to_string(dir.join("kv.json.failed.1")).unwrap(), "[1]");
        assert!(!kv.exists());

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
