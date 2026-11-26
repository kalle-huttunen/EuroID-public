import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import type { Model } from 'mongoose';
import { IdentityMutationService } from './identity-mutation.service';
import { ReconciliationService } from './reconciliation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityQueryService } from './identity-query.service';
import { Identity, IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { conflictFlagsOf, hubStateOf } from './identity-hub-state';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  createMockEventEmitter,
  createMockLoggerFactory,
  TEST_TENANT_ID,
  withTestTenant,
} from '@testing/test-helpers';

/**
 * A bulk rollback puts back what a Golden Record sync wrote: the captured profile, sources,
 * metadata and soft-delete marker, through a JSON snapshot. Run against MongoDB so the casting
 * of that JSON (dates, ids) and the tenant scoping are real.
 */
describe('Golden Record rollback (Integration)', () => {
  let moduleRef: TestingModule;
  let model: Model<IdentityDocument>;
  let service: IdentityMutationService;
  const eventEmitter = createMockEventEmitter();
  /** The tenant's Hashed National ID rule: a rollback removes its field and hetu. */
  const correlation = {
    nationalIdRuleOf: jest
      .fn()
      .mockResolvedValue({ strategy: 'hashedNationalId', nationalIdSourceField: 'henkilotunnus' }),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityMutationService,
        { provide: IdentityCorrelationService, useValue: correlation },
        { provide: IdentityQueryService, useValue: {} },
        // Asked only by an edit through PATCH /identity/:id (HR-mastered fields), not by a rollback
        { provide: ReconciliationService, useValue: {} },
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
      ],
    }).compile();
    service = moduleRef.get(IdentityMutationService);
    model = moduleRef.get(getModelToken(Identity.name));
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await model.deleteMany({ tenantId: { $in: [TEST_TENANT_ID, 'other-tenant'] } });
    eventEmitter.emit.mockClear();
  });

  const createIdentity = (tenantId = TEST_TENANT_ID) =>
    model.create({
      tenantId,
      profile: {
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        jobTitle: 'Analyst',
      },
      sources: [
        {
          sourceName: 'csv-hr',
          externalId: 'EMP-1',
          lastSync: new Date('2026-01-02T03:04:05Z'),
          rawData: { jobTitle: 'Analyst' },
        },
      ],
      metadata: { version: 2, correlationStatus: 'correlated' },
      deletedAt: new Date('2026-02-01T00:00:00Z'),
      deletedBy: 'offboarding-workflow',
    });

  it('puts back the profile, sources, metadata and soft-delete marker it captured', async () => {
    const identity = await createIdentity();
    const before = hubStateOf(identity);
    // What a sync writes: new profile values, a second source, a bumped version, undeleted.
    identity.set('profile', {
      ...(before.profile as object),
      jobTitle: 'Director',
      mobilePhone: '+358 40 1',
    });
    identity.sources.push({ sourceName: 'json-hr', externalId: 'X-9', rawData: {} } as never);
    identity.metadata = { version: 3, correlationStatus: 'correlated' };
    identity.deletedAt = undefined;
    identity.deletedBy = undefined;
    await identity.save();

    const restored = await withTestTenant(() =>
      service.restoreHubState(String(identity._id), JSON.parse(JSON.stringify(before))),
    );

    expect(restored).toBe(true);
    const after = await model.findById(identity._id).lean();
    expect(after?.profile).toMatchObject({ jobTitle: 'Analyst' });
    expect((after?.profile as { mobilePhone?: string }).mobilePhone).toBeUndefined();
    expect(after?.sources.map((s) => s.sourceName)).toEqual(['csv-hr']);
    expect(after?.sources[0].lastSync).toEqual(new Date('2026-01-02T03:04:05Z'));
    expect(after?.metadata).toEqual({ version: 2, correlationStatus: 'correlated' });
    expect(after?.deletedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(after?.deletedBy).toBe('offboarding-workflow');
    // A save() of a copy loaded before the restore now fails instead of undoing it.
    expect(after?.__v).toBeGreaterThan(identity.__v ?? 0);
  });

  // HX-E4: a bulk CREATE or UPDATE now marks the identity's Entra ID entry SYNCED after its Hub
  // write; the rollback that undoes the write puts that entry back as it was.
  it('puts back the Entra ID entries it captured and leaves the other entries as they are now', async () => {
    const identity = await createIdentity();
    identity.provisioning = [
      { targetSystem: 'ad', status: 'PENDING' },
      { targetSystem: 'entra', status: 'DEPROVISIONED', provisionedAt: null },
    ] as never;
    await identity.save();
    const before = hubStateOf(identity);
    // The bulk operation marks Entra ID SYNCED; meanwhile onboarding marked AD SYNCED
    await model.updateOne(
      { _id: identity._id },
      {
        $set: {
          provisioning: [
            { targetSystem: 'ad', status: 'SYNCED', provisionedAt: new Date() },
            { targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() },
          ],
        },
      },
    );

    await withTestTenant(() =>
      service.restoreHubState(String(identity._id), JSON.parse(JSON.stringify(before))),
    );

    const after = await model.findById(identity._id).lean();
    const byTarget = Object.fromEntries(
      (after?.provisioning ?? []).map((p) => [p.targetSystem, p.status]),
    );
    expect(byTarget).toEqual({ ad: 'SYNCED', entra: 'DEPROVISIONED' });
  });

  // Final review ID1: the restore read the entries, then wrote the whole array, so an entry
  // another writer changed in between was lost
  it('keeps an entry another writer changes between its read and its write', async () => {
    const identity = await createIdentity();
    identity.provisioning = [{ targetSystem: 'entra', status: 'DEPROVISIONED' }] as never;
    await identity.save();
    const before = hubStateOf(identity);
    await model.updateOne(
      { _id: identity._id },
      { $set: { provisioning: [{ targetSystem: 'entra', status: 'SYNCED' }] } },
    );
    const original = model.updateOne.bind(model);
    const spy = jest.spyOn(model, 'updateOne').mockImplementationOnce(((
      filter: unknown,
      update: unknown,
    ) => ({
      exec: async () => {
        // Onboarding marks AD SYNCED on the same identity at that moment
        await model.collection.updateOne({ _id: identity._id }, {
          $push: { provisioning: { targetSystem: 'ad', status: 'SYNCED' } },
        } as never);
        return original(filter as never, update as never).exec();
      },
    })) as never);

    await withTestTenant(() =>
      service.restoreHubState(String(identity._id), JSON.parse(JSON.stringify(before))),
    );
    spy.mockRestore();

    const after = await model.findById(identity._id).lean();
    const byTarget = Object.fromEntries(
      (after?.provisioning ?? []).map((p) => [p.targetSystem, p.status]),
    );
    expect(byTarget).toEqual({ ad: 'SYNCED', entra: 'DEPROVISIONED' });
    expect(after?.profile).toMatchObject({ jobTitle: 'Analyst' });
  });

  it('removes the Entra ID entry the bulk operation added to an identity that had none', async () => {
    const identity = await createIdentity();
    const before = hubStateOf(identity);
    expect(before.entraProvisioning).toEqual([]);
    await model.updateOne(
      { _id: identity._id },
      { $set: { provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }] } },
    );

    await withTestTenant(() =>
      service.restoreHubState(String(identity._id), JSON.parse(JSON.stringify(before))),
    );

    expect((await model.findById(identity._id).lean())?.provisioning).toEqual([]);
  });

  it('leaves the provisioning state as it is for a snapshot taken before HX-E4', async () => {
    const identity = await createIdentity();
    const { entraProvisioning: _none, ...older } = hubStateOf(identity);
    await model.updateOne(
      { _id: identity._id },
      { $set: { provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }] } },
    );

    await withTestTenant(() =>
      service.restoreHubState(String(identity._id), JSON.parse(JSON.stringify(older))),
    );

    const after = await model.findById(identity._id).lean();
    expect(after?.provisioning?.map((p) => p.targetSystem)).toEqual(['entra-id']);
  });

  it('clears a soft-delete marker the sync set on an identity that had none', async () => {
    const identity = await createIdentity();
    identity.deletedAt = undefined;
    identity.deletedBy = undefined;
    await identity.save();
    const before = hubStateOf(identity);
    identity.deletedAt = new Date();
    identity.deletedBy = 'x';
    await identity.save();

    await withTestTenant(() => service.restoreHubState(String(identity._id), before));

    const after = await model.findById(identity._id).lean();
    expect(after?.deletedAt).toBeUndefined();
    expect(after?.deletedBy).toBeUndefined();
  });

  it('touches no identity of another tenant', async () => {
    const identity = await createIdentity('other-tenant');
    const before = hubStateOf(identity);

    await expect(
      withTestTenant(() =>
        service.restoreHubState(String(identity._id), { ...before, metadata: { version: 99 } }),
      ),
    ).resolves.toBe(false);
    await expect(
      withTestTenant(() => service.removeIdentity(String(identity._id), 'bulk-rollback')),
    ).resolves.toBe(false);
    expect(await model.findById(identity._id).lean()).toMatchObject({ metadata: { version: 2 } });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('removes an identity the sync created and records why', async () => {
    const identity = await createIdentity();

    await expect(
      withTestTenant(() => service.removeIdentity(String(identity._id), 'bulk-rollback')),
    ).resolves.toBe(true);

    expect(await model.findById(identity._id).lean()).toBeNull();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      DomainEventType.IDENTITY_DELETED,
      String(identity._id),
      { identityId: String(identity._id), reason: 'bulk-rollback' },
      { actor: 'bulk-rollback' },
    );
  });

  // FOLLOWUPS 2026-11-25 (rollback-snapshot.schema.ts:57): a snapshot taken before migration
  // 20261125000000 holds raw national IDs; a rollback must not write them back
  it('writes back no national ID a snapshot taken before the cleanup holds', async () => {
    const identity = await createIdentity();
    const before = hubStateOf(identity);
    const raw = { henkilotunnus: '131085-999X', hetu: '131085-999X', site: 'HQ' };
    const old = {
      ...before,
      profile: { ...(before.profile as object), customAttributes: raw },
      sources: [
        {
          ...(before.sources[0] as object),
          rawData: { jobTitle: 'Analyst', hetu: '131085-999X', customAttributes: raw },
        },
      ],
      metadata: {
        ...before.metadata,
        conflictDetails: {
          matchedBy: 'email',
          incomingSource: { sourceName: 'json-hr', rawData: { customAttributes: raw } },
        },
      },
    };

    await withTestTenant(() => service.restoreHubState(String(identity._id), old));

    const after = await model.findById(identity._id).lean();
    expect(JSON.stringify(after)).not.toContain('131085');
    expect((after?.profile as { customAttributes?: unknown }).customAttributes).toEqual({
      site: 'HQ',
    });
    expect(after?.sources[0].rawData).toEqual({
      jobTitle: 'Analyst',
      customAttributes: { site: 'HQ' },
    });
    expect(after?.metadata?.conflictDetails?.incomingSource?.rawData).toEqual({
      customAttributes: { site: 'HQ' },
    });
    expect(correlation.nationalIdRuleOf).toHaveBeenCalledWith(TEST_TENANT_ID);
  });

  describe('conflict flags a low-confidence match set on another identity', () => {
    /** What the match writes on the existing identity when it mints `incomingId`. */
    const flagConflict = async (identity: IdentityDocument, incomingId: string) => {
      identity.metadata = {
        ...identity.metadata,
        correlationConflict: true,
        requiresReview: true,
        conflictDetails: {
          matchedBy: 'employeeNumber',
          confidence: 0.5,
          incomingSnapshot: { email: 'grace@example.com' },
          incomingIdentityId: incomingId,
        },
      };
      await identity.save();
    };

    it('puts back the flags as they were and unsets the ones that were not there', async () => {
      const identity = await createIdentity();
      const before = conflictFlagsOf(identity);
      await flagConflict(identity, 'minted-1');

      await expect(
        withTestTenant(() =>
          service.restoreConflictFlags(JSON.parse(JSON.stringify(before)), 'minted-1'),
        ),
      ).resolves.toBe(true);

      const after = await model.findById(identity._id).lean();
      expect(after?.metadata).toEqual({ version: 2, correlationStatus: 'correlated' });
      expect(after?.__v).toBeGreaterThan(identity.__v ?? 0);
    });

    it('brings back an earlier conflict the match replaced', async () => {
      const identity = await createIdentity();
      await flagConflict(identity, 'minted-0');
      const before = conflictFlagsOf(identity);
      await flagConflict(identity, 'minted-1');

      await withTestTenant(() => service.restoreConflictFlags(before, 'minted-1'));

      const after = await model.findById(identity._id).lean();
      expect(after?.metadata?.conflictDetails?.incomingIdentityId).toBe('minted-0');
      expect(after?.metadata?.requiresReview).toBe(true);
    });

    it('writes back no national ID a held row of the snapshot holds', async () => {
      const identity = await createIdentity();
      identity.metadata = {
        ...identity.metadata,
        requiresReview: true,
        conflictDetails: {
          matchedBy: 'email',
          confidence: 0,
          incomingIdentityId: 'minted-0',
          incomingSource: {
            sourceName: 'json-hr',
            externalId: 'X-1',
            lastSync: new Date('2026-01-02T03:04:05Z'),
            rawData: { hetu: '131085-999X', customAttributes: { henkilotunnus: '131085-999X' } },
          },
        },
      };
      await identity.save();
      const before = conflictFlagsOf(identity);
      await flagConflict(identity, 'minted-1');

      await withTestTenant(() => service.restoreConflictFlags(before, 'minted-1'));

      const after = await model.findById(identity._id).lean();
      expect(after?.metadata?.conflictDetails?.incomingIdentityId).toBe('minted-0');
      expect(after?.metadata?.conflictDetails?.incomingSource?.rawData).toEqual({});
    });

    it('leaves a conflict that was resolved or replaced since', async () => {
      const identity = await createIdentity();
      const before = conflictFlagsOf(identity);
      await flagConflict(identity, 'minted-2');

      await expect(
        withTestTenant(() => service.restoreConflictFlags(before, 'minted-1')),
      ).resolves.toBe(false);
      const after = await model.findById(identity._id).lean();
      expect(after?.metadata?.conflictDetails?.incomingIdentityId).toBe('minted-2');
    });

    it('touches no identity of another tenant', async () => {
      const identity = await createIdentity('other-tenant');
      const before = conflictFlagsOf(identity);
      await flagConflict(identity, 'minted-1');

      await expect(
        withTestTenant(() => service.restoreConflictFlags(before, 'minted-1')),
      ).resolves.toBe(false);
      expect((await model.findById(identity._id).lean())?.metadata?.correlationConflict).toBe(true);
    });
  });
});
