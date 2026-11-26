/**
 * The websocket's connect check on in-memory MongoDB with the real AdminUser model, real tokens
 * (AuthLocalService) and the real JwtAuthGuard: a local token gets the tenant's events only when
 * the guard would let it call the API, so a revoked session, a deactivated admin and a token that
 * can only set up MFA are disconnected.
 */
import mongoose, { Model } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { JwtAuthGuard } from '@infrastructure/auth/jwt-auth.guard';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import { MemorySecurityStateStore } from '@infrastructure/cache/security-state.store';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { AuthLocalService } from '../../modules/auth/auth-local.service';
import {
  AdminUser,
  AdminUserDocument,
  AdminUserSchema,
} from '../../modules/auth/schemas/admin-user.schema';
import { EventsGateway } from './events.gateway';

const TENANT = 'tenant-a';
const PASSWORD = 'ValidPass1!xx';
const settings: Record<string, string> = {
  JWT_SECRET: 'test-jwt-secret-thats-at-least-32chars-long',
  NODE_ENV: 'test',
};
const config = { get: (key: string) => settings[key] } as unknown as ConfigService;

type Ctor<T extends abstract new (...args: never[]) => unknown> = ConstructorParameters<T>;

describe('EventsGateway connect check (in-memory MongoDB, real JwtAuthGuard)', () => {
  let adminModel: Model<AdminUserDocument>;
  let tenantModel: Model<Tenant>;
  let authLocal: AuthLocalService;
  let gateway: EventsGateway;
  let tenantStatus: TenantStatusService;

  beforeAll(async () => {
    await connectTestDb();
    adminModel = mongoose.model(
      AdminUser.name,
      AdminUserSchema,
    ) as unknown as Model<AdminUserDocument>;
    tenantModel = mongoose.model(Tenant.name, TenantSchema) as unknown as Model<Tenant>;
    authLocal = new AuthLocalService(
      adminModel as unknown as Ctor<typeof AuthLocalService>[0],
      tenantModel as unknown as Ctor<typeof AuthLocalService>[1],
      config,
      {} as Ctor<typeof AuthLocalService>[3],
      {} as Ctor<typeof AuthLocalService>[4],
      {} as Ctor<typeof AuthLocalService>[5],
      new MemorySecurityStateStore(),
    );
    tenantStatus = new TenantStatusService(
      tenantModel as unknown as Ctor<typeof TenantStatusService>[0],
    );
    const guard = new JwtAuthGuard(
      config,
      new Reflector(),
      adminModel,
      {} as Ctor<typeof JwtAuthGuard>[3],
      {} as Ctor<typeof JwtAuthGuard>[4],
      tenantStatus,
    );
    gateway = new EventsGateway(config, guard);
  });

  afterEach(async () => {
    await clearTestDb();
    tenantStatus.forget(TENANT); // no cached status outlives the test that wrote it
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const seedAdmin = async (email: string) => {
    const doc = await adminModel.create({
      email,
      name: email,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      role: 'operator',
      tenantId: TENANT,
    });
    return String(doc._id);
  };

  /** A socket.io client handshake that carries `token` as the browser client sends it. */
  const connect = async (token: string) => {
    const socket = {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      join: jest.fn(),
      disconnect: jest.fn(),
      handshake: { headers: {}, auth: { token }, query: {} },
    };
    await gateway.handleConnection(
      socket as unknown as Parameters<EventsGateway['handleConnection']>[0],
    );
    return socket;
  };

  it("a session token of an active admin: joins the tenant's system room", async () => {
    const id = await seedAdmin('active@tenant-a.example');
    const { access_token } = await authLocal.issueTokensForUser(id);

    const socket = await connect(access_token);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith(`t:${TENANT}:system`);
    expect(socket.data).toMatchObject({ userId: id, roles: ['operator'], tenantId: TENANT });
  });

  it("is disconnected after the admin's sessions are revoked (tokenVersion)", async () => {
    const id = await seedAdmin('revoked@tenant-a.example');
    const { access_token } = await authLocal.issueTokensForUser(id);
    await authLocal.revokeAllSessions(id, TENANT);

    const socket = await connect(access_token);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.data.tenantId).toBeUndefined();
  });

  it('is disconnected when the admin is deactivated (isActive)', async () => {
    const id = await seedAdmin('left@tenant-a.example');
    const { access_token } = await authLocal.issueTokensForUser(id);
    await adminModel.updateOne({ _id: id }, { $set: { isActive: false } });

    const socket = await connect(access_token);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('is disconnected when its tenant is suspended', async () => {
    const id = await seedAdmin('suspended@tenant-a.example');
    const { access_token } = await authLocal.issueTokensForUser(id);
    await tenantModel.create({ tenantId: TENANT, name: 'Tenant A', status: 'suspended' });
    tenantStatus.forget(TENANT); // as TenantService.suspend does

    const socket = await connect(access_token);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  // A socket is checked once, on connect; the recheck keeps a revoked session from receiving the
  // tenant's events until the socket happens to disconnect.
  describe('the periodic session recheck', () => {
    const recheck = async (...sockets: Array<Awaited<ReturnType<typeof connect>>>) => {
      (gateway as unknown as { server: unknown }).server = {
        sockets: new Map(sockets.map((socket, i) => [`socket-${i}`, socket])),
      };
      await gateway.recheckSessions();
    };

    it("disconnects a socket after its admin's sessions are revoked, and keeps the others", async () => {
      const revokedId = await seedAdmin('later-revoked@tenant-a.example');
      const keptId = await seedAdmin('kept@tenant-a.example');
      const revoked = await connect((await authLocal.issueTokensForUser(revokedId)).access_token);
      const kept = await connect((await authLocal.issueTokensForUser(keptId)).access_token);
      expect(revoked.disconnect).not.toHaveBeenCalled();

      await authLocal.revokeAllSessions(revokedId, TENANT);
      await recheck(revoked, kept);

      expect(revoked.disconnect).toHaveBeenCalledWith(true);
      expect(kept.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects a socket after its admin is deactivated', async () => {
      const id = await seedAdmin('later-left@tenant-a.example');
      const socket = await connect((await authLocal.issueTokensForUser(id)).access_token);

      await adminModel.updateOne({ _id: id }, { $set: { isActive: false } });
      await recheck(socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects a socket after its tenant is suspended', async () => {
      const id = await seedAdmin('later-suspended@tenant-a.example');
      const socket = await connect((await authLocal.issueTokensForUser(id)).access_token);

      await tenantModel.create({ tenantId: TENANT, name: 'Tenant A', status: 'suspended' });
      tenantStatus.forget(TENANT); // as TenantService.suspend does
      await recheck(socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  it('is disconnected for a token that can only set up MFA (no role)', async () => {
    await seedAdmin('enrol@tenant-a.example');
    await tenantModel.create({
      tenantId: TENANT,
      name: 'Tenant A',
      settings: { mfaRequired: true },
    });
    const signIn = await authLocal.login({ email: 'enrol@tenant-a.example', password: PASSWORD });
    expect(signIn.mfa_enrollment_required).toBe(true);

    const socket = await connect(signIn.mfa_enrollment_token as string);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });
});
