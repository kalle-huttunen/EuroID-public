/**
 * Activating an access review campaign (in-memory MongoDB, tenant plugin, the real
 * AccessReviewCampaignService and AccessReviewItemService; identities, memberships and Temporal
 * are stubs).
 *
 * Hunt 04 F6: items were created one by one with no cleanup. A failed Temporal start only put
 * the campaign back to DRAFT, so a second activation created a second set; an error partway did
 * the same; and two concurrent activations both passed the DRAFT read. r2-04 N6: the items a
 * failed activation left on the DRAFT campaign were in reviewers' My Reviews and could be
 * decided, while no workflow acted on them.
 *
 * Now an activation claims the campaign first (one at a time), clears what an earlier attempt
 * left, and on any failure deletes its items and puts the campaign back to DRAFT. Reviewers see
 * and decide items of an ACTIVE campaign only.
 */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { accessReviewConfig } from '@infrastructure/config/access-review.config';
import {
  CampaignStatus,
  ReviewCampaign,
  ReviewCampaignDocument,
  ReviewCampaignSchema,
} from './schemas/review-campaign.schema';
import { ReviewItem, ReviewItemDocument, ReviewItemSchema } from './schemas/review-item.schema';
import { ScimToken, ScimTokenSchema } from '../scim-inbound/schemas/scim-token.schema';
import { AdminUser, AdminUserSchema } from '../auth/schemas/admin-user.schema';
import { IdentityService } from '../identity/identity.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { ReviewTargetAccessService } from './review-target-access.service';
import { AccessReviewCampaignService } from './access-review-campaign.service';
import { AccessReviewItemService } from './access-review-item.service';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const REVIEWER = 'mia.manager@a.example';

/** Three people with one group each, all reviewed by their manager. */
const PEOPLE = ['ann', 'bob', 'cid'].map((name) => ({
  _id: `id-${name}`,
  email: `${name}@a.example`,
  firstName: name,
  managerEmail: REVIEWER,
  employmentType: 'FULL_TIME',
  provisioning: [],
  sources: [],
}));

