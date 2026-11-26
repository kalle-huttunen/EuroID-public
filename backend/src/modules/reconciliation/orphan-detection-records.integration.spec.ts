/**
 * One open orphan record per target account, on in-memory MongoDB (drift_records) with the real
 * DriftService and OrphanCleanupService (Temporal faked). Every reconciliation run recorded an
 * orphan it had already quarantined again: a new drift, a new orphan.detected and a new cleanup
 * workflow per run.
 *
 * Proves: a later run records nothing new for an account with an open orphan drift whose cleanup
 * started, while a new orphan account is still recorded; an open drift whose cleanup never
 * started (no workflow id) is handed to the run to start one, without a new drift or event; an
 * account whose latest orphan drift an admin ignored is never recorded again, and ignoring it
 * cancels its cleanup; an account whose drift was corrected gets nothing new while that cleanup
 * still runs, and a new record once none runs.
 */
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { WorkflowNotFoundError } from '@temporalio/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { orphanConfig } from '@infrastructure/config/orphan.config';
import type { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import type { TargetAccount } from '@shared/interfaces/provisioning.interface';
import { connectTestDb, clearTestDb, closeTestDb, createMockEventEmitter } from '@testing';
import { IdentityService } from '../identity/identity.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { AdService } from '../connectors/ad-connector/ad.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';
import { Drift, DriftDocument, DriftSchema } from './schemas/drift.schema';
import { DriftService } from './drift.service';
import { DriftCorrectionService } from './drift-correction.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { OrphanDetectionService } from './orphan-detection.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const CLEANUP_ID = 't-tenant-a-orphan-cleanup-1';

/** An Entra ID account no identity owns. */
const account = (id: string): TargetAccount => ({
  id,
  userPrincipalName: `${id}@corp.example`,
  displayName: `Orphan ${id}`,
});

/** Cleanup workflows by id with their status, as Temporal describes them; others not found. */
const cleanups = new Map<string, string>();
const notFound = (workflowId: string) =>
  new WorkflowNotFoundError('Workflow not found', workflowId, undefined);
const temporal = {
  getClient: () => ({
    workflow: {
      getHandle: (workflowId: string) => ({
        describe: async () => {
          const status = cleanups.get(workflowId);
          if (!status) throw notFound(workflowId);
          return { status: { name: status } };
        },
        cancel: async () => {
          if (cleanups.get(workflowId) !== 'RUNNING') throw notFound(workflowId);
          cleanups.set(workflowId, 'CANCELLED');
        },
      }),
    },
  }),
};

describe('OrphanDetectionService: one open orphan record per account (in-memory MongoDB)', () => {
  let driftModel: Model<DriftDocument>;
  let drifts: DriftService;
  let service: OrphanDetectionService;
  const events = createMockEventEmitter();
  const listUsers = jest.fn();
  const orphanCleanup = new OrphanCleanupService(temporal as unknown as TemporalClientProvider);

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    Promise.resolve(withTenantContext(TENANT, fn));
  const run = () => service.detectOrphans('entra-id', TENANT);
  /** The stored drift records as MongoDB holds them, oldest first. */
  const stored = () => driftModel.collection.find({}).sort({ _id: 1 }).toArray();
  const detected = () => events.emit.mock.calls.filter(([type]) => type === 'orphan.detected');
  /** What the reconciliation run does once it has started a drift's cleanup. */
  const cleanupStarted = (driftId: string) => {
    cleanups.set(CLEANUP_ID, 'RUNNING');
    return inTenant(() => drifts.updateDriftWorkflowId(driftId, CLEANUP_ID));
  };
  /** A drift corrected while its cleanup kept running (closed before closing stopped it). */
  const correctedEarlier = (driftId: string) =>
    driftModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(driftId) },
      { $set: { status: 'corrected' } },
    );

  beforeAll(async () => {
    await connectTestDb();
    driftModel = mongoose.model(Drift.name, DriftSchema) as unknown as Model<DriftDocument>;
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrphanDetectionService,
        DriftService,
        { provide: getModelToken(Drift.name), useValue: driftModel },
        { provide: DriftCorrectionService, useValue: {} },
        {
          provide: IdentityService,
          useValue: {
            findUserForReconciliation: jest.fn().mockResolvedValue(null),
            findLiveOwnerKeys: jest.fn().mockResolvedValue(new Set()),
          },
        },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: EntraService, useValue: { listUsers } },
        { provide: AdService, useValue: {} },
        { provide: SCIMService, useValue: {} },
        { provide: ConnectorConfigService, useValue: {} },
        { provide: orphanConfig.KEY, useValue: { gracePeriodDays: 30 } },
        { provide: OrphanCleanupService, useValue: orphanCleanup },
      ],
    }).compile();
    service = moduleRef.get(OrphanDetectionService);
    drifts = moduleRef.get(DriftService);
  });

  beforeEach(() => {
    cleanups.clear();
    events.emit.mockClear();
    listUsers.mockReset().mockResolvedValue({ users: [account('ext-1')], nextLink: undefined });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('records an orphan once: a later run adds no drift, event or cleanup for it', async () => {
    const first = await run();
    expect(first.driftRecords).toHaveLength(1);
    await cleanupStarted(first.driftRecords[0]._id.toString());
    // A second orphan account appears; the first is still there
    const users = [account('ext-1'), account('ext-2')];
    listUsers.mockResolvedValue({ users, nextLink: undefined });

    const second = await run();

    expect(second.orphans.map((o) => o.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(second.driftRecords.map((d) => d.userId)).toEqual(['ext-2']);
    expect((await stored()).map((d) => d.userId)).toEqual(['ext-1', 'ext-2']);
    expect(detected().map(([, aggregateId]) => aggregateId)).toEqual(['ext-1', 'ext-2']);
  });

  // The run, or the detection attempt Temporal retried, stopped before it started the cleanup
  it('hands an open drift without a cleanup to the run to start one, recording nothing new', async () => {
    const first = await run();
    const driftId = first.driftRecords[0]._id.toString();

    const second = await run();

    expect(second.driftRecords.map((d) => d._id.toString())).toEqual([driftId]);
    expect(await stored()).toHaveLength(1);
    expect(detected()).toHaveLength(1);
  });

  // POST /reconciliation/drifts/:id/ignore: an ignore is a decision, as for detected drifts
  it('never quarantines an account again once an admin ignored it, and cancels its cleanup', async () => {
    const first = await run();
    const driftId = first.driftRecords[0]._id.toString();
    await cleanupStarted(driftId);

    await inTenant(() => drifts.ignoreDrift(driftId));
    expect(cleanups.get(CLEANUP_ID)).toBe('CANCELLED');
    const second = await run();
    const third = await run();

    expect(second.driftRecords).toEqual([]);
    expect(third.driftRecords).toEqual([]);
    expect((await stored()).map((d) => d.status)).toEqual(['ignored']);
    expect(detected()).toHaveLength(1);
  });

  it('records nothing new while the cleanup of a corrected drift still runs', async () => {
    const first = await run();
    const driftId = first.driftRecords[0]._id.toString();
    await cleanupStarted(driftId);
    await correctedEarlier(driftId);

    const second = await run();

    expect(second.driftRecords).toEqual([]);
    expect(await stored()).toHaveLength(1);
    expect(detected()).toHaveLength(1);
  });

  // An adopted account whose identity left, or a deleted account created again
  it.each([
    ['has ended', 'COMPLETED'],
    ['is not found (no longer in Temporal)', undefined],
  ])(
    'records the account again once its drift was corrected and its cleanup %s',
    async (_label, cleanupStatus) => {
      const first = await run();
      const driftId = first.driftRecords[0]._id.toString();
      await cleanupStarted(driftId);
      await correctedEarlier(driftId);
      if (cleanupStatus) cleanups.set(CLEANUP_ID, cleanupStatus);
      else cleanups.delete(CLEANUP_ID);

      const second = await run();

      expect(second.driftRecords).toHaveLength(1);
      expect(second.driftRecords[0]._id.toString()).not.toBe(driftId);
      expect((await stored()).map((d) => d.status)).toEqual(['corrected', 'quarantined']);
      expect(detected()).toHaveLength(2);
    },
  );
});
