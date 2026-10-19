#!/usr/bin/env bash
# Build the Tauri desktop app using the Docker builder.
# No host Rust toolchain is required.

set -euo pipefail

cd "$(dirname "$0")/.."

export HOST_UID=$(id -u)
export HOST_GID=$(id -g)

docker compose -f docker-compose.build.yml run --build --rm desktop-build

echo ""
echo "✅ Desktop build complete. Artifacts are in ./artifacts/desktop/"
