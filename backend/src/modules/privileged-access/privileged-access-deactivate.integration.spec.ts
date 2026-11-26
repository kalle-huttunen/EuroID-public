/**
 * PAM deactivation and offboarding of an admin identity (in-memory MongoDB). Deactivating an admin
 * account disables its accounts (a privileged session's end; the sessions run inline here,
 * testing/inline-pam-sessions.ts) but removes none, so it must not mark the admin identity's
 * provisioning entries DEPROVISIONED: offboarding reads those entries to
 * find the accounts to remove, and an entry marked DEPROVISIONED is skipped, which would leave the
 * privileged account in place. An entry marked so by a PAM deactivation (the code meant to write
 * DEPROVISIONED, keeping the entry's other fields) is still targeted when an admin identity is
 * offboarded; one EuroID's own deprovision recorded (`provisionedAt` null) is not.
 */
import mongoose, { Model } from 'mongoose';
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
import { IdentityProvisioningService } from '../identity/identity-provisioning.service';
import { PrivilegedAccessService } from './privileged-access.service';
import { PrivilegedSessionService } from './privileged-session.service';
import { PamSessionStateService } from './pam-session-state.service';
import { asPamSessionService, inlinePamSessions } from '@testing/inline-pam-sessions';

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
const SUPER_ADMIN = ['super-admin'];
const ENTRA_OBJECT_ID = 'entra-adm-obj-1';
const AD_DN = 'CN=adm-eero,OU=Admins,DC=corp,DC=example';

