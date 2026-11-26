# EuroID Frontend

> **AI AGENT:** Read `CLAUDE.md` first for safety rules. Then this file for frontend-specific paths. Architecture: `frontend/docs/ARCHITECTURE.md`. Coding rules: `rules/frontend-react.md`. UI workflows: `.ai/UI_GUIDE.md`.

---

## Tech Stack

| Layer | Stack | Version |
| --- | --- | --- |
| Framework | React + Vite + TypeScript | 19.x, 7.x, 5.x |
| UI | Ant Design | 5.x |
| Server State | TanStack Query (React Query) | 5.x |
| Client State | Zustand | 5.x |
| HTTP | axios (`axiosInstance`, `api/data.ts`) | 1.x |
| Routing | React Router v6 (explicit, not file-based) | 6.x |
| Visualization | React Flow (`@xyflow/react`, Canvas) + Recharts (Analytics) | 12.x / 3.x |
| Forms | Ant Design Form | -- |
| Real-time | Socket.io Client | 4.x |
| Auth (OIDC) | `react-oidc-context` + `oidc-client-ts` | 3.x |

---

## Mandatory Patterns

| Concern | Use | Source |
|---|---|---|
| HTTP calls | `axiosInstance` | `api/data.ts` (`@api/data`) |
| URL composition | `API_BASE` | `api/constants.ts` (`@api/constants`) |
| Server data | TanStack Query (`useQuery`/`useMutation`) | -- |
| Generated types | `npm run generate:api` (never hand-edit) | `generated/api.types.ts` |
| UI library | Ant Design only; icons from `@ant-design/icons` | -- |
| Colors | `BRAND.*` / `SEMANTIC.*` / `theme.useToken()` | `theme/themeConfig.ts` |
| Polling/pagination | Config constants | `config/polling.ts`, `config/pagination.ts` |
| Destructive actions | Require simulation + confirmation modal | -- |
| Detail views | A row's read-and-act detail opens in a centered `Modal` sized for its content, body scrolling under a fixed title and footer (`dead-letter/DeadLetterDetailModal.tsx`); a detail with tabs is its own page (`users/IdentityDetailPage.tsx`). Side drawers only for the Design Studio panels (`ConfigDrawer`, `SimulationDrawer`) and the mobile navigation | `DeadLetterDetailModal`, `IdentityDetailPage` |

---

## Architectural Rules

1. **State:** Server data → `useQuery`/`useMutation`. Local UI → `useState` or Zustand.
2. **Contract First:** Backend DTOs → auto-generated types in `generated/api.types.ts` → re-exported via `interfaces/`.
3. **Visual:** Canvas → React Flow. Charts → Recharts. Layout → Ant Design `<Layout>`, `<Row>`, `<Col>`, `<Card>`.
4. **Code-Splitting:** All pages are `React.lazy()` loaded in `App.tsx` with named exports.
5. **Named Exports:** Pages use named exports. Lazy import: `.then(m => ({ default: m.MyPage }))`.
6. **Query Key Factories:** Each API domain uses a key factory object for type-safe invalidation.
7. **Real-time Invalidation:** `useRealTimeQueryInvalidation()` in `App.tsx` subscribes to WebSocket rooms and invalidates queries via `EVENT_INVALIDATION_MAP` in `api/realtime.tsx`. Per query key prefix the first event invalidates at once; the rest of a burst is coalesced into one invalidation per `POLL_INTERVALS.REALTIME_INVALIDATION_WINDOW_MS` (`config/polling.ts`).

---

## Authentication (3 Modes)

Selection logic in `App.tsx` `AuthWrapper`:

| Priority | Condition | Provider | Behavior |
| --- | --- | --- | --- |
| 1 | `VITE_AUTH_DISABLED=true` | `DevAuthProvider` | Fake super-admin. No network calls. |
| 2 | `VITE_OIDC_AUTHORITY` is set | `AuthProvider` (OIDC) + `OIDCAuthBridge` | Authorization Code + PKCE. Silent renewal on 401. |
| 3 | Neither set | `LocalAuthProvider` | Email/password JWT (and SAML through `/auth/saml-callback`). Tokens in memory only (`auth/token-store.ts`), never in `localStorage`; the API also sets httpOnly `access_token` and `refresh_token` cookies, and `GET /auth/me` on load restores the session from them (not on `/auth/saml-callback`, where the code exchange decides). |

