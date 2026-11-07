#!/usr/bin/env bash
set -euo pipefail

# Builds the distributable axn-term DMG the standard way: a single
# `hdiutil create -srcfolder <staging> -format UDZO` step that writes the
# compressed read-only image directly — no read-write image, no mounting,
# no AppleScript.
#
# This replaces tauri-bundler's bundled create-dmg fork, which mounts a
# read-write image and arranges Finder icons via AppleScript; that
# mount/detach round-trip regularly fails with "resource busy" and leaves
# stale `rw.*` volumes mounted. It also replaces the
# strip-dmg-volume-icon post-pass — no custom volume icon is ever set.
#
# Expects the .app bundle to exist already (`tauri build --bundles app`).
# No-op on non-macOS hosts.

if [[ "$(uname)" != "Darwin" ]]; then
  echo "make-dmg: macOS only, skipping"
  exit 0
fi

# Optional $1: app name (default axn-term; e.g. axn-term-hmr builds against
# the matching tauri.$2 config, defaulting to tauri.conf.json).
APP_NAME="${1:-axn-term}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/target/release/bundle"
APP_BUNDLE="$BUNDLE_DIR/macos/${APP_NAME}.app"
TAURI_CONF="${2:-$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "make-dmg: $APP_BUNDLE not found — run 'pnpm build:desktop' first" >&2
  exit 1
fi

VOLUME_NAME="$APP_NAME"
# version lives only in the base config — merged variant confs don't carry it.
VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -1)"
if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json" | head -1)"
fi
if [[ -z "$VERSION" ]]; then
  echo "make-dmg: could not read version from $TAURI_CONF or tauri.conf.json" >&2
  exit 1
fi

# Match tauri-bundler's dmg filename suffixes.
case "$(uname -m)" in
  arm64) ARCH="aarch64" ;;
  *) ARCH="x64" ;;
esac

DMG_DIR="$BUNDLE_DIR/dmg"
DMG_PATH="$DMG_DIR/${VOLUME_NAME}_${VERSION}_${ARCH}.dmg"
mkdir -p "$DMG_DIR"

# Detach stale volumes left by previous builds (the old script could crash
# after mounting); a lingering /Volumes/axn-term also confuses Finder when
# the new image is opened.
for mnt in /Volumes/"$VOLUME_NAME"* /Volumes/dmg.*; do
  if [[ -d "$mnt" ]]; then
    hdiutil detach "$mnt" -force >/dev/null 2>&1 || true
  fi
done

STAGING="$(mktemp -d -t axn-dmg)"
trap 'rm -rf "$STAGING"' EXIT

# What the user sees in the dmg window: the app plus the classic
# /Applications drop-target symlink. ditto preserves the bundle's metadata.
ditto "$APP_BUNDLE" "$STAGING/$(basename "$APP_BUNDLE")"
ln -s /Applications "$STAGING/Applications"

hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING" \
  -ov -format UDZO -imagekey zlib-level=9 \
  "$DMG_PATH" -quiet

echo "make-dmg: created $DMG_PATH"
