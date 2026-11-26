/**
 * Managing a tenant's admin users (the console sign-ins, not managed identities) over HTTP on
 * in-memory MongoDB: a tenant super-admin lists its own tenant's admins with their last sign-in,
 * and nothing that signs anyone in leaves the API (password hashes, MFA secrets and backup codes,
 * refresh token hashes, token versions). A super-admin changes another admin's role (audited). No
 * admin route lets a super-admin lock the tenant out (deactivate or demote themselves, demote the
 * last active super-admin) or act on the deployment's platform admins, and another tenant's id is
 * 404 whatever it is. A password sign-in moves a legacy bcrypt hash to argon2id and refuses a
 * deactivated admin; a refresh token works once, and not once it expired or its admin left. A
 * refresh with the token in its cookie needs no body (main.ts's empty-body middleware).
 */

import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import mongoose, { Model, Types } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcryptjs';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
} from '@infrastructure/cache/security-state.store';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { emptyBodyAsObject } from '@infrastructure/middleware/empty-body.middleware';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { TenantGuard } from '@infrastructure/auth/tenant.guard';
import { authConfig } from '@infrastructure/config/auth.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
import { DomainEventType } from '@infrastructure/events/event-types';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';
import { AdminUsersService } from './admin-users.service';
import { AuthLocalController } from './auth-local.controller';
import { AuthLocalService } from './auth-local.service';
import { InviteService } from './invite.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { AdminUser, AdminUserDocument, AdminUserSchema } from './schemas/admin-user.schema';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PASSWORD = 'ValidPass1!xx';
/** The deployment's platform admin: an account of tenant A named in PLATFORM_ADMIN_USER_IDS. */
const PLATFORM_ADMIN_ID = new Types.ObjectId().toString();

/** Values that sign someone in or prove a second factor: none may reach an answer. */
const SECRETS = {
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2VjcmV0LXNhbHQ$aGFzaC1vZi1wYXNzd29yZA',
  passwordHistory: ['$argon2id$v=19$m=19456,t=2,p=1$b2xkLXNhbHQ$b2xkLWhhc2gtdmFsdWU'],
  mfaSecret: 'euroid:v2:key-1:VE9UUC1TRUNSRVQtQ0lQSEVSVEVYVA',
  mfaBackupCodes: ['$2b$10$backupcodehashbackupcodehashbackupcodehashbac'],
  refreshTokenHash: 'a3f1c9e5b7d2468ac0e9f1b3d5c7a9e1f3b5d7c9e1a3f5b7d9c1e3a5f7b9d1c3',
  passwordResetTokenHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
};

