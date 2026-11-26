/**
 * Leaver coverage for every target, end to end on the time-skipping Temporal test server and
 * in-memory MongoDB. Opt-in via TEMPORAL_E2E=1.
 *
 * The real offboardingWorkflow runs with the real connector activities, services and clients on
 * their own task queues (Entra, Okta, SCIM) and the default queue (GitHub, ServiceNow). Only the
 * vendors are mocked: the Okta, SCIM, GitHub and ServiceNow HTTP APIs (axios) and Microsoft
 * Graph's delete (EntraService). The identity is real: provisioned to every target, with the
 * Entra, Okta and SCIM account ids written back by WritebackActivities.writebackToIdentity, the
 * call onboarding makes. The identity activities, the result event and its timeline and
 * Leavers history handlers are real too.
 *
 * Proves:
 *   - Each vendor sees exactly one deprovision call with the right id: Graph delete by the
 *     written-back objectId, Okta deactivate by its id, SCIM PATCH active=false by its id, the
 *     GitHub invitation cancelled by its id, the ServiceNow sys_user found by email deactivated.
 *   - Discord webhook, Google Sheets and File outbound report "not applicable".
 *   - The Golden Record is deleted, the account targets' provisioning is DEPROVISIONED, and the
 *     per-system result reaches the identity timeline and the offboarding record (Leavers page).
 *   - A target that cannot be cleared (an accepted GitHub invitation) is reported failed with
 *     its reason, the other targets are still deprovisioned, the Golden Record is suspended
 *     (kept, login disabled) and the workflow fails with the result in its details.
 *   - An admin closing that failed target by hand (Leavers "removed manually", by workflow id)
 *     records it as removed manually, marks it DEPROVISIONED and deletes the Golden Record like
 *     a fully successful offboarding; also for an offboarding started by deleting the user,
 *     which has no leaver event.
 *   - GitHub with a login: the member is removed from the organization by the GitHub user id
 *     onboarding wrote back (looked up for its current login), or by the identity's GitHub
 *     login (customAttributes.githubLogin, read by the activity, not passed through history);
 *     a login that is no member, with no pending email invitation, is already gone.
 *   - An ERROR entry (onboarding never finished) whose account the target has is deprovisioned,
 *     without the Entra fallback.
 *   - Histories recorded by the pre-patch workflow (several targets, the Entra fallback, a
 *     partial failure), and by the workflow before offboarding:unsynced-targets and before
 *     offboarding:ad-deprovision-outcome, still replay; so does one recorded before the GitHub
 *     login added two arguments to deprovisionGitHubUser.
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { OffboardingTimelineHandler } from '../../src/infrastructure/events/handlers/offboarding-timeline.handler';
import { OffboardingManualRemovalHandler } from '../../src/infrastructure/events/handlers/offboarding-manual-removal.handler';
import { DeadLetterService } from '../../src/modules/dead-letter/dead-letter.service';
import { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import { CorrelationHashService } from '../../src/infrastructure/services/correlation-hash.service';
import {
  DEFAULT_PROVISIONING_QUEUE,
  QUEUE_NAMES,
} from '../../src/infrastructure/temporal/task-queue.config';
import { offboardingWorkflow } from '../../src/workflows/offboarding.workflow';
import { IdentityActivities } from '../../src/activities/identity.activities';
import { OffboardingActivities } from '../../src/activities/offboarding.activities';
import { WritebackActivities } from '../../src/activities/writeback.activities';
import { EntraActivities } from '../../src/activities/entra.activities';
import { OktaActivities } from '../../src/activities/okta.activities';
import { ScimActivities } from '../../src/activities/scim.activities';
import { GitHubActivities } from '../../src/activities/github.activities';
import { ServiceNowActivities } from '../../src/activities/servicenow.activities';
import { EntraService } from '../../src/modules/connectors/entra-connector/entra.service';
import { OktaService } from '../../src/modules/connectors/okta-connector/okta.service';
import { OktaClient } from '../../src/modules/connectors/okta-connector/okta.client';
import { OktaMapper } from '../../src/modules/connectors/okta-connector/okta.mapper';
import { OktaDiscoveryService } from '../../src/modules/connectors/okta-connector/okta-discovery.service';
import { OktaProvisioningService } from '../../src/modules/connectors/okta-connector/okta-provisioning.service';
import { SCIMService } from '../../src/modules/connectors/scim-connector/scim.service';
import { SCIMClient } from '../../src/modules/connectors/scim-connector/scim.client';
import { SCIMMapper } from '../../src/modules/connectors/scim-connector/scim.mapper';
import { GitHubService } from '../../src/modules/connectors/github-connector/github.service';
import { GitHubClient } from '../../src/modules/connectors/github-connector/github.client';
import { ServiceNowService } from '../../src/modules/connectors/servicenow-connector/servicenow.service';
import { ServiceNowClient } from '../../src/modules/connectors/servicenow-connector/servicenow.client';
import type { ConnectorConfigService } from '../../src/modules/connectors/connector-config.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { IdentityQueryService } from '../../src/modules/identity/identity-query.service';
import { IdentityMutationService } from '../../src/modules/identity/identity-mutation.service';
import { IdentityCorrelationService } from '../../src/modules/identity/identity-correlation.service';
import { IdentityUncorrelatedService } from '../../src/modules/identity/identity-uncorrelated.service';
import { IdentityProvisioningService } from '../../src/modules/identity/identity-provisioning.service';
import { IdentityOnionService } from '../../src/modules/identity/identity-onion.service';
import { IdentityControlsService } from '../../src/modules/identity/identity-controls.service';
import { AuditService } from '../../src/modules/audit/audit.service';
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
import {
  LeaverEvent,
  LeaverEventSchema,
  LeaverEventDocument,
} from '../../src/modules/leavers/schemas/leaver-event.schema';
import { LeaverOffboardingResultHandler } from '../../src/modules/leavers/leaver-offboarding-result.handler';
import { LeaverManualRemovalService } from '../../src/modules/leavers/leaver-manual-removal.service';
import {
  OffboardingRecord,
  OffboardingRecordSchema,
  OffboardingRecordDocument,
} from '../../src/modules/leavers/schemas/offboarding-record.schema';
import { fakeHttp, httpError, type FakeHttpCall } from '../../src/testing/fake-http';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

jest.mock('axios');
// The rest of the guard as it is: the Okta and ServiceNow clients build its HTTPS agent
jest.mock('../../src/infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('../../src/infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/offboarding.workflow.ts');
const fixture = (name: string) =>
  path.resolve(__dirname, `../fixtures/offboarding-pre-per-system-results.${name}.history.json`);
/** Recorded with the workflow before offboarding:unsynced-targets: ERROR entries only. */
const UNSYNCED_FIXTURE = path.resolve(
  __dirname,
  '../fixtures/offboarding-pre-unsynced-targets.history.json',
);
/** Recorded with the workflow before offboarding:ad-deprovision-outcome: an AD target by DN. */
const AD_OUTCOME_FIXTURE = path.resolve(
  __dirname,
  '../fixtures/offboarding-pre-ad-deprovision-outcome.history.json',
);
/**
 * Recorded with the workflow at 08fd38d4, before the GitHub login: deprovisionGitHubUser with
 * three arguments (email, tenant, workflow id), then ServiceNow. No patch guards the two new
 * arguments: replay compares the activity type of each command, not its input.
 */
