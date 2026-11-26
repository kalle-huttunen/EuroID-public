---
Last updated: 2026-11-23
---

# Platform Authentication & Authorization Architecture - The 2026 Standard

## The Core Problem

**"The locksmith's own door is unlocked."**

* **Today:** EuroID manages access for 10,000 employees across Entra ID, AD, Jira, and Slack. But the EuroID admin panel itself has **zero authentication**. Anyone on the network can modify policies, trigger provisioning, read PII, or override circuit breakers.
* **The Explosion:** A curious intern hits `DELETE /api/v1/identities`. Or a rogue script hammers `POST /api/v1/onboarding/batch`. Or a compliance auditor asks "who approved this policy change?" and the answer is "we don't know."
* **The Fix:** **OIDC authentication + Role-Based Access Control + Audit attribution.** Every API request is authenticated, authorized, and attributed.

---

## Auth Landmines (Critical Safety Protocol)

### Landmine 1: The "God Admin" Anti-Pattern

* **The Trap:** You create one "admin" role with full access. Every team member gets it because "it's easier."
* **The Explosion:** An intern accidentally triggers a full reconciliation revert. A departing employee exports all PII. There is no separation of duties.
* **The 2026 Fix: Least Privilege + Role Separation.**
  * Define granular roles that match actual job functions.
  * Circuit-breaker settings and resuming a paused pipeline require `policy-admin` (or `super-admin`), not every operator.
  * PII access is a separate permission, not bundled with "view identities."

### Landmine 2: The "Token in LocalStorage" Leak

* **The Trap:** You store the JWT access token in `localStorage` for convenience.
* **The Explosion:** A single XSS vulnerability exfiltrates every admin's token. The attacker now has full API access.
* **The 2026 Fix: Secure Token Handling.**
  * Local login: access and refresh tokens are `httpOnly`, `sameSite=strict` cookies (`secure` in production), never readable by JavaScript and never in localStorage (`backend/src/infrastructure/auth/auth-cookies.ts`, `frontend/src/auth/LocalAuthProvider.tsx`).
  * Local token lifetime: access cookie 15 minutes (the JWT inside expires after `JWT_EXPIRY`, default `1h`); refresh token 7 days (`REFRESH_TOKEN_EXPIRY_DAYS`, `modules/auth/auth-local.service.ts`).
  * OIDC login: the IdP sets the lifetimes. The frontend keeps the access token in a module variable (`frontend/src/auth/token-store.ts`) and sends it as a Bearer header; `oidc-client-ts` keeps the IdP tokens in sessionStorage (its default store).

### Landmine 3: The "Who Did This?" Compliance Gap

* **The Trap:** Actions are logged, but the `actor` field is always "system" or "admin" because the auth context is never propagated to the audit trail.
* **The Explosion:** An auditor asks "who approved removing the CFO from the Finance Admin group?" You cannot answer.
* **The 2026 Fix: Actor Attribution.**
  * Every API request carries the authenticated user's identity (from JWT claims).
  * The `correlationId` middleware (see infrastructure/OBSERVABILITY_ARCHITECTURE.md) also sets `actor` from the JWT.
  * Audit log entries, domain events, and user timeline events all carry the real actor.

---

## Architecture Decision: OIDC + JWT + NestJS Guards

### Why OIDC (Not Custom Auth)

EuroID is an identity platform — it should not reinvent authentication. Delegate to a trusted IdP:

| Option | When to Use |
|--------|-------------|
| **Microsoft Entra ID** | If the organization already uses M365. The admins are already Entra users. Zero extra infrastructure. |
| **Auth0 / Okta** | If multi-IdP support is needed or the org is not M365-native. |
| **Keycloak** | If self-hosted/open-source is required. |

The architecture is IdP-agnostic — it consumes standard OIDC tokens (JWT) regardless of the provider.

### Authentication Flow

```
    ┌────── Frontend (React SPA) ──────────────────────────────────────┐
    │                                                                   │
    │  1. User opens app → Redirect to IdP login (OIDC Authorization    │
    │     Code Flow with PKCE)                                          │
    │                                                                   │
    │  2. IdP authenticates → Returns authorization code                │
    │                                                                   │
    │  3. Frontend exchanges code for tokens (via IdP token endpoint)   │
    │     - access_token (JWT, lifetime set by the IdP)                 │
    │     - refresh_token if the IdP issues one (silent renew)          │
    │     - id_token (user profile claims)                              │
    │                                                                   │
    │  4. Frontend sends API requests with:                             │
    │     Authorization: Bearer <access_token>                          │
    │                                                                   │
    └──────────────────────────┬────────────────────────────────────────┘
                               │
    ┌────── Backend (NestJS API) ──────────────────────────────────────┐
    │                                                                   │
    │  5. JwtAuthGuard validates the token:                             │
    │     - Signature (via IdP JWKS endpoint, cached)                   │
    │     - Expiration (exp claim)                                      │
    │     - Audience (aud must match EuroID client ID)                  │
    │     - Issuer (iss must match IdP)                                 │
    │                                                                   │
    │  6. RolesGuard checks user's platform role against endpoint       │
    │     requirement                                                   │
    │                                                                   │
    │  7. Request proceeds (or 401/403)                                │
    │                                                                   │
    └──────────────────────────────────────────────────────────────────┘
```

---

## Platform Roles & Permissions

### Role Definitions

| Role | Description | Who Gets This |
|------|-------------|---------------|
| **viewer** | Read-only access to identities, policies, drift reports. Cannot see PII. | Helpdesk, auditors (read-only) |
| **operator** | Viewer + trigger syncs, approve provisioning, resolve drift, view PII | IT operations, L2 support |
| **policy-admin** | Operator + create/edit/delete policies, run simulations, manage role bundles, save and deploy blueprints, set the pipeline circuit breaker | IAM engineers, security team |
| **connector-admin** | Operator + configure connectors, edit a blueprint node's config (`PATCH /blueprints/:id`) | Integration engineers |
| **super-admin** | All permissions inside its own tenant. Manage the tenant's admins. Every tenant has one (its first registered user, invited admins, OIDC role claims; SAML never creates one, see JIT Provisioning), so it never reaches another tenant. | Tenant owner (1-2 people max per tenant) |
| **platform-admin** | Deployment operator: manage tenants, read deployment-wide diagnostics. Not a tenant role: it implies no tenant permission, and its holder keeps the tenant role of their own account. Granted only by deployment configuration (see § Platform Admin). | Whoever runs the deployment |

### Permission Matrix

Tenant roles act inside the caller's tenant only. `platform-admin` is a separate capability, not a step above `super-admin`: its column lists what the capability itself allows; a platform admin's account also has a tenant role, which decides the rest.

