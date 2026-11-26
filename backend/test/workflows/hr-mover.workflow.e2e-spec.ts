/**
 * HR-driven mover, end to end on the time-skipping Temporal test server and in-memory MongoDB.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * The scheduled sync runs as in production: scheduledSyncWorkflow -> runScheduledSync activity ->
 * SyncSchedulerService -> HrIngestionService (real CSV HR connector, real identity correlation and
 * reconciliation) -> HR_SYNC_COMPLETED (leaver detection) -> HR_SYNC_MOVERS_REQUESTED (HR mover
 * detection) -> MoverService, which starts the real moverWorkflow on the test server. The mover's
 * Entra change (applyMoverAccess on the Entra queue) and the policy evaluation are stubbed (the
 * stub reads the identity by id from MongoDB); recording its outcome (and so advancing the access
 * baseline) is the real MoverActivities.
 *
 * Proves:
 *   - A department change in the CSV starts the mover with trigger hr-sync, the access baseline's
 *     value as before, and system:hr-sync as the actor; the timeline says so.
 *   - Okta, where the identities were never provisioned, is reported "No account" and not
 *     attempted: the run still completes, so the next sync does not start it again.
 *   - A person terminated in the same sync with a changed department is offboarded, not moved.
 *   - A reorganisation above the mass-mover limit starts nothing; approving the batch starts
 *     each mover once, and the next sync starts nothing again.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { WorkflowNotFoundError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { ApplicationFailure } from '@temporalio/common';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { OffboardingEventHandler } from '../../src/infrastructure/events/handlers/offboarding-event.handler';
import { MoverTimelineHandler } from '../../src/infrastructure/events/handlers/mover-timeline.handler';
import { DeadLetterService } from '../../src/modules/dead-letter/dead-letter.service';
import { TemporalClientProvider } from '../../src/infrastructure/temporal/temporal-client.provider';
import { TenantService } from '../../src/infrastructure/multi-tenancy/tenant.service';
import {
  DEFAULT_PROVISIONING_QUEUE,
  QUEUE_NAMES,
} from '../../src/infrastructure/temporal/task-queue.config';
import { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import { CorrelationHashService } from '../../src/infrastructure/services/correlation-hash.service';
import { scheduledSyncWorkflow } from '../../src/workflows/scheduled-sync.workflow';
import { ScheduledSyncActivities } from '../../src/activities/scheduled-sync.activities';
import { EntraActivities } from '../../src/activities/entra.activities';
import { AdActivities } from '../../src/activities/ad.activities';
import { MoverActivities } from '../../src/activities/mover.activities';
import { SyncSchedulerService } from '../../src/modules/connectors/sync-scheduler.service';
import { HrIngestionService } from '../../src/modules/connectors/hr-ingestion.service';
import { ConnectorConfigService } from '../../src/modules/connectors/connector-config.service';
import { PluginRegistryService } from '../../src/modules/connectors/plugin/plugin-registry.service';
import { CsvHrService } from '../../src/modules/connectors/csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from '../../src/modules/connectors/json-api-hr-connector/json-api-hr.service';
import { csvHrManifest } from '../../src/modules/connectors/csv-hr-connector/connector.manifest';
import { BlueprintsService } from '../../src/modules/blueprints/blueprints.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { IdentityQueryService } from '../../src/modules/identity/identity-query.service';
import { IdentityMutationService } from '../../src/modules/identity/identity-mutation.service';
import { IdentityCorrelationService } from '../../src/modules/identity/identity-correlation.service';
import { IdentityUncorrelatedService } from '../../src/modules/identity/identity-uncorrelated.service';
import {
  IdentityProvisioningService,
  provisionedSystems,
} from '../../src/modules/identity/identity-provisioning.service';
import { IdentityOnionService } from '../../src/modules/identity/identity-onion.service';
import { IdentityDeletedMatchService } from '../../src/modules/identity/identity-deleted-match.service';
import { ReconciliationService } from '../../src/modules/identity/reconciliation.service';
import { ReconciliationConfigService } from '../../src/modules/identity/reconciliation-config.service';
import { CorrelationConfigService } from '../../src/modules/correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from '../../src/modules/identity/correlation/correlation-rule.engine';
import { UserEventService } from '../../src/modules/identity/user-event.service';
import { computeEntitlementDelta } from '../../src/shared/utils/entitlement-delta';
import { appliedAttributes } from '../../src/shared/utils/access-baseline';
import {
  Identity,
  IdentitySchema,
  IdentityDocument,
} from '../../src/modules/identity/schemas/identity.schema';
import {
  UserEvent,
  UserEventSchema,
  UserEventDocument,
} from '../../src/modules/identity/schemas/user-event.schema';
import { OffboardingService } from '../../src/modules/offboarding/offboarding.service';
import {
  LeaverPolicy,
  LeaverPolicySchema,
} from '../../src/modules/leavers/schemas/leaver-policy.schema';
import {
  LeaverEvent,
  LeaverEventSchema,
} from '../../src/modules/leavers/schemas/leaver-event.schema';
import {
  LeaverBatch,
  LeaverBatchSchema,
} from '../../src/modules/leavers/schemas/leaver-batch.schema';
import { HrSyncRun, HrSyncRunSchema } from '../../src/modules/leavers/schemas/hr-sync-run.schema';
import {
  OffboardingRecord,
  OffboardingRecordSchema,
} from '../../src/modules/leavers/schemas/offboarding-record.schema';
import { LeaverPolicyService } from '../../src/modules/leavers/leaver-policy.service';
import { LeaverDetectionService } from '../../src/modules/leavers/leaver-detection.service';
import { LeaverExecutionService } from '../../src/modules/leavers/leaver-execution.service';
import { LeaverSyncHandler } from '../../src/modules/leavers/leaver-sync.handler';
import { MoverService } from '../../src/modules/mover/mover.service';
import {
  MoverPolicy,
  MoverPolicySchema,
} from '../../src/modules/mover/schemas/mover-policy.schema';
import { MoverBatch, MoverBatchSchema } from '../../src/modules/mover/schemas/mover-batch.schema';
import {
  MoverBatchItem,
  MoverBatchItemSchema,
} from '../../src/modules/mover/schemas/mover-batch-item.schema';
import { HrMoverPolicyService } from '../../src/modules/mover/hr-mover-policy.service';
import { HrMoverExecutionService } from '../../src/modules/mover/hr-mover-execution.service';
import { HrMoverDetectionService } from '../../src/modules/mover/hr-mover-detection.service';
import { HrMoverBatchService } from '../../src/modules/mover/hr-mover-batch.service';
import { HrMoverSyncHandler } from '../../src/modules/mover/hr-mover-sync.handler';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';
import { testPayloadCodec } from '../helpers/test-payload-codec';

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const TENANT = 'tenant-a';

interface Person {
  id: string;
  department: string;
  status?: string;
}

function csv(people: Person[]): string {
  const rows = people.map(
    (p) =>
      `${p.id},${p.id},Test,${p.id.toLowerCase()}@corp.example,${p.status ?? 'Active'},${p.department}`,
  );
  return ['EmpID,First Name,Last Name,Email,Status,Department', ...rows].join('\n') + '\n';
}

const staff: Person[] = Array.from({ length: 40 }, (_, i) => ({
  id: `S${String(i).padStart(3, '0')}`,
  department: 'Sales',
}));
const leaver: Person = { id: 'T001', department: 'Sales' };

/** The tenant's policies: one Entra group and one Okta group per department. */
function policyOps(profile: { departmentName?: string }) {
  const department = profile.departmentName;
  return department
    ? [
        { type: 'group', action: 'add', target: 'entra-id', targetId: `g-${department}` },
        { type: 'group', action: 'add', target: 'okta', targetId: `okta-${department}` },
      ]
    : [];
}