const GITHUB_LOGIN_FIXTURE = path.resolve(
  __dirname,
  '../fixtures/offboarding-pre-github-login.history.json',
);
const TENANT = 'tenant-a';
const OKTA_BASE = 'https://acme.okta.example/api/v1';
const SNOW_BASE = 'https://acme.service-now.example';
const SCIM_BASE = 'https://scim.acme.example/v2';
const ACCOUNT_TARGETS = ['entra', 'okta', 'scim', 'github', 'servicenow'];
const LOG_TARGETS = ['discord-webhook', 'google-sheets', 'file-outbound'];

const connectorConfigs: Record<string, Record<string, unknown>> = {
  okta: { orgUrl: 'https://acme.okta.example', apiToken: 'ssws-test' },
  github: { personalAccessToken: 'ghp_test', orgName: 'acme' },
  servicenow: { instanceUrl: SNOW_BASE, username: 'euroid', password: 'secret' },
};
const canvasConfigs: Record<string, Record<string, unknown>> = {
  'entra-id': { tenantId: 'entra-tenant', clientId: 'c', clientSecret: 's' },
  scim: { baseUrl: SCIM_BASE, authType: 'bearer', bearerToken: 't' },
};

/** Mocked vendor APIs. Each records its calls; `writes` are the ones that change something. */
const okta = fakeHttp(({ method }) => (method === 'GET' ? { id: 'unused' } : {}));
const github = fakeHttp(({ method, url }) => {
  if (method === 'GET' && url === '/orgs/acme/invitations') {
    return [{ id: 4242, email: 'ada@acme.test', login: null }];
  }
  // GitHub logins: account 583231 (written back) has been renamed; eve-gh is not in the org
  if (method === 'GET' && url === '/user/583231') return { id: 583231, login: 'fay-renamed' };
  if (method === 'DELETE' && url === '/orgs/acme/memberships/eve-gh') throw httpError(404);
  return method === 'GET' ? [] : undefined;
});
const servicenow = fakeHttp(({ method, params }) => {
  if (method === 'GET') {
    const found = params?.sysparm_query === 'email=ada@acme.test';
    return { result: found ? [{ sys_id: 'snow-sys-1', active: 'true', locked_out: 'false' }] : [] };
  }
  return { result: {} };
});
const scimCalls: FakeHttpCall[] = [];
const graphDelete = jest.fn(async (_id: string) => true);

