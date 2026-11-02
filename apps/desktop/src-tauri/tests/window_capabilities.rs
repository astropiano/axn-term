use std::collections::BTreeMap;
use tauri::utils::{
    acl::{capability::Capability, resolved::Resolved},
    platform::Target,
};

#[test]
fn shell_commands_are_available_to_all_app_windows_only() {
    let capability: Capability =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    assert!(capability.local);
    assert!(capability.remote.is_none());
    let manifests =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let resolved = Resolved::resolve(
        &manifests,
        BTreeMap::from([(capability.identifier.clone(), capability)]),
        Target::current(),
    )
    .unwrap();
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
