#!/usr/bin/env bash
# check-hex-colors.sh — fail if frontend components/features/pages contain raw hex colors.
# Enforces "use BRAND/SEMANTIC tokens from themeConfig.ts" rule.
# Theme/config files are allowed to contain hex values (that's where they're defined).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_SRC="$REPO_ROOT/frontend/src"

# Files that are allowed to contain raw hex values.
# - theme/, config/: these are the definition sites for colors
# - generated/, interfaces/: auto-generated or external contract
# - blueprints/connectors/, blueprints/shared/: vendor brand identity colors (Microsoft, Slack, etc.) — must match the vendor's brand guide, not our palette
ALLOWED=(
  "frontend/src/theme/"
  "frontend/src/config/"
  "frontend/src/generated/"
  "frontend/src/interfaces/"
  "frontend/src/features/blueprints/connectors/"
  "frontend/src/features/blueprints/shared/"
  # RoleBundleManager exposes a color-picker with preset swatches — these are user-data values, not theme colors.
  "frontend/src/components/policy-engine/RoleBundleManager.tsx"
)

build_prune() {
  local args=()
  for p in "${ALLOWED[@]}"; do
    args+=(-not -path "*/$p*")
  done
  printf '%s ' "${args[@]}"
}

# Find hex color literals in string positions, excluding allowed paths.
# Pattern matches: "#abc", "#abcdef", '#abc', '#abcdef' inside string literals.
# Use Grep-equivalent bash (ripgrep not guaranteed in CI container).
HITS=""
while IFS= read -r -d '' file; do
  # shellcheck disable=SC2016
  if grep -HnE "['\"]#[0-9a-fA-F]{3,8}['\"]" "$file" 2>/dev/null; then
    HITS="found"
  fi
done < <(eval "find \"$FRONTEND_SRC\" -type f \( -name '*.ts' -o -name '*.tsx' \) $(build_prune) -print0")

if [[ -n "$HITS" ]]; then
  echo "" >&2
  echo "ERROR: raw hex color literals found outside theme/config/." >&2
  echo "Use BRAND.* or SEMANTIC.* tokens from frontend/src/theme/themeConfig.ts, or theme.useToken()." >&2
  exit 1
fi

echo "OK: no raw hex colors outside theme/"
