# Deployment Guide

> From development to production deployment with Docker Compose.

---

## Supported Deployment Model

EuroID is supported as **one installation per customer**: a dedicated stack (API, worker, frontend, MongoDB, Temporal and its database, plus Elasticsearch and Neo4j when used), run by the operator for that customer or inside the customer's network. Each installation serves one tenant: set `DEFAULT_TENANT_ID` (§ 5) and leave `SAML_ALLOWED_TENANT_IDS` empty. Inside the customer's network the AD connector reaches the domain controllers directly, and the file connectors' directories belong to that customer alone.

The code isolates tenants logically, but hosting several customers in one installation is not supported: AD and the file connectors need a remote agent that is not built, and the file directories are shared by all tenants. What exists and what is missing: [FUTURE_SHARED_HOSTING.md](architecture/future/FUTURE_SHARED_HOSTING.md).

## Architecture Overview

EuroID runs as 3 application containers (`euro-frontend`, `euro-api`, `euro-worker`) and the infrastructure services `euro-mongo`, `mongo-express`, `temporal`, `temporal-db`, `temporal-ui`, the one-shot `temporal-init` and the optional `euro-neo4j` (compose profile `graph`). The diagram shows the application containers and the three core stores:

```
┌─────────────────────────────────────────────────────────────┐
│  Load Balancer / Reverse Proxy (your infrastructure)        │
│  :443 → frontend :80  |  :443/api → euro-api :3001          │
└────────────┬──────────────────────────┬─────────────────────┘
             │                          │
     ┌───────▼───────┐         ┌───────▼───────┐
     │ euro-frontend  │         │  euro-api      │
     │ nginx:80       │         │  NestJS:3001   │
     │ (static SPA)   │         │  (REST + WS)   │
     └────────────────┘         └───────┬────────┘
                                        │
                                ┌───────▼───────┐
                                │ euro-worker    │
                                │ Temporal SDK   │
                                │ (no port)      │
                                └───────┬────────┘
                                        │
                    ┌───────────────────┬┴──────────────────┐
                    │                   │                    │
            ┌───────▼───────┐  ┌───────▼───────┐  ┌───────▼───────┐
            │ euro-mongo     │  │ temporal       │  │ temporal-db   │
            │ MongoDB:27017  │  │ gRPC:7233      │  │ Postgres:5432 │
            └────────────────┘  └────────────────┘  └────────────────┘
```

---

## Development Environment

See `docs/GETTING_STARTED.md` for full setup. Quick summary:

```bash
# Start infrastructure (temporal-init registers the TenantId search attribute and exits)
docker compose up euro-mongo temporal temporal-db temporal-init temporal-ui mongo-express -d

# Pending migrations, from the TypeScript files through ts-node (the API image runs the compiled ones, see Container Images)
cd backend && npm run migrate:up

# 3 terminals
cd backend && npm run start:dev          # API on :3001
cd backend && npm run start:worker:watch # Temporal worker
cd frontend && npm run dev               # Vite on :5173
```

---

## Docker Compose (Full Stack)

### Start Everything

```bash
docker compose up -d
```

### Services

| Service | Image | Port | Health Check |
|---------|-------|------|-------------|
| `euro-frontend` | `frontend/Dockerfile` | 80 | nginx `/health` |
| `euro-api` | `backend/Dockerfile` | 3002 → 3001 | `GET /api/v1/health` |
| `euro-worker` | `backend/Dockerfile.worker` | — | Temporal heartbeat |
| `euro-mongo` | `mongo:latest` | 27017 | — |
| `mongo-express` | `mongo-express` | 8081 | — |
| `temporal` | `temporalio/auto-setup` | 7233, 8233 | — |
| `temporal-init` | `temporalio/admin-tools` (pinned) | — | One-shot: registers `TenantId`, exits 0; `euro-api` and `euro-worker` start after it |
| `temporal-db` | `postgres:13` | — | — |
| `temporal-ui` | `temporalio/ui` | 8080 | — |
| `euro-neo4j` | `neo4j:5` (profile `graph`, off by default) | 7474 (Browser) and 7687 (Bolt), bound to 127.0.0.1 | — |

Neo4j backs the access explorer and is optional. Start it with `docker compose --profile graph up -d euro-neo4j` after setting `NEO4J_PASSWORD` (8 characters or more) in the root `.env`; `NEO4J_HEAP_MAX_SIZE` defaults to `512m`. The API and the worker read `NEO4J_URL` (default `bolt://euro-neo4j:7687`), `NEO4J_USER` (default `neo4j`) and `NEO4J_PASSWORD`, which must be the same for both.

### Container Images

| Image | Base | Build | Notes |
|-------|------|-------|-------|
| `euroid-api` | `node:20-slim` | Multi-stage (deps → build → run) | `curl` installed for healthcheck. Runs the pending migrations before the API starts |
| `euroid-worker` | `node:20-slim` | Multi-stage + workflow bundle pre-built | No healthcheck (Temporal manages liveness) |
| `euroid-frontend` | `nginx:1.27-alpine` | Multi-stage (deps → build → nginx) | SPA routing via `try_files` |

