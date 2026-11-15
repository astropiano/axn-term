#!/bin/bash
# Build the axn-term Android app (APK) in a container.
#
#   apps/mobile/build/android/build.sh [debug|release]
#
# Output: apps/mobile/build/artifacts/android/*.apk
#
# The checkout is mounted read-only and copied into the container (a pnpm
# install on the mounted tree would replace the host's node_modules).
# pnpm store, Gradle and ~/.android (the debug signing key) live in named
# volumes, so rebuilds are fast and debug APKs install over each other.
#
# RAMPHASTOS_LOCAL_DEPS=1 additionally mounts the sibling ../ramphastos
# checkout and builds the web bundle's ramphastos-client from it instead
# of the published npm package (AXN_LIBS_ROOT overrides its path; rebuild
# the client package's dist/ when its sources change).
#
# Release APKs are signed when ANDROID_KEYSTORE (path), ANDROID_KEYSTORE_PASSWORD,
# ANDROID_KEY_ALIAS (and optionally ANDROID_KEY_PASSWORD) are set; otherwise
# with the shared debug key (installable for testing, not for a store).
#
# Engine: docker by default; CONTAINER_ENGINE=podman (or docker → podman
# emulation) works too.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LIBS_ROOT="$(readlink -f "${AXN_LIBS_ROOT:-$REPO_ROOT/..}" 2>/dev/null || echo "${AXN_LIBS_ROOT:-$REPO_ROOT/..}")"
ARTIFACTS_DIR="$REPO_ROOT/apps/mobile/build/artifacts/android"
IMAGE_NAME="axn-term-android-builder"
ENGINE="${CONTAINER_ENGINE:-docker}"

BUILD_TYPE="${1:-debug}"
if [[ "$BUILD_TYPE" != "debug" && "$BUILD_TYPE" != "release" ]]; then
  echo "Usage: $0 [debug|release]"
  exit 1
fi
# With RAMPHASTOS_LOCAL_DEPS=1 the web bundle compiles the ramphastos
# client from the sibling checkout — a stale one ships old hub-protocol
# bugs. Warn (don't fail: offline builds).
if [[ -n "${RAMPHASTOS_LOCAL_DEPS:-}" ]]; then
  if [ ! -d "$LIBS_ROOT/ramphastos" ]; then
    echo "RAMPHASTOS_LOCAL_DEPS is set but no sibling checkout found: $LIBS_ROOT/ramphastos (set AXN_LIBS_ROOT)" >&2
    exit 1
  fi
  if behind=$(timeout 15 git -C "$LIBS_ROOT/ramphastos" fetch -q 2>/dev/null &&
              git -C "$LIBS_ROOT/ramphastos" rev-list --count 'HEAD..@{u}' 2>/dev/null) && [ "${behind:-0}" -gt 0 ]; then
    echo "warning: $LIBS_ROOT/ramphastos is $behind commit(s) behind its upstream — pull it (and rebuild its client dist) first" >&2
  fi
fi

# Rootless podman maps the container user to the host user only with
# keep-id; otherwise artifacts would belong to a subordinate uid.
USERNS=()
if "$ENGINE" --version 2>/dev/null | grep -qi podman; then
  USERNS=(--userns=keep-id)
fi

mkdir -p "$ARTIFACTS_DIR"
echo "Building Android $BUILD_TYPE APK..."

"$ENGINE" build \
  --build-arg USER_ID="$(id -u)" \
  --build-arg GROUP_ID="$(id -g)" \
  -t "$IMAGE_NAME" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR"

# ${BUILD_TYPE^} needs bash 4 — macOS ships 3.2.
BUILD_TYPE_CAP="$(tr '[:lower:]' '[:upper:]' <<< "${BUILD_TYPE:0:1}")${BUILD_TYPE:1}"
GRADLE_TASK="assemble${BUILD_TYPE_CAP}"