| Permission | viewer | operator | policy-admin | connector-admin | super-admin | platform-admin |
|-----------|--------|----------|-------------|----------------|-------------|----------------|
| View identities (no PII) | x | x | x | x | x | |
| View PII fields | | x | x | x | x | |
| Trigger sync / discovery | | x | x | x | x | |
| Approve provisioning | | x | x | x | x | |
| Resolve drift | | x | x | x | x | |
| View policies | x | x | x | x | x | |
| Create / edit policies | | | x | | x | |
| Delete policies | | | x | | x | |
| Run simulations | | | x | | x | |
| Manage role bundles | | | x | | x | |
| Approve / reject leaver batches, edit the leaver policy (`/leavers/*`) | | | x | | x | |
| Approve / reject HR mover batches, edit the mass-mover policy (`/movers/*`) | | | x | | x | |
| View connectors (secrets always masked) | x | x | x | x | x | |
| Manage blueprints (save, impact analysis, readiness check, deploy, pause, resume, stop) | | | x | | x | |
| Edit a blueprint node's config (`PATCH /blueprints/:id`) | | | | x | x | |
| Configure connectors | | | | x | x | |
| Set the pipeline circuit breaker (`PATCH /blueprints/pipeline-config`); resume after it paused | | | x | | x | |
| Manage the tenant's admins (invite and cancel invites, change roles, issue password reset codes, revoke sessions, deactivate) | | | | | x | |
| View audit logs | x | x | x | x | x | |
| Bulk operations | | x | x | | x | |
| Manage tenants (`/tenants`: create, list, update, suspend, migrate) | | | | | | x |
| Deployment diagnostics (`GET /batch-provision/health/diagnostics`) | | | | | | x |

Connector secrets (fields a connector manifest declares `type: 'password'`) are masked in every response for every role: `GET /connectors`, `GET /blueprints/latest`, `GET /blueprints/:id` and `PATCH /blueprints/:id`. Saving the mask back keeps the stored value, so no UI flow needs a secret in clear.

### Role Assignment

Roles are stored as a custom claim in the IdP (e.g., Entra ID app roles, Auth0 custom claims) or in a local `platform_roles` MongoDB collection for flexibility.

**Recommended approach:** Use the IdP's app role mechanism when possible (Entra ID App Roles are ideal since admins are already Entra users). Fall back to a local collection for overrides or when the IdP doesn't support custom claims.

```typescript
// JWT claims (after IdP authentication)
{
  "sub": "user-uuid-from-idp",
  "email": "admin@example.com",
  "name": "Kalle Admin",
  "roles": ["policy-admin"],           // From IdP app roles
  "aud": "euroid-client-id",
  "iss": "https://login.microsoftonline.com/{tenant}/v2.0"
}
```

### Platform Admin

Tenant management and deployment diagnostics span every tenant, so a tenant role cannot gate them: each tenant has its own `super-admin`. They require `@Roles('platform-admin')`, which `RolesGuard` grants only to a user whose id is listed in the deployment configuration:

```bash
# backend/.env — comma-separated authenticated user ids (JWT `sub`), never emails
PLATFORM_ADMIN_USER_IDS=6741c0f2a9d3e5b1c2f40a17
```

* **Local login:** the id is the `AdminUser` `_id` (`sub` in the token, `GET /api/v1/auth/me`). **OIDC:** the IdP subject. Break-glass: add `emergency-admin`; AUTH_DISABLED dev mode: add `dev-user`. Restart the API after a change.
* **Ids, not emails:** emails are not verified. A tenant super-admin can invite any address, SAML JIT takes the address the IdP asserts, and the first registration takes any address, so an email allow-list could be claimed by registering the listed address. Ids are server-generated (local) or the configured issuer's subject.
* **Nothing a tenant controls grants it:** no tenant role implies it (`ROLE_HIERARCHY`), a token whose `roles` claim names `platform-admin` gets nothing from it, `AdminUser.role` and invites cannot hold it, and first-user setup creates a tenant `super-admin`. With `PLATFORM_ADMIN_USER_IDS` unset, nobody is a platform admin.
* **Code:** `backend/src/infrastructure/auth/platform-admin.ts`, `roles.guard.ts`. Tests: `platform-admin.spec.ts` (tenant super-admin 403 on every `/tenants` route, platform admin allowed, setup and invites never grant it).
* **UI:** `GET /api/v1/auth/me` returns `isPlatformAdmin`, computed by the same check as `RolesGuard`. The frontend (`auth/usePlatformAdmin.ts`) shows the sidebar's Platform › Tenants entry, the command palette entry and the `/admin/tenants` route (`PlatformAdminRoute`) only when it is true, in every auth mode including dev mode; a tenant super-admin no longer sees a page whose calls all answer 403. This is display only: `/tenants` still refuses everyone else.

Tenant super-admin powers stay in the tenant: `GET /auth/users` lists the caller tenant's admins only (no password, MFA, session or token data; `isPlatformAdmin` marks an account named in `PLATFORM_ADMIN_USER_IDS`; `lastLoginAt` is set by every sign-in that issues a session), and `POST /auth/revoke/:userId` and `PATCH /auth/users/:id` act on an admin of the caller's tenant only, since `AdminUser` is exempt from the tenant plugin. The tenant lookup runs before every other check, so another tenant's id is 404 whatever it is: a 403 for a platform admin's id would tell another tenant's super-admin that the id is on the list. They cannot lock a tenant out or reach the deployment's operators: a super-admin cannot deactivate their own account or change their own role (400), demoting the tenant's last active super-admin is 409 (counted again after the write, so two super-admins demoting each other leave one), and an account named in `PLATFORM_ADMIN_USER_IDS` is refused to every tenant role (403) except its owner revoking their own sessions. A role change (`PATCH /auth/users/:id` `{ role }`, one of the five tenant roles) is audited as `admin_user.role_changed` and applies from the admin's next request: `JwtAuthGuard` takes the role of a local token from the database, not from the token (a scoped MFA enrollment token keeps no role). Code: `admin-users.service.ts`. Tests: `backend/src/modules/auth/admin-users.integration.spec.ts`, `backend/src/infrastructure/auth/jwt-auth.guard.spec.ts`.

