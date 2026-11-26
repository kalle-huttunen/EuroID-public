/**
 * Platform admin is granted by deployment configuration (PLATFORM_ADMIN_USER_IDS) only.
 * Every tenant has its own super-admin, so tenant management (/tenants) must refuse it, and
 * nothing a tenant controls (first-user setup, invites, the token's role claims) may grant
 * platform admin.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import * as jose from 'jose';
import { RolesGuard } from './roles.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PLATFORM_ADMIN_ROLE, isPlatformAdmin, parsePlatformAdminIds } from './platform-admin';
import { authConfig } from '../config/auth.config';
import { TenantController } from '../multi-tenancy/tenant.controller';
import { TenantService } from '../multi-tenancy/tenant.service';
import { AuthLocalService } from '../../modules/auth/auth-local.service';
import { MemorySecurityStateStore } from '../cache/security-state.store';
import { InviteService } from '../../modules/auth/invite.service';
import { AuthLocalController } from '../../modules/auth/auth-local.controller';
import { AdminUsersService } from '../../modules/auth/admin-users.service';

const PLATFORM_ADMIN_ID = 'platform-admin-1';

/** A tenant's first user: super-admin of tenant-a, not on the platform admin list. */
const tenantSuperAdmin = {
  sub: 'tenant-a-admin',
  email: 'admin@tenant-a.example',
  roles: ['super-admin'],
  tenantId: 'tenant-a',
};
const platformAdmin = {
  sub: PLATFORM_ADMIN_ID,
  email: 'ops@platform.example',
  roles: ['viewer'],
  tenantId: 'tenant-ops',
};

function guardFor(ids: string | undefined, required: string[]) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
  const guard = new RolesGuard(reflector, { PLATFORM_ADMIN_USER_IDS: ids });
  return (user: unknown) =>
    guard.canActivate({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);
}

describe('platform admin allow-list', () => {
  it('parses comma-separated user ids and ignores blanks', () => {
    expect([...parsePlatformAdminIds(' a , ,b,')]).toEqual(['a', 'b']);
    expect(parsePlatformAdminIds(undefined).size).toBe(0);
  });

  it('matches the authenticated user id only', () => {
    const ids = parsePlatformAdminIds(PLATFORM_ADMIN_ID);
    expect(isPlatformAdmin(platformAdmin, ids)).toBe(true);
    expect(isPlatformAdmin(tenantSuperAdmin, ids)).toBe(false);
    expect(isPlatformAdmin(undefined, ids)).toBe(false);
  });
});

describe('RolesGuard and platform-admin', () => {
  const requirePlatformAdmin = guardFor(PLATFORM_ADMIN_ID, [PLATFORM_ADMIN_ROLE]);

  it('refuses a tenant super-admin', () => {
    expect(() => requirePlatformAdmin(tenantSuperAdmin)).toThrow(ForbiddenException);
  });

  it('refuses a token that claims the platform-admin role (IdP or forged claim)', () => {
    expect(() =>
      requirePlatformAdmin({ ...tenantSuperAdmin, roles: [PLATFORM_ADMIN_ROLE] }),
    ).toThrow(ForbiddenException);
  });

  it('allows a user on the allow-list, whatever its tenant roles', () => {
    expect(requirePlatformAdmin(platformAdmin)).toBe(true);
  });

  it('allows nobody when the allow-list is not configured', () => {
    expect(() => guardFor(undefined, [PLATFORM_ADMIN_ROLE])(platformAdmin)).toThrow(
      ForbiddenException,
    );
  });

  it('gives a platform admin no tenant role it does not hold', () => {
    expect(() => guardFor(PLATFORM_ADMIN_ID, ['super-admin'])(platformAdmin)).toThrow(
      ForbiddenException,
    );
  });
});