# Clean old artifacts before copying new ones
rm -f "$ARTIFACTS_DIR"/*.apk

SIGN_ENV=()
SIGN_MOUNT=()
if [[ "$BUILD_TYPE" == "release" && -n "${ANDROID_KEYSTORE:-}" ]]; then
  SIGN_MOUNT=(-v "$(readlink -f "$ANDROID_KEYSTORE"):/keystore.jks:ro,z")
  SIGN_ENV=(
    -e ANDROID_KEYSTORE_PASSWORD
    -e ANDROID_KEY_ALIAS
    -e ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-${ANDROID_KEYSTORE_PASSWORD:-}}"
  )
fi

# RAMPHASTOS_LOCAL_DEPS=1 mounts the ramphastos checkout next to the
# copied repo — the same sibling layout as on the host (../ramphastos) —
# so vite's ramphastos-client alias resolves through ../../../ramphastos.
LIBS_MOUNT=()
if [[ -n "${RAMPHASTOS_LOCAL_DEPS:-}" ]]; then
  LIBS_MOUNT=(-v "$LIBS_ROOT/ramphastos:/work/tassistant/ramphastos:ro,z")
fi

"$ENGINE" run --rm "${USERNS[@]+"${USERNS[@]}"}" \
  -v "$REPO_ROOT:/src/tassistant/axn-term:ro,z" \
  "${LIBS_MOUNT[@]+"${LIBS_MOUNT[@]}"}" \
  -v "$ARTIFACTS_DIR:/out:z" \
  -v axn-term-android-pnpm:/cache/pnpm \
  -v axn-term-android-gradle:/cache/gradle \
  -v axn-term-android-home:/cache/android \
  "${SIGN_MOUNT[@]+"${SIGN_MOUNT[@]}"}" \
  "${SIGN_ENV[@]+"${SIGN_ENV[@]}"}" \
  -e BUILD_TYPE="$BUILD_TYPE" \
  -e GRADLE_TASK="$GRADLE_TASK" \
  -e RAMPHASTOS_LOCAL_DEPS="${RAMPHASTOS_LOCAL_DEPS:-}" \
  -e GRADLE_USER_HOME=/cache/gradle \
  -e ANDROID_USER_HOME=/cache/android \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    # A login shell resets PATH from /etc/profile — restore the image tools.
    export PATH="$JAVA_HOME/bin:$ANDROID_HOME/build-tools/36.0.0:$ANDROID_HOME/platform-tools:$PATH"
    mkdir -p /work/tassistant
    rsync -a --delete \
      --exclude node_modules --exclude target --exclude dist --exclude .claude \
      --exclude "apps/mobile/build/artifacts" \
      --exclude "apps/mobile/android/.gradle" --exclude "apps/mobile/android/app/build" \
      --exclude "apps/mobile/android/build" \
      /src/tassistant/axn-term/ /work/tassistant/axn-term/
    cd /work/tassistant/axn-term
    # Debug key lives in the persistent ~/.android volume.
    ln -sfn /cache/android "$HOME/.android"
    pnpm config set store-dir /cache/pnpm >/dev/null
    pnpm install --frozen-lockfile
    pnpm --dir apps/web exec vite build --mode mobile
    cd apps/mobile
    pnpm exec cap sync android
    cd android
    ./gradlew --no-daemon "$GRADLE_TASK"
    out=app/build/outputs/apk/$BUILD_TYPE
    if [[ "$BUILD_TYPE" == "release" && -f /keystore.jks ]]; then
      unsigned=$(ls "$out"/*-unsigned.apk | head -1)
      zipalign -p -f 4 "$unsigned" /tmp/aligned.apk
      apksigner sign --ks /keystore.jks --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
        --key-pass env:ANDROID_KEY_PASSWORD --ks-key-alias "$ANDROID_KEY_ALIAS" \
        --out /out/axn-term-release.apk /tmp/aligned.apk
    elif [[ "$BUILD_TYPE" == "release" ]]; then
      # No release key given: sign with the shared debug key so the APK
      # installs for testing (and updates a debug install). Not for stores.
      unsigned=$(ls "$out"/*-unsigned.apk | head -1)
      zipalign -p -f 4 "$unsigned" /tmp/aligned.apk
      apksigner sign --ks /cache/android/debug.keystore --ks-pass pass:android \
        --key-pass pass:android --ks-key-alias androiddebugkey \
        --out /out/axn-term-release-debugkey.apk /tmp/aligned.apk
    else
      cp "$out"/*.apk /out/
    fi
    rm -f /out/*.idsig
  '

echo "APK(s) copied to $ARTIFACTS_DIR:"
ls -1 "$ARTIFACTS_DIR"
