# Shared Hosting (Several Customers in One Installation)

> **Status:** Partially implemented: logical tenant isolation is built; the pieces a shared installation also needs are not.
> **Supported today:** one installation per customer ([DEPLOYMENT.md](../../DEPLOYMENT.md) § Supported Deployment Model).
> **Related:** [ARCHITECTURE_MULTI_TENANCY.md](../infrastructure/ARCHITECTURE_MULTI_TENANCY.md) | [FUTURE_REMOTE_AGENT.md](FUTURE_REMOTE_AGENT.md) | [FUTURE_CELL_ARCHITECTURE.md](FUTURE_CELL_ARCHITECTURE.md)

## Why one installation per customer today

Every connector runs in the central worker (`backend/src/worker.ts`). Connectors that call cloud APIs (Entra ID, Okta, SCIM, GitHub, ServiceNow, Google Sheets, JSON API HR over HTTP) work from anywhere. The rest need the customer's network or disk:

| Connector | Needs | Problem on a shared installation |
|---|---|---|
| Active Directory | LDAP to the customer's domain controllers | The central worker needs a network path into each customer (VPN or exposed LDAP) |
| CSV HR, JSON API HR in file mode | A readable file under `CSV_HR_ALLOWED_DIR` / `JSON_HR_ALLOWED_DIR` | The directory is shared by all tenants: one tenant's connector-admin can name another tenant's file |
| File outbound | A writable file under `FILE_OUTBOUND_ALLOWED_DIR` | Same shared directory |

A per-customer installation has one tenant, reaches the customer's network directly (when installed there) and owns its directories, so none of these apply.

## What is built (logical isolation)

| Concern | Implementation |
|---|---|
| Data | Global Mongoose plugin adds the tenant to every query from request context; fails without one (`backend/src/infrastructure/multi-tenancy/tenant.plugin.ts`, `tenant-context.helper.ts`) |
| Identity of the caller | Tenant from the JWT claim (`JWT_TENANT_CLAIM`); SCIM tokens are per tenant |
| Suspension | Suspended tenants are refused on authenticated requests, sign-in, refresh, websockets and SCIM (`tenant-status.service.ts`) |
| Workflows | Shared Temporal namespace, workflow ids `t-{tenantId}-...`, `TenantId` search attribute; a route answers 404 for another tenant's workflow (`backend/src/infrastructure/temporal/tenant-workflow.ts`, `tenant-search-attribute.ts`) |
| Realtime | Websocket rooms `t:{tenantId}:...` (`backend/src/infrastructure/realtime/events.gateway.ts`) |
| Administration | Tenants collection and admin UI (`tenant.controller.ts`, `frontend/src/features/admin/TenantManagement.tsx`), tenant data migration (`migrate-tenant-data.ts`), identity limit per tenant (`backend/src/modules/identity/identity-limit.ts`) |
| SSO | SAML JIT users land only in allow-listed, active tenants (`backend/src/modules/auth/saml-jit-policy.ts`) |
| Guards | `scripts/check-tenant-guard.sh`, `check-workflow-tenant-reads.sh`, `check-request-tenant-fields.sh` |

## What a shared installation would still need

1. **Remote agent** for AD and file connectors, running in the customer's network and taking its work from a per-tenant task queue ([FUTURE_REMOTE_AGENT.md](FUTURE_REMOTE_AGENT.md); only the registry in `backend/src/modules/agent-management/` exists). Until then, a shared installation can serve only cloud-connected customers.
2. **Per-tenant file directories** (`<allowed dir>/<tenantId>/`) for the file connectors that stay central, or file upload through the API instead of a shared disk.
3. **An external security test** of the tenant isolation. It has been reviewed from the code only.
4. **Operations per tenant**: backup and restore of one tenant, removal of a whole tenant's data, and limits that keep one tenant's sync from starving the others (circuit breakers are per tenant already).
5. **Physical isolation** for customers who require it: [FUTURE_CELL_ARCHITECTURE.md](FUTURE_CELL_ARCHITECTURE.md).

Items 1 to 3 are the minimum to host several customers that use AD or HR files; items 4 and 5 are for scale.
