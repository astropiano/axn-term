//! File logging: `log` facade → stderr + a rotating file in the platform's
//! standard log folder. The level is changeable at runtime (Settings →
//! General or `logLevel` in config.yaml) and `LOG_LEVEL` still works for
//! devs launching from a terminal.

use log::{LevelFilter, Metadata, Record};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const KEEP_BACKUPS: u32 = 4;
const FILE_NAME: &str = "axn-term.log";

static LEVEL: AtomicU8 = AtomicU8::new(3); // Info
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

struct RotatingFile {
    path: PathBuf,
    file: Option<std::fs::File>,
    size: u64,
}

impl RotatingFile {
    fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut rf = RotatingFile { path, file: None, size: 0 };
        rf.reopen();
        rf
    }

    fn reopen(&mut self) {
        self.file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok();
        self.size = self
            .file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
    }

    fn rotate(&mut self) {
        self.file = None;
        for i in (1..=KEEP_BACKUPS).rev() {
            let from = self.backup_name(i - 1);
            let to = self.backup_name(i);
            if from.exists() {
                let _ = std::fs::rename(&from, &to);
            }
        }
        self.reopen();
    }

    fn backup_name(&self, i: u32) -> PathBuf {
        if i == 0 {
            self.path.clone()
        } else {
            self.path.with_extension(format!("log.{}", i))
        }
    }

    fn write_line(&mut self, line: &str) {
        if self.size > MAX_FILE_BYTES {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(line.as_bytes());
            self.size += line.len() as u64;
        }
    }
}

struct AppLogger {
    file: Mutex<RotatingFile>,
}

impl log::Log for AppLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() as u8 <= LEVEL.load(Ordering::Relaxed)
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:5} [{}] {}\n",
            chrono_stamp(),
            record.level(),
            record.target(),
            record.args()
        );
        eprint!("{}", line);
        if let Ok(mut f) = self.file.lock() {
            f.write_line(&line);
        }
    }

    fn flush(&self) {
        if let Ok(mut f) = self.file.lock() {
            if let Some(file) = f.file.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

fn chrono_stamp() -> String {
    // Millisecond-precision local timestamp without pulling in chrono:
    // SystemTime → date via a simple civil-from-days conversion.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60,
        millis
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Platform-standard log folder: `~/Library/Logs/axn-term` on macOS,
/// `%LOCALAPPDATA%/axn-term/logs` on Windows, `$XDG_STATE_HOME/axn-term/logs`
/// (or `~/.local/state`) elsewhere.
pub(crate) fn default_log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library/Logs/axn-term");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = dirs::data_local_dir() {
            return dir.join("axn-term/logs");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = dirs::state_dir().or_else(dirs::data_local_dir) {
            return dir.join("axn-term/logs");
        }
    }
    crate::persist::state_dir()
        .map(|d| d.join("logs"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/axn-term-logs"))
}

fn parse_level(s: &str) -> Option<LevelFilter> {
    match s.trim().to_ascii_lowercase().as_str() {
        "off" => Some(LevelFilter::Off),
        "error" => Some(LevelFilter::Error),
        "warn" | "warning" => Some(LevelFilter::Warn),
        "info" => Some(LevelFilter::Info),
        "debug" => Some(LevelFilter::Debug),
        "trace" => Some(LevelFilter::Trace),
        _ => None,
    }
}

/// Read `logLevel`/`logDir` scalars out of config.yaml without a YAML dep:
/// only top-level `key: value` lines count, comments are stripped.
fn config_scalars() -> Vec<(String, String)> {
    let Ok(path) = crate::persist::config_file() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    raw.lines()
        .filter_map(|line| {
            if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('#') {
                return None;
            }
            let (k, v) = line.split_once(':')?;
            let v = v.split('#').next()?.trim().trim_matches('"').trim_matches('\'');
            Some((k.trim().to_string(), v.to_string()))
        })
        .collect()
}

/// Install the global logger. Resolution order for the level:
/// `LOG_LEVEL` env → `logLevel` in config.yaml → info. For the folder:
/// `AXN_TERM_LOG_DIR` env → `logDir` in config.yaml → OS default.
pub(crate) fn init() {
    let scalars = config_scalars();
    let find = |key: &str| scalars.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());

    let level = std::env::var("LOG_LEVEL")
        .ok()
        .and_then(|v| parse_level(&v))
        .or_else(|| find("logLevel").and_then(|v| parse_level(&v)))
        .unwrap_or(LevelFilter::Info);
    let dir = std::env::var_os("AXN_TERM_LOG_DIR")
        .map(PathBuf::from)
        .or_else(|| find("logDir").map(PathBuf::from))
        .unwrap_or_else(default_log_dir);
    let path = dir.join(FILE_NAME);

    LEVEL.store(level as u8, Ordering::Relaxed);
    if let Ok(mut p) = LOG_PATH.lock() {
        *p = Some(path.clone());
    }
    let _ = log::set_boxed_logger(Box::new(AppLogger {
        file: Mutex::new(RotatingFile::open(path.clone())),
    }));
    log::set_max_level(level);

    std::panic::set_hook(Box::new(|info| {
        log::error!("PANIC: {}", info);
        log::logger().flush();
    }));

    log::info!("axn-term starting — log file: {} (level {})", path.display(), level);
}

#[tauri::command]
pub(crate) fn set_log_level(level: String) -> Result<(), String> {
    let parsed = parse_level(&level).ok_or_else(|| format!("bad level: {}", level))?;
    LEVEL.store(parsed as u8, Ordering::Relaxed);
    log::set_max_level(parsed);
    log::info!("log level set to {}", parsed);
    Ok(())
}

#[tauri::command]
pub(crate) fn log_dir() -> Result<String, String> {
    Ok(LOG_PATH
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .and_then(|p| p.parent().map(|d| d.display().to_string()))
        .unwrap_or_else(|| default_log_dir().display().to_string()))
}
