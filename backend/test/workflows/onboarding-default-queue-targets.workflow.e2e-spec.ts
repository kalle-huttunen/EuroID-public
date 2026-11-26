/**
 * Onboarding to targets without a task queue of their own, end to end on the time-skipping
 * Temporal test server and in-memory MongoDB. Opt-in via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with the connector activities worker.ts
 * registers there (defaultQueueTargetActivities, the names the workflow builds): the real File
 * outbound activity and service writing a real file, and the real ServiceNow activity, service
 * and client against a mocked Table API (axios). The identity is real: getIdentityByEmail,
 * setProvisioningStatus, getOffboardingTargets and writebackToIdentity are the real activities
 * on in-memory MongoDB, and the write-back emits identity.updated through the real
 * DomainEventEmitterService (its payload schema). Canvas discovery, edge conditions, policy and
 * the pipeline guard are stubbed.
 *
 * Proves:
 *   - A joiner onboarded to a File-outbound target gets one JSONL line with their record and the
 *     policy intent, and a SYNCED provisioning entry; no account is written back (the target
 *     keeps none).
 *   - A ServiceNow target gets its sys_user record and tracking incident, a SYNCED entry, and
 *     `snow-<sys_id>` written back: the id offboarding reads (getOffboardingTargets). The
 *     write-back's identity.updated passes its payload schema (plan 2.0du), at depth 1.
 *   - A File-outbound target whose connector is not installed fails the health check, so the
 *     run fails before provisioning anything.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { WorkflowFailedError } from '@temporalio/client';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { DomainEventType } from '../../src/infrastructure/events/event-types';
import type { DomainEvent } from '../../src/infrastructure/events/domain-event.interface';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { DeadLetterService } from '../../src/modules/dead-letter/dead-letter.service';
import { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import { CorrelationHashService } from '../../src/infrastructure/services/correlation-hash.service';
import { DEFAULT_PROVISIONING_QUEUE } from '../../src/infrastructure/temporal/task-queue.config';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import { defaultQueueTargetActivities } from '../../src/worker-default-activities';
import { IdentityActivities } from '../../src/activities/identity.activities';
import { WritebackActivities } from '../../src/activities/writeback.activities';
import { GitHubActivities } from '../../src/activities/github.activities';
import { ServiceNowActivities } from '../../src/activities/servicenow.activities';
import { NoAccountTargetActivities } from '../../src/activities/no-account-target.activities';
import { GitHubService } from '../../src/modules/connectors/github-connector/github.service';
import { GitHubClient } from '../../src/modules/connectors/github-connector/github.client';
import { ServiceNowService } from '../../src/modules/connectors/servicenow-connector/servicenow.service';
import { ServiceNowClient } from '../../src/modules/connectors/servicenow-connector/servicenow.client';
import { DiscordWebhookService } from '../../src/modules/connectors/discord-webhook-connector/discord-webhook.service';
import { DiscordWebhookClient } from '../../src/modules/connectors/discord-webhook-connector/discord-webhook.client';
import { GoogleSheetsService } from '../../src/modules/connectors/google-sheets-connector/google-sheets.service';
import { GoogleSheetsClient } from '../../src/modules/connectors/google-sheets-connector/google-sheets.client';
import { FileOutboundService } from '../../src/modules/connectors/file-outbound-connector/file-outbound.service';
import type { ConnectorConfigService } from '../../src/modules/connectors/connector-config.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { IdentityQueryService } from '../../src/modules/identity/identity-query.service';
import { IdentityMutationService } from '../../src/modules/identity/identity-mutation.service';
import { IdentityCorrelationService } from '../../src/modules/identity/identity-correlation.service';
import { IdentityUncorrelatedService } from '../../src/modules/identity/identity-uncorrelated.service';
import { IdentityProvisioningService } from '../../src/modules/identity/identity-provisioning.service';
import { IdentityOnionService } from '../../src/modules/identity/identity-onion.service';
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
import { UserEvent, UserEventSchema } from '../../src/modules/identity/schemas/user-event.schema';
import { fakeHttp } from '../../src/testing/fake-http';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

jest.mock('axios');

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/onboarding.workflow.ts');
const TENANT = 'tenant-a';
const SNOW_BASE = 'https://acme.service-now.example';
const USER_TABLE = '/api/now/table/sys_user';
const INCIDENT_TABLE = '/api/now/table/incident';
/** The policy intent: one operation for every target. */
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };

