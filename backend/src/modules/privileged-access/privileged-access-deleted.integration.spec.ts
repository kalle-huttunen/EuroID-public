/**
 * Privileged access and soft-deleted identities (in-memory MongoDB). An offboarded admin identity
 * keeps its entry on the parent, and the service read it without the soft-delete filter: a deleted
 * admin identity still listed with [Activate], and `PUT .../activate` set it ACTIVE while its
 * `deletedAt` stayed set. Activation grants privileged access, so it is refused for a deleted
 * admin identity and for one whose parent identity is deleted or gone, before any session starts.
 * Deactivation only takes access away and stays open, so the hourly sweep can still close an
 * expired session. The sessions run inline here (testing/inline-pam-sessions.ts).
 */
import mongoose, { Model } from 'mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import type { PamConfig } from '@infrastructure/config/pam.config';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import {
  connectTestDb,
  clearTestDb,
  closeTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../identity/schemas/identity.schema';
import type { IdentityService } from '../identity/identity.service';
import { PrivilegedAccessService } from './privileged-access.service';
import { PrivilegedSessionService } from './privileged-session.service';
import { PamSessionStateService } from './pam-session-state.service';
import {
  asPamSessionService,
  inlinePamSessions,
  type InlinePamSessions,
} from '@testing/inline-pam-sessions';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const PAM_CONFIG = {
  tier0MaxHours: 8,
  tier1MaxHours: 24,
  tier2MaxHours: 72,
  adminUpnPattern: 'adm-{firstName}.{lastName}@{domain}',
  adminUpnMaxSuffix: 20,
  activationWaitMs: 2000,
  standingStateSweepLimit: 50,
} as unknown as PamConfig;
const DELETED_AT = new Date('2026-11-20T10:00:00Z');
const SUPER_ADMIN = ['super-admin'];

