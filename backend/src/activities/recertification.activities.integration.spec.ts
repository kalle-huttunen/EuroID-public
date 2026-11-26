/**
 * Recurring access review campaigns on in-memory MongoDB (tenant plugin): the recertification
 * scheduler clones a completed recurring campaign whose next run is due and activates the clone.
 *
 * Proves: one campaign of a series clones the next one. The source stops recurring once its
 * clone exists and the clone carries the recurrence forward, so a series has one campaign per
 * period. Before, the source kept recurring next to its clone and every series doubled each
 * period. A source cloned before that rule stops at its next run without cloning again, and a
 * cancelled clone ends the series.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import {
  CampaignStatus,
  ReviewCampaign,
  ReviewCampaignDocument,
  ReviewCampaignSchema,
} from '../modules/access-review/schemas/review-campaign.schema';
import { AccessReviewService } from '../modules/access-review/access-review.service';
import { RecertificationActivities } from './recertification.activities';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const DAY = 24 * 60 * 60 * 1000;
/**
 * Three scheduler days. A clone completes 30 days after it was created and is due a quarter after
 * that: T2 and T3 come after that point of the clone made on the day before them.
 */
const T1 = new Date('2026-01-10T03:00:00Z');
const T2 = new Date('2026-05-20T03:00:00Z');
const T3 = new Date('2026-09-30T03:00:00Z');

