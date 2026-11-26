/**
 * The joiner, mover, leaver story end to end, in one tenant, on the time-skipping Temporal test
 * server and in-memory MongoDB. Opt-in via TEMPORAL_E2E=1 (the pre-push hook runs it).
 *
 * Composition: the app's own Nest modules (identity, policy, connectors, onboarding, offboarding,
 * leavers, mover, access review, audit, events and their globals) as a Nest application without a
 * port, on in-memory MongoDB, with the env file ignored and no Redis, Neo4j, OPA, SMTP or Entra
 * configured. The Temporal client is the test server's; Elasticsearch is the real service left in
 * its fail-open mode (no connection attempt). One worker on the default queue runs every workflow with the activity
 * map worker.ts registers there (buildDefaultActivities over the app's activity classes); the
 * story touches no connector queue. Nothing else is mocked: the CSV HR connector reads files the
 * test writes, the File outbound connector appends to a file in a directory the test owns.
 *
 * Trigger paths (the ones a deployment uses):
 *   - HR data arrives by the scheduled sync: scheduledSyncWorkflow -> runScheduledSync ->
 *     SyncSchedulerService -> HrIngestionService (CSV HR) -> correlation -> HR_SYNC_COMPLETED
 *     (leaver detection) -> HR_SYNC_MOVERS_REQUESTED (HR mover detection) ->
 *     HR_SYNC_JOINERS_REQUESTED (HR joiner detection).
 *   - Joiner: the HR sync records the identities it minted as joiners and onboards them through
 *     IDENTITY_PROVISION_REQUESTED (OnboardingService.triggerOnboarding, one run per joiner) once
 *     the pipeline is deployed: the first import waits for Deploy, then, three joiners being
 *     above the mass-joiner allowance of 2, for an admin's approval of its batch. A later new
 *     hire under the allowance is onboarded by the sync itself (stage 5).
 *   - Mover: the HR-driven mover detection of the next full sync (trigger hr-sync).
 *   - Review: a campaign created and activated by an admin (AccessReviewService), decided by the
 *     default reviewer (ACCESS_REVIEW_DEFAULT_REVIEWER: the HR feed has no managers), closed by
 *     its workflow once nothing is pending, which then removes what was revoked.
 *   - Leaver: the HR status word "Terminated" (signal terminated, effective at once), detected by
 *     the sync and offboarded through IDENTITY_OFFBOARD_REQUESTED.
 *   - Rehire: the deleted leaver active again in HR with a start date after the deletion; the
 *     sync revives the identity and onboards it as a joiner (stage 6).
 *
 * Proves, stage by stage, what an evaluator looks for: see each `it`.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import * as winston from 'winston';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Connection } from 'mongoose';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporal } from '@temporalio/proto';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { authConfig } from '../../src/infrastructure/config/auth.config';
import { encryptionConfig } from '../../src/infrastructure/config/encryption.config';
import { eventsConfig } from '../../src/infrastructure/config/events.config';
import { appConfig } from '../../src/infrastructure/config/app.config';
import { elasticsearchConfig } from '../../src/infrastructure/config/elasticsearch.config';
import { opaConfig } from '../../src/infrastructure/config/opa.config';
import { eventSubscriptionsConfig } from '../../src/infrastructure/config/event-subscriptions.config';
import { ObservabilityModule } from '../../src/infrastructure/observability/observability.module';
import { EventsModule } from '../../src/infrastructure/events/events.module';
import { RedisModule } from '../../src/infrastructure/cache/redis.module';
import { ResilienceModule } from '../../src/infrastructure/resilience/resilience.module';
import { AuthModule } from '../../src/infrastructure/auth/auth.module';
import { SecretsModule } from '../../src/infrastructure/secrets/secrets.module';
import { CommonModule } from '../../src/infrastructure/common.module';
import { TenantModule } from '../../src/infrastructure/multi-tenancy/tenant.module';
import { TemporalModule } from '../../src/infrastructure/temporal/temporal.module';
import { TemporalClientProvider } from '../../src/infrastructure/temporal/temporal-client.provider';
import { GraphModule } from '../../src/infrastructure/graph/graph.module';
import { ElasticsearchModule } from '../../src/infrastructure/elasticsearch/elasticsearch.module';
import { ElasticsearchService } from '../../src/infrastructure/elasticsearch/elasticsearch.service';
import { OpaModule } from '../../src/infrastructure/opa/opa.module';
import { DEFAULT_PROVISIONING_QUEUE } from '../../src/infrastructure/temporal/task-queue.config';
import { DomainEventType } from '../../src/infrastructure/events/event-types';
import type { DomainEvent } from '../../src/infrastructure/events/domain-event.interface';
import { RateLimitActivityInterceptor } from '../../src/infrastructure/temporal/rate-limit-activity.interceptor';
import { CorrelationConfigModule } from '../../src/modules/correlation-config/correlation-config.module';
import { BlueprintsModule } from '../../src/modules/blueprints/blueprints.module';
import { BlueprintsService } from '../../src/modules/blueprints/blueprints.service';
import { PipelineService } from '../../src/modules/blueprints/pipeline.service';
import { ImpactAnalysisService } from '../../src/modules/blueprints/impact-analysis.service';
import { IdentityModule } from '../../src/modules/identity/identity.module';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { OffboardingModule } from '../../src/modules/offboarding/offboarding.module';
import { LeaversModule } from '../../src/modules/leavers/leavers.module';
import { JoinersModule } from '../../src/modules/joiners/joiners.module';
import { JoinerBatchService } from '../../src/modules/joiners/joiner-batch.service';
import { PolicyModule } from '../../src/modules/policy/policy.module';
import { PolicyService } from '../../src/modules/policy/policy.service';
import { EntitlementCatalogModule } from '../../src/modules/entitlement-catalog/entitlement-catalog.module';
import { AuditModule } from '../../src/modules/audit/audit.module';
import { PluginRegistryModule } from '../../src/modules/connectors/plugin/plugin-registry.module';
import { ConnectorConfigModule } from '../../src/modules/connectors/connector-config.module';
import { ConnectorConfigService } from '../../src/modules/connectors/connector-config.service';
import {
  HrIngestionService,
  IngestResult,
} from '../../src/modules/connectors/hr-ingestion.service';
import { DevToolsModule } from '../../src/modules/dev-tools/dev-tools.module';
import { RoleBundlesModule } from '../../src/modules/role-bundles/role-bundles.module';
import { DeadLetterModule } from '../../src/modules/dead-letter/dead-letter.module';
import { AccessReviewModule } from '../../src/modules/access-review/access-review.module';
import { AccessReviewService } from '../../src/modules/access-review/access-review.service';
import { MoverModule } from '../../src/modules/mover/mover.module';
import { AccessReevaluationService } from '../../src/modules/mover/access-reevaluation.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { PolicyEngineService } from '../../src/modules/policy/policy-engine.service';
import { ReviewExclusionService } from '../../src/modules/policy/review-exclusion.service';
import type { StandardUserDto } from '../../src/shared/dtos/standard-user.dto';
import { ActivitiesModule } from '../../src/activities/activities.module';
import { buildDefaultActivities } from '../../src/worker-default-activities';
import { HrActivities } from '../../src/activities/hr.activities';
import { IdentityActivities } from '../../src/activities/identity.activities';
import { EntraActivities } from '../../src/activities/entra.activities';
import { BulkProvisioningActivities } from '../../src/activities/bulk-provisioning.activities';
import { RateLimiterActivities } from '../../src/activities/rate-limiter.activities';
import { DistributedTransactionActivities } from '../../src/activities/distributed-transaction.activities';
import { ReconciliationActivities } from '../../src/activities/reconciliation.activities';
import { PolicyActivities } from '../../src/activities/policy.activities';
import { ConfigActivities } from '../../src/activities/config.activities';
import { AccessReviewActivities } from '../../src/activities/access-review.activities';
import { AccessReviewRevocationActivities } from '../../src/activities/access-review-revocation.activities';
import { WritebackActivities } from '../../src/activities/writeback.activities';
import { PipelineActivities } from '../../src/activities/pipeline.activities';
import { ScheduledSyncActivities } from '../../src/activities/scheduled-sync.activities';
import { ArchivalActivities } from '../../src/activities/archival.activities';
import { EntitlementExpiryActivities } from '../../src/activities/entitlement-expiry.activities';
import { PrivilegedAccessActivities } from '../../src/activities/privileged-access.activities';
import { AccessRequestActivities } from '../../src/activities/access-request.activities';
import { RiskScoreActivities } from '../../src/activities/risk-score.activities';
import { RecertificationActivities } from '../../src/activities/recertification.activities';
import { OrphanActivities } from '../../src/activities/orphan.activities';
import { IntelligenceActivities } from '../../src/activities/intelligence.activities';
import { AuditArchiveActivities } from '../../src/activities/audit-archive.activities';
import { CredentialActivities } from '../../src/activities/credential.activities';
import { MoverActivities } from '../../src/activities/mover.activities';
import { CredentialRotationActivities } from '../../src/activities/credential-rotation.activities';
import { GitHubActivities } from '../../src/activities/github.activities';
import { ServiceNowActivities } from '../../src/activities/servicenow.activities';
import { OffboardingActivities } from '../../src/activities/offboarding.activities';
import { NoAccountTargetActivities } from '../../src/activities/no-account-target.activities';
import { scheduledSyncWorkflow } from '../../src/workflows/scheduled-sync.workflow';
import {
  createTestWorkflowEnvironment,
  createWorkflowTestHarness,
  describeTemporalE2E,
} from '../helpers/workflow-test-env';
import type { WorkflowTestHarness } from '../helpers/workflow-test-env';

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const TENANT = 'tenant-jml';
const DAY = 24 * 60 * 60 * 1000;
/** Reviews items of identities without a manager (no manager column in this HR feed). */
const REVIEWER = 'reviewer@acme.test';

