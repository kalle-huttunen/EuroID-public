/**
 * Leaver detection on in-memory MongoDB with the tenant plugin: the three signals as a sync sees
 * them, the miss counter (partial and failed syncs never count, reappearing resets it), the
 * mass-leaver pause and its approval, idempotent starts, and tenant isolation.
 * Starting the offboarding is the IDENTITY_OFFBOARD_REQUESTED event; its handler is stubbed here
 * (the Temporal e2e in test/workflows/hr-leaver.workflow.e2e-spec.ts runs the real one).
 * An approved batch's offboardings start after the approval has answered (afterStarts waits
 * for them); a start that does not answer within HR_START_TIMEOUT_MS counts as failed.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Connection, Model } from 'mongoose';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { HrSyncCompletedPayload } from '@infrastructure/events/event-payloads';
import { Identity, IdentitySchema, IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverPolicy, LeaverPolicySchema } from './schemas/leaver-policy.schema';
import { LeaverEvent, LeaverEventSchema, LeaverEventDocument } from './schemas/leaver-event.schema';
import { LeaverBatch, LeaverBatchSchema } from './schemas/leaver-batch.schema';
import { HrSyncRun, HrSyncRunSchema } from './schemas/hr-sync-run.schema';
import { OffboardingRecord, OffboardingRecordSchema } from './schemas/offboarding-record.schema';
import { LeaverPolicyService } from './leaver-policy.service';
import { LeaverDetectionService } from './leaver-detection.service';
import { LeaverExecutionService } from './leaver-execution.service';
import { LeaverBatchService } from './leaver-batch.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const SOURCE = 'csv-hr';
const DAY = 24 * 60 * 60 * 1000;

/** A date-only HR value N days ago, as the CSV connector stores it. */
function daysAgo(n: number): Date {
  return new Date(new Date(Date.now() - n * DAY).toISOString().slice(0, 10));
}

