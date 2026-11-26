#!/usr/bin/env bash
# check-workflow-purity.sh — block non-deterministic patterns in Temporal workflows.
#
# Temporal workflow code runs under a deterministic sandbox. Calls that read
# "real" time, real randomness, or the real outside world break replay and
# cause silent corruption of in-flight workflows. This script scans the
# workflow files and the helper modules bundled with them (every non-spec
# backend/src/workflows/*.ts) for banned patterns. It does not follow imports
# outside that directory; keep shared helpers dependency-free.
#
# Clock reads (CLAUDE.md safety rule 8): workflow code reads the time only
# through workflowNow() in workflow-time.ts, which is the one file allowed to
# call the Date constructor without arguments. Temporal's sandbox makes that
# deterministic workflow time; banning `Date.now()` and `new Date()` elsewhere
# keeps every clock read in one documented, replay-safe place.
# `new Date(value)` converts a given value and stays allowed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/backend/src/workflows"

# Patterns that must not appear in workflow files.
# Each entry is a `label|ripgrep-pattern` pair.
BANNED=(
  "Math.random|Math\\.random\\("
  "crypto.randomUUID|crypto\\.randomUUID\\("
  "crypto.randomBytes|crypto\\.randomBytes\\("
  "process.env read|process\\.env\\."
  "fetch call|\\bfetch\\("
  "axios import|from ['\"]axios['\"]"
  "direct mongoose import|from ['\"]mongoose['\"]"
  "direct nestjs import|from ['\"]@nestjs/"
  "setTimeout raw|\\bsetTimeout\\("
  "setInterval raw|\\bsetInterval\\("
  "Date.now (use workflowNow())|\\bDate\\.now\\("
  "new Date() clock read (use workflowNow())|new Date\\(\\s*\\)"
)

# Files that may contain a banned pattern on purpose, as `pattern-label|relative path`.
EXEMPT=(
  "new Date() clock read (use workflowNow())|workflow-time.ts"
)

is_exempt() {
  local label="$1" file="$2"
  for e in "${EXEMPT[@]}"; do
    if [[ "${e%%|*}" == "$label" && "$file" == "$WORKFLOWS_DIR/${e##*|}" ]]; then
      return 0
    fi
  done
  return 1
}

# Regex listing allowed comment patterns that reference banned names (e.g.
# "DETERMINISM: No Math.random()" — documentation, not code).
ALLOWED_COMMENT_REGEX='^\s*\*'

VIOLATIONS=""
for entry in "${BANNED[@]}"; do
  label="${entry%%|*}"
  pattern="${entry##*|}"

  while IFS=: read -r file lineno content; do
    [[ -z "$file" ]] && continue
    # Skip comment lines (" * " at start).
    if [[ "$content" =~ $ALLOWED_COMMENT_REGEX ]]; then continue; fi
    # Skip single-line comments.
    if [[ "$content" =~ ^\s*// ]]; then continue; fi
    if is_exempt "$label" "$file"; then continue; fi
    VIOLATIONS+="$file:$lineno [$label] $content"$'\n'
  done < <(grep -rnE "$pattern" "$WORKFLOWS_DIR" --include='*.ts' --exclude='*.spec.ts' 2>/dev/null || true)
done

if [[ -n "$VIOLATIONS" ]]; then
  echo "ERROR: workflow files contain non-deterministic patterns:" >&2
  echo "$VIOLATIONS" >&2
  echo "Fix: move the side-effecting call into an activity (activities/*.ts); read the clock" >&2
  echo "     with workflowNow() from workflows/workflow-time.ts." >&2
  echo "     See: https://docs.temporal.io/develop/typescript/core-application#workflow-determinism" >&2
  exit 1
fi

echo "OK: workflow files are free of non-deterministic patterns"
