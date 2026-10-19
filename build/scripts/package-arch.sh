#!/usr/bin/env bash
# Package the built Tauri desktop binary as an Arch Linux pacman .pkg.tar.zst.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BINARY="${1:-$REPO_ROOT/artifacts/desktop/bin/axn-term}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/artifacts/desktop}"
ICON_SRC="$REPO_ROOT/apps/desktop/src-tauri/icons/128x128.png"
TAURI_CONF="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json"

if [[ ! -f "$BINARY" ]]; then
  echo "error: binary not found at $BINARY"
  exit 1
fi

# A production build embeds the vite dist via tauri's `custom-protocol`
# feature. Binaries built through a dev feature set (`tauri dev`,
# `--no-default-features`, stale dev cfg) embed nothing and load the vite
# devUrl instead — the app then renders "Could not connect to localhost".
ASSET_COUNT=$(strings "$BINARY" | grep -c 'assets/' || true)
if [[ "$ASSET_COUNT" -lt 50 ]]; then
  echo "error: $BINARY has no embedded frontend assets ($ASSET_COUNT asset refs found)"
  echo "       this looks like a dev-mode build; the installed app would show"
  echo "       'Could not connect to localhost: Connection refused'."
  echo "       rebuild with: cd apps/desktop && pnpm tauri build"
  exit 1
fi

PKGNAME="axn-term"
PKGVER=$(node -p "require('$TAURI_CONF').version")
PKGREL=1
ARCH="x86_64"
PKGFILE="$OUTPUT_DIR/${PKGNAME}-${PKGVER}-${PKGREL}-${ARCH}.pkg.tar.zst"

STAGEDIR=$(mktemp -d)
trap 'rm -rf "$STAGEDIR"' EXIT

mkdir -p "$STAGEDIR/usr/bin"
mkdir -p "$STAGEDIR/usr/share/applications"
mkdir -p "$STAGEDIR/usr/share/pixmaps"

cp -a "$BINARY" "$STAGEDIR/usr/bin/axn-term"
chmod 755 "$STAGEDIR/usr/bin/axn-term"
cp -a "$ICON_SRC" "$STAGEDIR/usr/share/pixmaps/axn-term.png"

cat > "$STAGEDIR/usr/share/applications/axn-term.desktop" <<'EOF'
[Desktop Entry]
Name=axn-term
Comment=axn-term desktop terminal
Exec=axn-term %U
Icon=axn-term
Type=Application
Terminal=false
Categories=System;TerminalEmulator;
EOF

cat > "$STAGEDIR/.PKGINFO" <<EOF
pkgname = $PKGNAME
pkgver = ${PKGVER}-${PKGREL}
arch = $ARCH
pkgdesc = axn-term desktop terminal
license = unknown
builddate = $(date -u +%s)
packager = axn-term Builder
size = $(du -sb "$STAGEDIR/usr" | cut -f1)
depend = webkit2gtk-4.1
depend = gtk3
depend = libayatana-appindicator
depend = openssl
EOF

mkdir -p "$OUTPUT_DIR"
tar -C "$STAGEDIR" -cf - .PKGINFO usr | zstd -19 -T0 > "$PKGFILE"

echo "==> Arch package: $PKGFILE"