describe('Access review: activating a campaign (MongoDB)', () => {
  let moduleRef: TestingModule;
  let campaigns: AccessReviewCampaignService;
  let items: AccessReviewItemService;
  let campaignModel: Model<ReviewCampaignDocument>;
  let itemModel: Model<ReviewItemDocument>;
  const start = jest.fn();
  const gather = jest.fn();
  let temporalDown = false;
  let people: Array<Record<string, unknown>> = PEOPLE;
  /** The tenant's live identities by employee id, as IdentityService answers the lookup. */
  const MANAGERS_BY_EMPLOYEE_ID: Record<string, string> = { 'E-2000': 'max.manager@a.example' };
  const findEmailsByEmployeeIds = jest.fn(
    async (ids: string[]) =>
      new Map(
        ids
          .filter((id) => MANAGERS_BY_EMPLOYEE_ID[id])
          .map((id) => [id, MANAGERS_BY_EMPLOYEE_ID[id]]),
      ),
  );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
          { name: ReviewItem.name, schema: ReviewItemSchema },
          { name: ScimToken.name, schema: ScimTokenSchema },
          { name: AdminUser.name, schema: AdminUserSchema },
        ]),
      ],
      providers: [
        AccessReviewCampaignService,
        AccessReviewItemService,
        {
          provide: IdentityService,
          useValue: { findAll: jest.fn(async () => people), findEmailsByEmployeeIds },
        },
        {
          provide: EntitlementCatalogService,
          useValue: {
            getCatalogEntriesBatch: jest.fn(async () => new Map()),
            isPolicyManaged: jest.fn(async () => false),
            getOwner: jest.fn(async () => null),
          },
        },
        { provide: ReviewTargetAccessService, useValue: { loadTargets: async () => ({}), gather } },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        {
          provide: TemporalClientProvider,
          useValue: {
            getClient: () => {
              if (temporalDown) throw new Error('Temporal is not connected (localhost:7233).');
              return { workflow: { start } };
            },
          },
        },
        {
          provide: accessReviewConfig.KEY,
          useValue: { defaultReviewer: 'unassigned@review.pending', activationClaimMs: 3_600_000 },
        },
        { provide: PluginRegistryService, useValue: {} },
      ],
    }).compile();
    campaigns = moduleRef.get(AccessReviewCampaignService);
    items = moduleRef.get(AccessReviewItemService);
    campaignModel = moduleRef.get(getModelToken(ReviewCampaign.name));
    itemModel = moduleRef.get(getModelToken(ReviewItem.name));
  });

  beforeEach(async () => {
    start.mockReset().mockResolvedValue(undefined);
    temporalDown = false;
    people = PEOPLE;
    gather
      .mockReset()
      .mockImplementation(async (holder: { email: string }) => [
        { system: 'entra-id', type: 'group', name: `G-${holder.email}`, nativeId: holder.email },
      ]);
    await campaignModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await itemModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await withTenantContext(A, () =>
      campaignModel.create({
        tenantId: A,
        campaignId: 'camp-1',
        name: 'Q4 review',
        scope: { type: 'all' },
        status: CampaignStatus.DRAFT,
        createdBy: 'admin@a.example',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const activate = () => inA(() => campaigns.activate('camp-1'));
  const itemCount = () =>
    itemModel.countDocuments({ campaignId: 'camp-1' }).setOptions({ skipTenantScope: true });
  const campaign = () =>
    campaignModel.findOne({ campaignId: 'camp-1' }).setOptions({ skipTenantScope: true }).lean();

  it('a failed Temporal start leaves no items and the campaign DRAFT', async () => {
    start.mockRejectedValueOnce(new Error('14 UNAVAILABLE'));

    await expect(activate()).rejects.toThrow('14 UNAVAILABLE');

    expect(await itemCount()).toBe(0);
    expect((await campaign())?.status).toBe(CampaignStatus.DRAFT);
  });

  // HX-A follow-up: the answer told the admin to restart the backend, which is wrong since the
  // Temporal client reconnects on its own (temporal-client.provider.ts)
  it('answers 503 asking to try again while Temporal cannot be reached', async () => {
    temporalDown = true;

    const error = await activate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toMatch(/try again/i);
    expect((error as Error).message).not.toMatch(/restart/i);
    expect(await itemCount()).toBe(0);
    expect((await campaign())?.status).toBe(CampaignStatus.DRAFT);
  });

  it('activating again after a failure gives one set of items', async () => {
    start.mockRejectedValueOnce(new Error('14 UNAVAILABLE'));
    await activate().catch(() => undefined);

    await activate();

    expect(await itemCount()).toBe(3);
    const after = await campaign();
    expect(after?.status).toBe(CampaignStatus.ACTIVE);
    expect(after?.stats.totalItems).toBe(3);
  });

  it('an error partway through the items leaves none behind', async () => {
    gather.mockImplementation(async (holder: { email: string }) => {
      if (holder.email === 'cid@a.example') throw new Error('Graph 503');
      return [{ system: 'entra-id', type: 'group', name: 'G', nativeId: holder.email }];
    });

    await expect(activate()).rejects.toThrow('Graph 503');

    expect(await itemCount()).toBe(0);
    expect((await campaign())?.status).toBe(CampaignStatus.DRAFT);
  });

  it('two activations at once give one set of items; the second is refused with 409', async () => {
    const results = await Promise.allSettled([activate(), activate()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictException);
    expect(await itemCount()).toBe(3);
    expect(start).toHaveBeenCalledTimes(1);
  });

  // Final review AG3: a slow activation A whose claim expired went on after B took over. A's
  // DRAFT-gated update then failed and A's release deleted B's items and put the running
  // campaign back to DRAFT.
  it('an activation that lost its claim to another never touches the campaign the other activated', async () => {
    let tookOver = false;
    gather.mockImplementation(async (holder: { email: string }) => {
      if (!tookOver) {
        tookOver = true;
        // A is slow: its claim expires and activation B takes the campaign over and finishes
        await campaignModel
          .updateOne(
            { campaignId: 'camp-1' },
            { $set: { activationStartedAt: new Date(Date.now() - 2 * 3_600_000) } },
          )
          .setOptions({ skipTenantScope: true });
        await activate();
      }
      return [{ system: 'entra-id', type: 'group', name: 'G', nativeId: holder.email }];
    });

    await expect(activate()).rejects.toBeInstanceOf(ConflictException);

    const after = await campaign();
    expect(after?.status).toBe(CampaignStatus.ACTIVE);
    expect(after?.workflowId).toBe(start.mock.calls[0][1].workflowId);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await itemCount()).toBe(3);
  });

  it('refreshes its claim while it generates items, so no one takes over a live activation', async () => {
    let claimDuringItems: Date | undefined;
    gather.mockImplementation(async (holder: { email: string }) => {
      // As if the activation had run for two hours so far
      await campaignModel
        .updateOne(
          { campaignId: 'camp-1' },
          { $set: { activationStartedAt: new Date(Date.now() - 2 * 3_600_000) } },
        )
        .setOptions({ skipTenantScope: true });
      return [{ system: 'entra-id', type: 'group', name: 'G', nativeId: holder.email }];
    });
    const create = jest.spyOn(itemModel, 'create');
    create.mockImplementationOnce(async (...args: unknown[]) => {
      claimDuringItems = (await campaign())?.activationStartedAt;
      create.mockRestore();
      return itemModel.create(...(args as Parameters<typeof itemModel.create>));
    });

    await activate();

    expect(claimDuringItems!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await campaign())?.status).toBe(CampaignStatus.ACTIVE);
  });

  it('activates a campaign whose earlier activation stopped without cleaning up', async () => {
    // A process that died partway: the claim is older than the claim timeout, items are left
    await campaignModel
      .updateOne(
        { campaignId: 'camp-1' },
        { $set: { activationStartedAt: new Date(Date.now() - 2 * 3_600_000) } },
      )
      .setOptions({ skipTenantScope: true });
    await inA(() =>
      itemModel.create({
        tenantId: A,
        itemId: 'left-over',
        campaignId: 'camp-1',
        identityId: 'id-ann',
        identityEmail: 'ann@a.example',
        identityName: 'ann',
        reviewerId: REVIEWER,
        entitlements: [{ system: 'entra-id', type: 'group', name: 'G' }],
        decision: 'pending',
      }),
    );

    await activate();

    expect(await itemCount()).toBe(3);
    expect(
      await itemModel.exists({ itemId: 'left-over' }).setOptions({ skipTenantScope: true }),
    ).toBeNull();
  });

  // r2-04 N7: with only managerId set (an HR employee id), the item's reviewer was that id,
  // which never matches a signed-in reviewer's email: nobody could decide it and it expired
  it('gives the item to a reviewer who can decide it when the manager is known by id only', async () => {
    people = [{ ...PEOPLE[0], managerEmail: undefined, managerId: 'E-1017' }];

    await activate();

    const [item] = await itemModel
      .find({ campaignId: 'camp-1' })
      .setOptions({ skipTenantScope: true })
      .lean();
    expect(item.reviewerId).toBe('unassigned@review.pending');
  });

  // HX-E2: a manager known only by managerId (an HR employee id) is looked up by the identity
  // with that employee id, so the manager reviews instead of the owner or the default reviewer
  it('gives the item to the manager found by their employee id', async () => {
    people = [
      { ...PEOPLE[0], managerEmail: undefined, managerId: 'E-2000' },
      { ...PEOPLE[1], managerEmail: undefined, managerId: 'E-2000' },
    ];
    findEmailsByEmployeeIds.mockClear();

    await activate();

    const found = await itemModel
      .find({ campaignId: 'camp-1' })
      .setOptions({ skipTenantScope: true })
      .lean();
    expect(found.map((item) => item.reviewerId)).toEqual([
      'max.manager@a.example',
      'max.manager@a.example',
    ]);
    // One lookup for the batch, each employee id once
    expect(findEmailsByEmployeeIds).toHaveBeenCalledTimes(1);
    expect(findEmailsByEmployeeIds).toHaveBeenCalledWith(['E-2000']);
  });

  describe('items of a campaign that is not active (r2-04 N6)', () => {
    beforeEach(async () => {
      await inA(() =>
        itemModel.create({
          tenantId: A,
          itemId: 'item-draft',
          campaignId: 'camp-1',
          identityId: 'id-ann',
          identityEmail: 'ann@a.example',
          identityName: 'ann',
          reviewerId: REVIEWER,
          entitlements: [{ system: 'entra-id', type: 'group', name: 'G' }],
          decision: 'pending',
        }),
      );
    });

    it('are not in the reviewer’s My Reviews', async () => {
      const mine = await inA(() => items.getMyReviews(REVIEWER));

      expect(mine.total).toBe(0);
      expect(mine.data).toEqual([]);
    });

    it('cannot be decided (409), and stay pending', async () => {
      await expect(
        inA(() => items.decide('item-draft', 'approved', REVIEWER)),
      ).rejects.toBeInstanceOf(ConflictException);
      const item = await itemModel
        .findOne({ itemId: 'item-draft' })
        .setOptions({ skipTenantScope: true });
      expect(item?.decision).toBe('pending');
    });
  });
});
