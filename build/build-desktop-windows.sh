#!/usr/bin/env bash
# Cross-compile the Windows desktop app (NSIS installer) using the Docker
# builder. No host Rust toolchain or Windows machine is required.

set -euo pipefail

cd "$(dirname "$0")/.."

export HOST_UID=$(id -u)
export HOST_GID=$(id -g)

docker compose -f docker-compose.build.yml run --build --rm desktop-windows-build

echo ""
echo "✅ Windows build complete. Installer is in ./artifacts/windows/bundle/"
