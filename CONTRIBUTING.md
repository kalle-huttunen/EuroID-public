# Contributing to EuroID

## Development Model

EuroID uses a **human + AI pair programming** workflow. One developer + AI assistant (Claude Code / Cursor) handles all development. This guide ensures consistency and captures conventions for future team scaling.

## Quick Start

```bash
# Prerequisites: Node 20+, Docker, Git
docker compose up euro-mongo temporal temporal-db temporal-init temporal-ui -d   # MongoDB + Temporal + Postgres
cd backend && npm install && npm run start:dev       # API on :3001
cd backend && npm run start:worker:watch             # Temporal worker
cd frontend && npm install && npm run dev             # UI on :5173
```

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for full setup.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code |
| `feature/*` | New features |
| `fix/*` | Bug fixes |
| `infra/*` | CI/CD, Docker, config changes |

## Commit Conventions

Format: `<type>: <description>`

Types (commitlint's conventional set; the commit hook rejects any other): `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, `ci`, `perf`, `style`, `revert`. A scope is optional: `fix(auth): ...`. CI, Docker and config changes use `build` or `ci`.

Examples:
- `feat: add SCIM connector health check`
- `fix: resolve race condition in reconciliation batch`
- `docs: update connector architecture diagram`

## Definition of Done

Before merging, verify:

- [ ] `npm run lint` passes (backend + frontend)
- [ ] `npm run typecheck` passes (backend + frontend)
- [ ] `npm run test` and `TEMPORAL_E2E=1 npm run test:e2e` pass (backend; the `pre-push` hook runs both after the type-check)
- [ ] No hardcoded secrets, URLs, or ports
- [ ] Architecture rules below respected
- [ ] Relevant docs updated (architecture docs, API changelog if applicable)

## Architecture Rules (Non-Negotiable)

1. **Connectors = Dumb Pipes** — field mapping only, business logic goes to Policy Engine
2. **Golden Record First** — all data routes through Identity Hub
3. **Temporal for orchestration** — multi-step flows use Temporal workflows
4. **Zod at the gate** — validate inputs at API boundary
5. **Simulate before commit** — destructive actions require dry-run

## Adding a New Module

1. Read `docs/architecture/core/SYSTEM_ARCHITECTURE.md` and the `docs/ARCHITECTURE.md` of a similar module
2. Update the module's architecture doc and `docs/architecture/API_CHANGELOG.md` for API changes
3. Update inventory tables in `backend/README.md` or `frontend/README.MD`

## Security

- Report vulnerabilities per [SECURITY.md](.github/SECURITY.md)
- Never commit `.env` files or credentials
