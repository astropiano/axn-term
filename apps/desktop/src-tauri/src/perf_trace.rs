//! Opt-in performance trace for the perf flows (`flows/axn-term-perf.xml`).
//!
//! `AXN_TERM_PERF_TRACE=<file>` appends one JSON line per event:
//! `{"name":"…","ms":12.3,"epochMs":…,"detail":"…"}` — `ms` since `run()`
//! started. The frontend reports its own marks through `perf_mark` (wired
//! via an init script only while tracing). Unset, every mark is a single
//! `OnceLock` read.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

struct Trace {
    file: Mutex<File>,
    start: Instant,
    start_epoch_ms: f64,
}

static TRACE: OnceLock<Option<Trace>> = OnceLock::new();

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn trace() -> Option<&'static Trace> {
    TRACE
        .get_or_init(|| {
            let path = std::env::var_os("AXN_TERM_PERF_TRACE")?;
            let file = OpenOptions::new().create(true).append(true).open(path).ok()?;
            Some(Trace {
                file: Mutex::new(file),
                start: Instant::now(),
                start_epoch_ms: epoch_ms(),
            })
        })
        .as_ref()
}

impl Trace {
    fn write(&self, name: &str, ms: f64, detail: Option<&str>) {
        let line = serde_json::json!({
            "name": name,
            "ms": (ms * 10.0).round() / 10.0,
            "epochMs": self.start_epoch_ms + ms,
            "detail": detail,
        });
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "{}", line);
        }
    }
}

/// Starts the clock (`run_start`). Call first thing in `run()`.
pub fn init() {
    if let Some(t) = trace() {
        t.write("run_start", 0.0, None);
    }
}

pub fn enabled() -> bool {
    trace().is_some()
}

/// Records `name` now.
pub fn mark(name: &str, detail: Option<&str>) {
    if let Some(t) = trace() {
        t.write(name, t.start.elapsed().as_secs_f64() * 1000.0, detail);
    }
}

/// Frontend marks carry their own wall-clock time, so IPC latency does not
/// skew them.
#[tauri::command]
pub fn perf_mark(name: String, epoch_ms: f64, detail: Option<String>) {
    if let Some(t) = trace() {
        t.write(&name, epoch_ms - t.start_epoch_ms, detail.as_deref());
    }
}

/// Init script that gives the frontend `window.__AXN_PERF__(name, detail?)`
/// — only injected while tracing, so marks are no-ops otherwise.
pub const INIT_SCRIPT: &str = "window.__AXN_PERF__ = (name, detail) => \
    window.__TAURI_INTERNALS__.invoke('perf_mark', { name, epochMs: performance.timeOrigin + performance.now(), detail: detail ?? null }).catch(() => {});";
