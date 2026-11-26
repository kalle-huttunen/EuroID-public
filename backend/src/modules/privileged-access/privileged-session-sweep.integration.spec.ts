/**
 * Privileged sessions as the API and the hourly sweep see them (in-memory MongoDB):
 * PrivilegedSessionService with the real PamSessionStateService, the Temporal side replaced by a
 * fake PamSessionService whose runs record their outcome as privilegedSessionWorkflow does.
 *
 * - Activation answers ACTIVE only once the session recorded every account enabled, 502 with the
 *   reason when enabling failed, and ACTIVATING when the bounded wait ends first.
 * - The sweep ends expired sessions, and starts bounded disable-only runs for live admin
 *   identities whose accounts may be enabled outside a session (target state unknown or
 *   `enabled`, entry not ACTIVE or ACTIVATING), so admin accounts provisioned before sessions
 *   existed end disabled without a person.
 * - The session state: a failed disable leaves the target state `enabled` with the reason on the
 *   entry, so the sweep retries; a deleted admin identity is never recorded ACTIVE.
 */
import mongoose, { Model } from 'mongoose';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
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
import { asPamSessionService, inlinePamSessions } from '@testing/inline-pam-sessions';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../identity/schemas/identity.schema';
import { PamSessionStateService } from './pam-session-state.service';
import { PrivilegedSessionService } from './privileged-session.service';

mongoose.plugin(tenantPlugin);

const PAM_CONFIG = {
  tier0MaxHours: 8,
  tier1MaxHours: 24,
  tier2MaxHours: 72,
  adminUpnPattern: 'adm-{firstName}.{lastName}@{domain}',
  adminUpnMaxSuffix: 20,
  activationWaitMs: 400,
  standingStateSweepLimit: 2,
  activationPendingAlertDays: 7,
} as unknown as PamConfig;
const HOUR = 60 * 60 * 1000;

