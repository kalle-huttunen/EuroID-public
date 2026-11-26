---
Last updated: 2026-11-22
---

# Multi-Tenancy Architecture — The 2026 Standard

> **Status:** Implementation Complete — Batch 8 (Tasks 38–42), 2026-02-12  
> **Spec:** [roadmap/ROADMAP.md](../roadmap/ROADMAP.md) Wave 3
> **Depends on:** All P0, P1, P2, P3.2–P3.5 complete (Batches 1–7)
> **Deployment (2026-11-26):** the isolation below is built, but EuroID is supported as one installation per customer ([DEPLOYMENT.md](../../DEPLOYMENT.md) § Supported Deployment Model). Several customers in one installation: [FUTURE_SHARED_HOSTING.md](../future/FUTURE_SHARED_HOSTING.md).

---

## The Core Problem (Solved)

**"Shared infrastructure, isolated data."**

* **Before Batch 8:** EuroID had a `tenantId` field on `StandardUserDto` and `User` schema, but there was **zero tenant isolation** at the data layer, API layer, workflow layer, or frontend. All tenants shared the same MongoDB collections, the same Temporal namespace, the same WebSocket rooms, and the same SCIM token pool.
* **The Explosion (Avoided):** Without isolation, Tenant A's admin could see Tenant B's users. A policy created by Tenant A could evaluate against Tenant B's identities. An anomaly alert from Tenant B could fire in Tenant A's WebSocket room. A SCIM token from Tenant A could provision into Tenant B's identity store.
* **The Fix (Implemented):** **Tenant context everywhere.** Every request, every query, every event, every workflow, every WebSocket broadcast carries and enforces tenant isolation via JWT claims → AsyncLocalStorage → Mongoose plugin, tenant-prefixed rooms, and workflow ID prefixes.

---

## Multi-Tenancy Landmines (Critical Safety Protocol)

### Landmine 1: The "Missing WHERE Clause" Data Leak

