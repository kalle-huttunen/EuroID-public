/**
 * Deciding a review item (in-memory MongoDB, tenant plugin, the real AccessReviewItemService).
 *
 * Hunt 04 F14: decide read the item, checked it was pending, then saved it, so two decisions at
 * once both passed the check, the last write won and both emitted their event. The campaign
 * stats were a snapshot of every item written after each decision, so concurrent decisions could
 * leave them stale. Now the decision is a conditional update on a pending item (the second gets
 * 400), and the stats move by the one transition each decision made.
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import {
  CampaignStatus,
  ReviewCampaign,
  ReviewCampaignDocument,
  ReviewCampaignSchema,
} from './schemas/review-campaign.schema';
import { ReviewItem, ReviewItemDocument, ReviewItemSchema } from './schemas/review-item.schema';
import { AccessReviewItemService } from './access-review-item.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const REVIEWER = 'mia.manager@a.example';

describe('Access review: deciding an item (MongoDB)', () => {
  let moduleRef: TestingModule;
  let items: AccessReviewItemService;
  let campaignModel: Model<ReviewCampaignDocument>;
  let itemModel: Model<ReviewItemDocument>;
  const emit = jest.fn();
  const signal = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
          { name: ReviewItem.name, schema: ReviewItemSchema },
        ]),
      ],
      providers: [
        AccessReviewItemService,
        { provide: DomainEventEmitterService, useValue: { emit } },
        {
          provide: TemporalClientProvider,
          useValue: { getClient: () => ({ workflow: { getHandle: () => ({ signal }) } }) },
        },
      ],
    }).compile();
    items = moduleRef.get(AccessReviewItemService);
    campaignModel = moduleRef.get(getModelToken(ReviewCampaign.name));
    itemModel = moduleRef.get(getModelToken(ReviewItem.name));
  });

  beforeEach(async () => {
    emit.mockReset();
    signal.mockReset().mockResolvedValue(undefined);
    await campaignModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await itemModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await withTenantContext(A, async () => {
      await campaignModel.create({
        tenantId: A,
        campaignId: 'camp-1',
        name: 'Q4 review',
        scope: { type: 'all' },
        status: CampaignStatus.ACTIVE,
        createdBy: 'admin@a.example',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        workflowId: 'wf-1',
        stats: { totalItems: 3, approved: 0, revoked: 0, pending: 3, expired: 0 },
      });
      for (const itemId of ['item-1', 'item-2', 'item-3']) {
        await itemModel.create({
          tenantId: A,
          itemId,
          campaignId: 'camp-1',
          identityId: `id-${itemId}`,
          identityEmail: `${itemId}@a.example`,
          identityName: itemId,
          reviewerId: REVIEWER,
          entitlements: [{ system: 'entra-id', type: 'group', name: 'G' }],
          decision: 'pending',
        });
      }
    });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const stats = async () =>
    (
      await campaignModel
        .findOne({ campaignId: 'camp-1' })
        .setOptions({ skipTenantScope: true })
        .lean()
    )?.stats;

  it('two decisions on one item at once: one is recorded, the other gets 400', async () => {
    // Both decisions read the item as pending before either writes: each waits at the campaign
    // lookup (between the pending check and the write) until both got there
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const findCampaign = campaignModel.findOne.bind(campaignModel);
    const spy = jest.spyOn(campaignModel, 'findOne').mockImplementation(((
      ...args: Parameters<typeof campaignModel.findOne>
    ) => {
      const query = findCampaign(...args);
      return {
        exec: async () => {
          if (++arrived === 2) release();
          await bothRead;
          return query.exec();
        },
      };
    }) as never);

    const results = await Promise.allSettled([
      inA(() => items.decide('item-1', 'approved', REVIEWER)),
      inA(() => items.decide('item-1', 'revoked', REVIEWER, 'no longer needed')),
    ]);

    spy.mockRestore();

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BadRequestException);
    expect(emit).toHaveBeenCalledTimes(1);
    const item = await itemModel
      .findOne({ itemId: 'item-1' })
      .setOptions({ skipTenantScope: true });
    const won = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<ReviewItemDocument>
    ).value;
    expect(item?.decision).toBe(won.decision);
    expect(await stats()).toMatchObject({ totalItems: 3, pending: 2 });
  });

  it('decisions on different items at once all count in the stats', async () => {
    await Promise.all([
      inA(() => items.decide('item-1', 'approved', REVIEWER)),
      inA(() => items.decide('item-2', 'approved', REVIEWER)),
      inA(() => items.decide('item-3', 'revoked', REVIEWER, 'left the team')),
    ]);

    expect(await stats()).toMatchObject({
      totalItems: 3,
      approved: 2,
      revoked: 1,
      pending: 0,
      expired: 0,
    });
    expect(signal).toHaveBeenCalledTimes(3);
  });
});
