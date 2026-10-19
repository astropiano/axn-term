#!/usr/bin/env bash
# Build the Tauri desktop app inside the desktop builder container.

set -euo pipefail

SOURCE=/src
BUILD=/build/source
OUTPUT=/output
CARGO_HOME=/cache/cargo
CARGO_TARGET_DIR=/cache/cargo/target
PNPM_STORE_DIR=/cache/pnpm/store
VITE_CACHE_DIR=/cache/vite

echo "==> Preparing build directory..."
mkdir -p /build "$OUTPUT" "$CARGO_TARGET_DIR" "$PNPM_STORE_DIR" "$VITE_CACHE_DIR"
rm -rf "$BUILD"
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='artifacts' \
  --exclude='target' \
  --exclude='dist' \
  "$SOURCE/" "$BUILD/"

cd "$BUILD"

export CARGO_HOME
export CARGO_TARGET_DIR
export CARGO_INCREMENTAL=1
export VITE_CACHE_DIR

# Use a shared pnpm store and Vite dep-optimization cache across rebuilds.
pnpm config set store-dir "$PNPM_STORE_DIR" --global

echo "==> Installing JS/TS dependencies..."
pnpm install --frozen-lockfile

echo "==> Building Tauri desktop app..."
cd apps/desktop
# linuxdeploy's bundled strip is too old for RELR (.relr.dyn) sections that
# modern toolchains emit in every .so — it aborts the whole AppImage bundle.
export NO_STRIP=1
pnpm tauri build

echo "==> Staging artifacts..."
mkdir -p "$OUTPUT/desktop/bin" "$OUTPUT/desktop/bundle"
cp -a "$CARGO_TARGET_DIR/release/axn-term" "$OUTPUT/desktop/bin/" 2>/dev/null || true
cp -a "$CARGO_TARGET_DIR/release/bundle/"* "$OUTPUT/desktop/bundle/" 2>/dev/null || true

echo "==> Building Arch Linux package..."
OUTPUT_DIR="$OUTPUT/desktop" "$BUILD/build/scripts/package-arch.sh" "$CARGO_TARGET_DIR/release/axn-term"

echo "==> Fixing output ownership..."
chown -R "${HOST_UID}:${HOST_GID}" "$OUTPUT/desktop"

echo "==> Desktop build complete: $OUTPUT/desktop"