* **The Trap:** You add `tenantId` to every schema but forget to filter by it in one service method. One `find({})` with no tenant filter leaks all tenants' data.
* **The Explosion:** Cross-tenant data exposure. Compliance violation. Customer trust destroyed.
* **The 2026 Fix: Mongoose Global Plugin + Defense-in-Depth.**
  * A Mongoose plugin automatically injects `{ tenantId }` into every `find`, `findOne`, `updateOne`, `deleteOne`, `countDocuments`, and `aggregate` query.
  * The tenant ID comes from AsyncLocalStorage (`requestContext`) — not passed as a parameter. Services cannot "forget" to pass it because they never pass it manually.
  * Defense layer: A NestJS interceptor logs a warning if any query runs without a `tenantId` filter (detectable by hooking Mongoose's query middleware).

### Landmine 2: The "God Tenant" Backdoor

* **The Trap:** You create a "system" or "default" tenant for background jobs (cron, Temporal workflows, event handlers). This tenant has no restrictions and can see everything.
* **The Explosion:** A bug in tenant resolution falls back to "default" → full cross-tenant access.
* **The 2026 Fix: Explicit Tenant Context, No Fallback.**
  * Background jobs (Temporal activities, event handlers, cron) must receive an **explicit** `tenantId` from the workflow/event that triggered them. There is no "default" tenant fallback.
  * If `tenantId` is missing from the context, the operation **fails** with a plain `Error` ("Tenant context required for ..." from `tenant.plugin.ts`, "No tenant context available" from `getCurrentTenantId()` in `tenant-context.helper.ts`). It never falls back silently.
  * System-level operations (health checks, metrics, retention purge) use a `@SystemOperation()` decorator that bypasses tenant scoping with an audit trail.

### Landmine 3: The "Temporal Namespace" Complexity Trap

* **The Trap:** You create one Temporal namespace per tenant for "perfect isolation." You now have 200 namespaces, each requiring separate worker pools, connection management, and monitoring.
* **The Explosion:** Infrastructure complexity explodes. Worker startup takes minutes. Each namespace needs its own retention config, search attributes, and scaling policy.
* **The 2026 Fix: Shared Namespace + Workflow ID Prefix + Search Attributes.**
  * All tenants share a single Temporal namespace (or a small number of namespaces).
  * Workflow IDs are prefixed: `t-{tenantId}-onboard-{identityId}`.
  * Temporal Search Attributes include `TenantId` for filtering in the Temporal UI and queries.
  * Activities receive `tenantId` as a parameter and set it in AsyncLocalStorage before executing.
  * Per-tenant namespace isolation is a future option for enterprise customers who require it.

### Landmine 4: The "Index Explosion" Performance Kill

* **The Trap:** You add `{ tenantId: 1 }` as a prefix to every compound index. You now have 50 indexes per collection, and MongoDB's working set exceeds RAM.
* **The Explosion:** Write performance degrades. Inserts slow to a crawl. Index builds lock collections.
* **The 2026 Fix: Strategic Indexing.**
  * Add `tenantId` as a prefix **only** to indexes that support hot query paths (list views, search, filtering).
  * For low-volume collections (policies, blueprints, connector configs), a simple `{ tenantId: 1 }` single-field index is sufficient — MongoDB uses index intersection for the rest.
  * For high-volume collections (identities, audit logs, user events), add compound indexes: `{ tenantId: 1, <existing key fields> }`.
  * Remove or replace existing indexes that duplicate the new compound ones.

---

## Architecture Decision: Shared Database + Mongoose Plugin

### Why Shared Database (Not Database-per-Tenant)

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| **Shared DB + tenant filter** | Simple ops, single connection pool, easy migrations, works with any MongoDB hosting | Index overhead, requires discipline in query scoping | < 1,000 tenants, < 1M identities total |
| **Database per tenant** | Complete isolation, per-tenant backup/restore, no index prefix overhead | Connection pool explosion, complex migrations, separate monitoring per DB | Regulatory requirement (banking, healthcare) or > 1M identities per tenant |

**EuroID Choice: Shared Database + Mongoose Plugin.**

Rationale:
1. EuroID is an IGA platform — not a SaaS app with millions of tenants. Expected: 5–50 tenants (enterprise customers, subsidiaries, or organizational units).
2. The existing MongoDB setup is a single database with TTL indexes, compound indexes, and Mongoose schemas. Database-per-tenant would require rewriting every `MongooseModule.forRoot()` call.
3. The Mongoose plugin pattern provides **automatic** tenant filtering — safer than manual scoping.
4. Migration path: If a tenant outgrows the shared model, their data can be migrated to a dedicated database later (lazy migration).

### Tenant Identification

Tenants are identified by a `tenantId` string (UUID or slug). The tenant ID flows from:

```
JWT Claims → JwtAuthGuard → RequestContext (AsyncLocalStorage) → All layers
```

```typescript
// JWT claims (after IdP authentication)
{
  "sub": "user-uuid-from-idp",
  "email": "admin@acme.com",
  "name": "Alice Admin",
  "roles": ["policy-admin"],
  "tenantId": "acme-corp",            // ← NEW: tenant identifier
  "aud": "euroid-client-id",
  "iss": "https://login.microsoftonline.com/{tenant}/v2.0"
}
```

For development (`AUTH_DISABLED=true`), the dev user gets `tenantId: 'dev-tenant'`.

---

## Architecture Overview

```
    ┌────────────── Request Flow ──────────────────────────────────────────┐
    │                                                                      │
    │  1. HTTP Request arrives                                             │
    │     └─ Header: Authorization: Bearer <JWT>                           │
    │                                                                      │
    │  2. JwtAuthGuard validates JWT, extracts:                            │
    │     └─ { sub, email, roles, tenantId }                               │
    │     └─ Sets request['user'] with tenantId                            │
    │                                                                      │
    │  3. CorrelationMiddleware creates RequestContext:                     │
    │     └─ { correlationId, traceId, actor, tenantId, startTime }        │
    │     └─ Stored in AsyncLocalStorage                                   │
    │                                                                      │
    │  4. TenantGuard validates:                                           │
    │     └─ tenantId is present (not empty)                               │
    │     └─ Tenant exists in tenants collection (optional, cached)        │
    │                                                                      │
    │  5. Controller → Service → Mongoose Query                            │
    │     └─ TenantPlugin auto-injects { tenantId } from requestContext    │
    │     └─ Service code NEVER manually passes tenantId to queries        │
    │                                                                      │
    │  6. Domain Events carry tenantId in metadata                         │
    │     └─ Handlers receive tenant context automatically                 │
    │                                                                      │
    │  7. Temporal Workflows receive tenantId as a parameter               │
    │     └─ Activities set tenantId in AsyncLocalStorage before executing  │
    │                                                                      │
    │  8. WebSocket broadcasts are scoped to tenant rooms                  │
    │     └─ Room format: t:{tenantId}:{room}                              │
    │     └─ Clients auto-join tenant-prefixed rooms on connect            │
    │                                                                      │
    └──────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Request Context (Tenant Extraction)

### Extended RequestContext

```typescript
// backend/src/infrastructure/middleware/correlation.middleware.ts

export interface RequestContext {
  correlationId: string;
  traceId?: string;
  actor: string;
  tenantId: string;          // ← NEW: required, no fallback
  identityId?: string;
  startTime: number;
}
```

### Tenant Extraction in JwtAuthGuard

```typescript
// In JwtAuthGuard.canActivate() — extract tenantId from JWT claims
request['user'] = {
  sub: payload.sub,
  email: payload.email as string,
  name: payload.name as string,
  roles: (payload.roles as string[]) ?? [],
  tenantId: payload.tenantId as string,    // ← NEW
};

// Dev mode bypass:
request['user'] = {
  sub: 'dev-user',
  email: 'dev@localhost',
  name: 'Developer',
  roles: ['super-admin'],
  tenantId: process.env.DEV_TENANT_ID || 'dev-tenant',  // ← NEW
};
```

### Correlation Middleware Update

```typescript
// In correlation.middleware.ts — after JwtAuthGuard has run
const user = req['user'];
const ctx: RequestContext = {
  correlationId,
  traceId,
  actor: user?.email ?? 'anonymous',
  tenantId: user?.tenantId ?? '',       // ← NEW: empty string = will fail TenantGuard
  startTime: Date.now(),
};
```

### TenantGuard

```typescript
// backend/src/infrastructure/auth/tenant.guard.ts

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const tenantId = request['user']?.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    return true;
  }
}
```

Registered globally in `AuthModule` alongside `JwtAuthGuard` and `RolesGuard`. Public endpoints (`@Public()`) skip it. System endpoints (`@SystemOperation()`) skip it.

---

## Layer 2: Data Layer (Mongoose Tenant Plugin)

### The Tenant Plugin Pattern

A Mongoose plugin that auto-injects `tenantId` into every query. This is the **primary safety mechanism** — services never manually filter by tenant.

```typescript
// backend/src/infrastructure/multi-tenancy/tenant.plugin.ts