Invites bring further admins into a tenant: `POST /auth/invites` (super-admin, `invite.controller.ts`) stores the invite in the inviter's tenant (the token's SHA-256 hash only, single use, 72 hours) and returns the token to the inviter alone; no event carries it. An address with an admin account in the inviter's tenant is refused (409); one with an account in another tenant is not, since that would tell one tenant who has accounts in another: registration refuses it (409) and the invite stays pending until it expires. `GET /auth/invites` lists the tenant's unused, unexpired invites without their codes or hashes, and `DELETE /auth/invites/:id` cancels one (deleted, audited as `invite.cancelled` without code or email; another tenant's is 404). The public `POST /auth/register` with `inviteToken` looks the invite up by that hash across tenants, since it has no tenant context, and creates the admin in the invite's tenant with the invite's role, never a tenant or role from the body. Tests: `backend/src/modules/auth/invite-registration.integration.spec.ts`.

Password reset (`backend/src/modules/auth/password-reset.service.ts`, `password-reset.controller.ts`) gives an admin who forgot the password a way back without database access. A reset token is 32 random bytes (64 hex characters) from `crypto.randomBytes`; only its SHA-256 and expiry are stored on the admin (`passwordResetTokenHash`, `passwordResetExpiresAt`), it is looked up by that hash, works once, and lasts `PASSWORD_RESET_TOKEN_TTL_MINUTES` (15 to 60, default 30). A newer token replaces it, and a reset or a password change removes it. Two ways to get one:

* **Self-service, when SMTP is configured:** the public `POST /auth/password-reset/request` `{ email }` (`@Public()`, like register) rate limits per client IP and per address (`PASSWORD_RESET_MAX_PER_IP`, default 10; `PASSWORD_RESET_MAX_PER_EMAIL`, default 3; per `PASSWORD_RESET_WINDOW_MINUTES`, default 15) in the shared security state store, which fails closed (503) like the MFA lockout, and then answers `202` with the same message for every address. The lookup, the token and the mail run after the answer, so neither the answer nor its timing tells whether the address has an account. Only an active account that signs in with a password gets a mail, through the notifications module's transport (`PasswordResetMailService`): sent at once, never stored or retried, since a stored mail would keep a live token in clear. The link carries the token in the URL fragment (`/reset-password#token=`), which browsers never send to a server.
* **Admin-issued, with or without SMTP:** `POST /auth/users/:id/password-reset` (super-admin) answers `{ token, expiresAt }` once, for an admin of the caller's tenant (404 otherwise, looked up first); refused for your own account (400), a platform admin (403), single sign-on and deactivated accounts (409).

The public `POST /auth/password-reset/confirm` `{ token, newPassword }` (rate limited per IP, fails closed) applies the change-password rules (`STRONG_PASSWORD_SCHEMA`, argon2id, no reuse of the last 5 passwords; `password-hashing.ts` serves both), increments `tokenVersion` and drops the refresh token so every session ends, signs nobody in and leaves MFA as it is. An unknown, used or expired token, or one of an account deactivated or single sign-on meanwhile, gets one message (400). Audit events `admin_user.password_reset_requested`, `admin_user.password_reset_issued` and `admin_user.password_reset_completed` carry the admin's id, never the token, code, password or address. `GET /auth/password-reset/config` (public) tells the sign-in page whether a link can be mailed. OIDC sign-ins have no `admin_users` row and no EuroID password. Tests: `backend/src/modules/auth/password-reset.integration.spec.ts`.

---

## Backend Implementation

### 1. JWT Validation Guard

```typescript
// backend/src/infrastructure/auth/jwt-auth.guard.ts

import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jose from 'jose';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private jwks: jose.createRemoteJWKSet;

  constructor(private readonly config: ConfigService) {
    // Cache the JWKS endpoint (auto-refreshes keys)
    const issuer = this.config.get<string>('OIDC_ISSUER');
    this.jwks = jose.createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No bearer token provided');
    }

    try {
      const { payload } = await jose.jwtVerify(token, this.jwks, {
        issuer: this.config.get('OIDC_ISSUER'),
        audience: this.config.get('OIDC_AUDIENCE'),
      });

      // Attach user info to request for downstream use
      request['user'] = {
        sub: payload.sub,
        email: payload.email as string,
        name: payload.name as string,
        roles: (payload.roles as string[]) ?? [],
      };

      return true;
    } catch (error) {
      throw new UnauthorizedException(`Invalid token: ${error.message}`);
    }
  }

  private extractToken(request: Request): string | undefined {
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return undefined;
  }
}
```

### 2. Roles Guard

```typescript
// backend/src/infrastructure/auth/roles.guard.ts

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

/** Role hierarchy: super-admin > connector-admin ≈ policy-admin > operator > viewer */
const ROLE_HIERARCHY: Record<string, string[]> = {
  'super-admin':    ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'],
  'connector-admin': ['connector-admin', 'operator', 'viewer'],
  'policy-admin':   ['policy-admin', 'operator', 'viewer'],
  'operator':       ['operator', 'viewer'],
  'viewer':         ['viewer'],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are specified, the endpoint is public (within auth'd users)
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest()['user'];
    if (!user?.roles) {
      throw new ForbiddenException('No roles assigned');
    }

    // Check if any of the user's roles grant the required permission
    const userPermissions = new Set<string>();
    for (const role of user.roles) {
      const granted = ROLE_HIERARCHY[role] ?? [];
      granted.forEach((r) => userPermissions.add(r));
    }

    const hasRole = requiredRoles.some((role) => userPermissions.has(role));
    if (!hasRole) {
      throw new ForbiddenException(
        `Requires one of: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
```

### 3. Roles Decorator

```typescript
// backend/src/infrastructure/auth/roles.decorator.ts

import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Decorator: @Roles('policy-admin') or @Roles('operator', 'policy-admin') */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

### 4. Auth User Decorator

```typescript
// backend/src/infrastructure/auth/auth-user.decorator.ts

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  roles: string[];
}

/** Extract the authenticated user from the request: @AuthUser() user: AuthUser */
export const AuthUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest()['user'];
  },
);
```

### 5. Controller Usage

```typescript
// Example: policy.controller.ts (after auth integration)

import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../infrastructure/auth/jwt-auth.guard';
import { RolesGuard } from '../../infrastructure/auth/roles.guard';
import { Roles } from '../../infrastructure/auth/roles.decorator';
import { AuthUser, AuthUser as AuthUserType } from '../../infrastructure/auth/auth-user.decorator';

@Controller('policies')
@UseGuards(JwtAuthGuard, RolesGuard)  // Apply to all endpoints in controller
export class PolicyController {

  @Get()
  @Roles('viewer')  // Anyone authenticated can view
  findAll() {
    return this.policyService.findAll();
  }

  @Post()
  @Roles('policy-admin')  // Only policy admins can create
  create(@Body() dto: CreatePolicyDto, @AuthUser() user: AuthUserType) {
    // Actor is now known — passes to audit trail via events
    return this.policyService.create(dto, user);
  }

  @Post('simulate')
  @Roles('policy-admin')
  simulate(@Body() dto: SimulatePolicyDto) {
    return this.policyService.simulate(dto);
  }
}
```

### 6. Global Guard Registration

Apply authentication globally so no endpoint is accidentally left unprotected.

```typescript
// backend/src/infrastructure/auth/auth.module.ts

import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaEnrollmentScopeGuard } from './mfa-enrollment-scope.guard';
import { RolesGuard } from './roles.guard';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [
    // Global: every endpoint requires authentication by default
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // An MFA enrollment token only on the routes marked @AllowMfaEnrollmentToken()
    { provide: APP_GUARD, useClass: MfaEnrollmentScopeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AuthModule {}
```

To make specific endpoints public (e.g., `/health`), use a `@Public()` decorator (`/metrics` is not a Nest route and is guarded by `METRICS_TOKEN`; see Public Endpoints below):

```typescript
// backend/src/infrastructure/auth/public.decorator.ts

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Update `JwtAuthGuard` to skip validation when `@Public()` is present:

```typescript
// In JwtAuthGuard.canActivate()
const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
```

---

## Frontend Integration

### OIDC Library

Use `@azure/msal-react` (for Entra ID) or `oidc-client-ts` + `react-oidc-context` (IdP-agnostic). The architecture below uses the agnostic approach.

### Auth Provider Setup

```typescript
// frontend/src/auth/auth-config.ts

export const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY,    // e.g. https://login.microsoftonline.com/{tenant}/v2.0
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  scope: 'openid profile email',
  response_type: 'code',                              // Authorization Code + PKCE
  automaticSilentRenew: true,
};
```

```typescript
// frontend/src/App.tsx (wrap with AuthProvider)

