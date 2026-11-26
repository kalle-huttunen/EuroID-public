# Getting Started

> From `git clone` to running the full stack locally in under 10 minutes.

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| **Node.js** | 20.x (LTS) | `node -v` |
| **npm** | 10.x+ | `npm -v` |
| **Docker** + **Docker Compose** | Latest | `docker compose version` |
| **Git** | Latest | `git --version` |

Optional (for standalone Temporal dev server):
- `temporal` CLI — `brew install temporal` / `npm install -g @temporalio/cli`

---

## 1. Clone and Install

```bash
git clone <repo-url> EuroID
cd EuroID

# Install root dev dependencies (husky, lint-staged, prettier) and the git hooks
npm install

# Install backend + frontend
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

The root `npm install` runs `scripts/setup-git-hooks.sh` (the `prepare` script). It generates the husky hooks in `.husky/_` of the main checkout and sets `core.hooksPath` in `.git/config` to the absolute path of that directory, so the main checkout and every `git worktree add` checkout run the same `commit-msg`, `pre-commit` and `pre-push` hooks. A worktree needs its own `node_modules` (root, `backend/`, `frontend/`) for the hooks to find their tools. After moving the main checkout, run `npm run prepare` in its root again.

The `pre-push` hook is the test gate (there is no CI): it runs the backend type-check (`npm run typecheck` in `backend/`; jest compiles the tests without type-checking), the backend unit and integration tests (`npm test`), then the Temporal workflow e2e suite (`TEMPORAL_E2E=1 npm run test:e2e`), which includes the joiner, mover and leaver story (`backend/test/workflows/jml-end-to-end.workflow.e2e-spec.ts`). Any of them failing refuses the push. The hook tests the working tree, so push from a clean tree. The e2e suite needs no Docker, MongoDB or Temporal server of your own: it starts in-memory MongoDB (the binary `npm install` puts in `backend/node_modules/.cache/mongodb-memory-server`) and Temporal's time-skipping test server. That server binary (about 86 MB) is downloaded on the first e2e run, from `https://temporal.download` (the archive is the Temporal Java SDK's test server release), into `backend/node_modules/.cache/temporal-test-server`, and reused from there for 365 days or until the Temporal SDK version changes. So a fresh clone or a new worktree without that directory needs the network for its first push (or first `TEMPORAL_E2E=1` run); offline, the e2e suites fail at once with `Failed to start ephemeral server: error sending request for url (https://temporal.download/...)` and the push is refused. With the binary cached, the suite runs offline. Copying `backend/node_modules` with `cp -a` copies the cache along.

---

## 2. Start Infrastructure (Docker Compose)

The quickest way to get MongoDB + Temporal running:

```bash
docker compose up euro-mongo temporal temporal-db temporal-init temporal-ui mongo-express -d
```

This starts:

| Service | Port | Purpose |
|---------|------|---------|
| `euro-mongo` | 27017 | MongoDB |
| `mongo-express` | 8081 | MongoDB Web UI — http://localhost:8081 |
| `temporal` | 7233 | Temporal gRPC |
| `temporal-db` | — | Temporal's PostgreSQL backend |
| `temporal-init` | — | Registers Temporal's `TenantId` search attribute, then exits |
| `temporal-ui` | 8080 | Temporal Web UI — http://localhost:8080 |

Wait ~15 seconds for Temporal to initialize, then verify:

```bash
docker compose ps   # All services should show "Up" or "running"
```

`temporal-init` shows as exited (0) in `docker compose ps -a`: it registered the `TenantId` search attribute, which every workflow the API starts carries (Temporal refuses a start whose search attribute is not registered). `docker compose logs temporal-init` ends with "TenantId is registered in namespace default"; see `docs/DEPLOYMENT.md` § 4. Temporal. With a standalone dev server instead of Compose: `temporal server start-dev --search-attribute TenantId=Keyword`.

### Optional: the access graph (Neo4j)

