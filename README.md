# EuroID - Identity Governance Platform

> *Schengen for your apps: one passport, no border checks.*
>
> **About this repository:** see [ABOUT.md](ABOUT.md) for what EuroID is, its status and the licence. File inventories: `backend/README.md`, `frontend/README.MD`.
>
> **New here?** See `docs/GETTING_STARTED.md` — from clone to running in under 10 minutes.

---

## What Is This?

EuroID is an **Identity Governance & Administration (IGA) platform**. It orchestrates user lifecycles from HR sources (CSV HR, JSON API HR) to target systems (Entra ID, Active Directory, Okta, SCIM, ServiceNow, GitHub, Google Sheets, Discord webhook, File outbound) via a policy engine, durable workflows, and a visual design studio. Connectors are registered in `backend/src/modules/connectors/plugin/register-connectors.ts`.

---

## Tech Stack

**Core:** NestJS + Temporal + React + Vite + MongoDB + TypeScript. Validation: Zod. UI: Ant Design. Auth: JWT + OIDC + SAML. Real-time: Socket.IO.

Versioned stack tables: `backend/README.md` § Tech Stack, `frontend/README.MD` § Tech Stack.

---

## Repository Structure

```
EuroID/
├── backend/                    # NestJS API + Temporal Worker
│   ├── src/
│   │   ├── main.ts             # API bootstrap (Swagger, CORS, Helmet, validation pipes)
│   │   ├── worker.ts           # Temporal worker (bulkhead pattern, per-connector queues)
│   │   ├── app.module.ts       # Root NestJS module
│   │   ├── activities/         # Temporal Activity implementations (one file per domain)
│   │   ├── infrastructure/     # Auth, events, observability, secrets, temporal, etc.
│   │   ├── shared/             # DTOs, errors, filters, SCIM, utils
│   │   ├── testing/            # Mock factories, test DB, test helpers
│   │   ├── modules/            # Feature modules (foundational pillars + extended)
│   │   ├── scripts/            # One-off scripts: data migrations, seeds, key rotation, payload decoding
│   │   └── workflows/          # Temporal Workflow definitions
│   ├── .env.example            # Backend env var template
│   ├── Dockerfile              # API container (multi-stage)
│   └── Dockerfile.worker       # Worker container (pre-built workflow bundle)
│
├── frontend/                   # React + Vite SPA
│   ├── src/
│   │   ├── App.tsx             # Root: providers, router, all route declarations
│   │   ├── auth/               # 3 auth providers (OIDC, Local, Dev)
│   │   ├── api/                # API modules, data layer, WebSocket
│   │   ├── components/         # Shared components
│   │   ├── config/             # Centralized constants (polling, pagination, routes)
│   │   ├── features/           # Feature pages (lazy-loaded)
│   │   ├── generated/          # Auto-generated types from swagger-spec.json
│   │   ├── interfaces/         # TypeScript types (must mirror backend DTOs)
│   │   ├── stores/             # Zustand stores
│   │   └── theme/              # Ant Design theme (light/dark/sider)
│   ├── .env.example            # Frontend env var template
│   ├── Dockerfile              # Frontend container
│   └── README.MD               # Frontend-specific AI agent guide
│
├── docs/
│   ├── architecture/           # Architecture docs
│   ├── adr/                    # Architecture Decision Records
│   └── operations/             # Operational runbooks
│
├── .husky/                     # Git hooks: lint-staged on commit, the test gate on push
│
├── ABOUT.md                    # What this repository is, status, licence
├── LICENSE                     # All rights reserved
├── docker-compose.yml          # Full stack: MongoDB, Temporal, API, Worker, Frontend
├── swagger-spec.json           # Auto-generated OpenAPI spec (updated on every API start)
└── package.json                # Root monorepo convenience scripts
```

Path aliases: see `backend/README.md` § Path Aliases and `frontend/README.MD` § Path Aliases.

---

## Dev Commands

### Local Development (3 terminals)

Backend API: `npm run start:dev` in `backend/` (port 3001). Worker: `npm run start:worker:watch` in `backend/`. Frontend: `npm run dev` in `frontend/` (port 5173).

**Prerequisites:** MongoDB on `localhost:27017`, Temporal on `localhost:7233`.

Quick start: `docker compose up euro-mongo temporal temporal-db temporal-init temporal-ui -d` then run the 3 terminals. `temporal-init` registers the `TenantId` search attribute; without it Temporal refuses every workflow start.

