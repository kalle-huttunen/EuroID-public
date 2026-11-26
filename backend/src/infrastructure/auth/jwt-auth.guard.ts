import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  UnauthorizedException,
  ServiceUnavailableException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Reflector } from '@nestjs/core';
import { Model } from 'mongoose';
import { Request } from 'express';
import * as crypto from 'crypto';

/** The user a bearer token signs in (JwtAuthGuard.authenticate), as request.user holds it. */
export interface AuthenticatedUser {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  tenantId: string;
  scope?: string;
  /** A local token's tokenVersion (none for OIDC): assertStillAllowed compares it later. */
  tokenVersion?: number;
}

/** Request with JWT user payload attached by JwtAuthGuard */
type RequestWithUser = Request & { user?: AuthenticatedUser };
import * as jose from 'jose';
import { IS_PUBLIC_KEY } from './public.decorator';
import { getRequestContext } from '../middleware/get-request-context';
import { AdminUser, AdminUserDocument } from '../../modules/auth/schemas/admin-user.schema';
import { AuditService } from '../../modules/audit/audit.service';

import { SECURITY_STATE_STORE, type SecurityStateStore } from '../cache/security-state.store';
import { TenantStatusService } from '../multi-tenancy/tenant-status.service';
import { isPlatformAdmin, parsePlatformAdminIds } from './platform-admin';
import { isDevOrTest } from '../config/runtime-env';

/** The admin fields the guard reads: a revoked local token is refused, the role is the current one. */
const ADMIN_REVOCATION_FIELDS = 'isActive tokenVersion role';
const EMERGENCY_RATE_LIMIT_COUNT = 5;
const EMERGENCY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** Failures per IP (security state increment); a new key, so counters of the old format expire. */
const EMERGENCY_FAILED_PREFIX = 'emergency:failures:';

