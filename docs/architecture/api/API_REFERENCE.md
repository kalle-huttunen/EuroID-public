---
Last updated: 2026-02-23
---

# API Endpoint Reference

> Hand-maintained and incomplete reference: see "Routes not yet listed here" below. The full list is the OpenAPI spec the API writes at startup outside production, [`swagger-spec.json`](../../../swagger-spec.json) (repository root), also served as Swagger UI at `http://localhost:3001/api/docs`.

**Global prefix:** `api/v1` (all routes except SCIM inbound).

### Routes not yet listed here

On 2026-11-25, 104 of the 307 routes in `swagger-spec.json` were missing from this page. Look them up in the spec:

- Whole modules: `access-explorer`, `access-requests`, `admin/reconciliation-config`, `agents`, `compliance-reports`, `credential-lifecycle`, `event-subscriptions`, `intelligence`, `joiners`, `nhi`, `privileged-access`, `realtime/status`, `risk-scores`.
- In listed modules: `analytics/v2/*`; `auth/invites`, `auth/logout`, `auth/password-reset/*`, `auth/saml/exchange`, `auth/users/:id/password-reset`; `batch-provision/health/diagnostics`; `entitlement-catalog/requestable`.
- Also: `identity/:id/access/preview`, `access/re-evaluate`, `access/review-exclusions` (and its `lift`), `identity/:id/offboard-impact`; `leavers/open-offboardings`, `leavers/offboardings/:workflowId/removed-manually`.
- Also: `policy/evaluate/:identityId`, `policy/review-exclusions/counts`; `reconciliation/drifts/open-counts`, `reconciliation/orphans/*`; `role-bundles/:id/resolved`; `bulk-provisioning/test/sample-batch`.

---

## Auth — `api/v1/auth`
| Method | Path | Access |
|---|---|---|
| POST | `/auth/login` | Public |
| POST | `/auth/register` | Public |
| POST | `/auth/refresh` | Public |
| GET | `/auth/setup-status` | Public |
| GET | `/auth/me` | Authenticated |
| GET | `/auth/users` | super-admin |
| POST | `/auth/invites` | super-admin |
| POST | `/auth/revoke/:userId` | super-admin |
| POST | `/auth/change-password` | Authenticated |
| PATCH | `/auth/users/:id` | super-admin |

## MFA — `api/v1/auth/mfa`
| Method | Path | Access |
|---|---|---|
| POST | `/auth/mfa/setup` | Authenticated |
| POST | `/auth/mfa/verify-setup` | Authenticated |
| POST | `/auth/mfa/challenge` | Public |
| POST | `/auth/mfa/disable` | Authenticated |
| POST | `/auth/mfa/backup-codes` | Authenticated |
| GET | `/auth/mfa/status` | Authenticated |

## SAML SSO — `api/v1/auth/saml`
| Method | Path | Access |
|---|---|---|
| GET | `/auth/saml/config` | Public |
| GET | `/auth/saml/login` | Public |
| POST | `/auth/saml/callback` | Public |
| GET | `/auth/saml/metadata` | Public |

