#!/usr/bin/env bash
# Build the container-sandbox toolchain image (pinned versions, linux natives).
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
# Docker Hub is often unreachable from CN networks; fall back to a mirror.
MIRROR_REGISTRY="https://registry.npmmirror.com"

echo "Building qubits-toolchain:latest (npm registry: $REGISTRY)"
docker build -f scripts/toolchain-image.dockerfile \
  --build-arg "NPM_REGISTRY=$REGISTRY" \
  -t qubits-toolchain:latest . 2>&1 | tail -20
echo "OK: qubits-toolchain:latest"
