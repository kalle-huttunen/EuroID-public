/**
 * My Reviews matches the reviewer without case (in-memory MongoDB, tenant plugin). HX-H follow-up:
 * GET /access-reviews/my-reviews matched `reviewerId` exactly, while decide compares without case,
 * so a reviewer whose stored address differed in case from the email in their token (an HR feed's
 * `Mia.Manager@...` manager email, a sign-in as `mia.manager@...`) never saw their items, which
 * expired undecided. A reviewer id is now stored trimmed and lower-cased (the schema, on create
 * and on the escalation's update), My Reviews asks for the token email lower-cased, and migration
 * 20261126000005 lower-cases the reviewer ids stored before.
 */
import mongoose, { Model } from 'mongoose';
import type { Db } from 'mongodb';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { up, down } from '../../../migrations/20261126000005-review-item-reviewer-lowercase';
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

mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof AccessReviewItemService>;

const A = 'tenant-a';
const B = 'tenant-b';

describe('Access review: My Reviews matches the reviewer without case (MongoDB)', () => {
  let db: Db;
  let campaignModel: Model<ReviewCampaignDocument>;
  let itemModel: Model<ReviewItemDocument>;
  let items: AccessReviewItemService;

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
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
      { emit: jest.fn() } as unknown as Ctor[2],
      {
        getClient: () => ({ workflow: { getHandle: () => ({ signal: jest.fn() }) } }),
      } as unknown as Ctor[3],
    );
  });

  beforeEach(async () => {
    await withTenantContext(A, () =>
      campaignModel.create({
        tenantId: A,
        campaignId: 'camp-a',
        name: 'Q4 review',
        scope: { type: 'all' },
        status: CampaignStatus.ACTIVE,
        createdBy: 'admin@a.example',
        deadline: new Date(Date.now() + 7 * 86_400_000),
      }),
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const itemDoc = (itemId: string, reviewerId: string, tenantId = A) => ({
    tenantId,
    itemId,
    campaignId: 'camp-a',
    identityId: `id-${itemId}`,
    identityEmail: `${itemId}@a.example`,
    identityName: `Person ${itemId}`,
    reviewerId,
    entitlements: [{ system: 'entra-id', type: 'group', name: 'SG-Finance' }],
    decision: 'pending',
  });
  const myItems = async (tokenEmail: string) =>
    (await inA(() => items.getMyReviews(tokenEmail))).data.map((i) => i.itemId);

  it('stores a reviewer id trimmed and lower-cased, on create and on update', async () => {
    await inA(() => itemModel.create(itemDoc('item-1', '  Mia.Manager@A.example ')));
    // The escalation moves an item with updateOne
    await inA(() =>
      itemModel
        .updateOne({ itemId: 'item-1' }, { $set: { reviewerId: 'Max.Boss@A.example' } })
        .exec(),
    );
    await inA(() => itemModel.create(itemDoc('item-2', 'Mia.Manager@A.example')));

    const stored = await itemModel
      .find({})
      .sort({ itemId: 1 })
      .setOptions({ skipTenantScope: true })
      .lean();
    expect(stored.map((i) => i.reviewerId)).toEqual([
      'max.boss@a.example',
      'mia.manager@a.example',
    ]);
  });

  it("lists the reviewer's items whatever the case of the token email", async () => {
    await inA(() => itemModel.create(itemDoc('item-1', 'Mia.Manager@A.example')));

    expect(await myItems('mia.manager@a.example')).toEqual(['item-1']);
    expect(await myItems('MIA.MANAGER@A.EXAMPLE')).toEqual(['item-1']);
    expect(await myItems('max.boss@a.example')).toEqual([]);
  });

  describe('migration 20261126000005', () => {
    it('lower-cases the reviewer ids stored before, in every tenant, and is safe to rerun', async () => {
      // Written before the release: around the schema, in the case the source had
      await db
        .collection('review_items')
        .insertMany([
          itemDoc('old-1', 'Mia.Manager@A.example'),
          itemDoc('old-2', 'mia.manager@a.example'),
          itemDoc('old-3', 'Ola.Owner@B.example', B),
        ]);
      expect(await myItems('mia.manager@a.example')).toEqual(['old-2']);

      await up(db);
      await up(db);

      expect((await myItems('Mia.Manager@a.example')).sort()).toEqual(['old-1', 'old-2']);
      const other = await db.collection('review_items').findOne({ itemId: 'old-3' });
      expect(other?.reviewerId).toBe('ola.owner@b.example');
    });

    it('down changes nothing (the original case is not kept)', async () => {
      await db.collection('review_items').insertOne(itemDoc('old-1', 'mia.manager@a.example'));
      await expect(down()).resolves.toBeUndefined();
      const after = await db.collection('review_items').findOne({ itemId: 'old-1' });
      expect(after?.reviewerId).toBe('mia.manager@a.example');
    });
  });
});