All implement `AuthContextValue` from `auth/auth-context.tsx`.

**Role hierarchy:** `super-admin > connector-admin / policy-admin > operator > viewer`

**Local dev:** Set `VITE_AUTH_DISABLED=true` in `.env`. Backend needs `AUTH_DISABLED=true`.

---

## API Call Pattern

`axiosInstance` + `API_BASE`. Interceptors auto-attach auth token + tenant header.

Per-domain API modules in `api/*-api.ts` contain:
1. Query key factory object (e.g., `auditKeys`, `intelligenceKeys`)
2. Plain `async` functions using `axiosInstance`
3. `useQuery`/`useMutation` hooks

**Generic resource hooks:** `api/resource-hooks.ts` (`useList`, `useOne`, `useCreate`, `useUpdate`, `useDelete`, `useInvalidate`) wrap TanStack Query + `axiosInstance`. Refine was removed.

**API route strings:** Centralized in `config/api-routes.ts`.

---

## Real-time / WebSocket

`api/realtime.tsx` (`@api/realtime`) provides:

| Export | Purpose |
| --- | --- |
| `SocketProvider` | Connects to `/events` gateway. Auto-attaches auth token. |
| `useSocket()` | Socket instance + connection status. |
| `useRealTimeEvents(rooms, callback)` | Subscribe to domain events. Rooms are counted per consumer: a room is left only when its last consumer on the page unmounts. |
| `useEventNotifications()` | Auto-show Ant Design notifications (rate-limited). |
| `useRealTimeQueryInvalidation()` | Auto-invalidate React Query caches via `EVENT_INVALIDATION_MAP`, at most once per key prefix per `REALTIME_INVALIDATION_WINDOW_MS` after the first event. |

**Rooms:** `anomalies`, `provisioning`, `drift`, `reviews`, `system`, `audit`, `identity`, `connectors`, `pipeline`.

**In `npm run dev`:** the namespace `/events` travels inside the socket.io protocol; the requests and the websocket upgrade go to socket.io's path `/socket.io`, which `vite.config.ts` proxies (with `ws: true`) to `VITE_PROXY_TARGET` (default `http://localhost:3001`), like `/api`.

**To add real-time for a new domain:** See `rules/agent-workflows.md` § "Adding Real-Time Events".

---

## Route Map

All routes in `App.tsx`. Public routes outside `ProtectedAppLayout`; authenticated routes inside.

