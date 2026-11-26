# API Error Response Format

What EuroID API endpoints return when a request fails, as the global exception filters in `backend/src/shared/filters/` produce it. SCIM endpoints (`/scim/v2/...`) answer in the SCIM error format instead (see [SCIM endpoints](#scim-endpoints)).

---

## Error Body

Most errors have NestJS's standard body:

```json
{
  "statusCode": 400,
  "message": "No blueprint canvas found",
  "error": "Bad Request"
}
```

| Field | Type | Present | Description |
|-------|------|---------|-------------|
| `statusCode` | `number` | Almost always | HTTP status code. Missing when a handler throws its own body without it (see below). |
| `message` | `string` or `string[]` | Always | Human-readable description. Validation errors give one entry per problem ([Validation Errors](#validation-errors)). |
| `error` | `string` | When the exception carries a message | HTTP status text (`"Bad Request"`, `"Not Found"`). Missing from the bodies the filters build themselves (`409`, the `400` for a Mongoose cast error, `500`), from `429`, and from an exception thrown without a message (`{ "statusCode": 401, "message": "Unauthorized" }`). |

A handler that throws an `HttpException` with an object body gets that object back unchanged, so a few endpoints add or drop fields:

- `POST /blueprints/deploy` when the readiness check fails: `{ "statusCode": 422, "message": "Readiness check failed", "readiness": { "ready": false, "checks": [...] } }`, with HTTP status 422 (see [422](#422-unprocessable-entity)).
- `POST /bulk-provisioning/start` with an invalid body: `{ "message": "Validation failed", "errors": [<Zod issues>] }`, no `statusCode`.
- `GET /health/ready` when unhealthy: the health report itself, `{ "status": "unhealthy", "uptime": ..., "timestamp": ..., "components": {...} }`.

No error body carries `details`, `timestamp` or `correlationId`. The correlation id comes back in the `X-Correlation-ID` response header ([Correlation ID](#correlation-id)).

---

## HTTP Status Codes

### 400 Bad Request

Invalid input. Typical bodies:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "No blueprint canvas found" }
```

```json
{ "statusCode": 400, "error": "Bad Request", "message": ["email: Invalid email", "department: Required"] }
```

A path id that is not a MongoDB ObjectId, rejected by `ParseObjectIdPipe`:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "Invalid ID format: abc" }
```

Routes of a resource addressed by its own public id (`/anomalies/:id` by `anomalyId`, `/policy-suggestions/:id` by `suggestionId`) validate with `ParsePublicIdPipe` instead: a UUID, and for anomalies also the document `_id`. Any other value gets the same body.

A Mongoose `CastError` for an ObjectId that reaches the filters (no pipe on the route), answered by `VersionConflictFilter`:

```json
{ "statusCode": 400, "message": "Invalid ID format" }
```

### 401 Unauthorized

Missing or invalid authentication, from `JwtAuthGuard` (`backend/src/infrastructure/auth/jwt-auth.guard.ts`). Messages include `No bearer token provided`, `Invalid token`, `Token revoked or user deactivated`.

```json
{ "statusCode": 401, "error": "Unauthorized", "message": "No bearer token provided" }
```

### 403 Forbidden

Authenticated, but the role does not grant the endpoint (`RolesGuard`), or the tenant check fails (`TenantGuard`).

```json
{ "statusCode": 403, "error": "Forbidden", "message": "Requires one of: policy-admin" }
```

### 404 Not Found

The resource does not exist or is not visible to the caller's tenant.

```json
{ "statusCode": 404, "error": "Not Found", "message": "Identity not found" }
```

### 409 Conflict

`VersionConflictFilter` answers a Mongoose `VersionError` (optimistic concurrency) with:

```json
{ "statusCode": 409, "message": "This record was modified by another user. Please refresh and try again." }
```

A service that throws `ConflictException` (for example an existing record) gets the standard body with `"error": "Conflict"`. An anomaly status change its current status does not allow is one: `{ "statusCode": 409, "error": "Conflict", "message": "Anomaly <anomalyId> is resolved and cannot be acknowledged." }`.

**Connector idempotency:** connectors catch `409 Conflict` from target systems and return the existing resource as success, so a target's 409 does not reach the API consumer.

### 422 Unprocessable Entity

`POST /blueprints/deploy` answers a failed readiness check with HTTP status 422 (`UnprocessableEntityException` in `PipelineService.deploy`); nothing is deployed. The body carries the `readiness` result, and the Deploy modal reads `statusCode` and `readiness` from it:

```json
{
  "statusCode": 422,
  "message": "Readiness check failed",
  "readiness": { "ready": false, "checks": [{ "name": "HR Source", "status": "fail", "message": "No HR source connector configured" }] }
}
```

`IdentityException` (`backend/src/shared/exceptions/domain-exceptions.ts`) also defaults to 422 with the body `{ "error": "IdentityError", "message": "..." }`, but it is thrown only in Temporal activities.

### 429 Too Many Requests

`ThrottlerGuard` (`@nestjs/throttler`, limits in `app.module.ts`):

```json
{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }
```

The response carries `Retry-After-short` or `Retry-After-medium` (seconds) for the throttler that blocked the request, plus `X-RateLimit-Limit-*`, `X-RateLimit-Remaining-*` and `X-RateLimit-Reset-*` on every throttled route.

### 500 Internal Server Error

Any error that is not an `HttpException` and that no specific filter answers:

```json
{ "statusCode": 500, "message": "Internal server error" }
```

The client never sees the message or stack; `AllExceptionsFilter` logs the error as `Unhandled exception: <message>` with its stack. That includes an error object that carries its own `statusCode` and `message` (an SDK's upstream response, for example): its status and message stay internal.

One exception: a client error from Express's body parsing (an `http-errors` error with a 4xx status and `expose: true`) keeps its status and message, e.g. `{ "statusCode": 413, "message": "request entity too large" }` for a body over the size limit.

### 503 Service Unavailable

Returned by `GET /health/ready` when MongoDB is down, with the health report as the body (see [Error Body](#error-body)); the connector counts are not read then (`components.connectors.checkedAt` is `null`). A stale connector, a failing security state store or a lost Neo4j connection make the report `degraded` with HTTP 200, not 503.

---

## Exception Filter Architecture

`main.ts` registers the three global filters listed in `backend/src/shared/filters/global-exception-filters.ts` (tests register the same list):

```typescript
[
  new AllExceptionsFilter(adapterHost),
  new VersionConflictFilter(adapterHost),
  new ZodErrorFilter(adapterHost),
]
```

NestJS tries controller-scoped filters first, then the global ones in reverse registration order, and uses the first whose `@Catch()` matches:

1. **`ZodErrorFilter`** (`zod-error.filter.ts`), `@Catch(ZodError)`: a `Schema.parse()` of request input in a controller or service that throws becomes `400` with one `message` entry per issue ([Validation Errors](#validation-errors)).
2. **`VersionConflictFilter`** (`version-conflict.filter.ts`), `@Catch(VersionError, CastError)` (Mongoose's error classes):
   - `VersionError` → `409`
   - `CastError` with `kind === 'ObjectId'` → `400 { statusCode, message: "Invalid ID format" }`
   - any other `CastError` → the catch-all answer below (the filter extends `AllExceptionsFilter`)
3. **`AllExceptionsFilter`** (`all-exceptions.filter.ts`), `@Catch()`, every other exception:
   - an `HttpException` → NestJS's `BaseExceptionFilter`: its own response body (a string message becomes `{ statusCode, message, error }`, an object is sent as is)
   - a body parsing client error (`http-errors`, 4xx, `expose: true`) → its `statusCode` and `message`
   - anything else → the generic `500`, logged as `Unhandled exception: <message>` with the stack

Each specific filter names only its own exception types in `@Catch()`; one with an empty `@Catch()` would take every exception before the catch-all. Tests: `global-exception-filters.spec.ts` (the registered chain over HTTP), `zod-error.filter.spec.ts`.

The SCIM controllers add `SCIMErrorFilter` with `@UseFilters`, which runs before the global filters.

---

## Validation Errors

Request input is validated with Zod at the API boundary (Safety Rule #4). Every path answers with the standard body and one `message` entry per issue, prefixed by the field path in dot notation:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["sources.0.externalId: Required", "email: Invalid email"]
}
```

- DTO classes are validated by the global `ZodValidationPipe` (`@anatine/zod-nestjs`). An issue on the body as a whole has an empty path (`": Expected object, received string"`).
- A `Schema.parse()` in a handler or service throws a `ZodError`, which `ZodErrorFilter` answers the same way; an issue on the body as a whole reads `"body: ..."`.
- Handlers that use `safeParse` throw `BadRequestException(zodIssueMessages(error))` with the same lines (for example `POST /blueprints/save`).

There is no `details` array.

---

## SCIM Endpoints

`/scim/v2/Users`, `/scim/v2/Groups` and the SCIM discovery endpoints (outside the `/api/v1` prefix) answer every error through `SCIMErrorFilter` (`backend/src/shared/scim/scim.error.ts`) as RFC 7644 §3.12 errors, with content type `application/scim+json`:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "scimType": "invalidFilter",
  "detail": "Invalid SCIM user filter syntax",
  "status": "400"
}
```

`scimType` is present only when the error sets it. A non-HTTP error becomes `"status": "500"` with `"detail": "Internal server error"`.

---

## Correlation ID

`CorrelationMiddleware` (`backend/src/infrastructure/middleware/correlation.middleware.ts`, applied to every route):

1. Takes the `x-correlation-id` request header when it matches `^[a-zA-Z0-9._-]{1,128}$`, otherwise generates a UUID.
2. Echoes it in the `X-Correlation-ID` response header on every response, errors included, plus `X-Trace-Id` when OpenTelemetry tracing is active.
3. Stores it in the request context, which `ContextualLoggerService` and `DomainEventEmitterService` read (`metadata.correlationId` on domain events).

Read the correlation id of a failed request from the `X-Correlation-ID` header; it is not part of the error body.
