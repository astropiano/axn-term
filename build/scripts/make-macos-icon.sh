#!/usr/bin/env bash
set -euo pipefail

# Regenerates src-tauri/icons/icon.icns (macOS bundle + DMG icon) from
# src-tauri/icons/icon-macos.svg — the axn-term glyph plated on the axn-dark
# background. macOS composites Dock icons over the translucent Dock, so the
# transparent-interior asset used elsewhere (icons/*.png, Linux package,
# Windows) shows the Dock's gray blur through the icon; only the .icns gets
# the plate.
#
# `./make-macos-icon.sh hmr` instead regenerates the axn-term-hmr dev
# variant's whole set in src-tauri/icons-hmr/ — .icns plus the PNG/ICO
# files listed under bundle.icon in tauri.term-hmr.conf.json — all rendered
# from the yellow-plated icons-hmr/icon-macos.svg (the yellow identifies
# the dev build on every platform, not just macOS).
#
# Needs rsvg-convert (brew install librsvg) and iconutil (ships with
# macOS); the hmr variant's .ico additionally needs ImageMagick `convert`.

if [[ "$(uname)" != "Darwin" ]]; then
  echo "make-macos-icon: macOS only, skipping" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

VARIANT="${1:-}"
if [[ "$VARIANT" == "hmr" ]]; then
  ICONS_DIR="$REPO_ROOT/apps/desktop/src-tauri/icons-hmr"
  APP_NAME="axn-term-hmr"
elif [[ -z "$VARIANT" ]]; then
  ICONS_DIR="$REPO_ROOT/apps/desktop/src-tauri/icons"
  APP_NAME="axn-term"
else
  echo "make-macos-icon: unknown variant '$VARIANT' (expected no arg or 'hmr')" >&2
  exit 1
fi

SRC="$ICONS_DIR/icon-macos.svg"
OUT="$ICONS_DIR/icon.icns"

ICONSET="$(mktemp -d -t axn-iconset)/${APP_NAME}.iconset"
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

if [[ "$VARIANT" == "hmr" ]]; then
  # The dev variant renders every raster asset from the plated SVG — there
  # is no transparent-interior set for it. The full-bleed plate makes
  # rsvg-convert emit opaque RGB PNGs, so they go through ImageMagick's
  # PNG32 (8-bit RGBA) — Tauri refuses non-RGBA icons at build time.
  for size in 32 128 256 512; do
    case "$size" in
      32)  out="32x32.png" ;;
      128) out="128x128.png" ;;
      256) out="128x128@2x.png" ;;
      512) out="icon.png" ;;
    esac
    rsvg-convert -w "$size" -h "$size" "$SRC" \
      | convert png:- "PNG32:$ICONS_DIR/$out"
  done
  convert "$ICONS_DIR/icon.png" \
    -define icon:auto-resize=256,128,64,48,32,16 \
    "$ICONS_DIR/icon.ico"
  echo "make-macos-icon: wrote PNG/ICO set in $ICONS_DIR"
fi
