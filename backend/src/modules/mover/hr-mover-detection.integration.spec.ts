/**
 * HR mover detection on in-memory MongoDB with the tenant plugin: which identities an HR sync
 * moves (delivered, provisioned, trigger attributes differ from the access baseline), what it
 * leaves alone (partial syncs, no baseline, HR leavers being offboarded), the mass-mover pause
 * with approval and rejection, start failures, and tenant isolation.
 * Starting the run is MoverService.triggerMover, stubbed here (the Temporal e2e in
 * test/workflows/hr-mover.workflow.e2e-spec.ts runs the real mover path).
 * An approved batch's runs start after the approval has answered (afterStarts waits for them);
 * a start that does not answer within HR_START_TIMEOUT_MS fails; a full sync starts what an
 * approval run left pending.
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
import {
  LeaverEvent,
  LeaverEventSchema,
  LeaverEventDocument,
} from '../leavers/schemas/leaver-event.schema';
import type { MoverWorkflowInput } from '../../workflows/mover.workflow';
import { MoverService } from './mover.service';
import { MoverPolicy, MoverPolicySchema } from './schemas/mover-policy.schema';
import { MoverBatch, MoverBatchSchema } from './schemas/mover-batch.schema';
import {
  MoverBatchItem,
  MoverBatchItemSchema,
  MoverBatchItemDocument,
} from './schemas/mover-batch-item.schema';
import { HrMoverPolicyService } from './hr-mover-policy.service';
import { HrMoverExecutionService } from './hr-mover-execution.service';
import { HrMoverDetectionService } from './hr-mover-detection.service';
import { HrMoverBatchService } from './hr-mover-batch.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const SOURCE = 'csv-hr';
const HOUR = 60 * 60 * 1000;

const BASE = {
  departmentName: 'Sales',
  jobTitle: 'Rep',
  location: 'Helsinki',
  managerEmail: 'boss@corp.example',
};

describe('HR mover detection (MongoDB)', () => {
  let moduleRef: TestingModule;
  let detection: HrMoverDetectionService;
  let batches: HrMoverBatchService;
  let policies: HrMoverPolicyService;
  let identityModel: Model<IdentityDocument>;
  let leaverEventModel: Model<LeaverEventDocument>;
  let itemModel: Model<MoverBatchItemDocument>;
  let clock: number;
  const events = { emit: jest.fn(), emitAndWait: jest.fn() };
  const triggerMover = jest.fn(
    async (input: MoverWorkflowInput, _options?: { requestedBy?: string }) =>
      `t-${input.tenantId}-mover-${input.identityId}`,
  );

  /** Mover starts: [identityId, workflow input, requestedBy]. */
  function starts(): Array<[string, MoverWorkflowInput, string | undefined]> {
    return triggerMover.mock.calls.map(([input, options]) => [
      input.identityId,
      input,
      options?.requestedBy,
    ]);
  }

  function emitted(type: DomainEventType): unknown[][] {
    return events.emit.mock.calls.filter(([t]) => t === type);
  }

  /** A provisioned identity of SOURCE whose access was applied with BASE (its baseline). */
  async function seed(
    tenantId: string,
    name: string,
    options: {
      baseline?: boolean;
      synced?: boolean;
      status?: string;
      provisioning?: Array<Record<string, unknown>>;
    } = {},
  ): Promise<string> {
    return withTenantContext(tenantId, async () => {
      const doc = await identityModel.create({
        tenantId,
        profile: {
          firstName: name,
          lastName: 'Test',
          email: `${name}@corp.example`,
          status: options.status ?? 'ACTIVE',
          ...BASE,
        },
        sources: [{ sourceName: SOURCE, externalId: name, lastSync: new Date(clock) }],
        provisioning: options.provisioning ?? [
          { targetSystem: 'entra-id', status: options.synced === false ? 'PENDING' : 'SYNCED' },
        ],
        ...(options.baseline === false
          ? {}
          : {
              accessBaseline: {
                attributes: { ...BASE, employmentType: 'FULL_TIME' },
                recordedAt: new Date(clock),
                recordedBy: 'provisioning',
              },
            }),
      });
      return String(doc._id);
    });
  }

  async function seedMany(tenantId: string, count: number, prefix = 'p'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await seed(tenantId, `${prefix}${i}`));
    return ids;
  }

  /** What the HR feed now says about these identities (as identity correlation writes it). */
  async function hrSays(tenantId: string, ids: string[], profile: Record<string, unknown>) {
    const set = Object.fromEntries(Object.entries(profile).map(([k, v]) => [`profile.${k}`, v]));
    await withTenantContext(tenantId, () =>
      identityModel.updateMany({ tenantId, _id: { $in: ids } }, { $set: set }).exec(),
    );
  }

  /** One sync of SOURCE: the identities in `delivered` get lastSync after the run start. */
  async function sync(
    tenantId: string,
    delivered: string[],
    run: Partial<HrSyncCompletedPayload> = {},
  ) {
    clock += HOUR;
    await withTenantContext(tenantId, () =>
      identityModel
        .updateMany(
          { tenantId, _id: { $in: delivered }, 'sources.sourceName': SOURCE },
          { $set: { 'sources.$.lastSync': new Date(clock + 1000) } },
        )
        .exec(),
    );
    const payload: HrSyncCompletedPayload = {
      connectorName: 'csv-hr',
      sourceName: SOURCE,
      startedAt: new Date(clock).toISOString(),
      completedAt: new Date(clock + 2000).toISOString(),
      fetched: delivered.length,
      skipped: 0,
      ingested: delivered.length,
      errorCount: 0,
      ...run,
    };
    return withTenantContext(tenantId, () => detection.evaluateSync(tenantId, payload));
  }

  const asAdmin = <T>(tenantId: string, fn: () => Promise<T>) => withTenantContext(tenantId, fn);

  /** The approved batch once its runs, which start after the approval answered, are started. */
  async function afterStarts(tenantId: string, batchId: string) {
    for (let i = 0; i < 200; i++) {
      const listed = await asAdmin(tenantId, () => batches.list('approved'));
      const batch = listed.find((b) => b.id === batchId);
      if (batch?.startedCount !== undefined) return batch;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The mover run starts of batch ${batchId} did not finish`);
  }

  const startMoverRun = async (input: MoverWorkflowInput) =>
    `t-${input.tenantId}-mover-${input.identityId}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: MoverPolicy.name, schema: MoverPolicySchema },
          { name: MoverBatch.name, schema: MoverBatchSchema },
          { name: MoverBatchItem.name, schema: MoverBatchItemSchema },
        ]),
      ],
      providers: [
        HrMoverPolicyService,
        HrMoverExecutionService,
        HrMoverDetectionService,
        HrMoverBatchService,
        { provide: MoverService, useValue: { triggerMover } },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    detection = moduleRef.get(HrMoverDetectionService);
    batches = moduleRef.get(HrMoverBatchService);
    policies = moduleRef.get(HrMoverPolicyService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    leaverEventModel = moduleRef.get(getModelToken(LeaverEvent.name));
    itemModel = moduleRef.get(getModelToken(MoverBatchItem.name));
    await itemModel.syncIndexes();
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
    clock = Date.now() - 30 * 24 * HOUR;
    events.emit.mockReset();
    triggerMover.mockClear();
  });

  it('starts the mover for a moved identity with the baseline values as before', async () => {
    const staff = await seedMany(A, 40);
    const [ada, bob] = staff;
    await hrSays(A, [ada], { departmentName: 'Engineering' });
    await hrSays(A, [bob], { jobTitle: 'Lead', location: 'Tampere' });

    const summary = await sync(A, staff);

    expect(summary).toEqual({
      kind: 'mover-sync-summary',
      sourceName: SOURCE,
      fullSync: true,
      detected: 2,
      started: 2,
      alreadyRunning: 0,
      startFailed: 0,
      withoutBaseline: 0,
    });
    const byId = new Map(starts().map(([id, input, actor]) => [id, { input, actor }]));
    expect(byId.get(ada)).toEqual({
      input: {
        // No email: the mover reads the identity by id (patch mover:identity-by-id)
        identityId: ada,
        tenantId: A,
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Sales' },
        trigger: 'hr-sync',
      },
      actor: 'system:hr-sync',
    });
    expect(byId.get(bob)?.input).toEqual(
      expect.objectContaining({
        changedFields: ['jobTitle', 'location'],
        previousAttributes: { jobTitle: 'Rep', location: 'Helsinki' },
      }),
    );
  });

  it('leaves alone the undelivered, the unprovisioned, the inactive and matching access', async () => {
    const staff = await seedMany(A, 30);
    const notDelivered = await seed(A, 'nd');
    const unprovisioned = await seed(A, 'up', { synced: false });
    const suspended = await seed(A, 'su', { status: 'SUSPENDED' });
    const noBaseline = await seed(A, 'nb', { baseline: false });
    await hrSays(A, [notDelivered, unprovisioned, suspended, noBaseline], {
      departmentName: 'Engineering',
    });
    // Outside the four trigger attributes: no mover run.
    await hrSays(A, staff.slice(0, 5), { employmentType: 'PART_TIME', costCenter: 'CC-9' });

    const summary = await sync(A, [...staff, unprovisioned, suspended, noBaseline]);

    expect(summary).toEqual(
      expect.objectContaining({ detected: 0, started: 0, withoutBaseline: 1 }),
    );
    expect(triggerMover).not.toHaveBeenCalled();
  });

  // The mover's own rule (provisionedSystems), plan 2.0dq: provisioned once, until a deprovision
  it('moves an identity whose only target failed in a mover run, not one never provisioned', async () => {
    const staff = await seedMany(A, 30);
    const moverFailed = await seed(A, 'mf', {
      provisioning: [{ targetSystem: 'okta', status: 'ERROR', provisionedAt: new Date(clock) }],
    });
    // Onboarding failed before any account existed; a deprovisioned target holds none either
    const neverProvisioned = await seed(A, 'np', {
      provisioning: [{ targetSystem: 'okta', status: 'ERROR' }],
    });
    const deprovisioned = await seed(A, 'dp', {
      provisioning: [{ targetSystem: 'okta', status: 'DEPROVISIONED', provisionedAt: null }],
    });
    await hrSays(A, [moverFailed, neverProvisioned, deprovisioned], {
      departmentName: 'Engineering',
    });

    const summary = await sync(A, [...staff, moverFailed, neverProvisioned, deprovisioned]);

    expect(summary).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(starts().map(([id]) => id)).toEqual([moverFailed]);
  });

  it.each([
    ['a skipped row', { skipped: 1 }],
    ['a failed row', { errorCount: 2 }],
    ['nothing fetched', { fetched: 0 }],
  ])('moves nobody after a partial sync (%s)', async (_label, run) => {
    const staff = await seedMany(A, 10);
    await hrSays(A, staff, { departmentName: '' });

    const summary = await sync(A, staff, run);

    expect(summary).toEqual(expect.objectContaining({ fullSync: false, detected: 0, started: 0 }));
    expect(triggerMover).not.toHaveBeenCalled();
    expect(emitted(DomainEventType.MOVER_BATCH_PAUSED)).toHaveLength(0);
  });

  it('skips identities an HR leaver is offboarding, not ones whose offboarding finished', async () => {
    const staff = await seedMany(A, 20);
    const [pendingLeaver, runningLeaver, rehired] = staff;
    await hrSays(A, [pendingLeaver, runningLeaver, rehired], { departmentName: 'Leavers' });
    const leaver = (identityId: string, extra: Record<string, unknown>) => ({
      tenantId: A,
      identityId,
      sourceName: SOURCE,
      reason: 'terminated',
      eventKey: `${SOURCE}:terminated:${identityId}`,
      detectedAt: new Date(clock),
      ...extra,
    });
    await withTenantContext(A, () =>
      leaverEventModel.create([
        leaver(pendingLeaver, { status: 'pending-approval', open: true }),
        leaver(runningLeaver, { status: 'started', open: false, workflowId: 'w1' }),
        leaver(rehired, {
          status: 'started',
          open: false,
          workflowId: 'w2',
          offboardingFinishedAt: new Date(),
        }),
      ]),
    );

    const summary = await sync(A, staff);

    expect(summary.detected).toBe(1);
    expect(starts().map(([id]) => id)).toEqual([rehired]);
  });

  it('pauses a mass change above the limit: nothing starts, the batch shows the changes', async () => {
    const staff = await seedMany(A, 40);
    const moved = staff.slice(0, 5);
    await hrSays(A, moved, { departmentName: 'Engineering' });

    const summary = await sync(A, staff);

    // 40 active identities: 5 % is 2 (the floor is 2 as well), so 5 moves need approval.
    expect(summary).toEqual(expect.objectContaining({ detected: 5, started: 0 }));
    expect(summary.pausedBatchId).toBeDefined();
    expect(triggerMover).not.toHaveBeenCalled();
    const [pending] = await asAdmin(A, () => batches.list('pending'));
    expect(pending).toEqual(
      expect.objectContaining({
        id: summary.pausedBatchId,
        sourceName: SOURCE,
        identityCount: 5,
        allowance: 2,
        activeIdentityCount: 40,
        fieldCounts: { departmentName: 5 },
      }),
    );
    expect(pending.items).toHaveLength(5);
    expect(pending.items[0]).toEqual(
      expect.objectContaining({
        status: 'pending-approval',
        displayName: expect.stringMatching(/^p\d Test$/),
        changes: [{ field: 'departmentName', before: 'Sales', after: 'Engineering' }],
      }),
    );
    expect(emitted(DomainEventType.MOVER_BATCH_PAUSED)[0][2]).toEqual({
      batchId: summary.pausedBatchId,
      sourceName: SOURCE,
      identityCount: 5,
      limit: 2,
      activeIdentityCount: 40,
    });

    // While the batch waits, the next sync raises its members again nowhere.
    const again = await sync(A, staff);
    expect(again).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(again.pausedBatchId).toBeUndefined();
  });

  it('approval starts each member with its changes as they are now, once', async () => {
    const staff = await seedMany(A, 40);
    const moved = staff.slice(0, 5);
    await hrSays(A, moved, { departmentName: 'Engineering' });
    const { pausedBatchId } = await sync(A, staff);
    // Since the pause: one went back to Sales, one moved on to Finance, one is being offboarded.
    await hrSays(A, [moved[0]], { departmentName: 'Sales' });
    await hrSays(A, [moved[1]], { departmentName: 'Finance' });
    await withTenantContext(A, () =>
      leaverEventModel.create({
        tenantId: A,
        identityId: moved[2],
        sourceName: SOURCE,
        reason: 'end-date',
        eventKey: 'k',
        status: 'queued',
        open: true,
        detectedAt: new Date(),
      }),
    );

    const answer = await asAdmin(A, () =>
      batches.approve(pausedBatchId!, 'admin@a.example', 'Reorganisation'),
    );

    // The answer comes before the starts: every member pending, nothing counted yet
    expect(answer).toEqual(
      expect.objectContaining({ status: 'approved', decidedBy: 'admin@a.example' }),
    );
    expect(answer.startedCount).toBeUndefined();
    expect(answer.items.map((i) => i.status)).toEqual(Array(5).fill('pending-approval'));
    expect(emitted(DomainEventType.MOVER_BATCH_APPROVED)[0][2]).toEqual({
      batchId: pausedBatchId,
      sourceName: SOURCE,
      identityCount: 5,
      comment: 'Reorganisation',
    });

    const view = await afterStarts(A, pausedBatchId!);
    expect(view.startedCount).toBe(3);
    expect(
      starts()
        .map(([id]) => id)
        .sort(),
    ).toEqual([moved[1], moved[3], moved[4]].sort());
    const finance = starts().find(([id]) => id === moved[1])!;
    expect(finance[1]).toEqual(
      expect.objectContaining({
        trigger: 'hr-sync',
        previousAttributes: { departmentName: 'Sales' },
      }),
    );
    expect(finance[2]).toBe('admin@a.example');
    const item = (id: string) => view.items.find((i) => i.identityId === id)!;
    expect(item(moved[0])).toEqual(
      expect.objectContaining({
        status: 'superseded',
        closeReason: expect.stringMatching(/matches/),
      }),
    );
    expect(item(moved[1])).toEqual(
      expect.objectContaining({
        status: 'started',
        workflowId: `t-${A}-mover-${moved[1]}`,
        changes: [{ field: 'departmentName', before: 'Sales', after: 'Finance' }],
      }),
    );
    expect(item(moved[2])).toEqual(
      expect.objectContaining({
        status: 'superseded',
        closeReason: expect.stringMatching(/offboarding/),
      }),
    );

    await expect(
      asAdmin(A, () => batches.approve(pausedBatchId!, 'other@a.example')),
    ).rejects.toThrow(ConflictException);
    await expect(
      asAdmin(A, () => batches.reject(pausedBatchId!, 'other@a.example')),
    ).rejects.toThrow(ConflictException);
    expect(triggerMover).toHaveBeenCalledTimes(3);
  });

  it('answers at once while the mover starts hang; each start fails after its timeout', async () => {
    const staff = await seedMany(A, 40);
    await hrSays(A, staff.slice(0, 5), { departmentName: 'Engineering' });
    const { pausedBatchId } = await sync(A, staff);
    // Temporal down: a start never answers (the client's gRPC retries took 30 to 45 s each)
    triggerMover.mockImplementation(() => new Promise<string>(() => {}));
    process.env.HR_START_TIMEOUT_MS = '50';
    try {
      const answer = await asAdmin(A, () => batches.approve(pausedBatchId!, 'admin@a.example'));
      expect(answer.items.map((i) => i.status)).toEqual(Array(5).fill('pending-approval'));

      const view = await afterStarts(A, pausedBatchId!);
      expect(view.startedCount).toBe(0);
      expect(view.items.map((i) => [i.status, i.closeReason])).toEqual(
        Array(5).fill([
          'failed',
          'The mover run did not start: The mover start did not answer within 50 ms',
        ]),
      );
    } finally {
      delete process.env.HR_START_TIMEOUT_MS;
      triggerMover.mockImplementation(startMoverRun);
    }
  });

  it('a full sync starts the items an approval run left pending, never a claimed one', async () => {
    const staff = await seedMany(A, 40);
    const moved = staff.slice(0, 5);
    await hrSays(A, moved, { departmentName: 'Engineering' });
    const { pausedBatchId } = await sync(A, staff);
    // As if the approval decided and its process stopped before starting anything: one item has
    // a stale claim (that process died), one a fresh claim (another process is starting it)
    const batchModel = moduleRef.get<Model<unknown>>(getModelToken(MoverBatch.name));
    await withTenantContext(A, async () => {
      await batchModel
        .updateOne(
          { _id: pausedBatchId },
          { $set: { status: 'approved', decidedBy: 'admin@a.example', decidedAt: new Date() } },
        )
        .exec();
      await itemModel
        .updateMany({ batchId: pausedBatchId }, { $set: { decidedBy: 'admin@a.example' } })
        .exec();
      await itemModel
        .updateOne(
          { batchId: pausedBatchId, identityId: moved[0] },
          { $set: { claimedAt: new Date(Date.now() - 2 * HOUR) } },
        )
        .exec();
      await itemModel
        .updateOne(
          { batchId: pausedBatchId, identityId: moved[1] },
          { $set: { claimedAt: new Date() } },
        )
        .exec();
    });

    await sync(A, staff);

    expect(
      starts()
        .map(([id]) => id)
        .sort(),
    ).toEqual([moved[0], ...moved.slice(2)].sort());
    expect(starts().every(([, , requestedBy]) => requestedBy === 'admin@a.example')).toBe(true);
    const [view] = await asAdmin(A, () => batches.list('approved'));
    expect(view.startedCount).toBe(4);
    expect(view.items.find((i) => i.identityId === moved[1])?.status).toBe('pending-approval');
  });

  it('rejection starts nothing; the same changes are not raised again, new ones are', async () => {
    const staff = await seedMany(A, 40);
    const moved = staff.slice(0, 5);
    await hrSays(A, moved, { departmentName: '' });
    const { pausedBatchId } = await sync(A, staff);

    const view = await asAdmin(A, () =>
      batches.reject(pausedBatchId!, 'admin@a.example', 'Broken export'),
    );

    expect(view.status).toBe('rejected');
    expect(view.items.every((i) => i.status === 'rejected')).toBe(true);
    expect(triggerMover).not.toHaveBeenCalled();
    expect(emitted(DomainEventType.MOVER_BATCH_REJECTED)).toHaveLength(1);

    const same = await sync(A, staff);
    expect(same).toEqual(expect.objectContaining({ detected: 0, started: 0 }));

    await hrSays(A, [moved[0]], { departmentName: 'Engineering' });
    const changed = await sync(A, staff);
    expect(changed).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(starts().map(([id]) => id)).toEqual([moved[0]]);
  });

  it('counts a run already in progress and a failed start; the next sync retries the failure', async () => {
    const staff = await seedMany(A, 40);
    const [running, failing] = staff;
    await hrSays(A, [running, failing], { departmentName: 'Engineering' });
    triggerMover.mockImplementation(async (input: MoverWorkflowInput) => {
      if (input.identityId === running) {
        throw new WorkflowExecutionAlreadyStartedError(
          'running',
          `t-${A}-mover-${running}`,
          'moverWorkflow',
        );
      }
      if (input.identityId === failing) throw new Error('Temporal unreachable');
      return 'never';
    });

    const summary = await sync(A, staff);
    expect(summary).toEqual(
      expect.objectContaining({ detected: 2, started: 0, alreadyRunning: 1, startFailed: 1 }),
    );

    triggerMover.mockImplementation(
      async (input: MoverWorkflowInput) => `t-${A}-mover-${input.identityId}`,
    );
    const retry = await sync(A, staff);
    expect(retry).toEqual(expect.objectContaining({ detected: 2, started: 2 }));
  });

  it('a stored policy with a floor of 0 pauses a single move in a small tenant', async () => {
    const staff = await seedMany(A, 10);
    await asAdmin(A, () =>
      policies.updatePolicy(
        { massMoverMaxCount: 10, massMoverMaxPercent: 5, massMoverMinCount: 0 },
        'admin@a.example',
      ),
    );
    await hrSays(A, [staff[0]], { jobTitle: 'Lead' });

    const summary = await sync(A, staff);

    expect(summary.pausedBatchId).toBeDefined();
    expect(triggerMover).not.toHaveBeenCalled();
    expect(emitted(DomainEventType.MOVER_POLICY_UPDATED)[0][2]).toEqual({
      changedFields: ['massMoverMinCount'],
    });
  });

  it('keeps tenants apart: syncs, batches and decisions', async () => {
    const staffA = await seedMany(A, 40, 'a');
    const staffB = await seedMany(B, 40, 'b');
    await hrSays(A, staffA.slice(0, 5), { departmentName: 'Engineering' });
    await hrSays(B, staffB.slice(0, 1), { departmentName: 'Engineering' });

    const inB = await sync(B, [...staffA, ...staffB]);
    expect(inB).toEqual(expect.objectContaining({ detected: 1, started: 1 }));
    expect(starts()[0][1].tenantId).toBe(B);

    const { pausedBatchId } = await sync(A, staffA);
    expect(await asAdmin(B, () => batches.list())).toEqual([]);
    await expect(
      asAdmin(B, () => batches.approve(pausedBatchId!, 'admin@b.example')),
    ).rejects.toThrow(NotFoundException);
    const [batchA] = await asAdmin(A, () => batches.list());
    expect(batchA.status).toBe('pending');
  });
});