import { Schema } from 'mongoose';
import { requestContext } from '../middleware/correlation.middleware';

/**
 * Mongoose plugin that auto-injects tenantId from AsyncLocalStorage
 * into all find, update, and delete queries.
 *
 * Collections marked with @SystemCollection() are exempt.
 */
export function tenantPlugin(schema: Schema): void {
  // Add tenantId field to schema if not already present
  if (!schema.path('tenantId')) {
    schema.add({ tenantId: { type: String, required: true, index: true } });
  }

  // Auto-inject tenantId into all query operations
  const queryMiddleware = [
    'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
    'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments',
    'estimatedDocumentCount', 'distinct',
  ];

  for (const method of queryMiddleware) {
    schema.pre(method as any, function (this: any) {
      const ctx = requestContext.getStore();
      if (!ctx?.tenantId) {
        // System operations (cron, Temporal) explicitly set tenantId in ALS
        // If it's still missing, this is a bug — log and fail safe
        if (!this.getOptions()?._systemOperation) {
          console.error(`[TENANT] Query on ${this.model?.modelName} without tenant context`);
        }
        return;
      }
      this.where({ tenantId: ctx.tenantId });
    });
  }

  // Auto-set tenantId on document save
  schema.pre('save', function (this: any) {
    const ctx = requestContext.getStore();
    if (ctx?.tenantId && !this.tenantId) {
      this.tenantId = ctx.tenantId;
    }
  });

  // Auto-set tenantId on insertMany
  schema.pre('insertMany', function (this: any, next: any, docs: any[]) {
    const ctx = requestContext.getStore();
    if (ctx?.tenantId) {
      for (const doc of docs) {
        if (!doc.tenantId) {
          doc.tenantId = ctx.tenantId;
        }
      }
    }
    next();
  });
}
```

### Plugin Registration

```typescript
// backend/src/infrastructure/multi-tenancy/tenant.module.ts

import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as mongoose from 'mongoose';
import { tenantPlugin } from './tenant.plugin';

@Global()
@Module({})
export class TenantModule implements OnModuleInit {
  onModuleInit() {
    // Apply tenant plugin to ALL schemas globally
    mongoose.plugin(tenantPlugin);
  }
}
```

**Import in `app.module.ts`** before any `MongooseModule.forFeature()` calls.

**Embedded schemas.** Registered globally, Mongoose applies the plugin to embedded (child) schemas too, after the model's own schema (`helpers/schema/applyPlugins.js`). The plugin marks the schemas a model's schema embeds, at any depth, when it runs on the model's schema, and gives them nothing: no `tenantId` path, no index, no hooks. A subdocument belongs to its parent's tenant. The children of a schema that skips the plugin (`skipTenantPlugin`, e.g. Tenant) are marked too. A schema must therefore not be both a model's schema and embedded in another model's: whichever compiles first decides, and compiled first as an embedded schema it would get no tenant scope as a model (none is, checked 2026-11-25). Before this release the plugin added an indexed `tenantId` to every embedded schema, so Mongoose built indexes such as `sources.tenantId_1` that no query used, and subdocuments were stamped with the request's tenant (all of them before commit 2ae3a960, identity sources, controls and provisioning entries through `ensureTenantId` after it); migration `20261125000001-drop-embedded-tenant-id` drops those indexes and removes the stored values. `profile.tenantId` on identities is declared by `IdentityProfile` itself (deprecated) and stays. Tests: `tenant.plugin.spec.ts` ("subdocuments", "embedded schemas"), `embedded-tenant-id-migration.integration.spec.ts`, `credential-policy.integration.spec.ts`.

### System Operations (Exempt from Tenant Scoping)

Some operations are inherently cross-tenant: health checks, metrics aggregation, data retention purge, platform admin tenant management.

```typescript
// backend/src/infrastructure/multi-tenancy/system-operation.decorator.ts