### Root Convenience Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev:backend` | Starts backend API from root |
| `npm run dev:frontend` | Starts frontend from root |
| `npm run temporal` | Starts Temporal dev server with the `TenantId` search attribute registered, which every workflow start needs (needs `temporal` CLI) |

---

## Docker Compose

`docker compose up` starts the full stack:

| Service | Image | Port | Purpose |
| --- | --- | --- | --- |
| `euro-mongo` | `mongo:latest` | 27017 | MongoDB |
| `mongo-express` | `mongo-express` | 8081 | MongoDB Web UI |
| `temporal` | `temporalio/auto-setup` | 7233 (gRPC), 8233 | Temporal server (Postgres backend) |
| `temporal-init` | `temporalio/admin-tools` | -- | Registers the `TenantId` search attribute, then exits; `euro-api` and `euro-worker` wait for it |
| `temporal-db` | `postgres:13` | -- | Temporal's Postgres |
| `temporal-ui` | `temporalio/ui` | 8080 | Temporal Web UI |
| `euro-api` | `backend/Dockerfile` | 3002 → 3001 | NestJS API |
| `euro-worker` | `backend/Dockerfile.worker` | -- | Temporal Worker |
| `euro-frontend` | `frontend/Dockerfile` | 80 | React frontend |
| `euro-neo4j` | `neo4j:5` | 7474, 7687 (127.0.0.1 only) | Optional graph for the Access explorer; starts only with `docker compose --profile graph up -d euro-neo4j` |

---

## Environment Configuration

| File | Purpose |
| --- | --- |
| `backend/.env.example` | Backend env var template (copy to `backend/.env`) |
| `backend/.env.production.example` | Production backend template |
| `frontend/.env.example` | Frontend env var template (copy to `frontend/.env`) |
| `frontend/.env.production.example` | Production frontend template |

**Backend env vars:** See `backend/README.md` § Environment Variables and `backend/.env.example` for the complete list.

**Frontend env vars:** See `frontend/README.MD` § Environment Variables and `frontend/.env.example` for the complete list.

---

## API Reference

| Resource | Location |
| --- | --- |
| Swagger UI | `http://localhost:3001/api/docs` (when API is running) |
| OpenAPI spec | `swagger-spec.json` (auto-regenerated on every API start) |
| API changelog | `docs/architecture/API_CHANGELOG.md` |
| Health check | `GET /api/v1/health` |
| Metrics | `GET /metrics` (Prometheus scrape endpoint) |
| SCIM 2.0 | `GET /scim/v2/*` (excluded from `/api/v1` prefix) |

Full endpoint inventory: `backend/README.md`.

**Real-time / WebSocket:** Socket.IO on `/events` gateway. Room subscriptions, auto-invalidation, notifications. Details: `frontend/README.MD` § Real-time / WebSocket.

---

## Checks (no CI)

There is no CI pipeline: the repository has no GitHub Actions workflow. The gates are the Git hooks in `.husky/`, installed by `npm install` in the repository root:

| Hook | Runs |
| --- | --- |
| `pre-commit` | `lint-staged` on the staged files: prettier, eslint, the related backend tests and the guard scripts in `scripts/check-*.sh` |
| `commit-msg` | commitlint (conventional commits) |
| `pre-push` | the backend type-check (`npm run typecheck`), the whole backend unit and integration suite (`npm test`), then the Temporal workflow e2e suite (`TEMPORAL_E2E=1 npm run test:e2e`); a failure refuses the push |

Nothing runs the frontend checks automatically: run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` in `frontend/` before pushing a frontend change. Details: `backend/docs/TESTING.md`.

---

## Database (MongoDB — Onion Model)

The `Identity` document uses a 5-layer "Onion Model" (profile → sources → controls → provisioning → metadata).

Schema: `backend/src/modules/identity/schemas/identity.schema.ts`
Full docs: `backend/src/modules/identity/docs/DATABASE_ARCHITECTURE.md`

---

## Architecture Documentation Index

Documentation uses a **two-tier system**: domain-specific docs live in module `docs/` folders, cross-cutting docs stay in `docs/architecture/`. See `docs/DOCUMENTATION_STRATEGY.md` for details.

**Start here:** `docs/architecture/core/DATAFLOWS.md` — end-to-end flow map that references all other docs.

**Future designs:** 20 feature designs with dependency map: `docs/architecture/future/README.md`. Nine of them are built or partly built (immutable audit, identity entitlement map, graph database, OPA, AI access intelligence, credential lifecycle, remote agent control plane, SIEM as webhooks only, CQRS read model for audit events).