import { AuthProvider } from 'react-oidc-context';
import { oidcConfig } from './auth/auth-config';

function App() {
  return (
    <AuthProvider {...oidcConfig}>
      <AppRoutes />
    </AuthProvider>
  );
}
```

### Protected Routes

```typescript
// frontend/src/auth/ProtectedRoute.tsx

import { useAuth } from 'react-oidc-context';
import { Navigate } from 'react-router-dom';

export function ProtectedRoute({ children, requiredRole }: {
  children: React.ReactNode;
  requiredRole?: string;
}) {
  const auth = useAuth();

  if (auth.isLoading) return <Spin />;
  if (!auth.isAuthenticated) return <Navigate to="/login" />;

  if (requiredRole) {
    const roles = auth.user?.profile?.roles as string[] ?? [];
    if (!roles.includes(requiredRole) && !roles.includes('super-admin')) {
      return <Result status="403" title="Access Denied" />;
    }
  }

  return <>{children}</>;
}
```

### API Client: Attach Token

Sample of the pattern. The real client is `axiosInstance` (`frontend/src/api/data.ts`): it sends the auth cookies (`withCredentials`) and, when `frontend/src/auth/token-store.ts` holds an OIDC access token, a Bearer header.

On a 401 it tries `POST /auth/refresh` once and retries the request; when that fails it calls the auth provider's sign-out (`setOn401`). Every provider's sign-out runs `clearSessionState()` (`frontend/src/auth/session-reset.ts`): it clears the query cache, the installed connector list and the Design studio draft, so a next user signing in without a reload sees none of the previous user's data. A 401 of a sign-in call (`/auth/login`, `/auth/mfa/challenge`, `/auth/saml/exchange`) is a refused credential and goes straight to the caller, with no refresh and no sign-out.

```typescript
// frontend/src/api/client.ts

import { useAuth } from 'react-oidc-context';
import axios from 'axios';

// Create an Axios instance that auto-attaches the Bearer token
export function useApiClient() {
  const auth = useAuth();

  const client = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1',
  });

  client.interceptors.request.use((config) => {
    if (auth.user?.access_token) {
      config.headers.Authorization = `Bearer ${auth.user.access_token}`;
    }
    return config;
  });

  // On 401, trigger silent token renewal or redirect to login
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 401) {
        try {
          await auth.signinSilent();
        } catch {
          auth.signinRedirect();
        }
      }
      return Promise.reject(error);
    },
  );

  return client;
}
```

### Permission Hook (For UI Conditional Rendering)

```typescript
// frontend/src/auth/usePermission.ts

import { useAuth } from 'react-oidc-context';

const ROLE_HIERARCHY: Record<string, string[]> = {
  'super-admin':     ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'],
  'connector-admin': ['connector-admin', 'operator', 'viewer'],
  'policy-admin':    ['policy-admin', 'operator', 'viewer'],
  'operator':        ['operator', 'viewer'],
  'viewer':          ['viewer'],
};

export function usePermission(requiredRole: string): boolean {
  const auth = useAuth();
  const userRoles = (auth.user?.profile?.roles as string[]) ?? [];

  return userRoles.some((role) => {
    const granted = ROLE_HIERARCHY[role] ?? [];
    return granted.includes(requiredRole);
  });
}

// Usage in components:
// const canEditPolicy = usePermission('policy-admin');
// {canEditPolicy && <Button>Edit Policy</Button>}
```

---

## Actor Attribution in Events and Audit

With auth in place, the actor flows automatically:

```
    JWT (sub, email, name)
         │
         ▼
    JwtAuthGuard → request['user']
         │
         ▼
    CorrelationMiddleware → requestContext (AsyncLocalStorage)
         │    sets: { correlationId, actor: user.email }
         │
         ▼
    Service → DomainEventEmitterService.emit()
         │    reads actor from requestContext
         │
         ▼
    AuditEventHandler → audit_logs.actor = "kalle@example.com"
    UserTimelineHandler → user_events.actor = "kalle@example.com"
```

Update the `CorrelationMiddleware` (from infrastructure/OBSERVABILITY_ARCHITECTURE.md) to include the actor:

```typescript
// In correlation.middleware.ts — after JwtAuthGuard has run
export interface RequestContext {
  correlationId: string;
  actor: string;      // user email from JWT, or 'system' for automated
  identityId?: string;
  startTime: number;
}

// In the middleware:
const user = req['user'];
const ctx: RequestContext = {
  correlationId,
  actor: user?.email ?? 'anonymous',
  startTime: Date.now(),
};
```

The actor is never taken from a request body. Request schemas do not accept actor fields, or the controller overwrites them with the authenticated user: `initiatedBy` of bulk provisioning and distributed transactions, `createdBy` of a tenant, `createdBy`/`updatedBy` of an identity (stripped from `POST /identity` and `PATCH /identity/:id`), approvers and reviewers (from `@AuthUser()`). A body value would let a caller record someone else as the actor, and the bulk delete approval compares the approver with `initiatedBy` (segregation of duties).

---

## Environment Configuration

```bash
# backend/.env

