fn main() {
    // Build timestamp for the About panel. Re-run whenever the embedded
    // frontend changes too — a frontend-only rebuild must not keep an old
    // date (cargo would otherwise skip this script).
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rustc-env=AXN_BUILD_DATE={}", build_timestamp());
    tauri_build::build()
}

/// `YYYY-MM-DD HH:MM UTC` for "now" — civil-from-days (Howard Hinnant), so
/// no date crate is needed in the build script.
fn build_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        tod / 3_600,
        (tod % 3_600) / 60
    )
}