describe('Privileged access and deleted identities (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let service: PrivilegedAccessService;
  let events: ReturnType<typeof createMockEventEmitter>;
  let sessions: InlinePamSessions;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
  });

  beforeEach(() => {
    events = createMockEventEmitter();
    const logger = createMockLoggerFactory().factory as unknown as LoggerFactoryService;
    const emitter = events as unknown as DomainEventEmitterService;
    sessions = inlinePamSessions(new PamSessionStateService(identityModel, emitter, logger));
    service = new PrivilegedAccessService(
      identityModel,
      {} as IdentityService,
      emitter,
      logger,
      PAM_CONFIG,
      new PrivilegedSessionService(
        identityModel,
        asPamSessionService(sessions),
        logger,
        PAM_CONFIG,
        events as unknown as DomainEventEmitterService,
      ),
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const softDelete = (id: string) =>
    identityModel.updateOne(
      { _id: id },
      { $set: { deletedAt: DELETED_AT, deletedBy: 'offboarding-workflow' } },
    );

  /** A live parent with one TIER_2 admin account (PENDING, as created). */
  async function parentWithAdmin() {
    const parent = await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Eero',
        lastName: 'Twinsource',
        email: 'eero.twinsource@corp.example',
        status: UserStatus.ACTIVE,
      },
      sources: [],
    });
    const admin = await service.createLinkedAdminIdentity(
      String(parent._id),
      'TIER_2',
      TEST_TENANT_ID,
    );
    return { parentId: String(parent._id), adminId: String(admin._id) };
  }

  const stored = (id: string) => identityModel.findById(id).lean().exec();

  describe('activateAdminAccount', () => {
    it('refuses a deleted admin identity and writes nothing', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await softDelete(adminId);
        events.emit.mockClear();

        await expect(
          service.activateAdminAccount(adminId, undefined, SUPER_ADMIN),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect((await stored(adminId))!.profile.status).toBe(UserStatus.PENDING);
        expect((await stored(parentId))!.linkedAdminAccounts![0].status).toBe('PENDING');
        expect(events.emit).not.toHaveBeenCalled();
        expect(sessions.startSession).not.toHaveBeenCalled();
      }));

    it('refuses an admin identity whose parent identity is deleted, with 409', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await softDelete(parentId);
        events.emit.mockClear();

        const attempt = service.activateAdminAccount(adminId, undefined, SUPER_ADMIN);
        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        await expect(attempt).rejects.toThrow(/parent identity .* is deleted/);

        expect((await stored(adminId))!.profile.status).toBe(UserStatus.PENDING);
        expect((await stored(parentId))!.linkedAdminAccounts![0].status).toBe('PENDING');
        expect(events.emit).not.toHaveBeenCalled();
        expect(sessions.startSession).not.toHaveBeenCalled();
      }));

    it('refuses an admin identity whose parent identity no longer exists', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await identityModel.deleteOne({ _id: parentId }); // GDPR erasure removes the document

        await expect(
          service.activateAdminAccount(adminId, undefined, SUPER_ADMIN),
        ).rejects.toBeInstanceOf(ConflictException);
        expect((await stored(adminId))!.profile.status).toBe(UserStatus.PENDING);
        expect(sessions.startSession).not.toHaveBeenCalled();
      }));

    it('still activates a live admin identity of a live parent', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();

        const result = await service.activateAdminAccount(adminId, undefined, SUPER_ADMIN);

        // A session of the tier's length (TIER_2: 72 h) enabled it
        expect(sessions.startSession).toHaveBeenCalledWith(
          adminId,
          TEST_TENANT_ID,
          expect.any(String),
          72 * 60 * 60 * 1000,
        );
        expect(result).toEqual({ state: 'ACTIVE', expiresAt: expect.any(String) });
        expect((await stored(adminId))!.profile.status).toBe(UserStatus.ACTIVE);
        expect((await stored(parentId))!.linkedAdminAccounts![0].status).toBe('ACTIVE');
      }));
  });

  describe('deactivateAdminAccount', () => {
    it('deactivates a live admin identity whose parent is deleted (taking access away stays open)', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await service.activateAdminAccount(adminId, undefined, SUPER_ADMIN);
        await softDelete(parentId);

        await expect(
          service.deactivateAdminAccount(adminId, undefined, SUPER_ADMIN),
        ).resolves.toEqual({ state: 'INACTIVE' });

        expect(sessions.endSession).toHaveBeenCalledWith(adminId, TEST_TENANT_ID, 'deactivated');
        expect((await stored(adminId))!.profile.status).toBe(UserStatus.INACTIVE);
        expect((await stored(parentId))!.linkedAdminAccounts![0].status).toBe('INACTIVE');
      }));

    it("the expiry sweep still closes a deleted admin identity's expired session", async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await service.activateAdminAccount(adminId, undefined, SUPER_ADMIN);
        await identityModel.updateOne(
          { _id: parentId },
          { $set: { 'linkedAdminAccounts.0.expiresAt': new Date(Date.now() - 60_000) } },
        );
        await softDelete(adminId);

        expect(await service.deactivateExpiredSessions(TEST_TENANT_ID)).toBe(1);
        expect(sessions.endSession).toHaveBeenCalledWith(adminId, TEST_TENANT_ID, 'expired');
        expect((await stored(parentId))!.linkedAdminAccounts![0].status).toBe('INACTIVE');
      }));
  });

  describe('listAllAdminAccounts', () => {
    it('leaves a deleted admin identity out', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await softDelete(adminId);
        // The parent gets a new admin account of the tier, as the PAM flow does after an offboarding
        const second = await service.createLinkedAdminIdentity(parentId, 'TIER_2', TEST_TENANT_ID);

        const rows = await service.listAllAdminAccounts(TEST_TENANT_ID);

        expect(rows.map((r) => r.adminIdentityId)).toEqual([String(second._id)]);
        expect(rows[0].parentDeleted).toBe(false);
      }));

    it('marks a live admin identity whose parent is deleted, so no Activate is offered', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await softDelete(parentId);

        const rows = await service.listAllAdminAccounts(TEST_TENANT_ID);

        expect(rows).toEqual([
          expect.objectContaining({ adminIdentityId: adminId, parentDeleted: true }),
        ]);
      }));
  });

  describe('getLinkedAdminAccounts', () => {
    it("leaves a deleted admin identity's entry out", async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await parentWithAdmin();
        await softDelete(adminId);
        const second = await service.createLinkedAdminIdentity(parentId, 'TIER_2', TEST_TENANT_ID);

        const entries = await service.getLinkedAdminAccounts(parentId, undefined, ['operator']);

        expect(entries.map((e) => e.identityId)).toEqual([String(second._id)]);
      }));

    it('answers 404 for a deleted parent identity', async () =>
      await withTestTenant(async () => {
        const { parentId } = await parentWithAdmin();
        await softDelete(parentId);

        await expect(
          service.getLinkedAdminAccounts(parentId, undefined, ['operator']),
        ).rejects.toBeInstanceOf(NotFoundException);
      }));
  });

  describe('createLinkedAdminIdentity', () => {
    it('refuses a deleted parent identity and creates nothing', async () =>
      await withTestTenant(async () => {
        const parent = await identityModel.create({
          tenantId: TEST_TENANT_ID,
          profile: {
            firstName: 'Bertta',
            lastName: 'Beta',
            email: 'bertta.beta@corp.example',
            status: UserStatus.INACTIVE,
          },
          sources: [],
          deletedAt: DELETED_AT,
          deletedBy: 'offboarding-workflow',
        });

        await expect(
          service.createLinkedAdminIdentity(String(parent._id), 'TIER_2', TEST_TENANT_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await identityModel.countDocuments({ adminTier: { $exists: true } })).toBe(0);
        expect((await stored(String(parent._id)))!.linkedAdminAccounts).toEqual([]);
      }));
  });
});
