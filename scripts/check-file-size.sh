#!/usr/bin/env bash
# check-file-size.sh — fail on oversized backend source files.
# Target is ~250 lines (see CLAUDE.md). Hard ceiling is 600 lines for non-test,
# non-schema, non-mapper files outside the event registries. Existing offenders are
# grandfathered below;
# each entry should be removed as the file is split.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_SRC="$REPO_ROOT/backend/src"

HARD_LIMIT=600

# Files exempt from the hard limit. Reduce this list — do not grow it.
# Tests, schemas, and mappers are legitimately large per CLAUDE.md and skipped by pattern.
GRANDFATHERED=(
  "activities/reconciliation.activities.ts"
  "modules/policy/policy-engine.service.ts"
  "modules/intelligence/intelligence.service.ts"
  "modules/compliance-reporting/compliance-reporting.service.ts"
  "modules/entitlement-catalog/entitlement-catalog.service.ts"
)

is_grandfathered() {
  local rel="$1"
  for g in "${GRANDFATHERED[@]}"; do
    if [[ "$rel" == "$g" ]]; then
      return 0
    fi
  done
  return 1
}

VIOLATIONS=""
while IFS= read -r file; do
  rel="${file#"$BACKEND_SRC/"}"
  # Skip tests, schemas, mappers, generated, migrations.
  case "$rel" in
    *.spec.ts|*.test.ts) continue ;;
    *schemas/*|*.schema.ts) continue ;;
    *mapper*|*.mapper.ts) continue ;;
    generated/*|migrations/*) continue ;;
    # The event registries are declaration lists (one entry per event type, payload or schema):
    # they grow with the number of events, not with logic, like the schema files above.
    infrastructure/events/event-types.ts|infrastructure/events/event-payloads.ts) continue ;;
    infrastructure/events/event-payload-schemas.ts|infrastructure/events/*-event-schemas.ts) continue ;;
  esac

  lines=$(wc -l < "$file")
  if (( lines > HARD_LIMIT )); then
    if is_grandfathered "$rel"; then
      continue
    fi
    VIOLATIONS+="$rel ($lines lines)"$'\n'
  fi
done < <(find "$BACKEND_SRC" -type f -name '*.ts')

if [[ -n "$VIOLATIONS" ]]; then
  echo "ERROR: files exceed $HARD_LIMIT-line hard limit (target is ~250, per CLAUDE.md):" >&2
  echo "$VIOLATIONS" >&2
  echo "Fix: split the file, or justify and add to GRANDFATHERED in scripts/check-file-size.sh." >&2
  exit 1
fi

echo "OK: no new files over $HARD_LIMIT-line hard limit"
