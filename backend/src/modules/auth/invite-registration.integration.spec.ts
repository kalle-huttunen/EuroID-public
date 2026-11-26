/**
 * Invite flow over HTTP on in-memory MongoDB with the tenant plugin: a tenant super-admin
 * invites, the invitee registers through the public POST /auth/register, and the new admin
 * lands in the inviting tenant with the invited role. The tenant and role come from the stored
 * invite only, never from the registration body; the invite is single-use and expires. The
 * super-admin lists the tenant's pending invites (never their codes) and cancels one. An address
 * with an account in the tenant is refused when invited; one with an account in another tenant is
 * not revealed to the inviter, and the invitee learns it at registration.
 */

import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
} from '@infrastructure/cache/security-state.store';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import mongoose, { Model } from 'mongoose';
import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
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
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { MfaService } from './mfa.service';
import { AdminUser, AdminUserDocument, AdminUserSchema } from './schemas/admin-user.schema';
import { Invite, InviteDocument, InviteSchema } from './schemas/invite.schema';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PASSWORD = 'ValidPass1!xx';

/** Test stand-in for JwtAuthGuard: the caller named in x-test-user, none on public routes. */
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

describe('Invite registration (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let adminModel: Model<AdminUserDocument>;
  let inviteModel: Model<InviteDocument>;
  let events: ReturnType<typeof createMockEventEmitter>;
  let ownerA: { sub: string; email: string; roles: string[]; tenantId: string };
  let ownerB: { sub: string; email: string; roles: string[]; tenantId: string };

  beforeAll(async () => {
    events = createMockEventEmitter();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DEFAULT_TENANT_ID: 'default-tenant' })],
        }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: Invite.name, schema: InviteSchema },
          { name: Tenant.name, schema: TenantSchema },
        ]),
      ],
      controllers: [AuthLocalController, InviteController],
      providers: [
        AuthLocalService,
        AdminUsersService,
        InviteService,
        { provide: DomainEventEmitterService, useValue: events },
        {
          provide: MachineIdentitySyncService,
          useValue: { syncAdminToIdentity: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: MfaService, useValue: {} },
        { provide: CACHE_MANAGER, useValue: { del: jest.fn() } },
        { provide: SECURITY_STATE_STORE, useValue: new MemorySecurityStateStore() },
        { provide: authConfig.KEY, useValue: { PLATFORM_ADMIN_USER_IDS: 'platform-ops' } },
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
    app.useGlobalInterceptors(new TenantContextInterceptor());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    adminModel = moduleRef.get(getModelToken(AdminUser.name));
    inviteModel = moduleRef.get(getModelToken(Invite.name));
  });

  beforeEach(async () => {
    // Each tenant's first admin, so registration is never first-user setup.
    const seed = async (tenantId: string) => {
      const doc = await adminModel.create({
        email: `owner@${tenantId}.example`,
        passwordHash: 'not-used',
        name: 'Owner',
        role: 'super-admin',
        tenantId,
      });
      return { sub: String(doc._id), email: doc.email, roles: ['super-admin'], tenantId };
    };
    ownerA = await seed(TENANT_A);
    ownerB = await seed(TENANT_B);
  });

  afterEach(async () => {
    await adminModel.deleteMany({});
    await inviteModel.deleteMany({}, { skipTenantScope: true });
    events.emit.mockClear();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

  async function invite(
    inviter: object,
    body: Record<string, unknown>,
  ): Promise<{ token: string; expiresAt: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/invites')
      .set(as(inviter))
      .send(body)
      .expect(201);
    return res.body;
  }

  function register(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ password: PASSWORD, name: 'New Admin', ...body });
  }

  it('registers the invitee into the inviting tenant with the invited role', async () => {
    const { token } = await invite(ownerA, {
      email: 'new.admin@tenant-a.example',
      roles: ['operator'],
    });

    const res = await register({ email: 'new.admin@tenant-a.example', inviteToken: token });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'new.admin@tenant-a.example',
      role: 'operator',
      tenantId: TENANT_A,
    });
    const stored = await adminModel.findOne({ email: 'new.admin@tenant-a.example' }).lean();
    expect(stored).toMatchObject({ role: 'operator', tenantId: TENANT_A, isActive: true });
    const used = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(used?.usedAt).toBeInstanceOf(Date);
  });

  it('ignores a tenant or role named in the registration body', async () => {
    const { token } = await invite(ownerA, { email: 'viewer@tenant-a.example', roles: ['viewer'] });

    const res = await register({
      email: 'viewer@tenant-a.example',
      inviteToken: token,
      tenantId: TENANT_B,
      role: 'super-admin',
      roles: ['platform-admin'],
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'viewer', tenantId: TENANT_A });
    const stored = await adminModel.findOne({ email: 'viewer@tenant-a.example' }).lean();
    expect(stored).toMatchObject({ role: 'viewer', tenantId: TENANT_A });
  });

  it("stores the invite in the inviter's tenant, whatever the invite body says", async () => {
    const { token } = await invite(ownerA, {
      email: 'x@tenant-a.example',
      roles: ['operator'],
      tenantId: TENANT_B,
    });

    const stored = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(stored).toMatchObject({ tenantId: TENANT_A, email: 'x@tenant-a.example' });
    // Only the hash is stored, never the token.
    expect(stored?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('accepts an invite once', async () => {
    const { token } = await invite(ownerA, { email: 'once@tenant-a.example', roles: ['operator'] });
    await register({ email: 'once@tenant-a.example', inviteToken: token }).expect(201);

    const again = await register({ email: 'twice@tenant-a.example', inviteToken: token });

    expect(again.status).toBe(401);
    expect(await adminModel.countDocuments({ email: 'twice@tenant-a.example' })).toBe(0);
  });

  it('refuses an expired invite and an unknown token', async () => {
    const { token } = await invite(ownerA, { email: 'late@tenant-a.example', roles: ['operator'] });
    await inviteModel
      .updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
      .setOptions({ skipTenantScope: true });

    await register({ email: 'late@tenant-a.example', inviteToken: token }).expect(401);
    await register({ email: 'late@tenant-a.example', inviteToken: 'f'.repeat(64) }).expect(401);
    expect(await adminModel.countDocuments({ email: 'late@tenant-a.example' })).toBe(0);
  });

  it('refuses an email that is not the invited one and leaves the invite usable', async () => {
    const { token } = await invite(ownerA, {
      email: 'right@tenant-a.example',
      roles: ['operator'],
    });

    const res = await register({ email: 'wrong@tenant-a.example', inviteToken: token });

    expect(res.status).toBe(400);
    expect(await adminModel.countDocuments({ email: 'wrong@tenant-a.example' })).toBe(0);
    const untouched = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(untouched?.usedAt).toBeUndefined();

    // The typo cost nothing: the invitee registers with the invited email.
    const retry = await register({ email: 'right@tenant-a.example', inviteToken: token });
    expect(retry.status).toBe(201);
    expect(retry.body.user).toMatchObject({ role: 'operator', tenantId: TENANT_A });
  });

  it('accepts one of two registrations racing for the same invite', async () => {
    const { token } = await invite(ownerA, { email: 'race@tenant-a.example', roles: ['operator'] });

    const results = await Promise.all([
      register({ email: 'race@tenant-a.example', inviteToken: token }),
      register({ email: 'race@tenant-a.example', inviteToken: token }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    // The loser either lost the invite claim (401) or arrived after the winner's account (409).
    expect([401, 409]).toContain(statuses[1]);
    expect(await adminModel.countDocuments({ email: 'race@tenant-a.example' })).toBe(1);
  });

  it('claims the invite for only one of two concurrent redemptions', async () => {
    const { token } = await invite(ownerA, { email: 'twice@tenant-a.example', roles: ['viewer'] });
    const inviteService = moduleRef.get(InviteService);
    const registerAdmin = jest.fn(async () => 'created');

    const outcomes = await Promise.allSettled([
      inviteService.redeemInvite(token, 'twice@tenant-a.example', registerAdmin),
      inviteService.redeemInvite(token, 'twice@tenant-a.example', registerAdmin),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(UnauthorizedException);
    expect(registerAdmin).toHaveBeenCalledTimes(1);
  });

  it('gives the invite back when creating the admin fails', async () => {
    const { token } = await invite(ownerA, {
      email: 'retry@tenant-a.example',
      roles: ['operator'],
    });
    const create = jest
      .spyOn(adminModel, 'create')
      .mockRejectedValueOnce(new Error('write concern timeout') as never);

    try {
      const failed = await register({ email: 'retry@tenant-a.example', inviteToken: token });
      expect(failed.status).toBe(500);
    } finally {
      create.mockRestore();
    }
    const released = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(released?.usedAt).toBeUndefined();

    await register({ email: 'retry@tenant-a.example', inviteToken: token }).expect(201);
    const used = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(used?.usedAt).toBeInstanceOf(Date);
  });

  it('refuses a registration without an invite once a tenant exists', async () => {
    await register({ email: 'walk-in@tenant-a.example' }).expect(403);
  });

  it('lets a super-admin whose id is not a database id invite', async () => {
    // A single sign-on (OIDC) admin has no admin_users row: its id is the identity provider's
    // subject. The emergency admin's id is not a database id either.
    const ssoOwner = {
      sub: 'auth0|5f7c8ec7c33c6c004bbafe82',
      email: 'sso.owner@tenant-a.example',
      roles: ['super-admin'],
      tenantId: TENANT_A,
    };
    const { token } = await invite(ssoOwner, {
      email: 'sso.invited@tenant-a.example',
      roles: ['viewer'],
    });

    const stored = await inviteModel.findOne({}, null, { skipTenantScope: true }).lean();
    expect(stored).toMatchObject({ createdBy: ssoOwner.sub, tenantId: TENANT_A });
    const res = await register({ email: 'sso.invited@tenant-a.example', inviteToken: token });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'viewer', tenantId: TENANT_A });
  });

  it('still redeems an invite stored with its inviter as an ObjectId', async () => {
    // How createdBy was stored before it held the caller's id as text.
    const token = 'invite-with-objectid-inviter';
    await inviteModel.collection.insertOne({
      email: 'earlier@tenant-a.example',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      roles: ['operator'],
      createdBy: new mongoose.Types.ObjectId(ownerA.sub),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: TENANT_A,
    });

    const res = await register({ email: 'earlier@tenant-a.example', inviteToken: token });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'operator', tenantId: TENANT_A });
  });

  it('lets only a super-admin invite', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/invites')
      .set(as({ ...ownerA, sub: 'op-1', roles: ['operator'] }))
      .send({ email: 'y@tenant-a.example', roles: ['operator'] })
      .expect(403);

    expect(await inviteModel.countDocuments({}, { skipTenantScope: true })).toBe(0);
  });

  it('an invited super-admin is a super-admin of the inviting tenant only', async () => {
    const { token } = await invite(ownerA, {
      email: 'co-owner@tenant-a.example',
      roles: ['super-admin'],
    });
    const res = await register({ email: 'co-owner@tenant-a.example', inviteToken: token }).expect(
      201,
    );
    const coOwner = { sub: res.body.user.id, roles: ['super-admin'], tenantId: TENANT_A };

    // It manages its own tenant's admins (revoke), and another tenant's admin is a 404.
    await request(app.getHttpServer())
      .post(`/api/v1/auth/revoke/${ownerA.sub}`)
      .set(as(coOwner))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/auth/revoke/${ownerB.sub}`)
      .set(as(coOwner))
      .expect(404);
    // Never a platform admin: only PLATFORM_ADMIN_USER_IDS grants that.
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(as({ ...coOwner, email: 'co-owner@tenant-a.example' }))
      .expect(200);
    expect(me.body).toMatchObject({ roles: ['super-admin'], isPlatformAdmin: false });
  });

  it("the inviter's tenant super-admin can revoke the invited admin's sessions; another tenant's cannot", async () => {
    const { token } = await invite(ownerA, { email: 'temp@tenant-a.example', roles: ['operator'] });
    const res = await register({ email: 'temp@tenant-a.example', inviteToken: token }).expect(201);
    const invitedId = res.body.user.id;

    await request(app.getHttpServer())
      .post(`/api/v1/auth/revoke/${invitedId}`)
      .set(as(ownerB))
      .expect(404);
    expect((await adminModel.findById(invitedId).lean())?.tokenVersion).toBe(0);

    await request(app.getHttpServer())
      .post(`/api/v1/auth/revoke/${invitedId}`)
      .set(as(ownerA))
      .expect(201);
    expect((await adminModel.findById(invitedId).lean())?.tokenVersion).toBe(1);
  });
  // Final review AU3: first-admin setup was open only while no admin at all existed, so a SAML
  // user signing in first (a JIT viewer) closed it, and no invite could ever be made
  describe('first-admin setup', () => {
    beforeEach(async () => {
      await adminModel.deleteMany({});
    });

    it('stays open while no active super-admin exists: a JIT-created viewer does not close it', async () => {
      await adminModel.create({
        email: 'sso.viewer@default-tenant.example',
        name: 'SSO viewer',
        role: 'viewer',
        authSource: 'saml',
        tenantId: 'default-tenant',
      });

      const status = await request(app.getHttpServer()).get('/api/v1/auth/setup-status');
      expect(status.body).toEqual({ hasAdminUsers: false });

      const res = await register({ email: 'first.admin@default-tenant.example' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        email: 'first.admin@default-tenant.example',
        role: 'super-admin',
      });
      const after = await request(app.getHttpServer()).get('/api/v1/auth/setup-status');
      expect(after.body).toEqual({ hasAdminUsers: true });
    });

    it('answers 409 when the address is the JIT-created account itself', async () => {
      await adminModel.create({
        email: 'sso.viewer@default-tenant.example',
        name: 'SSO viewer',
        role: 'viewer',
        authSource: 'saml',
        tenantId: 'default-tenant',
      });

      const res = await register({ email: 'SSO.Viewer@default-tenant.example' });

      expect(res.status).toBe(409);
      expect(await adminModel.countDocuments({ role: 'super-admin' })).toBe(0);
    });

    it('stays open when the only super-admin is deactivated', async () => {
      await adminModel.create({
        email: 'old.owner@default-tenant.example',
        passwordHash: 'not-used',
        name: 'Old owner',
        role: 'super-admin',
        tenantId: 'default-tenant',
        isActive: false,
      });

      const res = await register({ email: 'first.admin@default-tenant.example' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ role: 'super-admin' });
      expect(await adminModel.countDocuments({ role: 'super-admin', isActive: true })).toBe(1);
    });

    it('closes once an active super-admin exists', async () => {
      await adminModel.create({
        email: 'owner@default-tenant.example',
        passwordHash: 'not-used',
        name: 'Owner',
        role: 'super-admin',
        tenantId: 'default-tenant',
      });

      const res = await register({ email: 'second@default-tenant.example' });

      expect(res.status).toBe(403);
    });
  });

  describe('pending invites', () => {
    const list = (caller: object) =>
      request(app.getHttpServer()).get('/api/v1/auth/invites').set(as(caller));
    const cancel = (caller: object, id: string) =>
      request(app.getHttpServer()).delete(`/api/v1/auth/invites/${id}`).set(as(caller));
    const storedId = async (email: string) =>
      String((await inviteModel.findOne({ email }, null, { skipTenantScope: true }).lean())?._id);
    const cancellations = () =>
      events.emit.mock.calls.filter(([type]) => type === DomainEventType.INVITE_CANCELLED);

    it("lists the caller tenant's unused, unexpired invites, newest first, without codes", async () => {
      const pending = await invite(ownerA, {
        email: 'pending@tenant-a.example',
        roles: ['operator'],
      });
      const used = await invite(ownerA, { email: 'used@tenant-a.example', roles: ['viewer'] });
      await register({ email: 'used@tenant-a.example', inviteToken: used.token }).expect(201);
      await invite(ownerA, { email: 'late@tenant-a.example', roles: ['viewer'] });
      await inviteModel
        .updateOne(
          { email: 'late@tenant-a.example' },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        )
        .setOptions({ skipTenantScope: true });
      const newest = await invite(ownerA, {
        email: 'newest@tenant-a.example',
        roles: ['super-admin'],
      });
      await invite(ownerB, { email: 'other@tenant-b.example', roles: ['viewer'] });

      const res = await list(ownerA).expect(200);

      expect(res.body).toEqual([
        {
          id: await storedId('newest@tenant-a.example'),
          email: 'newest@tenant-a.example',
          role: 'super-admin',
          createdBy: ownerA.sub,
          createdAt: expect.any(String),
          expiresAt: newest.expiresAt,
        },
        {
          id: await storedId('pending@tenant-a.example'),
          email: 'pending@tenant-a.example',
          role: 'operator',
          createdBy: ownerA.sub,
          createdAt: expect.any(String),
          expiresAt: pending.expiresAt,
        },
      ]);
      const text = JSON.stringify(res.body);
      const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
      for (const token of [pending.token, newest.token]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(hashOf(token));
      }
      expect(text).not.toMatch(/token/i);
    });

    it('cancels an invite: its code registers nobody, and the audit entry holds no code or email', async () => {
      const { token } = await invite(ownerA, {
        email: 'wrong@tenant-a.example',
        roles: ['operator'],
      });
      const id = await storedId('wrong@tenant-a.example');

      await cancel(ownerA, id).expect(200, { success: true });

      await register({ email: 'wrong@tenant-a.example', inviteToken: token }).expect(401);
      expect(await adminModel.countDocuments({ email: 'wrong@tenant-a.example' })).toBe(0);
      expect((await list(ownerA).expect(200)).body).toEqual([]);
      expect(cancellations()).toHaveLength(1);
      const [, aggregateId, payload] = cancellations()[0];
      expect(aggregateId).toBe(id);
      expect(payload).toEqual({
        roles: ['operator'],
        createdBy: ownerA.sub,
        cancelledBy: ownerA.sub,
        expiresAt: expect.any(String),
      });
      expect(getEventSchema(DomainEventType.INVITE_CANCELLED).safeParse(payload).success).toBe(
        true,
      );
      expect(JSON.stringify(payload)).not.toContain(token);
    });

    it("answers 404 for another tenant's invite and leaves it usable", async () => {
      const { token } = await invite(ownerA, { email: 'kept@tenant-a.example', roles: ['viewer'] });

      const res = await cancel(ownerB, await storedId('kept@tenant-a.example')).expect(404);

      expect(res.body.message).toMatch(/No pending invite with this id in your tenant/);
      expect(cancellations()).toHaveLength(0);
      await register({ email: 'kept@tenant-a.example', inviteToken: token }).expect(201);
    });

    it('answers 404 for a used or expired invite, and 400 for an id that is not one', async () => {
      const used = await invite(ownerA, { email: 'done@tenant-a.example', roles: ['viewer'] });
      await register({ email: 'done@tenant-a.example', inviteToken: used.token }).expect(201);
      await invite(ownerA, { email: 'old@tenant-a.example', roles: ['viewer'] });
      await inviteModel
        .updateOne(
          { email: 'old@tenant-a.example' },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        )
        .setOptions({ skipTenantScope: true });

      await cancel(ownerA, await storedId('done@tenant-a.example')).expect(404);
      await cancel(ownerA, await storedId('old@tenant-a.example')).expect(404);
      await cancel(ownerA, 'not-an-id').expect(400);
      expect(await inviteModel.countDocuments({}, { skipTenantScope: true })).toBe(2);
    });

    it('needs super-admin to list or cancel', async () => {
      await invite(ownerA, { email: 'x@tenant-a.example', roles: ['viewer'] });
      const operator = { ...ownerA, sub: 'op-1', roles: ['operator'] };

      await list(operator).expect(403);
      await cancel(operator, await storedId('x@tenant-a.example')).expect(403);
      expect(await inviteModel.countDocuments({}, { skipTenantScope: true })).toBe(1);
    });
  });

  describe('an address that already has an account', () => {
    it('is refused when invited into the tenant that has it (409), whatever its case', async () => {
      for (const email of ['owner@tenant-a.example', ' Owner@Tenant-A.example ']) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/invites')
          .set(as(ownerA))
          .send({ email: email.trim(), roles: ['viewer'] })
          .expect(409);
        expect(res.body.message).toBe(
          'This email address already has an admin account in this tenant. No invite is needed.',
        );
      }
      expect(await inviteModel.countDocuments({}, { skipTenantScope: true })).toBe(0);
    });

    // The public route answered 409 "already has an admin account" before it looked at the
    // invite, so anyone could test which addresses have an admin account in any tenant.
    it('is not revealed to a caller without a valid invite for it', async () => {
      const noInvite = await register({ email: 'owner@tenant-b.example' }).expect(403);
      expect(noInvite.body.message).toBe(
        'Registration requires an invite. Contact your administrator.',
      );
      await register({ email: 'owner@tenant-b.example', inviteToken: 'f'.repeat(64) }).expect(401);
      // An invite for another address does not tell either.
      const { token } = await invite(ownerA, {
        email: 'someone@tenant-a.example',
        roles: ['viewer'],
      });
      await register({ email: 'owner@tenant-b.example', inviteToken: token }).expect(400);
    });

    // Refusing the invite would tell tenant A that the address has an account in tenant B.
    it("is not revealed to another tenant's inviter: registration tells the invitee and the invite stays pending", async () => {
      const { token } = await invite(ownerA, {
        email: 'owner@tenant-b.example',
        roles: ['viewer'],
      });

      const res = await register({ email: 'owner@tenant-b.example', inviteToken: token });

      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        'This email address already has an admin account. Sign in with it instead.',
      );
      const stored = await adminModel.findOne({ email: 'owner@tenant-b.example' }).lean();
      expect(stored).toMatchObject({ tenantId: TENANT_B, role: 'super-admin' });
      const pending = await request(app.getHttpServer())
        .get('/api/v1/auth/invites')
        .set(as(ownerA))
        .expect(200);
      expect(pending.body.map((i: { email: string }) => i.email)).toEqual([
        'owner@tenant-b.example',
      ]);
    });
  });
});
