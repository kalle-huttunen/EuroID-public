/**
 * Onboarding through a saved Design studio canvas, end to end on the time-skipping Temporal test
 * server and in-memory MongoDB. Opt-in via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue. Target discovery and edge conditions
 * are the real ConfigActivities reading a saved canvas (BlueprintsService.getLatestBlueprint
 * stubbed) with the real connector registry (the built-in manifests). The File-outbound and
 * ServiceNow targets are the real activities and services (a real file; a mocked ServiceNow
 * Table API that keeps the users it created), registered under the names worker.ts uses
 * (defaultQueueTargetActivities). The identity is real: getIdentityByEmail, getUserByEmail,
 * setProvisioningStatus and writebackToIdentity are the real activities on in-memory MongoDB;
 * the write-back's identity.updated goes through the real DomainEventEmitterService (its payload
 * schema). The identity.sources_changed events a write-back emits go to the real
 * SourcesChangedHandler, which starts onboarding through the real OnboardingService on this test
 * server. Policy, the pipeline guard, the HR fetch and the Hub save are stubbed.
 *
 * Proves:
 *   - A joiner onboarded through a canvas with a CSV HR source and a File-outbound target gets
 *     one JSONL line and a SYNCED File-outbound entry. The HR source is not a target: no health
 *     check or provisioning entry for csv-hr.
 *   - In an all-users run, ServiceNow's write-back does not start a second onboarding for the
 *     person: one file line, one ServiceNow incident.
 *   - A second onboarding run for the same person repeats no SYNCED target.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { temporal } from '@temporalio/proto';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventType } from '../../src/infrastructure/events/event-types';
import type { DomainEvent } from '../../src/infrastructure/events/domain-event.interface';
import {
  SourcesChangedHandler,
  type IdentitySourcesChangedPayload,
} from '../../src/infrastructure/events/handlers/sources-changed.handler';
import type { TemporalClientProvider } from '../../src/infrastructure/temporal/temporal-client.provider';
import type { AuditService } from '../../src/modules/audit/audit.service';
import { OnboardingService } from '../../src/modules/onboarding/onboarding.service';
import {
  JoinerEvent,
  JoinerEventSchema,
} from '../../src/modules/joiners/schemas/joiner-event.schema';
import { WritebackActivities } from '../../src/activities/writeback.activities';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { DeadLetterService } from '../../src/modules/dead-letter/dead-letter.service';
import { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import { CorrelationHashService } from '../../src/infrastructure/services/correlation-hash.service';
import { DEFAULT_PROVISIONING_QUEUE } from '../../src/infrastructure/temporal/task-queue.config';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import { defaultQueueTargetActivities } from '../../src/worker-default-activities';
import { ConfigActivities } from '../../src/activities/config.activities';
import { IdentityActivities } from '../../src/activities/identity.activities';
import { GitHubActivities } from '../../src/activities/github.activities';
import { ServiceNowActivities } from '../../src/activities/servicenow.activities';
import { NoAccountTargetActivities } from '../../src/activities/no-account-target.activities';
import type { BlueprintsService } from '../../src/modules/blueprints/blueprints.service';
import { PluginRegistryService } from '../../src/modules/connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../../src/modules/connectors/plugin/register-connectors';
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
/** The policy intent: one operation for every target. */
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };

const SNOW_BASE = 'https://acme.service-now.example';
const USER_TABLE = '/api/now/table/sys_user';
const INCIDENT_TABLE = '/api/now/table/incident';

/** Mocked ServiceNow Table API: a created user is found by the next lookup, as in ServiceNow. */
let snowUsers: Array<{ sys_id: string }> = [];
const servicenow = fakeHttp(({ method, url }) => {
  if (method === 'GET' && url === '/api/now/table/sys_properties') return { result: [] };
  if (method === 'GET' && url === USER_TABLE) return { result: snowUsers };
  // The open tracking incident of the event a provision retries: none here
  if (method === 'GET' && url === INCIDENT_TABLE) return { result: [] };
  if (method === 'POST' && url === USER_TABLE) {
    snowUsers = [{ sys_id: 'abc123' }];
    return { result: snowUsers[0] };
  }
  if (method === 'PATCH' && url === `${USER_TABLE}/abc123`) return { result: snowUsers[0] };
  if (method === 'POST' && url === INCIDENT_TABLE) {
    return { result: { sys_id: 'inc1', number: 'INC0001' } };
  }
  throw new Error(`unexpected ServiceNow call ${method} ${url}`);
});
/** No other vendor API is reachable: File outbound writes a local file. */
const noVendor = fakeHttp(({ method, url }) => {
  throw new Error(`unexpected vendor call ${method} ${url}`);
});