const createDevUser = (tenantId: string) => ({
  sub: 'dev-user',
  email: 'dev@localhost',
  name: 'Developer',
  roles: ['super-admin'],
  tenantId,
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUserDocument>,
    private readonly auditService: AuditService,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
    private readonly tenantStatus: TenantStatusService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // 1. Check @Public() — exempt from auth
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // 2. Check emergency token (break-glass)
    const emergencyUser = await this.checkEmergencyToken(request);
    if (emergencyUser) {
      request.user = emergencyUser;
      this.setActorInContext(request);
      return true;
    }

    // 4. Check AUTH_DISABLED — only allowed in development/test (allowlist, not blocklist)
    const authDisabledAllowed = isDevOrTest(this.config.get<string>('NODE_ENV') ?? '');
    if (authDisabledAllowed && this.config.get('AUTH_DISABLED') === 'true') {
      request.user = createDevUser(this.config.get('DEV_TENANT_ID') || 'dev-tenant');
      this.setActorInContext(request);
      return true;
    }

    // 5. Normal flow: validate Bearer token
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('No bearer token provided');
    }

    request.user = await this.authenticate(token);
    this.setActorInContext(request);
    return true;
  }

  /**
   * The user `token` signs in, or UnauthorizedException: a local token (issuer euroid-local, this
   * API's audience) of an active admin whose tokenVersion is current, with the admin's role now;
   * else, when OIDC_ISSUER is set, a token of that issuer. A tenant that is not active (suspended,
   * deprovisioned) is refused with 403, except for a platform admin (PLATFORM_ADMIN_USER_IDS), who
   * manages tenants. The websocket gateway runs it on connect and again on a timer.
   */
  async authenticate(token: string): Promise<AuthenticatedUser> {
    const user = (await this.authenticateLocal(token)) ?? (await this.authenticateOidc(token));
    if (!isPlatformAdmin(user, parsePlatformAdminIds(this.config.get('PLATFORM_ADMIN_USER_IDS')))) {
      await this.unlessUnavailable(() => this.tenantStatus.assertActive(user.tenantId));
    }
    return user;
  }

  /**
   * The user of a local token, or null when `token` is not one (no JWT_SECRET, another issuer or
   * audience, a bad signature): the caller then tries OIDC. Once the token verifies, a revoked
   * token is 401 and a database error 503; neither falls through to OIDC.
   */
  private async authenticateLocal(token: string): Promise<AuthenticatedUser | null> {
    const secretVal = this.config.get('JWT_SECRET');
    if (!secretVal) return null;
    let payload: jose.JWTPayload;
    try {
      const audience = this.config.get<string>('JWT_AUDIENCE') || 'euroid-api';
      ({ payload } = await jose.jwtVerify(token, new TextEncoder().encode(secretVal), {
        issuer: 'euroid-local',
        audience,
      }));
    } catch {
      return null; // Not a local token: fall through to OIDC
    }
    const sub = payload.sub as string;
    const tokenVersion = (payload.tokenVersion as number) ?? 0;
    const admin = await this.unlessUnavailable(() => this.assertNotRevoked(sub, tokenVersion));
    const scope = payload.scope as string | undefined;

    return {
      sub,
      email: (payload.email as string) ?? sub,
      name: (payload.name as string) ?? (payload.email as string) ?? sub,
      // The admin's role now, not the one the token was signed with: a role change applies
      // from the next request. A scoped token (MFA enrollment) keeps its empty roles.
      roles: scope ? ((payload.roles as string[]) ?? []) : [admin.role ?? 'viewer'],
      tenantId: (payload.tenantId as string) ?? '',
      scope,
      tokenVersion,
    };
  }

  /**
   * Whether a user that authenticate() let in may still use EuroID, without the token: a local
   * token's admin is still active with the same tokenVersion (no revocation, password change or
   * deactivation since), and the tenant is still active (a platform admin passes). 401 or 403
   * when not, 503 when the database cannot say. The websocket gateway runs it on a timer.
   */
  async assertStillAllowed(user: AuthenticatedUser): Promise<void> {
    const { tokenVersion } = user;
    if (tokenVersion !== undefined) {
      await this.unlessUnavailable(() => this.assertNotRevoked(user.sub, tokenVersion));
    }
    if (!isPlatformAdmin(user, parsePlatformAdminIds(this.config.get('PLATFORM_ADMIN_USER_IDS')))) {
      await this.unlessUnavailable(() => this.tenantStatus.assertActive(user.tenantId));
    }
  }

  private async authenticateOidc(token: string): Promise<AuthenticatedUser> {
    const issuer = this.config.get('OIDC_ISSUER');
    if (issuer) {
      try {
        const jwks = this.getJwks();
        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer,
          audience: this.config.get('OIDC_AUDIENCE'),
          clockTolerance: 30,
        });
        const tenantClaim = this.config.get('JWT_TENANT_CLAIM') || 'tenantId';
        return {
          sub: payload.sub as string,
          email: (payload.email as string) ?? (payload.preferred_username as string) ?? payload.sub,
          name: (payload.name as string) ?? (payload.email as string) ?? payload.sub,
          roles: (payload.roles as string[]) ?? [],
          tenantId: (payload[tenantClaim] as string) ?? '',
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(`OIDC token validation failed: ${message}`);
        throw new UnauthorizedException('Invalid token');
      }
    }

    throw new UnauthorizedException('Invalid token');
  }

  /**
   * Runs a database check: an HTTP answer it gives (401, 403) passes through, any other error
   * (MongoDB unreachable) is 503. A 401 would tell the client its session ended and sign it out.
   */
  private async unlessUnavailable<T>(check: () => Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sign-in check failed, answering 503: ${message}`);
      throw new ServiceUnavailableException(
        'Sign-in checks are temporarily unavailable. Try again later.',
      );
    }
  }

  /**
   * Refuses a local token whose admin is gone or deactivated, or whose tokenVersion is not the
   * admin's current one (revokeAllSessions, a password change or reset and a deactivation
   * increment it), and returns the admin's current role. Read from the database on every request,
   * never from a cache: a cached copy could outlive the revocation or a role change, when a
   * request re-cached the old value while the change ran, or when the changing instance could not
   * reach Redis to drop the copy that other instances read. One indexed _id read with a
   * projection, about what the Redis read it replaces cost.
   */
  private async assertNotRevoked(
    sub: string,
    tokenVersion: number,
  ): Promise<Pick<AdminUser, 'role'>> {
    const adminUser = await this.adminUserModel
      .findById(sub, ADMIN_REVOCATION_FIELDS)
      .lean<Pick<AdminUser, 'isActive' | 'tokenVersion' | 'role'>>();
    if (!adminUser || !adminUser.isActive || (adminUser.tokenVersion ?? 0) !== tokenVersion) {
      throw new UnauthorizedException('Token revoked or user deactivated');
    }
    return adminUser;
  }

  private setActorInContext(request: RequestWithUser): void {
    const ctx = getRequestContext();
    if (ctx && request.user) {
      ctx.actor = request.user.email;
    }
  }

  private getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
    if (!this.jwks) {
      const issuer = this.config.get<string>('OIDC_ISSUER');
      if (!issuer) {
        throw new UnauthorizedException('OIDC_ISSUER not configured');
      }
      const jwksUrl = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
      this.jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
    }
    return this.jwks;
  }

  private extractToken(request: Request): string | undefined {
    // FA-1: Prefer httpOnly cookie over Authorization header (browser clients)
    const cookies = (request as Request & { cookies?: { access_token?: string } }).cookies;
    if (cookies?.access_token) {
      return cookies.access_token;
    }
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return undefined;
  }

  /** Use request.ip (respects Express trust proxy); avoid raw X-Forwarded-For to prevent spoofing. */
  private getClientIp(request: Request): string {
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * One more failed emergency token attempt from `ip`, counted atomically (concurrent failures
   * each count) in a fixed window of EMERGENCY_RATE_LIMIT_WINDOW_MS from the first one.
   */
  private async recordEmergencyFailure(ip: string): Promise<void> {
    await this.securityState.increment(
      `${EMERGENCY_FAILED_PREFIX}${ip}`,
      EMERGENCY_RATE_LIMIT_WINDOW_MS,
    );
  }

  private async isEmergencyRateLimited(ip: string): Promise<boolean> {
    // A store failure rejects (503): the emergency token is refused, never let past its limit.
    const count = await this.securityState.get<number>(`${EMERGENCY_FAILED_PREFIX}${ip}`);
    return (count ?? 0) >= EMERGENCY_RATE_LIMIT_COUNT;
  }

  private async checkEmergencyToken(request: Request): Promise<{
    sub: string;
    email: string;
    name: string;
    roles: string[];
    tenantId: string;
  } | null> {
    const token = this.config.get<string>('EMERGENCY_ADMIN_TOKEN');
    if (!token) return null;

    const headerToken = request.headers['x-emergency-token'];
    const provided = typeof headerToken === 'string' ? headerToken : undefined;
    if (!provided) return null;

    const ip = this.getClientIp(request);
    if (await this.isEmergencyRateLimited(ip)) {
      throw new UnauthorizedException('Too many failed emergency token attempts. Try again later.');
    }

    const validUntil = this.config.get<string>('EMERGENCY_TOKEN_VALID_UNTIL');
    if (!validUntil) {
      await this.recordEmergencyFailure(ip);
      throw new UnauthorizedException(
        'Emergency token requires EMERGENCY_TOKEN_VALID_UNTIL to be set',
      );
    }
    // A date that cannot be read is NaN, and Date.now() > NaN is false: fail closed instead.
    const expiry = new Date(validUntil).getTime();
    if (!Number.isFinite(expiry) || Date.now() > expiry) {
      await this.recordEmergencyFailure(ip);
      throw new UnauthorizedException('Emergency token has expired');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest();
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    if (
      tokenHash.length !== providedHash.length ||
      !crypto.timingSafeEqual(tokenHash, providedHash)
    ) {
      await this.recordEmergencyFailure(ip);
      throw new UnauthorizedException('Invalid emergency token');
    }

    const tenantId = this.config.get('DEFAULT_TENANT_ID') || this.config.get('DEV_TENANT_ID');
    if (!tenantId) {
      await this.recordEmergencyFailure(ip);
      throw new UnauthorizedException(
        'Emergency token requires DEFAULT_TENANT_ID or DEV_TENANT_ID to be set. Do not use hardcoded fallbacks in production.',
      );
    }

    this.logger.warn(
      `[EMERGENCY_ACCESS] Break-glass access used from IP ${ip} for ${request.method} ${request.path}`,
    );
    await this.auditService.log({
      action: 'EMERGENCY_ACCESS',
      severity: 'critical',
      actor: 'emergency-admin',
      resourceType: 'auth',
      resourceId: 'emergency',
      resourceName: 'Emergency Access',
      description: 'Break-glass emergency access used',
      payload: {
        metadata: {
          ip,
          path: request.path,
          method: request.method,
          timestamp: new Date().toISOString(),
        },
      },
      tenantId,
    });

    return {
      sub: 'emergency-admin',
      email: 'emergency-admin',
      name: 'Emergency Admin',
      roles: ['super-admin'],
      tenantId,
    };
  }
}

// --- TASK_100: isActive + tokenVersion validation for local JWTs (2.0cb: read from the database on every request, no cache; 2.10: the role too). TASK_101: Emergency token (X-Emergency-Token), CRITICAL audit, rate limit 5/15min.