# OIDC Configuration
OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_AUDIENCE=euroid-client-id-from-app-registration

# For development: disable auth (never in production)
AUTH_DISABLED=false

# Platform admins (tenant management): comma-separated user ids, see § Platform Admin
PLATFORM_ADMIN_USER_IDS=
```

```bash
# frontend/.env

VITE_OIDC_AUTHORITY=https://login.microsoftonline.com/{tenant-id}/v2.0
VITE_OIDC_CLIENT_ID=euroid-spa-client-id
VITE_API_BASE_URL=http://localhost:3001/api/v1
```

### Development Mode: Bypass Auth

For local development, allow disabling auth with a clear guard:

```typescript
// In JwtAuthGuard.canActivate()
if (this.config.get('AUTH_DISABLED') === 'true') {
  // Inject a dev user so downstream code still has actor context
  request['user'] = {
    sub: 'dev-user',
    email: 'dev@localhost',
    name: 'Developer',
    roles: ['super-admin'],
  };
  return true;
}
```

This ensures:
- All code paths work the same in dev and prod (actor is always present)
- The dev user is a tenant `super-admin`, not a platform admin, unless `PLATFORM_ADMIN_USER_IDS` lists `dev-user`
- No special "skip auth" branches in service code
- The flag is environment-only — cannot be set via API
- It works only when `NODE_ENV` is `development` or `test`; with any other value (`staging`, `pre-prod`, unset) the API refuses to start (`auth.config.ts`)

**Development and test only.** One allow-list decides every development convenience: `isDevOrTest()` (`backend/src/infrastructure/config/runtime-env.ts`) is true only for `NODE_ENV` `development` or `test`. Everything else, `staging`, `pre-prod` and an unset `NODE_ENV` included, gets the production rules: no `AUTH_DISABLED`, no dev tools routes, the first admin only with `SETUP_TOKEN`, auth cookies `secure` (HTTPS), no Swagger UI at `/api/docs`, `/metrics` only with `METRICS_TOKEN`, the API exits on a short or placeholder `JWT_SECRET`, SAML assertions must be signed, `APP_BASE_URL` is required for SAML and SAML users are created only with `SAML_AUTO_CREATE_USER=true`.

---

## 🚨 Emergency "Break-Glass" Protocol

In the event of an OIDC outage (e.g., Azure AD down), the system supports time-limited emergency access without requiring `AUTH_DISABLED=true`.

### Setup (when emergency is needed)

1. **Generate token:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

2. **Set environment variables** (requires API restart):
   ```bash
   EMERGENCY_ADMIN_TOKEN=<hex-output-from-step-1>
   EMERGENCY_TOKEN_VALID_UNTIL=2026-02-18T12:00:00.000Z  # ISO datetime, e.g. 4 hours from now
   ```

3. **Restart the API** so it picks up the new env vars.

### Usage

Send the token in the `X-Emergency-Token` header with any API request:
```bash
curl -H "X-Emergency-Token: <your-token>" https://api.example.com/api/v1/health/ready
```

The emergency user has `super-admin` role and `tenantId` from `DEFAULT_TENANT_ID` (or `dev-tenant`).

### Security

- **Audit:** Every emergency access creates a CRITICAL audit event (`EMERGENCY_ACCESS`) with IP, path, method, and timestamp.
- **Rate limiting:** After 5 failed attempts per IP within 15 minutes, further attempts are rejected.
- **Expiration:** `EMERGENCY_TOKEN_VALID_UNTIL` must be set; expired tokens are rejected. It must be an ISO 8601 date-time: the API refuses to start with a value it cannot read (`auth.config.ts`), and the guard refuses the token if it meets one (`jwt-auth.guard.ts`).

### Cleanup (after resolution)

1. Remove `EMERGENCY_ADMIN_TOKEN` and `EMERGENCY_TOKEN_VALID_UNTIL` from the environment.
2. Restart the API.

---

## 🔐 Token Revocation (Blacklist)

JWTs are stateless, but we enforce revocation via **Session Versioning**.

* **User Schema:** Added `tokenVersion` (int).
* **JWT Claim:** Includes `tokenVersion: <tokenVersion>` (`auth-local.service.ts`, `signJwt`).
* **Guard Logic:** `JwtAuthGuard` refuses a local token whose `tokenVersion` differs from the admin's stored one, or whose admin is inactive (`assertNotRevoked`).
* **Action:** "Revoke All Sessions" increments the user's `tokenVersion` in DB.
* **Freshness:** `JwtAuthGuard` reads `isActive`, `tokenVersion` and `role` from MongoDB on every request with a local token (no cache), so a revocation, password change or deactivation refuses the old token from the next request on, on every instance, and a role change applies from the next request (`backend/src/infrastructure/auth/jwt-auth.guard.ts`, proof: `backend/src/modules/auth/session-revocation.spec.ts`, `jwt-auth.guard.spec.ts`).
* **Tenant status:** `JwtAuthGuard.authenticate` also refuses (403) a token, local or OIDC, whose tenant is suspended or deprovisioned, except a platform admin's (`TenantStatusService`, cached for `TENANT_STATUS_CACHE_MS`); sign-in, the MFA step and refresh refuse it too. See [ARCHITECTURE_MULTI_TENANCY.md](../infrastructure/ARCHITECTURE_MULTI_TENANCY.md) § Suspending a tenant.
* **Database errors:** when the admin or the tenant status cannot be read, the guard answers 503, never 401: a 401 tells the client the session ended.
* **Password guesses per account:** `POST /auth/login` takes an attempt for the address and the client IP (`request.ip`) before it checks the password, an atomic increment in the security state store (`login:failures:<sha256 of the address and the client IP>`) in a window of `LOGIN_LOCKOUT_MINUTES` (15), so a third party guessing from its own address cannot lock the owner out. Past `LOGIN_MAX_FAILURES_PER_ACCOUNT` (10) it answers 429 "Too many failed sign-ins for this account. Try again later." until the window ends, for an unknown address the same as for an account; a correct password clears the count. This adds to the per-IP throttle, which bounds guesses spread over many addresses from one client. A store failure answers 503, as the throttle does.
* **Refresh tokens:** one per admin (`refreshTokenHash`, `REFRESH_TOKEN_EXPIRY_DAYS`, 7 days by default), single-use: `POST /auth/refresh` rotates it only while the presented token is still the stored one, so of two refreshes with one token only one gets a session (`AuthLocalService.refresh`). A sign-in on a second browser or device replaces the first one's token, whose next refresh answers 401 and which signs in again.
* **Sign-out:** `POST /auth/logout` (public) clears the cookies and unsets the refresh token it is sent (the `refresh_token` cookie, or `refresh_token` in the body for an API client), so a copy of that token no longer refreshes. A token that is not the stored one (an older, already rotated one) changes nothing. The access token is not revoked; it ends at `JWT_EXPIRY`.
* **Websockets:** the gateway authenticates a socket on connect and checks it again every `REALTIME_SESSION_RECHECK_MS` (60 s by default; `EventsGateway.recheckSessions`, `JwtAuthGuard.assertStillAllowed`): a socket whose admin was revoked, changed password, was deactivated, or whose tenant was suspended is disconnected. The token's expiry is not checked again (the console does not reconnect a socket the server closed). While the database cannot answer, sockets stay connected.
* **Websocket:** the `/events` gateway runs the same check on connect (`EventsGateway.handleConnection` calls `JwtAuthGuard.authenticate`, OIDC tokens included) and also refuses a token with no role (an MFA enrollment token), so a revoked session, a deactivated admin or a token that can only set up MFA gets no event stream. No event signals a revocation, so a connection that is already open stays open; its next connect is refused (`backend/src/infrastructure/realtime/events.gateway.integration.spec.ts`).

---

## Module Structure

```
backend/src/infrastructure/auth/
├── auth.module.ts           # Global module — registers guards
├── jwt-auth.guard.ts        # Validates JWT signature, expiry, audience
├── roles.guard.ts           # Checks @Roles() decorator against user claims
├── roles.decorator.ts       # @Roles('policy-admin') decorator
├── public.decorator.ts      # @Public() — exempts endpoint from auth
└── auth-user.decorator.ts   # @AuthUser() — extracts user from request

