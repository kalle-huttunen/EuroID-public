/**
 * Access review exclusions on in-memory MongoDB (tenant plugin): a revoke kept once per identity,
 * system and entitlement, found for the engine by identity id or by email, listed for the Access
 * tab, lifted once by an admin (audited, the next evaluation grants again), counted per granting
 * policy; all in the caller's tenant only. Events carry ids only and pass their Zod schemas.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import {
  ReviewExclusion,
  ReviewExclusionDocument,
  ReviewExclusionSchema,
} from './schemas/review-exclusion.schema';
import { ReviewExclusionService, type NewReviewExclusion } from './review-exclusion.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const ADA = '64b7f0c2a1b2c3d4e5f60a01';
const BOB = '64b7f0c2a1b2c3d4e5f60a02';
const ADMIN = 'policy.admin@tenant-a.example';
const REVIEWER = 'manager@tenant-a.example';

const salesGroup = (over: Partial<NewReviewExclusion> = {}): NewReviewExclusion => ({
  identityId: ADA,
  targetSystem: 'entra-id',
  scope: 'entitlement',
  entitlementType: 'group',
  entitlementName: 'SG-Sales',
  entitlementId: '8d0f6c1e-0000-4000-8000-000000000001',
  campaignId: 'camp-1',
  campaignName: 'Q4 review',
  itemId: 'item-1',
  decision: 'revoked',
  reviewer: REVIEWER,
  justification: 'Moved to Engineering, Ada Lovelace no longer sells',
  decidedAt: new Date('2026-11-20T10:00:00.000Z'),
  grantingPolicies: [{ policyId: 'pol-sales', policyName: 'Sales baseline' }],
  ...over,
});

describe('ReviewExclusionService (in-memory MongoDB)', () => {
  let model: Model<ReviewExclusionDocument>;
  let service: ReviewExclusionService;
  const events = { emit: jest.fn() };
  const identityQuery = {
    findById: jest.fn(async (id: string) => ([ADA, BOB].includes(id) ? { _id: id } : null)),
    findByEmail: jest.fn(async (email: string) =>
      email === 'ada@tenant-a.example' ? { _id: ADA } : null,
    ),
  };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => withTenantContext(tenantId, fn);

  /** The events of one type: [aggregateId, payload, options]. */
  const emitted = (type: DomainEventType) =>
    events.emit.mock.calls
      .filter(([t]) => t === type)
      .map(([, aggregateId, payload, options]) => ({ aggregateId, payload, options }));

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      ReviewExclusion.name,
      ReviewExclusionSchema,
    ) as unknown as Model<ReviewExclusionDocument>;
    await model.init(); // the unique index of active exclusions
    service = new ReviewExclusionService(
      model,
      identityQuery as unknown as IIdentityQueryPort,
      events as unknown as DomainEventEmitterService,
    );
  });

  afterEach(async () => {
    events.emit.mockReset();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('record', () => {
    it('keeps a revoke with its campaign, reviewer and justification, audited by ids', async () => {
      await expect(inTenant(A, () => service.record(salesGroup(), A))).resolves.toBe(true);

      const [stored] = await model.find({}).setOptions({ skipTenantScope: true }).lean();
      expect(stored).toMatchObject({
        tenantId: A,
        identityId: ADA,
        systemKey: 'entraid',
        entitlementKey: '8d0f6c1e-0000-4000-8000-000000000001',
        campaignName: 'Q4 review',
        reviewer: REVIEWER,
        justification: 'Moved to Engineering, Ada Lovelace no longer sells',
        status: 'active',
        grantingPolicies: [{ policyId: 'pol-sales', policyName: 'Sales baseline' }],
      });
      expect(stored.createdAt).toBeInstanceOf(Date);

      const [event] = emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED);
      expect(event.aggregateId).toBe(ADA);
      expect(event.options).toEqual({ actor: REVIEWER });
      expect(event.payload).toEqual({
        exclusionId: String(stored._id),
        identityId: ADA,
        targetSystem: 'entra-id',
        scope: 'entitlement',
        entitlementType: 'group',
        entitlementId: '8d0f6c1e-0000-4000-8000-000000000001',
        campaignId: 'camp-1',
        itemId: 'item-1',
        decision: 'revoked',
        grantingPolicyIds: ['pol-sales'],
      });
      const schema = EVENT_SCHEMAS[DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED]!;
      expect(schema.parse(event.payload)).toEqual(event.payload);
      expect(JSON.stringify(event.payload)).not.toMatch(/@|Lovelace|SG-Sales/);
    });

    it('keeps one active exclusion per identity, system and entitlement', async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      // A retried close, another campaign, the system under another name, the id in another case
      const again = salesGroup({
        campaignId: 'camp-2',
        itemId: 'item-9',
        targetSystem: 'entra',
        entitlementId: '8D0F6C1E-0000-4000-8000-000000000001',
      });
      await expect(inTenant(A, () => service.record(again, A))).resolves.toBe(false);
      const both = await Promise.all([
        inTenant(A, () => service.record(salesGroup({ entitlementId: 'g-2' }), A)),
        inTenant(A, () => service.record(salesGroup({ entitlementId: 'g-2' }), A)),
      ]);

      expect(both.sort()).toEqual([false, true]);
      expect(await model.countDocuments({}).setOptions({ skipTenantScope: true })).toBe(2);
      expect(emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED)).toHaveLength(2);
    });

    it('keeps an account item as one exclusion of its system; auto-revoke: no actor', async () => {
      const account = salesGroup({
        targetSystem: 'github',
        scope: 'account',
        entitlementType: 'account',
        entitlementName: 'Account',
        entitlementId: undefined,
        decision: 'expired',
        reviewer: undefined,
        justification: undefined,
      });
      await inTenant(A, () => service.record(account, A));
      await expect(
        inTenant(A, () => service.record({ ...account, itemId: 'item-2' }, A)),
      ).resolves.toBe(false);

      const [stored] = await model.find({}).setOptions({ skipTenantScope: true }).lean();
      expect(stored).toMatchObject({ scope: 'account', entitlementKey: '*', decision: 'expired' });
      expect(stored).not.toHaveProperty('reviewer');
      expect(emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED)[0].options).toBeUndefined();
    });
  });

  describe('activeForProfile', () => {
    beforeEach(async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      await inTenant(B, () => service.record(salesGroup({ identityId: BOB }), B));
    });

    it("finds the identity's exclusions by its id, in the tenant only", async () => {
      const found = await inTenant(A, () => service.activeForProfile({ _id: ADA }, A));
      expect(found).toEqual([
        {
          id: expect.any(String),
          campaignId: 'camp-1',
          systemKey: 'entraid',
          scope: 'entitlement',
          entitlementType: 'group',
          entitlementName: 'SG-Sales',
          entitlementId: '8d0f6c1e-0000-4000-8000-000000000001',
        },
      ]);
      expect(await inTenant(B, () => service.activeForProfile({ _id: ADA }, B))).toEqual([]);
    });

    it('finds them by email for a profile without an id (the mover, the preview)', async () => {
      const found = await inTenant(A, () =>
        service.activeForProfile({ email: 'ada@tenant-a.example' }, A),
      );
      expect(found).toHaveLength(1);
      expect(identityQuery.findByEmail).toHaveBeenCalledWith('ada@tenant-a.example');
      expect(
        await inTenant(A, () => service.activeForProfile({ email: 'new.hire@x.example' }, A)),
      ).toEqual([]);
    });
  });

  describe('listActive and lift', () => {
    let exclusionId: string;

    beforeEach(async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      exclusionId = String((await model.findOne({}).setOptions({ skipTenantScope: true }))!._id);
    });

    it('lists the active exclusions for the Access tab, without internal keys', async () => {
      const { exclusions } = await inTenant(A, () => service.listActive(ADA));
      expect(exclusions).toEqual([
        expect.objectContaining({
          _id: exclusionId,
          targetSystem: 'entra-id',
          entitlementName: 'SG-Sales',
          campaignName: 'Q4 review',
          reviewer: REVIEWER,
          justification: 'Moved to Engineering, Ada Lovelace no longer sells',
          status: 'active',
        }),
      ]);
      expect(exclusions[0]).not.toHaveProperty('tenantId');
      expect(exclusions[0]).not.toHaveProperty('entitlementKey');
      await expect(
        inTenant(A, () => service.listActive('64b7f0c2a1b2c3d4e5f60aff')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lifts once, audited with the admin; the engine no longer finds it', async () => {
      const lifted = await inTenant(A, () => service.lift(ADA, exclusionId, ADMIN));

      expect(lifted).toMatchObject({ _id: exclusionId, status: 'lifted', liftedBy: ADMIN });
      expect(lifted.liftedAt).toBeInstanceOf(Date);
      expect(await inTenant(A, () => service.activeForProfile({ _id: ADA }, A))).toEqual([]);
      expect((await inTenant(A, () => service.listActive(ADA))).exclusions).toEqual([]);
      const [event] = emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED);
      expect(event).toEqual({
        aggregateId: ADA,
        payload: {
          exclusionId,
          identityId: ADA,
          targetSystem: 'entra-id',
          scope: 'entitlement',
          campaignId: 'camp-1',
        },
        options: { actor: ADMIN },
      });
      const schema = EVENT_SCHEMAS[DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED]!;
      expect(schema.parse(event.payload)).toEqual(event.payload);

      await expect(inTenant(A, () => service.lift(ADA, exclusionId, ADMIN))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED)).toHaveLength(1);
    });

    it('a later revoke of the same access is kept again after the lift', async () => {
      await inTenant(A, () => service.lift(ADA, exclusionId, ADMIN));
      await expect(
        inTenant(A, () => service.record(salesGroup({ campaignId: 'camp-2' }), A)),
      ).resolves.toBe(true);
      expect(await inTenant(A, () => service.activeForProfile({ _id: ADA }, A))).toHaveLength(1);
    });

    it('lifts nothing of another identity or another tenant (404)', async () => {
      await expect(inTenant(A, () => service.lift(BOB, exclusionId, ADMIN))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(inTenant(B, () => service.lift(ADA, exclusionId, ADMIN))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await inTenant(A, () => service.activeForProfile({ _id: ADA }, A))).toHaveLength(1);
      expect(events.emit).not.toHaveBeenCalledWith(
        DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('countsByPolicy', () => {
    it('counts active and lifted exclusions per granting policy, in the tenant only', async () => {
      const both = [
        { policyId: 'pol-sales', policyName: 'Sales baseline' },
        { policyId: 'pol-all', policyName: 'Everyone' },
      ];
      await inTenant(A, () => service.record(salesGroup({ grantingPolicies: both }), A));
      await inTenant(A, () =>
        service.record(salesGroup({ identityId: BOB, grantingPolicies: both }), A),
      );
      await inTenant(A, () =>
        service.record(salesGroup({ entitlementId: 'g-2', grantingPolicies: [] }), A),
      );
      await inTenant(B, () => service.record(salesGroup(), B));
      const bobs = await model
        .findOne({ identityId: BOB })
        .setOptions({ skipTenantScope: true })
        .lean();
      await inTenant(A, () => service.lift(BOB, String(bobs!._id), ADMIN));

      const counts = await inTenant(A, () => service.countsByPolicy());

      expect(counts).toEqual([
        { policyId: 'pol-all', policyName: 'Everyone', active: 1, lifted: 1 },
        { policyId: 'pol-sales', policyName: 'Sales baseline', active: 1, lifted: 1 },
      ]);
    });
  });

  describe('the "before" side of a delta, account exclusions, offboarding', () => {
    const github = salesGroup({
      itemId: 'item-2',
      targetSystem: 'github',
      scope: 'account',
      entitlementType: 'account',
      entitlementName: 'Account',
      entitlementId: undefined,
    });

    it('counts an exclusion lifted after the baseline on the before side only', async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      const [doc] = await model.find({}).setOptions({ skipTenantScope: true }).lean();
      const baselineAt = new Date(Date.now() - 60_000);
      await inTenant(A, () => service.lift(ADA, String(doc._id), ADMIN));

      expect(await inTenant(A, () => service.activeForProfile({ _id: ADA }, A))).toEqual([]);
      expect(
        await inTenant(A, () => service.activeForProfile({ _id: ADA }, A, baselineAt)),
      ).toHaveLength(1);
      // A baseline recorded after the lift (a run gave the access back): no longer counted
      expect(
        await inTenant(A, () => service.activeForProfile({ _id: ADA }, A, new Date())),
      ).toEqual([]);
    });

    it('names the systems with an active account exclusion, as systemKeys', async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      await inTenant(A, () => service.record(github, A));
      await inTenant(B, () => service.record({ ...github, targetSystem: 'servicenow' }, B));

      expect(await inTenant(A, () => service.accountExcludedSystems(ADA, A))).toEqual(['github']);
      expect(await inTenant(A, () => service.accountExcludedSystems(BOB, A))).toEqual([]);
    });

    it("ends an offboarded identity's exclusions, lifted by the system and audited", async () => {
      await inTenant(A, () => service.record(salesGroup(), A));
      await inTenant(A, () => service.record(github, A));
      await inTenant(A, () => service.record(salesGroup({ identityId: BOB }), A));
      events.emit.mockReset();

      await expect(inTenant(A, () => service.endForOffboarding(ADA, A))).resolves.toBe(2);
      await expect(inTenant(A, () => service.endForOffboarding(ADA, A))).resolves.toBe(0);

      const adas = await model
        .find({ identityId: ADA })
        .setOptions({ skipTenantScope: true })
        .lean();
      for (const doc of adas) {
        expect(doc).toMatchObject({
          status: 'lifted',
          liftedBy: 'system',
          liftReason: 'identity offboarded',
        });
      }
      expect(await inTenant(A, () => service.activeForProfile({ _id: BOB }, A))).toHaveLength(1);
      const lifted = emitted(DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED);
      expect(lifted).toHaveLength(2);
      const schema = EVENT_SCHEMAS[DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED]!;
      for (const event of lifted) {
        expect(event.options).toEqual({ actor: 'system:offboarding' });
        expect(event.payload).toMatchObject({ identityId: ADA, reason: 'identity offboarded' });
        expect(schema.parse(event.payload)).toEqual(event.payload);
      }
    });
  });
});
