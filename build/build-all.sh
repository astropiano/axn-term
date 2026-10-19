#!/usr/bin/env bash
# Build everything using the Docker builders: desktop artifacts into
# ./artifacts/ and the online server images (gateway + session host).

set -euo pipefail

cd "$(dirname "$0")/.."

./build/build-desktop.sh
./build/build-server.sh

echo ""
echo "✅ Desktop artifacts in ./artifacts/, server images axn-term-gateway + axn-term-host built"
