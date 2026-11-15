# axn-term mobile (Android)

The remote viewer for phones: the web viewer (`apps/web`, built with
`vite build --mode mobile` from `apps/web/mobile/index.html` →
`src/mobile/main.tsx`) in a Capacitor shell.

## Build

In a container — same approach as the Calendar app:

```bash
apps/mobile/build/android/build.sh          # debug APK
apps/mobile/build/android/build.sh release  # release APK (signed if ANDROID_KEYSTORE… is set)
```

The APK lands in `apps/mobile/build/artifacts/android/`. Needs Docker or
Podman. Debug builds share one signing key (kept in the
`axn-term-android-home` volume), so a new debug APK installs over the old one.
To build the web bundle against the sibling `../ramphastos`
checkout instead of the published client package, set
`RAMPHASTOS_LOCAL_DEPS=1` (`AXN_LIBS_ROOT` overrides its path) — same as the
rest of the repo.

## How it connects

The app needs no server settings. It pairs with a server once and then
finds it on whatever network the phone is on:

- **Same Wi-Fi:** desktops with Remote enabled announce `_axn-term._tcp`
  over mDNS; the app lists them (`NsdPlugin.java`, Android NsdManager).
- **QR code:** axn-term on the desktop → Remote → Connect a phone.
- **Address:** any address of the server, typed.

Sign-in is a device code (like the desktop): the app shows a code and opens
the system browser; nothing redirects inside the app. The sign-in is an
offline token kept in the app's private storage, refreshed through
whichever address answers — so it survives restarts and network changes.

Pairing stores the server by its discovery id (`/.well-known/axn-term`)
with all its endpoints (LAN name, LAN IP, tailnet). On every start and on
network changes the app picks the endpoint that answers and reloads onto
it — Wi-Fi ↔ Tailscale keeps the same sign-in and viewer id, so the desktop
sees the same phone.

Self-hosted servers with their own certificate authority: install the CA on
the phone (Settings → Security → Install a certificate → CA certificate);
the app trusts user CAs. Tailscale (`*.ts.net`) and public certificates
need nothing.
