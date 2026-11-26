import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Public } from './public.decorator';
import {
  MemorySecurityStateStore,
  SecurityStateUnavailableError,
} from '../cache/security-state.store';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';

jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => ({})),
}));

const mockAdminUserModel = {
  findById: jest.fn().mockReturnValue({
    lean: () =>
      Promise.resolve({
        _id: 'admin-123',
        isActive: true,
        tokenVersion: 0,
      }),
  }),
};

const mockAuditService = {
  log: jest.fn().mockResolvedValue(undefined),
};

/** Tenants by status; a tenant not listed has no tenants document (active). */
const tenantStatuses = new Map<string, string>();
const mockTenantStatus = {
  assertActive: jest.fn(async (tenantId: string) => {
    const status = tenantStatuses.get(tenantId);
    if (status && status !== 'active') throw new ForbiddenException('This tenant is suspended.');
  }),
};

const mockCache = {
  get: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

/** Handlers as a controller declares them: the guard reads the real @Public() metadata. */
class ProbeController {
  @Public()
  open() {}

  closed() {}
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let configService: jest.Mocked<ConfigService>;
  let reflector: Reflector;

  beforeEach(() => {
    configService = {
      get: jest.fn(),
    } as any;
    reflector = new Reflector();
    mockAdminUserModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'admin-123',
          isActive: true,
          tokenVersion: 0,
        }),
    });
    mockAuditService.log.mockClear().mockResolvedValue(undefined);
    mockCache.get.mockResolvedValue(undefined);
    tenantStatuses.clear();
    mockTenantStatus.assertActive.mockClear();
    guard = new JwtAuthGuard(
      configService,
      reflector,
      mockAdminUserModel as any,
      mockAuditService as any,
      mockCache as any,
      mockTenantStatus as any,
    );
  });

  function createMockContext(
    headers: Record<string, string> = {},
    isPublic = false,
  ): ExecutionContext {
    const request = { headers, user: undefined as any };

    return {
      getHandler: () => ProbeController.prototype[isPublic ? 'open' : 'closed'],
      getClass: () => ProbeController,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('should allow @Public() endpoints without token', async () => {
    const ctx = createMockContext({}, true);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    // The same request on a handler without @Public() needs a token.
    configService.get.mockReturnValue(undefined);
    await expect(guard.canActivate(createMockContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('should allow access when AUTH_DISABLED=true (dev mode)', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'NODE_ENV') return 'development';
      if (key === 'AUTH_DISABLED') return 'true';
      if (key === 'DEV_TENANT_ID') return 'dev-tenant';
      return undefined;
    });

    const ctx = createMockContext({});
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);

    const request = ctx.switchToHttp().getRequest();
    expect(request.user).toBeDefined();
    expect(request.user.email).toBe('dev@localhost');
    expect(request.user.roles).toContain('super-admin');
    expect(request.user.tenantId).toBe('dev-tenant');
  });

  // AUTH_DISABLED is honoured in development and test only; production, and an unset NODE_ENV
  // (read as production), still needs a token.
  it.each([['production'], [undefined]])(
    'refuses a request without a token when AUTH_DISABLED=true and NODE_ENV is %s',
    async (nodeEnv) => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'NODE_ENV') return nodeEnv;
        if (key === 'AUTH_DISABLED') return 'true';
        if (key === 'DEV_TENANT_ID') return 'dev-tenant';
        return undefined;
      });

      const ctx = createMockContext({});
      await expect(guard.canActivate(ctx)).rejects.toThrow('No bearer token provided');
      expect(ctx.switchToHttp().getRequest().user).toBeUndefined();
    },
  );

  it('should throw UnauthorizedException when no Bearer token', async () => {
    configService.get.mockReturnValue(undefined);
    const ctx = createMockContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException for malformed Authorization header', async () => {
    configService.get.mockReturnValue(undefined);
    const ctx = createMockContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException for invalid JWT when Bearer token provided', async () => {
    const jose = await import('jose');
    (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new Error('Invalid token'));

    configService.get.mockImplementation((key: string) => {
      if (key === 'AUTH_DISABLED') return undefined;
      if (key === 'OIDC_ISSUER') return 'https://login.microsoftonline.com/test-tenant/v2.0';
      if (key === 'OIDC_AUDIENCE') return 'test-audience';
      return undefined;
    });

    const ctx = createMockContext({ authorization: 'Bearer fake-jwt-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // Break-glass access (X-Emergency-Token): a super-admin of DEFAULT_TENANT_ID, audited as
  // critical, while EMERGENCY_TOKEN_VALID_UNTIL lies ahead. Failures count per IP in the security
  // state store; the fifth within 15 minutes locks the IP out, a correct token included.
  describe('the emergency token', () => {
    const TOKEN = 'break-glass-token';
    const IP = '203.0.113.7';
    let store: MemorySecurityStateStore;
    let env: Record<string, string | undefined>;
    let emergencyGuard: JwtAuthGuard;

    beforeEach(() => {
      store = new MemorySecurityStateStore();
      env = {
        EMERGENCY_ADMIN_TOKEN: TOKEN,
        EMERGENCY_TOKEN_VALID_UNTIL: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        DEFAULT_TENANT_ID: 'tenant-a',
      };
      configService.get.mockImplementation((key: string) => env[key]);
      emergencyGuard = new JwtAuthGuard(
        configService,
        reflector,
        mockAdminUserModel as never,
        mockAuditService as never,
        store,
        mockTenantStatus as never,
      );
    });

    const withToken = (token: string) => {
      const ctx = createMockContext({ 'x-emergency-token': token });
      Object.assign(ctx.switchToHttp().getRequest(), {
        ip: IP,
        method: 'POST',
        path: '/api/v1/identity',
      });
      return ctx;
    };
    const failures = async () => (await store.get<number>(`emergency:failures:${IP}`)) ?? 0;

    it('signs in a super-admin of the default tenant and audits it as critical', async () => {
      const ctx = withToken(TOKEN);

      await expect(emergencyGuard.canActivate(ctx)).resolves.toBe(true);

      expect(ctx.switchToHttp().getRequest().user).toEqual({
        sub: 'emergency-admin',
        email: 'emergency-admin',
        name: 'Emergency Admin',
        roles: ['super-admin'],
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'EMERGENCY_ACCESS',
          severity: 'critical',
          tenantId: 'tenant-a',
          payload: {
            metadata: expect.objectContaining({ ip: IP, method: 'POST', path: '/api/v1/identity' }),
          },
        }),
      );
      expect(await failures()).toBe(0);
    });

    it('refuses a correct token once its window has passed, and counts the attempt', async () => {
      env.EMERGENCY_TOKEN_VALID_UNTIL = new Date(Date.now() - 1000).toISOString();

      await expect(emergencyGuard.canActivate(withToken(TOKEN))).rejects.toThrow(
        'Emergency token has expired',
      );
      expect(await failures()).toBe(1);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    // A date that cannot be read (31.12.2026) gave NaN, and Date.now() > NaN is false: the
    // token never expired. It fails closed now.
    it.each(['31.12.2026', 'not a date'])(
      'refuses a correct token when the window is %s, and counts the attempt',
      async (value) => {
        env.EMERGENCY_TOKEN_VALID_UNTIL = value;

        await expect(emergencyGuard.canActivate(withToken(TOKEN))).rejects.toThrow(
          'Emergency token has expired',
        );
        expect(await failures()).toBe(1);
        expect(mockAuditService.log).not.toHaveBeenCalled();
      },
    );

    it('refuses a correct token when no window is configured, and counts the attempt', async () => {
      env.EMERGENCY_TOKEN_VALID_UNTIL = undefined;

      await expect(emergencyGuard.canActivate(withToken(TOKEN))).rejects.toThrow(
        'Emergency token requires EMERGENCY_TOKEN_VALID_UNTIL to be set',
      );
      expect(await failures()).toBe(1);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('refuses a wrong token and counts each attempt', async () => {
      const ctx = withToken('guess');
      await expect(emergencyGuard.canActivate(ctx)).rejects.toThrow('Invalid emergency token');
      await expect(emergencyGuard.canActivate(withToken('guess'))).rejects.toThrow(
        'Invalid emergency token',
      );

      expect(await failures()).toBe(2);
      expect(ctx.switchToHttp().getRequest().user).toBeUndefined();
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    // Read-then-write counting lost the failures of a parallel burst (each read 0, wrote 1).
    it('counts every failure of a parallel burst, and locks the IP out after it', async () => {
      const burst = Array.from({ length: 8 }, (_, i) =>
        emergencyGuard.canActivate(withToken(`guess-${i}`)).catch((e: Error) => e.message),
      );

      expect(await Promise.all(burst)).toEqual(Array(8).fill('Invalid emergency token'));
      expect(await failures()).toBe(8);
      await expect(emergencyGuard.canActivate(withToken(TOKEN))).rejects.toThrow(
        'Too many failed emergency token attempts',
      );
    });

    it('still lets a correct token in after four failures', async () => {
      for (let i = 1; i <= 4; i++) {
        await expect(emergencyGuard.canActivate(withToken(`guess-${i}`))).rejects.toThrow(
          'Invalid emergency token',
        );
      }

      await expect(emergencyGuard.canActivate(withToken(TOKEN))).resolves.toBe(true);
    });

    it('locks the IP out after five failures in 15 minutes, a correct token included', async () => {
      for (let i = 1; i <= 5; i++) {
        await expect(emergencyGuard.canActivate(withToken(`guess-${i}`))).rejects.toThrow(
          'Invalid emergency token',
        );
      }

      await expect(emergencyGuard.canActivate(withToken(TOKEN))).rejects.toThrow(
        'Too many failed emergency token attempts',
      );
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  describe('while the security state store is down', () => {
    const down = createUnavailableSecurityStateStore();

    beforeEach(() => {
      mockCache.get.mockImplementation((key: string) => down.get(key));
      mockCache.set.mockImplementation((key: string, value: unknown, ttl: number) =>
        down.set(key, value, ttl),
      );
    });

    afterEach(() => {
      mockCache.set.mockReset().mockResolvedValue(undefined);
    });

    it('refuses even a correct emergency token when its failure counter cannot be read', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'EMERGENCY_ADMIN_TOKEN') return 'break-glass-token';
        if (key === 'EMERGENCY_TOKEN_VALID_UNTIL') return '2999-01-01T00:00:00Z';
        if (key === 'DEFAULT_TENANT_ID') return 'tenant-a';
        return undefined;
      });
      const ctx = createMockContext({ 'x-emergency-token': 'break-glass-token' });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(SecurityStateUnavailableError);
      expect(mockAuditService.log).not.toHaveBeenCalled();
      expect(ctx.switchToHttp().getRequest().user).toBeUndefined();
    });

    describe('a local token', () => {
      beforeEach(async () => {
        const jose = await import('jose');
        (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
          payload: { sub: 'admin-123', tokenVersion: 0, roles: ['operator'], tenantId: 't-1' },
        });
        configService.get.mockImplementation((key: string) =>
          key === 'JWT_SECRET' ? 'test-secret' : undefined,
        );
      });

      it('is checked against the database: a deactivated admin is refused', async () => {
        mockAdminUserModel.findById.mockReturnValue({
          lean: () => Promise.resolve({ _id: 'admin-123', isActive: false, tokenVersion: 0 }),
        });
        const ctx = createMockContext({ authorization: 'Bearer local-jwt' });

        await expect(guard.canActivate(ctx)).rejects.toThrow('Token revoked or user deactivated');
      });

      it('of an active admin still passes', async () => {
        const ctx = createMockContext({ authorization: 'Bearer local-jwt' });

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(mockAdminUserModel.findById).toHaveBeenCalledWith(
          'admin-123',
          'isActive tokenVersion role',
        );
      });
    });
  });

  describe('a local token whose sessions are revoked', () => {
    beforeEach(async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockReset().mockResolvedValue({
        payload: { sub: 'admin-123', tokenVersion: 0, roles: ['operator'], tenantId: 't-1' },
      });
      configService.get.mockImplementation((key: string) =>
        key === 'JWT_SECRET' ? 'test-secret' : undefined,
      );
      mockCache.get.mockClear();
      mockCache.set.mockClear();
      mockAdminUserModel.findById.mockClear();
    });

    afterEach(async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockReset();
    });

    it('is refused on the next request: the guard reads tokenVersion from the database each time', async () => {
      const admin = { _id: 'admin-123', isActive: true, tokenVersion: 0 };
      mockAdminUserModel.findById.mockImplementation(() => ({
        lean: () => Promise.resolve({ ...admin }),
      }));
      const request = () => createMockContext({ authorization: 'Bearer local-jwt' });

      await expect(guard.canActivate(request())).resolves.toBe(true);
      admin.tokenVersion = 1; // revokeAllSessions, a password change or a deactivation
      await expect(guard.canActivate(request())).rejects.toThrow(
        'Token revoked or user deactivated',
      );

      // Nothing was cached that could outlive the revocation.
      expect(mockAdminUserModel.findById).toHaveBeenCalledTimes(2);
      expect(mockCache.get).not.toHaveBeenCalled();
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  // PATCH /auth/users/:id changes the role in the database; the token keeps the role it was
  // signed with until it expires, so the guard takes the role from the database on every request.
  describe('the role of a local token', () => {
    const admin = { _id: 'admin-123', isActive: true, tokenVersion: 0, role: 'super-admin' };
    const userOf = async (payload: Record<string, unknown>) => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({ payload });
      const ctx = createMockContext({ authorization: 'Bearer local-jwt' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      return ctx.switchToHttp().getRequest().user;
    };

    beforeEach(() => {
      admin.role = 'super-admin';
      configService.get.mockImplementation((key: string) =>
        key === 'JWT_SECRET' ? 'test-secret' : undefined,
      );
      mockAdminUserModel.findById.mockImplementation(() => ({
        lean: () => Promise.resolve({ ...admin }),
      }));
    });

    it('is the one in the database: a changed role applies from the next request', async () => {
      const token = { sub: 'admin-123', tokenVersion: 0, roles: ['super-admin'], tenantId: 't-1' };
      expect((await userOf(token)).roles).toEqual(['super-admin']);

      admin.role = 'viewer'; // PATCH /auth/users/admin-123 { role: 'viewer' }

      expect((await userOf(token)).roles).toEqual(['viewer']);
    });

    it('stays empty for a scoped MFA enrollment token, whatever the database holds', async () => {
      const user = await userOf({
        sub: 'admin-123',
        tokenVersion: 0,
        roles: [],
        scope: 'mfa-enrollment',
        tenantId: 't-1',
      });

      expect(user.roles).toEqual([]);
      expect(user.scope).toBe('mfa-enrollment');
    });
  });

  // A suspended tenant (DELETE /tenants/:id, PATCH status suspended) is refused on every request.
  describe('the tenant of a token', () => {
    const localToken = { sub: 'admin-123', tokenVersion: 0, roles: ['operator'], tenantId: 't-1' };
    const request = () => createMockContext({ authorization: 'Bearer some-jwt' });
    let env: Record<string, string | undefined>;

    beforeEach(async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockReset();
      env = { JWT_SECRET: 'test-secret' };
      configService.get.mockImplementation((key: string) => env[key]);
    });

    afterEach(async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockReset();
    });

    it('refuses a local token of a suspended tenant with 403', async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload: localToken });
      tenantStatuses.set('t-1', 'suspended');

      await expect(guard.canActivate(request())).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockTenantStatus.assertActive).toHaveBeenCalledWith('t-1');

      tenantStatuses.set('t-1', 'active');
      await expect(guard.canActivate(request())).resolves.toBe(true);
    });

    it('refuses an OIDC token of a suspended tenant with 403', async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock)
        .mockRejectedValueOnce(new Error('signature verification failed')) // not a local token
        .mockResolvedValueOnce({
          payload: { sub: 'oidc-user', roles: ['viewer'], tenantId: 't-1' },
        });
      env.OIDC_ISSUER = 'https://idp.example.com';
      tenantStatuses.set('t-1', 'suspended');

      await expect(guard.canActivate(request())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a platform admin of a suspended tenant through, so tenants stay manageable', async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload: localToken });
      tenantStatuses.set('t-1', 'suspended');
      env.PLATFORM_ADMIN_USER_IDS = 'admin-123';

      await expect(guard.canActivate(request())).resolves.toBe(true);
    });

    // A database error is not a bad token: 503, so the client does not sign the user out.
    it('answers 503 when the admin cannot be read, never 401', async () => {
      const jose = await import('jose');
      (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload: localToken });
      env.OIDC_ISSUER = 'https://idp.example.com';
      mockAdminUserModel.findById.mockReturnValue({
        lean: () => Promise.reject(new Error('connection pool closed')),
      });

      await expect(guard.canActivate(request())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});

// --- TASK_100: Added mockAdminUserModel, mockAuditService for guard constructor (4 deps).