## Identity — `api/v1/identity`
| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/identity` | operator | `?triggerWorkflow=true` to start onboarding |
| GET | `/identity` | viewer | `?_start&_end` for pagination |
| PATCH | `/identity/:id` | operator | 409 for a change of a field an HR source masters (`GET /identity/:id/mastery`); a body that changes nothing writes nothing. `?syncToEntra=true` for immediate sync to Entra ID (onboarding provisions Entra again even when SYNCED; other SYNCED targets are skipped). Response `workflow`: the started run's `workflowId`/`trackingUrl`, or `triggered: false` with the id of an onboarding run already in progress |
| DELETE | `/identity/:id` | operator | |
| GET | `/identity/conflicts` | viewer | |
| GET | `/identity/uncorrelated` | viewer | |
| GET | `/identity/uncorrelated/count` | viewer | |
| GET | `/identity/:id/candidates` | viewer | Correlation candidates |
| GET | `/identity/:id/entitlements` | viewer | Policy- and request-granted entitlements with status (Access tab) |
| POST | `/identity/:id/access/expiry/retry` | operator | Body `{ targetSystem }`; clears the entry's expiry failure so the next hourly expiry run tries again; answers the provisioning entry. 404 identity or entry not found, 409 no failed expiry |
| POST | `/identity/:id/access/expiry/removed-manually` | policy-admin | Body `{ targetSystem, reason }`; closes a failed expiry removed by hand: entry `DEPROVISIONED`, audited with the admin and note. Same role as `/leavers/offboardings/:workflowId/removed-manually`. 404 / 409 as retry |
| POST | `/identity/:id/pii/reveal` | operator | Body `{ field }`; audited clear value of one masked PII field. Identity responses mask `personalEmail`, `mobilePhone`, `workPhone`, `officeExtension` |
| POST | `/identity/:id/link` | operator | Link uncorrelated identity |
| POST | `/identity/:id/create-standalone` | operator | |
| POST | `/identity/:id/resolve-conflict` | operator | |
| DELETE | `/identity/:id/gdpr-erase` | super-admin | `?dryRun`, Header: `X-Confirm-Erasure` |
| GET | `/identity/:id/dsar-export` | super-admin, operator | GDPR data export |
| POST | `/identity/:id/consent` | super-admin, operator | |
| DELETE | `/identity/:id/consent/:purpose` | super-admin, operator | |
| GET | `/identity/:id/consent` | viewer+ | |
| GET | `/identity/:id/events` | viewer | `?type&dateFrom&dateTo&limit` |
| GET | `/identity/compliance/consent-report` | super-admin, operator | |
| GET | `/identity/v2/by-email` | viewer | `?email` |
| GET | `/identity/v2/:id` | viewer | |
| PATCH | `/identity/v2/:id/controls` | operator | Body `{ isLoginDisabled?, manualDepartment?, manualJobTitle?, reason?, expiresAt?, overrides? }` (strict). Setting `manualDepartment` or `manualJobTitle` (the override of an HR-mastered value) needs `reason`, `expiresAt` optional; `""` or `null` removes it; audited. 404 unknown identity |
| GET | `/identity/:id/mastery` | viewer | `{ masteredBy: { <field>: <HR source> }, attributeControls }`: the fields `PATCH /identity/:id` refuses (409) and the active overrides |
| GET | `/identity/:id` | viewer | |

## Policy — `api/v1/policy`
| Method | Path | Access |
|---|---|---|
| GET | `/policy` | viewer |
| GET | `/policy/:id` | viewer |
| GET | `/policy/:id/impact` | viewer |
| POST | `/policy` | policy-admin |
| PATCH | `/policy/:id` | policy-admin |
| DELETE | `/policy/:id` | policy-admin |
| POST | `/policy/:id/activate` | policy-admin |
| PATCH | `/policy/:id/toggle` | policy-admin |
| POST | `/policy/reorder` | policy-admin |
| POST | `/policy/simulate` | policy-admin |

## SoD Policies — `api/v1/sod-policies`
| Method | Path | Access |
|---|---|---|
| GET | `/sod-policies` | viewer |
| POST | `/sod-policies` | super-admin, policy-admin |
| PATCH | `/sod-policies/:id` | super-admin, policy-admin |
| DELETE | `/sod-policies/:id` | super-admin, policy-admin |

## Connectors — `api/v1/connectors`
| Method | Path | Access |
|---|---|---|
| GET | `/connectors/available` | viewer+ |
| GET | `/connectors` | viewer |
| POST | `/connectors/:name/install` | connector-admin |
| PATCH | `/connectors/:name` | connector-admin |
| DELETE | `/connectors/:name` | connector-admin |
| POST | `/connectors/:name/ingest` | connector-admin, operator, super-admin |
| POST | `/connectors/:name/health-check` | connector-admin+ |
| GET | `/connectors/:name/status` | viewer |
| GET | `/connectors/:name/sync-status` | viewer+ |
| POST | `/connectors/:name/discover` | connector-admin+ |

## Reconciliation — `api/v1/reconciliation`
| Method | Path | Access |
|---|---|---|
| POST | `/reconciliation/start-daily` | operator |
| POST | `/reconciliation/user/:userId` | operator |
| POST | `/reconciliation/distributed-transaction` | operator |
| GET | `/reconciliation/status/:workflowId` | viewer |
| GET | `/reconciliation/result/:workflowId` | viewer |
| GET | `/reconciliation/drifts` | viewer |
| GET | `/reconciliation/drifts/stats` | viewer |
| POST | `/reconciliation/drifts/:id/correct` | operator |
| POST | `/reconciliation/drifts/:id/ignore` | operator |
| POST | `/reconciliation/drifts/bulk-correct` | operator |
| POST | `/reconciliation/drifts/bulk-ignore` | operator |
| GET | `/reconciliation/connector-health` | viewer |

## Blueprints — `api/v1/blueprints`
| Method | Path | Access |
|---|---|---|
| GET | `/blueprints/latest` | viewer |
| GET | `/blueprints/:id` | viewer |
| GET | `/blueprints/pipeline-status` | viewer |
| GET | `/blueprints/health/:nodeId` | viewer |
| GET | `/blueprints/connector-status/:connectorId` | viewer |
| GET | `/blueprints/connector-entitlements/:nodeId` | viewer |
| PATCH | `/blueprints/:id` | connector-admin |
| POST | `/blueprints/save` | policy-admin |
| POST | `/blueprints/impact-analysis` | policy-admin |
| POST | `/blueprints/readiness-check` | policy-admin |
| POST | `/blueprints/deploy` | policy-admin |
| POST | `/blueprints/pause` | policy-admin |
| POST | `/blueprints/resume` | policy-admin |
| POST | `/blueprints/stop` | policy-admin |
| PATCH | `/blueprints/pipeline-config` | policy-admin |

## Onboarding — `api/v1/onboarding`
| Method | Path | Access |
|---|---|---|
| POST | `/onboarding/start` | operator |
| GET | `/onboarding/status/:workflowId` | operator |

## Leavers — `api/v1/leavers`
HR-driven leavers: batches a sync paused above the mass-leaver limit, and the tenant leaver policy (`backend/src/modules/leavers/docs/ARCHITECTURE.md`).

| Method | Path | Access |
|---|---|---|
| GET | `/leavers/batches?status=` | policy-admin |
| POST | `/leavers/batches/:id/approve` | policy-admin |
| POST | `/leavers/batches/:id/reject` | policy-admin |
| GET | `/leavers/policy` | policy-admin |
| PUT | `/leavers/policy` | policy-admin |

## Movers — `api/v1/movers`
HR-driven movers: batches an HR sync paused above the mass-mover limit, and the tenant mass-mover policy (`backend/src/modules/mover/docs/ARCHITECTURE.md`).

| Method | Path | Access |
|---|---|---|
| GET | `/movers/batches?status=` | policy-admin |
| POST | `/movers/batches/:id/approve` | policy-admin |
| POST | `/movers/batches/:id/reject` | policy-admin |
| GET | `/movers/policy` | policy-admin |
| PUT | `/movers/policy` | policy-admin |

## Batch Provision — `api/v1/batch-provision`
| Method | Path | Access |
|---|---|---|
| GET | `/batch-provision/health` | Public |
| POST | `/batch-provision/seed` | operator |
| POST | `/batch-provision/entra` | operator |
| GET | `/batch-provision/status/:workflowId` | operator |
| POST | `/batch-provision/cleanup` | operator |

## Bulk Provisioning — `api/v1/bulk-provisioning`
| Method | Path | Access |
|---|---|---|
| POST | `/bulk-provisioning/start` | operator |
| GET | `/bulk-provisioning/status/:workflowId` | operator |
| GET | `/bulk-provisioning/results/:workflowId` | operator |
| GET | `/bulk-provisioning/partial-results/:workflowId` | operator |
| POST | `/bulk-provisioning/approve-deletes/:workflowId` | operator |
| POST | `/bulk-provisioning/cancel/:workflowId` | operator |

## Access Reviews — `api/v1/access-reviews`
| Method | Path | Access |
|---|---|---|
| POST | `/access-reviews/campaigns` | policy-admin |
| GET | `/access-reviews/campaigns` | viewer |
| GET | `/access-reviews/campaigns/:id` | viewer |
| POST | `/access-reviews/campaigns/:id/activate` | super-admin |
| POST | `/access-reviews/campaigns/:id/cancel` | super-admin |
| GET | `/access-reviews/campaigns/:id/items` | viewer |
| GET | `/access-reviews/items/:itemId` | viewer |
| POST | `/access-reviews/items/:itemId/decide` | operator |
| GET | `/access-reviews/my-reviews` | viewer |

## Anomaly Detection — `api/v1/anomalies`
| Method | Path | Access |
|---|---|---|
| GET | `/anomalies` | viewer |
| GET | `/anomalies/risk-scores` | viewer |
| GET | `/anomalies/:id` | viewer |
| POST | `/anomalies/analyze` | super-admin |
| POST | `/anomalies/:id/acknowledge` | operator |
| POST | `/anomalies/:id/dismiss` | operator |
| POST | `/anomalies/:id/resolve` | operator |

## Analytics — `api/v1/analytics`
| Method | Path | Access |
|---|---|---|
| GET | `/analytics/upcoming-offboardings` | viewer |
| GET | `/analytics/upcoming-offboardings/:identityId` | viewer |
| GET | `/analytics/license-forecast` | viewer |
| GET | `/analytics/license-forecast/:system/:license` | viewer |
| GET | `/analytics/seasonal-patterns` | viewer |
| POST | `/analytics/refresh` | super-admin |

## Policy Suggestions — `api/v1/policy-suggestions`
| Method | Path | Access |
|---|---|---|
| GET | `/policy-suggestions` | viewer |
| GET | `/policy-suggestions/:id` | viewer |
| POST | `/policy-suggestions/:id/accept` | policy-admin |
| POST | `/policy-suggestions/:id/dismiss` | policy-admin |
| POST | `/policy-suggestions/analyze` | super-admin |

## Role Bundles — `api/v1/role-bundles`
| Method | Path | Access |
|---|---|---|
| GET | `/role-bundles` | viewer |
| GET | `/role-bundles/:id` | viewer |
| POST | `/role-bundles` | policy-admin |
| PATCH | `/role-bundles/:id` | policy-admin |
| DELETE | `/role-bundles/:id` | policy-admin |

## Entitlement Catalog — `api/v1/entitlement-catalog`
| Method | Path | Access |
|---|---|---|
| GET | `/entitlement-catalog` | viewer |
| PATCH | `/entitlement-catalog/:id/tags` | super-admin, policy-admin |

## Audit — `api/v1/audit`
| Method | Path | Access |
|---|---|---|
| GET | `/audit` | viewer |
| GET | `/audit/stats` | viewer |
| GET | `/audit/verify-integrity` | super-admin |
| GET | `/audit/merkle-roots` | super-admin |
| POST | `/audit/merkle-roots` | super-admin |
| POST | `/audit/verify-event/:eventId` | super-admin |
| POST | `/audit/verify` | super-admin |
| GET | `/audit/merkle-roots/:checkpointId/anchor` | super-admin |

## Dead Letter Queue — `api/v1/dead-letter`
| Method | Path | Access |
|---|---|---|
| GET | `/dead-letter` | operator |
| GET | `/dead-letter/stats` | operator |
| GET | `/dead-letter/:id` | operator |
| POST | `/dead-letter/batch-retry` | super-admin |
| POST | `/dead-letter/:id/dismiss` | operator |
| POST | `/dead-letter/:id/replay` | super-admin |
| POST | `/dead-letter/:id/retry` | super-admin |

## SCIM 2.0 Inbound (no `api/v1` prefix)
| Method | Path | Auth |
|---|---|---|
| POST | `/scim/v2/Users` | SCIM Bearer Token |
| GET | `/scim/v2/Users` | SCIM Bearer Token |
| GET | `/scim/v2/Users/:id` | SCIM Bearer Token |
| PUT | `/scim/v2/Users/:id` | SCIM Bearer Token |
| PATCH | `/scim/v2/Users/:id` | SCIM Bearer Token |
| DELETE | `/scim/v2/Users/:id` | SCIM Bearer Token |
| POST | `/scim/v2/Groups` | SCIM Bearer Token |
| GET | `/scim/v2/Groups` | SCIM Bearer Token |
| GET | `/scim/v2/Groups/:id` | SCIM Bearer Token |
| PUT | `/scim/v2/Groups/:id` | SCIM Bearer Token |
| PATCH | `/scim/v2/Groups/:id` | SCIM Bearer Token |
| DELETE | `/scim/v2/Groups/:id` | SCIM Bearer Token |
| GET | `/scim/v2/ServiceProviderConfig` | Public |
| GET | `/scim/v2/Schemas` | Public |
| GET | `/scim/v2/ResourceTypes` | Public |

Each SCIM token holds scopes (`POST /api/v1/scim-tokens`, default all four): GET on `/scim/v2/Users` needs `Users:read`, POST, PUT, PATCH and DELETE need `Users:write`, and `Groups:read` and `Groups:write` likewise on `/scim/v2/Groups`; a token without the route's scope gets 403. An unknown scope name at token creation is a 400.

`GET /scim/v2/Users` takes a single-clause `filter` on `userName` (the UPN, else the email), `emails.value`, `displayName` or `active` (`ACTIVE` and `PENDING` are active), as the SCIM response shows them; text compares without case.

PATCH changes only the attributes its operations name (`remove` clears an optional one; removing `userName`, `emails`, `name.givenName`, `name.familyName` or `active` is 400 `mutability`). POST answers 409 `uniqueness` when another identity has the userName as its UPN or email, or the body's primary email. A unique value taken by a concurrent write is 409 `uniqueness` too, and an id that is no ObjectId is 404.

PUT, PATCH and DELETE of a user refuse a change of a field an HR source masters (`GET /api/v1/identity/:id/mastery`): 400 with `scimType: "mutability"` and the field and its owner in `detail`. A full PUT that repeats the current value of such a field passes.

## SCIM Tokens — `api/v1/scim-tokens`
| Method | Path | Access |
|---|---|---|
| POST | `/scim-tokens` | super-admin |
| GET | `/scim-tokens` | super-admin |
| DELETE | `/scim-tokens/:id` | super-admin |

## Tenants — `api/v1/tenants`
| Method | Path | Access |
|---|---|---|
| POST | `/tenants` | platform-admin |
| GET | `/tenants` | platform-admin |
| GET | `/tenants/:id` | platform-admin |
| PATCH | `/tenants/:id` | platform-admin |
| DELETE | `/tenants/:id` | platform-admin |
| POST | `/tenants/migrate` | platform-admin |

## Health — `api/v1/health`
| Method | Path | Access |
|---|---|---|
| GET | `/health` | Public |
| GET | `/health/ready` | Public |

## Dev Tools — `api/v1/dev`
| Method | Path | Access |
|---|---|---|
| GET | `/dev/workflows` | viewer |
| GET | `/dev/workflows/:workflowId` | viewer |
| GET | `/dev/transactions` | viewer |
| GET | `/dev/transactions/:transactionId` | viewer |

## Data Retention — `api/v1/dev/retention`
| Method | Path | Access |
|---|---|---|
| GET | `/dev/retention/config` | viewer |
| POST | `/dev/retention/dry-run` | super-admin |
| POST | `/dev/retention/purge-deleted` | super-admin |

## Observability
| Method | Path | Access |
|---|---|---|
| GET | `/metrics` | Prometheus scrape |
| GET | `/api/docs` | Swagger UI |

## Common Patterns

| Pattern | Documentation |
|---------|--------------|
| Error response format | [API_ERROR_FORMAT.md](API_ERROR_FORMAT.md): error bodies as the exception filters return them, HTTP status codes, validation messages, SCIM errors |
| API versioning | Global prefix `api/v1` on all routes except SCIM inbound |
| Authentication | JWT bearer token via OIDC provider (see [Platform Auth](../security/PLATFORM_AUTH_ARCHITECTURE.md)) |
| Correlation tracking | `x-correlation-id` header propagated through logs, events, and Temporal workflows |
