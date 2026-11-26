/**
 * createLinkedAdminIdentity and soft-deleted identities (in-memory MongoDB with the identity
 * indexes). The email is unique among live identities only (a partial unique index), but the
 * admin UPN check counted soft-deleted identities too, so a UPN that only a former employee's
 * deleted identity had was refused with 409 "already exists" although the index allowed it. The
 * idempotency lookup took a deleted admin identity of the tier for an existing one, so re-creating
 * the tier's admin account answered 201 with the deleted identity and created nothing.
 *
 * The UPN (admin-upn.ts): a namesake's live identity holding it gave 409, so the second person's
 * admin provisioning failed for good; now the next numeric suffix is used. A name with diacritics
 * reached Entra ID as is (Entra ID refuses non-ASCII in a UPN's local part). A person's second
 * tier got the UPN of their first; without `{tier}` in ADMIN_UPN_PATTERN that stays a 409, whose
 * message says how to allow one admin account per tier and names no address.
 */
import mongoose, { Model } from 'mongoose';
import { ConflictException } from '@nestjs/common';
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
import type { PrivilegedSessionService } from './privileged-session.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const PAM_CONFIG = {
  tier0MaxHours: 8,
  tier1MaxHours: 24,
  tier2MaxHours: 72,
  adminUpnPattern: 'adm-{firstName}.{lastName}@{domain}',
  adminUpnMaxSuffix: 20,
} as unknown as PamConfig;
/** The admin UPN the pattern gives the parent below. */
const ADMIN_EMAIL = 'adm-ada.lovelace@corp.example';

describe('Linked admin identity email check (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let service: PrivilegedAccessService;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes(); // the partial unique email index production has
    service = new PrivilegedAccessService(
      identityModel,
      {} as IdentityService,
      createMockEventEmitter() as unknown as DomainEventEmitterService,
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
      PAM_CONFIG,
      {} as PrivilegedSessionService,
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** An identity of the test tenant with this email, soft-deleted when `deletedAt` is given. */
  const identityWith = (email: string, firstName: string, deletedAt?: Date) =>
    identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: { firstName, lastName: 'Lovelace', email, status: UserStatus.ACTIVE },
      sources: [],
      ...(deletedAt ? { deletedAt, deletedBy: 'offboarding-workflow' } : {}),
    });

  it('creates the admin identity when only a deleted identity has its email', async () =>
    await withTestTenant(async () => {
      const parent = await identityWith('ada.lovelace@corp.example', 'Ada');
      // A former employee's admin account, offboarded: its address is free again
      await identityWith(ADMIN_EMAIL, 'Ada', new Date('2026-06-01T10:00:00Z'));

      const admin = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(admin.profile.email).toBe(ADMIN_EMAIL);
      expect(admin.deletedAt).toBeFalsy();
      const live = await identityModel.find({ 'profile.email': ADMIN_EMAIL, deletedAt: null });
      expect(live.map((doc) => String(doc._id))).toEqual([String(admin._id)]);
      const stored = await identityModel.findById(parent._id).lean().exec();
      expect(stored!.linkedAdminAccounts).toEqual([
        expect.objectContaining({ identityId: String(admin._id), adminTier: 'TIER_1' }),
      ]);
    }));

  it("creates a new admin identity when the tier's admin identity was deleted, then keeps it", async () =>
    await withTestTenant(async () => {
      const parent = await identityWith('ada.lovelace@corp.example', 'Ada');
      const first = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );
      // Offboarded: soft-deleted, its accounts removed
      await identityModel.updateOne(
        { _id: first._id },
        { $set: { deletedAt: new Date('2026-11-20T10:00:00Z'), deletedBy: 'offboarding' } },
      );

      const second = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );
      const again = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(String(second._id)).not.toBe(String(first._id));
      expect(second.deletedAt).toBeFalsy();
      expect(second.profile.email).toBe(ADMIN_EMAIL);
      // Idempotent again: the live one is returned, nothing more is created
      expect(String(again._id)).toBe(String(second._id));
      expect(await identityModel.countDocuments({ adminTier: 'TIER_1' })).toBe(2);
      const stored = await identityModel.findById(parent._id).lean().exec();
      expect(stored!.linkedAdminAccounts!.map((la) => la.identityId)).toEqual([
        String(first._id),
        String(second._id),
      ]);
    }));

  it("gives the UPN a numeric suffix when another person's live identity has it", async () =>
    await withTestTenant(async () => {
      const parent = await identityWith('ada.lovelace@corp.example', 'Ada');
      // A namesake's admin account (or any other live identity) holds the UPN
      await identityWith(ADMIN_EMAIL, 'Ada');
      await identityWith('adm-ada.lovelace2@corp.example', 'Ada');

      const admin = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(admin.profile.email).toBe('adm-ada.lovelace3@corp.example');
      expect(admin.profile.userPrincipalName).toBe('adm-ada.lovelace3@corp.example');
      expect(await identityModel.countDocuments({ 'profile.email': ADMIN_EMAIL })).toBe(1);
    }));

  it('writes a name with diacritics as ASCII in the admin UPN', async () =>
    await withTestTenant(async () => {
      const parent = await identityModel.create({
        tenantId: TEST_TENANT_ID,
        profile: {
          firstName: 'Jöns',
          lastName: 'Mäkinen',
          email: 'jons.makinen@corp.example',
          status: UserStatus.ACTIVE,
        },
        sources: [],
      });

      const admin = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_2',
        TEST_TENANT_ID,
      );

      expect(admin.profile.email).toBe('adm-jons.makinen@corp.example');
    }));

  it("refuses a person's second tier whose UPN is their other admin account's, naming {tier} and the env var", async () =>
    await withTestTenant(async () => {
      const parent = await identityWith('ada.lovelace@corp.example', 'Ada');
      const tier2 = await service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_2',
        TEST_TENANT_ID,
      );
      expect(tier2.profile.email).toBe(ADMIN_EMAIL);

      const refusal = service.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );

      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(refusal).rejects.toThrow(/ADMIN_UPN_PATTERN/);
      await expect(refusal).rejects.toThrow(/\{tier\}/);
      // No address in the message: it reaches the workflow history in clear
      await expect(refusal).rejects.not.toThrow(/ada\.lovelace|corp\.example/);
      expect(await identityModel.countDocuments({ adminTier: 'TIER_1' })).toBe(0);
    }));

  it('gives each tier its own admin account when the pattern has {tier}', async () =>
    await withTestTenant(async () => {
      const tiered = new PrivilegedAccessService(
        identityModel,
        {} as IdentityService,
        createMockEventEmitter() as unknown as DomainEventEmitterService,
        createMockLoggerFactory().factory as unknown as LoggerFactoryService,
        { ...PAM_CONFIG, adminUpnPattern: 'adm-{firstName}.{lastName}-{tier}@{domain}' },
        {} as PrivilegedSessionService,
      );
      const parent = await identityWith('ada.lovelace@corp.example', 'Ada');

      const tier2 = await tiered.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_2',
        TEST_TENANT_ID,
      );
      const tier1 = await tiered.createLinkedAdminIdentity(
        String(parent._id),
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(tier2.profile.email).toBe('adm-ada.lovelace-t2@corp.example');
      expect(tier1.profile.email).toBe('adm-ada.lovelace-t1@corp.example');
      const stored = await identityModel.findById(parent._id).lean().exec();
      expect(stored!.linkedAdminAccounts!.map((la) => la.adminTier)).toEqual(['TIER_2', 'TIER_1']);
    }));
});