The Access explorer (`/access-explorer`: an identity's access graph, entitlement holders, access paths, SoD violations through nested groups) reads a Neo4j graph. Nothing else needs it. Without Neo4j every `/api/v1/access-explorer` route answers `503` with what to do, and the page shows that message. `docker compose up` does not start Neo4j: it runs only with the `graph` profile.

```bash
# The same password in .env (repository root, read by Compose) and in backend/.env (local API and worker)
NEO4J_PASSWORD=<8 characters or more>

docker compose --profile graph up -d euro-neo4j   # Bolt 127.0.0.1:7687, Neo4j Browser http://localhost:7474
```

Restart the API and the worker after setting `NEO4J_PASSWORD`: they read it when they start (`NEO4J_URL` defaults to `bolt://localhost:7687`, in Compose to `bolt://euro-neo4j:7687`). A process that started before Neo4j answered connects on its own: it tries again with a later graph call (a query, an event write, the readiness probe), at most once per `NEO4J_RECONNECT_INTERVAL_MS` (30 s by default), and until then the explorer answers `503` and `GET /api/v1/health/ready` reports `components.graph.status` `not-connected` (overall `degraded`). A connected process that loses Neo4j reports `not-connected` from the first graph call or connectivity check that cannot reach it until a call reaches Neo4j again or a check succeeds; the readiness probe starts such a check at most once per `NEO4J_RECONNECT_INTERVAL_MS`, also while connected, and does not wait for it. Then load the tenant's current state from MongoDB, as a super-admin: [Load graph from MongoDB] on the Access explorer page, or `POST /api/v1/access-explorer/resync`. It writes the identities, the entitlement catalog and the access the identity page shows as Active, and removes what MongoDB no longer has. Events keep the graph current afterwards: completed provisioning (access added and removed), entitlement discovery (the catalog's names and applications) and a deleted or offboarded identity (its node removed). Group nesting is not in the graph: no group-in-group membership is written to it. Each connection creates a uniqueness constraint on `(tenantId, id)` for the `Identity`, `Entitlement` and `Application` nodes if it is missing; when one cannot be created because the graph already holds duplicate nodes, the API log says so and names one of them, and a resync of that tenant removes its duplicates and creates the constraint. Run the resync again after a restore or after the graph was offline while access changed.

---

## 3. Configure Environment

### Backend

```bash
cp backend/.env.example backend/.env
```

For local dev, the defaults work. Key settings already in the example:

| Variable | Default | Notes |
|----------|---------|-------|
| `MONGO_URI` | `mongodb://admin:password123@localhost:27017/euroid?authSource=admin` | Matches docker-compose |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Matches docker-compose |
| `AUTH_DISABLED` | `true` | Bypasses OIDC for local dev |
| `ENCRYPTION_KEY` | (empty) | **Set this** — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

> **Important:** Set `ENCRYPTION_KEY` even for dev. Connector credentials are encrypted at rest. Without it, the secrets service uses a fallback but will warn on every start.

### Frontend

```bash
cp frontend/.env.example frontend/.env
```

Defaults work for local dev:

| Variable | Default | Notes |
|----------|---------|-------|
| `VITE_AUTH_DISABLED` | `true` | Uses DevAuthProvider (no IdP needed) |
| `VITE_API_BASE_URL` | `http://localhost:3001/api/v1` | Points to local backend |

---

## 4. Start the Application (3 Terminals)

| Terminal | Directory | Command | What it runs |
|----------|-----------|---------|-------------|
| 1 | `backend/` | `npm run start:dev` | NestJS API on **port 3001** (hot reload) |
| 2 | `backend/` | `npm run start:worker:watch` | Temporal worker (hot reload) |
| 3 | `frontend/` | `npm run dev` | Vite dev server on **port 5173** |

Or from the repo root:

```bash
# Terminal 1
npm run dev:backend

# Terminal 2 (must be in backend/)
cd backend && npm run start:worker:watch

# Terminal 3
npm run dev:frontend
```

---

## 5. Verify Everything Works

### Health Check

```bash
curl http://localhost:3001/api/v1/health
# Expected: { "status": "ok", ... }
```

### Swagger UI

Open http://localhost:3001/api/docs — interactive API documentation.

### Frontend

Open http://localhost:5173 — you should see the EuroID dashboard. With `AUTH_DISABLED=true`, you're automatically logged in as a dev user.

### Temporal UI

Open http://localhost:8080 — verify the Temporal UI loads. Once you trigger a workflow (e.g., onboarding), it will appear here.

### MongoDB UI

Open http://localhost:8081 — Mongo Express. Credentials: see docker-compose.yml.

### Demo Data

To give every page something to show, fill the dev tenant with a fictitious European company: about 200 identities across ten departments and eight offices (manager hierarchy, joiners, leavers, movers, contractors, a second JSON API HR source), their provisioning to Entra ID, AD, Okta, GitHub and File outbound, an entitlement catalog, policies and SoD policies, timeline entries, drift records, anomalies and risk scores, uncorrelated records and correlation conflicts, access requests, an active and a completed access review, webhook subscriptions with delivery history, dead-letter entries, and pending joiner, mover and leaver batches.

```bash
cd backend
npm run seed:demo                                 # tenant DEV_TENANT_ID (default dev-tenant), 200 identities
npm run seed:demo -- --reset                      # remove what the seed wrote, then seed again
npm run seed:demo -- --tenant acme --count 300    # another tenant, more people (at least 60)
```

The seed reads `MONGO_URI` from `backend/.env` and refuses to run with `NODE_ENV=production`. It is deterministic: the same people and ids in every run, with dates counted from the day of the run, and a second run without `--reset` writes nothing. Every address is under `example.com` (`demo.example.com`, `iberia.demo.example.com`). `--reset` removes only what the seed wrote: the documents it marked (`metadata.demoSeed`, `createdBy` or `workflowId` `demo-seed`, a `demo-seed:` correlation id) and the per-identity records of the seeded identities (timeline, drift, anomalies, risk scores, joiner, leaver and mover events). The hub lists the `--count` identities; three offboarded (soft-deleted) people come on top.

