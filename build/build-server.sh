#!/usr/bin/env bash
# Build the online server images (.NET gateway + session host).
# No host .NET SDK is required — both Dockerfiles publish inside the build.
#
# Produces axn-term-gateway:latest and axn-term-host:latest, the tags the
# axn-term-online scenario runs. Build into the engine the gateway's
# DOCKER_SOCK points at, or it has no session-host image to spawn.

set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f docker-compose.build.yml --profile server build gateway-image session-host-image

echo ""
echo "✅ Server images built: axn-term-gateway:latest, axn-term-host:latest"