| Path | Component | Guard |
| --- | --- | --- |
| `/login` | `LoginPage` (sign in, create an account with an invite, Forgot password?) | Public |
| `/reset-password` | `ResetPasswordPage` (new password with the emailed link's token or a super-admin's code) | Public |
| `/callback` | `AuthCallback` | Public (OIDC redirect) |
| `/auth/saml-callback` | `SamlCallbackPage` | Public |
| `/dashboard` | `Dashboard` (KPI band, "Needs attention" feed, connector health; `/` redirects here) | Authenticated |
| `/users` | `UserList` (page, page size and conflicts filter in `?page=&pageSize=&conflicts=1`; a row opens the identity page) | Authenticated |
| `/identities/:id` | `IdentityDetailPage` (Identity 360: Profile, Access, Recommendations (operator: entitlements most of the peer group has), Drift, Credentials (operator), Timeline, Risk, Raw data; `?tab=`; Back returns to the page it was opened from) | Authenticated (save and delete: `operator`) |
| `/identity/:id/map` | `IdentityMapCanvas` | Authenticated |
| `/blueprints` | `BlueprintCanvas` | Authenticated |
| `/role-rules` | `RoleBasedRules` | Authenticated |
| `/connectors` | `ConnectorMarketplace` | Authenticated |
| `/reconciliation` | `ReconciliationDashboard` | Authenticated |
| `/reconciliation/uncorrelated` | `UncorrelatedQueue` | Authenticated |
| `/bulk-operations` | `BulkOperations` | Authenticated |
| `/nhi` | `NhiPage`, "Non-human identities" (service accounts, workloads, AI agents and bots: filter by kind, status, risk tier and owner; details; create, delegate, revoke and the kill switch with the delegated agents they reach; issue a short-lived credential shown once; the signing status) | Authenticated, like `GET /nhi` (changes and the signing status: `super-admin`) |
| `/access-explorer` | `AccessExplorerPage`, "Access explorer" (the Neo4j access graph: an identity's access as a canvas and a table with how each entitlement was granted, the holders of an entitlement, the access path between them, SoD violations through nested groups; `?tab=`, `?identity=`, `?entitlement=`; the graph store's 503 with the API's message; loading the graph from MongoDB) | Authenticated, like the `GET /access-explorer` routes (the resync: `super-admin`) |
| `/audit` | `AuditDashboard` (`?dateFrom=&dateTo=`, ISO times, starts filtered to that window) | Authenticated |
| `/audit/integrity` | `AuditIntegrityPage` (hash chain check over a time window with the first broken event and why, erasure gaps and older events; one event's Merkle proof; Merkle checkpoints with create and check; a signed checkpoint's anchor proof in a modal). GDPR erasures run before commit `47fa1cd7` recorded nothing about the entries they deleted, so a window holding the event after such an entry reports `broken_link` (`backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md` § Known Limitations) | `super-admin` |
| `/dev/workflows` | `WorkflowDebugger` | `super-admin`; non-production builds only (`DEV_TOOLS_ENABLED`, `config/dev-tools.ts`) |
| `/dev/transactions` | `TransactionViewer` | `super-admin`; non-production builds only (`DEV_TOOLS_ENABLED`, `config/dev-tools.ts`) |
| `/intelligence/risk` | `RiskDashboard` (anomaly modal: acknowledge, resolve, dismiss; analysis) | Authenticated (anomaly actions: `operator`; analysis: `super-admin`) |
| `/intelligence/role-rules` | Redirects to `/role-rules` | Authenticated |
| `/intelligence/peer-groups` | `PeerGroupsPage`, "Peer groups" (groups by department and job title with members, outliers and when computed by the nightly batch; a group's modal: outliers linked to their access, the entitlements the rules give the group; read-only) | `policy-admin` |
| `/intelligence/suggestions` | `PolicySuggestions` | Authenticated |
| `/intelligence/reviews` | `AccessReviews` (campaigns, My Reviews; Reviewer quality: each reviewer's score per completed campaign with its signals, by campaign) | Authenticated (Reviewer quality: `super-admin`) |
| `/intelligence/analytics` | `Analytics` | Authenticated |
| `/admin/users` | `AdminUsersPage` (console sign-ins of the tenant with their last sign-in: invite with the code shown once, list and cancel pending invites, change a role, issue a password reset code shown once, revoke sessions, deactivate, reactivate) | `super-admin` |
| `/admin/scim` | `SCIMSettings` | `super-admin` |
| `/admin/webhooks` | `WebhooksPage` (outbound webhooks: create, edit, pause, resume, delete, send a test; delivery history modal linking failed deliveries to the dead-letter queue) | `super-admin` |
| `/admin/tenants` | `TenantManagement` | platform admin (`isPlatformAdmin` from `GET /auth/me`, `PlatformAdminRoute`) |
| `/admin/reconciliation-config` | `ReconciliationConfig` | `policy-admin` |
| `/leavers` | `LeaversPage`, "Joiners, movers and leavers" (pending leaver batches, failed offboardings, decided, HR joiners, HR movers, policy; `?tab=`) | `policy-admin` |
| `/dead-letter` | `DeadLetterPage` (dead-letter queue: filter, detail, retry, replay, dismiss; `?source=` starts filtered by a source prefix) | `operator` (retry and replay: `super-admin`) |
| `/sod-policies` | `SodPoliciesPage` (segregation-of-duties policies: list, create, action and severity, on or off, delete only deactivates; where they act) | Authenticated (changes: `policy-admin`) |
| `/credentials` | `CredentialLifecyclePage`, "Credential lifecycle" (due and overdue credentials, the ones that could not be checked with the reason, the note that automatic reset is off; compliance summary and credential policies: create, edit, delete; `?tab=`) | `operator` (summary and policies: `policy-admin`) |
| `/settings/security` | `AccountSecurityPage` (MFA setup, backup codes, password; `?mfa_enrollment=true` starts the MFA setup a tenant requires) | Authenticated. While a sign-in's MFA enrollment token is the session (`mfaEnrollmentOnly`), `?mfa_enrollment=true` is the only page: shown without the app layout, and every other route of `ProtectedAppLayout` leads back to it (`auth/MfaEnrollmentGate.tsx`) |
| `/access-requests` | `AccessRequestPortal` (the request form shows the SoD pre-check and, for operators, the peer group check) | Authenticated |
| `/access-requests/approvals` | `AccessRequestPortal` | Authenticated |
| `/access-requests/:id` | `RequestDetail` | Authenticated |
| `/compliance/reports` | Compliance Reports (nav entry for policy-admin and super-admin only) | `policy-admin` |
| `/compliance/gdpr` | `GdprPage`, "GDPR requests" (find a person by name or email in the identity list, offboarded people included: access export saved as a JSON file with its counts, consent records with record, grant again and revoke, erasure with a dry run, a typed confirmation and the attestation; the tenant's consent report) | `operator` (erasure: `super-admin`) |
| `/intelligence/privileged-access` | `PrivilegedAccessDashboard` | Authenticated |

---

## Interface Contract (Backend DTO → Frontend)

| Backend DTO | Frontend Interface |
| --- | --- |
| StandardUserDto | `interfaces/standard-user.interface.ts` (re-exports from `generated/api.types.ts`) |
| ImpactAnalysisRequest/Response | `interfaces/impact-analysis.interface.ts` |
| Timeline events | `interfaces/timeline.interface.ts` |
| IDrift, IConnectorHealthStatus | `interfaces/reconciliation.interface.ts` |
| IAuditEvent, IAuditFilter | `interfaces/audit.interface.ts` |
| IBulkOperation, IBulkProgress | `interfaces/bulk-operation.interface.ts` |
| IWorkflowExecution, IDistributedTransaction | `interfaces/developer.interface.ts` |
| ICorrelationConfig | `interfaces/correlation-config.interface.ts` |
| IReconciliationConfig | `interfaces/reconciliation-config.interface.ts` |
| IUncorrelatedAccount | `interfaces/uncorrelated.interface.ts` |
| Dead-letter entry, stats (`GET /dead-letter`, `/stats`, `/:id`) | `interfaces/dead-letter.interface.ts` (type and status unions from `generated/api.types.ts`) |
| SoD policy (`GET /sod-policies`, create and update bodies) | `interfaces/sod-policy.interface.ts` (written out: the spec types the bodies as unknown) |
| Credential inventory row, compliance summary, credential policy and its bodies (`/credential-lifecycle`) | `interfaces/credential-lifecycle.interface.ts` (written out: the spec types the responses as unknown) |
| Agent identity, its list page, filter, create body and issued credential (`/nhi`) | `interfaces/nhi.interface.ts` (written out: the spec types the bodies and responses as unknown) |
| Identity access graph, entitlement holders, access path, graph SoD violations, resync result (`/access-explorer`) | `interfaces/access-explorer.interface.ts` (written out from the controller: the spec types the responses as unknown) |
| Reviewer quality score, peer group with baseline and outliers, recommendation, unusual-request warning (`/intelligence`) | `interfaces/access-intelligence.interface.ts` (written out from the schemas and the service: the spec types the responses as unknown) |
| Admin user, invite (`GET /auth/users`, `POST /auth/invites`) | `interfaces/admin-user.interface.ts` (hand-written: the generated types carry no response bodies for these routes) |
| Webhook subscription, delivery attempt, test result (`/event-subscriptions`, `/:id/deliveries`, `/:id/test`) | `interfaces/webhook.interface.ts` (hand-written from the Mongoose schemas: the generated types carry no response bodies for these routes) |
| Field mastery of an identity (`GET /identity/:id/mastery`) | `interfaces/identity-mastery.interface.ts` (hand-written: the generated types carry no response body for this route) |
| GDPR consent record, consent report, erasure attestation, access export (`/identity/:id/consent`, `/identity/compliance/consent-report`, `/identity/:id/gdpr-erase`, `/identity/:id/dsar-export`) | `interfaces/gdpr.interface.ts` (hand-written from the services: the generated types carry no response bodies for these routes) |
| Chain check, Merkle checkpoint (list, create), event proof, checkpoint check, anchor (`/audit/verify-integrity`, `/audit/merkle-roots`, `/audit/verify-event/:eventId`, `/audit/verify`, `/audit/merkle-roots/:checkpointId/anchor`) | `interfaces/audit-integrity.interface.ts` (hand-written from the audit services: the generated types carry no response bodies for these routes) |

**After backend DTO changes:** Run `npm run generate:api` to regenerate `generated/api.types.ts`, then update relevant `interfaces/` re-export.

---

## Connector Registry

**Source of truth:** `features/blueprints/shared/connector-registry.ts`

- `CONNECTOR_REGISTRY`: name, icon, color, direction, configSchema, idPatterns, and `policyActions` (the actions the Design studio's policy node rail offers for a target connector).
- `POLICY_ACTION_TARGETS`: the target systems a policy action can name (the registered target connectors by backend id, plus `all`); the action drawer (`components/ActionConfig.tsx`) offers only these.
- Per-connector config: `features/blueprints/connectors/` (entra, ad).
- Display name → backend ID mapping: `config/connector-mapping.ts`.

---

## Theme System

`theme/themeConfig.ts` exports: `BRAND`, `SEMANTIC`, `lightTheme`, `darkTheme`, `siderTheme`.

Color mode: `ColorModeContextProvider` in `contexts/color-mode/`. Persisted to `localStorage("colorMode")`.

Use `BRAND.*`, `SEMANTIC.*`, or `theme.useToken()` inside components.

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Var | Purpose |
| --- | --- |
| `VITE_AUTH_DISABLED` | `true` for local dev (uses DevAuthProvider) |
| `VITE_API_BASE_URL` | API base URL (default: `/api/v1` via Vite proxy) |
| `VITE_OIDC_AUTHORITY` | OIDC provider URL |
| `VITE_OIDC_CLIENT_ID` | OIDC client ID |
| `VITE_OIDC_ROLE_CLAIM` | Role claim name (default: `roles`) |

---

## How to Add a New Page

See `rules/agent-workflows.md` § "Adding a New Frontend Page" for the full 8-step workflow.

---

## How to Add a New API Domain

1. Create `api/<domain>-api.ts` with query key factory + async functions + hooks.
2. Add real-time support: update `EVENT_INVALIDATION_MAP` and `ALL_ROOMS` in `api/realtime.tsx`.
3. Add interfaces to `interfaces/` (re-export from `generated/api.types.ts` where possible).
4. Update `docs/architecture/API_CHANGELOG.md`.

---

## Dev Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | TypeScript check + production build |
| `npm run typecheck` | Type check only (`tsc --noEmit`) |
| `npm run lint` | ESLint on `src/` |
| `npm run test` | Vitest (single run, at most 4 workers: `maxWorkers` in `vitest.config.ts`) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage |
| `npm run generate:api` | Regenerate `generated/api.types.ts` from `swagger-spec.json` |
| `npm run analyze` | Bundle visualization |

---

## Testing

- **Framework:** Vitest + `@testing-library/react`
- **Custom render:** `test/test-utils.tsx` (wraps with all providers)

---

## Project Structure

```
frontend/src/
├── App.tsx                         # Root: providers, router, all route declarations
├── index.tsx                       # Entry point
├── auth/                           # 3 auth providers + context + guards
├── api/                            # API modules + data layer, WebSocket
│   ├── data.ts
│   ├── constants.ts
│   ├── realtime.tsx
│   ├── audit-api.ts
│   ├── identity-api.ts
│   └── ...                         # Per-domain API modules
├── components/
│   ├── common/                     # DriftIndicator, ErrorBoundary, LiveBadge, PiiField, PageHeader, CommandPalette
│   ├── dashboard/                  # ProvisioningProgress
│   ├── layout/                     # navigation.tsx (NAV_SECTIONS: the menu), CustomSider, TopBar, MobileHeader, ConnectionStatus
│   └── policy-engine/              # PolicyEngineStudio, PolicyEditor, PolicyPreview, PolicyList
├── config/                         # api-routes, connector-mapping, pagination, polling
├── contexts/color-mode/            # Light/dark mode context
├── features/                       # Feature pages (lazy-loaded)
│   ├── auth/                       # Login, SAML callback
│   ├── dashboard/                  # Dashboard (/dashboard)
│   ├── users/                      # Identity Hub: UserList.tsx, create, onboarding, IdentityDetailPage.tsx (/identities/:id)
│   │   └── components/             # Identity page tabs: UserProfileTab, AccessTab, UserTimeline, etc.
│   ├── identity-map/               # Entitlement map canvas (/identity/:id/map)
│   ├── blueprints/                 # Design Studio: ReactFlow canvas
│   │   └── components/blueprint/   # ConnectorManager, canvas nodes, etc.
│   ├── connectors/                 # Connector Marketplace
│   ├── reconciliation/             # Reconciliation Dashboard
│   ├── leavers/                    # HR joiners, movers and leavers: mass-joiner, mass-mover and mass-leaver batches, policies
│   ├── dead-letter/                # Dead-letter queue: failed events and workflow steps, retry/replay
│   ├── sod-policies/               # Segregation of duties: SoD policies and where they act
│   ├── credential-lifecycle/       # Credential lifecycle: due and unchecked credentials, policies, identity tab
│   ├── nhi/                        # Non-human identities: agents, delegation, revoke, kill switch, credentials
│   ├── access-explorer/            # Access explorer: access graph canvas, holders, access path, graph SoD, resync
│   ├── webhooks/                   # Outbound webhooks: subscriptions, test delivery, delivery history
│   ├── admin-users/                # Admin users: console sign-ins, roles, invites, session revocation
│   ├── bulk-operations/            # Bulk CSV import & batch provisioning
│   ├── audit/                      # Audit Dashboard
│   ├── audit-integrity/            # Audit integrity: hash chain, Merkle checkpoints, event proofs, anchors
│   ├── developers/                 # Workflow Debugger, Transaction Viewer
│   ├── intelligence/               # Risk, Peer groups, Suggestions, Reviews (reviewer quality), Analytics, identity Recommendations tab
│   ├── access-requests/            # Access Request Portal, Approval Queue, Request Detail
│   ├── compliance/                 # Compliance reports; GDPR requests: access export, consent, erasure
│   ├── privileged-access/          # PAM Dashboard
│   ├── admin/                      # SCIM, Tenants, Recon Config
│   └── settings/                   # Account Security
├── generated/api.types.ts          # AUTO-GENERATED (do not edit)
├── interfaces/                     # TypeScript types — must mirror backend DTOs
├── stores/                         # connector-store (persisted), policy-draft-store (in-memory), command-palette-store (open state)
├── theme/                          # BRAND, SEMANTIC, lightTheme, darkTheme, siderTheme
├── test/                           # setup.ts, test-utils.tsx
└── utils/                          # user-helpers.ts
```

### Path Aliases

| Alias | Points To | Use For |
|---|---|---|
| `@features/*` | `src/features/*` | Page/feature components |
| `@api/*` | `src/api/*` | API modules, data provider, constants, realtime |
| `@shared/*` | `src/components/common/*` | Shared UI components (LiveBadge, DriftIndicator, etc.) |
| `@stores/*` | `src/stores/*` | Zustand stores |
| `@config/*` | `src/config/*` | Polling, pagination, API routes, connector mapping |
| `@theme/*` | `src/theme/*` | Theme config |