describe('PAM deactivation and admin offboarding targets (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let pam: PrivilegedAccessService;
  let provisioning: IdentityProvisioningService;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
  });

  beforeEach(() => {
    const logger = createMockLoggerFactory().factory as unknown as LoggerFactoryService;
    const emitter = createMockEventEmitter() as unknown as DomainEventEmitterService;
    const sessions = inlinePamSessions(new PamSessionStateService(identityModel, emitter, logger));
    pam = new PrivilegedAccessService(
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
        emitter,
      ),
    );
    provisioning = new IdentityProvisioningService(identityModel, logger);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /**
   * A parent with a TIER_1 admin account provisioned to Entra ID and AD (SYNCED, with the account
   * ids admin provisioning writes back), activated for a session.
   */
  async function activatedAdmin() {
    const parent = await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Eero',
        lastName: 'Admin',
        email: 'eero.admin@corp.example',
        status: UserStatus.ACTIVE,
      },
      sources: [],
    });
    const parentId = String(parent._id);
    const admin = await pam.createLinkedAdminIdentity(parentId, 'TIER_1', TEST_TENANT_ID);
    const adminId = String(admin._id);
    await identityModel.updateOne(
      { _id: adminId },
      {
        $set: {
          provisioning: [
            { targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() },
            { targetSystem: 'ad', status: 'SYNCED', provisionedAt: new Date() },
          ],
          sources: [
            { sourceName: 'entra-id', externalId: ENTRA_OBJECT_ID, sourceRole: 'target' },
            { sourceName: 'ad', externalId: AD_DN, sourceRole: 'target' },
          ],
        },
      },
    );
    await pam.activateAdminAccount(adminId, undefined, SUPER_ADMIN);
    return { parentId, adminId };
  }

  const stored = (id: string) => identityModel.findById(id).lean().exec();

  it('keeps the provisioning entries of an admin account deactivated through PAM', async () =>
    await withTestTenant(async () => {
      const { parentId, adminId } = await activatedAdmin();

      await pam.deactivateAdminAccount(adminId, undefined, SUPER_ADMIN);

      const admin = await stored(adminId);
      expect(admin!.profile.status).toBe(UserStatus.INACTIVE);
      expect(admin!.provisioning.map((p) => [p.targetSystem, p.status])).toEqual([
        ['entra', 'SYNCED'],
        ['ad', 'SYNCED'],
      ]);
      const entry = (await stored(parentId))!.linkedAdminAccounts![0];
      expect(entry.status).toBe('INACTIVE');
      expect(entry.deactivatedAt).toBeInstanceOf(Date);
    }));

  it('still finds every account of a deactivated admin account to offboard', async () =>
    await withTestTenant(async () => {
      const { adminId } = await activatedAdmin();
      await pam.deactivateAdminAccount(adminId, undefined, SUPER_ADMIN);

      await expect(provisioning.getOffboardingTargets(adminId, TEST_TENANT_ID)).resolves.toEqual({
        noProvisioningState: false,
        targets: [
          { targetSystem: 'entra', externalId: ENTRA_OBJECT_ID, status: 'SYNCED' },
          { targetSystem: 'ad', externalId: AD_DN, status: 'SYNCED' },
        ],
      });
    }));

  it('targets the entries an earlier PAM deactivation marked DEPROVISIONED', async () =>
    await withTestTenant(async () => {
      const { adminId } = await activatedAdmin();
      // What deactivateAdminAccount meant to store before 2026-11-25: every entry DEPROVISIONED
      // with its other fields kept (provisionedAt too), nothing removed in the targets
      await identityModel.updateOne(
        { _id: adminId },
        {
          $set: {
            'profile.status': UserStatus.INACTIVE,
            'provisioning.$[].status': 'DEPROVISIONED',
          },
        },
      );

      await expect(provisioning.getOffboardingTargets(adminId, TEST_TENANT_ID)).resolves.toEqual({
        noProvisioningState: false,
        targets: [
          { targetSystem: 'entra', externalId: ENTRA_OBJECT_ID, status: 'DEPROVISIONED' },
          { targetSystem: 'ad', externalId: AD_DN, status: 'DEPROVISIONED' },
        ],
      });
    }));

  it('leaves out an admin entry an earlier offboarding deprovisioned (provisionedAt null)', async () =>
    await withTestTenant(async () => {
      const { adminId } = await activatedAdmin();
      // A rerun after the first run removed the Entra ID account and failed in AD
      await provisioning.updateProvisioningState(adminId, 'entra', 'DEPROVISIONED');

      const found = await provisioning.getOffboardingTargets(adminId, TEST_TENANT_ID);

      expect(found.targets.map((t) => [t.targetSystem, t.status])).toEqual([['ad', 'SYNCED']]);
    }));

  // Deprovisioned before the provisionedAt marker existed (no marker at all): offboarding can only
  // find such an account by its stored id. Without one, its deprovision fails on every rerun
  // (no DN, no object id) and the person stays suspended for an account that is gone.
  it('targets a DEPROVISIONED admin entry without the marker only when its account id is stored', async () =>
    await withTestTenant(async () => {
      const { adminId } = await activatedAdmin();
      await identityModel.updateOne(
        { _id: adminId },
        {
          $set: {
            provisioning: [
              { targetSystem: 'entra', status: 'DEPROVISIONED' },
              { targetSystem: 'ad', status: 'DEPROVISIONED' },
            ],
            // The Entra ID object id is stored, no AD distinguished name
            sources: [
              { sourceName: 'entra-id', externalId: ENTRA_OBJECT_ID, sourceRole: 'target' },
            ],
          },
        },
      );
      expect((await stored(adminId))!.provisioning[0]).not.toHaveProperty('provisionedAt');

      await expect(provisioning.getOffboardingTargets(adminId, TEST_TENANT_ID)).resolves.toEqual({
        noProvisioningState: false,
        targets: [{ targetSystem: 'entra', externalId: ENTRA_OBJECT_ID, status: 'DEPROVISIONED' }],
      });
    }));

  it('leaves out a DEPROVISIONED entry of an identity that is no admin account', async () =>
    await withTestTenant(async () => {
      const person = await identityModel.create({
        tenantId: TEST_TENANT_ID,
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@corp.example',
          status: UserStatus.ACTIVE,
        },
        sources: [],
        provisioning: [
          { targetSystem: 'entra', status: 'DEPROVISIONED', provisionedAt: new Date() },
          { targetSystem: 'okta', status: 'SYNCED' },
        ],
      });

      const found = await provisioning.getOffboardingTargets(String(person._id), TEST_TENANT_ID);

      expect(found.targets.map((t) => t.targetSystem)).toEqual(['okta']);
    }));
});