**Migrations in the image.** The `euroid-api` image has production dependencies only (no ts-node) and no `src/`, so it cannot load the TypeScript migrations. `nest build` compiles them and `migrate-mongo-config.ts` into `dist/`, and the CMD runs `npm run migrate:up:dist` and then the API: migrate-mongo lists `migrations/*.ts` and `backend/scripts/load-compiled-migrations.js` loads each as its compiled `dist/migrations/<name>.js`. migration_changelog keeps the `.ts` names, the same ones `npm run migrate:up` (ts-node, development) records, so a database migrated either way is recognised by the other. A failed migration stops the container before the API starts. To run them by hand in a container of the image: `npm run migrate:status:dist`, `npm run migrate:up:dist`, `npm run migrate:down:dist` (from `/app`, with the API's environment: `MONGO_URI`, the encryption settings and `CORRELATION_HMAC_SECRET`, which `20261125000000-strip-raw-national-id` reads). Docker Compose passes `CORRELATION_HMAC_SECRET` from the root `.env` to `euro-api` and `euro-worker` (empty when unset).

> **Why `node:20-slim` not `node:20-alpine`?** The Temporal SDK has native modules that fail on Alpine (musl). See ADR in `docs/adr/DECISIONS_LOG.md`.

---

## Production Checklist

### 1. Secrets & Encryption

| Variable | How to Generate | Notes |
|----------|----------------|-------|
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | **Required.** Envelope encryption for connector credentials, and the source of the key Temporal payloads are encrypted with (derived, see below). |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Required when using local auth (email/password). |
| `ENCRYPTION_KEY_ID` | `rotate-encryption-key.ts --generate` prints one with the new key | Stored with every secret the key encrypts (default `default`). Required, and not `default`, while `ENCRYPTION_KEY_PREVIOUS` is set: the API and the worker refuse to start otherwise. Keep it after a rotation. No `:`. |
| `ENCRYPTION_KEY_PREVIOUS`, `ENCRYPTION_KEY_PREVIOUS_ID` | Your current `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID` | During a key rotation only; remove both when the script reports every secret under the new key and no Temporal workflow started before the rotation is still running. Steps: `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` § Key Rotation. |
| `CORRELATION_HMAC_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Required for national ID correlation (the Brain's Hashed National ID rule): at least 16 characters, the same for the API and the worker. There is no fallback: without it nothing is hashed, national IDs are dropped unhashed, the API and the worker log one warning, and the Design studio refuses to save a Hashed National ID rule. Tenants without the rule need none. Changing it changes every hash, so stored identities no longer match new records by national ID until their sources sync again. |

> Never reuse dev keys in production. See `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` for the full encryption model.

**Temporal payload encryption.** The API and the worker encrypt every payload they send to Temporal (workflow inputs such as an onboarding's email, activity arguments and results, signals, memos, results) with AES-256-GCM, under a key derived from `ENCRYPTION_KEY` and its key id. There is no setting to turn on. Details: `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` § Temporal Payloads.

- **Deploy the API and the worker together, with the same encryption settings.** A worker without the codec (or without the key) cannot read the workflows a new API starts: their workflow tasks fail and Temporal retries them until the new worker runs. An API without the codec cannot read the results and memos a new worker writes (bulk provisioning status, batch onboarding and reconciliation results) and answers with an error until it is updated. Workflows started before the deploy go on as they are: their plaintext payloads pass through.
- **Temporal UI and CLI:** inputs, results and other payloads show as `binary/encrypted` base64. No codec server is provided for the UI. To read a payload, export the history with `temporal workflow show --workflow-id <id> --namespace <ns> --output json > history.json` and run `npx ts-node -r tsconfig-paths/register src/scripts/decode-temporal-payloads.ts history.json` from `backend/` with the worker's encryption settings. The output holds personal data.
- **Rollback:** do not roll back to a version without the codec while workflows started with it are running or their results are still read: such a worker fails their tasks (unknown encoding `binary/encrypted`) and such an API fails to read their results, until a version with the codec runs again. The workflows wait with their state intact, but an activity whose encrypted input such a worker picks up fails its attempts and can run out of retries. New workflows started on the rolled-back version are unencrypted and run normally.
- **Key rotation:** keep `ENCRYPTION_KEY_PREVIOUS` until every workflow started before the rotation has closed (§ Key Rotation, step 4).

### 2. Authentication

**Disable dev bypass:**

```env
# backend/.env
AUTH_DISABLED=false
OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_AUDIENCE={client-id}

# frontend/.env
VITE_AUTH_DISABLED=false
VITE_OIDC_AUTHORITY=https://login.microsoftonline.com/{tenant-id}/v2.0
VITE_OIDC_CLIENT_ID={client-id}
```

See `.env.production.example` files in both `backend/` and `frontend/`.

Supported providers: **Entra ID (Azure AD)**, **Auth0**, **Keycloak**, or any OIDC-compliant IdP.

Optional: SAML 2.0 SSO — set `SAML_ENTRY_POINT`, `SAML_CERT`, etc. in backend `.env`.

### 3. MongoDB

- Use a managed MongoDB service (Atlas, DocumentDB, or self-hosted replica set)
- Enable authentication (`MONGO_URI` with credentials)
- Enable TLS for connections
- Configure connection pool: `MONGO_MAX_POOL_SIZE` (default 20), `MONGO_MIN_POOL_SIZE` (default 5)

### 4. Temporal

- Use Temporal Cloud or a self-hosted Temporal cluster
- For mTLS: set `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH`, `TEMPORAL_TLS_CA_PATH` for the API and the worker (both read them through `temporalTlsConfig()` in `backend/src/infrastructure/config/temporal.config.ts`). Unless all three are set and the files exist, the connection is plain, and an mTLS-only server (Temporal Cloud) refuses it
- Set `TEMPORAL_ADDRESS` to your cluster endpoint
- `TEMPORAL_NAMESPACE` (default `default`): the namespace the API starts workflows in and the worker (with its schedules) polls. Both read it from `backend/src/infrastructure/config/temporal.config.ts`, so set it the same for the API and the worker. The Temporal UI links in API responses (`trackingUrl`, built from `TEMPORAL_UI_URL`) name it too
- Register the custom search attribute `TenantId` (type `Keyword`) in that namespace before the first workflow starts (below)

#### The `TenantId` search attribute

Every workflow the API starts for a tenant carries the custom search attribute `TenantId` (Keyword) with the tenant id: onboarding, offboarding, movers, reconciliation, bulk provisioning, access review campaigns, access requests and scheduled connector syncs (`searchAttributes: { TenantId: [tenantId] }`; the name is in `backend/src/infrastructure/temporal/tenant-search-attribute.ts`). Child workflows inherit it (`backend/src/workflows/child-workflow-tenant.ts`), and a route that reads or controls a workflow by id answers 404 unless its `TenantId` is the caller's tenant (`backend/src/infrastructure/temporal/tenant-workflow.ts`).

Temporal accepts only search attributes that are registered on the server. Without `TenantId` it refuses every one of those starts (the error names `TenantId`; the API logs it), so nothing can be onboarded, offboarded, reconciled or reviewed. Register it once per Temporal cluster, in the namespace set by `TEMPORAL_NAMESPACE` (default `default`). The commands below use `default`; put your namespace there if you set another.

**Docker Compose.** The `temporal` service (`temporalio/auto-setup`) does not register it: the image's setup script (`docker/auto-setup.sh` in `temporalio/docker-builds`) registers only Temporal's own test attributes (`CustomKeywordField` and others) and reads no variable that adds others. The one-shot service `temporal-init` (`temporalio/admin-tools`, pinned) does it with the Temporal CLI: it retries until Temporal and the namespace answer, does nothing when `TenantId` is already registered, and exits 0; `euro-api` and `euro-worker` start only after it completed (`service_completed_successfully`). The namespace is `TEMPORAL_NAMESPACE` from the root `.env` (default `default`), which compose also passes to auto-setup (`DEFAULT_NAMESPACE`), the API and the worker. Temporal stores the attribute in `temporal-db` (the `postgres_data` volume); `docker compose down -v` removes it, and the next `up` registers it again. Check: `docker compose logs temporal-init` ends with "TenantId is registered in namespace default".

**Any Temporal server (Temporal CLI):**

```bash
temporal operator search-attribute create --address <host>:7233 --namespace default --name TenantId --type Keyword
# Check: TenantId is listed with type Keyword
temporal operator search-attribute list --address <host>:7233 --namespace default
```

Add `--tls-cert-path`, `--tls-key-path` and `--tls-ca-path` for a server that requires mTLS. For development without Docker, `temporal server start-dev --search-attribute TenantId=Keyword` starts a dev server with it registered.

**Operator API.** The CLI calls the gRPC method `OperatorService.AddSearchAttributes`. From the TypeScript SDK (the workflow e2e tests make the same call, for example `backend/test/workflows/hr-mover.workflow.e2e-spec.ts`):

```ts
import { Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
await connection.operatorService.addSearchAttributes({
  namespace: 'default',
  searchAttributes: {
    TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
  },
});
```

**Temporal Cloud.** Add `TenantId` (Keyword) to the namespace's custom search attributes in the Cloud UI or with Temporal's Cloud CLI.

### 5. Multi-Tenancy

```env
DEFAULT_TENANT_ID=your-org-id
JWT_TENANT_CLAIM=tenantId    # Must match your IdP's token claim
```

### 6. CORS

```env
CORS_ORIGINS=https://your-domain.com
```

Restrict to your frontend domain(s) only. Comma-separated for multiple origins.

### 7. Data Retention

```env
WORKFLOW_RETENTION_DAYS=90
USER_EVENTS_RETENTION_DAYS=365
AUDIT_RETENTION_DAYS=365
IDENTITY_SOFT_DELETE_RETENTION_DAYS=30
```

For cold storage archival (S3 or Azure Blob), see `ARCHIVAL_STORAGE_*` vars in `backend/.env.example`.

### 8. Email Notifications (optional)

```env
SMTP_HOST=smtp.your-domain.com
SMTP_PORT=587                       # STARTTLS required by default; 465 = implicit TLS
SMTP_USER=euroid-mailer
SMTP_PASSWORD=<secret>
SMTP_FROM=EuroID <no-reply@your-domain.com>
FRONTEND_URL=https://your-domain.com  # links in the mails; default: first CORS_ORIGINS entry
```

Unset `SMTP_HOST` keeps email off (in-app notifications only). Who gets which mail, and how failed sends are retried through the dead-letter queue: `backend/src/modules/notifications/docs/ARCHITECTURE.md`. All variables: `backend/.env.example`.

---

## Upgrading to the 2026-11-25 release

The release is described entry by entry in `docs/architecture/API_CHANGELOG.md` under `[2026-11-25]`. The steps below are in the order an operator works.

### Before the deploy

1. **Run the migrations first.** From `backend/`, with `MONGO_URI` pointing at the production database (`migrate-mongo-config.ts`), run `npm run migrate:up` (`npm run migrate:status` lists what is pending). The migrations in this release (everything after the baseline of 2.0.0 in `backend/migrations/`) are `20261121000000-identity-correlation-id-unique-index` (when identities of one tenant share a `profile.correlationId` it fails, lists them and changes nothing; the later migrations then do not run and the `euro-api` container does not start, so merge or correct those identities and run it again), `20261122000000-agent-id-per-tenant-unique`, `20261122000001-entitlement-catalog-native-id-index`, `20261122000002-offboarding-records-from-leaver-events` (copies each leaver event's offboarding result to `offboarding_records`), `20261123000000-joiner-events-one-per-hire`, `20261123000001-identity-email-unique-among-live`, `20261124000000-deprovisioned-writeback-incomplete`, `20261124000001-audit-chain-indexes`, `20261125000000-strip-raw-national-id` (item 6), `20261125000001-drop-embedded-tenant-id` (item 7), `20261125000002-webhook-delivery-unique-per-event` (item 8), `20261125000003-identity-email-lowercase` (item 11), `20261125000004-scim-group-unique-name` (item 12), `20261126000000-close-false-positive-drifts` (item 13), `20261126000001-consent-unique-per-purpose` (item 14), `20261126000002-tenant-settings-types` (item 15), `20261126000003-identity-open-conflict-index` (item 16), `20261126000004-identity-employee-id-index` (item 17) `20261126000005-review-item-reviewer-lowercase` (item 18), `20261126000006-nhi-ownerless-backfill` (item 19) and `20261126000007-entra-provisioning-backfill` (item 20), `20261126000008-report-empty-condition-groups` (item 21), `20261126000009-scim-token-default-scopes` (item 22). `20261124000001-audit-chain-indexes` must finish before the new API and worker start: it builds the unique partial index `audit_events {tenantId, seq}`, `audit_chain_heads {tenantId}` and `audit_roots {tenantId, firstSeq}`. Without it Mongoose builds the `audit_events` index at start by scanning the whole collection, while events are written. The `euro-api` image runs them before it starts (`npm run migrate:up:dist`, see Container Images); the `euro-worker` image runs none (`backend/Dockerfile.worker`), so do not rely on the API container having finished when the worker comes up.
2. **Check the outbox.** Look for rows in `event_outbox` with `status: "processing"`. The new poller takes such a row again when its claim is older than `OUTBOX_CLAIM_TIMEOUT_MS`, or when it has no `claimedAt` and its `updatedAt` is older (`backend/src/infrastructure/events/outbox-poller.service.ts:137-140`), and publishes it, so an old stuck row is published on the first poll after the deploy.
3. **Check Temporal.** The `TenantId` search attribute (Keyword) must be registered in the namespace the API and the worker use (see "The `TenantId` search attribute" above). Docker Compose registers it through `temporal-init`. `TEMPORAL_NAMESPACE` now applies to the API too (`backend/src/infrastructure/temporal/temporal-client.provider.ts:30-33`): with it set to something other than `default`, workflows started earlier in `default` are not reachable through the API. Do not terminate a stuck daily reconciliation run that started before this release on its own: terminate its running orphan cleanup child as well.
4. **Review SoD BLOCK policies.** An SoD policy now also matches an operation on target `all`, and the legacy target name `active-directory` is read as `ad` (`backend/src/modules/policy/sod.service.ts:155`), so a BLOCK policy can start to refuse requests it did not before. Onboarding and mover runs now also compare a rule's group display name with a policy's native id (GUID) through the entitlement catalog, as access requests already did: a BLOCK policy written with GUIDs now stops a joiner or mover whose rules name those groups by display name, so check the policies' entitlements against your rules.
5. **Remove `INTELLIGENCE_BASELINE_HOLD_RATE`** from your deployment config; the variable is dropped and nothing reads it.
6. **National IDs: `20261125000000-strip-raw-national-id`.** It removes the raw national IDs (each tenant's Hashed National ID field and `hetu`) from `sources[].rawData`, `profile.customAttributes`, the access baseline and held conflict rows of every identity, deleted ones included, and from the bulk rollback snapshots of Golden Records still kept (`rollback_snapshots`, kinds `hub-identity` and `hub-conflict-flags`; a fixed-key `profile.correlationId` in one is removed, and the next sync of a restored identity sets the hash again); the values cannot be restored (`down` does nothing). Run it with the production `CORRELATION_HMAC_SECRET` (16+ characters, the value the API uses) and the API's encryption settings (`ENCRYPTION_KEY` or KMS: it decrypts each tenant's Brain config and those snapshots) in its environment. A snapshot it cannot decrypt fails it before any change and is named by `_id`: no key opens it, so a rollback cannot restore it either; delete it from `rollback_snapshots`, or wait until it expires (`ROLLBACK_SNAPSHOT_TTL_HOURS`), and run it again. For a tenant with a Hashed National ID rule it recomputes `profile.correlationId` from the stored value, which repairs the hashes made without a secret (a fixed key from the source code, the same for every tenant). The raw values are the only way to rebuild those hashes, so while any tenant has the rule and the secret is missing or shorter than 16 characters, it fails before any identity changes and names those tenants: set the secret, or remove the rule from their Brain config, and run it again. A tenant without the rule needs no secret: its `profile.correlationId` is never made or changed, except that one which is such a fixed-key hash of the identity's own value is removed. A Brain config it cannot decrypt fails it before any identity changes. Two identities of one tenant that would get the same hash are logged by id and keep their `profile.correlationId` (a fixed-key hash is removed): merge them. A rule field a database path cannot name (with a dot or a space) is logged by name and its values are left: remove them by hand. An identity whose sources a sync reordered while it ran is left as it is and logged by id; to clean it, run `npm run migrate:down` twice (it undoes the last applied migration first, `20261125000001-drop-embedded-tenant-id`; neither `down` changes data, they only unmark the migrations) and `npm run migrate:up` again with HR syncs paused (both migrations are safe to run again). It logs counts and ids, never values. The API and the worker of the previous release store the raw value again for every row they ingest: pause HR syncs (scheduled and manual) from this migration until the new API and worker run, or a row ingested in between keeps its raw value.
7. **Embedded tenantId: `20261125000001-drop-embedded-tenant-id`.** In every collection it drops each index whose key is a single nested `<path>.tenantId` (`sources.tenantId_1`, `passwordPolicy.tenantId_1` and the like; the tenant plugin made them for every embedded schema, and no query used them), never a top-level or compound index, and removes the `tenantId` stamped inside embedded documents (identity sources, controls, provisioning entries and linked admin accounts, policy conditions and actions, credential policy settings and the other embedded documents the models declare). An identity's `profile.tenantId` stays. It logs the indexes it dropped and the documents it changed per collection and path; a second run changes nothing. `down` does nothing: the old build stamps new subdocuments again and builds the indexes again at start. The API and the worker of the previous release keep stamping identity sources, controls and provisioning entries they save until they stop; such a value is harmless (nothing reads it) and goes when the array is next written.
8. **Webhook deliveries: `20261125000002-webhook-delivery-unique-per-event`.** Two processes handling one event at once (an outbox reclaim, a dead-letter replay) could both record and post its webhook delivery. The `webhook_delivery_attempts {subscriptionId, eventId}` index is now unique, and inserting the attempt is the claim (`backend/src/modules/event-subscriptions/event-delivery.service.ts`). The migration removes the duplicate attempts of each subscription and event first, keeping one: a `DELIVERED` attempt before a `PENDING` one before a `FAILED` one, the oldest among equals (the others would only have posted the event again; the log line counts them). Then it replaces the index under the same name. Attempts expire after 30 days, so only recent ones can be duplicated. `down` restores the non-unique index; it does not bring the removed attempts back. Run it before the new API starts: Mongoose cannot build the unique index over a non-unique one of the same name.
9. **Check the auth settings.** `EMERGENCY_TOKEN_VALID_UNTIL`, when set, must be an ISO 8601 date-time (`2026-12-31T23:59:00Z`): the API refuses to start with a value it cannot read, which until now made the break-glass token never expire. A deployment that has no active super-admin yet (SSO users JIT created as viewers do not count) and runs with `NODE_ENV` other than `development` or `test` needs `SETUP_TOKEN` to create its first admin (`POST /auth/register` with it as `inviteToken`, the Setup token field of the sign-in page); without it the registration answers 403. `staging` and `pre-prod` get the production rules everywhere now (`backend/src/infrastructure/config/runtime-env.ts`), as does an unset `NODE_ENV`: the API refuses to start with `AUTH_DISABLED=true` or a `JWT_SECRET` shorter than 32 characters or a placeholder, Swagger UI is off, `/metrics` needs `METRICS_TOKEN`, the auth cookies are `secure` (serve such an environment over HTTPS), and SAML needs signed assertions, `APP_BASE_URL` and `SAML_AUTO_CREATE_USER=true` for new users. Set `NODE_ENV=development` only on a developer machine. SAML now accepts only responses to the AuthnRequests EuroID sent: sign-ins started from the identity provider's portal (IdP-initiated) are refused until `SAML_VALIDATE_IN_RESPONSE_TO=ifPresent` is set. If the API is reachable without a reverse proxy in front, set `TRUST_PROXY=false`: with the default (one trusted proxy) a client can choose the address the sign-in, break-glass and password reset rate limits count by sending `X-Forwarded-For`. **SAML users created on a first sign-in (JIT) are capped:** their role is the asserted one (or `SAML_DEFAULT_ROLE`) held to `SAML_JIT_MAX_ROLE` (default `viewer`; never `super-admin`), and a tenant the assertion names (`SAML_TENANT_ATTR`) must be on `SAML_ALLOWED_TENANT_IDS` and be an active tenant in `tenants`; without the list only `SAML_DEFAULT_TENANT_ID` (else `DEFAULT_TENANT_ID`) is used (`backend/src/modules/auth/saml-jit-policy.ts`). A deployment whose IdP maps roles or tenants for new users sets both variables before the deploy, or new SAML users arrive as viewers of the default tenant and a sign-in into another tenant is refused. Existing SAML admins keep their stored role and tenant.
10. **File outbound connector: set `FILE_OUTBOUND_ALLOWED_DIR`.** The connector now writes only inside this directory, checked on the real path, symlinks resolved (`backend/src/modules/connectors/file-outbound-connector/file-outbound.service.ts`); before, a connector-admin could make the worker append to any file it can write. In production the variable is required wherever the connector is used: without it every provision and health check of the connector fails (400). Outside production the working directory is the default. A tenant's `outputFilePath` outside the directory now fails its provisioning: move the file or the setting before the deploy. Set it on the worker and the API (the API runs the health check).
11. **Identity emails: `20261125000003-identity-email-lowercase`.** Identity emails are now stored trimmed and lower-cased and compared in that form (`backend/src/shared/utils/email.ts`), so the same address in another case (HR `jane.doe@x.fi`, the IdP `Jane.Doe@x.fi`) is one identity. The migration lower-cases the `profile.email` of every soft-deleted identity and of every live identity whose address no other live identity of its tenant has in another case. Two or more live identities of a tenant with one address in different cases are left as they are: the log names them by id (`[migration] tenant <t>: identities <ids> have one email in different cases`), and each pair is raised as a correlation conflict (`matchedBy: 'email'`, confidence 0) in the identity hub's Conflicts list, where Merge joins them. An identity with an open conflict keeps it; when every one of a group has one, the log says to merge them by hand. A second run changes nothing. `down` does nothing (the original case is not kept). It changes no `managerEmail`, `personalEmail` or source record: reconcile lower-cases the profile email from them at the next sync. Run it before the new API starts; it needs no pause of HR syncs (a sync of the old API in between stores the case the source sends, and the next reconcile lower-cases it).
12. **SCIM groups: `20261125000004-scim-group-unique-name`.** `POST /scim/v2/Groups` checked for a group of that display name and then inserted one, so an IdP retrying a create made duplicate groups. `entitlement_catalog` now has a unique partial index `scim_group_name_unique` on `{ tenantId, name }` for `system: 'scim-inbound', type: 'Group'`, and the losing create answers 409 `uniqueness`. The migration first merges each tenant's SCIM groups of one name into the oldest (`createdAt`, then `_id`): its members get the others' members (each once), its `externalId` stays (or is the first other's when it has none), access requests naming another of them (`entitlements.catalogEntryId`) and SCIM groups holding another as a member are moved to it, and the others are deleted; the log names each kept group and the ids merged into it. Let the IdP's next sync of those groups confirm the members. A second run changes nothing. `down` drops the index and does not split merged groups. Run it before the new API starts: Mongoose cannot build the index over duplicates.
13. **Reconciliation drifts: `20261126000000-close-false-positive-drifts`.** Reconciliation compared hub fields with account fields no lookup returns, and the hub status with `ACTIVE` and `DISABLED`, so every run left open `FIELD_MISMATCH` drifts on `firstName`, `lastName`, `email`, `jobTitle`, `departmentName`, `mobilePhone` and `officeLocation`, and a CRITICAL `STATUS_MISMATCH` for every leaver, suspended, inactive or guest identity whose account was correctly disabled. The migration closes those open drifts in every tenant as `corrected` (`correctedAt` set), as a run closes a drift it no longer finds; no `drift.resolved` event is emitted for them. Real drifts (a leaver's account still enabled, an active identity's account disabled) and a PENDING identity's stay open, and the first run after the deploy updates them to the new values (`hubValue` `ENABLED` or `DISABLED`) or closes them. Ignored and corrected drifts are left as they are. `down` does nothing: reopening the false drifts would bring them back.
14. **Consents: `20261126000001-consent-unique-per-purpose`.** A consent grant upserted the record of an identity and purpose on a non-unique index, so two grants at once could store two records, and a revoke then changed only one of them, leaving the other `granted` in the consent report. `consents {tenantId, identityId, purpose}` is now unique. The migration first deletes the duplicates of each identity and purpose, keeping the record changed last (`updatedAt`, then the newest `_id`), which holds the consent's current state, then replaces the index under the same name (`tenantId_1_identityId_1_purpose_1`). Rerunning it is safe; `down` restores the non-unique index and cannot restore the deleted duplicates. Without the migration Mongoose cannot build the unique index (it logs the conflict) and duplicates stay possible.
15. **Tenant settings: `20261126000002-tenant-settings-types`.** `PATCH /api/v1/tenants/:id` now checks each setting's type, and the console's tenant edit form sends the stored settings back, so a tenant whose settings were stored with a wrong type before (`mfaRequired: "false"`, which read as true, or `maxIdentities: "500"`) answered 400 to every edit. The migration stores each known setting as its type when it can be read as one (`"true"`/`"false"`/`1`/`0` for `mfaRequired` and the `features` flags, a string of digits for `maxIdentities` and `retentionDays`, a comma-separated string for `allowedConnectors`) and removes a value it cannot read, logging the tenant id and the key (never the value). Unknown keys stay. Check the log: a removed `mfaRequired` means the tenant no longer requires MFA until an admin sets it again, and a removed `maxIdentities` means no limit. Rerunning it changes nothing; `down` restores nothing (the old values are not kept).
16. **Open conflicts: `20261126000003-identity-open-conflict-index`.** Before a record mints an identity, correlation now also looks for an open email conflict naming the record's address in another case (`backend/src/modules/identity/identity-email-case-conflict.ts`) and holds the record on it: until a mixed-case pair item 11 raised is merged, a new record of that person would otherwise mint a third identity. The migration builds the partial index `identities {tenantId, metadata.conflictDetails.matchedBy}` over identities with `metadata.requiresReview: true`, so that lookup reads the tenant's open conflicts only. No document changes; Mongoose would build it at start otherwise. Rerunning it changes nothing; `down` drops the index. A raised pair whose conflict is dismissed is not looked up this way: its first sync lower-cases one member, which the exact lookups then find, so merge the raised pairs rather than dismissing them.
17. **Employee ids: `20261126000004-identity-employee-id-index`.** An access review now gives the items of a person whose HR record names the manager only by `managerId` (an employee id, no `managerEmail`) to the live identity of the tenant with that employee id (`profile.employeeId`; an id two live identities carry names nobody, and the owner or default reviewer gets the item as before). The migration builds the index `identities {tenantId, profile.employeeId}` that lookup reads. No document changes; Mongoose would build it at start otherwise. Rerunning it changes nothing; `down` drops the index.
18. **Access review reviewers: `20261126000005-review-item-reviewer-lowercase`.** My Reviews (`GET /api/v1/access-reviews/my-reviews`) matched an item's reviewer exactly against the signed-in email, while deciding compared without case, so a reviewer whose stored address differed in case (an HR manager email sent as `Mia.Manager@...`) never saw their items there and they expired undecided. A reviewer id is now stored trimmed and lower-cased (`backend/src/modules/access-review/schemas/review-item.schema.ts`) and My Reviews asks for the email lower-cased. The migration lower-cases the `reviewerId` of the review items stored before, in every tenant, and logs how many it changed. Rerunning it changes nothing; `down` does nothing (the original case is not kept). Until it runs, items stored with an upper-case reviewer are still missing from that reviewer's My Reviews (the campaign view shows them).
19. **NHI agents whose owner left: `20261126000006-nhi-ownerless-backfill`.** An agent whose owner is offboarded or erased is now marked ownerless and gets no new credential until a super-admin gives it a new owner (`POST /api/v1/nhi/:agentId/owner`, or [Change owner] on the Non-human identities page) or revokes it; credentials issued before keep verifying until they expire (`backend/src/modules/nhi/nhi-ownership.service.ts`). From the deploy on the owner's offboarding or erasure sets the mark; the migration marks the agents, not revoked, whose owner identity was deleted (`offboarded`) or no longer exists (`erased` when the erasure took the owner email out, else `offboarded`) before it, in every tenant. An owner who is only suspended is not taken as gone. Rerunning it changes nothing, and `down` leaves the marks (removing them would let those agents get credentials again). After it, list them with `GET /api/v1/nhi?ownerless=true` (or the page's Ownership filter) and give each a new owner or revoke it: an integration that asks for a new credential for such an agent gets 409.
20. **Entra ID entries of bulk-provisioned people: `20261126000007-entra-provisioning-backfill`.** A bulk CREATE or UPDATE to Entra ID recorded the account's object id on the identity (its `entra-id` target source) but wrote no Entra ID provisioning entry, so `provisionedSystems` never listed Entra ID for those people: the mover never changed their Entra ID access, and offboarding reached them only through its no-provisioning-state fallback. From the deploy on, such an operation marks the identity's Entra ID entry SYNCED (`backend/src/activities/bulk-provisioning-created-account.ts`, `recordEntraSynced`), and a rollback puts the entry back as it was. The migration adds an `entra-id` entry, SYNCED with `provisionedAt` and `lastSync` set to now, to every live identity in every tenant that has an Entra ID target source with an account id and no Entra ID entry under any name (`entra-id`, `entra`, `entraid`); it logs how many. It cannot know more than that the account exists. Rerunning it changes nothing; `down` leaves the entries (an entry it added cannot be told from one written since). After it, a mover run reaches those people's Entra ID access; an HR-sync mover still skips one without an access baseline (`movers.withoutBaseline`) until a mover run (an edit's, for one) records it.
21. **Role-based rules with an empty condition group: `20261126000008-report-empty-condition-groups`.** A condition group without conditions matched everyone until now; from this release it matches nobody (`backend/src/modules/policy/policy-engine.service.ts`, `matchesConditions`), and the API refuses new ones. An active rule stored with such a group gave its access to every identity and now gives it to none, so onboarding, the mover and reconciliation can read the missing access as a removal for every identity. The migration changes nothing: it logs, per tenant, the id and name of each active rule with a group that has no conditions (`[migration] policies: tenant ... review them: <id> (<name>), ...`). Before the new worker runs, open each one on the Role-based rules page and give the group the conditions it should have, or remove the group, or deactivate the rule. Rerunning it reports again.
22. **Inbound SCIM token scopes: `20261126000009-scim-token-default-scopes`.** The SCIM endpoints now require the token's scope for the route (`Users:read` for GET on Users, `Users:write` for any other method, the same for Groups; `backend/src/modules/scim-inbound/guards/scim-auth.guard.ts`). The guard read no scopes before, so every valid token reached every route. The migration gives every stored token that holds none of those four scopes (no scopes, or only others such as `scim` or `users:read`) the default four, which keeps what it could do, and logs how many (`[migration] scim_tokens: N token(s) ...`). A token holding at least one of the four keeps its scopes: check that each IdP's token holds the scopes it needs (an IdP that only reads users with a `Users:read` token now gets 403 on writes). Rerunning it changes nothing; `down` leaves the scopes.

### Deploy

- **Deploy the API and the worker together**, with the same encryption settings. Temporal payloads are encrypted by a codec in the client and the worker; an old API also writes audit events without the `seq` the new chain needs. Deploy the frontend with them. Rolling back to a build without the codec stalls workflows that started with it: see "Temporal payload encryption" and its **Rollback** rule in section 1 (roll back only after those workflows have closed, or keep the codec). Keep `ENCRYPTION_KEY_PREVIOUS` until workflows started before a key rotation have closed.
- **Linked admin accounts of leavers.** Offboarding a person now offboards their live linked admin accounts first (patch `offboarding:linked-admin-cascade`, `backend/src/workflows/offboarding-linked-admins.ts`). The patch applies to offboarding runs started after the worker runs the new code: a run already open, or one a worker of the old build picks up, leaves the admin accounts alone. Deploy the worker before HR leavers or user deletes of people with admin accounts are processed; for a leaver offboarded before the deploy, offboard each live admin identity on its own (`DELETE /api/v1/identity/:adminId`). The new workflow code calls the new activity `getLinkedAdminIdentities` (default queue); during a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers.
- **Privileged admin accounts become just-in-time.** A linked admin account is now disabled in the target systems outside a privileged session: activation starts `privilegedSessionWorkflow` (`backend/src/workflows/privileged-session.workflow.ts`), which enables the accounts in Entra ID, AD, SCIM and Okta for the tier's `PAM_TIER*_MAX_HOURS` and disables them at expiry or on deactivation. The worker must run the new code before the API answers activations: deploy both together. The Entra ID app registration must be able to set `accountEnabled` (Microsoft Graph `User.EnableDisableAccount.All` or `User.ReadWrite.All`; for users holding privileged directory roles Entra ID can ask for more, so try one activation in a test tenant first), the AD service account needs write access to `userAccountControl` of the admin accounts, and the Okta token the user lifecycle calls (suspend, unsuspend). Not verified against live directories. New admin accounts are created disabled (patch `admin-account-provisioning:settle-standing-state` makes sure after each provisioning). Sessions that were ACTIVE in EuroID before the deploy have no running workflow: the hourly sweep ends each one at its `expiresAt` by a disable run.
- **One admin account per tier.** Onboarding now provisions every admin tier a person's policies grant, each to its own admin identity (patch `onboarding:provision-every-admin-tier`). With the default `ADMIN_UPN_PATTERN` (no `{tier}`) a person's second tier gets the UPN of the first and its admin provisioning fails with 409; the person's own accounts and the other tiers are still provisioned (patch `onboarding:admin-account-failure-not-fatal`), the failed tier goes on the person's timeline and the onboarding run ends failed (`AdminAccountFailed`). A run started before the worker runs the new code fails at that child, before the person's own targets. If your policies grant admin roles of more than one tier to one person, set `ADMIN_UPN_PATTERN` with `{tier}` (for example `adm-{firstName}.{lastName}-{tier}@{domain}`) before the deploy. Existing admin identities keep their UPN.
- **Reconciliation scan scope.** A reconciliation run whose config names `includedDepartments` or `excludedUsers` scans only those identities and leaves excluded users' orphan accounts alone (patches `reconciliation:scan-scope`, `reconcile-batch:scan-scope`). A run started before the worker runs the new code scans every identity, a scope in its config or not. The scope reaches the activities as a new argument of `getReconciliationUserCount`, `fetchHubUsersPage` and `runOrphanDetection`, which a worker of the old build ignores: replace every worker before starting a scoped run.
- **Reconciliation approval for deletes.** A reconciliation run with `requireApprovalForDeletes: true` no longer auto-corrects a group membership or license removal (disables are still corrected at once), and the orphan cleanups it starts no longer auto-delete (patches `reconcile-batch:approval-for-deletes`, `orphan-cleanup:approval-for-deletes`). A run or cleanup started before the worker runs the new code keeps the old behaviour: with `ORPHAN_AUTO_DELETE_AFTER_EXTENDED=true`, a cleanup already waiting still deletes its account after the extended grace; close its drift by hand ([Ignore], or [Delete] when the account should go) to decide now.
- **Reconciliation compares what the target account carries.** A run raises no field drift for attributes the account lookups do not return, and compares the account's enabled state with the one provisioning writes for the identity's status (`backend/src/activities/reconciliation-account-state.ts`); a leaver's account still enabled is disabled by a run that auto-corrects `STATUS_MISMATCH`, CRITICAL or not, as [Run daily reconciliation] does with its auto-correct choice left on (patch `reconcile-batch:status-containment`). The button now also scans AD and SCIM when their connectors are installed; before, it named AD `active-directory`, which reconciliation cannot read, so a tenant's first run from the button after the deploy may raise and correct AD drifts for the first time. A batch started before the worker runs the new code corrects no CRITICAL drift. The open false drifts earlier runs left are closed by migration `20261126000000-close-false-positive-drifts` (item 13 above) and by the next run; expect the first run after the deploy to disable the accounts of leavers whose accounts are still enabled in Entra ID, AD or SCIM.
- **Orphan detection.** Detection now leaves Entra ID guests (`#EXT#` UPNs) and the accounts named in `ORPHAN_EXCLUDED_ACCOUNTS` alone, and matches an account to an identity by its UPN and its mail in any case (`backend/src/modules/reconciliation/docs/ORPHAN_DETECTION.md`). Set `ORPHAN_EXCLUDED_ACCOUNTS` to your break-glass and service accounts before the first run after the deploy. An orphan cleanup now asks before it disables or deletes whether its drift is still open and the account still an orphan, and ends otherwise (new activity `confirmOrphan`, default queue; patch `orphan-cleanup:recheck-before-acting`); a cleanup already waiting asks too when it reaches its next disable or delete after the worker runs the new code. During a rolling deploy a `confirmOrphan` attempt an old worker picks up fails and is retried until a new worker answers. AD and SCIM orphans are now disabled (before, nothing changed and `disabledAt` was set anyway). Orphan drifts recorded before for such accounts stay quarantined: [Ignore] them on the Reconciliation page, which also stops their cleanup.
- **Distributed transactions.** A cancelled distributed transaction (Temporal UI or CLI) now rolls back what it committed and ends with its per-system results, `autoRollback` or not (patch `distributed-transaction:cancel-rolls-back`); a run started before the worker runs the new code keeps the old behaviour, where a cancel during the commit left the committed systems in place. A CREATE whose commit failed after the Entra ID account was made now has that account deleted by the rollback.
- **Reconciliation drift alerts.** A reconciliation run now reads `maxDriftsBeforeAlert` and `criticalDriftAlertThreshold` (patch `reconciliation:drift-threshold-alerts`) and, with `notifyOnDrift`, calls the new activity `notifyDriftThresholdExceeded` (default queue): it emits `reconciliation.drift_threshold_exceeded` and mails `notifyEmail` when SMTP is configured. During a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers. [Run daily reconciliation] sends thresholds 10 and 5 with `notifyOnDrift`, so the first run over them emits the event.
- **Onboarding with an AD target.** Onboarding now health-checks AD on its canvas node's config and leaves an AD node without a config out of the run (patch `onboarding:ad-not-configured`, `backend/src/workflows/onboarding-health-check.ts`); before, every onboarding run of a tenant with AD on the canvas failed at the health check. A run started before the worker runs the new code still checks AD without a config and fails.
- **A target that did not provision is not SYNCED.** Onboarding and admin account provisioning now leave a target ERROR, with its reason, when its provision answers that it did nothing (an AD config without host or base DN), and onboarding keeps the writeback incomplete when the write-back answers it did nothing (patches `onboarding:unprovisioned-not-synced`, `admin-account-provisioning:unprovisioned-not-synced`). A run started before the worker runs the new code marks such a target SYNCED.
- **Only a deployed pipeline provisions.** The onboarding and mover workflows now provision only while the tenant's pipeline is DEPLOYED, and onboarding reads it before the person's admin accounts (patches `onboarding:pipeline-guard-deployed`, `mover:pipeline-guard-deployed`); before, only PAUSED and STOPPED stopped them, and the admin accounts were made even then. A tenant that onboards people (an identity edit, [Provision], a new HR source) without ever having deployed its canvas must deploy it in the Design studio (impact analysis, then [Deploy]); until then those runs provision nothing and their result says the pipeline is not deployed. A run started before the worker runs the new code keeps the old guard.
- **A failed admin account no longer stops onboarding.** The new onboarding code calls the new activity `recordAdminAccountFailed` (default queue) when an admin account child fails (patch `onboarding:admin-account-failure-not-fatal`); during a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers.
- **A failed audit checkpoint export fails the run.** With `AUDIT_ARCHIVE_ENABLED=true`, an audit-archive run in which a checkpoint could not be exported to WORM storage now ends failed (`AuditArchiveExportFailed`) after exporting the others (patch `audit-archive:fail-on-export-errors`); before, it completed and the failure showed only in its result. Expect failed runs in the `audit-archive-daily` schedule's history where exports had been failing unnoticed.
- **Cold-storage archival by document id.** An archival run started after the worker runs the new code passes document ids between its activities, never the documents (patch `archival:ids-not-documents`, `backend/src/workflows/archival.workflow.ts`), and calls the new activities `findArchivalBatch` and `exportArchivalBatch` (default queue). A run already open, or one a worker of the old build picks up, keeps passing the documents. `listArchivalTenantIds`, the first activity of every archival run, was not registered on the worker, so with `ARCHIVAL_ENABLED=true` every run failed at once; it is registered now. Archival no longer skips documents inside the date range of an earlier batch: documents that were left behind that way (a tie at a batch's last timestamp, an event written late) are archived by the first run after the deploy, if the audit TTL index has not deleted them yet.
- **Archival skips a batch that is gone before its export.** When every document of a batch an archival run found was deleted before the export read it (the collection's TTL index, once archival lags), the export threw and the run failed after its retries. The export now uploads nothing and answers an empty batch, and a run started after the worker runs the new code skips it, records and counts nothing for it, and goes on with the next batch (patch `archival:empty-batch-skipped`, `backend/src/workflows/archival.workflow.ts`; fixture `backend/test/fixtures/archival-pre-empty-batch-skipped.history.json`, recorder and proof in `backend/test/workflows/archival.workflow.e2e-spec.ts`). A run already open ends that collection for the night instead of failing.
- **Bulk DISABLE and DELETE write no Golden Record.** A bulk DISABLE or DELETE now changes only the target account (patch `bulk-provisioning:no-hub-write-for-removals`, `backend/src/workflows/bulk-provisioning-operation.ts`); before, it upserted the identity from the request body, so a deleted Entra user could stay ACTIVE in the Hub, or be minted there. A bulk run started before the worker runs the new code keeps the old behaviour.
- **Onboarding needs its person.** An `onboardingWorkflow` run started without a `targetEmail` now fails at once (`OnboardingTargetRequired`, not retried; patch `onboarding:target-required`, `backend/src/workflows/onboarding-input.ts`); before, it onboarded every active identity in one run, whose activity result goes over Temporal's payload limit on a large tenant. No EuroID caller starts such a run (`OnboardingService.triggerOnboarding` needs the person); a script or Temporal schedule of your own that starts `onboardingWorkflow` with only `tenantId` must name the person. A run started before the worker runs the new code keeps the all-users path.
- **Cancelling a bulk run rolls it back.** `POST /api/v1/bulk-provisioning/cancel/:workflowId` now only signals the run, which stops before its next batch or delete, rolls back what it changed (a DELETE stays done) and ends with result status `CANCELLED` and its results (patch `bulk-provisioning:cancel-compensates`); before, the API terminated the run right after the signal, leaving an operation half done, nothing rolled back and no results. A cancel of a batch that is not running answers 409. A bulk run started before the worker runs the new code still ends FAILED without a rollback when cancelled, and is no longer terminated: it goes on to the end of its current phase.
- **Bulk DISABLE and DELETE mark the identity's entry.** At its end a bulk run now marks the provisioning entry of each account its DISABLE and DELETE operations removed (and did not roll back) DEPROVISIONED, the identity found by the operation's source key, else its email; nothing is created (patch `bulk-provisioning:mark-removed-accounts`, new activity `markRemovedAccounts` on the default queue, `backend/src/activities/bulk-provisioning-removals.ts`). Before, the entry stayed SYNCED until reconciliation found the drift, so offboarding and the mover took the account for active. During a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers. A bulk run started before the worker runs the new code leaves the entries as they are.
- **An identity edit during a mover run is queued, not dropped.** An edit (`PATCH /api/v1/identity/:id`, a control, SCIM) that meets the identity's open mover run is now queued on it (signal `reevaluate`), and the run, once it has recorded its outcome, continues as new with the queued edits (patch `mover:reevaluate-queued-edit`, `backend/src/workflows/mover-reevaluation.ts`); before, the edit's access change waited for the next HR sync. Before it signals, the API asks the open run the query `acceptsQueuedEdits` (patch `mover:queued-edit-query`), which only runs started by the new worker answer: an open run started earlier, or one a worker of the old build handles during a rolling deploy, gets no signal, and the API starts the edit's own run once that run has ended (it waits in the background; if the API restarts before then, the warning `Mover edit for identity <id> waits for <workflowId> to end` in its log names the identity to re-evaluate with `POST /api/v1/identity/:id/access/re-evaluate`). The answer is `queued: true` in both cases. `PATCH /api/v1/identity/:id` now asks the mover itself for an edit that moves a trigger attribute and reports the run, or the queued change, in `workflow` (see API_CHANGELOG).
- **An expiring access request is EXPIRED only once its access is removed.** At a time-bound request's end date the approval workflow now tries a failed revoke again (after 5 minutes, then twice as long each time up to 6 hours) until it succeeds, and marks the request `EXPIRED` only then (patch `access-request-approval:revoke-until-done`); the request stays `ACTIVE` meanwhile. Before, a revoke that failed (Entra ID down at that moment) was ignored, the request was marked `EXPIRED` and the person kept the access. A run that reaches its end date after the worker runs the new code gets this, also one started before the deploy; a run that ended before keeps its `EXPIRED`. This release does not look for requests marked `EXPIRED` earlier whose revoke had failed; the worker log of such a run says `entitlements revoked; failed: entra-id`.
- **An admin can close an access request whose removal keeps failing.** At the end date the approval workflow's retries of a refused removal now also end when a policy-admin closes the request as removed by hand (`POST /api/v1/access-requests/:id/removed-manually`, the REMOVED_MANUALLY signal), and the run continues as new after 20 retries, so its history stays small (patch `access-request-approval:revoke-closable-continue-as-new`, `backend/src/workflows/access-request-revoke-retry.ts`). A run that was already retrying when the worker starts the new code takes it at its next retry (at most 6 hours later). Deploy the API and the worker together: a worker of the old build ignores the signal, so the request is closed but the old run keeps retrying the removal.
- **A manager's request for a report can be approved.** A new access request stores a step whose approver is the requester as approved by the request (a manager requesting for their report is the MANAGER step's approver), and the approval workflow skips such a step (patch `access-request-approval:skip-steps-approved-at-creation`). A request created by the new API and picked up by a worker of the old build waits for that step and times out `REJECTED`, as such requests always did; deploy the worker with the API.
- **Risk scores per tenant.** The nightly `riskScoreCalculationWorkflow` now lists the tenants (new activity `listRiskScoreTenants`) and scores each in its own activity (`runRiskScoreTenant`, default queue; 2 hours per attempt, heartbeat every identity, 5 attempts, a retry resumes from the last heartbeat), continuing as new after 50 tenants (patch `risk-score-calculation:per-tenant`, `backend/src/workflows/risk-score-calculation.workflow.ts`); before, one 30-minute activity scored every tenant and kept nothing when it timed out. A run started before the worker runs the new code keeps the single activity, which stays registered. During a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers.
- **Orphan detection page by page.** The daily reconciliation now runs `runOrphanDetection` under its own activity options, 2 hours per attempt with a 2-minute heartbeat timeout (the activity heartbeats after each page of accounts and every 30 seconds while it runs, so a long AD or SCIM listing in one call does not time out, and asks the hub once per page), and names a system whose detection failed in the run's report (`orphanDetectionFailures`) (patch `reconciliation:orphan-detection-heartbeat`); before, it had the run's 5 minutes and no heartbeat, and a failure was only logged. A run started before the worker runs the new code keeps the 5 minutes. The API needs no change; deploy the worker with it.
- **Orphan delete per system.** A SCIM orphan is now deleted (`DELETE /Users/{id}`) by [Delete] and by `ORPHAN_AUTO_DELETE_AFTER_EXTENDED`; before, only Entra ID orphans were. An Active Directory orphan is never deleted by EuroID: `POST /api/v1/reconciliation/orphans/:driftId/signal` with `DELETE` answers 422 for it, and a cleanup that would auto-delete it records the reason on the drift (`orphanDetails.keptReason`) through the new activity `keepOrphanAccount` (default queue) and leaves the account disabled and quarantined (patch `orphan-cleanup:ad-never-deleted`). A cleanup started before the worker runs the new code tries the AD delete, which the new activity refuses. During a rolling deploy an attempt an old worker picks up fails and is retried until a new worker answers. Check `ORPHAN_AUTO_DELETE_AFTER_EXTENDED`: with `true`, SCIM orphans past their extended grace are now deleted.
- **A distributed-transaction CREATE never takes over an account.** Its prepare now resolves the account's UPN and refuses the transaction when an Entra ID account already has that UPN, the email or the employee id; its commit only creates (`EntraService.createAccount`), and its rollback deletes only the account the commit created (`backend/src/activities/distributed-transaction-entra.ts`). No workflow patch: the workflow is unchanged. A CREATE prepared by the old build and committed by a new worker is not committed (`FAILED`, nothing created; start it again), and one committed by the old build without `createdAccountId` and rolled back by a new worker is `ROLLBACK_FAILED` with nothing deleted: check Entra ID for its account.
- **A SCIM or Entra ID orphan is deleted by the id its drift holds.** The orphan cleanup now passes the drift's `externalId` to `deleteOrphanAccount` (patch `orphan-cleanup:delete-by-external-id`, `backend/src/workflows/orphan-cleanup.workflow.ts`). A SCIM orphan is deleted by that SCIM id; before, it was found by its userName or email only, so a SCIM user without such a match was never deleted. An Entra ID orphan is deleted by that object id; before, by its UPN or mail, so an account renamed after detection was not found, and a UPN another account took over named that account. A cleanup started before the worker runs the new code still deletes by the userName, UPN or email. The activity takes the new argument as optional, so a delete an old worker picks up during a rolling deploy runs as before.
- **Encryption.** The API and the worker refuse to start with `ENCRYPTION_KEY_PREVIOUS` set and `ENCRYPTION_KEY_ID` unset or `default` (`backend/src/infrastructure/secrets/encryption.service.ts:42-48`).
- **New optional environment variables** (defaults in brackets):

| Variable | Default | Read in |
|----------|---------|---------|
| `OUTBOX_CLAIM_TIMEOUT_MS` | 300000 | `backend/src/infrastructure/config/events.config.ts:15` |
| `OUTBOX_SWEEP_INTERVAL_MS` | 15000 | `backend/src/infrastructure/config/events.config.ts` |
| `OUTBOX_RETRY_BASE_MS` | 5000 | `backend/src/infrastructure/config/events.config.ts` |
| `HR_START_TIMEOUT_MS` | 10000 | `backend/src/infrastructure/config/defaults.ts:46` |
| `HR_START_CLAIM_TIMEOUT_MS` | 600000 | `backend/src/infrastructure/config/defaults.ts:53` |
| `AUDIT_CHAIN_WRITE_ATTEMPTS` | 50 | `backend/src/modules/audit/audit-chain-writer.ts:22` |
| `AUDIT_CHECKPOINT_MAX_EVENTS` | 10000 | `backend/src/modules/audit/audit-merkle.service.ts:28` |
| `AUDIT_CHECKPOINT_MAX_PER_RUN` | 50 | `backend/src/modules/audit/audit-merkle.service.ts:30` |
| `CREDENTIAL_INVENTORY_REFRESH_LIMIT` (worker) | 500 accounts per tenant per run | `backend/src/infrastructure/config/defaults.ts:84` |
| `NEO4J_RECONNECT_INTERVAL_MS` | 30000 | `backend/src/infrastructure/graph/graph.service.ts:53` |
| `HEALTH_CONNECTOR_CACHE_MS` (API) | 15000 | `backend/src/infrastructure/health/health.service.ts` |
| `NHI_SIGNING_PRIVATE_KEY` (API) | none | `backend/src/modules/nhi/nhi-credential.service.ts:111` |
| `NHI_TRUST_DOMAIN` | `euroid.local` | `backend/src/modules/nhi/nhi-credential.service.ts:110` |
| `ADMIN_UPN_MAX_SUFFIX` | 20 | `backend/src/infrastructure/config/pam.config.ts:30` |
| `PAM_ACTIVATION_WAIT_MS` (API) | 15000 | `backend/src/infrastructure/config/pam.config.ts:31` |
| `PAM_STANDING_STATE_SWEEP_LIMIT` (worker) | 50 disable runs per tenant per hourly sweep | `backend/src/infrastructure/config/pam.config.ts:37` |
| `PAM_ACTIVATION_PENDING_ALERT_DAYS` (worker) | 7 days an Okta admin account may wait for its owner's activation before the hourly sweep raises `admin_account.activation_pending`, once | `backend/src/infrastructure/config/pam.config.ts:38` |
| `TEMPORAL_RECONNECT_MIN_MS` (API) | 1000 | `backend/src/infrastructure/config/temporal.config.ts` (`temporalReconnectDelays`) |
| `TEMPORAL_RECONNECT_MAX_MS` (API) | 30000 | `backend/src/infrastructure/config/temporal.config.ts` (`temporalReconnectDelays`) |
| `TRUST_PROXY` (API) | 1 (one reverse proxy) | `backend/src/infrastructure/config/trust-proxy.ts` (`trustProxySetting`) |
| `SAML_VALIDATE_IN_RESPONSE_TO` (API) | `always` | `backend/src/modules/auth/saml-auth.service.ts:130` |
| `SAML_JIT_MAX_ROLE` (API) | `viewer`: the strongest role a JIT-created SAML admin gets; `super-admin` is refused | `backend/src/modules/auth/saml-jit-policy.ts` (`samlJitConfig`) |
| `SAML_ALLOWED_TENANT_IDS` (API) | none: only the default tenant; comma-separated tenant ids an assertion may name | `backend/src/modules/auth/saml-jit-policy.ts` (`samlJitConfig`) |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` (API) | 10 | `backend/src/infrastructure/config/auth.config.ts:41` |
| `LOGIN_LOCKOUT_MINUTES` (API) | 15 | `backend/src/infrastructure/config/auth.config.ts:42` |
| `REALTIME_SESSION_RECHECK_MS` (API) | 60000 | `backend/src/infrastructure/realtime/events.gateway.ts:56` |
| `TENANT_STATUS_CACHE_MS` (API) | 30000 | `backend/src/infrastructure/multi-tenancy/tenant-status.service.ts:33` |
| `ACCESS_REVIEW_ACTIVATION_CLAIM_MS` (API, worker) | 3600000 (1 hour) | `backend/src/infrastructure/config/access-review.config.ts` (`activationClaimMs`) |
| `RECONCILIATION_PAGE_SIZE` (worker) | 200 identities per page, at most 5000 | `backend/src/activities/reconciliation.activities.ts` (`reconciliationPageSize`) |
| `ORPHAN_EXCLUDED_ACCOUNTS` (API, worker) | none: UPNs or mails orphan detection never quarantines, comma-separated, `*` any text | `backend/src/infrastructure/config/orphan.config.ts` |
| `AUDIT_ANCHOR_WITNESS_TIMEOUT_MS` (API, worker) | 10000 | `backend/src/modules/audit/audit-anchor.service.ts` (`witnessTimeoutMs`) |

- `ADMIN_UPN_PATTERN` accepts `{tier}` (`t0`, `t1`, `t2`). The default `adm-{firstName}.{lastName}@{domain}` has none, so a person can have one admin account only: creating their second tier answers 409 naming the variable. To allow one per tier, set e.g. `adm-{firstName}.{lastName}-{tier}@{domain}`; existing admin identities keep their UPN, only new ones follow the new pattern. `ADMIN_UPN_MAX_SUFFIX` bounds the numeric suffix a namesake's admin UPN gets.
- `NHI_SIGNING_PRIVATE_KEY` is an Ed25519 PEM key. Without it the NHI page disables issuing credentials.
- The API connects to Temporal over mTLS when all three `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH` and `TEMPORAL_TLS_CA_PATH` files exist (`backend/src/infrastructure/config/temporal.config.ts:29-38`), as the worker already did.
- Audit checkpoints and the daily `audit-archive-daily` schedule exist only where `AUDIT_ARCHIVE_ENABLED=true`. A worker started with `AUDIT_ARCHIVE_ENABLED` off pauses an existing `audit-archive-daily` schedule, and one started with `ARCHIVAL_ENABLED` off or no `ARCHIVAL_STORAGE_PROVIDER` pauses `archival-nightly` (note `Paused by the EuroID worker: ...`); a later start with the job on resumes it. Before, turning a job off left its schedule running. A schedule paused by hand stays paused. With the archive enabled and no `AUDIT_ARCHIVE_S3_BUCKET`, the API and the worker refuse to start (`backend/src/modules/audit/audit-archive-storage.factory.ts:20-22`). The first daily run also makes checkpoints over each tenant's audit events from before the chain and uploads them: expect a backlog upload.
- Each audit write now reads and updates the tenant's chain head (`audit_chain_heads`). Mongoose also builds, at start, partial unique indexes on `audit_events {tenantId, eventId}` and `user_events {tenantId, eventId, type}`, a unique index on `webhook_delivery_attempts {subscriptionId, eventId}` (migration `20261125000002-webhook-delivery-unique-per-event` replaces the non-unique one first), and indexes on `review_exclusions`.
- **Neo4j** (optional): set `NEO4J_URL`, `NEO4J_USER` and `NEO4J_PASSWORD` the same for the API and the worker, and restart both after Neo4j is up. Both reconnect on their own afterwards, and `GET /api/v1/health/ready` reports `components.graph` as `not-connected` (overall `degraded`, HTTP 200) while it is lost.

### After the deploy

1. **Resync the access graph, once per tenant whose graph was loaded.** As a super-admin of that tenant, call `POST /api/v1/access-explorer/resync` (or use the button on the access explorer page); it is synchronous and loads the caller's tenant. Rule-given and provisioned access now sits on the catalog's node, and every entitlement node is keyed by its system and native id (`<system>::<native id>`, `backend/src/modules/access-explorer/entitlement-node-id.ts`), so one native id in two systems (`admin`, a numeric group id) is two entitlements instead of one with the holders of both. Until the resync the graph holds the nodes keyed by native id alone next to the ones events write with the new key, and the explorer answers from both; the resync removes the old ones. The explorer API now takes an entitlement as that key: a link or bookmark with a bare native id answers 400. Identities deleted before the release leave the graph only through this resync. The API and the worker create uniqueness constraints on `(tenantId, id)` for the Identity, Entitlement and Application nodes at each connection; if the log says "Could not create the uniqueness constraint", resync each tenant it names (the resync removes duplicate nodes).
2. **Rebuild the stored peer groups.** Until then baselines are rule-only. The nightly `intelligence-batch-daily` schedule does it, or trigger it now: `temporal schedule trigger --schedule-id intelligence-batch-daily --namespace <TEMPORAL_NAMESPACE>`.
3. **Expect first runs of the scheduled jobs.** The worker creates its schedules at start, and from this release updates the ones that exist (spec from the cron variables, action args encoded under the current key; `backend/src/worker.ts:241-336`, `backend/src/infrastructure/temporal/schedule-upsert.ts`): the log names each schedule `created` or `updated`, and a cron variable changed since a schedule was created applies now. `recertification-scheduler-daily`, `intelligence-batch-daily` and `credential-rotation-nightly` are always created; `audit-archive-daily` only with `AUDIT_ARCHIVE_ENABLED=true`. The nightly credential run now runs for every active tenant, fills `credential_inventory` from Entra ID and AD, resets no password, and writes `credential.expiring_soon` and `credential.inventory_updated` events to the audit log. Intelligence views show data only after the first `intelligence-batch-daily` run.
4. **Expect the existing admin accounts to be disabled.** Admin accounts provisioned before this release are enabled in the target systems, and EuroID does not know their state (`pamTargetState` unset). From the first hourly expiry sweep after the deploy (`entitlement-expiry-hourly`, at the full hour), the worker starts a disable-only `privilegedSessionWorkflow` run for each live admin identity whose state is not `disabled` and that has no open session, at most `PAM_STANDING_STATE_SWEEP_LIMIT` (default 50) per tenant per hour; a tenant with 200 admin accounts is done after four sweeps. Progress: the worker logs `[ExpiryCheck] Started <n> PAM disable runs for admin accounts of unknown state in tenant <t>` and `[PAM] Standing state: started <n> disable runs in <t>, <m> left for the next sweep`; the Temporal UI lists the runs (`WorkflowType = 'privilegedSessionWorkflow'`); in MongoDB, `db.identities.countDocuments({ tenantId: '<t>', parentIdentityId: { $ne: null }, deletedAt: null, pamTargetState: { $ne: 'disabled' } })` counts what is left (an account whose disable failed keeps `enabled` and its entry shows `disableError`; the sweep retries it every hour). To start the sweep now: `temporal schedule trigger --schedule-id entitlement-expiry-hourly --namespace <TEMPORAL_NAMESPACE>`.
5. **Check the Temporal UI and logs.** Payloads show as `binary/encrypted`. To read one, export the history and decode it with `npx ts-node -r tsconfig-paths/register src/scripts/decode-temporal-payloads.ts history.json` from `backend/`.
6. **Decide what happens to old Temporal histories that hold national IDs.** Migration `20261125000000-strip-raw-national-id` cleans MongoDB only. Onboarding and mover runs from before this release recorded the identity's whole profile, `customAttributes` with the national ID included, in activity results (`getIdentityByEmail`, `backend/src/activities/identity.activities.ts`), and bulk provisioning runs recorded their users as sent, a `hetu` included. Histories from before the payload codec hold them in plaintext, later ones encrypted (readable with the worker's key through `decode-temporal-payloads.ts`). A closed history stays until the namespace retention removes it. The commands below use the flags of the Temporal CLI in the `temporalio/admin-tools` image `docker-compose.yml` pins; add `--address` and your TLS or API key flags as for any other `temporal` command.
   - **Wait for the retention.** `temporal operator namespace describe --namespace <TEMPORAL_NAMESPACE>` shows it. Closed histories older than it are already gone, and the others go when it passes. `temporal operator namespace update --namespace <TEMPORAL_NAMESPACE> --retention <duration>` shortens it, for every workflow closed from then on as well.
   - **Delete them now.** Count what a filter selects, then delete it (a batch job on the server; `--rps` limits its rate):

     ```bash
     Q="ExecutionStatus != 'Running' AND CloseTime < '<deploy time, RFC 3339>' AND WorkflowType IN ('onboardingWorkflow', 'moverWorkflow', 'bulkProvisioningWorkflow')"
     temporal workflow count --namespace <TEMPORAL_NAMESPACE> --query "$Q"
     temporal workflow delete --namespace <TEMPORAL_NAMESPACE> --query "$Q" --reason "national IDs in histories from before the 2026-11-25 release" --yes
     ```

     Leave out the `WorkflowType` clause to delete every closed history from before the deploy. Keep `ExecutionStatus != 'Running'`: `temporal workflow delete` terminates a running execution it matches.
   - **What deleting loses.** It cannot be undone. The deleted runs no longer show in the Temporal UI or in `temporal workflow show`: their inputs, activity results and timeline are gone for audit and debugging, and `GET /api/v1/bulk-provisioning/status/:workflowId`, `results/:workflowId` and the other routes that read a run from Temporal answer 404 for them. EuroID's own records in MongoDB stay (the audit log, the identity timeline, offboarding records). A backup of the Temporal database taken earlier still holds the histories (Backup & Restore, Temporal).

7. **Rotate webhook tokens that were in a URL.** Until this release the `webhook.subscription_created` event carried the subscription's full URL, so every signed-in user of the tenant could receive it on the websocket and read it in the audit log (`GET /api/v1/audit`, viewer). Audit entries written before keep it (the log is hash-chained and not rewritten). For each webhook subscription whose URL holds a token (in the path, the query or the user info), rotate the token at the receiver and save the new URL in Admin > Webhooks. The event now carries `webhookHost` only (`backend/src/modules/event-subscriptions/event-subscription.service.ts`).

8. **Rebuild the Elasticsearch audit index (only where Elasticsearch is reachable at `ELASTICSEARCH_NODE`; `GET /api/v1/analytics/v2/status` says `elasticsearch: true`).** Live indexing stored each domain event under its request's correlation id, so events of one request overwrote one another; they now get their own id. The documents indexed before stay under the old ids. Delete the index (`<ELASTICSEARCH_INDEX_PREFIX>-audit-events`, default `euroid-audit-events`) and, as a super-admin of each tenant, call `POST /api/v1/analytics/v2/backfill`, which indexes the tenant's audit log again under the new ids.

9. **Run Entra ID discovery once per tenant with an Entra ID connector.** The license forecast (Analytics, `GET /api/v1/analytics/license-forecast`) now counts from the units Entra ID reports in use and enabled, which discovery stores on each license's catalog entry; until it runs, every license shows its consumption as unknown, and the impact analysis's Entra ID tab shows no units left. Run it from the connector's Discovered Groups & Licenses tab (`POST /api/v1/connectors/entra-id/discover`), or wait for the scheduled discovery where `syncIntervalHours` is set.
10. **Expect 409 for a Design studio save over someone else's.** The studio sends the canvas revision it loaded; a save after another admin's save answers 409 and the studio asks to reload. A browser tab opened before the deploy runs the old studio, whose saves carry no revision and are still stored, unchecked (audit `revisionChecked: false`): ask admins to reload the Design studio after the deploy.

### What clients and admins will notice

- **Okta admin accounts waiting for activation get no hourly disable run.** An Okta linked admin account whose owner has not finished the activation Okta emailed stays `PROVISIONED`, and the hourly PAM sweep started a disable-only run for it every hour, each failing with the same 422. The sweep now reads the account's Okta status first and starts a run only when the last disable failed in Okta alone and the account is no longer `PROVISIONED` or `STAGED` (it cannot sign in before). The entry keeps `pamTargetState: enabled` and its `disableError`, so the next sweep reads it again. After `PAM_ACTIVATION_PENDING_ALERT_DAYS` (default 7) of waiting, one event `admin_account.activation_pending` (audited, webhook-subscribable) asks a person to finish or remove the account (`backend/src/modules/privileged-access/pam-okta-activation.ts`).
- **Access requests change the entitlement only.** Fulfilling an access request and removing its access at its end date now add or remove only the group membership, directory role or license, on the Entra ID account recorded for the person (`backend/src/activities/entra-entitlement-changes.ts`). Before, both PATCHed the person's attributes from a profile built by hand and created an account when no object id was recorded. A request for a person without a recorded Entra ID account looks the account up read-only by the person's UPN, email and employee id (accounts made by bulk provisioning have no recorded object id) and records the one match for the person; with no match, or several, it ends `REJECTED` with the reason on its page: onboard the person first, or link the right account. A bulk CREATE or UPDATE now records the object id of the account it provisioned. A removal Entra ID refuses keeps the request `ACTIVE` with the reason ("Access not removed yet") and raises `provisioning.failed` once: remove the access in Entra ID or fix the cause (for example the app's permission on a role-assignable group), and the next attempt, at most 6 hours later, ends the request `EXPIRED`. When EuroID cannot remove it at all, a policy-admin removes the access in Entra ID and clicks [Mark removed manually] on the request page (with a note): the request ends `EXPIRED`, recorded with their name as removed by hand, and the retries stop. Policy-admins can now open any access request of their tenant.
- **Max Identities is enforced.** A tenant's `settings.maxIdentities` (Admin > Tenants > Edit, Max Identities) was stored and never read; the console said so. Now no identity is created past it: `POST /api/v1/identity` answers 409 naming the limit, SCIM `POST /scim/v2/Users` answers SCIM 409, bulk and batch rows fail with the message, and the HR sync holds the rows of new people (`rowsHeldForIdentityLimit`, logged) until a sync after the limit is raised. Updates, rehires and correlations onto existing identities are never refused, and live identities (not soft-deleted) count, linked admin accounts included. Before the deploy, check each tenant's limit against its live identity count (`db.identities.countDocuments({ tenantId: '<id>', deletedAt: null })`) and raise or clear (empty field) a limit that is already reached, or new hires stop at the next HR sync. Creates running at the same moment can still pass the limit slightly; each overshoot raises one `tenant.identity_limit_exceeded` event (`{ limit, count }`) in the audit log and to webhooks, checked after each new identity and in the hourly expiry sweep.
- Admin > SCIM shows the SCIM base URL as the console's own origin plus `/scim/v2/` (it showed the placeholder `https://your-euroid-domain/scim/v2/` with the relative `API_BASE` every deployment uses). The SCIM routes sit outside the `/api` prefix, so the reverse proxy must route `/scim/v2/` to `euro-api` like `/api` for that URL to work; the dev server proxies `/scim` (`frontend/vite.config.ts`).
- `PATCH /api/v1/identity/:id` answers 409 for fields an HR source masters (`HrMasteredFieldsException`, `backend/src/modules/identity/hr-mastered-fields.exception.ts`); override them through the controls route with a reason and an expiry. SCIM inbound answers 400 with `scimType` `mutability` for the same changes (`backend/src/modules/scim-inbound/scim-users.controller.ts:129`): tell your SCIM clients.
- An installed Okta config without org URL or API token answers 400 "Okta config is incomplete" (`backend/src/modules/connectors/okta-connector/okta.service.ts:160-166`).
- `POST /api/v1/reconciliation/start-daily` answers 400 for a body with `cronSchedule` or `enabled: false` (runs start on request; no scheduled reconciliation exists): a script or client that sends them must leave them out. It honours `includedDepartments` and `excludedUsers`, and refuses an `excludedUsers` entry that is neither an identity id nor an email address (400). It answers 400 for a body with `notifySlack` (no Slack sender exists; subscribe a webhook to `reconciliation.drift_threshold_exceeded`), and the run now acts on `requireApprovalForDeletes`, the drift thresholds, `notifyOnDrift` and `notifyEmail` (`backend/src/modules/reconciliation/docs/ARCHITECTURE.md`, Run Settings).
- Drift `correct` and `ignore` answer 409 for a corrected or ignored drift (`backend/src/modules/reconciliation/reconciliation.controller.ts:394-402`).
- `PUT /api/v1/privileged-access/admin-accounts/:adminId/activate` answers 404 for a deleted admin identity and 409 when its parent identity is deleted; `GET /api/v1/privileged-access/admin-accounts` leaves deleted admin identities out and adds `parentDeleted`.
- The tenant plugin stamps `tenantId` on top-level documents only; documents written before keep it inside their subdocuments, and a client that sends such an object back must leave the key out.
- `GET /api/v1/identity` takes `q` and `includeDeleted` (the latter needs the operator role, `backend/src/modules/identity/identity.controller.ts:185-198`). `POST /api/v1/reconciliation/user/:userId` takes an ObjectId only (`reconciliation.controller.ts:182`).
- New routes: `POST /api/v1/audit/merkle-roots` (super-admin), `GET /api/v1/credential-lifecycle/inventory`, `POST /api/v1/nhi/credentials/verify`, `GET /api/v1/nhi/_/public-key`, `POST /api/v1/access-explorer/resync`. `GET /api/v1/audit/verify-integrity` and `POST /api/v1/audit/verify` gain fields; their entries in the changelog list them.
- Every access explorer route answers 503 with a message when Neo4j is not configured or a query fails (it answered empty data before).
- Only four routes accept an MFA enrollment token: `GET /auth/me`, `GET /auth/mfa/status`, `POST /auth/mfa/setup` and `POST /auth/mfa/verify-setup` (`backend/src/infrastructure/auth/mfa-enrollment-scope.guard.ts:4-7`).
- `POST /api/v1/access-reviews/campaigns/:id/cancel` takes a reason (`backend/src/modules/access-review/access-review.controller.ts:84-100`); cancelling a recurring campaign ends the recurrence.
- `OPA_FALLBACK_ON_ERROR=false` now throws on a failed OPA query instead of returning null (`backend/src/infrastructure/opa/opa-client.service.ts:91-93`).
- Removed event types: `credential.rotated` and `credential.rotation_failed` (`backend/src/infrastructure/events/event-types.ts:232`). Subscriptions that name them stay valid and receive nothing.
- Identity reads no longer return the national ID in `sources[].rawData` or `profile.customAttributes` (the tenant's Hashed National ID field and `hetu`, also for tenants without the rule; `backend/src/modules/identity/national-id.ts`). A policy condition or a target mapping that read `customAttributes.hetu` finds nothing.
- `POST /api/v1/blueprints/save` answers 400 for a correlation config with a Hashed National ID rule while the server has no usable `CORRELATION_HMAC_SECRET` (`backend/src/modules/blueprints/dtos/blueprint-validation.ts`). A tenant that has such a rule stored cannot save its canvas until the secret is set or the rule removed.
- Offboarding results (`GET /api/v1/leavers/batches`, `GET /api/v1/leavers/open-offboardings`, the `identity.offboarding_completed` event) carry `linkedAdmins` when the person had linked admin accounts; an admin account whose offboarding failed leaves the person suspended, and the Failed offboardings tab lists that person too. Close the admin account's failed target on its own row, then offboard the person again.
- `GET /api/v1/health/ready` (public) answers `components.connectors` as counts, `{ ok, stale, unknown, checkedAt }`, instead of an object keyed by connector name with each connector's `lastSync`: an unauthenticated caller learned which connectors every tenant installed and when they last synced. A monitor that read a connector by name must read the counts (`stale > 0` still makes the probe `degraded`), or a tenant's own state through `GET /api/v1/reconciliation/connector-health`. The counts are cached for `HEALTH_CONNECTOR_CACHE_MS` and include the connectors of a tenant without a `tenants` document; while MongoDB is down the probe answers its 503 at once with `checkedAt: null`.
- `PUT /api/v1/privileged-access/admin-accounts/:adminId/deactivate` no longer marks the admin identity's provisioning entries `DEPROVISIONED` (it never removed anything in a target system). A deleted admin identity no longer adds to its person's risk score.

---

## Health Monitoring

### Endpoints

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET /api/v1/health` | API health check | No |
| `GET /metrics` | Prometheus scrape | Optional (`METRICS_TOKEN`) |
| `GET /api/docs` | Swagger UI | No |

### Container Health

The API container has a built-in healthcheck:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD curl -sf http://localhost:3001/api/v1/health || exit 1
```

The worker has no HTTP healthcheck — Temporal manages worker liveness via heartbeats.

The frontend nginx serves `/health` returning `200 ok`.

### Observability

| Signal | Tool | Config |
|--------|------|--------|
| Logs | Winston (JSON in production) | `LOG_PII_REDACT=true` for PII redaction |
| Metrics | Prometheus via `prom-client` | Scrape `GET /metrics` |
| Traces | OpenTelemetry → OTLP | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` |

Set `OTEL_SDK_DISABLED=true` if no trace collector is available.

Full details: `docs/architecture/infrastructure/OBSERVABILITY_ARCHITECTURE.md`

---

## CI/CD

The repository has no CI pipeline (`.github/` holds CODEOWNERS, Dependabot, issue and pull request templates and `SECURITY.md`, no workflows). The gates are the Husky hooks in `.husky/`:

| Hook | What it runs |
|------|--------------|
| `pre-commit` | `npx lint-staged` |
| `commit-msg` | `commitlint` (conventional commits) |
| `pre-push` | In `backend/`: `npm run typecheck`, `npm test`, then `TEMPORAL_E2E=1 npm run test:e2e` (the workflow e2e suite) |

Build the images and scan them in your own pipeline before deploying.

---

## Backup & Restore

### MongoDB

```bash
# Backup
mongodump --uri="mongodb://..." --archive=euroid-backup-$(date +%Y%m%d).archive --gzip

# Restore
mongorestore --uri="mongodb://..." --archive=euroid-backup-20260222.archive --gzip
```

### Temporal

Temporal persists workflow state in its own Postgres database. Back up `temporal-db` using standard Postgres tools:

```bash
pg_dump -h <host> -U temporal temporal > temporal-backup.sql
```

Workflow payloads in that database are encrypted (§ 1, Temporal payload encryption): a restore is readable only with the `ENCRYPTION_KEY` and key ids that were in use when its workflows ran, so keep those with the backup's retention.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| API returns 503 | MongoDB or Temporal not reachable | Check `docker compose logs euro-api` for connection errors |
| Worker not processing workflows | Worker can't connect to Temporal | Verify `TEMPORAL_ADDRESS`. Check `docker compose logs euro-worker` |
| Frontend blank page | API unreachable or CORS mismatch | Check browser console. Verify `CORS_ORIGINS` includes frontend URL |
| Auth redirect loop | OIDC misconfiguration | Verify `OIDC_ISSUER` and `OIDC_AUDIENCE` match IdP. Check `AUTH_DISABLED` is `false` |
| Encryption errors on start | Missing or invalid `ENCRYPTION_KEY` | Generate a fresh 32-byte base64 key. See Secrets section above |
| A connector route or job answers 503 "could not be decrypted by this process" | This API or worker process lacks the key the connector config was saved with (another `ENCRYPTION_KEY`, or a key id missing from `ENCRYPTION_KEY_ID` / `ENCRYPTION_KEY_PREVIOUS_ID`) | Give every API and worker process the same key settings; the stored config is unchanged. If that key is lost, install the connector again with its full config. See `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` |
| Onboarding, offboarding, reconciliation or a review does not start; the API log shows Temporal refusing the start over the search attribute `TenantId` | `TenantId` is not registered on this Temporal server, in the namespace `TEMPORAL_NAMESPACE` (default `default`) | With Compose: `docker compose logs temporal-init` says why it did not register it. Elsewhere: register it, Production Checklist § 4, "The `TenantId` search attribute" |
| Temporal "namespace not found" | Temporal auto-setup not complete | Wait 30s after `docker compose up`. Check `docker compose logs temporal` |
| High memory usage in worker | Large workflow history | Check Temporal UI for stuck workflows. Consider increasing `workerIdleMemoryLimit` |

---

## Security Hardening

For production deployments, also review:

- **Platform Auth:** `docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md`
- **Data Retention:** `docs/architecture/security/DATA_RETENTION.md`
- **Secrets Management:** `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md`
- **Security Rules:** `skills/software-security/SKILL.md` (CodeGuard rules)

Key hardening steps:
1. Set `AUTH_DISABLED=false` (never ship with auth disabled)
2. Set `ENCRYPTION_KEY` (never use passphrase fallback in production)
3. Set `LOG_PII_REDACT=true` (default — redacts PII from logs)
4. Set `METRICS_TOKEN` if metrics endpoint is exposed
5. Configure `CSP_REPORT_ONLY` / `CSP_REPORT_URI` for Content Security Policy monitoring
6. Use TLS for all external connections (MongoDB, Temporal, OIDC)
