/**
 * AccessReviewItemService.countActiveCampaignsInAllTenants (in-memory MongoDB, tenant plugin): the
 * euroid_access_review_campaigns_active gauge, counted when Prometheus scrapes, outside any tenant
 * context. Only ACTIVE campaigns count, in every tenant.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
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
  type ReviewItemDocument,
} from './schemas/review-item.schema';
import { AccessReviewItemService } from './access-review-item.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof AccessReviewItemService>;

describe('Active access review campaigns in every tenant (MongoDB)', () => {
  let campaignModel: Model<ReviewCampaignDocument>;
  let items: AccessReviewItemService;

  beforeAll(async () => {
    await connectTestDb();
    campaignModel = mongoose.model(
      ReviewCampaign.name,
      ReviewCampaignSchema,
    ) as unknown as Model<ReviewCampaignDocument>;
    const itemModel = mongoose.model(
      ReviewItem.name,
      ReviewItemSchema,
    ) as unknown as Model<ReviewItemDocument>;
    items = new AccessReviewItemService(
      campaignModel as unknown as Ctor[0],
      itemModel as unknown as Ctor[1],
      { emit: jest.fn() } as unknown as Ctor[2],
      { getClient: jest.fn() } as unknown as Ctor[3],
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const seed = (tenantId: string, name: string, status: CampaignStatus) =>
    withTenantContext(tenantId, () =>
      campaignModel.create({
        tenantId,
        campaignId: `${tenantId}-${name}`,
        name,
        scope: { type: 'all' },
        status,
        createdBy: 'admin@corp.example',
        deadline: new Date(Date.now() + 86_400_000),
      }),
    );

  it('counts the ACTIVE campaigns of every tenant, no other status', async () => {
    await seed('tenant-a', 'q1', CampaignStatus.ACTIVE);
    await seed('tenant-b', 'q1', CampaignStatus.ACTIVE);
    await seed('tenant-a', 'draft', CampaignStatus.DRAFT);
    await seed('tenant-a', 'done', CampaignStatus.COMPLETED);
    await seed('tenant-b', 'stopped', CampaignStatus.CANCELLED);

    expect(await items.countActiveCampaignsInAllTenants()).toBe(2);
  });
});