/** Environment the app reads; anything that would reach a real service is blanked. */
const HERMETIC_ENV: Record<string, string | undefined> = {
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  REDIS_URL: undefined,
  NEO4J_PASSWORD: undefined,
  SMTP_HOST: undefined,
  OPA_ENABLED: undefined,
  KMS_PROVIDER: undefined,
  ENTRA_TENANT_ID: undefined,
  ENTRA_CLIENT_ID: undefined,
  ENTRA_CLIENT_SECRET: undefined,
  AUDIT_ARCHIVE_ENABLED: undefined,
  ACCESS_REVIEW_DEFAULT_REVIEWER: REVIEWER,
};

interface Person {
  id: string;
  first: string;
  last: string;
  title: string;
  department: string;
  location: string;
  status?: string;
  /** The Start Date cell (empty when unset). */
  startDate?: string;
}

const ada: Person = {
  id: 'E100',
  first: 'Ada',
  last: 'Lovelace',
  title: 'Engineer',
  department: 'Engineering',
  location: 'Helsinki',
};
const grace: Person = {
  id: 'E101',
  first: 'Grace',
  last: 'Hopper',
  title: 'Engineer',
  department: 'Engineering',
  location: 'Helsinki',
};
const alan: Person = {
  id: 'E102',
  first: 'Alan',
  last: 'Turing',
  title: 'Account Executive',
  department: 'Sales',
  location: 'Espoo',
};
/** A new hire of stage 5. */
const linus: Person = {
  id: 'E103',
  first: 'Linus',
  last: 'Torvalds',
  title: 'Engineer',
  department: 'Engineering',
  location: 'Helsinki',
};
const emailOf = (p: Person) => `${p.first}.${p.last}@acme.test`.toLowerCase();