describe('Leaver detection (MongoDB)', () => {
  let moduleRef: TestingModule;
  let detection: LeaverDetectionService;
  let batches: LeaverBatchService;
  let identityModel: Model<IdentityDocument>;
  let eventModel: Model<LeaverEventDocument>;
  let clock: number;
  const events = {
    emit: jest.fn(),
    emitAndWait: jest.fn(),
  };

  /** Offboarding requests the stubbed handler received: [identityId, reason]. */
  function offboardRequests(): Array<[string, string]> {
    return events.emitAndWait.mock.calls
      .filter(([type]) => type === DomainEventType.IDENTITY_OFFBOARD_REQUESTED)
      .map(([, id, payload]) => [id as string, (payload as { reason: string }).reason]);
  }

  function emitted(type: DomainEventType): unknown[][] {
    return events.emit.mock.calls.filter(([t]) => t === type);
  }

  /**
   * The approved batch once its offboarding starts, which run after the approval answered, are
   * done (they record startedCount last).
   */
  async function afterStarts(tenantId: string, batchId: string) {
    for (let i = 0; i < 200; i++) {
      const listed = await withTenantContext(tenantId, () => batches.list('approved'));
      const batch = listed.find((b) => b.id === batchId);
      if (batch?.startedCount !== undefined) return batch;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The offboarding starts of batch ${batchId} did not finish`);
  }

  async function seed(
    tenantId: string,
    name: string,
    raw: { hrStatus?: string; endDate?: Date } = {},
    options: { primaryHrSource?: string; lastSync?: Date } = {},
  ): Promise<string> {
    return withTenantContext(tenantId, async () => {
      const doc = await identityModel.create({
        tenantId,
        profile: {
          firstName: name,
          lastName: 'Test',
          email: `${name}@corp.example`,
          status: 'ACTIVE',
        },
        sources: [
          {
            sourceName: SOURCE,
            externalId: name,
            lastSync: options.lastSync ?? new Date(clock),
            rawData: {
              status: 'ACTIVE',
              ...(raw.hrStatus ? { customAttributes: { hrStatus: raw.hrStatus } } : {}),
              ...(raw.endDate ? { endDate: raw.endDate } : {}),
            },
          },
        ],
        metadata: { primaryHrSource: options.primaryHrSource ?? SOURCE },
      });
      return String(doc._id);
    });
  }

  async function seedActive(tenantId: string, count: number, prefix = 'p'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await seed(tenantId, `${prefix}${i}`));
    return ids;
  }

  /**
   * One sync of SOURCE: every identity in `present` is delivered (its lastSync moves past the
   * run start, as ingestion does), then the run is reported.
   */
  async function sync(
    tenantId: string,
    present: string[],
    run: Partial<HrSyncCompletedPayload> = {},
  ) {
    clock += 60 * 60 * 1000;
    const startedAt = new Date(clock);
    await withTenantContext(tenantId, () =>
      identityModel
        .updateMany(
          { tenantId, _id: { $in: present }, 'sources.sourceName': SOURCE },
          { $set: { 'sources.$.lastSync': new Date(clock + 1000) } },
        )
        .exec(),
    );
    const payload: HrSyncCompletedPayload = {
      connectorName: 'csv-hr',
      sourceName: SOURCE,
      startedAt: startedAt.toISOString(),
      completedAt: new Date(clock + 2000).toISOString(),
      fetched: present.length,
      skipped: 0,
      ingested: present.length,
      errorCount: 0,
      ...run,
    };
    return withTenantContext(tenantId, () => detection.evaluateSync(tenantId, payload));
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: LeaverBatch.name, schema: LeaverBatchSchema },
          { name: HrSyncRun.name, schema: HrSyncRunSchema },
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
        ]),
      ],
      providers: [
        LeaverPolicyService,
        LeaverDetectionService,
        LeaverExecutionService,
        LeaverBatchService,
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    detection = moduleRef.get(LeaverDetectionService);
    batches = moduleRef.get(LeaverBatchService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    eventModel = moduleRef.get(getModelToken(LeaverEvent.name));
    await eventModel.syncIndexes();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    const connection = moduleRef.get<Connection>(getConnectionToken());
    for (const collection of Object.values(connection.collections)) {
      await collection.deleteMany({});
    }
    clock = Date.now() - 30 * DAY;
    events.emit.mockReset();
    events.emitAndWait.mockReset();
    events.emitAndWait.mockImplementation(
      async (type: DomainEventType, id: string, _payload: unknown, opts: { tenantId: string }) =>
        type === DomainEventType.IDENTITY_OFFBOARD_REQUESTED
          ? [undefined, `t-${opts.tenantId}-offboard-${id}`]
          : [],
    );
  });

  it('starts offboarding for a terminated person and a passed end date, with the reason', async () => {
    const active = await seedActive(A, 40);
    const terminated = await seed(A, 'terry', { hrStatus: 'Terminated' });
    const ended = await seed(A, 'enid', { endDate: daysAgo(2) });
    const future = await seed(A, 'fred', { endDate: daysAgo(-10) });

    const summary = await sync(A, [...active, terminated, ended, future]);

    expect(summary).toEqual(expect.objectContaining({ fullSync: true, detected: 2, started: 2 }));
    expect(summary.pausedBatchId).toBeUndefined();
    expect(offboardRequests()).toEqual(
      expect.arrayContaining([
        [terminated, 'leaver:terminated'],
        [ended, 'leaver:end-date'],
      ]),
    );
    expect(offboardRequests()).toHaveLength(2);
    const stored = await withTenantContext(A, () => eventModel.find({}).lean().exec());
    expect(stored.map((e) => [e.identityId, e.status, e.workflowId])).toEqual(
      expect.arrayContaining([
        [terminated, 'started', `t-${A}-offboard-${terminated}`],
        [ended, 'started', `t-${A}-offboard-${ended}`],
      ]),
    );
    // Timeline and audit: detected and started, per identity, in the sync's tenant.
    expect(emitted(DomainEventType.LEAVER_DETECTED)).toHaveLength(2);
    expect(emitted(DomainEventType.LEAVER_OFFBOARDING_STARTED)).toHaveLength(2);
    for (const [, , , opts] of events.emit.mock.calls) {
      expect((opts as { tenantId: string }).tenantId).toBe(A);
    }
  });

  it('re-running the sync starts nothing twice', async () => {
    const active = await seedActive(A, 40);
    const terminated = await seed(A, 'terry', { hrStatus: 'terminated' });

    await sync(A, [...active, terminated]);
    const again = await sync(A, [...active, terminated]);
    // Even after the offboarding finished (identity soft-deleted) nothing new happens.
    await withTenantContext(A, () =>
      identityModel.updateOne({ _id: terminated }, { $set: { deletedAt: new Date() } }).exec(),
    );
    await sync(A, active);

    expect(again).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(offboardRequests()).toEqual([[terminated, 'leaver:terminated']]);
    expect(await withTenantContext(A, () => eventModel.countDocuments({}).exec())).toBe(1);
  });

  it('a rehire who leaves again with the same status word and no end date is a new leaver', async () => {
    const active = await seedActive(A, 40);
    const terry = await seed(A, 'terry', { hrStatus: 'terminated' });
    await sync(A, [...active, terry]);
    expect(offboardRequests()).toEqual([[terry, 'leaver:terminated']]);

    // Offboarded (soft-deleted), then rehired: HR delivers the person active again and the Hub
    // revives the identity, marked metadata.rehiredAt (IdentityDeletedMatchService.revive)
    const setRaw = (hrStatus: string, extra: Record<string, unknown> = {}) =>
      withTenantContext(A, () =>
        identityModel
          .updateOne(
            { _id: terry },
            { $set: { 'sources.0.rawData.customAttributes.hrStatus': hrStatus, ...extra } },
          )
          .exec(),
      );
    await withTenantContext(A, () =>
      identityModel.updateOne({ _id: terry }, { $set: { deletedAt: new Date() } }).exec(),
    );
    await setRaw('active', { deletedAt: null, 'metadata.rehiredAt': new Date(clock) });
    await sync(A, [...active, terry]);
    expect(offboardRequests()).toHaveLength(1);

    // Leaves again: same status word, still no end date
    await setRaw('terminated');
    const second = await sync(A, [...active, terry]);

    expect(second).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(offboardRequests()).toEqual([
      [terry, 'leaver:terminated'],
      [terry, 'leaver:terminated'],
    ]);
    const keys = await withTenantContext(A, () =>
      eventModel.find({ identityId: terry }).sort({ detectedAt: 1 }).lean().exec(),
    );
    expect(keys.map((e) => e.eventKey)).toEqual([
      // Never rehired at the first departure: the key as before the rehire marker existed
      `${SOURCE}:terminated:terminated|`,
      expect.stringMatching(new RegExp(`^${SOURCE}:terminated:terminated\\|:rehired:`)),
    ]);
  });

  describe('missing from the source', () => {
    it('needs 3 consecutive full syncs; partial and failed syncs never count', async () => {
      const active = await seedActive(A, 40);
      const gone = await seed(A, 'gina');

      await sync(A, active); // miss 1
      await sync(A, active, { skipped: 1 }); // partial: unmappable row
      await sync(A, active, { errorCount: 2 }); // partial: rows failed to save
      await sync(A, [], { fetched: 0 }); // empty feed: never full
      const second = await sync(A, active); // miss 2
      expect(second.detected).toBe(0);
      expect(offboardRequests()).toEqual([]);

      const third = await sync(A, active); // miss 3
      expect(third).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
      expect(offboardRequests()).toEqual([[gone, 'leaver:missing-from-source']]);
    });

    it('a person back in the feed starts counting from zero', async () => {
      const active = await seedActive(A, 40);
      const back = await seed(A, 'bob');

      await sync(A, active);
      await sync(A, active);
      await sync(A, [...active, back]); // reappears
      await sync(A, active);
      await sync(A, active);
      expect(offboardRequests()).toEqual([]);

      await sync(A, active);
      expect(offboardRequests()).toEqual([[back, 'leaver:missing-from-source']]);
    });

    it('a partial run detects terminated people but nobody missing', async () => {
      const active = await seedActive(A, 40);
      await seed(A, 'gina');
      await sync(A, active);
      await sync(A, active);
      // The next export marks someone as left, but one row cannot be mapped.
      const terminated = await seed(A, 'terry', { hrStatus: 'left' });

      const partial = await sync(A, [...active, terminated], { skipped: 3 });

      expect(partial).toEqual(expect.objectContaining({ fullSync: false, detected: 1 }));
      expect(offboardRequests()).toEqual([[terminated, 'leaver:terminated']]);
    });
  });

  it('only offboards identities whose authoritative HR source is this one', async () => {
    const active = await seedActive(A, 40);
    const otherPrimary = await seed(
      A,
      'wanda',
      { hrStatus: 'terminated' },
      { primaryHrSource: 'workday' },
    );

    const summary = await sync(A, [...active, otherPrimary]);

    expect(summary.detected).toBe(0);
    expect(offboardRequests()).toEqual([]);
  });

  describe('mass-leaver safety', () => {
    it('pauses a run above the limit, starts all on approval, never twice', async () => {
      const staying = await seedActive(A, 48, 's');
      const dropped = await seedActive(A, 12, 'd');
      await sync(A, [...staying, ...dropped]);

      await sync(A, staying);
      await sync(A, staying);
      const third = await sync(A, staying);

      // 12 > min(10, 5% of 60 = 3): nothing starts, one pending batch.
      expect(third).toEqual(expect.objectContaining({ detected: 12, started: 0 }));
      expect(third.pausedBatchId).toBeDefined();
      expect(offboardRequests()).toEqual([]);
      expect(emitted(DomainEventType.LEAVER_BATCH_PAUSED)).toHaveLength(1);
      const paused = emitted(DomainEventType.LEAVER_DETECTED).map(
        ([, , p]) => (p as { paused: boolean }).paused,
      );
      expect(paused).toEqual(Array(12).fill(true));

      // The feed is still missing them: no second batch while this one waits.
      const fourth = await sync(A, staying);
      expect(fourth.detected).toBe(0);
      expect(fourth.pausedBatchId).toBeUndefined();

      const [pending] = await withTenantContext(A, () => batches.list('pending'));
      expect(pending.items).toHaveLength(12);
      expect(pending.items.every((i) => i.reason === 'missing-from-source')).toBe(true);

      const approved = await withTenantContext(A, () =>
        batches.approve(third.pausedBatchId!, 'admin@corp.example', 'HR confirmed'),
      );
      // The answer comes before the starts: every member queued, nothing counted yet
      expect(approved).toEqual(
        expect.objectContaining({ status: 'approved', decidedBy: 'admin@corp.example' }),
      );
      expect(approved.startedCount).toBeUndefined();
      expect(approved.items.map((i) => i.status)).toEqual(Array(12).fill('queued'));
      const approval = emitted(DomainEventType.LEAVER_BATCH_APPROVED)[0];
      expect(approval[2]).toEqual({
        batchId: third.pausedBatchId,
        sourceName: SOURCE,
        identityCount: 12,
        comment: 'HR confirmed',
      });
      expect(approval[3]).toEqual({ tenantId: A, actor: 'admin@corp.example' });

      const started = await afterStarts(A, third.pausedBatchId!);
      expect(started.startedCount).toBe(12);
      expect(started.items.every((i) => i.status === 'started')).toBe(true);
      expect(
        offboardRequests()
          .map(([id]) => id)
          .sort(),
      ).toEqual([...dropped].sort());
      expect(emitted(DomainEventType.LEAVER_OFFBOARDING_STARTED)).toHaveLength(12);

      // A member's offboarding result is its workflow's offboarding record
      await withTenantContext(A, () =>
        moduleRef.get<Model<unknown>>(getModelToken(OffboardingRecord.name)).create({
          tenantId: A,
          workflowId: `t-${A}-offboard-${dropped[0]}`,
          identityId: dropped[0],
          status: 'partial-failure',
          hubStatus: 'suspended',
          systems: [{ system: 'github', outcome: 'failed', reason: 'accepted invitation' }],
          finishedAt: new Date(),
        }),
      );
      const [decided] = await withTenantContext(A, () => batches.list('approved'));
      expect(decided.items.find((i) => i.identityId === dropped[0])?.offboarding).toMatchObject({
        status: 'partial-failure',
        systems: [{ system: 'github', outcome: 'failed' }],
      });
      expect(decided.items.find((i) => i.identityId === dropped[1])?.offboarding).toBeUndefined();

      await expect(
        withTenantContext(A, () => batches.approve(third.pausedBatchId!, 'admin@corp.example')),
      ).rejects.toBeInstanceOf(ConflictException);
      await sync(A, staying);
      expect(offboardRequests()).toHaveLength(12);
    });

    it('a small tenant offboards up to 2 leavers per sync without approval (the floor)', async () => {
      // 12 active identities: 5% is 0.6, which alone would send every leaver to approval
      const activeA = await seedActive(A, 10, 's');
      const leaversA = [
        await seed(A, 'terry', { hrStatus: 'terminated' }),
        await seed(A, 'enid', { endDate: daysAgo(2) }),
      ];
      const activeB = await seedActive(B, 9, 'b');
      const leaversB = [
        await seed(B, 'tom', { hrStatus: 'terminated' }),
        await seed(B, 'tim', { hrStatus: 'terminated' }),
        await seed(B, 'tia', { hrStatus: 'terminated' }),
      ];

      const small = await sync(A, [...activeA, ...leaversA]);
      const overFloor = await sync(B, [...activeB, ...leaversB]);

      expect(small).toEqual(expect.objectContaining({ detected: 2, started: 2 }));
      expect(small.pausedBatchId).toBeUndefined();
      expect(overFloor).toEqual(expect.objectContaining({ detected: 3, started: 0 }));
      const [pending] = await withTenantContext(B, () => batches.list('pending'));
      expect(pending).toEqual(expect.objectContaining({ identityCount: 3, allowance: 2 }));
    });

    it('a rejected batch starts nothing and is not raised again on the same evidence', async () => {
      const staying = await seedActive(A, 48, 's');
      const dropped = await seedActive(A, 12, 'd');
      await sync(A, [...staying, ...dropped]);
      await sync(A, staying);
      await sync(A, staying);
      const { pausedBatchId } = await sync(A, staying);

      const rejected = await withTenantContext(A, () =>
        batches.reject(pausedBatchId!, 'admin@corp.example', 'Broken export'),
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.items.every((i) => i.status === 'rejected')).toBe(true);
      expect(emitted(DomainEventType.LEAVER_BATCH_REJECTED)[0][2]).toEqual(
        expect.objectContaining({ comment: 'Broken export', identityCount: 12 }),
      );
      const next = await sync(A, staying);
      expect(next.detected).toBe(0);
      expect(next.pausedBatchId).toBeUndefined();
      expect(offboardRequests()).toEqual([]);
    });

    it('does not start someone who came back before the approval', async () => {
      const staying = await seedActive(A, 48, 's');
      const dropped = await seedActive(A, 12, 'd');
      await sync(A, [...staying, ...dropped]);
      await sync(A, staying);
      await sync(A, staying);
      const { pausedBatchId } = await sync(A, staying);
      await sync(A, [...staying, dropped[0]]);

      const approved = await withTenantContext(A, () =>
        batches.approve(pausedBatchId!, 'admin@corp.example'),
      );

      expect(approved.items.find((i) => i.identityId === dropped[0])?.status).toBe('superseded');
      expect((await afterStarts(A, pausedBatchId!)).startedCount).toBe(11);
      expect(offboardRequests().map(([id]) => id)).not.toContain(dropped[0]);
    });

    it('records why a member did not start (the batch history shows it)', async () => {
      const staying = await seedActive(A, 48, 's');
      const dropped = await seedActive(A, 12, 'd');
      await sync(A, [...staying, ...dropped]);
      await sync(A, staying);
      await sync(A, staying);
      const { pausedBatchId } = await sync(A, staying);
      events.emitAndWait.mockRejectedValueOnce(new Error('Temporal unavailable'));

      await withTenantContext(A, () => batches.approve(pausedBatchId!, 'admin@corp.example'));

      const listed = await afterStarts(A, pausedBatchId!);
      expect(listed.startedCount).toBe(11);
      expect(listed.items.filter((i) => i.startError)).toEqual([
        expect.objectContaining({ status: 'queued', startError: 'Temporal unavailable' }),
      ]);
    });

    it('answers at once while the starts hang; each start fails after its timeout', async () => {
      const staying = await seedActive(A, 48, 's');
      const dropped = await seedActive(A, 12, 'd');
      await sync(A, [...staying, ...dropped]);
      await sync(A, staying);
      await sync(A, staying);
      const { pausedBatchId } = await sync(A, staying);
      // Temporal down: a start never answers (the client's gRPC retries took 30 to 45 s each)
      events.emitAndWait.mockImplementation(async (type: DomainEventType) =>
        type === DomainEventType.IDENTITY_OFFBOARD_REQUESTED ? new Promise(() => {}) : [],
      );
      process.env.HR_START_TIMEOUT_MS = '50';
      try {
        const approved = await withTenantContext(A, () =>
          batches.approve(pausedBatchId!, 'admin@corp.example'),
        );

        expect(approved.status).toBe('approved');
        expect(approved.items.map((i) => i.status)).toEqual(Array(12).fill('queued'));
        expect(approved.items.filter((i) => i.startError)).toEqual([]);

        const listed = await afterStarts(A, pausedBatchId!);
        expect(listed.startedCount).toBe(0);
        expect(listed.items.map((i) => [i.status, i.startError])).toEqual(
          Array(12).fill(['queued', 'The offboarding start did not answer within 50 ms']),
        );
        // No claim is left behind: the source's next sync tries every one again
        const claimed = await withTenantContext(A, () =>
          eventModel.countDocuments({ batchId: pausedBatchId, claimedAt: { $ne: null } }).exec(),
        );
        expect(claimed).toBe(0);
      } finally {
        delete process.env.HR_START_TIMEOUT_MS;
      }
    });
  });

  describe('starting offboarding', () => {
    const recordModel = () => moduleRef.get<Model<unknown>>(getModelToken(OffboardingRecord.name));
    const offboardingRecord = (identityId: string, finishedAt: Date) =>
      withTenantContext(A, () =>
        recordModel().create({
          tenantId: A,
          workflowId: `t-${A}-offboard-${identityId}`,
          identityId,
          status: 'partial-failure',
          hubStatus: 'suspended',
          systems: [{ system: 'github', outcome: 'failed', reason: 'accepted invitation' }],
          finishedAt,
        }),
      );

    it('never starts a second offboarding when a start that timed out did run', async () => {
      const active = await seedActive(A, 40);
      const terminated = await seed(A, 'terry', { hrStatus: 'terminated' });
      // The start does not answer in time, but Temporal starts the run anyway
      events.emitAndWait.mockImplementationOnce(() => new Promise(() => {}));
      process.env.HR_START_TIMEOUT_MS = '50';
      try {
        const first = await sync(A, [...active, terminated]);
        expect(first).toEqual(expect.objectContaining({ detected: 1, started: 0 }));
        // That run finishes (suspended: a target still has access) before the next sync
        await offboardingRecord(terminated, new Date());

        const second = await sync(A, [...active, terminated]);

        expect(second.started).toBe(1);
        expect(offboardRequests()).toHaveLength(1);
        const [event] = await withTenantContext(A, () => eventModel.find({}).lean().exec());
        expect(event).toEqual(
          expect.objectContaining({
            status: 'started',
            workflowId: `t-${A}-offboard-${terminated}`,
            offboardingFinishedAt: expect.any(Date),
          }),
        );
        expect(event.startError).toBeUndefined();
        expect(emitted(DomainEventType.LEAVER_OFFBOARDING_STARTED)[0][2]).toEqual(
          expect.objectContaining({ workflowId: `t-${A}-offboard-${terminated}` }),
        );
      } finally {
        delete process.env.HR_START_TIMEOUT_MS;
      }
    });

    it("an offboarding that finished before the first attempt is not this leaver's", async () => {
      const active = await seedActive(A, 40);
      const terminated = await seed(A, 'terry', { hrStatus: 'terminated' });
      // An earlier offboarding of the identity (before a rehire, or a manual delete)
      await offboardingRecord(terminated, new Date(Date.now() - DAY));

      const summary = await sync(A, [...active, terminated]);

      expect(summary.started).toBe(1);
      expect(offboardRequests()).toEqual([[terminated, 'leaver:terminated']]);
    });

    it('keeps a failed start queued and retries it on the next sync', async () => {
      const active = await seedActive(A, 40);
      const terminated = await seed(A, 'terry', { hrStatus: 'terminated' });
      events.emitAndWait.mockRejectedValueOnce(new Error('Temporal unavailable'));

      const first = await sync(A, [...active, terminated]);
      const [queued] = await withTenantContext(A, () => eventModel.find({}).lean().exec());
      const second = await sync(A, [...active, terminated]);

      expect(first).toEqual(expect.objectContaining({ detected: 1, started: 0 }));
      expect(queued).toEqual(
        expect.objectContaining({ status: 'queued', startError: 'Temporal unavailable' }),
      );
      expect(second).toEqual(expect.objectContaining({ detected: 0, started: 1 }));
    });

    it('counts an offboarding that is already running as started', async () => {
      const active = await seedActive(A, 40);
      const terminated = await seed(A, 'terry', { hrStatus: 'terminated' });
      events.emitAndWait.mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError(
          'running',
          `t-${A}-offboard-${terminated}`,
          'offboardingWorkflow',
        ),
      );

      const summary = await sync(A, [...active, terminated]);

      expect(summary.started).toBe(1);
      const [event] = await withTenantContext(A, () => eventModel.find({}).lean().exec());
      expect(event).toEqual(
        expect.objectContaining({ status: 'started', workflowId: `t-${A}-offboard-${terminated}` }),
      );
    });
  });

  describe('tenant leaver policy', () => {
    it("a tenant's stored limits apply to that tenant only, and the change is audited", async () => {
      const policies = moduleRef.get(LeaverPolicyService);
      expect(await withTenantContext(A, () => policies.getPolicy())).toEqual(
        expect.objectContaining({ configured: false, massLeaverMaxCount: 10 }),
      );
      const stored = await withTenantContext(A, () =>
        policies.updatePolicy(
          {
            signals: { terminated: true, endDate: true, missingFromSource: true },
            terminatedStatuses: ['terminated'],
            missingSyncThreshold: 2,
            massLeaverMaxCount: 100,
            massLeaverMaxPercent: 50,
            massLeaverMinCount: 2,
            timezone: 'Europe/Helsinki',
          },
          'admin@corp.example',
        ),
      );
      expect(stored).toEqual(
        expect.objectContaining({
          configured: true,
          missingSyncThreshold: 2,
          updatedBy: 'admin@corp.example',
        }),
      );
      const [, , payload, opts] = emitted(DomainEventType.LEAVER_POLICY_UPDATED)[0];
      expect((payload as { changedFields: string[] }).changedFields).toEqual(
        expect.arrayContaining([
          'terminatedStatuses',
          'missingSyncThreshold',
          'massLeaverMaxCount',
          'timezone',
        ]),
      );
      expect(opts).toEqual({ actor: 'admin@corp.example' });

      for (const tenant of [A, B]) {
        const staying = await seedActive(tenant, 48, `${tenant}s`);
        const dropped = await seedActive(tenant, 12, `${tenant}d`);
        await sync(tenant, [...staying, ...dropped]);
        await sync(tenant, staying);
        const second = await sync(tenant, staying);
        if (tenant === A) {
          // A: two misses are enough and 12 <= min(100, 50% of 60): all start.
          expect(second).toEqual(expect.objectContaining({ detected: 12, started: 12 }));
        } else {
          // B keeps the defaults: no leaver after two misses.
          expect(second.detected).toBe(0);
        }
      }
      expect(await withTenantContext(B, () => policies.getPolicy())).toEqual(
        expect.objectContaining({ configured: false, missingSyncThreshold: 3 }),
      );
    });

    it('a policy stored before the floor existed gets the default floor, never above its count', async () => {
      const policies = moduleRef.get(LeaverPolicyService);
      const policyModel = moduleRef.get<Model<unknown>>(getModelToken(LeaverPolicy.name));
      const stored = (tenantId: string, massLeaverMaxCount: number) =>
        withTenantContext(tenantId, () =>
          policyModel.create({
            tenantId,
            signals: { terminated: true, endDate: true, missingFromSource: true },
            terminatedStatuses: ['terminated'],
            missingSyncThreshold: 3,
            massLeaverMaxCount,
            massLeaverMaxPercent: 5,
            timezone: 'UTC',
          }),
        );
      await stored(A, 10);
      await stored(B, 1);

      expect(await withTenantContext(A, () => policies.getPolicy())).toEqual(
        expect.objectContaining({ configured: true, massLeaverMinCount: 2 }),
      );
      expect(await withTenantContext(B, () => policies.getPolicy())).toEqual(
        expect.objectContaining({ configured: true, massLeaverMaxCount: 1, massLeaverMinCount: 1 }),
      );
    });
  });

  describe('tenant isolation', () => {
    it("a tenant's sync never touches another tenant's identities or batches", async () => {
      const activeA = await seedActive(A, 48, 'a');
      const droppedA = await seedActive(A, 12, 'x');
      await seedActive(B, 40, 'b');
      const terminatedB = await seed(B, 'bterry', { hrStatus: 'terminated' });

      await sync(A, [...activeA, ...droppedA]);
      await sync(A, activeA);
      await sync(A, activeA);
      const { pausedBatchId } = await sync(A, activeA);

      expect(offboardRequests().map(([id]) => id)).not.toContain(terminatedB);
      expect(await withTenantContext(B, () => eventModel.countDocuments({}).exec())).toBe(0);
      expect(await withTenantContext(B, () => batches.list())).toEqual([]);
      await expect(
        withTenantContext(B, () => batches.approve(pausedBatchId!, 'admin@b.example')),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTenantContext(B, () => batches.reject(pausedBatchId!, 'admin@b.example')),
      ).rejects.toBeInstanceOf(NotFoundException);
      const [stillPending] = await withTenantContext(A, () => batches.list('pending'));
      expect(stillPending.id).toBe(pausedBatchId);
    });
  });
});
