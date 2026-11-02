#!/usr/bin/env bash
# Cross-compile the Tauri desktop app for Windows (x86_64-pc-windows-msvc)
# inside the Windows builder container and bundle an NSIS installer.

set -euo pipefail

SOURCE="${SOURCE:-/src}"
BUILD="${BUILD:-/build/source}"
OUTPUT="${OUTPUT:-/output}"
TARGET=x86_64-pc-windows-msvc
CARGO_HOME="${CARGO_HOME:-/cache/cargo}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/cache/cargo/target}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-/cache/pnpm/store}"
VITE_CACHE_DIR="${VITE_CACHE_DIR:-/cache/vite}"
# cargo-xwin's MSVC CRT + Windows SDK download (~700 MB, fetched once).
XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-/cache/xwin}"

echo "==> Preparing build directory..."
mkdir -p "$(dirname "$BUILD")" "$OUTPUT" "$CARGO_TARGET_DIR" "$PNPM_STORE_DIR" "$VITE_CACHE_DIR" "$XWIN_CACHE_DIR"
rm -rf "$BUILD"
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='artifacts' \
  --exclude='target' \
  --exclude='dist' \
  --exclude='.claude' \
  "$SOURCE/" "$BUILD/"

cd "$BUILD"

# Release builds (CI) stamp the tag's version into the build copy only.
if [[ -n "${APP_VERSION:-}" ]]; then
  echo "==> Setting app version to $APP_VERSION..."
  "$BUILD/build/scripts/set-version.sh" "$APP_VERSION"
fi

export CARGO_HOME CARGO_TARGET_DIR VITE_CACHE_DIR XWIN_CACHE_DIR
export CARGO_INCREMENTAL=1

pnpm config set store-dir "$PNPM_STORE_DIR" --global

echo "==> Installing JS/TS dependencies..."
pnpm install --frozen-lockfile

echo "==> Building Tauri desktop app for $TARGET..."
cd apps/desktop
# Only NSIS cross-builds on Linux; MSI needs WiX, which is Windows-only.
pnpm tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

echo "==> Staging artifacts..."
RELEASE="$CARGO_TARGET_DIR/$TARGET/release"
mkdir -p "$OUTPUT/windows/bin" "$OUTPUT/windows/bundle"
cp -a "$RELEASE/axn-term.exe" "$OUTPUT/windows/bin/"
cp -a "$RELEASE/bundle/nsis/"*.exe "$OUTPUT/windows/bundle/"

if [[ -n "${HOST_UID:-}" ]]; then
  echo "==> Fixing output ownership..."
  chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" "$OUTPUT/windows"
fi

echo "==> Windows build complete: $OUTPUT/windows"
