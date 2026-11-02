//! Window bookkeeping: id allocation, boot intent parsing, and
//! `create_window`/`create_window_with`.

use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, Wry};
use crate::AppState;

pub(crate) fn next_window_id(counter: &AtomicU64, is_used: impl Fn(&str) -> bool) -> String {
    loop {
        let n = counter.fetch_add(1, Ordering::SeqCst);
        let id = format!("w-{}", n);
        // Restored windows predate this process's counter. Reserve a fresh
        // candidate atomically and skip any label already in the window map.
        if !is_used(&id) {
            return id;
        }
    }
}

/// Extras for a window opened by tearing a session out of another window.
/// Every field is optional; `create_window` without options opens a plain
/// 800×600 window like Ctrl/⌘+N.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewWindowOptions {
    /// URL fragment for the new window's frontend (`axn-boot=…`, built by
    /// `encodeBootIntent`). Only URL-safe characters pass — it is spliced
    /// into the window URL.
    boot: Option<String>,
    /// Logical screen position of the window's top-left corner (where the
    /// session was dropped). Ignored by Wayland compositors, which place
    /// windows themselves.
    x: Option<f64>,
    y: Option<f64>,
    /// Logical inner size — the source window's, like a browser tab drag.
    width: Option<f64>,
    height: Option<f64>,
}

pub(crate) const DEFAULT_WINDOW_SIZE: (f64, f64) = (800.0, 600.0);

/// The boot fragment when it is short and URL-safe (the frontend
/// percent-encodes its JSON), else None.
pub(crate) fn boot_fragment(raw: Option<&str>) -> Option<&str> {
    let raw = raw?;
    let ok = !raw.is_empty()
        && raw.len() <= 2048
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~%=&".contains(&b));
    ok.then_some(raw)
}

/// Requested inner size, clamped to something a window can sensibly have.
pub(crate) fn window_size(width: Option<f64>, height: Option<f64>) -> (f64, f64) {
    match (width, height) {
        (Some(w), Some(h)) if w.is_finite() && h.is_finite() => {
            (w.clamp(400.0, 8192.0), h.clamp(300.0, 8192.0))
        }
        _ => DEFAULT_WINDOW_SIZE,
    }
}

/// Requested position when both coordinates are plausible screen values.
pub(crate) fn window_position(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
    match (x, y) {
        (Some(x), Some(y))
            if x.is_finite() && y.is_finite() && x.abs() <= 32768.0 && y.abs() <= 32768.0 =>
        {
            Some((x, y))
        }
        _ => None,
    }
}

pub(crate) fn create_window_internal<M: Manager<Wry>>(manager: &M, label: &str) -> Result<(), String> {
    create_window_with(manager, label, &NewWindowOptions::default())
}

pub(crate) fn create_window_with<M: Manager<Wry>>(
    manager: &M,
    label: &str,
    options: &NewWindowOptions,
) -> Result<(), String> {
    let url = match boot_fragment(options.boot.as_deref()) {
        Some(boot) => format!("index.html#{}", boot),
        None => "index.html".to_string(),
    };
    let (width, height) = window_size(options.width, options.height);
    let dev_url = manager.config().build.dev_url.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(manager, label, WebviewUrl::App(url.into()))
        .title("axn-term")
        .inner_size(width, height)
        // Backstop to the frontend's drop guard: the webview must never leave
        // the app. A dropped file the page did not cancel would be opened in
        // place of the app (e.g. an image shown full-window), which also
        // unloads the close handler, so the window could no longer close.
        .on_navigation(move |url| is_app_navigation(url, dev_url.as_ref()));
    if let Some((x, y)) = window_position(options.x, options.y) {
        builder = builder.position(x, y);
    }
    builder = builder.visible(false);
    // macOS/Windows: no native file-drop target. The default wry drop handler
    // registers the webview as an OS-level drop destination, which on macOS
    // overlays a phantom "+" copy badge on internal HTML5 drags and can
    // consume the drop before the JS handlers see it (on Windows it fully
    // blocks HTML5 drag and drop); their webviews give the page dropped files
    // anyway. Linux keeps it: WebKitGTK hides a dropped file's path from the
    // page, and the GTK handler only takes drags carrying file URIs — the
    // app's own HTML5 drags never do. Its drops reach the frontend as
    // `onDragDropEvent` (fileDrop.ts).
    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.disable_drag_drop_handler();
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    {
        // Log every window-close path — a clean app exit is the last window
        // closing, so this is where unexpected quits become diagnosable.
        let label = window.label().to_string();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                log::info!("window {:?} CloseRequested", label);
            }
            tauri::WindowEvent::Destroyed => {
                log::info!("window {:?} Destroyed", label);
            }
            _ => {}
        });
    }

    // On Wayland, tao unconditionally installs a GtkHeaderBar as the window
    // titlebar, forcing GTK client-side decorations — a tall, icon-less bar
    // that looks foreign on KDE. Removing it lets GTK use the compositor's
    // server-side decorations (native KWin titlebar on KDE/Wayland) and
    // falls back to GTK's plain titlebar on compositors without SSD.
    // Both calls run on the GTK main thread; this function may be reached
    // from the remote-control HTTP thread.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let window2 = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(gtk_window) = window2.gtk_window() {
                gtk_window.set_titlebar(None::<&gtk::Widget>);
            }
            let _ = window2.show();
        });
    }
    #[cfg(not(target_os = "linux"))]
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigations a window's webview may perform: the app's own pages (bundled
/// assets, the dev server in debug builds) and the documents sandboxed
/// plugin iframes use (`about:srcdoc`, `blob:`, `data:`). Everything else —
/// `file://` from a drop, remote pages — is refused; external links open in
/// the system browser through `openExternal` instead.
pub(crate) fn is_app_navigation(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && dev_url.is_some_and(|dev| dev.origin() == url.origin()))
        }
        _ => false,
    }
}