/** A canvas as the Design studio saves it: CSV HR feeds the Brain, the Brain feeds the targets. */
function canvas(targets: string[]) {
  return {
    nodes: [
      { id: 'csv-hr-source', type: 'connectorNode', data: { role: 'source', type: 'csv-hr' } },
      { id: 'euroid-core', type: 'connectorNode', data: { role: 'brain' } },
      ...targets.map((type) => ({
        id: `${type}-target`,
        type: 'connectorNode',
        data: { role: 'target', type },
      })),
    ],
    edges: [
      { id: 'hr-core', source: 'csv-hr-source', target: 'euroid-core' },
      ...targets.map((type) => ({
        id: `core-${type}`,
        source: 'euroid-core',
        target: `${type}-target`,
      })),
    ],
  };
}

describeTemporalE2E('onboarding through a saved canvas (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let identityModel: Model<IdentityDocument>;
  let outDir: string;
  let sourcesChangedHandler: SourcesChangedHandler;
  /** Saved connector configs (ConnectorConfigService); a missing entry is "not installed". */
  const connectorConfigs: Record<string, Record<string, unknown> | undefined> = {};
  let savedCanvas = canvas([]);
  /** The joiners the HR fetch of an all-users run returns. */
  const newHires: Array<Record<string, unknown>> = [];
  /** identity.sources_changed events emitted since the test started. */
  const sourcesChanged: Array<DomainEvent<IdentitySourcesChangedPayload>> = [];
  /** Workflow ids of the onboarding runs OnboardingService started. */
  const triggered: string[] = [];

  beforeAll(async () => {
    (axios.create as jest.Mock).mockImplementation((options: { baseURL?: string }) =>
      options.baseURL === SNOW_BASE ? servicenow.instance : noVendor.instance,
    );

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: UserEvent.name, schema: UserEventSchema },
          // SourcesChangedHandler reads it: no identity of these tests is an open HR joiner
          { name: JoinerEvent.name, schema: JoinerEventSchema },
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
    const identity = moduleRef.get(IdentityActivities);

    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    const config = new ConfigActivities(
      { getLatestBlueprint: async () => savedCanvas } as unknown as BlueprintsService,
      registry,
    );
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
    const bind = <T extends object>(obj: T, name: keyof T) =>
      (obj[name] as (...args: unknown[]) => unknown).bind(obj);

    moduleRef
      .get(EventEmitter2)
      .on(DomainEventType.IDENTITY_SOURCES_CHANGED, (event: DomainEvent) =>
        sourcesChanged.push(event as unknown as DomainEvent<IdentitySourcesChangedPayload>),
      );

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        getActiveTargetSystems: bind(config, 'getActiveTargetSystems'),
        getConnectorConfig: bind(config, 'getConnectorConfig'),
        getEdgeConditions: bind(config, 'getEdgeConditions'),
        getPipelineStatus: async () => 'DEPLOYED',
        recordProvisioningOutcome: async () => undefined,
        evaluateUser: async () => ({ operations: [groupOp] }),
        // No target excluded by an access review (patch onboarding:review-exclusions)
        getReviewExcludedTargets: async () => [],
        fetchNewHires: async () => newHires,
        saveToHub: async () => 'saved',
        getIdentityByEmail: bind(identity, 'getIdentityByEmail'),
        getUserByEmail: bind(identity, 'getUserByEmail'),
        setProvisioningStatus: bind(identity, 'setProvisioningStatus'),
        writebackToIdentity: bind(writeback, 'writebackToIdentity'),
        writebackToHrSource: async () => ({ success: false, updatedFields: [], skippedFields: [] }),
        // What worker.ts registers on the default queue for the targets without a queue
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
    // OnboardingService starts runs with the TenantId search attribute, as a deployment has it
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
    const onboarding = new OnboardingService(
      { logFireAndForget: jest.fn() } as unknown as AuditService,
      moduleRef.get(LoggerFactoryService),
      { getClient: () => harness.env.client } as unknown as TemporalClientProvider,
    );
    const trigger = onboarding.triggerOnboarding.bind(onboarding);
    jest.spyOn(onboarding, 'triggerOnboarding').mockImplementation(async (target, options) => {
      const workflowId = await trigger(target, options);
      triggered.push(workflowId);
      return workflowId;
    });
    sourcesChangedHandler = new SourcesChangedHandler(
      moduleRef.get(IdentityService),
      onboarding,
      moduleRef.get(getModelToken(JoinerEvent.name)),
    );
  }, 180_000);

  afterAll(async () => {
    await harness?.shutdown();
    await moduleRef?.close();
    await closeTestDb();
  }, 60_000);

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'euroid-onboarding-canvas-e2e-'));
    // File outbound writes only inside its allowed directory (file-outbound.service.ts)
    process.env.FILE_OUTBOUND_ALLOWED_DIR = outDir;
    connectorConfigs['file-outbound'] = { outputFilePath: path.join(outDir, 'joiners.jsonl') };
    connectorConfigs.servicenow = { instanceUrl: SNOW_BASE, username: 'euroid', password: 'x' };
    snowUsers = [];
    servicenow.calls.length = 0;
    sourcesChanged.length = 0;
    triggered.length = 0;
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

  it('onboards a joiner through a canvas with a CSV HR source and a File-outbound target', async () => {
    savedCanvas = canvas(['file-outbound']);
    const id = await joiner('ada@acme.test');

    await expect(
      harness.env.client.workflow.execute(onboardingWorkflow, {
        args: [{ targetEmail: 'ada@acme.test', tenantId: TENANT }],
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId: `t-${TENANT}-onboarding-canvas-e2e-file`,
      }),
    ).resolves.toContain('Dynamic onboarding complete');

    const lines = outputLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      user: { email: 'ada@acme.test', firstName: 'Ada', lastName: 'Lovelace' },
      intent: { operations: [groupOp] },
    });
    // Only the target is provisioned: the CSV HR source gets no entry
    const doc = await stored(id);
    expect(doc?.provisioning).toEqual([
      expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
    ]);
    expect(noVendor.calls).toEqual([]);
  }, 120_000);

  const incidents = () => servicenow.writes().filter((c) => c.url === INCIDENT_TABLE).length;

  /**
   * Hands the identity.sources_changed events to SourcesChangedHandler, as the event bus does,
   * and waits for every onboarding run the handler started.
   */
  async function deliverSourcesChanged() {
    for (const event of sourcesChanged.splice(0)) {
      await sourcesChangedHandler.handleSourcesChanged(event);
    }
    for (const workflowId of triggered) {
      await harness.env.client.workflow.getHandle(workflowId).result();
    }
  }

  it('starts no second onboarding for a person whose account the run writes back', async () => {
    savedCanvas = canvas(['servicenow', 'file-outbound']);
    const id = await joiner('grace@acme.test');

    await expect(
      harness.env.client.workflow.execute(onboardingWorkflow, {
        args: [{ targetEmail: 'grace@acme.test', tenantId: TENANT }],
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId: `t-${TENANT}-onboard-${id}`,
      }),
    ).resolves.toContain('Dynamic onboarding complete for grace@acme.test');

    // ServiceNow's write-back added the account to the identity as a new source
    expect(sourcesChanged.map((event) => event.payload.newSourceName)).toEqual(['servicenow']);
    await deliverSourcesChanged();

    expect({ lines: outputLines().length, incidents: incidents() }).toEqual({
      lines: 1,
      incidents: 1,
    });
    expect(triggered).toEqual([]);
    const doc = await stored(id);
    expect(doc?.provisioning).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetSystem: 'servicenow', status: 'SYNCED' }),
        expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
      ]),
    );
  }, 120_000);

  it('repeats no SYNCED target when the same person is onboarded again', async () => {
    savedCanvas = canvas(['servicenow', 'file-outbound']);
    const id = await joiner('alan@acme.test');
    // E.g. an operator presses Provision twice for the same person
    const onboard = (run: number) =>
      harness.env.client.workflow.execute(onboardingWorkflow, {
        args: [{ targetEmail: 'alan@acme.test', tenantId: TENANT }],
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId: `t-${TENANT}-onboarding-canvas-e2e-repeat-${run}`,
      });

    await expect(onboard(1)).resolves.toContain('Dynamic onboarding complete');
    await expect(onboard(2)).resolves.toContain('Dynamic onboarding complete');

    expect({ lines: outputLines().length, incidents: incidents() }).toEqual({
      lines: 1,
      incidents: 1,
    });
    expect(servicenow.writes().filter((c) => c.url.startsWith(USER_TABLE))).toHaveLength(1);
    const doc = await stored(id);
    expect(doc?.provisioning).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetSystem: 'servicenow', status: 'SYNCED' }),
        expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
      ]),
    );
  }, 120_000);
});