describe('/tenants over HTTP', () => {
  let app: INestApplication;
  const tenantService = {
    create: jest.fn(async (d: object) => d),
    findAll: jest.fn(async () => []),
    findById: jest.fn(async (id: string) => ({ tenantId: id })),
    update: jest.fn(async (id: string) => ({ tenantId: id })),
    suspend: jest.fn(async (id: string) => ({ tenantId: id, status: 'suspended' })),
    migrateDatabase: jest.fn(async () => ({ migrated: 0 })),
  };

  /** Stand-in for JwtAuthGuard: the test names the authenticated user in a header. */
  const testAuth: CanActivate = {
    canActivate: (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(req.headers['x-test-user'] as string);
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TenantController],
      providers: [
        { provide: TenantService, useValue: tenantService },
        { provide: authConfig.KEY, useValue: { PLATFORM_ADMIN_USER_IDS: PLATFORM_ADMIN_ID } },
        // AuthModule's global guards, as in the app: the controller declares none of its own.
        { provide: APP_GUARD, useValue: testAuth },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const routes: Array<[string, (agent: request.Agent) => request.Test]> = [
    ['POST /tenants', (a) => a.post('/tenants').send({ tenantId: 'tenant-c', name: 'C' })],
    ['GET /tenants', (a) => a.get('/tenants')],
    ['GET /tenants/:id', (a) => a.get('/tenants/tenant-b')],
    ['PATCH /tenants/:id', (a) => a.patch('/tenants/tenant-b').send({ name: 'Renamed' })],
    ['DELETE /tenants/:id (suspend)', (a) => a.delete('/tenants/tenant-b')],
    [
      'POST /tenants/migrate',
      (a) => a.post('/tenants/migrate').send({ targetTenantId: 'tenant-b' }),
    ],
  ];

  it.each(routes)('%s: a tenant super-admin gets 403 and nothing runs', async (_name, call) => {
    const agent = request
      .agent(app.getHttpServer())
      .set('x-test-user', JSON.stringify(tenantSuperAdmin));

    await call(agent).expect(403);

    for (const fn of Object.values(tenantService)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(routes)('%s: the platform admin is allowed', async (_name, call) => {
    const agent = request
      .agent(app.getHttpServer())
      .set('x-test-user', JSON.stringify(platformAdmin));

    const res = await call(agent);

    expect(res.status).toBeLessThan(300);
  });

  const asPlatformAdmin = () =>
    request.agent(app.getHttpServer()).set('x-test-user', JSON.stringify(platformAdmin));

  it.each(['', '   ', 'acme corp', 'acme"', '-acme', 'a'.repeat(65)])(
    'refuses the tenant id %p with 400 and creates nothing',
    async (tenantId) => {
      await asPlatformAdmin().post('/tenants').send({ tenantId, name: 'C' }).expect(400);
      expect(tenantService.create).not.toHaveBeenCalled();
    },
  );

  // A string "false" was stored and read as true, turning MFA on for the whole tenant.
  it.each([{ mfaRequired: 'false' }, { retentionDays: '30' }, { maxIdentities: -1 }])(
    'refuses the setting %p with 400 and changes nothing',
    async (settings) => {
      await asPlatformAdmin().patch('/tenants/tenant-b').send({ settings }).expect(400);
      expect(tenantService.update).not.toHaveBeenCalled();
    },
  );

  it('migrate previews unless the body says dryRun false', async () => {
    await asPlatformAdmin().post('/tenants/migrate').send({ targetTenantId: 'tenant-b' });
    await asPlatformAdmin()
      .post('/tenants/migrate')
      .send({ targetTenantId: 'tenant-b', dryRun: false });

    expect(tenantService.migrateDatabase.mock.calls).toEqual([
      ['tenant-b', true],
      ['tenant-b', false],
    ]);
  });

  // The global guards already run; declaring them again ran the token check twice per request.
  it('declares no JWT or role guard of its own', () => {
    const declared = Reflect.getMetadata(GUARDS_METADATA, TenantController) ?? [];
    expect(declared).not.toContain(JwtAuthGuard);
    expect(declared).not.toContain(RolesGuard);
  });

  it('records the authenticated platform admin as creator, never a body createdBy', async () => {
    await request(app.getHttpServer())
      .post('/tenants')
      .set('x-test-user', JSON.stringify(platformAdmin))
      .send({ tenantId: 'tenant-c', name: 'C', createdBy: 'someone-else@example.com' })
      .expect(201);

    expect(tenantService.create).toHaveBeenCalledWith({
      tenantId: 'tenant-c',
      name: 'C',
      createdBy: 'ops@platform.example',
    });
  });
});

/**
 * The UI shows tenant management only to a platform admin, so GET /auth/me reports it. The
 * server decides it from PLATFORM_ADMIN_USER_IDS; nothing in the token grants it.
 */
describe('GET /auth/me isPlatformAdmin', () => {
  async function meApp(platformAdminIds: string | undefined) {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthLocalController],
      providers: [
        { provide: AuthLocalService, useValue: {} },
        { provide: AdminUsersService, useValue: {} },
        { provide: authConfig.KEY, useValue: { PLATFORM_ADMIN_USER_IDS: platformAdminIds } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    // Stand-in for JwtAuthGuard: the authenticated user is the one the test names.
    app.use(
      (
        req: { headers: Record<string, string>; user?: unknown },
        _res: unknown,
        next: () => void,
      ) => {
        req.user = JSON.parse(req.headers['x-test-user']);
        next();
      },
    );
    await app.init();
    return app;
  }

  async function me(app: INestApplication, user: object) {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('x-test-user', JSON.stringify(user))
      .expect(200);
    return res.body;
  }

  let app: INestApplication;

  beforeAll(async () => {
    app = await meApp(PLATFORM_ADMIN_ID);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is true for a user on the allow-list, whatever its tenant role', async () => {
    expect(await me(app, platformAdmin)).toMatchObject({
      sub: PLATFORM_ADMIN_ID,
      roles: ['viewer'],
      isPlatformAdmin: true,
    });
  });

  it('is false for a tenant super-admin, and for a token that claims the role', async () => {
    expect((await me(app, tenantSuperAdmin)).isPlatformAdmin).toBe(false);
    expect(
      (await me(app, { ...tenantSuperAdmin, roles: [PLATFORM_ADMIN_ROLE], isPlatformAdmin: true }))
        .isPlatformAdmin,
    ).toBe(false);
  });

  it('is false for everyone when the allow-list is not configured', async () => {
    const unconfigured = await meApp(undefined);
    try {
      expect((await me(unconfigured, platformAdmin)).isPlatformAdmin).toBe(false);
    } finally {
      await unconfigured.close();
    }
  });
});

describe('tenant setup never grants platform admin', () => {
  const JWT_SECRET = 'test-jwt-secret-thats-at-least-32chars-long';

  it("the first registered user's token is a tenant super-admin that /tenants refuses", async () => {
    const created = {
      _id: { toString: () => 'first-user-id' },
      email: 'first@tenant-a.example',
      name: 'First',
      role: 'super-admin',
      tenantId: 'tenant-a',
      tokenVersion: 0,
    };
    const adminModel = {
      // issueTokensForUser reads the new account back (no admins yet: no address check).
      findOne: jest.fn().mockResolvedValue(created),
      countDocuments: jest.fn().mockResolvedValue(0),
      findOneAndUpdate: jest.fn().mockResolvedValue(created),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const config = {
      get: (key: string) =>
        ({
          JWT_SECRET,
          JWT_EXPIRY: '1h',
          DEFAULT_TENANT_ID: 'tenant-a',
          REFRESH_TOKEN_EXPIRY_DAYS: '7',
          NODE_ENV: 'test', // first-admin setup without SETUP_TOKEN: development and test only
        })[key],
    };
    type Ctor = ConstructorParameters<typeof AuthLocalService>;
    const service = new AuthLocalService(
      adminModel as unknown as Ctor[0],
      { findOne: jest.fn().mockResolvedValue(null) } as unknown as Ctor[1], // no tenants document
      config as unknown as Ctor[2],
      { syncAdminToIdentity: jest.fn().mockResolvedValue(undefined) } as unknown as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      new MemorySecurityStateStore(),
    );

    const { user } = await service.register({
      email: 'first@tenant-a.example',
      password: 'ValidPass1!xx',
      name: 'First',
    });
    const { access_token } = await service.issueTokensForUser(user.id);
    const { payload } = await jose.jwtVerify(access_token, new TextEncoder().encode(JWT_SECRET), {
      issuer: 'euroid-local',
    });

    expect(user.role).toBe('super-admin');
    expect(payload.roles).toEqual(['super-admin']);
    // Even with an allow-list configured, the new account is not on it.
    const requirePlatformAdmin = guardFor(PLATFORM_ADMIN_ID, [PLATFORM_ADMIN_ROLE]);
    expect(() =>
      requirePlatformAdmin({ sub: payload.sub, roles: payload.roles, tenantId: 'tenant-a' }),
    ).toThrow(ForbiddenException);
  });

  it('an invite cannot carry platform-admin', async () => {
    const invites = new InviteService(
      { create: jest.fn() } as never,
      { emit: jest.fn() } as never,
      { exists: jest.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      invites.createInvite(
        'x@tenant-a.example',
        [PLATFORM_ADMIN_ROLE],
        '507f1f77bcf86cd799439011',
        'tenant-a',
      ),
    ).rejects.toThrow('At least one valid role is required');
  });
});