#[tauri::command]
pub(crate) fn create_window(app: AppHandle, options: Option<NewWindowOptions>) -> Result<String, String> {
    let id = next_window_id(&app.state::<AppState>().window_counter, |id| {
        app.get_webview_window(id).is_some()
    });
    create_window_with(&app, &id, &options.unwrap_or_default())?;
    Ok(id)
}

#[cfg(test)]
mod new_window_options_tests {
    use super::*;

    #[test]
    fn boot_fragment_accepts_only_url_safe_text() {
        assert_eq!(
            boot_fragment(Some("axn-boot=%7B%22kind%22%3A%22tear-off%22%7D")),
            Some("axn-boot=%7B%22kind%22%3A%22tear-off%22%7D")
        );
        assert_eq!(boot_fragment(None), None);
        assert_eq!(boot_fragment(Some("")), None);
        // Anything that could break out of the fragment or the URL is refused.
        assert_eq!(boot_fragment(Some("axn-boot=x\"><script>")), None);
        assert_eq!(boot_fragment(Some("a#b")), None);
        assert_eq!(boot_fragment(Some("a b")), None);
        assert_eq!(boot_fragment(Some("a/../b")), None);
        assert_eq!(boot_fragment(Some(&"a".repeat(2049))), None);
    }

    #[test]
    fn window_size_clamps_and_defaults() {
        assert_eq!(window_size(Some(1200.0), Some(700.0)), (1200.0, 700.0));
        assert_eq!(window_size(Some(10.0), Some(10.0)), (400.0, 300.0));
        assert_eq!(window_size(Some(1e9), Some(1e9)), (8192.0, 8192.0));
        assert_eq!(window_size(Some(f64::NAN), Some(500.0)), DEFAULT_WINDOW_SIZE);
        assert_eq!(window_size(Some(900.0), None), DEFAULT_WINDOW_SIZE);
    }

    #[test]
    fn window_position_needs_both_plausible_coordinates() {
        assert_eq!(window_position(Some(-120.0), Some(40.0)), Some((-120.0, 40.0)));
        assert_eq!(window_position(Some(10.0), None), None);
        assert_eq!(window_position(Some(f64::INFINITY), Some(0.0)), None);
        assert_eq!(window_position(Some(1e6), Some(0.0)), None);
    }

    #[test]
    fn options_deserialize_from_camel_case_and_default_when_absent() {
        let o: NewWindowOptions =
            serde_json::from_str(r#"{"boot":"axn-boot=x","x":1,"y":2,"width":300,"height":400}"#).unwrap();
        assert_eq!(o.boot.as_deref(), Some("axn-boot=x"));
        assert_eq!((o.x, o.y, o.width, o.height), (Some(1.0), Some(2.0), Some(300.0), Some(400.0)));
        let empty: NewWindowOptions = serde_json::from_str("{}").unwrap();
        assert!(empty.boot.is_none() && empty.x.is_none() && empty.width.is_none());
    }
}


#[cfg(test)]
mod window_id_tests {
    use super::*;

    #[test]
    fn skips_restored_labels_with_a_fresh_counter() {
        let counter = AtomicU64::new(0);
        let restored = ["main", "w-0", "w-1", "w-3"];
        assert_eq!(next_window_id(&counter, |id| restored.contains(&id)), "w-2");
        assert_eq!(next_window_id(&counter, |id| restored.contains(&id)), "w-4");
    }

    #[test]
    fn concurrent_creators_reserve_distinct_labels() {
        let counter = AtomicU64::new(0);
        let ids = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16).map(|_| {
                scope.spawn(|| next_window_id(&counter, |id| id == "w-0"))
            }).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect::<std::collections::HashSet<_>>()
        });
        assert_eq!(ids.len(), 16);
        assert!(!ids.contains("w-0"));
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn app_pages_and_plugin_frames_may_load() {
        let dev = url("http://localhost:1420");
        for ok in [
            "tauri://localhost/index.html#boot",
            "http://tauri.localhost/index.html",
            "about:srcdoc",
            "about:blank",
            "blob:tauri://localhost/1234",
            "data:text/html,hi",
        ] {
            assert!(is_app_navigation(&url(ok), Some(&dev)), "{ok}");
        }
        assert_eq!(
            is_app_navigation(&url("http://localhost:1420/index.html"), Some(&dev)),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn dropped_files_and_foreign_pages_are_refused() {
        let dev = url("http://localhost:1420");
        for bad in [
            "file:///home/me/Pictures/shot.png",
            "https://example.com/",
            "http://localhost:1421/",
            "http://tauri.localhost.evil.example/",
        ] {
            assert!(!is_app_navigation(&url(bad), Some(&dev)), "{bad}");
        }
    }
}