frontend/src/auth/
├── auth-config.ts           # OIDC configuration
├── ProtectedRoute.tsx       # Route wrapper with role check
└── usePermission.ts         # Permission hook for conditional UI
```

---

## Implementation Plan

### Phase 1: Backend Auth Guards (1 day)

| # | Task | Files |
|---|------|-------|
| 1 | Install `jose` (JWT verification library) | `package.json` |
| 2 | Create `infrastructure/auth/` folder with all guard/decorator files | New files |
| 3 | Create `AuthModule` (global) with APP_GUARD registration | New file |
| 4 | Import `AuthModule` in `app.module.ts` | `app.module.ts` |
| 5 | Add `@Public()` to health/metrics endpoints | Health/metrics controllers |
| 6 | Add env vars: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `AUTH_DISABLED` | `.env`, `.env.example` |
| 7 | Update `CorrelationMiddleware` to include actor from JWT | `correlation.middleware.ts` |

### Phase 2: Endpoint Role Annotations (1 day)

| # | Task | Files |
|---|------|-------|
| 1 | Add `@Roles('viewer')` to all GET endpoints | All 12 controllers |
| 2 | Add `@Roles('operator')` to sync/approve/resolve endpoints | Identity, reconciliation, onboarding controllers |
| 3 | Add `@Roles('policy-admin')` to policy CRUD + simulation endpoints | Policy, role-bundles controllers |
| 4 | Add `@Roles('connector-admin')` to blueprint/connector endpoints | Blueprints, connector-config controllers |
| 5 | Add `@Roles('super-admin')` to circuit-breaker override endpoints | Reconciliation controller |
| 6 | Update all mutation endpoints to accept and pass `@AuthUser()` | All controllers with POST/PUT/DELETE |

### Phase 3: Frontend Auth (1 day)

| # | Task | Files |
|---|------|-------|
| 1 | Install `react-oidc-context` (or `@azure/msal-react` for Entra) | `package.json` |
| 2 | Create `auth/` folder with config, ProtectedRoute, usePermission | New files |
| 3 | Wrap `App.tsx` with `AuthProvider` | `App.tsx` |
| 4 | Wrap routes with `ProtectedRoute` | Router config |
| 5 | Update API client to attach Bearer token | API client file |
| 6 | Add role-based UI conditional rendering (hide buttons user can't use) | Key pages |

### Phase 4: IdP Setup (Depends on Chosen Provider)

| # | Task |
|---|------|
| 1 | Register EuroID as an App Registration in Entra ID (or Auth0/Keycloak) |
| 2 | Configure redirect URIs, scopes, app roles |
| 3 | Create app roles: viewer, operator, policy-admin, connector-admin, super-admin |
| 4 | Assign initial users to roles |
| 5 | Update `.env` with real issuer/audience/client IDs |

**Total estimated effort:** 3–4 days (backend + frontend + IdP setup)

---

## Public Endpoints (No Auth Required)

These endpoints are exempt from authentication via `@Public()`:

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Shallow health check (load balancer probe) |
| `GET /health/ready` | Deep health check (readiness probe) |
| `GET /metrics` | Prometheus metrics scraping. Not a Nest route and not `@Public()`: it is registered on the HTTP adapter in `backend/src/main.ts`, outside `/api/v1` and the JWT guard. With `METRICS_TOKEN` set it answers only `Authorization: Bearer <METRICS_TOKEN>` (compared in constant time, `infrastructure/observability/metrics-token.ts`), else 403; without it, it is open in development and test and answers 403 everywhere else |
| `GET /api/docs` | Swagger UI (disable in production or restrict by IP) |
| `GET /api/v1/auth/password-reset/config`, `POST /api/v1/auth/password-reset/request`, `POST /api/v1/auth/password-reset/confirm` | Console admin password reset (§ Platform Admin), rate limited in the shared security state store |
| `POST /api/v1/auth/login`, `register`, `refresh`, `logout`; `GET /api/v1/auth/setup-status` | Local login and session (`auth-local.controller.ts`). `register` creates the first admin (a super-admin) only with `SETUP_TOKEN`, or without one when `NODE_ENV` is `development` or `test` (`first-admin-setup.ts`). First-admin setup stays open until an active super-admin exists: a viewer that SAML JIT created (JIT never grants super-admin) or a deactivated super-admin does not close it, so a SAML-first deployment can still create its super-admin; `setup-status` answers `hasAdminUsers: false` until then. An address that is already an admin account answers 409. After that, only with a valid invite, and it tells whether an address has an account only to the holder of a valid invite for it |
| `POST /api/v1/auth/mfa/challenge` | MFA step of a login (`mfa.controller.ts`) |
| `GET /api/v1/auth/saml/config`, `login`, `metadata`; `POST /api/v1/auth/saml/callback`, `exchange` | SAML login (`saml-auth.controller.ts`) |
| `GET /api/v1/batch-provision/health` | Batch-provision health check |
| `GET /scim/v2/ServiceProviderConfig`, `Schemas`, `ResourceTypes` | SCIM discovery (RFC 7644). `/scim/v2/Users` and `/Groups` skip the JWT guard but require a SCIM bearer token (`@ScimAuth('Users')`, `@ScimAuth('Groups')`) holding the route's scope: `Users:read` or `Groups:read` for GET, `Users:write` or `Groups:write` for POST, PUT, PATCH and DELETE (403 otherwise) |

---

## Related Documents

| Doc | Relevance |
|-----|-----------|
| **[roadmap/ROADMAP.md](../roadmap/ROADMAP.md)** | Prioritized backlog — this doc is the full auth spec |
| **infrastructure/OBSERVABILITY_ARCHITECTURE.md** | Correlation middleware carries actor context |
| **core/EVENT_BUS_ARCHITECTURE.md** | Domain events carry actor from auth context |
| **`frontend/docs/ARCHITECTURE.md`** | Frontend auth integration, route protection |
| **core/SYSTEM_ARCHITECTURE.md** | Security & Compliance section — audit trail requires actor |

---

## TASK_101 Recap: Break-Glass Emergency Access

- `X-Emergency-Token` header grants super-admin when `EMERGENCY_ADMIN_TOKEN` + `EMERGENCY_TOKEN_VALID_UNTIL` set.
- CRITICAL audit event per use; rate limit 5 failures/IP/15min.

---

## TASK_116: SAML 2.0 SSO

### Overview

SAML 2.0 SP-initiated login is supported alongside OIDC and local auth. Uses `@node-saml/node-saml` (no Passport dependency).

### Flow

```
User clicks "Sign in with SSO" → GET /api/v1/auth/saml/login?returnUrl=<path> → binding cookie + 302 to IdP (RelayState)
IdP authenticates → POST /api/v1/auth/saml/callback (SAMLResponse, RelayState)
Validate assertion → RelayState's sign-in → JIT provision user (if new) → MFA gate (as a password sign-in) → one-time code bound to the browser → Redirect to /auth/saml-callback?code=…[&returnUrl=…]
Frontend → POST /api/v1/auth/saml/exchange { code } with the binding cookie → the sign-in answer (session, MFA step or MFA setup token)
```

**The code is bound to the browser that started the sign-in** (`saml-login-state.ts`). The login sets `saml_binding`, a random value in an HttpOnly, `SameSite=Strict` cookie on `/api/v1/auth/saml` (15 minutes), and keeps its SHA-256, with the return path, under a random RelayState id in the security state store. The IdP posts the RelayState back; the callback takes that state (once) and stores the binding hash with the one-time code. The exchange clears the cookie and answers only when the cookie hashes to the code's binding (constant-time compare); any other browser gets 401 "This sign-in was started in another browser", and the code is used up. So a link `/auth/saml-callback?code=<someone else's code>` signs nobody in (login CSRF). The cookie is not read at the callback: that is a cross-site POST from the IdP, which a SameSite cookie does not ride on. A response whose RelayState this deployment did not issue, or issued and saw used, is refused; with `SAML_VALIDATE_IN_RESPONSE_TO=ifPresent` it is accepted as an IdP-initiated sign-in and its code is not bound (an unsolicited response can sign any browser in, so that mode accepts login CSRF).

