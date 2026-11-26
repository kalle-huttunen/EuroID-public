/**
 * HR joiner detection on in-memory MongoDB with the tenant plugin: which identities an HR sync
 * onboards (minted by the sync, due, pipeline DEPLOYED), what waits (pipeline not deployed or
 * paused, start date ahead, partial sync, failed start), what never starts (left in HR in the same
 * export, an HR leaver, deleted, onboarded otherwise), the mass-joiner pause with approval and
 * rejection, idempotence of a re-ingest, and tenant isolation.
 * Starting onboarding is IDENTITY_PROVISION_REQUESTED, stubbed here (the Temporal e2e in
 * test/workflows/jml-end-to-end.workflow.e2e-spec.ts runs the real onboarding path).
 * An approved batch's onboardings start after the approval has answered (afterStarts waits for
 * them); a start that does not answer within HR_START_TIMEOUT_MS counts as failed.
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
import type {
  HrSyncCompletedPayload,
  IdentityProvisionRequestedPayload,
} from '@infrastructure/events/event-payloads';
import { Identity, IdentitySchema, IdentityDocument } from '../identity/schemas/identity.schema';
import {
  LeaverEvent,
  LeaverEventSchema,
  LeaverEventDocument,
} from '../leavers/schemas/leaver-event.schema';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { LeaverPolicyService } from '../leavers/leaver-policy.service';
import { PipelineService } from '../blueprints/pipeline.service';
import { JoinerPolicy, JoinerPolicySchema } from './schemas/joiner-policy.schema';
import { JoinerEvent, JoinerEventSchema, JoinerEventDocument } from './schemas/joiner-event.schema';
import { JoinerBatch, JoinerBatchSchema } from './schemas/joiner-batch.schema';
import { JoinerSource, JoinerSourceSchema } from './schemas/joiner-source.schema';
import { JoinerPolicyService } from './joiner-policy.service';
import { JoinerExecutionService } from './joiner-execution.service';
import { JoinerDetectionService } from './joiner-detection.service';
import { JoinerBatchService } from './joiner-batch.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const SOURCE = 'csv-hr';

interface Hire {
  name: string;
  hrStatus?: string;
  startDate?: string;
  /** A start date HR sent that is not a date: the connector keeps it as sent instead. */
  startDateUnreadable?: string;
  endDate?: string;
}