describeTemporalE2E('HR-driven mover (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let csvDir: string;
  let scheduledSync: ScheduledSyncActivities | undefined;
  let moverActivities: MoverActivities | undefined;
  const sharedActivities = {
    getConnectorConfig: jest.fn(async () => ({ tenantId: 'entra-tenant' })),
    setProvisioningStatus: jest.fn(async () => undefined),
  };
  const offboardingActivities = {
    // No linked admin accounts (the cascade: offboarding-linked-admins.workflow.e2e-spec.ts)
    getLinkedAdminIdentities: jest.fn(async () => []),
    getOffboardingTargets: jest.fn(async () => ({
      noProvisioningState: false,
      targets: [{ targetSystem: 'entra-id', externalId: 'x', status: 'SYNCED' }],
    })),
    markDeleted: jest.fn(async () => undefined),
    suspendIdentity: jest.fn(async () => undefined),
    recordOffboardingOutcome: jest.fn(async () => undefined),
  };
  const moverWorkflowActivities = {
    getPipelineStatus: jest.fn(async () => 'DEPLOYED'),
    /** MoverActivities.evaluateMoverChange with the stub policies: the identity read by id. */
    evaluateMoverChange: jest.fn(
      async (
        identityId: unknown,
        changedFields: unknown,
        previousAttributes: unknown,
        tenantId: unknown,
      ) => {
        const model = moduleRef.get<Model<IdentityDocument>>(getModelToken(Identity.name));
        const doc = await withTenantContext(String(tenantId), () =>
          model
            .findOne({ _id: String(identityId) })
            .lean()
            .exec(),
        );
        if (!doc) return null;
        const profile = doc.profile as unknown as Record<string, unknown>;
        type Dept = { departmentName?: string };
        const now = policyOps(profile as Dept);
        const before = policyOps({ ...profile, ...(previousAttributes as object) } as Dept);
        const delta = computeEntitlementDelta(before, now);
        return {
          applied: appliedAttributes(profile, changedFields as string[]),
          toAdd: delta.toAdd,
          toRemove: delta.toRemove,
          operationCounts: { before: before.length, after: now.length },
          provisionedSystems: provisionedSystems(
            doc as unknown as Pick<IdentityDocument, 'provisioning' | 'sources'>,
          ),
        };
      },
    ),
    getActiveTargetSystems: jest.fn(async () => ['entra-id', 'okta']),
    recordMoverOutcome: (...args: unknown[]) =>
      moverActivities!.recordMoverOutcome(
        ...(args as Parameters<MoverActivities['recordMoverOutcome']>),
      ),
  };
  const applyMoverAccess = jest.fn(async (..._args: unknown[]) => ({ changed: 2, unchanged: 0 }));
  /** What MoverAccessActivities answers for an identity with no Okta account (422, final). */
  const oktaApplyMoverAccess = jest.fn(async (..._args: unknown[]) => {
    throw ApplicationFailure.nonRetryable(
      'okta: No Okta account found for the identity',
      'DeprovisionRejected',
    );
  });
  const entraDeleteUser = jest.fn(async (..._args: unknown[]) => ({
    success: true,
    outcome: 'deprovisioned',
  }));

  beforeAll(async () => {
    csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-mover-e2e-'));
    process.env.CSV_HR_ALLOWED_DIR = csvDir;

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        runScheduledSync: (input: unknown) =>
          scheduledSync!.runScheduledSync(
            input as Parameters<ScheduledSyncActivities['runScheduledSync']>[0],
          ),
        ...sharedActivities,
        ...offboardingActivities,
        ...moverWorkflowActivities,
      },
      queueWorkers: [
        {
          taskQueue: QUEUE_NAMES['entra'],
          activities: { deleteUser: entraDeleteUser, applyMoverAccess },
        },
        { taskQueue: QUEUE_NAMES['okta'], activities: { applyMoverAccess: oktaApplyMoverAccess } },
      ],
    });
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });

    const loggerFactory = {
      create: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    };
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: UserEvent.name, schema: UserEventSchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: LeaverBatch.name, schema: LeaverBatchSchema },
          { name: HrSyncRun.name, schema: HrSyncRunSchema },
          // LeaverExecutionService reads a start that timed out but ran from offboarding records
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
          { name: MoverPolicy.name, schema: MoverPolicySchema },
          { name: MoverBatch.name, schema: MoverBatchSchema },
          { name: MoverBatchItem.name, schema: MoverBatchItemSchema },
        ]),
      ],
      providers: [
        // Scheduled sync and HR ingestion (real CSV connector)
        ScheduledSyncActivities,
        SyncSchedulerService,
        HrIngestionService,
        CsvHrService,
        {
          provide: ConnectorConfigService,
          useValue: {
            getConfig: async () => ({ config: { filePath: 'employees.csv' } }),
            setSyncRunning: async () => true,
            updateSyncStatus: async () => undefined,
          },
        },
        { provide: PluginRegistryService, useValue: { getById: () => csvHrManifest } },
        { provide: JsonApiHrService, useValue: {} },
        { provide: BlueprintsService, useValue: {} },
        { provide: EntraActivities, useValue: {} },
        { provide: AdActivities, useValue: {} },
        { provide: TenantService, useValue: {} },
        // Identity hub (real correlation, reconciliation into the profile, source tracking)
        IdentityService,
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        UserEventService,
        ReconciliationService,
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({ rules: [{ strategy: 'email' }] }),
            getPrimaryHrSourceName: async () => null,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            isHrSourceName: async (name: string) => name === 'csv-hr',
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
          },
        },
        {
          provide: CorrelationRuleEngine,
          useValue: {
            findCorrelatedIdentity: async () => ({
              identity: null,
              matchedBy: null,
              confidence: 0,
            }),
          },
        },
        { provide: CorrelationHashService, useValue: { hash: () => 'h' } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: AuditService, useValue: { logFireAndForget: jest.fn(), log: jest.fn() } },
        // Domain events (real emitter and handlers)
        DomainEventEmitterService,
        { provide: DeadLetterService, useValue: { capture: jest.fn() } },
        { provide: getModelToken(OutboxEvent.name), useValue: {} },
        OffboardingEventHandler,
        LeaverSyncHandler,
        HrMoverSyncHandler,
        MoverTimelineHandler,
        // Leavers, offboarding and movers (real), Temporal client = the test server
        LeaverPolicyService,
        LeaverDetectionService,
        LeaverExecutionService,
        OffboardingService,
        MoverService,
        MoverActivities,
        HrMoverPolicyService,
        HrMoverExecutionService,
        HrMoverDetectionService,
        HrMoverBatchService,
        {
          provide: TemporalClientProvider,
          useValue: { getClient: () => harness.env.client, isConnected: () => true },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    await moduleRef.init();
    scheduledSync = moduleRef.get(ScheduledSyncActivities);
    moverActivities = moduleRef.get(MoverActivities);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await harness?.shutdown();
    await closeTestDb();
    fs.rmSync(csvDir, { recursive: true, force: true });
  }, 60_000);

  function writeFeed(people: Person[]): void {
    fs.writeFileSync(path.join(csvDir, 'employees.csv'), csv(people));
  }

  async function runSync(): Promise<void> {
    const result = await harness.env.client.workflow.execute(scheduledSyncWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId: `sync-${TENANT}-csv-hr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [{ tenantId: TENANT, connectorName: 'csv-hr' }],
      searchAttributes: { TenantId: [TENANT] },
    });
    expect(result).toEqual(expect.objectContaining({ success: true, type: 'ingest' }));
  }

  const identityModel = () => moduleRef.get<Model<IdentityDocument>>(getModelToken(Identity.name));

  async function identityIdOf(person: Person): Promise<string> {
    const doc = await withTenantContext(TENANT, () =>
      identityModel()
        .findOne({ 'profile.email': `${person.id.toLowerCase()}@corp.example` })
        .lean()
        .exec(),
    );
    expect(doc).toBeTruthy();
    return String(doc!._id);
  }

  /** What onboarding leaves behind: a SYNCED Entra target and the access baseline. */
  async function provisionEveryone(): Promise<void> {
    const identities = moduleRef.get(IdentityService);
    await withTenantContext(TENANT, async () => {
      const docs = await identityModel().find({}).select('_id').lean().exec();
      await identityModel()
        .updateMany(
          {},
          { $set: { provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }] } },
        )
        .exec();
      for (const doc of docs) {
        expect(await identities.recordInitialAccessBaseline(String(doc._id))).toBe(true);
      }
    });
  }

  const moverId = (identityId: string) => `t-${TENANT}-mover-${identityId}`;
  const offboardingId = (identityId: string) => `t-${TENANT}-offboard-${identityId}`;

  async function moverInput(identityId: string) {
    const handle = harness.env.client.workflow.getHandle(moverId(identityId));
    const history = await handle.fetchHistory();
    const payload =
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    // Stored encrypted by the payload codec, as the API's client sends it
    return JSON.parse(Buffer.from(testPayloadCodec.decryptPayload(payload!).data!).toString());
  }

  async function expectNoMover(identityId: string): Promise<void> {
    await expect(
      harness.env.client.workflow.getHandle(moverId(identityId)).describe(),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  }

  async function timelineTitles(identityId: string, expected: string): Promise<string[]> {
    const model = moduleRef.get<Model<UserEventDocument>>(getModelToken(UserEvent.name));
    // Timeline handlers run after the emit returns; give them a moment.
    for (let attempt = 0; attempt < 200; attempt++) {
      const events = await withTenantContext(TENANT, () =>
        model.find({ userId: identityId }).lean().exec(),
      );
      const titles = events.map((e) => e.title);
      if (titles.includes(expected)) return titles;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }

  it('moves an HR department change and offboards, not moves, a leaver', async () => {
    writeFeed([...staff, leaver]);
    await runSync();
    await provisionEveryone();
    const [ada, bob, carl] = await Promise.all(staff.slice(0, 3).map(identityIdOf));
    const leaverId = await identityIdOf(leaver);

    writeFeed([
      { ...staff[0], department: 'Engineering' },
      { ...staff[1], department: 'Engineering' },
      ...staff.slice(2),
      { ...leaver, status: 'Terminated', department: 'Former staff' },
    ]);
    await runSync();

    const handle = harness.env.client.workflow.getHandle(moverId(ada));
    await handle.result();
    const described = await handle.describe();
    expect(described.memo).toEqual(
      expect.objectContaining({ trigger: 'hr-sync', triggeredBy: 'system:hr-sync' }),
    );
    expect(described.searchAttributes).toEqual(expect.objectContaining({ TenantId: [TENANT] }));
    expect(await moverInput(ada)).toEqual(
      expect.objectContaining({
        identityId: ada,
        tenantId: TENANT,
        trigger: 'hr-sync',
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Sales' },
      }),
    );
    await harness.env.client.workflow.getHandle(moverId(bob)).result();
    expect((await moverInput(ada)).email).toBeUndefined();
    // The Entra change on the Entra queue, by identity id: Sales group out, Engineering group in.
    const adaTask = applyMoverAccess.mock.calls.find(
      ([task]) => (task as { identityId?: string }).identityId === ada,
    )?.[0];
    expect(adaTask).toEqual({
      identityId: ada,
      connector: 'entra',
      operations: [
        { type: 'group', action: 'remove', targetId: 'g-Sales' },
        { type: 'group', action: 'add', targetId: 'g-Engineering' },
      ],
    });
    expect(await timelineTitles(ada, 'Access change started by HR sync')).toContain(
      'Access change started by HR sync',
    );
    // No Okta account (never provisioned there): reported, not attempted, the run completed
    expect(await timelineTitles(ada, 'No account: okta')).toEqual(
      expect.arrayContaining(['Access updated: entra-id', 'No account: okta']),
    );
    expect(oktaApplyMoverAccess).not.toHaveBeenCalled();

    await expectNoMover(carl);
    await expectNoMover(leaverId);
    await harness.env.client.workflow.getHandle(offboardingId(leaverId)).result();
  }, 180_000);

  it('pauses a reorganisation above the limit and moves each person once on approval', async () => {
    const reorganised = staff.slice(2, 8);
    writeFeed([
      { ...staff[0], department: 'Engineering' },
      { ...staff[1], department: 'Engineering' },
      ...reorganised.map((p) => ({ ...p, department: 'Finance' })),
      ...staff.slice(8),
      { ...leaver, status: 'Terminated', department: 'Former staff' },
    ]);
    const ids = await Promise.all(reorganised.map(identityIdOf));
    const earlier = await Promise.all(staff.slice(0, 2).map(identityIdOf));
    const earlierRuns = await Promise.all(
      earlier.map(
        async (id) => (await harness.env.client.workflow.getHandle(moverId(id)).describe()).runId,
      ),
    );

    await runSync();

    for (const id of ids) await expectNoMover(id);
    const batches = moduleRef.get(HrMoverBatchService);
    const [pending] = await withTenantContext(TENANT, () => batches.list('pending'));
    // 41 active identities: 5 % is 2, the floor is 2.
    expect(pending).toEqual(
      expect.objectContaining({ identityCount: 6, allowance: 2, sourceName: 'csv-hr' }),
    );
    expect(pending.items.map((i) => i.identityId).sort()).toEqual([...ids].sort());

    const approved = await withTenantContext(TENANT, () =>
      batches.approve(pending.id, 'admin@corp.example', 'Finance reorganisation'),
    );
    expect(approved.status).toBe('approved');
    // The runs start after the approval answered; the run records startedCount last
    let startedCount: number | undefined;
    for (let i = 0; i < 200 && startedCount === undefined; i++) {
      const decided = await withTenantContext(TENANT, () => batches.list('approved'));
      startedCount = decided.find((b) => b.id === pending.id)?.startedCount;
      if (startedCount === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(startedCount).toBe(6);
    const runIds = new Map<string, string>();
    for (const id of ids) {
      const handle = harness.env.client.workflow.getHandle(moverId(id));
      await handle.result();
      const d = await handle.describe();
      expect(d.memo).toEqual(
        expect.objectContaining({ trigger: 'hr-sync', triggeredBy: 'admin@corp.example' }),
      );
      runIds.set(id, d.runId);
    }
    // The earlier movers completed and advanced the baseline: this sync did not move them again.
    for (const [i, id] of earlier.entries()) {
      expect((await harness.env.client.workflow.getHandle(moverId(id)).describe()).runId).toBe(
        earlierRuns[i],
      );
    }

    // The same feed again: every baseline now matches, so nothing starts twice.
    await runSync();
    for (const [id, runId] of runIds) {
      expect((await harness.env.client.workflow.getHandle(moverId(id)).describe()).runId).toBe(
        runId,
      );
    }
    const [stillPending] = await withTenantContext(TENANT, () => batches.list('pending'));
    expect(stillPending).toBeUndefined();
  }, 240_000);
});