describe('Recertification scheduler: recurring campaigns (MongoDB)', () => {
  let moduleRef: TestingModule;
  let scheduler: RecertificationActivities;
  let campaignModel: Model<ReviewCampaignDocument>;
  const events = { emit: jest.fn() };
  // AccessReviewService.activate builds the items and starts the workflow; here it only activates
  const activate = jest.fn((campaignId: string) =>
    campaignModel
      .updateOne({ campaignId }, { $set: { status: CampaignStatus.ACTIVE } })
      .setOptions({ skipTenantScope: true }),
  );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: ReviewCampaign.name, schema: ReviewCampaignSchema }]),
      ],
      providers: [
        RecertificationActivities,
        { provide: AccessReviewService, useValue: { activate } },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: TenantService, useValue: { findAll: jest.fn() } },
      ],
    }).compile();
    scheduler = moduleRef.get(RecertificationActivities);
    campaignModel = moduleRef.get(getModelToken(ReviewCampaign.name));
  });

  beforeEach(async () => {
    events.emit.mockClear();
    activate.mockClear();
    await campaignModel.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const run = (at: Date) => scheduler.runRecertificationScheduler(A, at.toISOString());
  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const all = () =>
    campaignModel.find({}).sort({ createdAt: 1 }).setOptions({ skipTenantScope: true }).lean();
  const one = (campaignId: string) =>
    campaignModel.findOne({ campaignId }).setOptions({ skipTenantScope: true }).lean();
  const clonesOf = async (campaignId: string) =>
    (await all()).filter((c) => c.recurrence?.previousCampaignId === campaignId);

  /** A completed quarterly campaign due at `due`, optionally the clone of `previousCampaignId`. */
  async function completedRecurring(
    campaignId: string,
    due: Date,
    previousCampaignId?: string,
  ): Promise<void> {
    await inA(() =>
      campaignModel.create({
        tenantId: A,
        campaignId,
        name: 'Quarterly review',
        scope: { type: 'all' },
        status: CampaignStatus.COMPLETED,
        createdBy: 'admin@a.example',
        deadline: new Date(due.getTime() - 30 * DAY),
        completedAt: new Date(due.getTime() - 90 * DAY),
        recurrence: { enabled: true, frequency: 'QUARTERLY', nextRunAt: due, previousCampaignId },
      }),
    );
  }

  /** What AccessReviewActivities.completeCampaign writes: COMPLETED, next run a quarter later. */
  async function complete(campaignId: string, at: Date): Promise<void> {
    const nextRunAt = new Date(at);
    nextRunAt.setMonth(nextRunAt.getMonth() + 3);
    await campaignModel
      .updateOne(
        { campaignId },
        {
          $set: {
            status: CampaignStatus.COMPLETED,
            completedAt: at,
            'recurrence.nextRunAt': nextRunAt,
          },
        },
      )
      .setOptions({ skipTenantScope: true });
  }

  it('clones a due campaign once and hands the recurrence to the clone', async () => {
    await completedRecurring('src', new Date(T1.getTime() - DAY));

    await expect(run(T1)).resolves.toEqual({ campaignsCreated: 1, errors: 0 });

    const [clone] = await clonesOf('src');
    expect(clone).toMatchObject({
      status: CampaignStatus.ACTIVE,
      templateCampaignId: 'src',
      recurrence: { enabled: true, frequency: 'QUARTERLY', previousCampaignId: 'src' },
    });
    expect(activate).toHaveBeenCalledWith(clone.campaignId);
    const source = await one('src');
    expect(source?.recurrence?.enabled).toBe(false);
    expect(source?.recurrence?.nextRunAt).toBeUndefined();
    // The next day nothing is due
    await expect(run(new Date(T1.getTime() + DAY))).resolves.toEqual({
      campaignsCreated: 0,
      errors: 0,
    });
    expect(await all()).toHaveLength(2);
  });

  it('keeps one campaign per period: each period only the latest campaign clones', async () => {
    await completedRecurring('src', new Date(T1.getTime() - DAY));

    await run(T1);
    const [first] = await clonesOf('src');
    await complete(first.campaignId, new Date(T1.getTime() + 30 * DAY));
    await expect(run(T2)).resolves.toEqual({ campaignsCreated: 1, errors: 0 });
    const [second] = await clonesOf(first.campaignId);
    await complete(second.campaignId, new Date(T2.getTime() + 30 * DAY));
    await expect(run(T3)).resolves.toEqual({ campaignsCreated: 1, errors: 0 });

    const campaigns = await all();
    expect(campaigns).toHaveLength(4);
    expect(campaigns.filter((c) => c.recurrence?.enabled).map((c) => c.status)).toEqual([
      CampaignStatus.ACTIVE,
    ]);
    expect(await clonesOf('src')).toHaveLength(1);
  });

  it('stops a source whose clone exists already, without cloning it again', async () => {
    const due = new Date(T2.getTime() - DAY);
    await completedRecurring('src', due);
    // Cloned before the source stopped recurring: the clone is under review
    await inA(() =>
      campaignModel.create({
        tenantId: A,
        campaignId: 'clone-1',
        name: 'Quarterly review - 2026-01',
        scope: { type: 'all' },
        status: CampaignStatus.ACTIVE,
        createdBy: 'admin@a.example',
        deadline: T2,
        recurrence: { enabled: true, frequency: 'QUARTERLY', previousCampaignId: 'src' },
        templateCampaignId: 'src',
      }),
    );

    await expect(run(T2)).resolves.toEqual({ campaignsCreated: 0, errors: 0 });

    expect(await all()).toHaveLength(2);
    expect(activate).not.toHaveBeenCalled();
    expect((await one('src'))?.recurrence).toMatchObject({ enabled: false });
    expect((await one('clone-1'))?.recurrence).toMatchObject({ enabled: true });
  });

  it('ends the series when the clone is cancelled', async () => {
    await completedRecurring('src', new Date(T1.getTime() - DAY));
    await run(T1);
    const [clone] = await clonesOf('src');
    await campaignModel
      .updateOne({ campaignId: clone.campaignId }, { $set: { status: CampaignStatus.CANCELLED } })
      .setOptions({ skipTenantScope: true });

    await expect(run(T2)).resolves.toEqual({ campaignsCreated: 0, errors: 0 });
    await expect(run(T3)).resolves.toEqual({ campaignsCreated: 0, errors: 0 });

    expect(await all()).toHaveLength(2);
  });

  // Hunt 04 F7 / r2-03 N2: the source stopped recurring before the clone was activated, so one
  // failed activation (Temporal down, an Entra error) left a DRAFT clone that never completes and
  // a source that no longer recurs; the next day hasClone held, and the series ended unnoticed
  describe('when the clone’s activation fails', () => {
    beforeEach(async () => {
      await completedRecurring('src', new Date(T1.getTime() - DAY));
      activate.mockImplementationOnce((() =>
        Promise.reject(new Error('Temporal is not connected'))) as never);
    });

    it('counts the failure and keeps the source recurring', async () => {
      await expect(run(T1)).resolves.toEqual({ campaignsCreated: 0, errors: 1 });

      const [clone] = await clonesOf('src');
      expect(clone.status).toBe(CampaignStatus.DRAFT);
      expect((await one('src'))?.recurrence).toMatchObject({ enabled: true });
    });

    it('activates the draft clone on the next run, without a second clone', async () => {
      await run(T1);

      await expect(run(new Date(T1.getTime() + DAY))).resolves.toEqual({
        campaignsCreated: 1,
        errors: 0,
      });

      const clones = await clonesOf('src');
      expect(clones).toHaveLength(1);
      expect(clones[0].status).toBe(CampaignStatus.ACTIVE);
      expect(activate).toHaveBeenLastCalledWith(clones[0].campaignId);
      expect((await one('src'))?.recurrence).toMatchObject({ enabled: false });
    });
  });
});
