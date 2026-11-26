/**
 * Onboarding and the tenant's provisioning pipeline status, end to end on the time-skipping
 * Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch onboarding:pipeline-guard-deployed the guard skipped a person only while the
 * pipeline was PAUSED or STOPPED, and only after the person's admin account children had run:
 * - a paused pipeline (an operator, or the circuit breaker) still created and provisioned the
 *   person's privileged admin accounts;
 * - a pipeline never deployed (DRAFT, or SIMULATED after an impact analysis) provisioned real
 *   accounts for a run an identity edit, a new HR source or [Provision] started, although HR
 *   joiners wait for Deploy.
 *
 * Proves, for runs started now:
 *   - Only a DEPLOYED pipeline provisions. PAUSED, STOPPED, DRAFT and SIMULATED provision nothing
 *     for the person, admin accounts included, and the result says why.
 *   - A DEPLOYED pipeline provisions the admin account and the person's own targets.
 *   - A history recorded before the patch (DRAFT: the admin child ran, then the person was
 *     provisioned) still replays.
 *
 * Fixture test/fixtures/onboarding-pre-pipeline-guard-deployed.history.json was recorded with the
 * pre-patch workflows (commit 9f3c929c) under the workflow id t-tenant-a-onboard-pre-guard, from
 * backend/ (the index re-exports the copy so the child runs on the same worker):
 *   git show 9f3c929c:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-guard.workflow.ts
 *   printf "export * from './onboarding-pre-guard.workflow';\nexport * from './admin-account-provisioning.workflow';\n" \
 *     > src/workflows/index-pre-guard.ts
 *   TEMPORAL_E2E=1 GUARD_FIXTURE_WORKFLOWS=src/workflows/index-pre-guard.ts \
 *     npx jest -c test/jest-e2e.json onboarding-pipeline-guard -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-guard.workflow.ts src/workflows/index-pre-guard.ts
 * (At 9f3c929c the admin child and the health check were those of that commit: copy them as well
 * when recording against a later tree.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { onboardingWorkflow } from '../../src/workflows';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

// The worker's entry module: it exports the admin provisioning child too
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-pipeline-guard-deployed.history.json',
);
const PRE_PATCH_WORKFLOW_ID = 't-tenant-a-onboard-pre-guard';
const TENANT = 'tenant-a';
const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };
const ADMIN_OPERATIONS = [
  {
    type: 'role',
    action: 'add',
    target: 'entra',
    targetId: 'global-admin-role',
    sourcePolicy: 'pam-policy',
    adminTier: 'TIER_0',
  },
];

describeTemporalE2E('onboarding and the pipeline status (e2e)', () => {
  let harness: WorkflowTestHarness;
  let pipelineStatus = 'DEPLOYED';
  const getOrCreateLinkedAdminIdentity = jest.fn();
  const provisionUserToEntra = jest.fn();
  const setProvisioningStatus = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => pipelineStatus,
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [groupOp], adminOperations: ADMIN_OPERATIONS }),
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
      // adminAccountProvisioningWorkflow
      getOrCreateLinkedAdminIdentity: (...args: unknown[]) =>
        getOrCreateLinkedAdminIdentity(...args),
      settleAdminAccountState: async () => true,
    },
    queueWorkers: [
      {
        taskQueue: 'provisioning-entra',
        activities: {
          isEntraConfigured: async () => true,
          checkEntraHealth: async () => true,
          provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
        },
      },
    ],
  });

  const addTenantIdAttribute = (h: WorkflowTestHarness) =>
    h.env.connection.operatorService.addSearchAttributes({
      namespace: h.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
    await addTenantIdAttribute(harness);
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    pipelineStatus = 'DEPLOYED';
    getOrCreateLinkedAdminIdentity
      .mockReset()
      .mockResolvedValue({ adminIdentityId: 'admin-1', adminProfile: { email: 'adm@x.test' } });
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
  });

  const onboard = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: h.taskQueue,
      workflowId,
      searchAttributes: { TenantId: [TENANT] },
    });

  it.each([
    ['PAUSED', 'the provisioning pipeline is paused'],
    ['STOPPED', 'the provisioning pipeline is stopped'],
    ['DRAFT', 'the provisioning pipeline is not deployed (DRAFT)'],
    ['SIMULATED', 'the provisioning pipeline is not deployed (SIMULATED)'],
  ])(
    'provisions nothing, admin accounts included, while the pipeline is %s',
    async (status, why) => {
      pipelineStatus = status;

      const handle = await onboard(harness, `t-${TENANT}-onboard-guard-${status.toLowerCase()}`);
      await expect(handle.result()).resolves.toBe(
        `Dynamic onboarding complete for ${user.email}. 1 of 1 not provisioned: ${why}.`,
      );

      expect(getOrCreateLinkedAdminIdentity).not.toHaveBeenCalled();
      expect(provisionUserToEntra).not.toHaveBeenCalled();
      expect(setProvisioningStatus).not.toHaveBeenCalled();
    },
    60_000,
  );

  it('provisions the admin account and the person while the pipeline is DEPLOYED', async () => {
    const handle = await onboard(harness, `t-${TENANT}-onboard-guard-deployed`);
    await expect(handle.result()).resolves.toBe(`Dynamic onboarding complete for ${user.email}.`);

    expect(getOrCreateLinkedAdminIdentity).toHaveBeenCalledWith('identity-1', 'TIER_0', TENANT);
    // The person's Entra ID account and the admin account's
    expect(provisionUserToEntra).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('replays a history recorded before the patch onboarding:pipeline-guard-deployed', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.GUARD_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (GUARD_FIXTURE_WORKFLOWS = an index of the pre-patch workflows)',
    async () => {
      pipelineStatus = 'DRAFT';
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        await addTenantIdAttribute(pre);
        const handle = await onboard(pre, PRE_PATCH_WORKFLOW_ID);
        await expect(handle.result()).resolves.toBe(
          `Dynamic onboarding complete for ${user.email}.`,
        );
        // The pre-patch code: a DRAFT pipeline provisions the admin account and the person
        expect(getOrCreateLinkedAdminIdentity).toHaveBeenCalledTimes(1);
        expect(provisionUserToEntra).toHaveBeenCalledTimes(2);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
