/**
 * HR-driven leaver, end to end on the time-skipping Temporal test server and in-memory MongoDB.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * The scheduled sync runs as in production: scheduledSyncWorkflow -> runScheduledSync activity ->
 * SyncSchedulerService -> HrIngestionService (real CSV HR connector, real identity correlation)
 * -> HR_SYNC_COMPLETED -> leaver detection -> IDENTITY_OFFBOARD_REQUESTED -> OffboardingService,
 * which starts the real offboardingWorkflow on the test server. Only connector side effects of
 * the offboarding (Entra delete, Hub markDeleted, the result record) are stubbed.
 *
 * Proves:
 *   - A CSV with one terminated person and one past end date starts two offboarding workflows,
 *     each with its reason in the memo and on the identity timeline.
 *   - A feed that drops 12 people starts nothing once they count as missing (3 full syncs): a
 *     pending leaver batch holds them. Approving it starts 12 offboardings.
 *   - Re-running the sync starts no workflow twice (same run ids on the test server).
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
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { OffboardingEventHandler } from '../../src/infrastructure/events/handlers/offboarding-event.handler';
import { LeaverTimelineHandler } from '../../src/infrastructure/events/handlers/leaver-timeline.handler';
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
import { SyncSchedulerService } from '../../src/modules/connectors/sync-scheduler.service';
import { HrIngestionService } from '../../src/modules/connectors/hr-ingestion.service';
import { ConnectorConfigService } from '../../src/modules/connectors/connector-config.service';
import { PluginRegistryService } from '../../src/modules/connectors/plugin/plugin-registry.service';
import { CsvHrService } from '../../src/modules/connectors/csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from '../../src/modules/connectors/json-api-hr-connector/json-api-hr.service';
import { csvHrManifest } from '../../src/modules/connectors/csv-hr-connector/connector.manifest';
import { BlueprintsService } from '../../src/modules/blueprints/blueprints.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { IdentityQueryService } from '../../src/modules/identity/identity-query.service';
import { IdentityMutationService } from '../../src/modules/identity/identity-mutation.service';
import { IdentityCorrelationService } from '../../src/modules/identity/identity-correlation.service';
import { IdentityUncorrelatedService } from '../../src/modules/identity/identity-uncorrelated.service';
import { IdentityProvisioningService } from '../../src/modules/identity/identity-provisioning.service';
import { IdentityOnionService } from '../../src/modules/identity/identity-onion.service';
import { IdentityDeletedMatchService } from '../../src/modules/identity/identity-deleted-match.service';
import { ReconciliationService } from '../../src/modules/identity/reconciliation.service';
import { ReconciliationConfigService } from '../../src/modules/identity/reconciliation-config.service';
import { CorrelationConfigService } from '../../src/modules/correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from '../../src/modules/identity/correlation/correlation-rule.engine';
import { UserEventService } from '../../src/modules/identity/user-event.service';
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
import { LeaverBatchService } from '../../src/modules/leavers/leaver-batch.service';
import { LeaverSyncHandler } from '../../src/modules/leavers/leaver-sync.handler';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const TENANT = 'tenant-a';
const DAY = 24 * 60 * 60 * 1000;

interface Person {
  id: string;
  status?: string;
  endDate?: string;
}

function csv(people: Person[]): string {
  const rows = people.map(
    (p) =>
      `${p.id},${p.id},Test,${p.id.toLowerCase()}@corp.example,${p.status ?? 'Active'},${p.endDate ?? ''}`,
  );
  return ['EmpID,First Name,Last Name,Email,Status,End Date', ...rows].join('\n') + '\n';
}

const staff: Person[] = Array.from({ length: 48 }, (_, i) => ({
  id: `S${String(i).padStart(3, '0')}`,
}));
const dropped: Person[] = Array.from({ length: 12 }, (_, i) => ({
  id: `D${String(i).padStart(3, '0')}`,
}));
const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
const terminated: Person = { id: 'T001', status: 'Terminated' };
const ended: Person = { id: 'E001', endDate: twoDaysAgo };

describeTemporalE2E('HR-driven leaver (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let csvDir: string;
  let scheduledSync: ScheduledSyncActivities | undefined;
  const offboardingActivities = {
    // No linked admin accounts (the cascade: offboarding-linked-admins.workflow.e2e-spec.ts)
    getLinkedAdminIdentities: jest.fn(async () => []),
    getOffboardingTargets: jest.fn(async () => ({
      noProvisioningState: false,
      targets: [{ targetSystem: 'entra-id', externalId: 'x', status: 'SYNCED' }],
    })),
    getConnectorConfig: jest.fn(async () => ({ tenantId: 'entra-tenant' })),
    setProvisioningStatus: jest.fn(async () => undefined),
    markDeleted: jest.fn(async () => undefined),
    suspendIdentity: jest.fn(async () => undefined),
    recordOffboardingOutcome: jest.fn(async () => undefined),
  };
  const entraDeleteUser = jest.fn(async (..._args: unknown[]) => ({
    success: true,
    outcome: 'deprovisioned',
  }));

  beforeAll(async () => {
    csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-leaver-e2e-'));
    process.env.CSV_HR_ALLOWED_DIR = csvDir;

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        runScheduledSync: (input: unknown) =>
          scheduledSync!.runScheduledSync(
            input as Parameters<ScheduledSyncActivities['runScheduledSync']>[0],
          ),
        ...offboardingActivities,
      },
      queueWorkers: [
        { taskQueue: QUEUE_NAMES['entra'], activities: { deleteUser: entraDeleteUser } },
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
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
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
        // Identity hub (real correlation, minting and source tracking)
        IdentityService,
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        UserEventService,
        {
          provide: ReconciliationService,
          useValue: { reconcile: async (identity: IdentityDocument) => identity },
        },
        { provide: ReconciliationConfigService, useValue: { getHrSourceTags: async () => [] } },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({ rules: [{ strategy: 'email' }] }),
            getPrimaryHrSourceName: async () => null,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            isHrSourceName: async (name: string) => name === 'csv-hr',
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
        // Domain events (real emitter and handlers)
        DomainEventEmitterService,
        { provide: DeadLetterService, useValue: { capture: jest.fn() } },
        { provide: getModelToken(OutboxEvent.name), useValue: {} },
        OffboardingEventHandler,
        LeaverTimelineHandler,
        LeaverSyncHandler,
        // Leavers and offboarding (real), Temporal client = the test server
        LeaverPolicyService,
        LeaverDetectionService,
        LeaverExecutionService,
        LeaverBatchService,
        OffboardingService,
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

  async function identityIdOf(person: Person): Promise<string> {
    const model = moduleRef.get<Model<IdentityDocument>>(getModelToken(Identity.name));
    const doc = await withTenantContext(TENANT, () =>
      model
        .findOne({ 'profile.email': `${person.id.toLowerCase()}@corp.example` })
        .lean()
        .exec(),
    );
    expect(doc).toBeTruthy();
    return String(doc!._id);
  }

  const offboardingId = (identityId: string) => `t-${TENANT}-offboard-${identityId}`;

  async function describeOffboarding(identityId: string) {
    const handle = harness.env.client.workflow.getHandle(offboardingId(identityId));
    await handle.result();
    return handle.describe();
  }

  async function timelineTypes(identityId: string): Promise<string[]> {
    const model = moduleRef.get<Model<UserEventDocument>>(getModelToken(UserEvent.name));
    // Timeline handlers run after the emit returns; give them a moment.
    for (let attempt = 0; attempt < 200; attempt++) {
      const events = await withTenantContext(TENANT, () =>
        model.find({ userId: identityId }).lean().exec(),
      );
      if (events.length >= 2) return events.map((e) => e.type).sort();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }

  it('offboards a terminated person and a passed end date, with the reason', async () => {
    writeFeed([...staff, ...dropped, terminated, ended]);

    await runSync();

    const terminatedId = await identityIdOf(terminated);
    const endedId = await identityIdOf(ended);
    const t = await describeOffboarding(terminatedId);
    const e = await describeOffboarding(endedId);
    expect(t.memo).toEqual(expect.objectContaining({ reason: 'leaver:terminated' }));
    expect(e.memo).toEqual(expect.objectContaining({ reason: 'leaver:end-date' }));
    expect(t.status.name).toBe('COMPLETED');
    expect(t.searchAttributes).toEqual(expect.objectContaining({ TenantId: [TENANT] }));
    expect(await timelineTypes(terminatedId)).toEqual(['LEAVER_DETECTED', 'WORKFLOW_STARTED']);
    // Nobody else left.
    await expect(
      harness.env.client.workflow.getHandle(offboardingId(await identityIdOf(staff[0]))).describe(),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  }, 120_000);

  it('pauses 12 people missing from the feed, starts them on approval, never twice', async () => {
    writeFeed([...staff, terminated, ended]);
    const droppedIds = await Promise.all(dropped.map(identityIdOf));

    // Missing in three consecutive full syncs: the third makes them leavers.
    await runSync();
    await runSync();
    await runSync();

    for (const id of droppedIds) {
      await expect(
        harness.env.client.workflow.getHandle(offboardingId(id)).describe(),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    const batches = moduleRef.get(LeaverBatchService);
    const [pending] = await withTenantContext(TENANT, () => batches.list('pending'));
    expect(pending).toEqual(expect.objectContaining({ identityCount: 12, sourceName: 'csv-hr' }));
    expect(pending.items.map((i) => i.identityId).sort()).toEqual([...droppedIds].sort());

    const approved = await withTenantContext(TENANT, () =>
      batches.approve(pending.id, 'admin@corp.example', 'HR confirmed'),
    );
    expect(approved.status).toBe('approved');
    // The offboardings start after the approval answered; the run records startedCount last
    let startedCount: number | undefined;
    for (let i = 0; i < 200 && startedCount === undefined; i++) {
      const decided = await withTenantContext(TENANT, () => batches.list('approved'));
      startedCount = decided.find((b) => b.id === pending.id)?.startedCount;
      if (startedCount === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(startedCount).toBe(12);
    const runIds = new Map<string, string>();
    for (const id of droppedIds) {
      const d = await describeOffboarding(id);
      expect(d.memo).toEqual(expect.objectContaining({ reason: 'leaver:missing-from-source' }));
      runIds.set(id, d.runId);
    }
    const earlierIds = [await identityIdOf(terminated), await identityIdOf(ended)];
    for (const id of earlierIds) runIds.set(id, (await describeOffboarding(id)).runId);

    // The same feed again: no new leaver, no workflow started a second time.
    await runSync();
    for (const [id, runId] of runIds) {
      expect(
        (await harness.env.client.workflow.getHandle(offboardingId(id)).describe()).runId,
      ).toBe(runId);
    }
    const [stillPending] = await withTenantContext(TENANT, () => batches.list('pending'));
    expect(stillPending).toBeUndefined();
    // Every leaver was deprovisioned, each by its own single workflow run (activity retries aside).
    const deprovisioned = new Set(entraDeleteUser.mock.calls.map((call) => String(call[2])));
    expect([...deprovisioned].sort()).toEqual([...runIds.keys()].sort());
  }, 180_000);
});
