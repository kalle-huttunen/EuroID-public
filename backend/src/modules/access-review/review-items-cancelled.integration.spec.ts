/**
 * A cancelled campaign's items are closed to reviewers (in-memory MongoDB, tenant plugin). Before,
 * POST /access-reviews/items/:itemId/decide still recorded a decision on an open item of a
 * CANCELLED campaign, and GET /access-reviews/my-reviews still listed it, although nothing acts on
 * such a decision: the workflow is cancelled and listRevocationTasks revokes nothing for the
 * campaign. Now the decide is a 409 that names the campaign, and My Reviews leaves the campaign's
 * items out (pending and decided), with a total that counts without them.
 */
import { ConflictException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventType } from '@infrastructure/events/event-types';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import {
  CampaignStatus,
  ReviewCampaign,
  ReviewCampaignSchema,
  type ReviewCampaignDocument,
} from './schemas/review-campaign.schema';
import {
  ReviewItem,
  ReviewItemSchema,
  type ReviewDecision,
  type ReviewItemDocument,
} from './schemas/review-item.schema';
import { AccessReviewItemService } from './access-review-item.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof AccessReviewItemService>;

const A = 'tenant-a';
const REVIEWER = 'manager@a.example';

describe('Access review: a cancelled campaign is closed to reviewers (MongoDB)', () => {
  let campaignModel: Model<ReviewCampaignDocument>;
  let itemModel: Model<ReviewItemDocument>;
  let items: AccessReviewItemService;
  const events = { emit: jest.fn() };
  const signal = jest.fn();
  const getHandle = jest.fn(() => ({ signal }));

  beforeAll(async () => {
    await connectTestDb();
    campaignModel = mongoose.model(
      ReviewCampaign.name,
      ReviewCampaignSchema,
    ) as unknown as Model<ReviewCampaignDocument>;
    itemModel = mongoose.model(
      ReviewItem.name,
      ReviewItemSchema,
    ) as unknown as Model<ReviewItemDocument>;
    items = new AccessReviewItemService(
      campaignModel as unknown as Ctor[0],
      itemModel as unknown as Ctor[1],
      events as unknown as Ctor[2],
      { getClient: () => ({ workflow: { getHandle } }) } as unknown as Ctor[3],
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  const seedCampaign = (campaignId: string, name: string, status: CampaignStatus) =>
    inA(() =>
      campaignModel.create({
        tenantId: A,
        campaignId,
        name,
        scope: { type: 'all' },
        status,
        createdBy: 'admin@a.example',
        deadline: new Date(Date.now() + 7 * 86_400_000),
        workflowId: `wf-${campaignId}`,
      }),
    );

  const seedItem = (itemId: string, campaignId: string, decision: ReviewDecision = 'pending') =>
    inA(() =>
      itemModel.create({
        tenantId: A,
        itemId,
        campaignId,
        identityId: `id-${itemId}`,
        identityEmail: `${itemId}@a.example`,
        identityName: `Person ${itemId}`,
        reviewerId: REVIEWER,
        entitlements: [{ system: 'entra-id', type: 'group', name: 'SG-Finance' }],
        decision,
      }),
    );

  const decisionOf = async (itemId: string) =>
    (await itemModel.findOne({ itemId }).setOptions({ skipTenantScope: true }).lean())?.decision;

  it.each([
    ['approve', 'approved' as const, undefined],
    ['revoke', 'revoked' as const, 'No longer in finance'],
  ])(
    'refuses to %s an open item of a cancelled campaign: 409, nothing written',
    async (_label, decision, justification) => {
      await seedCampaign('camp-x', 'Q4 review: Finance', CampaignStatus.CANCELLED);
      await seedItem('item-1', 'camp-x');

      const refused = inA(() => items.decide('item-1', decision, REVIEWER, justification));

      await expect(refused).rejects.toBeInstanceOf(ConflictException);
      await expect(refused).rejects.toThrow(
        'Campaign "Q4 review: Finance" was cancelled: its items can no longer be decided',
      );
      expect(await decisionOf('item-1')).toBe('pending');
      expect(events.emit).not.toHaveBeenCalled();
      expect(getHandle).not.toHaveBeenCalled();
    },
  );

  it('decides an open item of an active campaign as before (control)', async () => {
    await seedCampaign('camp-a', 'Q4 review: Sales', CampaignStatus.ACTIVE);
    await seedItem('item-1', 'camp-a');

    await inA(() => items.decide('item-1', 'approved', REVIEWER));

    expect(await decisionOf('item-1')).toBe('approved');
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.ACCESS_REVIEW_ITEM_APPROVED,
      'item-1',
      expect.objectContaining({ campaignId: 'camp-a' }),
    );
    expect(getHandle).toHaveBeenCalledWith('wf-camp-a');
    expect(signal).toHaveBeenCalledWith('signalItemDecided');
  });

  it("leaves a cancelled campaign's items out of My Reviews, and out of the total", async () => {
    await seedCampaign('camp-a', 'Q4 review: Sales', CampaignStatus.ACTIVE);
    await seedCampaign('camp-done', 'Q3 review: Sales', CampaignStatus.COMPLETED);
    await seedCampaign('camp-x', 'Q4 review: Finance', CampaignStatus.CANCELLED);
    await seedItem('active-open', 'camp-a');
    await seedItem('active-approved', 'camp-a', 'approved');
    await seedItem('done-revoked', 'camp-done', 'revoked');
    await seedItem('cancelled-open', 'camp-x');
    await seedItem('cancelled-approved', 'camp-x', 'approved');

    const pending = await inA(() => items.getMyReviews(REVIEWER, { decision: 'pending' }));
    expect(pending.data.map((i) => i.itemId)).toEqual(['active-open']);
    expect(pending.total).toBe(1);

    const all = await inA(() => items.getMyReviews(REVIEWER));
    expect(all.data.map((i) => i.itemId).sort()).toEqual([
      'active-approved',
      'active-open',
      'done-revoked',
    ]);
    expect(all.total).toBe(3);
  });
});
