/**
 * Cancelling an access review campaign (in-memory MongoDB, tenant plugin): the cancel stops the
 * campaign's accessReviewWorkflow through Temporal cancellation, and the workflow's activities
 * leave a cancelled campaign alone, in case one is still running or Temporal could not be
 * reached: no escalation, no expiry of pending items, no completion (the campaign stays
 * CANCELLED). The workflow side runs in test/workflows/access-review-revocation.workflow.e2e-spec.ts.
 * The cancel is audited (access_review.campaign_cancelled with the optional reason) and leaves the
 * items' decisions as they are, as the cancel dialog tells the admin. Cancelling a recurring
 * campaign ends the recurrence (the recertification scheduler clones only completed campaigns:
 * recertification.activities.integration.spec.ts).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { WorkflowNotFoundError } from '@temporalio/client';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
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
import { EntraService } from '../connectors/entra-connector/entra.service';
import { ReviewTargetAccessService } from './review-target-access.service';
import { AccessReviewCampaignService } from './access-review-campaign.service';
import { AccessReviewActivities } from '../../activities/access-review.activities';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

describe('Access review: cancelling a campaign (MongoDB)', () => {
  let moduleRef: TestingModule;
  let campaigns: AccessReviewCampaignService;
  let activities: AccessReviewActivities;
  let campaignModel: Model<ReviewCampaignDocument>;
  let itemModel: Model<ReviewItemDocument>;
  const events = { emit: jest.fn() };
  const cancel = jest.fn();
  const getHandle = jest.fn(() => ({ cancel }));
  let temporalDown = false;
  const temporal = {
    getClient: () => {
      if (temporalDown) throw new Error('Temporal client not connected');
      return { workflow: { getHandle } };
    },
  };

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
        AccessReviewActivities,
        { provide: IdentityService, useValue: { findByEmail: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementCatalogService, useValue: {} },
        { provide: EntraService, useValue: {} },
        { provide: ReviewTargetAccessService, useValue: {} },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: TemporalClientProvider, useValue: temporal },
        {
          provide: accessReviewConfig.KEY,
          useValue: { defaultReviewer: 'unassigned@review.pending' },
        },
        // Read only when a campaign is created
        { provide: PluginRegistryService, useValue: {} },
      ],
    }).compile();
    campaigns = moduleRef.get(AccessReviewCampaignService);
    activities = moduleRef.get(AccessReviewActivities);
    campaignModel = moduleRef.get(getModelToken(ReviewCampaign.name));
    itemModel = moduleRef.get(getModelToken(ReviewItem.name));
  });

  beforeEach(async () => {
    events.emit.mockReset();
    cancel.mockReset().mockResolvedValue(undefined);
    getHandle.mockClear();
    temporalDown = false;
    await campaignModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await itemModel.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  /** A campaign whose only item has waited ten days, with escalation to the admin after one. */
  async function seed(
    status: CampaignStatus,
    workflowId?: string,
    extra: Partial<ReviewCampaign> = {},
  ): Promise<void> {
    await inA(async () => {
      await campaignModel.create({
        tenantId: A,
        campaignId: 'camp-1',
        name: 'Q4 review',
        scope: { type: 'all' },
        status,
        createdBy: 'admin@a.example',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        escalation: { enabled: true, escalateAfterDays: 1, escalateTo: 'ADMIN' },
        ...(workflowId ? { workflowId } : {}),
        ...extra,
      });
      await itemModel.create({
        tenantId: A,
        itemId: 'item-1',
        campaignId: 'camp-1',
        identityId: 'id-1',
        identityEmail: 'person@a.example',
        identityName: 'Person',
        reviewerId: 'reviewer@a.example',
        entitlements: [{ system: 'entra-id', type: 'group', name: 'Finance' }],
      });
    });
    // createdAt is immutable through the model; the raw driver backdates it for escalation
    await itemModel.collection.updateOne(
      { itemId: 'item-1' },
      { $set: { createdAt: TEN_DAYS_AGO } },
    );
  }

  const campaign = () =>
    campaignModel.findOne({ campaignId: 'camp-1' }).setOptions({ skipTenantScope: true }).lean();
  const item = () =>
    itemModel.findOne({ itemId: 'item-1' }).setOptions({ skipTenantScope: true }).lean();

  it('cancelling an active campaign cancels its workflow', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1');

    const result = await inA(() => campaigns.cancel('camp-1'));

    expect(result.status).toBe(CampaignStatus.CANCELLED);
    expect(getHandle).toHaveBeenCalledWith('wf-camp-1');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await campaign())?.status).toBe(CampaignStatus.CANCELLED);
    // Not a recurring campaign: no recurrence is written
    expect((await campaign())?.recurrence).toBeUndefined();
  });

  it('a workflow that already ended, or Temporal down, still leaves the campaign cancelled', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1');
    cancel.mockRejectedValue(new WorkflowNotFoundError('not found', 'wf-camp-1', undefined));
    await expect(inA(() => campaigns.cancel('camp-1'))).resolves.toMatchObject({
      status: CampaignStatus.CANCELLED,
    });

    await campaignModel
      .updateOne({ campaignId: 'camp-1' }, { $set: { status: CampaignStatus.ACTIVE } })
      .setOptions({ skipTenantScope: true });
    temporalDown = true;
    await expect(inA(() => campaigns.cancel('camp-1'))).resolves.toMatchObject({
      status: CampaignStatus.CANCELLED,
    });
  });

  it('cancelling a recurring campaign ends its recurrence', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1', {
      recurrence: { enabled: true, frequency: 'QUARTERLY', previousCampaignId: 'camp-0' },
    });

    const result = await inA(() => campaigns.cancel('camp-1'));

    expect(result.recurrence?.enabled).toBe(false);
    expect((await campaign())?.recurrence).toMatchObject({
      enabled: false,
      frequency: 'QUARTERLY',
      previousCampaignId: 'camp-0',
    });
  });

  it('a draft campaign has no workflow to cancel', async () => {
    await seed(CampaignStatus.DRAFT);

    await inA(() => campaigns.cancel('camp-1'));

    expect(getHandle).not.toHaveBeenCalled();
    expect((await campaign())?.status).toBe(CampaignStatus.CANCELLED);
  });

  it('after the cancel nothing is escalated, expired or completed', async () => {
    await seed(CampaignStatus.CANCELLED, 'wf-camp-1');

    await expect(activities.checkAndEscalateOverdue('camp-1', A)).resolves.toBe(0);
    await expect(activities.expirePendingItems('camp-1', A)).resolves.toBe(0);
    await activities.completeCampaign('camp-1', A);

    expect(await item()).toMatchObject({ decision: 'pending', reviewerId: 'reviewer@a.example' });
    const after = await campaign();
    expect(after?.status).toBe(CampaignStatus.CANCELLED);
    expect(after?.completedAt).toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // HX-E2: reviewer ids are stored lower-cased; an escalation target that is the reviewer in
  // another case (an admin's createdBy as typed) is the same person, so nothing moves
  it('does not escalate an item to its own reviewer written in another case', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1', { createdBy: 'Reviewer@A.example' });

    await expect(activities.checkAndEscalateOverdue('camp-1', A)).resolves.toBe(0);

    expect(await item()).toMatchObject({ reviewerId: 'reviewer@a.example' });
    expect((await item())?.escalatedFrom).toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('an active campaign is still escalated, expired and completed (control)', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1');

    await expect(activities.checkAndEscalateOverdue('camp-1', A)).resolves.toBe(1);
    await expect(activities.expirePendingItems('camp-1', A)).resolves.toBe(1);
    await activities.completeCampaign('camp-1', A);

    expect(await item()).toMatchObject({ decision: 'expired', reviewerId: 'admin@a.example' });
    // No reviewer address in the event (audit log, websocket): the mail handler reads the item
    expect(events.emit).toHaveBeenCalledWith(DomainEventType.ACCESS_REVIEW_ESCALATED, 'item-1', {
      itemId: 'item-1',
      campaignId: 'camp-1',
      daysOverdue: 1,
    });
    expect((await campaign())?.status).toBe(CampaignStatus.COMPLETED);
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.ACCESS_REVIEW_CAMPAIGN_COMPLETED,
      'camp-1',
      expect.objectContaining({ campaignId: 'camp-1' }),
    );
  });

  /** The payload of the one access_review.campaign_cancelled emit, through its real schema. */
  function cancelledEvent(): unknown {
    const calls = events.emit.mock.calls.filter(
      ([type]) => type === DomainEventType.ACCESS_REVIEW_CAMPAIGN_CANCELLED,
    );
    expect(calls).toHaveLength(1);
    const [, aggregateId, payload] = calls[0];
    expect(aggregateId).toBe('camp-1');
    return getEventSchema(DomainEventType.ACCESS_REVIEW_CAMPAIGN_CANCELLED).parse(payload);
  }

  it('the cancel is audited: access_review.campaign_cancelled with the reason', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1');

    await inA(() => campaigns.cancel('camp-1', 'Wrong scope: Finance instead of Sales'));

    expect(cancelledEvent()).toEqual({
      campaignId: 'camp-1',
      name: 'Q4 review',
      previousStatus: 'ACTIVE',
      reason: 'Wrong scope: Finance instead of Sales',
    });
  });

  it('a draft cancelled without a reason is audited too', async () => {
    await seed(CampaignStatus.DRAFT);

    await inA(() => campaigns.cancel('camp-1'));

    expect(cancelledEvent()).toEqual({
      campaignId: 'camp-1',
      name: 'Q4 review',
      previousStatus: 'DRAFT',
    });
  });

  it.each([CampaignStatus.COMPLETED, CampaignStatus.CANCELLED])(
    'a %s campaign cannot be cancelled: 400, nothing changes, nothing audited',
    async (status) => {
      await seed(status, 'wf-camp-1');

      await expect(inA(() => campaigns.cancel('camp-1', 'Too late'))).rejects.toThrow(
        'Campaign camp-1 cannot be cancelled',
      );

      expect((await campaign())?.status).toBe(status);
      expect(getHandle).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    },
  );

  // What the cancel dialog tells the admin: the items keep their decisions (listRevocationTasks
  // then revokes nothing for the cancelled campaign: access-review-revocation.activities.spec).
  it('leaves the items as they are: open ones pending, decided ones decided', async () => {
    await seed(CampaignStatus.ACTIVE, 'wf-camp-1');
    await inA(() =>
      itemModel.create({
        tenantId: A,
        itemId: 'item-2',
        campaignId: 'camp-1',
        identityId: 'id-2',
        identityEmail: 'other@a.example',
        identityName: 'Other',
        reviewerId: 'reviewer@a.example',
        entitlements: [{ system: 'entra-id', type: 'group', name: 'Payroll' }],
        decision: 'revoked',
        justification: 'Left the payroll team',
      }),
    );

    await inA(() => campaigns.cancel('camp-1', 'Duplicate campaign'));

    expect(await item()).toMatchObject({ decision: 'pending' });
    const decided = await itemModel
      .findOne({ itemId: 'item-2' })
      .setOptions({ skipTenantScope: true })
      .lean();
    expect(decided?.decision).toBe('revoked');
  });
});
