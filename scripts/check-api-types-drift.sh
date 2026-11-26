#!/usr/bin/env bash
# check-api-types-drift.sh — fail if frontend generated API types diverge from committed swagger-spec.json.
# Run in CI after checkout. Requires: frontend deps installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
TYPES_FILE="$FRONTEND_DIR/src/generated/api.types.ts"

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "ERROR: frontend/node_modules missing. Run 'npm ci' in frontend/ first." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/swagger-spec.json" ]]; then
  echo "ERROR: swagger-spec.json missing at repo root." >&2
  exit 1
fi

# Regenerate into a temp file and diff against the committed version.
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

(cd "$FRONTEND_DIR" && npx --no-install openapi-typescript ../swagger-spec.json -o "$TMP_FILE" >/dev/null 2>&1)

if ! diff -q "$TYPES_FILE" "$TMP_FILE" >/dev/null 2>&1; then
  echo "ERROR: frontend/src/generated/api.types.ts is out of sync with swagger-spec.json." >&2
  echo "Fix: cd frontend && npm run generate:api && commit the result." >&2
  echo "" >&2
  diff -u "$TYPES_FILE" "$TMP_FILE" | head -60 >&2
  exit 1
fi

echo "OK: API types in sync with swagger-spec.json"
