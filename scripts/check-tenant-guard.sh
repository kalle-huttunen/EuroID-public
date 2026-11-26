#!/usr/bin/env bash
# check-tenant-guard.sh — fail on patterns that bypass the Mongoose tenant plugin.
# The plugin intercepts Model.find/updateOne/etc. and injects tenantId. Going through
# `.collection.<op>()` (the raw MongoDB driver) sidesteps it and is a tenant-isolation escape.
# Legitimate opt-outs use `{ skipTenantScope: true }` on the Model-level call, not collection bypass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_SRC="$REPO_ROOT/backend/src"

# Files allowed to bypass (infrastructure that operates system-wide or migrations).
# - tenant.plugin.ts itself sets up the plugin
# - migrate-tenant-data.ts is the one-shot migration tool
# - migrations/ are DB migrations that run outside request context
ALLOWED=(
  "backend/src/infrastructure/multi-tenancy/tenant.plugin.ts"
  "backend/src/infrastructure/multi-tenancy/migrate-tenant-data.ts"
  "backend/src/migrations/"
)

build_prune() {
  local args=()
  for p in "${ALLOWED[@]}"; do
    args+=(-not -path "*/$p*")
  done
  printf '%s ' "${args[@]}"
}

# Patterns that bypass the tenant plugin:
# 1. `.collection.find(`, `.collection.findOne(`, `.collection.updateOne(`, etc.
# 2. `.db.collection(` — raw driver access.
PATTERN='\.collection\.(find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|aggregate|insertOne|insertMany|countDocuments|distinct)\(|\.db\.collection\('

HITS=""
while IFS= read -r -d '' file; do
  if grep -HnE "$PATTERN" "$file" 2>/dev/null; then
    HITS="found"
  fi
done < <(eval "find \"$BACKEND_SRC\" -type f -name '*.ts' -not -name '*.spec.ts' -not -name '*.test.ts' $(build_prune) -print0")

if [[ -n "$HITS" ]]; then
  echo "" >&2
  echo "ERROR: raw MongoDB collection access found. These bypass the tenant plugin." >&2
  echo "Fix: use the Mongoose Model (model.find(), model.updateOne(), etc.). For intentional" >&2
  echo "system-wide queries, pass { skipTenantScope: true } in the options object." >&2
  exit 1
fi

echo "OK: no tenant-plugin bypasses found"
