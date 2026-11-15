#!/usr/bin/env bash
# Build the per-user session-host image (axn-term-host) that the gateway
# spawns through the docker/podman socket.
#
# compose.yaml declares the session-host service with `scale: 0`, and
# podman-compose never builds services it doesn't start — so on a fresh
# machine the gateway has no image to spawn. Run this once (and again after
# changing apps/session-host or session-host/), into the same engine the
# gateway's DOCKER_SOCK points at.
#
#   CONTAINER_ENGINE=podman scenarios/axn-term-online/build-session-host.sh
#
# CONTAINER_ENGINE defaults to docker when available, else podman.
# SESSION_HOST_IMAGE overrides the tag (default axn-term-host, matching the
# gateway's SESSION_HOST_IMAGE).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${AXN_TERM_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
IMAGE="${SESSION_HOST_IMAGE:-axn-term-host}"

if [ -n "${CONTAINER_ENGINE:-}" ]; then
  ENGINE="$CONTAINER_ENGINE"
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "error: neither docker nor podman found (set CONTAINER_ENGINE)" >&2
  exit 1
fi

echo "==> Building $IMAGE with $ENGINE (repo: $REPO_ROOT)"

# Default: published Ramphastos.* NuGet packages. RAMPHASTOS_LOCAL_DEPS=1
# builds against the sibling checkout — the `libraries` context must then
# point at the dir containing it (../ramphastos next to axn-term).
ARGS=()
if [ -n "${RAMPHASTOS_LOCAL_DEPS:-}" ]; then
  LIBS_ROOT="${AXN_LIBS_ROOT:-$(cd "$REPO_ROOT/.." 2>/dev/null && pwd || echo "$REPO_ROOT/..")}"
  ARGS+=(--build-context "libraries=$LIBS_ROOT" --build-arg "RAMPHASTOS_LOCAL_DEPS=$RAMPHASTOS_LOCAL_DEPS")
  echo "==> RAMPHASTOS_LOCAL_DEPS: sibling checkout at $LIBS_ROOT"
fi

"$ENGINE" build \
  --build-context "axn-term=$REPO_ROOT" \
  ${ARGS[@]+"${ARGS[@]}"} \
  -t "$IMAGE" \
  -f "$SCRIPT_DIR/session-host/Dockerfile" \
  "$SCRIPT_DIR/session-host"
