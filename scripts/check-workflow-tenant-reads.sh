#!/usr/bin/env bash
# check-workflow-tenant-reads.sh — fail when code reads or controls a Temporal workflow by id
# without the tenant check.
#
# Workflow ids are guessable (t-<tenant>-bulk-<batch>-<ms>, t-<tenant>-onboard-<identityId>) and a
# Temporal handle answers for any id in the namespace. A route that describes, queries, reads
# the result or history of, signals or cancels a workflow by an id from the request must take
# the handle from getTenantWorkflow() (backend/src/infrastructure/temporal/tenant-workflow.ts),
# which answers 404 unless the workflow's TenantId search attribute is the caller's tenant.
# Companion to check-request-tenant-fields.sh.
#
# Rule (non-spec files under backend/src): no `getHandle(` outside tenant-workflow.ts, unless
# the file is allow-listed below with the reason its workflow ids cannot come from the request.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_SRC="$REPO_ROOT/backend/src"

# Files allowed to call getHandle() directly, as "path|reason". An entry needs a reason.
ALLOWED=(
  "backend/src/infrastructure/temporal/tenant-workflow.ts|The tenant check itself."
  "backend/src/modules/access-requests/access-request-decision.service.ts|Signals doc.workflowId of an access request it loaded through the tenant-scoped model; the request names the access request, never the workflow."
  "backend/src/modules/access-requests/access-request-manual-removal.service.ts|Signals doc.workflowId of an access request it loaded through the tenant-scoped model (findOne with the context tenant); the request names the access request, never the workflow."
  "backend/src/modules/access-review/access-review-item.service.ts|Signals campaign.workflowId of a campaign loaded through the tenant-scoped model."
  "backend/src/modules/access-review/access-review-campaign.service.ts|Cancels campaign.workflowId of a campaign loaded through the tenant-scoped model (findOne with the context tenant)."
  "backend/src/modules/privileged-access/pam-session.service.ts|Signals the privileged session of an admin identity its callers load through the tenant-scoped model (deactivate, the hourly sweep, offboarding's linked admin lookup, the identity.deleted handler); the id is built from the tenant and that admin identity's id, never taken from a request."
  "backend/src/infrastructure/temporal/schedule-upsert.ts|Updates and deletes the worker's own schedules by the constant schedule ids worker.ts passes; a schedule handle, never a workflow, and no id from a request."
  "backend/src/modules/reconciliation/orphan-cleanup.service.ts|Describes, signals and cancels drift.workflowId of an orphan drift its callers load through the tenant-scoped model (orphan ADOPT/DELETE, detection, a drift closed by hand); starts cleanups under ids built from the drift."
)

is_allowed() {
  local rel="$1"
  for entry in "${ALLOWED[@]}"; do
    if [[ "$rel" == "${entry%%|*}" ]]; then
      return 0
    fi
  done
  return 1
}

HITS=""
while IFS= read -r -d '' file; do
  rel="${file#"$REPO_ROOT/"}"
  is_allowed "$rel" && continue
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "$rel:$line"
    HITS="found"
  done <<< "$(grep -nP '\bgetHandle\(' "$file" || true)"
done < <(find "$BACKEND_SRC" -type f -name '*.ts' -not -name '*.spec.ts' -not -name '*.test.ts' -print0)

if [[ -n "$HITS" ]]; then
  echo "" >&2
  echo "ERROR: a Temporal workflow is read or controlled by id without the tenant check." >&2
  echo "Fix: get the handle with getTenantWorkflow(client, workflowId) from" >&2
  echo "@infrastructure/temporal/tenant-workflow. When the id comes from a tenant-scoped record" >&2
  echo "and never from the request, add the file with a reason to ALLOWED in" >&2
  echo "scripts/check-workflow-tenant-reads.sh." >&2
  exit 1
fi

echo "OK: every workflow read by id goes through the tenant check"
