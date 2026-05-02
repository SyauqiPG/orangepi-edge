#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deployment smoke test for orangepi-edge
#
# Builds Docker image, starts container, runs API smoke tests, then tears
# down. Exits 0 on success, non-zero on failure.
#
# Usage:
#   bash test/deploy/smoke.sh
#
# Environment variables:
#   SMOKE_TEST_URL   Base URL of the service (default: http://localhost:4000)
#   COMPOSE_FILE     Path to docker-compose.yml (default: docker-compose.yml)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.yml}"
SMOKE_TEST_URL="${SMOKE_TEST_URL:-http://localhost:4000}"
COMPOSE_PROJECT_NAME="orangepi-edge-smoke"

cd "$PROJECT_DIR"

echo "============================================"
echo "  Deployment Smoke Test"
echo "============================================"
echo "Project dir:  $PROJECT_DIR"
echo "Compose file: $COMPOSE_FILE"
echo "Test URL:     $SMOKE_TEST_URL"
echo ""

# ---------------------------------------------------------------------------
# Phase 1: Build
# ---------------------------------------------------------------------------
echo "[smoke] Building Docker image..."
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$COMPOSE_FILE" \
  build

echo "[smoke] Build completed."
echo ""

# ---------------------------------------------------------------------------
# Phase 2: Start
# ---------------------------------------------------------------------------
echo "[smoke] Starting container..."
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$COMPOSE_FILE" \
  up -d --remove-orphans

# Cleanup on exit
cleanup() {
  echo ""
  echo "[smoke] Tearing down container..."
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" \
    down --remove-orphans 2>/dev/null || true
  echo "[smoke] Teardown complete."
}
trap cleanup EXIT

echo "[smoke] Container started. Waiting for health check..."
echo ""

# ---------------------------------------------------------------------------
# Phase 3: Wait for health
# ---------------------------------------------------------------------------
MAX_RETRIES=30
RETRY_INTERVAL=2
HEALTHY=false

for i in $(seq 1 "$MAX_RETRIES"); do
  if curl --fail --silent "${SMOKE_TEST_URL}/api/v1/health" >/dev/null 2>&1; then
    HEALTHY=true
    echo "[smoke] Service is healthy after ${i}s."
    break
  fi
  echo "[smoke] Waiting... (${i}/${MAX_RETRIES})"
  sleep "$RETRY_INTERVAL"
done

if [ "$HEALTHY" != "true" ]; then
  echo "[smoke] ERROR: Service did not become healthy within $((MAX_RETRIES * RETRY_INTERVAL)) seconds."
  echo "[smoke] Container logs:"
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" \
    logs --tail=50
  exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Phase 4: Run API smoke tests
# ---------------------------------------------------------------------------
echo "[smoke] Running API smoke tests..."
SMOKE_TEST_URL="$SMOKE_TEST_URL" npx --yes node --test "$SCRIPT_DIR/deployment-smoke.test.js"

echo ""
echo "[smoke] All smoke tests passed!"
echo "============================================"