**The page asked for survives the sign-in.** `returnUrl` is kept only when it is a path of the console (starts with one `/`, no `//`, backslash, colon or control character, at most 2048 characters: the console's `isSafeReturnUrl` rule); the IdP sees only the RelayState id. The callback hands it to `/auth/saml-callback` as `returnUrl`, and the console checks it again with `isSafeReturnUrl` before going there (after the MFA step too).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/v1/auth/saml/config` | Public | Returns `{ enabled, issuer }` |
| GET | `/api/v1/auth/saml/login` | Public | Sets the binding cookie and redirects to the IdP SSO URL; `?returnUrl=` a console path |
| POST | `/api/v1/auth/saml/callback` | Public | Validates the assertion and its RelayState, passes the MFA gate, redirects to the frontend with a one-time code (60 s) and the return path |
| POST | `/api/v1/auth/saml/exchange` | Public | The code's sign-in answer, for the browser with the code's binding cookie only (401 otherwise) |
| GET | `/api/v1/auth/saml/metadata` | Public | Returns SP metadata XML |

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `SAML_ENTRY_POINT` | — | IdP SSO URL (required to enable SAML) |
| `SAML_ISSUER` | `euroid-sp` | SP entity ID |
| `SAML_CERT` | — | IdP signing certificate, base64 (required) |
| `SAML_CALLBACK_URL` | `{APP_BASE_URL}/api/v1/auth/saml/callback` | Assertion Consumer Service URL |
| `SAML_WANT_ASSERTIONS_SIGNED` | `true` | Require signed assertions |
| `SAML_ACCEPTED_CLOCK_SKEW_MS` | `30000` | Clock skew tolerance |
| `SAML_EMAIL_ATTR` | SAML email claim URI | Email attribute name in assertion |
| `SAML_NAME_ATTR` | SAML name claim URI | Display name attribute |
| `SAML_ROLE_ATTR` | — | Role attribute (maps to EuroID roles) |
| `SAML_TENANT_ATTR` | — | Tenant ID attribute |
| `SAML_AUTO_CREATE_USER` | `true` | JIT provision new users on first login |
| `SAML_DEFAULT_ROLE` | `viewer` | Default role for JIT-provisioned users (held to `SAML_JIT_MAX_ROLE`) |
| `SAML_JIT_MAX_ROLE` | `viewer` | The strongest role a JIT-provisioned user gets; `super-admin` is refused (viewer used) |
| `SAML_ALLOWED_TENANT_IDS` | — | Tenants `SAML_TENANT_ATTR` may name, comma-separated; unset: only the default tenant |
| `SAML_VALIDATE_IN_RESPONSE_TO` | `always` | `always`: only responses to this SP's own AuthnRequests (SP-initiated); `ifPresent`: IdP-initiated sign-ins too |

Every response is checked against the AuthnRequest it answers (`InResponseTo`): node-saml keeps the request ids for 15 minutes in the security state store (`SecurityStateSamlCache`, `saml-replay.ts`), so the callback can land on another instance than the login, and removes an id once its response is used. An assertion older than 10 minutes is refused (`maxAssertionAgeMs`), and each assertion id (with its issuer) signs in once: it is counted atomically in the store for that time, so a captured response replayed, or posted twice at once, is refused. With `ifPresent` an unsolicited response is accepted, and only the assertion id check stops its replay. The callback's rate limit (`SAML_CALLBACK_THROTTLE_LIMIT`, `SAML_CALLBACK_THROTTLE_MEDIUM`) is counted across instances (`sharedThrottleKey`).

### JIT Provisioning

On first SAML login, if `SAML_AUTO_CREATE_USER=true`, a new AdminUser is created with `authSource: 'saml'`, a role and tenant within this deployment's limits (below), and no `passwordHash` (the schema requires one for `authSource: 'local'` only). SAML users have no EuroID password: `POST /auth/login` refuses them before any password is compared, `POST /auth/change-password` answers 409, and a password reset is refused (see above). OIDC sign-ins create no `admin_users` row at all. Proof: `backend/src/modules/auth/saml-auth.integration.spec.ts` (real models on in-memory MongoDB).

**Tenant and role of a JIT-provisioned admin** (`saml-jit-policy.ts`, tests `saml-jit-policy.spec.ts`). An IdP admin is not a EuroID admin, so the IdP's attributes are held to what the deployment allows. The tenant is the default tenant (`SAML_DEFAULT_TENANT_ID`, else `DEFAULT_TENANT_ID`), or the one `SAML_TENANT_ATTR` names when it is on `SAML_ALLOWED_TENANT_IDS` (without the list only the default tenant is allowed). A tenant the assertion names must have a `tenants` document with status `active`; the default tenant may have none (a single-tenant deployment) and is refused only when its document is suspended or deprovisioned. A refused tenant creates no admin, and the sign-in fails. The role is the asserted one (`SAML_ROLE_ATTR`), else `SAML_DEFAULT_ROLE`, held to `SAML_JIT_MAX_ROLE` (default `viewer`): the strongest role both grant through the role hierarchy (`roleWithin`, `backend/src/infrastructure/auth/roles.guard.ts`), so `super-admin` above a `connector-admin` cap gives `connector-admin`, and `policy-admin` under it gives `operator`. `super-admin` is never given: as the cap it is refused and `viewer` used. An existing SAML admin keeps the role and tenant stored; assertions never change them (an admin of the tenant changes the role in Admin users).

### Guard Integration

The SAML callback ends in the same step as a password sign-in (`AuthLocalService.completeSignIn`) and issues the same local JWT format (HS256, issuer: `euroid-local`), so JwtAuthGuard treats both alike.

---

## TASK_116: TOTP MFA

### Overview

TOTP-based multi-factor authentication (RFC 6238) with bcrypt-hashed backup codes. MFA secrets encrypted at rest via `EncryptionService` (AES-256-GCM).

### Login Flow with MFA

```
POST /api/v1/auth/login → { mfa_required: true, mfa_token: <5min JWT, iss: euroid-mfa> }
POST /api/v1/auth/mfa/challenge → { code, mfa_token } → Validate TOTP/backup → Issue access_token
```

The MFA pending token uses issuer `euroid-mfa` so JwtAuthGuard (which expects `euroid-local`) naturally rejects it for protected endpoints.

Every code check (`MfaService.validateCode`: the challenge, disable, backup code regeneration) first takes one of 5 attempts of a 15-minute window per admin, an atomic increment in the security state store (`mfa:attempts:<id>`), so a burst of parallel guesses gets at most 5 checks; past them the answer is 429 and a valid code clears the counter. A code proves the factor once: the TOTP step of an accepted code (`mfaLastTotpStep`, the setup code's included) and every earlier step are refused afterwards, and a backup code is removed by a conditional update, so of two requests with one code only one passes. Backup codes are 10 characters of `A-Z2-7` (50 bits) and are read in any case; codes issued before 2026-11-25 have 8 characters and keep working until used or regenerated. The break-glass failure counter per IP is an atomic increment too (`emergency:failures:<ip>`).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/v1/auth/mfa/setup` | Protected | Generate TOTP secret, return QR code |
| POST | `/api/v1/auth/mfa/verify-setup` | Protected | Verify first code, enable MFA, return backup codes |
| POST | `/api/v1/auth/mfa/challenge` | Public | Verify TOTP + MFA token, issue access token |
| POST | `/api/v1/auth/mfa/disable` | Protected | Disable MFA (requires current code) |
| POST | `/api/v1/auth/mfa/backup-codes` | Protected | Regenerate backup codes (requires current code) |
| GET | `/api/v1/auth/mfa/status` | Protected | Returns `{ mfaEnabled, backupCodesRemaining }` |

### Schema Changes (AdminUser)

| Field | Type | Description |
|-------|------|-------------|
| `mfaSecret` | `string?` | TOTP secret, encrypted via EncryptionService |
| `mfaEnabled` | `boolean` | Default `false` |
| `mfaBackupCodes` | `string[]` | Bcrypt hashes of 10 single-use codes |
| `mfaLastTotpStep` | `number?` | The 30-second step of the last accepted TOTP code; it and earlier steps are refused |
| `authSource` | `'local' \| 'saml'` | Default `'local'` |

### Tenant MFA Policy

Tenant `settings.mfaRequired: boolean`. When enabled and the admin has not enrolled MFA, a password sign-in (`POST /auth/login`) and a SAML sign-in (`POST /auth/saml/exchange`) both answer `{ mfa_enrollment_required: true, message, mfa_enrollment_token, user }`: a 5-minute token with scope `mfa-enrollment` and no roles, and no session or cookies. The global `MfaEnrollmentScopeGuard` (right after `JwtAuthGuard`, `backend/src/infrastructure/auth/mfa-enrollment-scope.guard.ts`) accepts that token only on the routes marked `@AllowMfaEnrollmentToken()`: `GET /auth/me`, `GET /auth/mfa/status`, `POST /auth/mfa/setup` and `POST /auth/mfa/verify-setup`. `POST /auth/logout` is public and checks no token. Every other route answers 403 "This sign-in can only set up MFA...", whether or not it needs a role (`POST /auth/change-password`, `POST /auth/mfa/disable` and `POST /auth/mfa/backup-codes` among them). `/mfa/setup` and `/mfa/verify-setup` also refuse any other token without a role (an OIDC token without roles). Tests: `backend/src/infrastructure/auth/mfa-enrollment-scope.guard.spec.ts`. Both go through `AuthLocalService.completeSignIn`. No tenant setting trusts the identity provider's MFA. The sign-in pages keep the token in memory as the access token (no refresh token) and open Account security's MFA setup (`frontend/src/auth/mfa-enrollment.ts`). The session is marked `mfaEnrollmentOnly` in the auth context, so MFA setup is its only page: `MfaEnrollmentGate` shows it without the app layout (whose queries need a role) and sends every other signed-in route back to it, and the sign-in page sends the session there instead of to `/`. When the setup is done the page signs the admin out, and the next sign-in passes the MFA step.

### Emergency Access

The emergency token (`X-Emergency-Token`) bypasses MFA by design — it's a break-glass mechanism.