import { SetMetadata } from '@nestjs/common';

export const IS_SYSTEM_OPERATION = 'isSystemOperation';
export const SystemOperation = () => SetMetadata(IS_SYSTEM_OPERATION, true);
```

For code that runs outside of a request context (Temporal activities, event handlers), the tenantId is set explicitly in AsyncLocalStorage:

```typescript
// Helper: run a function within a tenant context
export function withTenantContext<T>(tenantId: string, fn: () => T | Promise<T>): T | Promise<T> {
  const ctx: RequestContext = {
    correlationId: randomUUID(),
    actor: 'system',
    tenantId,
    startTime: Date.now(),
  };
  return requestContext.run(ctx, fn);
}
```

---

## Layer 3: Schema Migration Plan

### Schema `tenantId` (Done)

Every tenant-owned collection carries a required root-level `tenantId`. Most schemas declare it; the tenant plugin, registered globally (`mongoose.plugin(tenantPlugin)` in `infrastructure/multi-tenancy/tenant.module.ts`), adds it to any schema that does not (`tenant.plugin.ts`), for example `archival_records` and the anomaly module's `risk_scores`.

Opted out with `skipTenantPlugin`: `Tenant` (`tenants`, the registry itself), `AdminUser` (`admin_users`, declares its own `tenantId`) and the dead-letter `error` sub-schema. The `users` collection is decommissioned. Collection names in code: `drift_records`, `review_campaigns`, `review_items`.

**Note:** Workflow execution data is sourced from Temporal Visibility API; no `workflow_executions` collection.

### Index Strategy

**High-volume collections** — add compound indexes:

```typescript
// identities
// unique among live identities only (migration 20261123000001-identity-email-unique-among-live)
IdentitySchema.index(
  { tenantId: 1, 'profile.email': 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
IdentitySchema.index({ tenantId: 1, 'profile.status': 1 });
IdentitySchema.index({ tenantId: 1, deletedAt: 1 });

// policies
PolicySchema.index({ tenantId: 1, status: 1, priority: 1 });

// audit_events — already has { tenantId: 1, timestamp: -1 }

// entitlement_catalog
EntitlementSchema.index({ tenantId: 1, system: 1, type: 1 });

// drift_records
DriftSchema.index({ tenantId: 1, userId: 1, detectedAt: -1 });

// user_events
UserEventSchema.index({ tenantId: 1, userId: 1, timestamp: -1 });
```

**Low-volume collections** — single `{ tenantId: 1 }` index is sufficient:

```typescript
// blueprints, connector_configs, role_bundles, scim_tokens, dead_letter,
// anomalies, policy_suggestions, review_campaigns, review_items,
// transaction_logs
```

### Data Migration

Documents stored before multi-tenancy, without a `tenantId`, are assigned to a tenant with `POST /api/v1/tenants/migrate` `{ targetTenantId, dryRun? }` (platform admin; `TenantService.migrateDatabase`, `backend/src/infrastructure/multi-tenancy/migrate-tenant-data.ts`):

- The target must exist in `tenants` (404 otherwise); create it first with `POST /tenants`.
- `dryRun` defaults to `true`: the answer `{ dryRun, targetTenantId, collections }` counts per collection the documents that would move, and nothing moves. Send `dryRun: false` to move them.
- It moves documents whose `tenantId` is missing, `null` or empty, in every collection of a registered model whose schema carries the tenant plugin, plus the legacy collection names kept in `migrate-tenant-data.ts` (`tenantDataCollections`), so a new tenant collection is never left out. The audit chain (`audit_events`, `audit_chain_heads`, `audit_roots`) never moves, and `tenants` and `admin_users` opt out of the plugin. Only the calling process's models are known; the API boots `AppModule`, which reaches every module that registers a model (`archival_records` too, through `ActivitiesModule`), and `migrate-tenant-data.coverage.spec.ts` fails when a tenant schema is registered only outside it without its collection named in the list. Documents tagged `default` move only while `default` is no live tenant: not in `tenants`, not `DEFAULT_TENANT_ID` (whose default is `default`) and not the target.
- `audit_events` never moves: its hash chain is per tenant (`audit-chain-verifier.ts`), and moved events would break both tenants' chains.

Environment variable: `DEFAULT_TENANT_ID` — the tenant ID to assign to all pre-existing data. Required for first boot after multi-tenancy is enabled.

---

## Layer 4: Domain Events (Tenant Propagation)

### Event Envelope Extension

```typescript
// Updated DomainEvent metadata
export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  type: DomainEventType;
  aggregateId: string;
  timestamp: string;
  payload: T;
  metadata: {
    correlationId: string;
    causedBy?: string;
    depth: number;
    emittedBy: string;
    actor: string;
    tenantId: string;           // ← NEW: required
  };
}
```

### DomainEventEmitterService Update

```typescript
// In DomainEventEmitterService.emit()
const ctx = requestContext.getStore();
const event: DomainEvent<T> = {
  // ... existing fields ...
  metadata: {
    correlationId: ctx?.correlationId ?? 'no-context',
    causedBy: options?.causedBy,
    depth,
    emittedBy: this.constructor.name,
    actor: options?.actor ?? ctx?.actor ?? 'system',
    tenantId: ctx?.tenantId ?? options?.tenantId ?? '',  // ← NEW
  },
};
```

### Event Handlers

All event handlers receive tenant context via the event envelope. Handlers that write to the database must ensure the tenant context is set in AsyncLocalStorage:

```typescript
// In AuditEventHandler.handleAll()
@OnEvent('**', { async: true })
async handleAll(event: DomainEvent): Promise<void> {
  await withTenantContext(event.metadata.tenantId, async () => {
    await this.auditService.log({
      action: event.type,
      targetId: event.aggregateId,
      actor: event.metadata.actor,
      // tenantId is auto-injected by Mongoose plugin from ALS
    });
  });
}
```

---

## Layer 5: Temporal Workflows (Tenant Propagation)

### Workflow ID Convention

```
t-{tenantId}-{workflowType}-{entityId}

Examples:
  t-acme-corp-onboard-user-abc123
  t-acme-corp-access-review-campaign-xyz
  t-acme-corp-reconciliation-entra
```

### Starting Workflows

All workflow start calls include `tenantId` in the workflow input:

```typescript
// In OnboardingService.startOnboarding()
const tenantId = requestContext.getStore()?.tenantId;

await this.temporalClient.workflow.start(onboardingWorkflow, {
  workflowId: `t-${tenantId}-onboard-${identityId}`,
  taskQueue: DEFAULT_PROVISIONING_QUEUE,
  args: [{ user, intent, tenantId }],   // ← tenantId in args
  searchAttributes: {
    TenantId: [tenantId],                // ← Searchable in Temporal UI
  },
});
```

### Activities with Tenant Context

Activities receive `tenantId` from the workflow and set it in AsyncLocalStorage:

```typescript
// In activities — wrap with tenant context
async provisionUserToEntra(
  input: { user: StandardUserDto; intent: ProvisioningIntent; tenantId: string },
): Promise<ProvisioningResult> {
  return withTenantContext(input.tenantId, async () => {
    // All Mongoose queries inside here are automatically tenant-scoped
    return this.entraService.provision(input.user, input.intent);
  });
}
```

### Temporal Search Attributes

Register a custom search attribute for Temporal:

```bash
# One-time setup per Temporal cluster
temporal operator search-attribute create --name TenantId --type Keyword --namespace default
```

Docker Compose registers it (service `temporal-init`); every registration path is in `docs/DEPLOYMENT.md` § 4. Temporal.

This enables tenant-scoped workflow queries in the Temporal UI: `TenantId = "acme-corp"`.

---

## Layer 6: WebSocket (Tenant-Scoped Rooms)

### Room Naming Convention

```
t:{tenantId}:{room}

Examples:
  t:acme-corp:anomalies
  t:acme-corp:provisioning
  t:acme-corp:drift
  t:acme-corp:reviews
  t:acme-corp:analytics
  t:acme-corp:system
```

### Connection Handler Update

```typescript
// In EventsGateway.handleConnection()
// After JWT validation:
client.data.tenantId = payload.tenantId as string;

// Auto-join tenant-prefixed system room
client.join(`t:${client.data.tenantId}:system`);
```

### Subscribe Handler Update

```typescript
@SubscribeMessage('subscribe')
handleSubscribe(client: Socket, payload: { rooms?: string[] }): void {
  const tenantId = client.data.tenantId;
  if (!tenantId) return;

  const rooms = payload?.rooms ?? [];
  for (const room of rooms) {
    if (VALID_ROOMS.includes(room)) {
      client.join(`t:${tenantId}:${room}`);  // ← Tenant-prefixed
    }
  }
}
```

### Broadcast Update

```typescript
// In RealTimeBridgeService — scope broadcasts to tenant
@OnEvent('**', { async: true })
async handleDomainEvent(event: DomainEvent): void {
  const tenantId = event.metadata.tenantId;
  if (!tenantId) return;

  const room = this.mapEventToRoom(event.type);
  if (room) {
    this.gateway.broadcastToRoom(
      `t:${tenantId}:${room}`,  // ← Tenant-prefixed
      event.type,
      event.payload,
    );
  }
}
```

---

## Layer 7: SCIM Inbound (Tenant-Scoped Tokens)

### SCIM Token Schema Update

```typescript
@Schema({ collection: 'scim_tokens', timestamps: true })
export class ScimToken {
  @Prop({ required: true })
  tenantId: string;           // ← NEW: which tenant this token provisions into

  @Prop({ required: true, unique: true })
  tokenHash: string;

  // ... existing fields ...
}
```

### SCIM Auth Guard Update

When a SCIM request arrives with a bearer token, the guard:
1. Validates the token (SHA-256 lookup)
2. Extracts the `tenantId` from the token record
3. Sets `tenantId` in the request context (AsyncLocalStorage)

```typescript
// In ScimAuthGuard.canActivate()
const tokenRecord = await this.scimTokenService.validateToken(bearerToken);
if (!tokenRecord) throw new UnauthorizedException('Invalid SCIM token');

// Set tenant context for the SCIM request
request['user'] = {
  sub: `scim-token:${tokenRecord.id}`,
  email: 'scim-client',
  name: tokenRecord.name,
  roles: ['scim-provisioner'],
  tenantId: tokenRecord.tenantId,   // ← Tenant from token
};
```

This means:
- Each SCIM token is bound to a specific tenant
- SCIM inbound requests automatically provision into the correct tenant
- No cross-tenant provisioning is possible via SCIM

---

## Layer 8: Frontend (Tenant Context)

### Tenant from OIDC Claims

```typescript
// frontend/src/auth/use-tenant.ts
import { useAuth } from 'react-oidc-context';

export function useTenant(): { tenantId: string; tenantName?: string } {
  const auth = useAuth();
  const tenantId = (auth.user?.profile?.tenantId as string) ?? 'unknown';
  const tenantName = (auth.user?.profile?.tenantName as string) ?? tenantId;
  return { tenantId, tenantName };
}
```

### API Client — Tenant Header

The backend extracts tenant from JWT claims (not a custom header), so no header changes are needed for the main API. However, for debugging and traceability:

```typescript
// In API client interceptor
config.headers['X-Tenant-Id'] = tenantId;  // Informational, not authoritative
```

### WebSocket — Tenant-Scoped Subscriptions

```typescript
// In useRealTimeEvents hook
const { tenantId } = useTenant();

// Rooms are now tenant-prefixed on the server side.
// The client subscribes to the base room name; the server maps to t:{tenantId}:{room}.
socket.emit('subscribe', { rooms: ['anomalies', 'provisioning'] });
```

### Sidebar — Tenant Display

```
┌──────────────────────────────────┐
│  EuroID                          │
│  ────────────────────────────    │
│  ▸ Acme Corp                     │  ← Current tenant name
│  ────────────────────────────    │
│  ▸ Identities                    │
│  ▸ Policies                      │
│  ▸ Connectors                    │
│  ...                             │
└──────────────────────────────────┘
```

### Tenant Switcher (Design, Not Built)

Not in the code: the sidebar shows the current tenant's name only (`frontend/src/components/layout/CustomSider.tsx`), and there is no tenant switching. The design for platform operators managing multiple tenants:

```
┌──────────────────────────────────┐
│  ▸ Acme Corp  ▾                  │
│  ┌────────────────────────────┐  │
│  │  ✓ Acme Corp              │  │
│  │    Beta Industries         │  │
│  │    Gamma Holdings          │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

Tenant switching re-authenticates with a different tenant scope (if IdP supports it) or calls a backend endpoint to get a tenant-scoped access token.

---

## Layer 9: Background Process Protocol (Cron & Workers)

Background jobs (Cron, Temporal Activities) run outside the HTTP Request Context. The Mongoose Tenant Plugin cannot automatically detect the tenant.

### The Rules:

1. **Fail Safe:** The Tenant Plugin is configured to **Throw an Error** if a query is attempted without a tenant context (unless explicitly skipped). It does NOT default to "global search."
2. **Explicit Iteration:** Cron jobs must:
    * Fetch a list of all `Tenant` IDs.
    * Iterate through them.
    * Wrap the logic for each tenant in `withTenantContext(tenantId, async () => { ... })`.

---

## Tenant Management

### Tenant Collection

```typescript
// backend/src/infrastructure/multi-tenancy/schemas/tenant.schema.ts

@Schema({ collection: 'tenants', timestamps: true })
export class Tenant {
  @Prop({ required: true, unique: true })
  tenantId: string;          // 'acme-corp' — the ID used everywhere

  @Prop({ required: true })
  name: string;              // 'Acme Corporation' — display name

  @Prop({ enum: ['active', 'suspended', 'deprovisioned'], default: 'active' })
  status: string;

  @Prop({ type: Object, default: {} })
  settings: {
    maxIdentities?: number;       // Identity limit: the most live identities (see Identity limit)
    retentionDays?: number;       // Override global retention
    allowedConnectors?: string[]; // Restrict available connector types
    features?: Record<string, boolean>; // Feature flags per tenant
  };

  @Prop()
  createdBy: string;
}
```

The `tenants` collection is **exempt** from the tenant plugin (it is the source of truth for tenants). Access is restricted to the platform admin (`@Roles('platform-admin')`), never a tenant's `super-admin`: every tenant has a super-admin of its own (its first registered user, invited admins, OIDC role claims; SAML never creates one since HX-A2, `saml-jit-policy.ts`), so a super-admin gate let any tenant's admin rename, suspend or migrate every other tenant. Platform admin is granted only by deployment configuration (`PLATFORM_ADMIN_USER_IDS`, see [PLATFORM_AUTH_ARCHITECTURE.md](../security/PLATFORM_AUTH_ARCHITECTURE.md) § Platform Admin).

### Admin Endpoints

```
POST   /api/v1/tenants          — Create tenant (platform-admin; createdBy is the caller)
GET    /api/v1/tenants          — List tenants (platform-admin)
GET    /api/v1/tenants/:id      — Get tenant (platform-admin)
PATCH  /api/v1/tenants/:id      — Update name, status or settings (platform-admin; settings merged key by key, null removes one)
DELETE /api/v1/tenants/:id      — Suspend tenant (platform-admin, soft-delete)
POST   /api/v1/tenants/migrate  — Assign documents without a tenant to an existing tenant (platform-admin; dry run by default, see Data Migration)
```

### Identity limit

`settings.maxIdentities` is the most live (not soft-deleted) identities a tenant may have; unset (or anything but a positive integer) is no limit. It is checked where a record would mint a new identity (`assertRoomForNewIdentity`, `backend/src/modules/identity/identity-limit.ts`, called by `IdentityCorrelationService.ensureIdentityFromUser` before any write), so every creating path is held to it: HR ingest, SCIM `POST /scim/v2/Users`, `POST /api/v1/identity`, bulk and batch provisioning. An update, a rehire (it revives a soft-deleted identity) and a correlation onto an existing identity create nothing and are never refused, even past the limit. Linked admin accounts and the identities of console admins are made outside correlation: they are not refused, and they count as live identities.

- The API answers 409 "The tenant's identity limit (N) is reached: no identity was created. ..."; SCIM answers its error format with status 409 and no `scimType`.
- HR ingest does not drop the person: the row is counted in `rowsHeldForIdentityLimit` with `identityLimit` (neither `ingested` nor `errors`) and logged, and every sync reads it again, so the first sync after the limit is raised (or identities are deleted) creates it and joiner detection sees it then.
- A bulk or batch row past the limit fails with that message ("Golden Record save failed: ..."), as a held conflict row does.
- The count and the insert are separate steps: creates running at the same moment can pass the limit by the number running. That overshoot is accepted (the cap is a license control; a lock would serialise every create) and never unnoticed: after each new identity created outside a transaction (one created inside a transaction, which may still abort, is left to the sweep), and in the hourly expiry sweep for every tenant (which counts committed identities only, and also catches creates whose transactions could not see each other), `reportIdentityLimitOvershoot` (`identity-limit.ts`) compares the live count with the limit. Above it, one event `tenant.identity_limit_exceeded` (`{ limit, count }`, audited, webhook-subscribable) is raised and the tenants document gets `identityLimitExceededAt`; a check that finds the count within the limit again clears it, so the next overshoot alerts again.

### Suspending a tenant

A tenant whose `status` is `suspended` or `deprovisioned` (`DELETE /tenants/:id`, or `PATCH /tenants/:id` with `status`) cannot use EuroID (`backend/src/infrastructure/multi-tenancy/tenant-status.service.ts`):

- Sign-in answers 403 ("This tenant is suspended. Contact your platform administrator.") after the credentials check: password login, the SAML callback (no code is issued) and the MFA step (`AuthLocalService.completeSignIn` and `issueTokensForUser`), and so does `POST /auth/refresh`.
- Every authenticated request and websocket connection of the tenant gets the same 403 (`JwtAuthGuard.authenticate`); the socket is disconnected.
- An inbound SCIM request with a token of the tenant gets a SCIM-format 403 with the same message (`ScimAuthGuard`; the SCIM routes are `@Public()`, so the JWT guard does not see them).
- The scheduled jobs skip it (risk scores, recertification, entitlement expiry, intelligence, credential rotation and the hourly connector sync read `status === 'active'`). Archival and the audit checkpoint export keep running: retention and the audit export are obligations a suspension does not end.
- A platform admin (`PLATFORM_ADMIN_USER_IDS`) is not refused, so a suspended tenant of their own never locks out tenant management, and neither is the break-glass token.

A tenant without a `tenants` document (a single-tenant deployment's `DEFAULT_TENANT_ID`) is active. The status is cached per API process for `TENANT_STATUS_CACHE_MS` (30 s by default): the instance that suspends applies it from the next request (`TenantService` drops the cached entry), other instances within that time. Sessions are not revoked: they work again when the tenant is set back to `active`, until they expire.

---

## Configuration & Environment

```bash
# backend/.env

# Multi-tenancy
DEFAULT_TENANT_ID=acme-corp               # Used for data migration and dev mode
DEV_TENANT_ID=dev-tenant                  # Tenant ID when AUTH_DISABLED=true

# JWT claims mapping
JWT_TENANT_CLAIM=tenantId                 # Which JWT claim contains the tenant ID
```

There is no single-tenant switch: the tenant plugin and `TenantGuard` (`infrastructure/auth/auth.module.ts`) always run.

---

## Security Considerations

### Cross-Tenant Attack Vectors

| Vector | Mitigation |
|--------|-----------|
| JWT tampering (fake tenantId) | JWT signature verification via JWKS. TenantId comes from a trusted IdP. |
| Parameter injection (`?tenantId=other`) | TenantId is NEVER read from query params or body. Only from JWT claims. Request schemas do not declare `tenantId`; services that copy a tenant into a document or a workflow input take it from the request context, which wins over a payload value. `scripts/check-request-tenant-fields.sh` (CI) fails on a request schema or controller that accepts a tenant id; the few legitimate cases (platform-admin tenant management, internal schemas) are allow-listed with a reason. |
| Direct MongoDB access | Database credentials are per-deployment, not per-tenant. Network isolation at infra level. |
| SCIM token reuse across tenants | Tokens are bound to a specific tenant at creation time. Validated in ScimAuthGuard. |
| WebSocket room sniffing | Room names are server-assigned based on JWT tenantId. Clients cannot join arbitrary rooms. |
| Temporal workflow visibility | Search attributes filter by tenantId. Temporal UI access is restricted to platform admins. |
| Temporal workflow read by id (`t-<tenant>-...` ids are guessable) | Every route that describes, queries, reads the result or history of, signals or cancels a workflow by an id from the request takes the handle from `getTenantWorkflow()` (`backend/src/infrastructure/temporal/tenant-workflow.ts`): the workflow's `TenantId` search attribute must be the caller's tenant, else 404, the same answer as a missing id. A workflow started without `TenantId` (runs from before the attribute, child workflows started before they inherited it) is a 404 for everyone; child workflows get the parent's `TenantId` through `inheritTenantAttributes()` (`backend/src/workflows/child-workflow-tenant.ts`). `scripts/check-workflow-tenant-reads.sh` (CI) fails on a `getHandle()` elsewhere; the allow-listed callers signal workflow ids they read from tenant-scoped documents. |

### Audit Trail

Every cross-tenant operation (super-admin switching tenants, system operations) is logged:

```typescript
{
  action: 'TENANT_CONTEXT_SWITCH',
  actor: 'admin@platform.com',
  fromTenant: 'acme-corp',
  toTenant: 'beta-industries',
  timestamp: '2026-02-12T10:00:00Z',
}
```

---

## Migration Strategy

### Phase 1: Schema + Plugin (Task 38–39)
1. Add `tenantId` to all schemas
2. Register Mongoose tenant plugin globally
3. Run data migration to assign `DEFAULT_TENANT_ID` to existing documents
4. Extend `RequestContext` with `tenantId`
5. Update `JwtAuthGuard` and `CorrelationMiddleware`

### Phase 2: Service Migration (Task 40)
1. Update all services to work with tenant-scoped queries
2. The plugin handles most work automatically
3. Special cases: cross-tenant admin endpoints, system operations

### Phase 3: Temporal + SCIM (Task 41)
1. Propagate `tenantId` to all Temporal workflow inputs
2. Update activities to use `withTenantContext`
3. Scope SCIM tokens to tenants
4. Update SCIM guards

### Phase 4: Frontend + WebSocket (Task 42)
1. Extract tenant from OIDC claims
2. Tenant-scoped WebSocket rooms
3. Tenant display in sidebar
4. Tenant management page (Admin section)

---

## Related Documents

| Doc | Relevance |
|-----|-----------|
| **[roadmap/ROADMAP.md](../roadmap/ROADMAP.md)** | Wave 3 — this doc is the full multi-tenancy spec |
| **security/PLATFORM_AUTH_ARCHITECTURE.md** | JWT claims, role hierarchy — tenant claim is added |
| **`backend/src/modules/identity/docs/DATABASE_ARCHITECTURE.md`** | Onion Model schemas — tenantId added to all |
| **core/EVENT_BUS_ARCHITECTURE.md** | Domain events — tenantId in metadata |
| **infrastructure/TEMPORAL_WORKFLOWS.md** | Workflow patterns — tenantId in args + search attributes |
| **`backend/src/infrastructure/temporal/docs/TASK_QUEUES.md`** | Bulkhead pattern — shared queues, tenant-scoped workflow IDs |
| **`backend/src/modules/connectors/docs/ARCHITECTURE.md`** | Connector pattern — activities receive tenant context |
| **infrastructure/OBSERVABILITY_ARCHITECTURE.md** | Correlation middleware — tenantId added to context |
| **security/DATA_RETENTION.md** | Retention — tenant-scoped purge |
| **`backend/src/infrastructure/secrets/docs/ARCHITECTURE.md`** | Encryption — per-tenant key scoping (future) |