describe('Privileged sessions: activation answer and the hourly sweep (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let state: PamSessionStateService;
  let events: ReturnType<typeof createMockEventEmitter>;
  let sessions: ReturnType<typeof inlinePamSessions>;
  let service: PrivilegedSessionService;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
  });

  beforeEach(() => {
    const logger = createMockLoggerFactory().factory as unknown as LoggerFactoryService;
    events = createMockEventEmitter();
    state = new PamSessionStateService(
      identityModel,
      events as unknown as DomainEventEmitterService,
      logger,
    );
    sessions = inlinePamSessions(state);
    service = new PrivilegedSessionService(
      identityModel,
      asPamSessionService(sessions),
      logger,
      PAM_CONFIG,
      events as unknown as DomainEventEmitterService,
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  let seq = 0;
  /** A live person with one linked admin identity; `entry` and `admin` override their fields. */
  async function adminAccount(
    entry: Record<string, unknown> = {},
    admin: Record<string, unknown> = {},
  ) {
    seq++;
    const parent = await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Eero',
        lastName: `P${seq}`,
        email: `p${seq}@corp.example`,
        status: UserStatus.ACTIVE,
      },
      sources: [],
    });
    const created = await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Eero',
        lastName: `P${seq}`,
        email: `adm-p${seq}@corp.example`,
        status: UserStatus.PENDING,
        employmentType: 'ADMIN_ACCOUNT',
        sourceSystem: 'euroid-pam',
      },
      sources: [{ sourceName: 'entra-id', externalId: `obj-${seq}`, sourceRole: 'target' }],
      provisioning: [{ targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() }],
      parentIdentityId: String(parent._id),
      adminTier: 'TIER_1',
      ...admin,
    });
    const adminId = String(created._id);
    await identityModel.updateOne(
      { _id: parent._id },
      {
        $set: {
          linkedAdminAccounts: [
            { identityId: adminId, adminTier: 'TIER_1', status: 'PENDING', ...entry },
          ],
        },
      },
    );
    return { parentId: String(parent._id), adminId };
  }

  const entryOf = async (parentId: string) =>
    (await identityModel.findById(parentId).lean().exec())!.linkedAdminAccounts![0];
  const adminOf = (adminId: string) => identityModel.findById(adminId).lean().exec();

  describe('activate', () => {
    it('answers ACTIVE once the session recorded every account enabled', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await adminAccount();

        const result = await service.activate(adminId, parentId, 24 * HOUR, TEST_TENANT_ID);

        expect(result).toEqual({ state: 'ACTIVE', expiresAt: expect.any(String) });
        const entry = await entryOf(parentId);
        expect(entry.status).toBe('ACTIVE');
        expect(new Date(entry.expiresAt!).toISOString()).toBe(
          (result as { expiresAt: string }).expiresAt,
        );
        expect((await adminOf(adminId))!.profile.status).toBe(UserStatus.ACTIVE);
        expect((await adminOf(adminId))!.pamTargetState).toBe('enabled');
        expect(events.emit).toHaveBeenCalledWith(
          DomainEventType.ADMIN_ACCOUNT_ACTIVATED,
          adminId,
          expect.objectContaining({ parentIdentityId: parentId }),
          { actor: 'privileged-session-workflow' },
        );
      }));

    it('answers 502 with the reason when enabling failed, and records nothing ACTIVE', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await adminAccount();
        sessions.startSession.mockImplementation(
          async (id: string, tenantId: string, sessionId: string) => {
            await state.markActivating(id, sessionId, tenantId);
            await state.recordFailed(id, sessionId, 'ad: refused (HTTP 403)', [], tenantId);
          },
        );

        const attempt = service.activate(adminId, parentId, 24 * HOUR, TEST_TENANT_ID);

        await expect(attempt).rejects.toBeInstanceOf(BadGatewayException);
        await expect(attempt).rejects.toThrow(/ad: refused \(HTTP 403\).*Nothing stays enabled/);
        const entry = await entryOf(parentId);
        expect(entry.status).toBe('INACTIVE');
        expect(entry.activationError).toBe('ad: refused (HTTP 403)');
        expect((await adminOf(adminId))!.profile.status).toBe(UserStatus.PENDING);
        expect((await adminOf(adminId))!.pamTargetState).toBe('disabled');
      }));

    it('answers ACTIVATING when the wait ends before the session knows', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await adminAccount();
        sessions.startSession.mockImplementation(
          async (id: string, tenantId: string, sessionId: string) => {
            await state.markActivating(id, sessionId, tenantId);
          },
        );

        await expect(
          service.activate(adminId, parentId, 24 * HOUR, TEST_TENANT_ID),
        ).resolves.toEqual({ state: 'ACTIVATING' });
        expect((await entryOf(parentId)).status).toBe('ACTIVATING');
      }));
  });

  describe('the hourly sweep', () => {
    it('ends the expired sessions only', async () =>
      await withTestTenant(async () => {
        const expired = await adminAccount({
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() - HOUR),
        });
        const running = await adminAccount({
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + HOUR),
        });

        await expect(service.endExpired(TEST_TENANT_ID, new Date())).resolves.toBe(1);

        expect(sessions.endSession.mock.calls).toEqual([
          [expired.adminId, TEST_TENANT_ID, 'expired'],
        ]);
        expect((await entryOf(expired.parentId)).status).toBe('INACTIVE');
        expect((await entryOf(running.parentId)).status).toBe('ACTIVE');
      }));

    it('disables admin accounts of unknown or enabled state outside a session, bounded per sweep', async () =>
      await withTestTenant(async () => {
        const unknown1 = await adminAccount();
        const enabled = await adminAccount({ status: 'INACTIVE' }, { pamTargetState: 'enabled' });
        const unknown2 = await adminAccount({ status: 'INACTIVE' });
        await adminAccount({}, { pamTargetState: 'disabled' });
        await adminAccount({ status: 'ACTIVE', expiresAt: new Date(Date.now() + HOUR) });
        await adminAccount({ status: 'ACTIVATING' });
        await adminAccount({}, { deletedAt: new Date() });

        // PAM_STANDING_STATE_SWEEP_LIMIT is 2 here: the third waits for the next sweep
        await expect(service.convergeStandingState(TEST_TENANT_ID)).resolves.toBe(2);
        expect(sessions.startDisable.mock.calls).toEqual([
          [unknown1.adminId, TEST_TENANT_ID, 'standing-state'],
          [enabled.adminId, TEST_TENANT_ID, 'standing-state'],
        ]);
        expect((await adminOf(unknown1.adminId))!.pamTargetState).toBe('disabled');

        // The next sweep reaches the rest; then nothing is left
        sessions.startDisable.mockClear();
        await expect(service.convergeStandingState(TEST_TENANT_ID)).resolves.toBe(1);
        expect(sessions.startDisable.mock.calls).toEqual([
          [unknown2.adminId, TEST_TENANT_ID, 'standing-state'],
        ]);
        await expect(service.convergeStandingState(TEST_TENANT_ID)).resolves.toBe(0);
      }));

    it('does not count an admin identity whose run is already running', async () =>
      await withTestTenant(async () => {
        await adminAccount();
        sessions.startDisable.mockResolvedValue(false);
        await expect(service.convergeStandingState(TEST_TENANT_ID)).resolves.toBe(0);
      }));

    // HX-A2 follow-up: an Okta admin account whose owner never finishes the activation stays
    // PROVISIONED, and each sweep started a disable-only run for it that failed with the same 422.
    describe("an Okta admin account waiting for its owner's activation", () => {
      const OKTA_REFUSAL =
        'okta: The Okta user is PROVISIONED: its owner has not finished the activation Okta ' +
        'emailed, and Okta suspends only an ACTIVE user. (HTTP 422)';
      const DAY = 24 * HOUR;

      /** An admin identity with an Okta account whose last disable failed as `disableError`. */
      const oktaAdmin = (disableError = OKTA_REFUSAL, deactivatedAt = new Date()) =>
        adminAccount(
          { status: 'INACTIVE', disableError, deactivatedAt },
          {
            pamTargetState: 'enabled',
            sources: [{ sourceName: 'okta', externalId: '00u-okta', sourceRole: 'target' }],
            provisioning: [{ targetSystem: 'okta', status: 'SYNCED', provisionedAt: new Date() }],
          },
        );
      const pendingEvents = () =>
        events.emit.mock.calls.filter(
          ([type]) => type === DomainEventType.ADMIN_ACCOUNT_ACTIVATION_PENDING,
        );

      it('starts no run while Okta says PROVISIONED, and keeps the target state for the next sweep', async () =>
        await withTestTenant(async () => {
          const { parentId, adminId } = await oktaAdmin();
          const readOktaStatus = jest
            .fn()
            .mockResolvedValue({ status: 'PROVISIONED', statusChanged: new Date().toISOString() });

          await expect(service.convergeStandingState(TEST_TENANT_ID, readOktaStatus)).resolves.toBe(
            0,
          );

          expect(readOktaStatus).toHaveBeenCalledWith({
            oktaUserId: '00u-okta',
            login: (await adminOf(adminId))!.profile.email,
          });
          expect(sessions.startDisable).not.toHaveBeenCalled();
          expect((await adminOf(adminId))!.pamTargetState).toBe('enabled');
          expect((await entryOf(parentId)).disableError).toBe(OKTA_REFUSAL);
          expect(pendingEvents()).toEqual([]);
        }));

      it('starts the run once the owner has activated it (ACTIVE)', async () =>
        await withTestTenant(async () => {
          const { adminId } = await oktaAdmin();
          const readOktaStatus = jest.fn().mockResolvedValue({ status: 'ACTIVE' });

          await expect(service.convergeStandingState(TEST_TENANT_ID, readOktaStatus)).resolves.toBe(
            1,
          );
          expect(sessions.startDisable.mock.calls).toEqual([
            [adminId, TEST_TENANT_ID, 'standing-state'],
          ]);
        }));

      it('starts the run when another system failed too, whatever Okta says', async () =>
        await withTestTenant(async () => {
          await oktaAdmin(`ad: LDAP unavailable; ${OKTA_REFUSAL}`);
          const readOktaStatus = jest.fn().mockResolvedValue({ status: 'PROVISIONED' });

          await expect(service.convergeStandingState(TEST_TENANT_ID, readOktaStatus)).resolves.toBe(
            1,
          );
          expect(readOktaStatus).not.toHaveBeenCalled();
        }));

      it('starts the run when the Okta status cannot be read', async () =>
        await withTestTenant(async () => {
          await oktaAdmin();
          const readOktaStatus = jest.fn().mockRejectedValue(new Error('Okta unreachable'));

          await expect(service.convergeStandingState(TEST_TENANT_ID, readOktaStatus)).resolves.toBe(
            1,
          );
        }));

      it('raises one alert once the account has waited PAM_ACTIVATION_PENDING_ALERT_DAYS', async () =>
        await withTestTenant(async () => {
          const { parentId, adminId } = await oktaAdmin();
          const pendingSince = new Date(Date.now() - 8 * DAY).toISOString();
          const readOktaStatus = jest
            .fn()
            .mockResolvedValue({ status: 'PROVISIONED', statusChanged: pendingSince });

          await service.convergeStandingState(TEST_TENANT_ID, readOktaStatus);
          await service.convergeStandingState(TEST_TENANT_ID, readOktaStatus);

          expect(pendingEvents()).toEqual([
            [
              DomainEventType.ADMIN_ACCOUNT_ACTIVATION_PENDING,
              adminId,
              {
                parentIdentityId: parentId,
                targetSystem: 'okta',
                targetStatus: 'PROVISIONED',
                pendingSince,
                alertAfterDays: 7,
              },
            ],
          ]);
          expect((await entryOf(parentId)).activationPendingAlertedAt).toBeInstanceOf(Date);
          expect(sessions.startDisable).not.toHaveBeenCalled();

          // A disable that succeeds later clears the mark, so a new wait alerts again
          await state.recordEnded(
            adminId,
            { reason: 'standing-state', failures: [] },
            TEST_TENANT_ID,
          );
          expect((await entryOf(parentId)).activationPendingAlertedAt).toBeUndefined();
        }));

      // Final review CP5: the one-alert mark was claimed before the event; an emit that failed
      // left the mark set, and the alert was never raised until a disable succeeded
      it('raises the alert on the next sweep when the event could not be emitted', async () =>
        await withTestTenant(async () => {
          const { parentId } = await oktaAdmin();
          const pendingSince = new Date(Date.now() - 8 * DAY).toISOString();
          const readOktaStatus = jest
            .fn()
            .mockResolvedValue({ status: 'PROVISIONED', statusChanged: pendingSince });
          events.emit.mockImplementationOnce(() => {
            throw new Error('event bus down');
          });

          await expect(service.convergeStandingState(TEST_TENANT_ID, readOktaStatus)).resolves.toBe(
            0,
          );
          expect((await entryOf(parentId)).activationPendingAlertedAt).toBeUndefined();

          await service.convergeStandingState(TEST_TENANT_ID, readOktaStatus);

          expect(pendingEvents()).toHaveLength(2);
          expect((await entryOf(parentId)).activationPendingAlertedAt).toBeInstanceOf(Date);
        }));

      it('raises no alert before PAM_ACTIVATION_PENDING_ALERT_DAYS, counting from the session end without an Okta date', async () =>
        await withTestTenant(async () => {
          await oktaAdmin(OKTA_REFUSAL, new Date(Date.now() - 6 * DAY));
          const readOktaStatus = jest.fn().mockResolvedValue({ status: 'PROVISIONED' });

          await service.convergeStandingState(TEST_TENANT_ID, readOktaStatus);

          expect(pendingEvents()).toEqual([]);
        }));
    });
  });

  describe('after admin account provisioning', () => {
    it('starts a disable-only run unless a session is open', async () =>
      await withTestTenant(async () => {
        const idle = await adminAccount();
        const active = await adminAccount({
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + HOUR),
        });

        await expect(service.settleAfterProvisioning(idle.adminId, TEST_TENANT_ID)).resolves.toBe(
          true,
        );
        await expect(service.settleAfterProvisioning(active.adminId, TEST_TENANT_ID)).resolves.toBe(
          false,
        );
        expect(sessions.startDisable.mock.calls).toEqual([
          [idle.adminId, TEST_TENANT_ID, 'provisioned'],
        ]);
      }));

    it('does not hold the provisioning when this process has no Temporal client', async () =>
      await withTestTenant(async () => {
        const idle = await adminAccount();
        sessions.startDisable.mockRejectedValue(
          new ServiceUnavailableException('Temporal is not connected'),
        );

        await expect(service.settleAfterProvisioning(idle.adminId, TEST_TENANT_ID)).resolves.toBe(
          false,
        );
        // The sweep picks it up: its target state is still unknown
        expect((await adminOf(idle.adminId))!.pamTargetState).toBeUndefined();
      }));
  });

  describe('session state', () => {
    it('keeps the target state enabled, with the reason, while a disable fails', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await adminAccount(
          { status: 'ACTIVE', expiresAt: new Date(Date.now() - HOUR) },
          { pamTargetState: 'enabled' },
        );
        // An active session's admin profile
        await identityModel.updateOne(
          { _id: adminId },
          { $set: { 'profile.status': UserStatus.ACTIVE } },
        );

        await state.recordEnded(
          adminId,
          { reason: 'expired', failures: ['ad: LDAP unavailable'] },
          TEST_TENANT_ID,
        );

        let entry = await entryOf(parentId);
        expect(entry.status).toBe('INACTIVE');
        expect(entry.disableError).toBe('ad: LDAP unavailable');
        expect((await adminOf(adminId))!.pamTargetState).toBe('enabled');
        expect((await adminOf(adminId))!.profile.status).toBe(UserStatus.INACTIVE);
        expect(events.emit).toHaveBeenCalledWith(
          DomainEventType.ADMIN_ACCOUNT_DEACTIVATED,
          adminId,
          {
            parentIdentityId: parentId,
            reason: 'expired',
            disableFailed: true,
          },
        );

        // The sweep's next run disables it: the reason goes, the state is disabled
        await state.recordEnded(
          adminId,
          { reason: 'standing-state', failures: [] },
          TEST_TENANT_ID,
        );
        entry = await entryOf(parentId);
        expect(entry.disableError).toBeUndefined();
        expect((await adminOf(adminId))!.pamTargetState).toBe('disabled');
      }));

    it('never records a deleted admin identity ACTIVE', async () =>
      await withTestTenant(async () => {
        const { parentId, adminId } = await adminAccount({ status: 'ACTIVATING', sessionId: 's1' });
        await identityModel.updateOne({ _id: adminId }, { $set: { deletedAt: new Date() } });

        await expect(state.recordActive(adminId, 's1', HOUR, TEST_TENANT_ID)).resolves.toEqual({
          live: false,
        });
        expect((await entryOf(parentId)).status).toBe('ACTIVATING');
        expect((await adminOf(adminId))!.profile.status).toBe(UserStatus.PENDING);
        await expect(state.sessionTargets(adminId, TEST_TENANT_ID)).resolves.toEqual({
          live: false,
          login: expect.stringContaining('@corp.example'),
          targets: [{ targetSystem: 'entra', externalId: expect.stringMatching(/^obj-/) }],
        });
      }));
  });
});
