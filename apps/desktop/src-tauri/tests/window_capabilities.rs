use std::collections::BTreeMap;
use tauri::utils::{
    acl::{capability::Capability, resolved::Resolved},
    platform::Target,
};

fn capability(json: &str) -> Capability {
    serde_json::from_str(json).unwrap()
}

fn default_capability() -> Capability {
    capability(include_str!("../capabilities/default.json"))
}

fn resolve(capability: Capability) -> Resolved {
    let manifests =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    Resolved::resolve(
        &manifests,
        BTreeMap::from([(capability.identifier.clone(), capability)]),
        Target::current(),
    )
    .unwrap()
}

fn json(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap()
}

#[test]
fn shell_commands_are_available_to_all_app_windows_only() {
    let capability = default_capability();
    assert!(capability.local);
    // The shipped capability trusts no remote origin at all — the vite
    // dev-server origin lives in the hmr-only dev-hmr capability.
    assert!(capability.remote.is_none(), "default capability must not grant remote urls");
    let resolved = resolve(capability);
    for command in [
        "plugin:event|listen",
        "plugin:fs|read_text_file",
        "plugin:fs|write_text_file",
        "plugin:window|close",
    ] {
        let permissions = resolved.allowed_commands.get(command).expect(command);
        // `settings`: the macOS Preferences window (lib.rs menu handler).
        for label in ["main", "w-0", "w-19", "w-restored", "settings"] {
            assert!(
                permissions
                    .iter()
                    .any(|p| p.windows.iter().any(|w| w.matches(label))),
                "{command} denied for {label}"
            );
        }
        assert!(!permissions
            .iter()
            .any(|p| p.windows.iter().any(|w| w.matches("untrusted"))));
    }
}

/// Sensitive dotfiles and autostart locations stay unwritable through the
/// fs plugin even though `$HOME/**` is in scope (#26 keeps reads unscoped;
/// writes are the accident rail).
#[test]
fn fs_writes_deny_sensitive_home_paths() {
    let resolved = resolve(default_capability());
    for command in ["plugin:fs|write_text_file", "plugin:fs|mkdir"] {
        let denies: Vec<String> = resolved.allowed_commands[command]
            .iter()
            .filter_map(|c| c.scope_id)
            .flat_map(|id| resolved.command_scope[&id].deny.iter())
            .map(|v| serde_json::to_string(v).unwrap())
            .collect();
        for path in [
            "$HOME/.ssh/**",
            "$HOME/.gnupg/**",
            "$HOME/.bashrc",
            "$HOME/.zshrc",
            "$HOME/.profile",
            "$HOME/Library/LaunchAgents/**",
        ] {
            assert!(
                denies.iter().any(|d| d.contains(&format!("\"{path}\""))),
                "{command} does not deny {path}"
            );
        }
    }
    // Only the write commands the frontend uses are granted — no remove,
    // rename, copy or truncate over $HOME.
    for command in [
        "plugin:fs|remove",
        "plugin:fs|rename",
        "plugin:fs|copy_file",
        "plugin:fs|truncate",
        "plugin:fs|write_file",
    ] {
        assert!(!resolved.allowed_commands.contains_key(command), "{command} granted");
    }
}

/// The dev-server origin is trusted only by axn-term-hmr: dev-hmr is never
/// enabled by the shipped config, names exactly the vite origin, and grants
/// exactly what `default` grants.
#[test]
fn dev_hmr_remote_origin_is_hmr_only_and_exact() {
    let shipped = json(include_str!("../tauri.conf.json"));
    assert_eq!(shipped["app"]["security"]["capabilities"], serde_json::json!(["default"]));
    let hmr = json(include_str!("../tauri.term-hmr.conf.json"));
    assert_eq!(
        hmr["app"]["security"]["capabilities"],
        serde_json::json!(["default", "dev-hmr"])
    );
    assert_eq!(hmr["build"]["frontendDist"], "http://127.0.0.1:5914");

    let raw = json(include_str!("../capabilities/dev-hmr.json"));
    let dev = capability(include_str!("../capabilities/dev-hmr.json"));
    assert!(!dev.local);
    assert_eq!(
        dev.remote.as_ref().map(|r| r.urls.clone()),
        Some(vec!["http://127.0.0.1:5914/*".to_string()])
    );
    let default = json(include_str!("../capabilities/default.json"));
    assert_eq!(raw["permissions"], default["permissions"], "dev-hmr drifted from default");
    let resolved = resolve(dev);
    assert!(resolved.allowed_commands.contains_key("plugin:fs|write_text_file"));
}

/// The shipped webview has a CSP: no plugins/objects, no `<base>` hijack,
/// no eval in the app page, and Tauri does not append per-script hashes
/// (they would switch off 'unsafe-inline', which sandboxed plugin frames
/// inherit and need).
#[test]
fn shipped_webview_has_a_csp() {
    let shipped = json(include_str!("../tauri.conf.json"));
    let security = &shipped["app"]["security"];
    let csp = security["csp"].as_object().expect("csp must be set");
    assert_eq!(csp["object-src"], "'none'");
    assert_eq!(csp["base-uri"], "'self'");
    assert_eq!(csp["default-src"], "'self'");
    let script = csp["script-src"].as_str().unwrap();
    assert!(!script.contains("unsafe-eval"), "{script}");
    assert!(!script.split_whitespace().any(|s| s == "http:" || s == "*"), "{script}");
    assert!(csp["connect-src"].as_str().unwrap().contains("ipc:"));
    assert_eq!(
        security["dangerousDisableAssetCspModification"],
        serde_json::json!(["script-src", "style-src"])
    );
}