describeTemporalE2E('offboarding: every target, per-system results (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let identityModel: Model<IdentityDocument>;

  beforeAll(async () => {
    (axios.create as jest.Mock).mockImplementation((options: { baseURL?: string }) => {
      if (options.baseURL === OKTA_BASE) return okta.instance;
      if (options.baseURL === 'https://api.github.com') return github.instance;
      if (options.baseURL === SNOW_BASE) return servicenow.instance;
      throw new Error(`unexpected vendor ${options.baseURL}`);
    });
    (axios as unknown as jest.Mock).mockImplementation(
      async (req: { method: string; url: string; data?: unknown }) => {
        scimCalls.push({
          method: req.method as FakeHttpCall['method'],
          url: req.url.slice(SCIM_BASE.length),
          data: req.data,
        });
        return { status: 200, headers: {}, data: { id: 'scim-1' } };
      },
    );

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: UserEvent.name, schema: UserEventSchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
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
        // The kill switch an incomplete offboarding sets (suspendIdentity -> updateControls)
        IdentityControlsService,
        { provide: AuditService, useValue: { log: jest.fn(), logFireAndForget: jest.fn() } },
        // Never reached: no row here belongs to a deleted identity
        { provide: IdentityDeletedMatchService, useValue: {} },
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
        OffboardingTimelineHandler,
        LeaverOffboardingResultHandler,
        OffboardingManualRemovalHandler,
        LeaverManualRemovalService,
        IdentityActivities,
        OffboardingActivities,
      ],
    })
      .useMocker(() => ({}))
      .compile();
    await moduleRef.init();
    identityModel = moduleRef.get(getModelToken(Identity.name));

    const emitter = moduleRef.get(DomainEventEmitterService);
    const connectorConfig = {
      getConfig: async (id: string) => ({ config: connectorConfigs[id] }),
    } as unknown as ConnectorConfigService;
    const oktaClient = new OktaClient();
    const oktaActivities = new OktaActivities(
      new OktaService(
        new OktaDiscoveryService(oktaClient),
        new OktaProvisioningService(oktaClient, new OktaMapper()),
        connectorConfig,
        { get: () => undefined } as never,
      ),
      emitter,
      {} as never,
    );
    const scimActivities = new ScimActivities(
      new SCIMService(
        new SCIMClient(
          { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
          { execute: (_c: string, fn: () => Promise<unknown>) => fn() } as never,
        ),
        new SCIMMapper(),
      ),
      moduleRef.get(IdentityService),
      emitter,
    );
    const entraActivities = new EntraActivities(
      { deleteUser: graphDelete } as unknown as EntraService,
      { emit: jest.fn() } as unknown as DomainEventEmitterService,
      {} as never,
      moduleRef.get(IdentityService),
    );
    const githubActivities = new GitHubActivities(
      new GitHubService(new GitHubClient(), connectorConfig),
      moduleRef.get(IdentityService),
      emitter,
    );
    const snowActivities = new ServiceNowActivities(
      new ServiceNowService(new ServiceNowClient(), connectorConfig),
      emitter,
    );
    const identity = moduleRef.get(IdentityActivities);
    const outcome = moduleRef.get(OffboardingActivities);
    const bind = <T extends object>(obj: T, name: keyof T) =>
      (obj[name] as (...args: unknown[]) => unknown).bind(obj);

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        getConnectorConfig: async (id: unknown) => canvasConfigs[id as string] ?? null,
        getProvisionedTargets: bind(identity, 'getProvisionedTargets'),
        getOffboardingTargets: bind(identity, 'getOffboardingTargets'),
        setProvisioningStatus: bind(identity, 'setProvisioningStatus'),
        markDeleted: bind(identity, 'markDeleted'),
        suspendIdentity: bind(identity, 'suspendIdentity'),
        recordOffboardingOutcome: bind(outcome, 'recordOffboardingOutcome'),
        // No linked admin accounts (the cascade: offboarding-linked-admins.workflow.e2e-spec.ts)
        getLinkedAdminIdentities: async () => [],
        deprovisionGitHubUser: bind(githubActivities, 'deprovisionGitHubUser'),
        deprovisionServiceNowUser: bind(snowActivities, 'deprovisionServiceNowUser'),
      },
      queueWorkers: [
        {
          taskQueue: QUEUE_NAMES['entra'],
          activities: { deleteUser: bind(entraActivities, 'deleteUser') },
        },
        {
          taskQueue: QUEUE_NAMES['okta'],
          activities: { deprovisionOktaUser: bind(oktaActivities, 'deprovisionOktaUser') },
        },
        {
          taskQueue: QUEUE_NAMES['scim'],
          activities: { deprovisionScimUser: bind(scimActivities, 'deprovisionScimUser') },
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.shutdown();
    await moduleRef?.close();
    await closeTestDb();
  }, 60_000);

  beforeEach(() => {
    for (const vendor of [okta, github, servicenow]) vendor.calls.length = 0;
    scimCalls.length = 0;
    graphDelete.mockClear();
  });

  /**
   * An identity provisioned to `targets` (SYNCED), with the account ids onboarding writes back
   * for Entra, Okta and SCIM, and (unless `leaver` is false: DELETE /identity/:id) a started
   * leaver event for its offboarding.
   */
  async function provisionedIdentity(
    email: string,
    targets: string[],
    ids: Record<string, string>,
    leaver = true,
  ) {
    return withTenantContext(TENANT, async () => {
      const doc = await identityModel.create({
        tenantId: TENANT,
        profile: { firstName: 'Ada', lastName: 'Lovelace', email, status: 'ACTIVE' },
        sources: [{ sourceName: 'csv-hr', externalId: email, rawData: { email } }],
        provisioning: targets.map((targetSystem) => ({ targetSystem, status: 'SYNCED' })),
        metadata: { version: 1 },
      });
      const identityId = String(doc._id);
      const writeback = new WritebackActivities(
        moduleRef.get(IdentityService),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { emit: jest.fn() } as never,
      );
      for (const [system, objectId] of Object.entries(ids)) {
        await writeback.writebackToIdentity(identityId, system, { objectId }, TENANT);
      }
      if (!leaver) return identityId;
      await moduleRef.get<Model<LeaverEventDocument>>(getModelToken(LeaverEvent.name)).create({
        tenantId: TENANT,
        identityId,
        sourceName: 'csv-hr',
        reason: 'terminated',
        eventKey: `k-${identityId}`,
        status: 'started',
        open: false,
        detectedAt: new Date(),
        workflowId: `t-${TENANT}-offboard-${identityId}`,
      });
      return identityId;
    });
  }

  const offboard = (identityId: string, email: string) =>
    harness.env.client.workflow.execute(offboardingWorkflow, {
      args: [{ userId: identityId, userEmail: email, tenantId: TENANT }],
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId: `t-${TENANT}-offboard-${identityId}`,
    });

  const stored = (identityId: string) =>
    withTenantContext(TENANT, () => identityModel.findById(identityId).lean().exec());

  /** The offboarding record (per-system result) of the identity's offboarding workflow. */
  const offboardingRecord = (identityId: string) =>
    withTenantContext(TENANT, () =>
      moduleRef
        .get<Model<OffboardingRecordDocument>>(getModelToken(OffboardingRecord.name))
        .findOne({ workflowId: `t-${TENANT}-offboard-${identityId}` })
        .lean()
        .exec(),
    );

  /** The result event's handlers run after the emit returns; wait for their writes. */
  async function eventually<T>(
    read: () => T | Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    let value = await read();
    for (let attempt = 0; attempt < 100 && !done(value); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      value = await read();
    }
    return value;
  }

  it('removes the account in each target exactly once with the right id; log targets are not applicable', async () => {
    const id = await provisionedIdentity('ada@acme.test', [...ACCOUNT_TARGETS, ...LOG_TARGETS], {
      'entra-id': 'entra-obj-1',
      okta: '00u1',
      scim: 'scim-1',
    });

    const result = await offboard(id, 'ada@acme.test');

    expect(graphDelete.mock.calls).toEqual([['entra-obj-1', canvasConfigs['entra-id']]]);
    expect(okta.writes()).toEqual([{ method: 'POST', url: '/users/00u1/lifecycle/deactivate' }]);
    expect(scimCalls.filter((c) => c.method !== 'GET')).toEqual([
      expect.objectContaining({ method: 'PATCH', url: '/Users/scim-1' }),
    ]);
    expect(github.writes()).toEqual([{ method: 'DELETE', url: '/orgs/acme/invitations/4242' }]);
    expect(servicenow.writes()).toEqual([
      {
        method: 'PATCH',
        url: '/api/now/table/sys_user/snow-sys-1',
        data: { active: 'false', locked_out: 'true' },
      },
    ]);
    expect(result).toEqual({
      identityId: id,
      workflowId: `t-${TENANT}-offboard-${id}`,
      status: 'completed',
      hubStatus: 'deleted',
      systems: [
        { system: 'entra', outcome: 'deprovisioned', detail: 'deleted' },
        { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
        { system: 'scim', outcome: 'deprovisioned', detail: 'deactivated' },
        { system: 'github', outcome: 'deprovisioned', detail: 'pending invitation cancelled' },
        { system: 'servicenow', outcome: 'deprovisioned', detail: 'deactivated and locked' },
        ...LOG_TARGETS.map((system) => ({
          system,
          outcome: 'not-applicable',
          reason: 'keeps no account (notification or log target)',
        })),
      ],
    });

    const identity = await stored(id);
    expect(identity?.deletedAt).toBeInstanceOf(Date);
    expect(
      Object.fromEntries(identity!.provisioning.map((p) => [p.targetSystem, p.status])),
    ).toEqual({
      ...Object.fromEntries(ACCOUNT_TARGETS.map((t) => [t, 'DEPROVISIONED'])),
      ...Object.fromEntries(LOG_TARGETS.map((t) => [t, 'SYNCED'])),
    });

    const timeline = await eventually(
      () =>
        withTenantContext(TENANT, () =>
          moduleRef
            .get<Model<UserEventDocument>>(getModelToken(UserEvent.name))
            .find({ userId: id })
            .lean()
            .exec(),
        ),
      (events) => events.length >= 9,
    );
    expect(timeline.map((e) => e.title).sort()).toEqual(
      [
        ...ACCOUNT_TARGETS.map((t) => `Access removed: ${t}`),
        ...LOG_TARGETS.map((t) => `Not applicable: ${t}`),
        'Offboarding completed',
      ].sort(),
    );
    const record = await eventually(() => offboardingRecord(id), Boolean);
    expect(record).toMatchObject({
      identityId: id,
      status: 'completed',
      hubStatus: 'deleted',
      systems: result && typeof result === 'object' ? result.systems : [],
    });
  }, 120_000);

  it('reports a target it cannot clear, still clears the others and suspends the Golden Record', async () => {
    const id = await provisionedIdentity('bo@acme.test', ['okta', 'github'], { okta: '00u2' });

    const error = await offboard(id, 'bo@acme.test').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    const failure = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(failure.type).toBe('OffboardingPartialFailure');
    expect(failure.details?.[0]).toEqual({
      identityId: id,
      workflowId: `t-${TENANT}-offboard-${id}`,
      status: 'partial-failure',
      hubStatus: 'suspended',
      systems: [
        { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
        {
          system: 'github',
          outcome: 'failed',
          reason: expect.stringContaining('remove them from the organization in GitHub'),
        },
      ],
    });
    expect(okta.writes()).toEqual([{ method: 'POST', url: '/users/00u2/lifecycle/deactivate' }]);
    expect(github.writes()).toEqual([]);

    const identity = await stored(id);
    expect(identity?.deletedAt).toBeFalsy();
    expect(identity?.profile.status).toBe('SUSPENDED');
    expect(identity?.controls?.isLoginDisabled).toBe(true);

    // An admin removes the member in GitHub and closes the target on the Leavers page
    await eventually(() => offboardingRecord(id), Boolean);
    const item = await withTenantContext(TENANT, () =>
      moduleRef
        .get(LeaverManualRemovalService)
        .markRemoved(
          `t-${TENANT}-offboard-${id}`,
          'github',
          'admin@acme.test',
          'Removed from acme',
        ),
    );
    expect(item.leaver).toMatchObject({ reason: 'terminated', sourceName: 'csv-hr' });

    expect(item.offboarding).toMatchObject({
      status: 'completed',
      hubStatus: 'deleted',
      systems: [
        { system: 'okta', outcome: 'deprovisioned' },
        {
          system: 'github',
          outcome: 'removed-manually',
          manualRemoval: { by: 'admin@acme.test', reason: 'Removed from acme' },
        },
      ],
    });
    const closed = await stored(id);
    expect(closed?.deletedAt).toBeInstanceOf(Date);
    expect(closed?.deletedBy).toBe('admin@acme.test');
    expect(closed?.provisioning.find((p) => p.targetSystem === 'github')?.status).toBe(
      'DEPROVISIONED',
    );
    const titles = await eventually(
      async () =>
        (
          await withTenantContext(TENANT, () =>
            moduleRef
              .get<Model<UserEventDocument>>(getModelToken(UserEvent.name))
              .find({ userId: id })
              .lean()
              .exec(),
          )
        ).map((e) => e.title),
      (all) => all.includes('Removed manually: github') && all.includes('Offboarding completed'),
    );
    expect(titles).toEqual(
      expect.arrayContaining(['Removed manually: github', 'Offboarding completed']),
    );
    expect(github.writes()).toEqual([]);
  }, 120_000);

  it('closes a failed target of an offboarding started by deleting the user (no leaver event)', async () => {
    const id = await provisionedIdentity(
      'dee@acme.test',
      ['okta', 'github'],
      { okta: '00u4' },
      false,
    );

    const error = await offboard(id, 'dee@acme.test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const workflowId = `t-${TENANT}-offboard-${id}`;
    await eventually(() => offboardingRecord(id), Boolean);

    const removal = moduleRef.get(LeaverManualRemovalService);
    const open = await withTenantContext(TENANT, () => removal.listOpen());
    const listed = open.find((i) => i.workflowId === workflowId);
    expect(listed).toMatchObject({ identityId: id, displayName: 'Ada Lovelace' });
    expect(listed?.leaver).toBeUndefined();

    const item = await withTenantContext(TENANT, () =>
      removal.markRemoved(workflowId, 'github', 'admin@acme.test', 'Removed from acme'),
    );

    expect(item.offboarding).toMatchObject({ status: 'completed', hubStatus: 'deleted' });
    const closed = await stored(id);
    expect(closed?.deletedAt).toBeInstanceOf(Date);
    expect(closed?.deletedBy).toBe('admin@acme.test');
    expect(closed?.provisioning.find((p) => p.targetSystem === 'github')?.status).toBe(
      'DEPROVISIONED',
    );
  }, 120_000);

  it('removes the GitHub member by the user id onboarding wrote back, at its current login', async () => {
    const id = await provisionedIdentity('fay@acme.test', ['github'], {
      github: 'github-user-583231',
    });

    const result = await offboard(id, 'fay@acme.test');

    expect(github.calls[0]).toEqual({ method: 'GET', url: '/user/583231' });
    expect(github.writes()).toEqual([
      { method: 'DELETE', url: '/orgs/acme/memberships/fay-renamed' },
    ]);
    expect(result).toMatchObject({
      status: 'completed',
      hubStatus: 'deleted',
      systems: [
        {
          system: 'github',
          outcome: 'deprovisioned',
          detail: 'removed from the organization (membership or invitation)',
        },
      ],
    });
    const identity = await stored(id);
    expect(identity?.provisioning[0].status).toBe('DEPROVISIONED');
  }, 120_000);

  it("uses the identity's GitHub login without a written-back id; no member and no invitation is already gone", async () => {
    const id = await provisionedIdentity('eve@acme.test', ['github'], {});
    await withTenantContext(TENANT, () =>
      identityModel
        .updateOne({ _id: id }, { $set: { 'profile.customAttributes': { githubLogin: 'eve-gh' } } })
        .exec(),
    );

    const result = await offboard(id, 'eve@acme.test');

    expect(github.writes()).toEqual([{ method: 'DELETE', url: '/orgs/acme/memberships/eve-gh' }]);
    expect(result).toMatchObject({
      status: 'completed',
      hubStatus: 'deleted',
      systems: [
        { system: 'github', outcome: 'already-gone', detail: 'not a member of the organization' },
      ],
    });
    const identity = await stored(id);
    expect(identity?.deletedAt).toBeInstanceOf(Date);
  }, 120_000);

  it('deprovisions an ERROR entry (onboarding never finished) whose account the target has', async () => {
    const id = await provisionedIdentity('cy@acme.test', [], {});
    await withTenantContext(TENANT, () =>
      identityModel
        .updateOne(
          { _id: id },
          { $set: { provisioning: [{ targetSystem: 'okta', status: 'ERROR' }] } },
        )
        .exec(),
    );

    const result = await offboard(id, 'cy@acme.test');

    // No stored id: looked up by login (the mock finds user "unused"), then deactivated
    expect(okta.calls[0]).toMatchObject({ method: 'GET', url: '/users/cy%40acme.test' });
    expect(okta.writes()).toEqual([{ method: 'POST', url: '/users/unused/lifecycle/deactivate' }]);
    expect(graphDelete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'completed',
      systems: [{ system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' }],
    });
    const identity = await stored(id);
    expect(identity?.provisioning[0].status).toBe('DEPROVISIONED');
  }, 120_000);

  it.each([
    ['unsynced-targets', UNSYNCED_FIXTURE],
    ['ad-deprovision-outcome', AD_OUTCOME_FIXTURE],
  ])(
    'replays a history recorded before the %s patch',
    async (_name, file) => {
      const history = JSON.parse(fs.readFileSync(file, 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
      ).resolves.toBeUndefined();
    },
    60_000,
  );

  it('replays a history recorded before the GitHub login (deprovisionGitHubUser with three arguments)', async () => {
    const history = JSON.parse(fs.readFileSync(GITHUB_LOGIN_FIXTURE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  it.each(['multi', 'legacy', 'partial'])(
    'replays a history recorded before the per-system results patch (%s)',
    async (name) => {
      const history = JSON.parse(fs.readFileSync(fixture(name), 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
      ).resolves.toBeUndefined();
    },
    60_000,
  );
});
