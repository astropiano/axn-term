#!/usr/bin/env bash
set -euo pipefail

# Regenerates src-tauri/icons/icon.icns (macOS bundle + DMG icon) from
# src-tauri/icons/icon-macos.svg — the axn-term glyph plated on the axn-dark
# background. macOS composites Dock icons over the translucent Dock, so the
# transparent-interior asset used elsewhere (icons/*.png, Linux package,
# Windows) shows the Dock's gray blur through the icon; only the .icns gets
# the plate.
#
# Needs rsvg-convert (brew install librsvg) and iconutil (ships with macOS).

if [[ "$(uname)" != "Darwin" ]]; then
  echo "make-macos-icon: macOS only, skipping" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/apps/desktop/src-tauri/icons/icon-macos.svg"
OUT="$REPO_ROOT/apps/desktop/src-tauri/icons/icon.icns"

ICONSET="$(mktemp -d -t axn-iconset)/axn-term.iconset"
trap 'rm -rf "$(dirname "$ICONSET")"' EXIT
mkdir -p "$ICONSET"

# iconset naming: icon_NxN.png and icon_NxN@2x.png (rendered at 2N).
for spec in 16:16 16:32 32:32 32:64 128:128 128:256 256:256 256:512 512:512 512:1024; do
  name="${spec%%:*}"
  size="${spec##*:}"
  suffix=""
  [ "$size" -ne "$name" ] && suffix="@2x"
  rsvg-convert -w "$size" -h "$size" \
    -o "$ICONSET/icon_${name}x${name}${suffix}.png" "$SRC"
done

iconutil -c icns "$ICONSET" -o "$OUT"
echo "make-macos-icon: wrote $OUT"