Limits of the demo data: the seeded pending access requests have no running approval workflow, so approving or rejecting one fails (create a request in the portal to show the approval flow); the two webhook subscriptions are paused or disabled and need a new signing secret before they deliver; approving a joiner, mover or leaver batch, or re-evaluating a demo identity, starts the real workflows against the configured target systems.

---

## 6. Full Docker Compose (Optional)

To run the **entire stack** in Docker (API + Worker + Frontend + infrastructure):

```bash
docker compose up -d
```

| Service | Port | URL |
|---------|------|-----|
| Frontend | 80 | http://localhost |
| API | 3002 (→3001 internal) | http://localhost:3002/api/docs |
| MongoDB | 27017 | — |
| Mongo Express | 8081 | http://localhost:8081 |
| Temporal gRPC | 7233 | — |
| Temporal UI | 8080 | http://localhost:8080 |

> Note: In full Docker mode, the API is exposed on port **3002** (mapped from internal 3001). The frontend Nginx proxies `/api` to the API container.

---

## Common Issues

| Problem | Solution |
|---------|----------|
| `ECONNREFUSED :27017` | MongoDB not running. Check `docker compose ps` — `euro-mongo` should be up. |
| `ECONNREFUSED :7233` | Temporal not ready. Wait 15-30 seconds after `docker compose up`. Check `docker compose logs temporal`. |
| Worker fails with `transport error` | Temporal server not fully initialized. Restart the worker after Temporal is healthy. |
| `ENCRYPTION_KEY` warnings | Set `ENCRYPTION_KEY` in `backend/.env`. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| Frontend shows blank page | Check browser console. Ensure `VITE_API_BASE_URL` matches where the backend is running. |
| Port conflict on 3001 | Another process uses port 3001. Kill it or set `PORT=3003` in `backend/.env`. |
| `jose` ESM errors in tests | Known issue. See `backend/jest.config.ts` for `moduleNameMapper` workaround. |
| Pre-commit hook fails | Husky runs lint-staged. Fix lint/prettier errors or run `npm run format` in `backend/`. |
| Commits in a `git worktree` run no hooks | `git config core.hooksPath` must print the absolute path of the main checkout's `.husky/_`. Run `npm run prepare` in the main checkout's root. |
| Push refused: `Failed to start ephemeral server: error sending request for url (https://temporal.download/...)` | The pre-push e2e suite could not download Temporal's test server. Connect to the network and push again (one download, then cached in `backend/node_modules/.cache/temporal-test-server`). |

---

## Next Steps

- **Architecture overview:** Start with `docs/architecture/core/DATAFLOWS.md` for end-to-end flow understanding
- **Backend guide:** `backend/README.md` — module inventory, path aliases, endpoint map
- **Frontend guide:** `frontend/README.MD` — component patterns, route map, features
- **Visual diagrams:** `docs/architecture/DIAGRAMS_INDEX.md`
- **User flows:** `docs/USER_FLOWS.md` — step-by-step flows with API calls and UI interactions

---

## Reading Paths by Role

### For New Contributors

1. **This file** — environment setup
2. `docs/architecture/core/DATAFLOWS.md` — end-to-end data flow (the "Rosetta Stone")
3. `docs/architecture/core/SYSTEM_ARCHITECTURE.md` — foundational pillars, principles, extended modules
4. `CONTRIBUTING.md` — architecture rules and the checks a change must pass
5. `backend/README.md` or `frontend/README.MD` — module inventories for your area
6. Module-specific `docs/ARCHITECTURE.md` — deep dive into the module you'll work on

### For Auditors & Compliance

1. `docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md` — OIDC, RBAC, roles, MFA, SAML
2. `docs/architecture/security/DATA_RETENTION.md` — TTL policies, soft-delete, archival
3. `backend/src/modules/audit/` — hash-chain audit log, integrity verification
4. `backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md` — GDPR article mapping
5. `docs/architecture/api/API_STABILITY_CONTRACT.md` — API versioning guarantees
6. `docs/adr/DECISIONS_LOG.md` — architecture decision records with rationale

### For Operators & SRE

1. `docs/DEPLOYMENT.md` — Docker Compose, production checklist, CI/CD
2. `docs/architecture/infrastructure/OBSERVABILITY_ARCHITECTURE.md` — logging, metrics, tracing
3. `docs/architecture/infrastructure/DISASTER_RECOVERY.md` — RPO/RTO, backup, failure scenarios
4. `docs/architecture/infrastructure/INFRASTRUCTURE_SCALING.md` — Redis, circuit breakers, cell roadmap
5. `docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md` — workflow patterns, retry policies
6. `backend/src/infrastructure/temporal/docs/TASK_QUEUES.md` — bulkhead isolation
