#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-/opt/orangepi-edge}"

cd "$PROJECT_DIR"

echo "[deploy] Pulling latest container images"
docker compose pull

echo "[deploy] Restarting service"
docker compose up -d --remove-orphans

echo "[deploy] Running quick health check"
curl --fail --silent http://localhost:4000/api/v1/health >/dev/null

echo "[deploy] Deployment completed"