/** Test stand-in for JwtAuthGuard: the caller named in x-test-user. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header);
    return true;
  }
}

@Injectable()
class RequestContextMiddleware implements NestMiddleware {
  private readonly inner = new CorrelationMiddleware();
  use(req: Request, res: Response, next: NextFunction): void {
    this.inner.use(req, res, next);
  }
}

type Caller = { sub: string; email: string; roles: string[]; tenantId: string };

describe('Admin users (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let adminModel: Model<AdminUserDocument>;
  let events: ReturnType<typeof createMockEventEmitter>;
  let mfa: {
    issueMfaPendingToken: jest.Mock;
    verifyMfaPendingToken: jest.Mock;
    validateCode: jest.Mock;
  };
  let ownerA: Caller;
  let ownerB: Caller;
  let operatorA: Caller;
  let platformAdmin: Caller;

  beforeAll(async () => {
    events = createMockEventEmitter();
    // The MFA step of a sign-in: a pending token names the admin, and the code is accepted.
    mfa = {
      issueMfaPendingToken: jest.fn(
        async (user: { _id: unknown }) => `pending:${String(user._id)}`,
      ),
      verifyMfaPendingToken: jest.fn(async (token: string) => ({ sub: token.split(':')[1] })),
      validateCode: jest.fn().mockResolvedValue(true),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: 'test-jwt-secret-thats-at-least-32chars-long' })],
        }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: Tenant.name, schema: TenantSchema },
        ]),
      ],
      controllers: [AuthLocalController, MfaController],
      providers: [
        AuthLocalService,
        AdminUsersService,
        { provide: DomainEventEmitterService, useValue: events },
        { provide: InviteService, useValue: {} },
        { provide: MachineIdentitySyncService, useValue: {} },
        { provide: MfaService, useValue: mfa },
        { provide: SECURITY_STATE_STORE, useValue: new MemorySecurityStateStore() },
        { provide: authConfig.KEY, useValue: { PLATFORM_ADMIN_USER_IDS: PLATFORM_ADMIN_ID } },
        // Same order as AuthModule: authentication, roles, tenant.
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    const contextMiddleware = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      contextMiddleware.use(req, res, next),
    );
    // As main.ts: the auth cookies, and {} for a request without a body
    app.use(cookieParser());
    app.use(emptyBodyAsObject);
    app.useGlobalInterceptors(new TenantContextInterceptor());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    adminModel = moduleRef.get(getModelToken(AdminUser.name));
  });

  beforeEach(async () => {
    const seed = async (fields: Partial<AdminUser> & { _id?: string }): Promise<Caller> => {
      const doc = await adminModel.create({ ...SECRETS, tokenVersion: 7, ...fields });
      return {
        sub: String(doc._id),
        email: doc.email,
        roles: [doc.role],
        tenantId: doc.tenantId,
      };
    };
    ownerA = await seed({
      email: 'owner@tenant-a.example',
      name: 'Olivia Owner',
      role: 'super-admin',
      tenantId: TENANT_A,
      mfaEnabled: true,
    });
    operatorA = await seed({
      email: 'ops@tenant-a.example',
      name: 'Oscar Operator',
      role: 'operator',
      tenantId: TENANT_A,
      authSource: 'saml',
    });
    await seed({
      email: 'left@tenant-a.example',
      name: 'Lena Left',
      role: 'viewer',
      tenantId: TENANT_A,
      isActive: false,
    });
    platformAdmin = await seed({
      _id: PLATFORM_ADMIN_ID,
      email: 'platform@tenant-a.example',
      name: 'Pat Platform',
      role: 'super-admin',
      tenantId: TENANT_A,
    });
    ownerB = await seed({
      email: 'owner@tenant-b.example',
      name: 'Bob Owner',
      role: 'super-admin',
      tenantId: TENANT_B,
    });
  });

  afterEach(async () => {
    await adminModel.deleteMany({});
    events.emit.mockClear();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });
  const listAs = (caller: Caller) =>
    request(app.getHttpServer()).get('/api/v1/auth/users').set(as(caller));

  describe('GET /auth/users', () => {
    it("lists the caller tenant's admins, sorted by email, with role, status and MFA", async () => {
      const res = await listAs(ownerA).expect(200);

      expect(res.body.map((a: { email: string }) => a.email)).toEqual([
        'left@tenant-a.example',
        'ops@tenant-a.example',
        'owner@tenant-a.example',
        'platform@tenant-a.example',
      ]);
      const byEmail = (email: string) => res.body.find((a: { email: string }) => a.email === email);
      expect(byEmail('owner@tenant-a.example')).toEqual({
        id: ownerA.sub,
        email: 'owner@tenant-a.example',
        name: 'Olivia Owner',
        role: 'super-admin',
        isActive: true,
        mfaEnabled: true,
        authSource: 'local',
        isPlatformAdmin: false,
        createdAt: expect.any(String),
        // Never signed in since it was created.
        lastLoginAt: null,
      });
      expect(byEmail('ops@tenant-a.example')).toMatchObject({
        id: operatorA.sub,
        role: 'operator',
        authSource: 'saml',
        mfaEnabled: false,
      });
      expect(byEmail('left@tenant-a.example')).toMatchObject({ isActive: false });
      // The page must not offer a tenant role's actions on the deployment's platform admin.
      expect(byEmail('platform@tenant-a.example')).toMatchObject({
        id: PLATFORM_ADMIN_ID,
        isPlatformAdmin: true,
      });
    });

    it('answers nothing that signs anyone in or proves a second factor', async () => {
      const res = await listAs(ownerA).expect(200);

      const allowed = [
        'id',
        'email',
        'name',
        'role',
        'isActive',
        'mfaEnabled',
        'authSource',
        'isPlatformAdmin',
        'createdAt',
        'lastLoginAt',
      ];
      for (const admin of res.body) {
        expect(Object.keys(admin).sort()).toEqual([...allowed].sort());
      }
      const text = JSON.stringify(res.body);
      for (const value of [
        SECRETS.passwordHash,
        ...SECRETS.passwordHistory,
        SECRETS.mfaSecret,
        ...SECRETS.mfaBackupCodes,
        SECRETS.refreshTokenHash,
        SECRETS.passwordResetTokenHash,
      ]) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toMatch(/tokenVersion|passwordHash|mfaSecret|refreshToken|passwordReset/);
    });

    it("never lists another tenant's admins", async () => {
      const a = await listAs(ownerA).expect(200);
      expect(a.body.map((u: { email: string }) => u.email)).not.toContain('owner@tenant-b.example');

      const b = await listAs(ownerB).expect(200);
      expect(b.body).toEqual([expect.objectContaining({ id: ownerB.sub, name: 'Bob Owner' })]);
    });

    // Every other admin route needs super-admin too: the list carries every admin's email.
    it('needs super-admin', async () => {
      for (const role of ['operator', 'policy-admin', 'connector-admin', 'viewer']) {
        await listAs({ ...operatorA, roles: [role] }).expect(403);
      }
    });
  });

  describe('lockout and platform admins', () => {
    const revoke = (caller: Caller, id: string) =>
      request(app.getHttpServer()).post(`/api/v1/auth/revoke/${id}`).set(as(caller));
    const setActive = (caller: Caller, id: string, isActive: boolean) =>
      request(app.getHttpServer())
        .patch(`/api/v1/auth/users/${id}`)
        .set(as(caller))
        .send({ isActive });
    const stored = (id: string) => adminModel.findById(id).lean();

    // Only a super-admin deactivates: deactivating yourself is one way the last super-admin could
    // leave the tenant with nobody who can reactivate anyone.
    it('refuses deactivating your own account and leaves it as it was', async () => {
      const res = await setActive(ownerA, ownerA.sub, false).expect(400);

      expect(res.body.message).toBe(
        'You cannot deactivate your own account. Another super-admin can.',
      );
      expect(await stored(ownerA.sub)).toMatchObject({ isActive: true, tokenVersion: 7 });
    });

    it('still deactivates and reactivates another admin of the tenant', async () => {
      await setActive(ownerA, operatorA.sub, false).expect(200);
      expect(await stored(operatorA.sub)).toMatchObject({ isActive: false, tokenVersion: 8 });

      await setActive(ownerA, operatorA.sub, true).expect(200);
      expect(await stored(operatorA.sub)).toMatchObject({ isActive: true });
    });

    // An OIDC super-admin (or the break-glass token) has no admin_users row of its own, so the
    // self check does not stop them deactivating the tenant's only active super-admin.
    it("refuses deactivating the tenant's last active super-admin (409) and leaves it active", async () => {
      await adminModel.updateOne({ _id: platformAdmin.sub }, { $set: { role: 'viewer' } });
      const oidcOwner = {
        sub: 'oidc|owner',
        email: 'sso@example.com',
        roles: ['super-admin'],
        tenantId: TENANT_A,
      };

      const res = await setActive(oidcOwner, ownerA.sub, false).expect(409);

      expect(res.body.message).toBe(
        'This is the last active super-admin of the tenant. Make another admin a super-admin first.',
      );
      expect(await stored(ownerA.sub)).toMatchObject({ isActive: true, tokenVersion: 7 });
    });

    it('keeps an active super-admin when two super-admins deactivate each other at once', async () => {
      const seedOwner = async (email: string) => {
        const doc = await adminModel.create({
          ...SECRETS,
          email,
          name: email,
          role: 'super-admin',
          tenantId: 'tenant-d',
        });
        return { sub: String(doc._id), email, roles: ['super-admin'], tenantId: 'tenant-d' };
      };
      const first = await seedOwner('first@tenant-d.example');
      const second = await seedOwner('second@tenant-d.example');

      const results = await Promise.all([
        setActive(first, second.sub, false),
        setActive(second, first.sub, false),
      ]);

      expect(results.map((r) => r.status).every((s) => s === 200 || s === 409)).toBe(true);
      const owners = await adminModel.countDocuments({
        tenantId: 'tenant-d',
        role: 'super-admin',
        isActive: true,
      });
      expect(owners).toBeGreaterThanOrEqual(1);
    });

    it('lets an admin revoke their own sessions: they are signed out, the account stays', async () => {
      await revoke(ownerA, ownerA.sub).expect(201);

      const after = await stored(ownerA.sub);
      expect(after).toMatchObject({ isActive: true, role: 'super-admin', tokenVersion: 8 });
      expect(after?.refreshTokenHash).toBeUndefined();
    });

    // The account is the deployment's (PLATFORM_ADMIN_USER_IDS), not its tenant's.
    it("refuses a tenant super-admin's revoke, deactivation or reactivation of a platform admin", async () => {
      const res = await revoke(ownerA, platformAdmin.sub).expect(403);
      expect(res.body.message).toMatch(/PLATFORM_ADMIN_USER_IDS/);
      await setActive(ownerA, platformAdmin.sub, false).expect(403);
      await setActive(ownerA, platformAdmin.sub, true).expect(403);

      const after = await stored(platformAdmin.sub);
      expect(after).toMatchObject({ isActive: true, tokenVersion: 7 });
      expect(after?.refreshTokenHash).toBe(SECRETS.refreshTokenHash);
    });

    it('lets a platform admin revoke their own sessions but not deactivate themselves', async () => {
      await revoke(platformAdmin, platformAdmin.sub).expect(201);
      expect(await stored(platformAdmin.sub)).toMatchObject({ tokenVersion: 8 });

      await setActive(platformAdmin, platformAdmin.sub, false).expect(400);
      expect(await stored(platformAdmin.sub)).toMatchObject({ isActive: true });
    });

    it('answers 400 for a revoke whose id is not an ObjectId, and changes nothing', async () => {
      const res = await revoke(ownerA, 'not-an-object-id').expect(400);

      expect(res.body.message).toBe('Invalid ID format: not-an-object-id');
      expect(await stored(ownerA.sub)).toMatchObject({ tokenVersion: 7 });
    });

    it("keeps another tenant's admins out of reach (404)", async () => {
      await revoke(ownerB, operatorA.sub).expect(404);
      await setActive(ownerB, operatorA.sub, false).expect(404);
      // The service itself filters by tenant too (deactivation moved here from AuthLocalService).
      const adminUsers = moduleRef.get(AdminUsersService);
      await expect(adminUsers.setActive(operatorA.sub, false, TENANT_B)).resolves.toBeNull();

      expect(await stored(operatorA.sub)).toMatchObject({ isActive: true, tokenVersion: 7 });
    });

    // A 403 would tell another tenant's super-admin that the id is on PLATFORM_ADMIN_USER_IDS.
    it("answers 404 for another tenant's platform admin, like for any id of another tenant", async () => {
      const revoked = await revoke(ownerB, platformAdmin.sub).expect(404);
      expect(revoked.body.message).toBe('Admin user not found');
      await setActive(ownerB, platformAdmin.sub, false).expect(404);
      await request(app.getHttpServer())
        .patch(`/api/v1/auth/users/${platformAdmin.sub}`)
        .set(as(ownerB))
        .send({ role: 'viewer' })
        .expect(404);

      expect(await stored(platformAdmin.sub)).toMatchObject({
        isActive: true,
        role: 'super-admin',
        tokenVersion: 7,
      });
    });
  });

  describe('PATCH /auth/users/:id role', () => {
    const setRole = (caller: object, id: string, role: unknown) =>
      request(app.getHttpServer()).patch(`/api/v1/auth/users/${id}`).set(as(caller)).send({ role });
    const roleOf = async (id: string) => (await adminModel.findById(id).lean())?.role;
    const roleChanges = () =>
      events.emit.mock.calls.filter(([type]) => type === DomainEventType.ADMIN_USER_ROLE_CHANGED);
    /** A super-admin of the tenant who signs in through OIDC: no admin_users row of their own. */
    const oidcOwner = (tenantId: string) => ({
      sub: 'oidc|owner',
      email: 'sso.owner@example.com',
      roles: ['super-admin'],
      tenantId,
    });

    it("changes another admin's role, audits it and lists the new role", async () => {
      const res = await setRole(ownerA, operatorA.sub, 'policy-admin').expect(200);

      expect(res.body).toMatchObject({ id: operatorA.sub, role: 'policy-admin' });
      expect(await roleOf(operatorA.sub)).toBe('policy-admin');
      const list = await listAs(ownerA).expect(200);
      expect(list.body.find((a: { id: string }) => a.id === operatorA.sub).role).toBe(
        'policy-admin',
      );
      // One audit entry, with ids and roles only (no email), valid for the emitter's schema.
      expect(roleChanges()).toHaveLength(1);
      const [, aggregateId, payload] = roleChanges()[0];
      expect(aggregateId).toBe(operatorA.sub);
      expect(payload).toEqual({
        adminUserId: operatorA.sub,
        previousRole: 'operator',
        newRole: 'policy-admin',
        changedBy: ownerA.sub,
      });
      expect(
        getEventSchema(DomainEventType.ADMIN_USER_ROLE_CHANGED).safeParse(payload).success,
      ).toBe(true);
    });

    it('changes nothing and audits nothing when the role is the current one', async () => {
      await setRole(ownerA, operatorA.sub, 'operator').expect(200);

      expect(await roleOf(operatorA.sub)).toBe('operator');
      expect(roleChanges()).toHaveLength(0);
    });

    it('lets a super-admin demote another super-admin while one stays active', async () => {
      const coOwner = await adminModel.create({
        ...SECRETS,
        email: 'co-owner@tenant-a.example',
        name: 'Cora Co-owner',
        role: 'super-admin',
        tenantId: TENANT_A,
      });

      await setRole(ownerA, String(coOwner._id), 'viewer').expect(200);

      expect(await roleOf(String(coOwner._id))).toBe('viewer');
    });

    it('refuses changing your own role and leaves it as it was', async () => {
      const res = await setRole(ownerA, ownerA.sub, 'viewer').expect(400);

      expect(res.body.message).toBe('You cannot change your own role. Another super-admin can.');
      expect(await roleOf(ownerA.sub)).toBe('super-admin');
      expect(roleChanges()).toHaveLength(0);
    });

    it("refuses demoting the tenant's last active super-admin (409)", async () => {
      // Tenant B's only active super-admin; a deactivated one does not count.
      await adminModel.create({
        ...SECRETS,
        email: 'gone@tenant-b.example',
        name: 'Gary Gone',
        role: 'super-admin',
        tenantId: TENANT_B,
        isActive: false,
      });

      const res = await setRole(oidcOwner(TENANT_B), ownerB.sub, 'operator').expect(409);

      expect(res.body.message).toBe(
        'This is the last active super-admin of the tenant. Make another admin a super-admin first.',
      );
      expect(await roleOf(ownerB.sub)).toBe('super-admin');
      expect(roleChanges()).toHaveLength(0);
    });

    it('keeps an active super-admin when two super-admins demote each other at once', async () => {
      const seedOwner = async (email: string) => {
        const doc = await adminModel.create({
          ...SECRETS,
          email,
          name: email,
          role: 'super-admin',
          tenantId: 'tenant-c',
        });
        return { sub: String(doc._id), email, roles: ['super-admin'], tenantId: 'tenant-c' };
      };
      const first = await seedOwner('first@tenant-c.example');
      const second = await seedOwner('second@tenant-c.example');

      const results = await Promise.all([
        setRole(first, second.sub, 'viewer'),
        setRole(second, first.sub, 'viewer'),
      ]);

      expect(results.map((r) => r.status).every((s) => s === 200 || s === 409)).toBe(true);
      const owners = await adminModel.countDocuments({
        tenantId: 'tenant-c',
        role: 'super-admin',
        isActive: true,
      });
      expect(owners).toBeGreaterThanOrEqual(1);
      expect(roleChanges()).toHaveLength(results.filter((r) => r.status === 200).length);
    });

    it("refuses a tenant super-admin's change of a platform admin's role (403)", async () => {
      const res = await setRole(ownerA, platformAdmin.sub, 'viewer').expect(403);

      expect(res.body.message).toMatch(/PLATFORM_ADMIN_USER_IDS/);
      expect(await roleOf(platformAdmin.sub)).toBe('super-admin');
    });

    it("keeps another tenant's admin out of reach (404)", async () => {
      await setRole(ownerB, operatorA.sub, 'viewer').expect(404);

      expect(await roleOf(operatorA.sub)).toBe('operator');
    });

    it('accepts only the five tenant roles', async () => {
      for (const role of ['platform-admin', 'admin', '', 42]) {
        await setRole(ownerA, operatorA.sub, role).expect(400);
      }
      expect(await roleOf(operatorA.sub)).toBe('operator');
    });

    it('needs super-admin', async () => {
      await setRole({ ...operatorA, roles: ['policy-admin'] }, operatorA.sub, 'viewer').expect(403);
    });
  });

  describe('last sign-in', () => {
    const lastLoginOf = async (id: string) => (await adminModel.findById(id).lean())?.lastLoginAt;
    const seedWithPassword = async (email: string, mfaEnabled: boolean) => {
      const doc = await adminModel.create({
        email,
        name: email,
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        role: 'operator',
        tenantId: TENANT_A,
        mfaEnabled,
      });
      return String(doc._id);
    };
    const signIn = (email: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASSWORD });

    it('is recorded when a password sign-in issues a session', async () => {
      const id = await seedWithPassword('pw@tenant-a.example', false);
      const before = Date.now();

      await signIn('pw@tenant-a.example').expect(201);

      const at = await lastLoginOf(id);
      expect(at).toBeInstanceOf(Date);
      expect(at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const list = await listAs(ownerA).expect(200);
      expect(list.body.find((a: { id: string }) => a.id === id).lastLoginAt).toBe(
        at!.toISOString(),
      );
    });

    it('waits for the MFA step: the password alone is not a sign-in', async () => {
      const id = await seedWithPassword('mfa@tenant-a.example', true);

      const first = await signIn('mfa@tenant-a.example').expect(201);
      expect(first.body.mfa_required).toBe(true);
      expect(await lastLoginOf(id)).toBeUndefined();

      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/challenge')
        .send({ mfa_token: first.body.mfa_token, code: '123456' })
        .expect(201);
      expect(await lastLoginOf(id)).toBeInstanceOf(Date);
    });

    // SamlAuthService.handleCallback issues the session through issueTokensForUser, like the MFA
    // challenge (saml-auth.service.spec.ts covers that call).
    it('is recorded by the session issue that the MFA challenge and the SAML callback share', async () => {
      await moduleRef.get(AuthLocalService).issueTokensForUser(operatorA.sub);

      expect(await lastLoginOf(operatorA.sub)).toBeInstanceOf(Date);
    });

    it('is not touched by a failed sign-in or a token refresh', async () => {
      const id = await seedWithPassword('quiet@tenant-a.example', false);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'quiet@tenant-a.example', password: 'WrongPass1!xx' })
        .expect(401);
      expect(await lastLoginOf(id)).toBeUndefined();

      const signedIn = await signIn('quiet@tenant-a.example').expect(201);
      const firstAt = (await lastLoginOf(id))!.getTime();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: signedIn.body.refresh_token })
        .expect(201);
      expect((await lastLoginOf(id))!.getTime()).toBe(firstAt);
    });
  });

  describe('password sign-in and refresh', () => {
    const http = () => request(app.getHttpServer());
    const signIn = (email: string, password = PASSWORD) =>
      http().post('/api/v1/auth/login').send({ email, password });
    const refresh = (refreshToken: string) =>
      http().post('/api/v1/auth/refresh').send({ refresh_token: refreshToken });
    const seed = async (email: string, passwordHash?: string) => {
      const doc = await adminModel.create({
        email,
        name: email,
        passwordHash: passwordHash ?? (await argon2.hash(PASSWORD, { type: argon2.argon2id })),
        role: 'operator',
        tenantId: TENANT_A,
      });
      return String(doc._id);
    };
    const storedOf = async (id: string) => (await adminModel.findById(id).lean())!;

    it('moves a legacy bcrypt hash to argon2id at sign-in, and signs in with it after', async () => {
      const id = await seed('legacy@tenant-a.example', await bcrypt.hash(PASSWORD, 10));

      await signIn('legacy@tenant-a.example').expect(201);

      const { passwordHash } = await storedOf(id);
      expect(passwordHash).toMatch(/^\$argon2id\$/);
      expect(await argon2.verify(passwordHash!, PASSWORD)).toBe(true);
      await signIn('legacy@tenant-a.example').expect(201);
      await signIn('legacy@tenant-a.example', 'WrongPass1!xx').expect(401);
    });

    // The sign-in schema applied the password policy, so an account whose password predates the
    // policy answered 400 and could not sign in at all.
    it('signs in with a password set before the policy, and answers 401 (not 400) to a wrong one', async () => {
      await seed('old@tenant-a.example', await argon2.hash('short', { type: argon2.argon2id }));

      await signIn('old@tenant-a.example', 'short').expect(201);
      await signIn('old@tenant-a.example', 'nope').expect(401);
    });

    it('refuses a deactivated admin both a sign-in and a refresh of an earlier session', async () => {
      const id = await seed('gone@tenant-a.example');
      const session = await signIn('gone@tenant-a.example').expect(201);
      // Deactivated in the database, the refresh token still stored.
      await adminModel.updateOne({ _id: id }, { $set: { isActive: false } });

      await signIn('gone@tenant-a.example').expect(401);
      await refresh(session.body.refresh_token).expect(401);
    });

    it('refuses an expired refresh token and forgets it', async () => {
      const id = await seed('late@tenant-a.example');
      const session = await signIn('late@tenant-a.example').expect(201);
      await adminModel.updateOne(
        { _id: id },
        { $set: { refreshTokenExpiresAt: new Date(Date.now() - 1000) } },
      );

      const res = await refresh(session.body.refresh_token).expect(401);

      expect(res.body.message).toBe('Refresh token expired');
      const stored = await storedOf(id);
      expect(stored.refreshTokenHash).toBeUndefined();
      expect(stored.refreshTokenExpiresAt).toBeUndefined();
    });

    // The token in the httpOnly cookie, as the console refreshes: Express 5 leaves req.body
    // undefined, and the body DTO (refresh_token optional) answered 400 without main.ts's middleware
    it('refreshes from the cookie alone, with no body', async () => {
      await seed('cookie@tenant-a.example');
      const first = (await signIn('cookie@tenant-a.example').expect(201)).body.refresh_token;

      const res = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${first}`)
        .expect(201);

      expect(res.body.access_token).toEqual(expect.any(String));
      expect(res.body.refresh_token).not.toBe(first);
      await refresh(first).expect(401);
    });

    it('rotates the refresh token: the used one stops working, the new one works once', async () => {
      await seed('rotate@tenant-a.example');
      const first = (await signIn('rotate@tenant-a.example').expect(201)).body.refresh_token;

      const second = (await refresh(first).expect(201)).body.refresh_token;

      expect(second).not.toBe(first);
      await refresh(first).expect(401);
      await refresh(second).expect(201);
      await refresh(second).expect(401);
    });

    // A refresh token is single-use: of two refreshes that present it at once (a stolen copy
    // racing its owner), one gets a new session and the other 401.
    it('lets only one of two simultaneous refreshes with one token through', async () => {
      await seed('race@tenant-a.example');
      const token = (await signIn('race@tenant-a.example').expect(201)).body.refresh_token;

      const results = await Promise.all([refresh(token), refresh(token), refresh(token)]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 401, 401]);
      const winner = results.find((r) => r.status === 201)!;
      await refresh(winner.body.refresh_token).expect(201);
    });

    // One refresh slot per admin (documented): a sign-in elsewhere replaces the first browser's.
    it("a second sign-in replaces the first browser's refresh token", async () => {
      await seed('twice@tenant-a.example');
      const first = (await signIn('twice@tenant-a.example').expect(201)).body.refresh_token;
      const second = (await signIn('twice@tenant-a.example').expect(201)).body.refresh_token;

      await refresh(first).expect(401);
      await refresh(second).expect(201);
    });

    // A refresh token stolen before the sign-out must not keep the session alive for 7 days.
    it('signing out ends the refresh token in the cookie: it no longer refreshes', async () => {
      const id = await seed('leaving@tenant-a.example');
      const token = (await signIn('leaving@tenant-a.example').expect(201)).body.refresh_token;

      const res = await http()
        .post('/api/v1/auth/logout')
        .set('Cookie', `refresh_token=${token}`)
        .expect(201);

      expect(res.body).toEqual({ success: true });
      expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);
      expect((await storedOf(id)).refreshTokenHash).toBeUndefined();
      await refresh(token).expect(401);
    });

    it('signing out with the refresh token in the body (an API client) ends it too', async () => {
      await seed('api@tenant-a.example');
      const token = (await signIn('api@tenant-a.example').expect(201)).body.refresh_token;

      await http().post('/api/v1/auth/logout').send({ refresh_token: token }).expect(201);

      await refresh(token).expect(401);
    });

    it("signing out with another session's old token leaves the current session alone", async () => {
      await seed('two@tenant-a.example');
      const old = (await signIn('two@tenant-a.example').expect(201)).body.refresh_token;
      const current = (await refresh(old).expect(201)).body.refresh_token;

      await http().post('/api/v1/auth/logout').set('Cookie', `refresh_token=${old}`).expect(201);
      // Without a token at all, signing out only clears the cookies.
      await http().post('/api/v1/auth/logout').expect(201);

      await refresh(current).expect(201);
    });
  });
});
