//! Local-network announcement of this desktop (`_axn-term._tcp` over mDNS)
//! while remote publishing is on, so a phone on the same Wi-Fi lists it
//! without typing an address. The TXT record says which server the desktop
//! publishes to (`server`, `sid`), who it is (`did`, `name`) — nothing
//! secret: an announcement only helps a client *find* a desktop; trust
//! still comes from TLS and the account sign-in.

use std::sync::Mutex;

use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Deserialize;

const SERVICE_TYPE: &str = "_axn-term._tcp.local.";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    /// Address the phone fetches the discovery document from.
    pub server: String,
    /// The server's other addresses (TXT `alt`, space-separated).
    #[serde(default)]
    pub alternates: Vec<String>,
    pub server_id: Option<String>,
    /// Stable desktop id (the remote device id).
    pub desktop_id: String,
}

struct Active {
    daemon: ServiceDaemon,
    fullname: String,
    current: Announcement,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// Start, update or (with `None`) stop the announcement. Idempotent: the
/// frontend calls it whenever remote settings change.
#[tauri::command]
pub fn remote_announce(announcement: Option<Announcement>) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|e| e.to_string())?;
    if active.as_ref().map(|a| &a.current) == announcement.as_ref() {
        return Ok(());
    }
    if let Some(old) = active.take() {
        let _ = old.daemon.unregister(&old.fullname);
        let _ = old.daemon.shutdown();
    }
    let Some(next) = announcement else {
        return Ok(());
    };

    let host = hostname();
    let daemon = ServiceDaemon::new().map_err(|e| format!("mdns: {e}"))?;
    let info = service_info(&host, &next)?;
    let fullname = info.get_fullname().to_string();
    daemon.register(info).map_err(|e| format!("mdns register: {e}"))?;
    log::info!("[announce] {fullname} → {}", next.server);
    *active = Some(Active { daemon, fullname, current: next });
    Ok(())
}

fn service_info(host: &str, a: &Announcement) -> Result<ServiceInfo, String> {
    let mut txt = vec![
        ("v", "1".to_string()),
        ("server", a.server.clone()),
        ("did", a.desktop_id.clone()),
        ("name", host.to_string()),
    ];
    let alt = alt_value(&a.alternates);
    if !alt.is_empty() {
        txt.push(("alt", alt));
    }
    if let Some(sid) = &a.server_id {
        txt.push(("sid", sid.clone()));
    }
    let props: Vec<(&str, &str)> = txt.iter().map(|(k, v)| (*k, v.as_str())).collect();
    // Instance names must be unique on the link: the device id is, the
    // hostname alone is not (two windows/apps on one machine, cloned VMs).
    let instance = instance_name(host, &a.desktop_id);
    // No service is served on this port — the phone talks to the server,
    // not to the desktop. 9 is the discard port.
    ServiceInfo::new(SERVICE_TYPE, &instance, &format!("{}.local.", dns_label(host)), "", 9, &props[..])
        .map(ServiceInfo::enable_addr_auto)
        .map_err(|e| format!("mdns service: {e}"))
}

/// Space-separated alternates, cut to whole entries within the 255-byte
/// TXT string limit (minus `alt=`).
fn alt_value(alternates: &[String]) -> String {
    let mut out = String::new();
    for a in alternates {
        let extra = if out.is_empty() { a.len() } else { a.len() + 1 };
        if out.len() + extra > 250 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(a);
    }
    out
}

fn instance_name(host: &str, desktop_id: &str) -> String {
    let mut name = format!("{host} ({desktop_id})");
    // DNS-SD instance labels are limited to 63 bytes.
    while name.len() > 63 {
        name.pop();
    }
    name
}

/// RFC 1123-ish label for the `.local` host record.
fn dns_label(host: &str) -> String {
    let label: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .take(63)
        .collect();
    if label.is_empty() { "axn-term".into() } else { label }
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().trim_end_matches(".local").to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "axn-term".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Announcement {
        Announcement {
            server: "https://fedora.local:18094".into(),
            alternates: vec!["https://192.168.1.41:18094".into(), "https://fedora.ts.net:18094".into()],
            server_id: Some("srv-1".into()),
            desktop_id: "host-1a2b3c4d".into(),
        }
    }

    #[test]
    fn txt_record_carries_server_and_identity() {
        let info = service_info("fedora", &sample()).unwrap();
        let props = info.get_properties();
        assert_eq!(props.get_property_val_str("v"), Some("1"));
        assert_eq!(props.get_property_val_str("server"), Some("https://fedora.local:18094"));
        assert_eq!(
            props.get_property_val_str("alt"),
            Some("https://192.168.1.41:18094 https://fedora.ts.net:18094")
        );
        assert_eq!(props.get_property_val_str("sid"), Some("srv-1"));
        assert_eq!(props.get_property_val_str("did"), Some("host-1a2b3c4d"));
        assert_eq!(props.get_property_val_str("name"), Some("fedora"));
        assert_eq!(info.get_fullname(), "fedora (host-1a2b3c4d)._axn-term._tcp.local.");
        assert_eq!(info.get_hostname(), "fedora.local.");
    }

    #[test]
    fn names_stay_within_dns_limits() {
        let long = "x".repeat(80);
        assert!(instance_name(&long, "host-1").len() <= 63);
        assert_eq!(dns_label("My Mac.home"), "My-Mac-home");
        assert_eq!(dns_label(""), "axn-term");
        let many: Vec<String> = (0..20).map(|i| format!("https://host-{i}.example.com:18094")).collect();
        assert!(alt_value(&many).len() <= 250);
    }
}
