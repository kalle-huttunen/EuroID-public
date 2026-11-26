#!/usr/bin/env bash
# check-request-tenant-fields.sh — fail when HTTP input can name a tenant.
#
# The tenant comes only from the authenticated request context: TenantContextInterceptor copies
# the JWT tenant into AsyncLocalStorage and the Mongoose tenant plugin scopes queries with it.
# The plugin never overrides a tenantId that a filter or a new document already carries, so a
# tenantId taken from a request body, query, path or header and copied into a document, a filter
# or a workflow input reads or writes another tenant. Companion to check-tenant-guard.sh.
#
# Rules (non-spec files under backend/src):
#   1. A Zod field named tenantId / tenant / *TenantId (`tenantId: z.`): request schemas must not
#      declare one. Internal schemas that legitimately carry it are allow-listed below.
#   2. A schema derived from an internal tenant-carrying schema (INTERNAL_SCHEMAS) without
#      `.omit({ tenantId: true })`. Imports, `typeof`, comments and `.parse`/`.safeParse` of
#      internal objects are fine.
#   3. A controller binding a tenant directly (@Body/@Query/@Param/@Headers('tenantId' ...)) or
#      binding an internal DTO class (INTERNAL_DTOS) as @Body/@Query.
#   4. A controller reading body.tenantId, dto.tenantId, query.tenantId, params.tenantId or
#      payload.tenantId.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_SRC="$REPO_ROOT/backend/src"

# Files allowed to declare or read a tenant field, as "path|reason". An entry needs a reason.
ALLOWED=(
  "backend/src/infrastructure/multi-tenancy/tenant.dtos.ts|Tenant management (TenantController, @Roles('platform-admin'), granted only by PLATFORM_ADMIN_USER_IDS): the tenantId names the tenant being created or migrated to."
  "backend/src/infrastructure/multi-tenancy/tenant.controller.ts|Same tenant-management routes: reads CreateTenantBodyDto.tenantId."
  "backend/src/shared/dtos/standard-user.dto.ts|Internal golden-record schema (workflows, HR ingestion, SCIM mapping). Never bound to a request (rule 3); request schemas derive from it only with .omit({ tenantId: true }) (rule 2)."
  "backend/src/modules/identity/dtos/identity-read.dto.ts|Response (read model) schema, never bound to a request (rule 3)."
  "backend/src/modules/identity/national-id.ts|Reads the field names of StandardUserSchema (which keys correlation never removes from a record); derives no schema and parses no input."
  "backend/src/infrastructure/events/event-payload-schemas.ts|Validates internal domain-event payloads that services emit, never HTTP input."
  "backend/src/modules/nhi/dtos/agent-credential.dto.ts|The NHI credential envelope POST /nhi/credentials/verify takes: its signed payload names the tenant it was issued for. NhiCredentialService.verify only compares it with the request context's tenant (a mismatch is inactive) and scopes no query or document with it."
)

# Internal schemas and DTO classes that carry tenantId.
INTERNAL_SCHEMAS='StandardUserSchema|IdentityReadSchema|IdentityOnionReadSchema'
INTERNAL_DTOS='StandardUserDto|IdentityReadDto|IdentityOnionReadDto'

RULE1="\\b[A-Za-z]*(?:tenant|Tenant)(?:Id)?['\"]?\\s*\\??\\s*:\\s*z\\."
RULE2_USE="\\b(?:${INTERNAL_SCHEMAS})\\b"
RULE2_OK="^\\s*(?:import\\b|//|\\*|/\\*)|^\\s*(?:${INTERNAL_SCHEMAS}),?\\s*\$|\\}\\s*from\\s*['\"]|typeof\\s+(?:${INTERNAL_SCHEMAS})\\b|(?:${INTERNAL_SCHEMAS})\\.omit\\(\\{\\s*tenantId:\\s*true|(?:${INTERNAL_SCHEMAS})\\.(?:safeParse|parse)\\("
RULE3="(?i)@(?:Body|Query|Param|Headers)\\(\\s*['\"](?:tenantId|tenant_id|tenant|x-tenant-id)['\"]|@(?:Body|Query)\\([^)]*\\)\\s*\\w+\\??\\s*:\\s*(?:Partial<)?(?:${INTERNAL_DTOS})\\b"
RULE4="\\b(?:body|dto|query|params|payload)\\??\\.tenantId\\b"

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
report() {
  # $1 = rule label, $2 = grep -n output lines for one file, $3 = relative path
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "$3:$line  [$1]"
    HITS="found"
  done <<< "$2"
}

while IFS= read -r -d '' file; do
  rel="${file#"$REPO_ROOT/"}"
  is_allowed "$rel" && continue

  report "rule 1: tenant field in a schema" "$(grep -nP "$RULE1" "$file" || true)" "$rel"

  derived=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! grep -qP "$RULE2_OK" <<< "${line#*:}"; then
      derived+="$line"$'\n'
    fi
  done <<< "$(grep -nP "$RULE2_USE" "$file" || true)"
  report "rule 2: derived from an internal tenant schema without .omit({ tenantId: true })" "$derived" "$rel"

  if grep -q "@Controller(" "$file"; then
    report "rule 3: controller binds a tenant or an internal DTO" "$(grep -nP "$RULE3" "$file" || true)" "$rel"
    report "rule 4: controller reads a request tenantId" "$(grep -nP "$RULE4" "$file" || true)" "$rel"
  fi
done < <(find "$BACKEND_SRC" -type f -name '*.ts' -not -name '*.spec.ts' -not -name '*.test.ts' -print0)

if [[ -n "$HITS" ]]; then
  echo "" >&2
  echo "ERROR: HTTP input can name a tenant. The tenant must come from the request context." >&2
  echo "Fix: drop the field (or .omit({ tenantId: true })) and use getCurrentTenantId() or the" >&2
  echo "authenticated user's tenantId. For a deliberate exception, add the file with a reason to" >&2
  echo "ALLOWED in scripts/check-request-tenant-fields.sh." >&2
  exit 1
fi

echo "OK: no request schema or controller accepts a tenantId"
