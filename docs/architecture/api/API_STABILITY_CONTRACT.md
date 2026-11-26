# API Stability Contract

> **Version:** 1.0  
> **Effective:** 2026-02-12

---

## Versioning Strategy

All API endpoints are served under the `/api/v1/` prefix.

### Rules

1. **v1 endpoints are frozen once released.** Breaking changes (removed fields, renamed paths, changed semantics) require a new version (v2).

2. **Non-breaking changes are allowed on v1:**
   - Adding new optional fields to response DTOs
   - Adding new endpoints
   - Adding new query parameters (optional)
   - Relaxing validation (accepting more input)

3. **Breaking changes include:**
   - Removing or renaming a field in a response DTO
   - Changing the type of an existing field
   - Removing an endpoint
   - Adding a required field to a request DTO
   - Changing the meaning of an existing field
   - Changing authentication requirements for an existing endpoint

4. **Deprecation process:**
   - Mark deprecated endpoints in the OpenAPI spec with `@ApiOperation({ deprecated: true })` (`@nestjs/swagger`); the code has no `@ApiDeprecated()` decorator and no deprecated endpoint today
   - Log a deprecation warning when the endpoint is called
   - Maintain deprecated endpoints for at least 2 release cycles
   - Document in API_CHANGELOG.md

### Internal Endpoints

Endpoints under `/api/v1/dev/` are internal and may change without notice. They are not part of the stability contract.

### Source of Truth

The `swagger-spec.json` file (auto-generated on backend startup) is the machine-readable source of truth for the API surface. The `docs/architecture/API_CHANGELOG.md` documents changes.

---

## Public (Unauthenticated) Endpoints

These endpoints are decorated with `@Public()` and do not require a JWT:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/health` | Liveness check |
| GET | `/api/v1/health/ready` | Readiness check |
| GET | `/api/v1/batch-provision/health` | Entra/batch-provision health check |
| POST | `/api/v1/auth/login`, `/register`, `/refresh`, `/logout` | Local login and session (`auth-local.controller.ts`) |
| GET | `/api/v1/auth/setup-status` | Whether the first admin exists |
| GET, POST | `/api/v1/auth/password-reset/config`, `/request`, `/confirm` | Console admin password reset |
| POST | `/api/v1/auth/mfa/challenge` | MFA step of a login |
| GET, POST | `/api/v1/auth/saml/config`, `/login`, `/metadata`, `/callback`, `/exchange` | SAML login |
| GET | `/scim/v2/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes` | SCIM discovery (RFC 7644) |

Not behind the JWT guard either: `GET /metrics` (Prometheus) is registered in `main.ts` outside Nest; with `METRICS_TOKEN` set it needs that token as Bearer, and in production without it the route answers 403.
`/scim/v2/Users` and `/scim/v2/Groups` take a SCIM bearer token (`@ScimAuth()`) instead of a JWT.

All other endpoints require a valid Bearer JWT (or the local login's `access_token` cookie).