/** An HR export in the CSV HR connector's default columns. */
function hrExport(people: Person[]): string {
  const header =
    'EmpID,First Name,Last Name,Email,Job Title,Department,Employment Type,Location,Status,' +
    'Start Date';
  const rows = people.map((p) =>
    [
      p.id,
      p.first,
      p.last,
      emailOf(p),
      p.title,
      p.department,
      'Full-time',
      p.location,
      p.status ?? 'Active',
      p.startDate ?? '',
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

/** The two active policies: what each department gets in the File outbound target. */
const ENGINEERING = 'engineering-developers';
const SALES = 'sales-team';
function departmentPolicy(name: string, department: string, group: string) {
  return {
    name,
    description: `${department} joiners get ${group}`,
    priority: 3,
    conditionGroups: [
      {
        id: 'g1',
        join: 'AND' as const,
        conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: department }],
      },
    ],
    actions: [
      {
        id: 'a1',
        type: 'assign_group',
        target: 'file-outbound',
        params: { groupName: group },
        label: `Add to ${group}`,
      },
    ],
  };
}

/** A joiner's timeline after its onboarding to File outbound (plan 2.8a). */
const JOINER_HISTORY = [
  'Created via csv-hr',
  'Onboarding started by HR sync',
  'Policy evaluated',
  'Provisioned to file-outbound',
];

/** Wait (bounded, real time) until `read` returns something `done` accepts. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !done(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

describeTemporalE2E('Joiner, mover and leaver, end to end (e2e)', () => {
  let env: TestWorkflowEnvironment;
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let db: Connection;
  let csvDir: string;
  let outDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  /** Every domain event the app emitted, in order. */
  const events: DomainEvent[] = [];
  /** Workflows the app started (the test starts the syncs, which are not listed). */
  const started: Array<{ workflowId: string; type: string }> = [];
  /** What each HR ingest answered (leaver and mover summaries included). */
  const ingests: IngestResult[] = [];
  const ids: Record<string, string> = {};
  /** OnboardingService's deterministic workflow id for the person: by identity id (plan 2.0dn). */
  const onboardingId = (p: Person) => `t-${TENANT}-onboard-${ids[p.id]}`;

  const outputFile = () => path.join(outDir, 'provisioning.jsonl');
  const fileLines = () =>
    fs.existsSync(outputFile())
      ? fs
          .readFileSync(outputFile(), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];

  const asTenant = <T>(fn: () => Promise<T>, actor?: string) =>
    withTenantContext(TENANT, fn, actor ? { actor } : undefined) as Promise<T>;

  const identityDoc = (email: string) =>
    db.collection('identities').findOne({ tenantId: TENANT, 'profile.email': email });

  const timeline = (identityId: string) =>
    db
      .collection('user_events')
      .find({ tenantId: TENANT, userId: identityId })
      .sort({ timestamp: 1, _id: 1 })
      .toArray();

  const audit = (filter: Record<string, unknown>) =>
    db
      .collection('audit_events')
      .find({ tenantId: TENANT, ...filter })
      .toArray();

  const workflowsStartedSince = (mark: number) => started.slice(mark).map((s) => s.type);

  /** No event handler failed and no event was refused by its payload schema (the DLQ is empty). */
  async function expectNoDeadLetters(): Promise<void> {
    const entries = await db.collection('dead_letter').find({}).toArray();
    expect(
      entries.map((e) => `${e.type} ${e.source} ${e.handler ?? ''}: ${e.error?.message}`),
    ).toEqual([]);
  }

  async function runHrSync(people: Person[]): Promise<IngestResult> {
    fs.writeFileSync(path.join(csvDir, 'employees.csv'), hrExport(people));
    const before = ingests.length;
    const result = await env.client.workflow.execute(scheduledSyncWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId: `sync-${TENANT}-csv-hr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [{ tenantId: TENANT, connectorName: 'csv-hr' }],
      searchAttributes: { TenantId: [TENANT] },
    });
    expect(result).toEqual(expect.objectContaining({ success: true, type: 'ingest' }));
    expect(ingests).toHaveLength(before + 1);
    return ingests[before];
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jml-e2e-hr-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jml-e2e-out-'));
    const mongoUri = testDbUri();
    const testEnv = {
      ...HERMETIC_ENV,
      MONGO_URI: mongoUri,
      CSV_HR_ALLOWED_DIR: csvDir,
      FILE_OUTBOUND_ALLOWED_DIR: outDir,
    };
    for (const [key, value] of Object.entries(testEnv)) {
      savedEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    env = await createTestWorkflowEnvironment();
    await env.connection.operatorService.addSearchAttributes({
      namespace: env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
    const start = env.client.workflow.start.bind(env.client.workflow);
    jest.spyOn(env.client.workflow, 'start').mockImplementation((async (
      workflow: unknown,
      options: { workflowId: string },
    ) => {
      const type = typeof workflow === 'string' ? workflow : (workflow as { name: string }).name;
      started.push({ workflowId: options.workflowId, type });
      return start(workflow as never, options as never);
    }) as never);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            authConfig,
            encryptionConfig,
            eventsConfig,
            appConfig,
            eventSubscriptionsConfig,
            elasticsearchConfig,
            opaConfig,
          ],
        }),
        ObservabilityModule,
        EventsModule,
        RedisModule,
        ResilienceModule,
        AuthModule,
        SecretsModule,
        CommonModule,
        MongooseModule.forRoot(mongoUri),
        TenantModule,
        TemporalModule,
        CorrelationConfigModule,
        BlueprintsModule,
        IdentityModule,
        OnboardingModule,
        OffboardingModule,
        LeaversModule,
        PolicyModule,
        EntitlementCatalogModule,
        AuditModule,
        PluginRegistryModule,
        ConnectorConfigModule,
        ActivitiesModule,
        DevToolsModule,
        RoleBundlesModule,
        DeadLetterModule,
        AccessReviewModule,
        MoverModule,
        JoinersModule,
        GraphModule,
        ElasticsearchModule,
        OpaModule,
      ],
    })
      .overrideProvider(TemporalClientProvider)
      .useValue({ getClient: () => env.client, isConnected: () => true })
      // The real service in its fail-open mode, without the connection attempt
      .overrideProvider(ElasticsearchService)
      .useFactory({
        factory: (config: ConfigService) =>
          Object.assign(new ElasticsearchService(config), { onModuleInit: async () => undefined }),
        inject: [ConfigService],
      })
      .overrideProvider(WINSTON_MODULE_PROVIDER)
      .useValue(
        winston.createLogger({ level: 'error', transports: [new winston.transports.Console()] }),
      )
      .compile();
    // An application, not only the module: as in main.ts, the WebSocket gateway that relays
    // domain events to the UI gets its server (no port is opened)
    app = moduleRef.createNestApplication();
    await app.init();
    db = moduleRef.get<Connection>(getConnectionToken());
    moduleRef.get(EventEmitter2).onAny((_type: string | string[], event: unknown) => {
      if (event && typeof event === 'object' && 'eventId' in event)
        events.push(event as DomainEvent);
    });
    const ingestion = moduleRef.get(HrIngestionService);
    const ingest = ingestion.ingestFromConnector.bind(ingestion);
    jest.spyOn(ingestion, 'ingestFromConnector').mockImplementation(async (...args) => {
      const result = await ingest(...args);
      ingests.push(result);
      return result;
    });

    // The default queue's worker, as worker.ts registers it
    const get = <T>(cls: new (...args: never[]) => T): T => moduleRef.get(cls, { strict: false });
    harness = await createWorkflowTestHarness({
      env,
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activityInterceptors: [() => ({ inbound: new RateLimitActivityInterceptor() })],
      activities: buildDefaultActivities({
        hr: get(HrActivities),
        identity: get(IdentityActivities),
        entra: get(EntraActivities),
        bulk: get(BulkProvisioningActivities),
        rateLimiter: get(RateLimiterActivities),
        distributedTx: get(DistributedTransactionActivities),
        reconciliation: get(ReconciliationActivities),
        policy: get(PolicyActivities),
        config: get(ConfigActivities),
        accessReview: get(AccessReviewActivities),
        accessReviewRevocation: get(AccessReviewRevocationActivities),
        writeback: get(WritebackActivities),
        pipeline: get(PipelineActivities),
        scheduledSync: get(ScheduledSyncActivities),
        archival: get(ArchivalActivities),
        entitlementExpiry: get(EntitlementExpiryActivities),
        privilegedAccess: get(PrivilegedAccessActivities),
        accessRequest: get(AccessRequestActivities),
        riskScore: get(RiskScoreActivities),
        recertification: get(RecertificationActivities),
        orphan: get(OrphanActivities),
        intelligence: get(IntelligenceActivities),
        auditArchive: get(AuditArchiveActivities),
        credential: get(CredentialActivities),
        mover: get(MoverActivities),
        credentialRotation: get(CredentialRotationActivities),
        github: get(GitHubActivities),
        serviceNow: get(ServiceNowActivities),
        offboarding: get(OffboardingActivities),
        noAccountTargets: get(NoAccountTargetActivities),
      }) as Record<string, (...args: unknown[]) => unknown>,
    });

    // The tenant as an admin sets it up: connectors installed, the canvas saved, two policies
    // created by one policy admin and activated by another (SoD)
    await asTenant(async () => {
      const connectors = moduleRef.get(ConnectorConfigService);
      await connectors.install('csv-hr', { filePath: 'employees.csv' });
      await connectors.install('file-outbound', { outputFilePath: outputFile() });
      await moduleRef.get(BlueprintsService).saveBlueprint({
        nodes: [
          {
            id: 'csv-hr-source',
            type: 'source',
            position: { x: 0, y: 0 },
            // Configured on the canvas too: Deploy's readiness check reads the source node config
            data: {
              type: 'csv-hr',
              role: 'source',
              label: 'CSV HR',
              config: { filePath: 'employees.csv' },
            },
          },
          { id: 'hub', type: 'hub', position: { x: 200, y: 0 }, data: { label: 'EuroID' } },
          {
            id: 'file-outbound-target',
            type: 'target',
            position: { x: 400, y: 0 },
            data: { type: 'file-outbound', role: 'target', label: 'File outbound' },
          },
        ],
        edges: [
          { id: 'e1', source: 'csv-hr-source', target: 'hub' },
          { id: 'e2', source: 'hub', target: 'file-outbound-target' },
        ],
      });
      const policies = moduleRef.get(PolicyService);
      for (const [name, department, group] of [
        ['Engineering access', 'Engineering', ENGINEERING],
        ['Sales access', 'Sales', SALES],
      ]) {
        const policy = await policies.create(
          departmentPolicy(name, department, group),
          'policy.author@acme.test',
        );
        await policies.activate(String(policy._id), 'policy.reviewer@acme.test');
      }
    }, 'admin@acme.test');
  }, 300_000);

  afterAll(async () => {
    await (harness ? harness.shutdown() : env?.teardown());
    await app?.close();
    await closeTestDb();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [csvDir, outDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('1. joiner: the first HR import waits for Deploy and an approval, then onboarding delivers each to File outbound', async () => {
    const mark = started.length;
    const first = await runHrSync([ada, grace, alan]);

    // HR ingestion and correlation: three new Golden Records, nothing left by leaver or mover.
    // The pipeline is not deployed yet: the three are recorded as joiners and wait.
    expect(first).toEqual(
      expect.objectContaining({
        ingested: 3,
        errors: [],
        leavers: expect.objectContaining({ fullSync: true, detected: 0, started: 0 }),
        movers: expect.objectContaining({ fullSync: true, detected: 0, started: 0 }),
        joiners: expect.objectContaining({
          fullSync: true,
          detected: 3,
          started: 0,
          pending: 0,
          waiting: 3,
          pipelineStatus: 'DRAFT',
        }),
      }),
    );
    for (const person of [ada, grace, alan]) {
      const doc = await identityDoc(emailOf(person));
      expect(doc).toEqual(
        expect.objectContaining({
          profile: expect.objectContaining({
            firstName: person.first,
            lastName: person.last,
            departmentName: person.department,
            jobTitle: person.title,
            status: 'ACTIVE',
            employmentType: 'FULL_TIME',
          }),
          sources: [
            expect.objectContaining({
              sourceName: 'csv-hr',
              externalId: person.id,
              sourceRole: 'primary-hr',
            }),
          ],
          provisioning: [],
        }),
      );
      expect(doc!.deletedAt ?? null).toBeNull();
      ids[person.id] = String(doc!._id);
    }
    expect(workflowsStartedSince(mark)).toEqual([]);

    // The admin runs the impact analysis over the imported people and deploys. Deploy itself
    // starts no workflow.
    const pipeline = moduleRef.get(PipelineService);
    await asTenant(async () => {
      const analysis = await moduleRef.get(ImpactAnalysisService).computeDeltas(TENANT, {});
      await pipeline.recordSimulation(TENANT, analysis.risk.overallRisk);
    }, 'admin@acme.test');
    // The readiness check reads the canvas through BlueprintsService's 5 s cache, which the
    // analysis filled and recordSimulation does not clear: it passes once the cache has expired
    const readiness = await eventually(
      () => asTenant(() => pipeline.runReadinessCheck(TENANT)),
      (r) => r.ready,
    );
    expect(readiness.checks.filter((c) => c.status === 'fail')).toEqual([]);
    // A first import creates every person (100 % affected), so the analysis is critical and
    // Deploy refuses until the admin confirms it
    expect(readiness.checks.filter((c) => c.acknowledgementRequired)).toEqual([
      expect.objectContaining({ name: 'Impact Analysis' }),
    ]);
    await expect(
      asTenant(() => pipeline.deploy(TENANT, 'admin@acme.test'), 'admin@acme.test'),
    ).rejects.toMatchObject({ status: 422 });
    expect(await pipeline.getPipelineStatus(TENANT)).toBe('SIMULATED');
    await asTenant(
      () => pipeline.deploy(TENANT, 'admin@acme.test', { acknowledgeCriticalRisk: true }),
      'admin@acme.test',
    );
    expect(await pipeline.getPipelineStatus(TENANT)).toBe('DEPLOYED');
    expect(workflowsStartedSince(mark)).toEqual([]);

    // The first full sync after Deploy picks the joiners up. Three active identities allow
    // max(2, min(10, 5 % of 3)) = 2 onboarding runs per sync: the import waits for a person.
    const second = await runHrSync([ada, grace, alan]);
    expect(second.joiners).toEqual(
      expect.objectContaining({
        detected: 0,
        started: 0,
        pending: 3,
        waiting: 0,
        pipelineStatus: 'DEPLOYED',
        pausedBatchId: expect.any(String),
      }),
    );
    expect(workflowsStartedSince(mark)).toEqual([]);
    const joinerBatches = moduleRef.get(JoinerBatchService);
    const [batch] = await asTenant(() => joinerBatches.list('pending'));
    expect(batch).toEqual(
      expect.objectContaining({
        id: second.joiners!.pausedBatchId,
        sourceName: 'csv-hr',
        identityCount: 3,
        allowance: 2,
        activeIdentityCount: 3,
      }),
    );
    expect(batch.items.map((i) => i.email).sort()).toEqual([ada, grace, alan].map(emailOf).sort());

    // The admin approves: one onboarding run per joiner, through the existing onboarding path
    const approved = await asTenant(
      () => joinerBatches.approve(batch.id, 'admin@acme.test', 'First import checked'),
      'admin@acme.test',
    );
    expect(approved).toEqual(expect.objectContaining({ status: 'approved' }));
    // The onboardings start after the approval answered; the run records startedCount last
    let startedCount: number | undefined;
    for (let i = 0; i < 200 && startedCount === undefined; i++) {
      const decided = await asTenant(() => joinerBatches.list('approved'));
      startedCount = decided.find((b) => b.id === batch.id)?.startedCount;
      if (startedCount === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(startedCount).toBe(3);
    for (const person of [ada, grace, alan]) {
      const workflowId = onboardingId(person);
      const handle = env.client.workflow.getHandle(workflowId);
      await expect(handle.result()).resolves.toBe(
        `Dynamic onboarding complete for ${emailOf(person)}.`,
      );
      // The trigger memo names the HR sync; the workflow input is unchanged
      expect((await handle.describe()).memo).toEqual(
        expect.objectContaining({ reason: 'joiner:hr-sync:csv-hr' }),
      );
    }

    // File outbound: one line per joiner with the record and the policy's intent
    const lines = fileLines();
    expect(lines).toHaveLength(3);
    for (const person of [ada, grace, alan]) {
      const group = person.department === 'Engineering' ? ENGINEERING : SALES;
      const line = lines.find((l) => (l.user as { email: string }).email === emailOf(person));
      expect(line).toEqual({
        timestamp: expect.any(String),
        user: {
          email: emailOf(person),
          firstName: person.first,
          lastName: person.last,
          jobTitle: person.title,
          departmentName: person.department,
        },
        intent: {
          operations: [
            expect.objectContaining({
              type: 'group',
              action: 'add',
              target: 'file-outbound',
              targetId: group,
              sourcePolicy: `${person.department} access`,
            }),
          ],
        },
      });
    }

    for (const person of [ada, grace, alan]) {
      const doc = await identityDoc(emailOf(person));
      // SYNCED with the write-back complete: a target that keeps no account has nothing to write
      // back, so the identity keeps only its HR source and no identity.updated goes out
      expect(doc!.provisioning).toEqual([
        expect.objectContaining({
          targetSystem: 'file-outbound',
          status: 'SYNCED',
          writebackComplete: true,
        }),
      ]);
      expect(doc!.provisioning[0].errorMsg).toBeUndefined();
      expect(doc!.sources.map((s: { sourceName: string }) => s.sourceName)).toEqual(['csv-hr']);
      // The profile access was applied with, for the mover and the access preview
      expect(doc!.accessBaseline).toEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            departmentName: person.department,
            jobTitle: person.title,
            location: person.location,
          }),
        }),
      );
    }
    expect(events.filter((e) => e.type === DomainEventType.IDENTITY_UPDATED)).toEqual([]);
    // Each joiner's own run, nothing else (no second onboarding, no mover)
    expect(workflowsStartedSince(mark)).toEqual([
      'onboardingWorkflow',
      'onboardingWorkflow',
      'onboardingWorkflow',
    ]);

    // Timeline, the joiner's history (plan 2.8a): created by the first sync, the start by the
    // approving admin, then the run's policy evaluation and the record File outbound got
    for (const person of [ada, grace, alan]) {
      const entries = await eventually(
        () => timeline(ids[person.id]),
        (list) => list.length >= JOINER_HISTORY.length,
      );
      expect(entries.map((e) => e.title).sort()).toEqual([...JOINER_HISTORY].sort());
      expect(entries[0]).toEqual(
        expect.objectContaining({ title: 'Created via csv-hr', type: 'USER_CREATED' }),
      );
      const entry = (title: string) => entries.find((e) => e.title === title);
      expect(entry('Onboarding started by HR sync')).toEqual(
        expect.objectContaining({
          description: 'New in the csv-hr sync (mass-joiner batch approved).',
          actor: 'admin@acme.test',
        }),
      );
      expect(entry('Policy evaluated')).toEqual(
        expect.objectContaining({
          type: 'POLICY_EVALUATED',
          description: `Matched: ${person.department} access. 1 operation.`,
        }),
      );
      expect(entry('Provisioned to file-outbound')).toEqual(
        expect.objectContaining({
          type: 'USER_PROVISIONED',
          description: 'no account: line appended to the outbound file',
          targetSystem: 'file-outbound',
        }),
      );
    }
    // The same history in the audit log, under the identity id: no email as an id or in a payload
    for (const person of [ada, grace, alan]) {
      for (const action of ['identity.created', 'policy.evaluated', 'provisioning.completed']) {
        const audited = await eventually(
          () => audit({ action, resourceId: ids[person.id] }),
          (list) => list.length > 0,
        );
        expect(audited.length).toBeGreaterThan(0);
        expect(JSON.stringify(audited)).not.toContain(emailOf(person));
      }
    }
    expect(await audit({ resourceId: { $in: [ada, grace, alan].map(emailOf) } })).toEqual([]);

    // Audit: the two syncs, the joiner batch and its decision, each onboarding start
    const audited = async (action: string, count: number) =>
      eventually(
        () => audit({ action }),
        (list) => list.length >= count,
      );
    expect(await audited('connector.hr_sync_completed', 2)).toHaveLength(2);
    expect(await audited('connector.hr_sync_joiners_requested', 2)).toHaveLength(2);
    expect(await audited('joiner.batch_paused', 1)).toHaveLength(1);
    expect(await audited('joiner.batch_approved', 1)).toEqual([
      expect.objectContaining({ actor: 'admin@acme.test' }),
    ]);
    for (const person of [ada, grace, alan]) {
      expect(
        await audit({ action: 'identity.joiner_onboarding_started', resourceId: ids[person.id] }),
      ).toEqual([expect.objectContaining({ actor: 'admin@acme.test' })]);
    }
    const onboardingAudit = await audit({ action: 'PROVISIONING_EXECUTED' });
    expect(onboardingAudit.map((a) => a.resourceId).sort()).toEqual(
      [ada, grace, alan].map(onboardingId).sort(),
    );

    // The same export again: nothing new starts
    const again = started.length;
    const repeat = await runHrSync([ada, grace, alan]);
    expect(repeat.joiners).toEqual(
      expect.objectContaining({ detected: 0, started: 0, pending: 0, waiting: 0, closed: 0 }),
    );
    expect(workflowsStartedSince(again)).toEqual([]);
    expect(fileLines()).toHaveLength(3);
    await expectNoDeadLetters();
  }, 180_000);

  it('2. mover: a department change in the next HR export moves the access', async () => {
    const mark = started.length;
    const moved: Person = { ...ada, department: 'Sales' };
    const sync = await runHrSync([moved, grace, alan]);

    expect(sync.movers).toEqual(
      expect.objectContaining({ fullSync: true, detected: 1, started: 1, withoutBaseline: 0 }),
    );
    expect(sync.leavers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(sync.joiners).toEqual(expect.objectContaining({ detected: 0, started: 0, pending: 0 }));
    const moverId = `t-${TENANT}-mover-${ids[ada.id]}`;
    expect(started.slice(mark)).toEqual([{ workflowId: moverId, type: 'moverWorkflow' }]);
    await expect(env.client.workflow.getHandle(moverId).result()).resolves.toContain(
      'Mover complete',
    );

    // The outcome, as published for the timeline: the mover changes Entra ID, AD, Okta and SCIM
    // only, so File outbound is reported "not updated", with the policy delta it did not apply
    const completed = events.find((e) => e.type === DomainEventType.MOVER_COMPLETED);
    expect(completed?.payload).toEqual(
      expect.objectContaining({
        identityId: ids[ada.id],
        trigger: 'hr-sync',
        status: 'completed',
        changedFields: ['departmentName'],
        added: 1,
        removed: 1,
        systems: [
          {
            system: 'file-outbound',
            outcome: 'not-supported',
            added: [SALES],
            removed: [ENGINEERING],
            reason: 'The mover updates Entra ID, Active Directory, Okta and SCIM only.',
          },
        ],
      }),
    );
    const entries = await eventually(
      () => timeline(ids[ada.id]),
      (list) => list.some((e) => e.title === 'Access change completed'),
    );
    // The joiner history of stage 1, then the move's own entries (the mover evaluates a policy
    // profile read by id, which carries no identity id: no "Policy evaluated" entry)
    const joinerPart = entries.slice(0, JOINER_HISTORY.length);
    expect(joinerPart.map((e) => e.title).sort()).toEqual([...JOINER_HISTORY].sort());
    const moverPart = entries.slice(JOINER_HISTORY.length);
    expect(moverPart.map((e) => e.title)).toEqual([
      'Access change started by HR sync',
      'Not updated by the mover: file-outbound',
      'Access change completed',
    ]);
    expect(moverPart[0]).toEqual(
      expect.objectContaining({ description: 'Changed: departmentName', actor: 'system:hr-sync' }),
    );

    // The baseline advanced to the new department; File outbound got nothing new
    const doc = await identityDoc(emailOf(ada));
    expect(doc!.profile.departmentName).toBe('Sales');
    expect(doc!.accessBaseline.attributes).toEqual(
      expect.objectContaining({ departmentName: 'Sales' }),
    );
    expect(fileLines()).toHaveLength(3);

    // What the active policies give Ada now: the Sales group only
    const policyNow = await asTenant(async () => {
      const identities = moduleRef.get(IdentityService);
      const identity = await identities.findIdentityById(ids[ada.id]);
      const profile = await identities.buildProfileWithContractsForPolicy(identity!);
      return moduleRef
        .get(PolicyEngineService)
        .evaluateOperationsWithoutSod(profile as unknown as StandardUserDto, TENANT);
    });
    expect(policyNow.map((op) => op.targetId)).toEqual([SALES]);
    // and the access preview: nothing pending, since the run advanced the baseline
    const preview = await asTenant(() =>
      moduleRef.get(AccessReevaluationService).preview(ids[ada.id]),
    );
    expect(preview).toEqual(
      expect.objectContaining({
        changes: [],
        toAdd: [],
        toRemove: [],
        provisionedTargets: ['file-outbound'],
        canReevaluate: true,
      }),
    );
    for (const action of ['mover.started', 'mover.completed']) {
      expect(await audit({ action, resourceId: ids[ada.id] })).toHaveLength(1);
    }
    // The other two, unchanged in HR, were not moved
    expect(events.filter((e) => e.type === DomainEventType.MOVER_STARTED)).toHaveLength(1);
    await expectNoDeadLetters();
  }, 120_000);

  // A campaign cannot read memberships in File outbound, so the review item is each identity's
  // account there (plan 2.8b). Revoking one removes it at campaign close through offboarding's
  // per-target deprovision, which has nothing to remove in a target that keeps no account: the
  // outcome is "already gone" and the provisioning entry is closed, as entitlement expiry does.
  it('3. review: a campaign over File outbound reviews each account, and a revoked one is closed', async () => {
    const reviews = moduleRef.get(AccessReviewService);
    const campaign = await asTenant(
      () =>
        reviews.createCampaign(
          {
            name: 'Q4 File outbound review',
            scope: { type: 'system', value: 'file-outbound' },
            deadline: new Date(Date.now() + 7 * DAY),
          },
          'review.admin@acme.test',
        ),
      'review.admin@acme.test',
    );
    const active = await asTenant(() => reviews.activate(campaign.campaignId));
    expect(active.status).toBe('ACTIVE');
    expect(active.stats).toEqual(expect.objectContaining({ totalItems: 3, pending: 3 }));

    // One item per person with a File outbound account, for the default reviewer
    const { data: items } = await asTenant(() => reviews.listItems(campaign.campaignId, {}));
    const itemOf = (p: Person) => items.find((i) => i.identityId === ids[p.id])!;
    expect(items.map((i) => i.identityId).sort()).toEqual(
      [ada, grace, alan].map((p) => ids[p.id]).sort(),
    );
    for (const item of items) {
      expect(item.reviewerId).toBe(REVIEWER);
      expect(item.entitlements.map(({ system, type, name }) => ({ system, type, name }))).toEqual([
        { system: 'file-outbound', type: 'account', name: 'Account' },
      ]);
    }

    // The reviewer keeps Ada's and Grace's accounts and revokes Alan's; nothing is removed yet
    await asTenant(async () => {
      await reviews.decide(itemOf(ada).itemId, 'approved', REVIEWER);
      await reviews.decide(itemOf(grace).itemId, 'approved', REVIEWER);
      await reviews.decide(itemOf(alan).itemId, 'revoked', REVIEWER, 'Left the file feed team');
    }, REVIEWER);
    expect((await identityDoc(emailOf(alan)))!.provisioning[0].status).toBe('SYNCED');

    await env.client.workflow.getHandle(active.workflowId!).result();
    const closed = await asTenant(() => reviews.findOne(campaign.campaignId));
    expect(closed.status).toBe('COMPLETED');
    expect(closed.stats).toEqual(
      expect.objectContaining({ totalItems: 3, approved: 2, revoked: 1, pending: 0 }),
    );
    expect(closed.toObject().revocationSummary).toEqual({
      removed: 0,
      alreadyGone: 1,
      manualActionNeeded: 0,
      failed: 0,
    });
    const revoked = await asTenant(() => reviews.getItem(itemOf(alan).itemId));
    expect(revoked.toObject().entitlements[0].revocation).toEqual(
      expect.objectContaining({
        outcome: 'already-gone',
        detail: 'keeps no account (notification or log target)',
      }),
    );

    // Alan's entry is closed (no account until a new provisioning); the kept ones are untouched
    // and nothing was written to the file
    expect((await identityDoc(emailOf(alan)))!.provisioning).toEqual([
      expect.objectContaining({
        targetSystem: 'file-outbound',
        status: 'DEPROVISIONED',
        provisionedAt: null,
      }),
    ]);
    for (const person of [ada, grace]) {
      expect((await identityDoc(emailOf(person)))!.provisioning).toEqual([
        expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
      ]);
    }
    expect(fileLines()).toHaveLength(3);

    // Timeline and audit: the removal, by the reviewer who revoked it
    const entries = await eventually(
      () => timeline(ids[alan.id]),
      (list) => list.some((e) => e.title.endsWith('after access review: file-outbound')),
    );
    // After the joiner history of stage 1 (plan 2.8a)
    const joinerPart = entries.slice(0, JOINER_HISTORY.length);
    expect(joinerPart.map((e) => e.title).sort()).toEqual([...JOINER_HISTORY].sort());
    expect(entries.slice(JOINER_HISTORY.length).map((e) => e.title)).toEqual([
      'No account left after access review: file-outbound',
    ]);
    expect(entries[JOINER_HISTORY.length]).toEqual(
      expect.objectContaining({
        actor: REVIEWER,
        severity: 'info',
        description: 'keeps no account (notification or log target)',
        targetSystem: 'file-outbound',
      }),
    );
    expect(
      await eventually(
        () => audit({ action: 'access_review.account_revoked', resourceId: ids[alan.id] }),
        (list) => list.length > 0,
      ),
    ).toEqual([expect.objectContaining({ actor: REVIEWER })]);
    for (const person of [ada, grace]) {
      expect(await timeline(ids[person.id])).not.toContainEqual(
        expect.objectContaining({ title: expect.stringContaining('access review') }),
      );
    }

    // The revoke sticks: an access review exclusion of Alan's File outbound account, counted
    // against the Sales policy that grants him the Sales group there, which the policies now
    // leave out for him; Ada, in Sales too, keeps it
    const exclusionsOf = (person: Person) =>
      asTenant(() => moduleRef.get(ReviewExclusionService).listActive(ids[person.id]));
    expect((await exclusionsOf(alan)).exclusions).toEqual([
      expect.objectContaining({
        targetSystem: 'file-outbound',
        scope: 'account',
        campaignId: campaign.campaignId,
        campaignName: 'Q4 File outbound review',
        decision: 'revoked',
        reviewer: REVIEWER,
        justification: 'Left the file feed team',
        grantingPolicies: [expect.objectContaining({ policyName: 'Sales access' })],
        status: 'active',
      }),
    ]);
    expect((await exclusionsOf(ada)).exclusions).toEqual([]);
    const grantsOf = (person: Person) =>
      asTenant(async () => {
        const identities = moduleRef.get(IdentityService);
        const identity = await identities.findIdentityById(ids[person.id]);
        const profile = await identities.buildProfileWithContractsForPolicy(identity!);
        return moduleRef
          .get(PolicyEngineService)
          .evaluateOperationsWithoutSod(profile as unknown as StandardUserDto, TENANT);
      });
    expect(await grantsOf(alan)).toEqual([]);
    expect((await grantsOf(ada)).map((op) => op.targetId)).toEqual([SALES]);
    expect(
      await eventually(
        () => audit({ action: 'access_review.exclusion_created', resourceId: ids[alan.id] }),
        (list) => list.length > 0,
      ),
    ).toEqual([expect.objectContaining({ actor: REVIEWER })]);
    await expectNoDeadLetters();
  }, 120_000);

  it('4. leaver: HR terminates a person, offboarding runs once', async () => {
    const mark = started.length;
    const people = [{ ...ada, department: 'Sales' }, { ...grace, status: 'Terminated' }, alan];
    const sync = await runHrSync(people);

    // Default leaver policy: "Terminated" acts at once (no end date, so no grace period). Three
    // active identities allow max(2, min(10, 5 % of 3)) = 2 automatic leavers per sync: the floor
    // lets this one start without a batch
    expect(sync.leavers).toEqual(
      expect.objectContaining({ fullSync: true, detected: 1, started: 1 }),
    );
    expect(sync.leavers?.pausedBatchId).toBeUndefined();
    expect(sync.movers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(sync.joiners).toEqual(expect.objectContaining({ detected: 0, started: 0, closed: 0 }));
    const offboardingId = `t-${TENANT}-offboard-${ids[grace.id]}`;
    expect(started.slice(mark)).toEqual([
      { workflowId: offboardingId, type: 'offboardingWorkflow' },
    ]);
    const handle = env.client.workflow.getHandle(offboardingId);
    await expect(handle.result()).resolves.toEqual(
      expect.objectContaining({
        identityId: ids[grace.id],
        status: 'completed',
        hubStatus: 'deleted',
        systems: [
          {
            system: 'file-outbound',
            outcome: 'not-applicable',
            reason: 'keeps no account (notification or log target)',
          },
        ],
      }),
    );
    expect((await handle.describe()).memo).toEqual(
      expect.objectContaining({ reason: 'leaver:terminated' }),
    );
    // File outbound keeps no account: nothing written for the leaver, the delivered record's
    // entry stays SYNCED
    expect(fileLines()).toHaveLength(3);
    const doc = await identityDoc(emailOf(grace));
    expect(doc!.provisioning).toEqual([
      expect.objectContaining({ targetSystem: 'file-outbound', status: 'SYNCED' }),
    ]);
    // Golden Record deleted (soft): gone from the hub's live view
    expect(doc!.deletedAt).toBeInstanceOf(Date);
    expect(doc!.deletedBy).toBe('offboarding-workflow');
    await expect(
      asTenant(() => moduleRef.get(IdentityService).findIdentityById(ids[grace.id])),
    ).resolves.toBeNull();
    // The leaver event and the offboarding record the Leavers page reads
    const leaverEvent = await eventually(
      () => db.collection('leaver_events').findOne({ tenantId: TENANT, identityId: ids[grace.id] }),
      (e) => !!e?.offboardingFinishedAt,
    );
    expect(leaverEvent).toEqual(
      expect.objectContaining({
        reason: 'terminated',
        status: 'started',
        workflowId: offboardingId,
        offboardingFinishedAt: expect.any(Date),
      }),
    );
    expect(await db.collection('offboarding_records').find({ tenantId: TENANT }).toArray()).toEqual(
      [
        expect.objectContaining({
          workflowId: offboardingId,
          identityId: ids[grace.id],
          status: 'completed',
          hubStatus: 'deleted',
        }),
      ],
    );

    const entries = await eventually(
      () => timeline(ids[grace.id]),
      (list) => list.some((e) => e.title === 'Offboarding completed'),
    );
    expect(entries.map((e) => e.title).sort()).toEqual(
      [
        ...JOINER_HISTORY,
        'Leaver detected: terminated in HR',
        'Offboarding started',
        'Status changed: ACTIVE → SUSPENDED',
        'Not applicable: file-outbound',
        'User deprovisioned',
        'Offboarding completed',
      ].sort(),
    );
    for (const action of [
      'identity.leaver_detected',
      'identity.leaver_offboarding_started',
      'identity.status_changed',
      'identity.offboarding_completed',
      'identity.deleted',
    ]) {
      expect(await audit({ action, resourceId: ids[grace.id] })).toHaveLength(1);
    }

    // The same export again: nothing new starts
    const runId = (await handle.describe()).runId;
    const again = started.length;
    const repeat = await runHrSync(people);
    // The deleted leaver's terminated row changes nothing and is no error
    expect(repeat).toEqual(
      expect.objectContaining({ ingested: 2, errors: [], activeRowsOfDeletedIdentities: 0 }),
    );
    expect(repeat.leavers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(repeat.movers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(workflowsStartedSince(again)).toEqual([]);
    expect((await handle.describe()).runId).toBe(runId);
    await expectNoDeadLetters();
  }, 180_000);

  it('5. joiner under the limit: a new hire waits while the pipeline is paused, then the sync onboards him', async () => {
    const people = [
      { ...ada, department: 'Sales' },
      { ...grace, status: 'Terminated' },
      alan,
      linus,
    ];
    const pipeline = moduleRef.get(PipelineService);
    const mark = started.length;

    // Paused: the sync records the new hire and starts nothing
    await asTenant(() => pipeline.pause(TENANT), 'admin@acme.test');
    const paused = await runHrSync(people);
    expect(paused).toEqual(expect.objectContaining({ ingested: 3, errors: [] }));
    expect(paused.joiners).toEqual(
      expect.objectContaining({
        fullSync: true,
        detected: 1,
        started: 0,
        pending: 0,
        waiting: 1,
        pipelineStatus: 'PAUSED',
      }),
    );
    expect(workflowsStartedSince(mark)).toEqual([]);
    const doc = await identityDoc(emailOf(linus));
    ids[linus.id] = String(doc!._id);
    expect(doc!.provisioning).toEqual([]);

    // Resumed: the next full sync starts his onboarding on its own (1 is within the allowance
    // of 2 for three active identities), as system:hr-sync
    await asTenant(() => pipeline.resume(TENANT), 'admin@acme.test');
    const resumed = await runHrSync(people);
    expect(resumed.joiners).toEqual(
      expect.objectContaining({
        detected: 0,
        started: 1,
        pending: 0,
        waiting: 0,
        pipelineStatus: 'DEPLOYED',
      }),
    );
    expect(resumed.joiners?.pausedBatchId).toBeUndefined();
    expect(started.slice(mark)).toEqual([
      { workflowId: onboardingId(linus), type: 'onboardingWorkflow' },
    ]);
    const handle = env.client.workflow.getHandle(onboardingId(linus));
    await expect(handle.result()).resolves.toBe(
      `Dynamic onboarding complete for ${emailOf(linus)}.`,
    );
    expect((await handle.describe()).memo).toEqual(
      expect.objectContaining({ reason: 'joiner:hr-sync:csv-hr' }),
    );
    expect(fileLines()).toHaveLength(4);
    expect(fileLines()[3]).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ email: emailOf(linus), departmentName: 'Engineering' }),
        intent: {
          operations: [expect.objectContaining({ action: 'add', targetId: ENGINEERING })],
        },
      }),
    );
    expect((await identityDoc(emailOf(linus)))!.provisioning).toEqual([
      expect.objectContaining({
        targetSystem: 'file-outbound',
        status: 'SYNCED',
        writebackComplete: true,
      }),
    ]);

    const entries = await eventually(
      () => timeline(ids[linus.id]),
      (list) => list.length >= JOINER_HISTORY.length,
    );
    expect(entries.map((e) => e.title).sort()).toEqual([...JOINER_HISTORY].sort());
    // Created by the paused sync, onboarded by the next one
    expect(entries[0].title).toBe('Created via csv-hr');
    expect(entries.find((e) => e.title === 'Onboarding started by HR sync')).toEqual(
      expect.objectContaining({ description: 'New in the csv-hr sync.', actor: 'system:hr-sync' }),
    );
    expect(
      await eventually(
        () => audit({ action: 'identity.joiner_onboarding_started', resourceId: ids[linus.id] }),
        (list) => list.length > 0,
      ),
    ).toEqual([expect.objectContaining({ actor: 'system:hr-sync' })]);

    // The same export again: nothing new starts
    const again = started.length;
    const repeat = await runHrSync(people);
    expect(repeat.joiners).toEqual(
      expect.objectContaining({ detected: 0, started: 0, pending: 0, waiting: 0, closed: 0 }),
    );
    expect(repeat.leavers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(repeat.movers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    expect(workflowsStartedSince(again)).toEqual([]);
    expect(fileLines()).toHaveLength(4);
    await expectNoDeadLetters();
  }, 180_000);

  it('6. rehire: a person who left returns in HR with a later start date, and the sync onboards her as a joiner', async () => {
    // Grace was offboarded and deleted in stage 4; HR now has her active, starting today (after
    // the deletion): the sync revives her identity, and she is a joiner like a new hire
    const returning: Person = { ...grace, startDate: new Date().toISOString() };
    const people = [{ ...ada, department: 'Sales' }, returning, alan, linus];
    const mark = started.length;

    const sync = await runHrSync(people);

    expect(sync).toEqual(
      expect.objectContaining({ ingested: 4, errors: [], activeRowsOfDeletedIdentities: 0 }),
    );
    expect(sync.leavers).toEqual(expect.objectContaining({ detected: 0, started: 0 }));
    // Her earlier employment's File outbound entry does not make her a provisioned identity
    expect(sync.movers).toEqual(
      expect.objectContaining({ detected: 0, started: 0, withoutBaseline: 0 }),
    );
    // Four active identities allow max(2, min(10, 0)) = 2 joiners per sync: she starts at once
    expect(sync.joiners).toEqual(
      expect.objectContaining({
        fullSync: true,
        detected: 1,
        started: 1,
        pending: 0,
        waiting: 0,
        closed: 0,
        pipelineStatus: 'DEPLOYED',
      }),
    );
    expect(started.slice(mark)).toEqual([
      { workflowId: onboardingId(grace), type: 'onboardingWorkflow' },
    ]);
    const handle = env.client.workflow.getHandle(onboardingId(grace));
    await expect(handle.result()).resolves.toBe(
      `Dynamic onboarding complete for ${emailOf(grace)}.`,
    );
    expect((await handle.describe()).memo).toEqual(
      expect.objectContaining({ reason: 'joiner:hr-sync:csv-hr' }),
    );
    // Delivered to File outbound again: the entry from her first employment was not "done"
    expect(fileLines()).toHaveLength(5);
    expect(fileLines()[4]).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ email: emailOf(grace), departmentName: 'Engineering' }),
        intent: {
          operations: [expect.objectContaining({ action: 'add', targetId: ENGINEERING })],
        },
      }),
    );
    const doc = await identityDoc(emailOf(grace));
    expect(String(doc!._id)).toBe(ids[grace.id]);
    expect(doc!.deletedAt ?? null).toBeNull();
    expect(doc!.provisioning).toEqual([
      expect.objectContaining({
        targetSystem: 'file-outbound',
        status: 'SYNCED',
        writebackComplete: true,
      }),
    ]);
    // One joiner per hire: the first hire's stays as it was, the rehire has its own
    const joiners = await db
      .collection('joiner_events')
      .find({ tenantId: TENANT, identityId: ids[grace.id] })
      .sort({ detectedAt: 1 })
      .toArray();
    expect(joiners).toEqual([
      expect.objectContaining({ status: 'started' }),
      expect.objectContaining({
        status: 'started',
        rehiredAt: expect.any(Date),
        workflowId: onboardingId(grace),
      }),
    ]);
    expect(joiners[0].rehiredAt).toBeUndefined();

    const entries = await eventually(
      () => timeline(ids[grace.id]),
      (list) => list.some((e) => e.description === 'Rehired in the csv-hr sync.'),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        title: 'Onboarding started by HR sync',
        description: 'Rehired in the csv-hr sync.',
        actor: 'system:hr-sync',
      }),
    );

    // The same export again: nothing new starts
    const again = started.length;
    const repeat = await runHrSync(people);
    expect(repeat.joiners).toEqual(
      expect.objectContaining({ detected: 0, started: 0, pending: 0, waiting: 0, closed: 0 }),
    );
    expect(workflowsStartedSince(again)).toEqual([]);
    expect(fileLines()).toHaveLength(5);
    await expectNoDeadLetters();
  }, 180_000);
});
