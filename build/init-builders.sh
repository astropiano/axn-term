#!/usr/bin/env bash
# One-time setup: build the Docker builder images.

set -euo pipefail

cd "$(dirname "$0")/.."
docker compose -f docker-compose.build.yml build

echo "✅ Builder images ready."