/** Mocked ServiceNow Table API: no record for the email yet; creates answer with their sys_id. */
const servicenow = fakeHttp(({ method, url }) => {
  if (method === 'GET') return { result: [] };
  if (url === USER_TABLE) return { result: { sys_id: 'abc123' } };
  if (url === INCIDENT_TABLE) return { result: { sys_id: 'inc1', number: 'INC0001' } };
  throw new Error(`unexpected ServiceNow call ${method} ${url}`);
});
/** Discord's client builds its axios instance up front; no test posts to it. */
const discord = fakeHttp(() => {
  throw new Error('unexpected Discord call');
});

describeTemporalE2E('onboarding: targets on the default queue (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let identityModel: Model<IdentityDocument>;
  let identity: IdentityActivities;
  let outDir: string;
  /** Saved connector configs (ConnectorConfigService); a missing entry is "not installed". */
  const connectorConfigs: Record<string, Record<string, unknown> | undefined> = {};
  const activeTargets = jest.fn();
  /** identity.updated as the event bus delivers it, after the payload schema. */
  const identityUpdated: DomainEvent[] = [];

  beforeAll(async () => {
    (axios.create as jest.Mock).mockImplementation((options: { baseURL?: string }) => {
      if (options.baseURL === SNOW_BASE) return servicenow.instance;
      if (options.baseURL === undefined) return discord.instance;
      throw new Error(`unexpected vendor ${options.baseURL}`);
    });

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: UserEvent.name, schema: UserEventSchema },
        ]),
      ],
      providers: [
        IdentityService,
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        ReconciliationService,
        UserEventService,
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({ rules: [{ strategy: 'email' }] }),
            getPrimaryHrSourceName: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
          },
        },
        { provide: CorrelationRuleEngine, useValue: {} },
        { provide: CorrelationHashService, useValue: { hash: () => 'h' } },
        {
          provide: LoggerFactoryService,
          useValue: {
            create: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
          },
        },
        DomainEventEmitterService,
        { provide: DeadLetterService, useValue: { capture: jest.fn() } },
        { provide: getModelToken(OutboxEvent.name), useValue: {} },
        IdentityActivities,
      ],
    })
      .useMocker(() => ({}))
      .compile();
    await moduleRef.init();
    identityModel = moduleRef.get(getModelToken(Identity.name));
    identity = moduleRef.get(IdentityActivities);

    const connectorConfig = {
      getConfig: async (id: string) =>
        connectorConfigs[id] ? { config: connectorConfigs[id] } : null,
    } as unknown as ConnectorConfigService;
    const writeback = new WritebackActivities(
      moduleRef.get(IdentityService),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      moduleRef.get(DomainEventEmitterService),
    );
    moduleRef
      .get(EventEmitter2)
      .on(DomainEventType.IDENTITY_UPDATED, (event: DomainEvent) => identityUpdated.push(event));
    const bind = <T extends object>(obj: T, name: keyof T) =>
      (obj[name] as (...args: unknown[]) => unknown).bind(obj);

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        getActiveTargetSystems: () => activeTargets(),
        getConnectorConfig: async () => null,
        getEdgeConditions: async () => null,
        getPipelineStatus: async () => 'DEPLOYED',
        recordProvisioningOutcome: async () => undefined,
        evaluateUser: async () => ({ operations: [groupOp] }),
        // No target excluded by an access review (patch onboarding:review-exclusions)
        getReviewExcludedTargets: async () => [],
        getIdentityByEmail: bind(identity, 'getIdentityByEmail'),
        getUserByEmail: bind(identity, 'getUserByEmail'),
        setProvisioningStatus: bind(identity, 'setProvisioningStatus'),
        writebackToIdentity: bind(writeback, 'writebackToIdentity'),
        writebackToHrSource: async () => ({ success: false, updatedFields: [], skippedFields: [] }),
        // What worker.ts registers on the default queue for these targets
        ...(defaultQueueTargetActivities({
          github: new GitHubActivities(
            new GitHubService(new GitHubClient(), connectorConfig),
            moduleRef.get(IdentityService),
            moduleRef.get(DomainEventEmitterService),
          ),
          serviceNow: new ServiceNowActivities(
            new ServiceNowService(new ServiceNowClient(), connectorConfig),
            moduleRef.get(DomainEventEmitterService),
          ),
          noAccountTargets: new NoAccountTargetActivities(
            new DiscordWebhookService(new DiscordWebhookClient(), connectorConfig),
            new GoogleSheetsService(new GoogleSheetsClient(), connectorConfig),
            new FileOutboundService(connectorConfig),
            moduleRef.get(DomainEventEmitterService),
          ),
        }) as Record<string, (...args: unknown[]) => unknown>),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.shutdown();
    await moduleRef?.close();
    await closeTestDb();
  }, 60_000);

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'euroid-onboarding-e2e-'));
    // File outbound writes only inside its allowed directory (file-outbound.service.ts)
    process.env.FILE_OUTBOUND_ALLOWED_DIR = outDir;
    connectorConfigs['file-outbound'] = { outputFilePath: path.join(outDir, 'joiners.jsonl') };
    connectorConfigs.servicenow = {
      instanceUrl: SNOW_BASE,
      username: 'euroid',
      password: 'secret',
    };
    servicenow.calls.length = 0;
    identityUpdated.length = 0;
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    delete process.env.FILE_OUTBOUND_ALLOWED_DIR;
  });

  /** A joiner in the Hub (from CSV HR) with no provisioning yet. */
  async function joiner(email: string) {
    return withTenantContext(TENANT, async () => {
      const doc = await identityModel.create({
        tenantId: TENANT,
        profile: { firstName: 'Ada', lastName: 'Lovelace', email, status: 'ACTIVE' },
        sources: [{ sourceName: 'csv-hr', externalId: email, rawData: { email } }],
        metadata: { version: 1 },
      });
      return String(doc._id);
    });
  }

  const onboard = (email: string, id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ targetEmail: email, tenantId: TENANT }],
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId: `t-${TENANT}-onboarding-e2e-${id}`,
    });

  const stored = (identityId: string) =>
    withTenantContext(TENANT, () => identityModel.findById(identityId).lean().exec());

  const outputLines = () => {
    const file = path.join(outDir, 'joiners.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it('writes the joiner to the File-outbound file and marks the target SYNCED', async () => {
    activeTargets.mockResolvedValue(['file-outbound']);
    const id = await joiner('ada@acme.test');

    await expect(onboard('ada@acme.test', 'file')).resolves.toContain(
      'Dynamic onboarding complete',
    );

    const lines = outputLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      user: { email: 'ada@acme.test', firstName: 'Ada', lastName: 'Lovelace' },
      intent: { operations: [groupOp] },
    });
    const doc = await stored(id);
    expect(doc?.provisioning).toEqual([
      expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
    ]);
    expect(doc?.provisioning?.[0].errorMsg).toBeUndefined();
    // No account in a file: nothing written back, the identity keeps only its HR source
    expect(doc?.sources?.map((s) => s.sourceName)).toEqual(['csv-hr']);
  }, 120_000);

  it('creates the ServiceNow user and writes back the sys_id offboarding uses', async () => {
    activeTargets.mockResolvedValue(['file-outbound', 'servicenow']);
    const id = await joiner('grace@acme.test');

    await expect(onboard('grace@acme.test', 'servicenow')).resolves.toContain(
      'Dynamic onboarding complete',
    );

    expect(servicenow.writes().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${USER_TABLE}`,
      `POST ${INCIDENT_TABLE}`,
    ]);
    expect(servicenow.writes()[0].data).toMatchObject({
      email: 'grace@acme.test',
      user_name: 'grace@acme.test',
    });
    expect(outputLines()).toHaveLength(1);

    const doc = await stored(id);
    expect(doc?.provisioning).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
        expect.objectContaining({
          targetSystem: 'servicenow',
          status: 'SYNCED',
          writebackComplete: true,
        }),
      ]),
    );
    const { targets } = await identity.getOffboardingTargets(id, TENANT);
    expect(targets).toEqual(
      expect.arrayContaining([
        { targetSystem: 'servicenow', externalId: 'snow-abc123', status: 'SYNCED' },
        { targetSystem: 'file-outbound', externalId: undefined, status: 'SYNCED' },
      ]),
    );
    // The write-back's identity.updated passed its payload schema (else the activity fails and
    // retries), at depth 1: no mover or onboarding handler starts a run for it. The payload names
    // the identity by id only: it carries no email since plan 2.0dn.
    expect(identityUpdated).toEqual([
      expect.objectContaining({
        aggregateId: id,
        payload: {
          identityId: id,
          changedFields: ['objectId'],
          source: 'writeback',
          targetSystem: 'servicenow',
        },
        metadata: expect.objectContaining({ depth: 1, tenantId: TENANT }),
      }),
    ]);
  }, 120_000);

  it('fails at the health check, provisioning nothing, when File outbound is not installed', async () => {
    activeTargets.mockResolvedValue(['file-outbound']);
    connectorConfigs['file-outbound'] = undefined;
    const id = await joiner('alan@acme.test');

    const error = await onboard('alan@acme.test', 'not-installed').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(String((error as WorkflowFailedError).cause?.message)).toContain(
      'file-outbound is unreachable',
    );
    expect(outputLines()).toEqual([]);
    expect((await stored(id))?.provisioning ?? []).toEqual([]);
  }, 120_000);
});
