/**
 * AuthModule's global guards over HTTP in AuthModule's order (JwtAuthGuard, MfaEnrollmentScopeGuard,
 * RolesGuard, TenantGuard), with the real jose and the admin read from in-memory MongoDB. Other
 * HTTP specs stand in for JwtAuthGuard with a header, and jest.config.ts maps 'jose' to a stand-in
 * that ignores exp, nbf and alg; here an expired, foreign or forged token meets the code that
 * refuses it in production, and a session token a sign-in issued meets the whole chain.
 */
import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { Model } from 'mongoose';
import * as jose from 'jose';
import * as request from 'supertest';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { AuditService } from '../../modules/audit/audit.service';
import { AuthLocalService } from '../../modules/auth/auth-local.service';
import {
  AdminUser,
  AdminUserDocument,
  AdminUserSchema,
} from '../../modules/auth/schemas/admin-user.schema';
import { MemorySecurityStateStore, SECURITY_STATE_STORE } from '../cache/security-state.store';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaEnrollmentScopeGuard } from './mfa-enrollment-scope.guard';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';
import { TenantGuard } from './tenant.guard';
import { Tenant, TenantSchema } from '../multi-tenancy/schemas/tenant.schema';
import {
  TENANT_INACTIVE_MESSAGE,
  TenantStatusModule,
  TenantStatusService,
} from '../multi-tenancy/tenant-status.service';

jest.mock('jose', () => jest.requireActual('@testing/real-jose').loadRealJose());

const JWT_SECRET = 'test-jwt-secret-thats-at-least-32chars-long';
const TENANT = 'tenant-a';

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request & { user?: unknown }) {
    return req.user;
  }

  @Roles('super-admin')
  @Get('admin')
  admin() {
    return { ok: true };
  }
}

describe('AuthModule guards over HTTP (real jose)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let adminModel: Model<AdminUserDocument>;
  let tenantModel: Model<Tenant>;
  let adminId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET, NODE_ENV: 'test' })],
        }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: Tenant.name, schema: TenantSchema },
        ]),
        TenantStatusModule,
      ],
      controllers: [ProbeController],
      providers: [
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: SECURITY_STATE_STORE, useValue: new MemorySecurityStateStore() },
        // AuthModule's order: authentication, MFA enrollment scope, roles, tenant.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: MfaEnrollmentScopeGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    adminModel = moduleRef.get(getModelToken(AdminUser.name));
    tenantModel = moduleRef.get(getModelToken(Tenant.name));
  });

  beforeEach(async () => {
    const admin = await adminModel.create({
      email: 'vera@tenant-a.example',
      name: 'Vera Viewer',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      role: 'viewer',
      tenantId: TENANT,
    });
    adminId = String(admin._id);
  });

  afterEach(async () => {
    await adminModel.deleteMany({});
    await tenantModel.deleteMany({});
    moduleRef.get(TenantStatusService).forget(TENANT);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  /** The access token a completed sign-in issues (AuthLocalService, as login and MFA do). */
  const sessionToken = async () => {
    const auth = new AuthLocalService(
      adminModel,
      tenantModel as never,
      moduleRef.get(ConfigService),
      {} as never,
      {} as never,
      {} as never,
      new MemorySecurityStateStore(),
    );
    return (await auth.issueTokensForUser(adminId)).access_token;
  };

  /** A local token with the claims AuthLocalService signs, each part replaceable. */
  const localToken = async (
    opts: {
      claims?: Record<string, unknown>;
      issuer?: string;
      audience?: string;
      secret?: string;
      expiresAt?: number | string;
    } = {},
  ) =>
    new jose.SignJWT({
      sub: adminId,
      roles: ['viewer'],
      tenantId: TENANT,
      tokenVersion: 0,
      ...opts.claims,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(opts.expiresAt ?? '1h')
      .setIssuer(opts.issuer ?? 'euroid-local')
      .setAudience(opts.audience ?? 'euroid-api')
      .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));

  describe('the token check', () => {
    it("accepts a sign-in's session token, with the admin's current role", async () => {
      const token = await sessionToken();
      const me = await get('/probe/me', token).expect(200);
      expect(me.body).toMatchObject({ sub: adminId, roles: ['viewer'], tenantId: TENANT });

      // Promoted after the sign-in: the same token gets the role the database holds now.
      await adminModel.updateOne({ _id: adminId }, { $set: { role: 'super-admin' } });
      await get('/probe/admin', token).expect(200);
    });

    it.each<[string, () => Promise<string>]>([
      ['an expired token', () => localToken({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
      ['a token for another audience', () => localToken({ audience: 'another-api' })],
      ['a token of another issuer', () => localToken({ issuer: 'euroid-mfa' })],
      ['a token signed with another secret', () => localToken({ secret: `${JWT_SECRET}-other` })],
      [
        'an unsigned token (alg none)',
        async () =>
          new jose.UnsecuredJWT({ sub: adminId, roles: ['super-admin'], tenantId: TENANT })
            .setIssuedAt()
            .setExpirationTime('1h')
            .setIssuer('euroid-local')
            .setAudience('euroid-api')
            .encode(),
      ],
    ])('refuses %s with 401', async (_name, tokenOf) => {
      const res = await get('/probe/me', await tokenOf()).expect(401);
      expect(res.body.message).toBe('Invalid token');
    });

    it('accepts the same claims signed correctly (the refusals above are the token, not the claims)', async () => {
      await get('/probe/me', await localToken()).expect(200);
    });
  });

  describe('the guard chain', () => {
    it('answers 401 to a request without a token, and lets it reach a @Public() route', async () => {
      await get('/probe/me').expect(401);
      await get('/probe/open').expect(200, { ok: true });
    });

    it("answers 403 to a viewer's token on a super-admin route", async () => {
      const res = await get('/probe/admin', await sessionToken()).expect(403);
      expect(res.body.message).toBe('Requires one of: super-admin');
    });

    it('answers 403 to a token without a role on a route that needs one', async () => {
      // A scoped token keeps the roles it was signed with (none); the guard takes no role from
      // the database for it.
      const token = await localToken({ claims: { roles: [], scope: 'reporting' } });
      await get('/probe/me', token).expect(200);

      const res = await get('/probe/admin', token).expect(403);
      expect(res.body.message).toBe('Requires one of: super-admin');
    });

    it('answers 403 to a token without a tenant', async () => {
      const token = await localToken({ claims: { tenantId: undefined } });
      const res = await get('/probe/me', token).expect(403);
      expect(res.body.message).toMatch(/Tenant context is required/);
    });

    it('answers 403 to a token of a suspended tenant', async () => {
      const token = await sessionToken();
      await get('/probe/me', token).expect(200);
      // As TenantService.suspend does on the instance that suspends: the cached status is dropped.
      await tenantModel.create({ tenantId: TENANT, name: 'Tenant A', status: 'suspended' });
      moduleRef.get(TenantStatusService).forget(TENANT);

      const res = await get('/probe/me', token).expect(403);
      expect(res.body.message).toBe(TENANT_INACTIVE_MESSAGE);
    });

    it('answers 403 to an MFA enrollment token outside the MFA setup routes', async () => {
      const token = await localToken({ claims: { roles: [], scope: 'mfa-enrollment' } });
      const res = await get('/probe/me', token).expect(403);
      expect(res.body.message).toMatch(/can only set up MFA/);
    });
  });
});
