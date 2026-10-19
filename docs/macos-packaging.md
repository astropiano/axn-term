# macOS packaging: code signing & Local Network permission

axn-term spawns shells, and everything those shells do on the network is
attributed to the app. Since macOS 15 the **Local Network** privacy filter
governs that: connections to LAN peers from an ungranted app fail with
`No route to host` (the gateway and the internet still work, and mDNS keeps
arriving because `mDNSResponder` is a system process — a confusing
half-working signature).

For the grant in *System Settings → Privacy & Security → Local Network* to
actually apply, two build-time requirements must be met:

## 1. `NSLocalNetworkUsageDescription` in Info.plist

macOS **silently denies** local-network access when the key is missing — no
prompt, no TCC entry, dead connections. Declared in
`apps/desktop/src-tauri/Info.plist` (merged into the bundle by the Tauri
CLI) together with `NSBonjourServices`.

## 2. A stable code signature

Local Network privacy tracks app identity via the **code signature**
(Apple TN3179). Adhoc-signed builds get a new cdhash on every compile, so a
granted toggle silently stops matching the next binary — the "toggle is on
but it's still blocked" trap.

`bundle.macOS.signingIdentity` in `tauri.conf.json` is set to
**`axn-term Code Signing`**, a self-signed code-signing certificate created
on the development machine:

```bash
# create + export (once)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -subj "/CN=axn-term Code Signing" \
  -addext "extendedKeyUsage=codeSigning" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "basicConstraints=critical,CA:FALSE"
openssl pkcs12 -export -out axn.p12 -inkey key.pem -in cert.pem \
  -passout pass:<pw> -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
  # ^ legacy algorithms — OpenSSL 3.x defaults are rejected by `security import`

# install (per machine)
security import axn.p12 -k ~/Library/Keychains/login.keychain-db -P <pw> -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
```

The certificate backup lives at `~/.axn-term-codesign/` on the build
machine. Without this identity in the keychain, `tauri build` fails; set
`APPLE_SIGNING_IDENTITY` to override.

Caveat: `tauri dev` keeps the cargo linker adhoc signature, so dev-mode
sessions can still lose LAN access. Re-sign the dev binary to fix it:

```bash
codesign --force --sign "axn-term Code Signing" target/debug/axn-term
```

The same applies to an already-installed `.app` after patching its
`Info.plist` by hand:

```bash
codesign --force --deep --sign "axn-term Code Signing" /Applications/axn-term.app
```

After re-signing, relaunch the app — the next LAN access triggers the
system prompt; **Allow** once and it sticks across rebuilds (the designated
requirement now matches `identifier + certificate leaf`, not a per-build
cdhash).

## Publishing roadmap — what's needed to ship axn-term

The self-signed cert is a **development-only** fix. Other machines would
each need the cert imported, trusted, and the permission granted — and
Gatekeeper still flags the app as unidentified. To publish properly:

1. **Apple Developer Program membership** ($99/yr) — required for a
   *Developer ID Application* certificate. This is the hard prerequisite;
   everything else is config.
2. **Developer ID certificate** on the build machine
   (`Developer ID Application: <Your Name> (TEAMID)`). Update
   `bundle.macOS.signingIdentity` (or set `APPLE_SIGNING_IDENTITY`) to it.
   TN3179 explicitly wants an Apple-issued identity for reliable Local
   Network tracking — self-signed works locally but is not guaranteed.
3. **Hardened runtime + notarization** — required for Gatekeeper to open
   the app on other Macs without the "damaged"/unidentified-developer
   dance. Tauri builds already enable the hardened runtime when signed;
   add notarization via `xcrun notarytool submit --wait` +
   `xcrun stapler staple axn-term.app` before DMG packaging. Credentials
   via `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or App Store Connect
   API key (`APPLE_API_KEY`/`APPLE_API_ISSUER`) — keep them out of the
   repo, inject via env/CI secrets.
4. **DMG flow** — `build/scripts/make-dmg.sh` runs after bundling;
   stapling must happen between `.app` signing and `hdiutil create`
   (or staple the DMG itself afterwards — `stapler` also works on DMGs).
5. **CI signing secrets** — export the Developer ID cert as `.p12`, store
   in the GitLab CI secrets along with the notarytool credentials, create
   a temporary keychain in the pipeline (`security create-keychain` /
   `set-key-partition-list`), sign, notarize, staple, package.
6. **Optional: Tauri updater** — if auto-update is ever wanted, it needs
   its own signing keypair (`tauri signer generate`) plus the updater
   pubkey in `tauri.conf.json` and a release artifact feed; orthogonal to
   code signing but worth deciding before the first public release.
7. **Local Network UX on first launch** — nothing to build, but worth a
   README/FAQ note: users must click **Allow** on the
   "find devices on your local network" prompt, else LAN shells silently
   fail. With a Developer ID signature the prompt reliably appears on
   first LAN access.

## References

- Apple TN3179 — Understanding local network privacy
- Apple TN3127 — Inside code signing: requirements
- `AGENTS.md` → "macOS Local Network permission & code signing" (short ops summary)