/** Today's calendar day in UTC (the default leaver policy zone), as an HR date-only value. */
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe('HR joiner detection (MongoDB)', () => {
  let moduleRef: TestingModule;
  let detection: JoinerDetectionService;
  let batches: JoinerBatchService;
  let policies: JoinerPolicyService;
  let identityModel: Model<IdentityDocument>;
  let leaverEventModel: Model<LeaverEventDocument>;
  let joinerEventModel: Model<JoinerEventDocument>;
  let pipelineStatus: string;
  const getPipelineStatus = jest.fn(async () => pipelineStatus);
  /** The onboarding handler: answers the workflow id OnboardingService would start. */
  const onboard = async (
    _payload: IdentityProvisionRequestedPayload,
    tenantId: string,
    identityId: string,
  ): Promise<unknown[]> => [`t-${tenantId}-onboard-${identityId}`];
  const provision = jest.fn(onboard);
  const events = {
    emit: jest.fn(),
    emitAndWait: jest.fn(
      async (
        type: DomainEventType,
        aggregateId: string,
        payload: unknown,
        options: { tenantId: string },
      ) =>
        type === DomainEventType.IDENTITY_PROVISION_REQUESTED
          ? provision(payload as IdentityProvisionRequestedPayload, options.tenantId, aggregateId)
          : [],
    ),
  };

  /** Onboarding requests: [identityId, payload, tenantId, actor]. */
  function requests(): Array<[string, unknown, string, string]> {
    return events.emitAndWait.mock.calls
      .filter(([type]) => type === DomainEventType.IDENTITY_PROVISION_REQUESTED)
      .map(([, id, payload, options]) => [
        id,
        payload,
        options.tenantId,
        (options as { actor?: string }).actor ?? '',
      ]);
  }

  function emitted(type: DomainEventType): unknown[][] {
    return events.emit.mock.calls.filter(([t]) => t === type);
  }

  /** An identity that is onboarded already (it has a SYNCED target): no joiner. */
  async function seedStaff(tenantId: string, count: number, prefix = 's'): Promise<string[]> {
    const ids: string[] = [];
    await withTenantContext(tenantId, async () => {
      for (let i = 0; i < count; i++) {
        const doc = await identityModel.create({
          tenantId,
          profile: {
            firstName: `${prefix}${i}`,
            lastName: 'Staff',
            email: `${prefix}${i}@corp.example`,
            status: 'ACTIVE',
          },
          sources: [{ sourceName: SOURCE, externalId: `${prefix}${i}`, lastSync: new Date() }],
          provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }],
        });
        ids.push(String(doc._id));
      }
    });
    // Staff existed before any sync of a test. Created in the same millisecond as the next sync's
    // startedAt, one would count as minted by that sync (createdAt >= startedAt).
    await identityModel.collection.updateMany(
      { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );
    return ids;
  }

  /** What identity correlation mints for a new HR row (its csv-hr record kept as rawData). */
  async function mint(tenantId: string, hire: Hire): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: {
          firstName: hire.name,
          lastName: 'New',
          email: `${hire.name}@corp.example`,
          status: 'ACTIVE',
          departmentName: 'Engineering',
          jobTitle: 'Engineer',
        },
        sources: [
          {
            sourceName: SOURCE,
            externalId: hire.name,
            lastSync: new Date(),
            rawData: {
              status: 'ACTIVE',
              customAttributes: {
                hrStatus: hire.hrStatus ?? 'Active',
                ...(hire.startDateUnreadable
                  ? { startDateUnreadable: hire.startDateUnreadable }
                  : {}),
              },
              ...(hire.startDate ? { startDate: new Date(hire.startDate) } : {}),
              ...(hire.endDate ? { endDate: new Date(hire.endDate) } : {}),
            },
          },
        ],
        provisioning: [],
      }),
    );
    return String(doc._id);
  }

  /**
   * One sync of SOURCE: it delivers the existing identities in `deliver` (lastSync after the run
   * start) and mints `hires`; then joiner detection runs for it.
   */
  async function sync(
    tenantId: string,
    hires: Hire[],
    deliver: string[] = [],
    run: Partial<HrSyncCompletedPayload> = {},
  ) {
    const startedAt = new Date();
    await withTenantContext(tenantId, () =>
      identityModel
        .updateMany(
          { tenantId, _id: { $in: deliver }, 'sources.sourceName': SOURCE },
          { $set: { 'sources.$.lastSync': new Date() } },
        )
        .exec(),
    );
    const ids: string[] = [];
    for (const hire of hires) ids.push(await mint(tenantId, hire));
    const payload: HrSyncCompletedPayload = {
      connectorName: 'csv-hr',
      sourceName: SOURCE,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      fetched: deliver.length + hires.length || 1,
      skipped: 0,
      ingested: deliver.length + hires.length,
      errorCount: 0,
      ...run,
    };
    const summary = await withTenantContext(tenantId, () =>
      detection.evaluateSync(tenantId, payload),
    );
    return { summary, ids };
  }

  const joiner = (tenantId: string, identityId: string) =>
    withTenantContext(tenantId, () =>
      joinerEventModel.findOne({ tenantId, identityId }).lean().exec(),
    );
  const asAdmin = <T>(tenantId: string, fn: () => Promise<T>) => withTenantContext(tenantId, fn);

  /** The approved batch once its starts, which run after the approval answered, are done. */
  async function afterStarts(tenantId: string, batchId: string) {
    for (let i = 0; i < 200; i++) {
      const listed = await asAdmin(tenantId, () => batches.list('approved'));
      const batch = listed.find((b) => b.id === batchId);
      if (batch?.startedCount !== undefined) return batch;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The onboarding starts of batch ${batchId} did not finish`);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
          { name: JoinerPolicy.name, schema: JoinerPolicySchema },
          { name: JoinerEvent.name, schema: JoinerEventSchema },
          { name: JoinerBatch.name, schema: JoinerBatchSchema },
          { name: JoinerSource.name, schema: JoinerSourceSchema },
        ]),
      ],
      providers: [
        LeaverPolicyService,
        JoinerPolicyService,
        JoinerExecutionService,
        JoinerDetectionService,
        JoinerBatchService,
        { provide: PipelineService, useValue: { getPipelineStatus } },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    detection = moduleRef.get(JoinerDetectionService);
    batches = moduleRef.get(JoinerBatchService);
    policies = moduleRef.get(JoinerPolicyService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    leaverEventModel = moduleRef.get(getModelToken(LeaverEvent.name));
    joinerEventModel = moduleRef.get(getModelToken(JoinerEvent.name));
    await joinerEventModel.syncIndexes();
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
    pipelineStatus = 'DEPLOYED';
    events.emit.mockReset();
    events.emitAndWait.mockClear();
    provision.mockReset().mockImplementation(onboard);
    getPipelineStatus.mockClear();
  });

  it('onboards the identities a full sync minted, as system:hr-sync, through the provision request', async () => {
    const staff = await seedStaff(A, 40);

    const { summary, ids } = await sync(A, [{ name: 'ada' }, { name: 'bob' }], staff);

    expect(summary).toEqual({
      kind: 'joiner-sync-summary',
      sourceName: SOURCE,
      fullSync: true,
      detected: 2,
      started: 2,
      pending: 0,
      waiting: 0,
      startFailed: 0,
      closed: 0,
      pipelineStatus: 'DEPLOYED',
    });
    expect(requests()).toEqual([
      // No email in the event: the onboarding handler reads it from the identity
      [ids[0], { reason: 'joiner:hr-sync:csv-hr' }, A, 'system:hr-sync'],
      [ids[1], { reason: 'joiner:hr-sync:csv-hr' }, A, 'system:hr-sync'],
    ]);
    const workflowId = `t-${A}-onboard-${ids[0]}`;
    expect(await joiner(A, ids[0])).toEqual(
      expect.objectContaining({
        sourceName: SOURCE,
        status: 'started',
        open: false,
        workflowId,
        startedAt: expect.any(Date),
      }),
    );
    const startedEvents = emitted(DomainEventType.JOINER_ONBOARDING_STARTED);
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]).toEqual([
      DomainEventType.JOINER_ONBOARDING_STARTED,
      ids[0],
      {
        identityId: ids[0],
        joinerEventId: expect.any(String),
        sourceName: SOURCE,
        workflowId,
      },
      { tenantId: A, actor: 'system:hr-sync' },
    ]);
  });

  it('starts nothing while the pipeline is not deployed or paused; the first full sync after Deploy does', async () => {
    pipelineStatus = 'DRAFT';
    const { summary, ids } = await sync(A, [{ name: 'ada' }, { name: 'bob' }]);
    expect(summary).toEqual(
      expect.objectContaining({ detected: 2, started: 0, waiting: 2, pipelineStatus: 'DRAFT' }),
    );
    expect(requests()).toEqual([]);
    expect((await joiner(A, ids[0]))?.status).toBe('waiting');

    pipelineStatus = 'PAUSED';
    const paused = await sync(A, [], ids);
    expect(paused.summary).toEqual(
      expect.objectContaining({ detected: 0, started: 0, waiting: 2, pipelineStatus: 'PAUSED' }),
    );
    expect(requests()).toEqual([]);

    pipelineStatus = 'DEPLOYED';
    const deployed = await sync(A, [], ids);
    expect(deployed.summary).toEqual(
      expect.objectContaining({ detected: 0, started: 2, waiting: 0, pipelineStatus: 'DEPLOYED' }),
    );
    expect(requests().map(([id]) => id)).toEqual(ids);
  });

  it('starts nothing new when the same export is ingested again', async () => {
    const { ids } = await sync(A, [{ name: 'ada' }]);
    expect(requests()).toHaveLength(1);

    const again = await sync(A, [], ids);
    const third = await sync(A, [], ids);

    for (const { summary } of [again, third]) {
      expect(summary).toEqual(
        expect.objectContaining({ detected: 0, started: 0, pending: 0, waiting: 0, closed: 0 }),
      );
    }
    expect(requests()).toHaveLength(1);
    expect(
      await withTenantContext(A, () => joinerEventModel.countDocuments({ tenantId: A }).exec()),
    ).toBe(1);
  });

  it('records at the next run what a run minted while its joiner detection did not run', async () => {
    const first = await sync(A, [{ name: 'ada' }]);
    // A run that minted bob and failed before joiner detection (its leaver detection failed)
    const bob = await mint(A, { name: 'bob' });
    // Created by hand and from another source: no joiners of this source
    await withTenantContext(A, () =>
      identityModel.create([
        {
          tenantId: A,
          profile: { firstName: 'Man', lastName: 'Ual', email: 'manual@corp.example' },
        },
        {
          tenantId: A,
          profile: { firstName: 'Sc', lastName: 'Im', email: 'scim@corp.example' },
          sources: [{ sourceName: 'scim', externalId: 'x', lastSync: new Date() }],
        },
      ]),
    );

    const next = await sync(A, [], [...first.ids, bob]);

    expect(next.summary).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(requests().map(([id]) => id)).toEqual([...first.ids, bob]);
    expect(
      await withTenantContext(A, () => joinerEventModel.countDocuments({ tenantId: A }).exec()),
    ).toBe(2);
  });

  it.each([
    ['a skipped row', { skipped: 1 }],
    ['a failed row', { errorCount: 1 }],
  ])(
    'a partial sync (%s) records its joiners and starts nobody; the next full sync does',
    async (_label, run) => {
      const partial = await sync(A, [{ name: 'ada' }], [], run);
      expect(partial.summary).toEqual(
        expect.objectContaining({ fullSync: false, detected: 1, started: 0, waiting: 1 }),
      );
      expect(partial.summary.pipelineStatus).toBeUndefined();
      expect(getPipelineStatus).not.toHaveBeenCalled();
      expect(requests()).toEqual([]);

      const full = await sync(A, [], partial.ids);
      expect(full.summary).toEqual(expect.objectContaining({ started: 1, waiting: 0 }));
    },
  );

  it('waits for a start date ahead, and for a full sync that delivers the person', async () => {
    const { summary, ids } = await sync(A, [{ name: 'ada', startDate: day(1) }]);
    expect(summary).toEqual(expect.objectContaining({ detected: 1, started: 0, waiting: 1 }));

    // The start date is reached (HR still has it; here the stored date moves to today)
    await withTenantContext(A, () =>
      identityModel
        .updateOne({ _id: ids[0] }, { $set: { 'sources.0.rawData.startDate': new Date(day(0)) } })
        .exec(),
    );
    const undelivered = await sync(A, [{ name: 'bob', startDate: day(0) }]);
    // ada was not in this run: she waits; bob starts on his start date
    expect(undelivered.summary).toEqual(
      expect.objectContaining({ detected: 1, started: 1, waiting: 1 }),
    );
    expect(requests().map(([id]) => id)).toEqual(undelivered.ids);

    const delivered = await sync(A, [], ids);
    expect(delivered.summary).toEqual(expect.objectContaining({ started: 1, waiting: 0 }));
  });

  it('holds a joiner whose start date is unreadable, says so on its timeline once, and starts it once a sync reads a date', async () => {
    const { summary, ids } = await sync(A, [{ name: 'ada', startDateUnreadable: '31.13.2026' }]);

    // A full sync (the row was ingested), yet nobody is onboarded before the real start
    expect(summary).toEqual(
      expect.objectContaining({ fullSync: true, detected: 1, started: 0, waiting: 1 }),
    );
    expect(requests()).toEqual([]);
    expect(await joiner(A, ids[0])).toEqual(
      expect.objectContaining({ status: 'waiting', waitReason: 'start-date-unreadable' }),
    );
    expect(emitted(DomainEventType.JOINER_ONBOARDING_WAITING)).toEqual([
      [
        DomainEventType.JOINER_ONBOARDING_WAITING,
        ids[0],
        {
          identityId: ids[0],
          joinerEventId: expect.any(String),
          sourceName: SOURCE,
          reason: 'start-date-unreadable',
        },
        { tenantId: A, actor: 'system:hr-sync' },
      ],
    ]);

    // The next sync still cannot read it: still waiting, no second timeline entry
    const again = await sync(A, [], ids);
    expect(again.summary).toEqual(expect.objectContaining({ started: 0, waiting: 1 }));
    expect(emitted(DomainEventType.JOINER_ONBOARDING_WAITING)).toHaveLength(1);

    // HR fixes the date: the sync reads it (the connector drops the unreadable value)
    await withTenantContext(A, () =>
      identityModel
        .updateOne(
          { _id: ids[0] },
          {
            $set: { 'sources.0.rawData.startDate': new Date(day(0)) },
            $unset: { 'sources.0.rawData.customAttributes.startDateUnreadable': 1 },
          },
        )
        .exec(),
    );
    const fixed = await sync(A, [], ids);
    expect(fixed.summary).toEqual(expect.objectContaining({ started: 1, waiting: 0 }));
    expect(requests().map(([id]) => id)).toEqual(ids);
  });

  it('records a rehire the sync revived as a joiner of its own, and onboards it although its earlier employment left targets', async () => {
    const before = new Date(Date.now() - 365 * 86_400_000);
    await sync(A, []); // an earlier sync of the source: its recording cursor
    // Grace joined long ago (her first joiner started then), left and was deleted; this sync
    // revived her (metadata.rehiredAt) and closed the targets of her earlier employment
    const id = await withTenantContext(A, async () => {
      const doc = await identityModel.create({
        tenantId: A,
        profile: {
          firstName: 'Grace',
          lastName: 'H',
          email: 'grace@corp.example',
          status: 'ACTIVE',
        },
        sources: [
          {
            sourceName: SOURCE,
            externalId: 'grace',
            lastSync: new Date(),
            rawData: { status: 'ACTIVE', startDate: new Date(day(0)) },
          },
        ],
        provisioning: [
          {
            targetSystem: 'file-outbound',
            status: 'DEPROVISIONED',
            writebackComplete: false,
            lastSync: before,
          },
        ],
        metadata: { rehiredAt: new Date(), rehiredFrom: SOURCE },
      });
      await joinerEventModel.create({
        tenantId: A,
        identityId: String(doc._id),
        sourceName: SOURCE,
        status: 'started',
        open: false,
        detectedAt: before,
        workflowId: 'first-hire',
      });
      // The leaver event that ended her earlier employment does not stop the new one
      await leaverEventModel.create({
        tenantId: A,
        identityId: String(doc._id),
        sourceName: SOURCE,
        reason: 'terminated',
        eventKey: `${SOURCE}:terminated:terminated|`,
        status: 'started',
        open: false,
        detectedAt: before,
        workflowId: 'offboard-1',
        offboardingFinishedAt: before,
      });
      return String(doc._id);
    });
    await identityModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { createdAt: before } },
    );

    const { summary } = await sync(A, [], [id]);

    expect(summary).toEqual(expect.objectContaining({ detected: 1, started: 1, closed: 0 }));
    expect(requests()).toEqual([[id, { reason: 'joiner:hr-sync:csv-hr' }, A, 'system:hr-sync']]);
    const events = await withTenantContext(A, () =>
      joinerEventModel.find({ tenantId: A, identityId: id }).sort({ detectedAt: 1 }).lean().exec(),
    );
    expect(events).toEqual([
      expect.objectContaining({ status: 'started', workflowId: 'first-hire' }),
      expect.objectContaining({ status: 'started', rehiredAt: expect.any(Date) }),
    ]);
    expect(emitted(DomainEventType.JOINER_ONBOARDING_STARTED)[0][2]).toEqual(
      expect.objectContaining({ identityId: id, rehire: true }),
    );

    // The same export again: the rehire is not raised a second time
    const again = await sync(A, [], [id]);
    expect(again.summary).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
  });

  it('never onboards a person HR marks as left in the same export', async () => {
    const { summary, ids } = await sync(A, [
      { name: 'tom', hrStatus: 'Terminated' },
      { name: 'eve', endDate: day(-1) },
    ]);

    expect(summary).toEqual(expect.objectContaining({ detected: 2, started: 0, closed: 2 }));
    expect(await joiner(A, ids[0])).toEqual(
      expect.objectContaining({
        status: 'superseded',
        open: false,
        closeReason: 'HR marks the person as left (status "terminated").',
      }),
    );
    expect((await joiner(A, ids[1]))?.closeReason).toMatch(/ended in HR/);
    expect(requests()).toEqual([]);
  });

  it('an open or started HR leaver event closes the joiner, a rejected one does not', async () => {
    pipelineStatus = 'DRAFT';
    const { ids } = await sync(A, [{ name: 'lea' }, { name: 'kim' }]);
    const leaverEvent = (identityId: string, status: string) => ({
      tenantId: A,
      identityId,
      sourceName: SOURCE,
      reason: 'terminated',
      eventKey: `${SOURCE}:terminated:${identityId}`,
      status,
      open: false,
      detectedAt: new Date(),
    });
    await withTenantContext(A, () =>
      leaverEventModel.create([
        { ...leaverEvent(ids[0], 'started'), workflowId: 'w-1' },
        // The admin rejected the leaver batch: the person did not leave
        leaverEvent(ids[1], 'rejected'),
      ]),
    );

    pipelineStatus = 'DEPLOYED';
    const { summary } = await sync(A, [], ids);

    expect(summary).toEqual(expect.objectContaining({ started: 1, closed: 1 }));
    expect((await joiner(A, ids[0]))?.closeReason).toMatch(/leaver event/);
    expect(requests().map(([id]) => id)).toEqual([ids[1]]);
  });

  it('closes a waiting joiner an operator onboarded meanwhile, or that was deleted or left', async () => {
    pipelineStatus = 'DRAFT';
    const { ids } = await sync(A, [{ name: 'ada' }, { name: 'bob' }, { name: 'cy' }]);
    await withTenantContext(A, async () => {
      await identityModel
        .updateOne(
          { _id: ids[0] },
          { $set: { provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }] } },
        )
        .exec();
      await identityModel.updateOne({ _id: ids[1] }, { $set: { deletedAt: new Date() } }).exec();
      await leaverEventModel.create({
        tenantId: A,
        identityId: ids[2],
        sourceName: SOURCE,
        reason: 'end-date',
        eventKey: 'k',
        status: 'pending-approval',
        open: true,
        detectedAt: new Date(),
      });
    });

    pipelineStatus = 'DEPLOYED';
    const { summary } = await sync(A, [], ids);

    expect(summary).toEqual(expect.objectContaining({ started: 0, waiting: 0, closed: 3 }));
    expect((await joiner(A, ids[0]))?.closeReason).toMatch(/already onboarded/);
    expect((await joiner(A, ids[1]))?.closeReason).toMatch(/deleted/);
    expect((await joiner(A, ids[2]))?.closeReason).toMatch(/leaver event/);
    expect(requests()).toEqual([]);
  });

  it('pauses above the limit: nothing starts, one batch shows who joins', async () => {
    const staff = await seedStaff(A, 40);
    const hires = ['ada', 'bob', 'cy', 'dan', 'eve'].map((name) => ({ name }));

    const { summary, ids } = await sync(A, hires, staff);

    // 45 active identities: 5 % is 2 (the floor is 2 as well), so 5 joiners need approval
    expect(summary).toEqual(
      expect.objectContaining({ detected: 5, started: 0, pending: 5, waiting: 0 }),
    );
    expect(summary.pausedBatchId).toBeDefined();
    expect(requests()).toEqual([]);
    const [pending] = await asAdmin(A, () => batches.list('pending'));
    expect(pending).toEqual(
      expect.objectContaining({
        id: summary.pausedBatchId,
        sourceName: SOURCE,
        status: 'pending',
        identityCount: 5,
        allowance: 2,
        activeIdentityCount: 45,
      }),
    );
    expect(pending.items).toHaveLength(5);
    expect(pending.items.find((i) => i.identityId === ids[0])).toEqual({
      joinerEventId: expect.any(String),
      identityId: ids[0],
      displayName: 'ada New',
      email: 'ada@corp.example',
      departmentName: 'Engineering',
      jobTitle: 'Engineer',
      status: 'pending-approval',
      workflowId: undefined,
      closeReason: undefined,
      startError: undefined,
    });
    expect(emitted(DomainEventType.JOINER_BATCH_PAUSED)[0][2]).toEqual({
      batchId: summary.pausedBatchId,
      sourceName: SOURCE,
      identityCount: 5,
      limit: 2,
      activeIdentityCount: 45,
    });

    // While the batch waits, the next sync raises its members nowhere.
    const again = await sync(A, [], [...staff, ...ids]);
    expect(again.summary).toEqual(
      expect.objectContaining({ detected: 0, started: 0, pending: 0, waiting: 0 }),
    );
    expect(again.summary.pausedBatchId).toBeUndefined();
  });

  it('approval starts each member read again, as the approver; refused while not deployed', async () => {
    const staff = await seedStaff(A, 40);
    const hires = ['ada', 'bob', 'cy', 'dan', 'eve'].map((name) => ({ name }));
    const { summary, ids } = await sync(A, hires, staff);
    const batchId = summary.pausedBatchId!;
    // Since the pause: HR terminated bob, an operator onboarded cy
    await withTenantContext(A, async () => {
      await identityModel
        .updateOne(
          { _id: ids[1] },
          { $set: { 'sources.0.rawData.customAttributes.hrStatus': 'Terminated' } },
        )
        .exec();
      await identityModel
        .updateOne(
          { _id: ids[2] },
          { $set: { provisioning: [{ targetSystem: 'entra-id', status: 'PENDING' }] } },
        )
        .exec();
    });

    pipelineStatus = 'PAUSED';
    await expect(asAdmin(A, () => batches.approve(batchId, 'admin@a.example'))).rejects.toThrow(
      /pipeline is PAUSED/,
    );
    const [stillPending] = await asAdmin(A, () => batches.list('pending'));
    expect(stillPending.id).toBe(batchId);
    expect(requests()).toEqual([]);

    pipelineStatus = 'DEPLOYED';
    const answer = await asAdmin(A, () => batches.approve(batchId, 'admin@a.example', 'New hires'));

    // The answer comes before the starts: every member a waiting joiner, nothing counted yet
    expect(answer).toEqual(
      expect.objectContaining({
        status: 'approved',
        decidedBy: 'admin@a.example',
        comment: 'New hires',
      }),
    );
    expect(answer.startedCount).toBeUndefined();
    expect(answer.items.map((i) => i.status)).toEqual(Array(5).fill('waiting'));
    expect(emitted(DomainEventType.JOINER_BATCH_APPROVED)[0][2]).toEqual({
      batchId,
      sourceName: SOURCE,
      identityCount: 5,
      comment: 'New hires',
    });

    const view = await afterStarts(A, batchId);
    expect(view.startedCount).toBe(3);
    expect(requests().map(([id, , , actor]) => [id, actor])).toEqual([
      [ids[0], 'admin@a.example'],
      [ids[3], 'admin@a.example'],
      [ids[4], 'admin@a.example'],
    ]);
    const item = (id: string) => view.items.find((i) => i.identityId === id)!;
    expect(item(ids[0])).toEqual(
      expect.objectContaining({
        status: 'started',
        workflowId: `t-${A}-onboard-${ids[0]}`,
      }),
    );
    expect(item(ids[1])).toEqual(
      expect.objectContaining({ status: 'superseded', closeReason: expect.stringMatching(/left/) }),
    );
    expect(item(ids[2])).toEqual(
      expect.objectContaining({
        status: 'superseded',
        closeReason: expect.stringMatching(/already onboarded/),
      }),
    );
    expect(emitted(DomainEventType.JOINER_ONBOARDING_STARTED)[0][2]).toEqual(
      expect.objectContaining({ identityId: ids[0], batchId }),
    );
    expect(emitted(DomainEventType.JOINER_ONBOARDING_STARTED)[0][3]).toEqual({
      tenantId: A,
      actor: 'admin@a.example',
    });

    await expect(asAdmin(A, () => batches.approve(batchId, 'other@a.example'))).rejects.toThrow(
      ConflictException,
    );
    await expect(asAdmin(A, () => batches.reject(batchId, 'other@a.example'))).rejects.toThrow(
      ConflictException,
    );
    expect(requests()).toHaveLength(3);
  });

  it('answers at once while the onboarding starts hang; each waits for the next full sync', async () => {
    const staff = await seedStaff(A, 40);
    const { summary, ids } = await sync(
      A,
      ['ada', 'bob', 'cy'].map((name) => ({ name })),
      staff,
    );
    // Temporal down: a start never answers (the client's gRPC retries took 30 to 45 s each)
    provision.mockImplementation(() => new Promise<unknown[]>(() => {}));
    process.env.HR_START_TIMEOUT_MS = '50';
    try {
      const answer = await asAdmin(A, () =>
        batches.approve(summary.pausedBatchId!, 'admin@a.example'),
      );
      expect(answer.status).toBe('approved');
      expect(answer.items.map((i) => [i.status, i.startError])).toEqual(
        Array(3).fill(['waiting', undefined]),
      );

      const view = await afterStarts(A, summary.pausedBatchId!);
      expect(view.startedCount).toBe(0);
      expect(view.items.map((i) => [i.status, i.startError])).toEqual(
        Array(3).fill(['waiting', 'The onboarding start did not answer within 50 ms']),
      );
    } finally {
      delete process.env.HR_START_TIMEOUT_MS;
    }

    // Temporal is back: the next full sync starts them (a limit that lets three through)
    provision.mockImplementation(onboard);
    await asAdmin(A, () =>
      policies.updatePolicy(
        { massJoinerMaxCount: 10, massJoinerMaxPercent: 50, massJoinerMinCount: 2 },
        'admin@a.example',
      ),
    );
    const retry = await sync(A, [], [...staff, ...ids]);
    expect(retry.summary).toEqual(expect.objectContaining({ started: 3, waiting: 0 }));
  });

  it('rejection starts nothing, and no later sync raises the members again', async () => {
    const staff = await seedStaff(A, 40);
    const hires = ['ada', 'bob', 'cy'].map((name) => ({ name }));
    const { summary, ids } = await sync(A, hires, staff);

    const view = await asAdmin(A, () =>
      batches.reject(summary.pausedBatchId!, 'admin@a.example', 'Test import'),
    );

    expect(view.status).toBe('rejected');
    expect(view.items.map((i) => [i.status, i.closeReason])).toEqual([
      ['rejected', 'Batch rejected'],
      ['rejected', 'Batch rejected'],
      ['rejected', 'Batch rejected'],
    ]);
    expect(emitted(DomainEventType.JOINER_BATCH_REJECTED)[0][2]).toEqual(
      expect.objectContaining({ identityCount: 3, comment: 'Test import' }),
    );
    const next = await sync(A, [], [...staff, ...ids]);
    expect(next.summary).toEqual(expect.objectContaining({ detected: 0, started: 0, pending: 0 }));
    expect(requests()).toEqual([]);
  });

  it('closes a joiner whose onboarding already runs; a failed start waits for the next full sync', async () => {
    provision.mockImplementation(async (_payload, tenantId, identityId) => {
      // As the onboarding handler, which reads the person by the event's identity id
      const identity = await withTenantContext(tenantId, () =>
        identityModel.findById(identityId).lean().exec(),
      );
      if (identity?.profile?.email?.startsWith('ada')) {
        throw new WorkflowExecutionAlreadyStartedError('running', 'w-ada', 'onboardingWorkflow');
      }
      throw new Error('Temporal unreachable');
    });
    const { summary, ids } = await sync(A, [{ name: 'ada' }, { name: 'bob' }]);

    expect(summary).toEqual(
      expect.objectContaining({ started: 0, closed: 1, startFailed: 1, waiting: 1 }),
    );
    expect((await joiner(A, ids[0]))?.closeReason).toMatch(/already in progress/);
    expect(await joiner(A, ids[1])).toEqual(
      expect.objectContaining({ status: 'waiting', startError: 'Temporal unreachable' }),
    );

    provision.mockImplementation(onboard);
    const retry = await sync(A, [], ids);
    expect(retry.summary).toEqual(expect.objectContaining({ started: 1, waiting: 0 }));
    const retried = await joiner(A, ids[1]);
    expect(retried?.status).toBe('started');
    expect(retried?.startError).toBeUndefined();
  });

  it('a stored policy with a floor of 0 pauses a single joiner in a small tenant', async () => {
    await seedStaff(A, 5);
    await asAdmin(A, () =>
      policies.updatePolicy(
        { massJoinerMaxCount: 10, massJoinerMaxPercent: 5, massJoinerMinCount: 0 },
        'admin@a.example',
      ),
    );

    const { summary } = await sync(A, [{ name: 'ada' }]);

    expect(summary).toEqual(expect.objectContaining({ pending: 1, started: 0 }));
    expect(requests()).toEqual([]);
    expect(emitted(DomainEventType.JOINER_POLICY_UPDATED)[0]).toEqual([
      DomainEventType.JOINER_POLICY_UPDATED,
      'joiner-policy',
      { changedFields: ['massJoinerMinCount'] },
      { actor: 'admin@a.example' },
    ]);
    expect(await asAdmin(A, () => policies.getPolicy())).toEqual(
      expect.objectContaining({ massJoinerMinCount: 0, configured: true }),
    );
    expect(await asAdmin(B, () => policies.getPolicy())).toEqual(
      expect.objectContaining({ massJoinerMinCount: 2, configured: false }),
    );
  });

  it('keeps tenants apart: syncs, batches and decisions', async () => {
    await seedStaff(A, 40, 'a');
    const inA = await sync(
      A,
      ['new1', 'new2', 'new3'].map((name) => ({ name })),
    );
    const inB = await sync(B, [{ name: 'new1' }]);

    expect(inA.summary.pausedBatchId).toBeDefined();
    expect(inB.summary).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(requests().map(([, , tenantId]) => tenantId)).toEqual([B]);
    expect(await asAdmin(B, () => batches.list())).toEqual([]);
    await expect(
      asAdmin(B, () => batches.approve(inA.summary.pausedBatchId!, 'admin@b.example')),
    ).rejects.toThrow(NotFoundException);
    const [batchA] = await asAdmin(A, () => batches.list());
    expect(batchA.status).toBe('pending');
  });
});
