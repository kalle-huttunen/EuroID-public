/**
 * Onboarding when one of the person's admin account children fails, end to end on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch onboarding:admin-account-failure-not-fatal onboarding awaited each admin
 * provisioning child and a failed child failed the run there: the person's own accounts were not
 * provisioned, and the tiers after the failed one got no admin account. A second tier whose admin
 * UPN another tier already holds (409, ADMIN_UPN_PATTERN without {tier}) did this for every such
 * person.
 *
 * Proves, for runs started now:
 *   - The person's own targets are provisioned whatever the admin children do.
 *   - Every tier's child is started; a failed one is recorded on the person's timeline
 *     (recordAdminAccountFailed, with the tier and the child's own reason).
 *   - The run then ends failed (AdminAccountFailed, not retried), naming the identity and the tier
 *     but no email.
 *   - A history recorded before the patch (the run failed at the child, nothing provisioned for
 *     the person) still replays.
 *
 * Fixture test/fixtures/onboarding-pre-admin-account-failure.history.json was recorded with the
 * pre-patch workflows (commit 9f3c929c) under the workflow id t-tenant-a-onboard-pre-admin-failure,
 * from backend/ (the index re-exports the copies so the child runs on the same worker):
 *   git show 9f3c929c:backend/src/workflows/onboarding.workflow.ts \
 *     | sed "s#'./onboarding-admin-tiers'#'./onboarding-admin-tiers-pre-failure'#" \
 *     > src/workflows/onboarding-pre-admin-failure.workflow.ts
 *   git show 9f3c929c:backend/src/workflows/onboarding-admin-tiers.ts \
 *     > src/workflows/onboarding-admin-tiers-pre-failure.ts
 *   printf "export * from './onboarding-pre-admin-failure.workflow';\nexport * from './admin-account-provisioning.workflow';\n" \
 *     > src/workflows/index-pre-admin-failure.ts
 *   TEMPORAL_E2E=1 ADMIN_FAILURE_FIXTURE_WORKFLOWS=src/workflows/index-pre-admin-failure.ts \
 *     npx jest -c test/jest-e2e.json onboarding-admin-account-failure -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-admin-failure.workflow.ts \
 *     src/workflows/onboarding-admin-tiers-pre-failure.ts src/workflows/index-pre-admin-failure.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
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
  '../fixtures/onboarding-pre-admin-account-failure.history.json',
);
const PRE_PATCH_WORKFLOW_ID = 't-tenant-a-onboard-pre-admin-failure';
const TENANT = 'tenant-a';
const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };
const UPN_TAKEN =
  "The admin UPN for TIER_2 is held by this person's admin account of another tier: put {tier} in ADMIN_UPN_PATTERN";

const adminOp = (targetId: string, adminTier: string) => ({
  type: 'role',
  action: 'add',
  target: 'entra',
  targetId,
  sourcePolicy: 'pam-policy',
  adminTier,
});
// TIER_0 first: its child provisions; TIER_2's admin identity cannot be created
const ADMIN_OPERATIONS = [
  adminOp('global-admin-role', 'TIER_0'),
  adminOp('helpdesk-role', 'TIER_2'),
];

describeTemporalE2E('onboarding when an admin account child fails (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getOrCreateLinkedAdminIdentity = jest.fn();
  const provisionUserToEntra = jest.fn();
  const setProvisioningStatus = jest.fn();
  const recordAdminAccountFailed = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
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
      recordAdminAccountFailed: (...args: unknown[]) => recordAdminAccountFailed(...args),
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
    getOrCreateLinkedAdminIdentity
      .mockReset()
      .mockImplementation(async (_parent: unknown, tier: unknown) => {
        if (tier === 'TIER_2')
          throw ApplicationFailure.nonRetryable(UPN_TAKEN, 'ConflictException');
        return { adminIdentityId: `admin-${String(tier)}`, adminProfile: { email: 'adm@x.test' } };
      });
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    recordAdminAccountFailed.mockReset().mockResolvedValue(undefined);
  });

  const onboard = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: h.taskQueue,
      workflowId,
      searchAttributes: { TenantId: [TENANT] },
    });

  it("provisions the person's own targets and records the failed admin tier", async () => {
    const workflowId = `t-${TENANT}-onboard-admin-failure`;
    const error = await (await onboard(harness, workflowId)).result().catch((e: unknown) => e);

    // The person's own Entra ID account is provisioned and SYNCED
    expect(
      setProvisioningStatus.mock.calls
        .filter(([identityId]) => identityId === 'identity-1')
        .map(([, system, status]) => [system, status]),
    ).toEqual([
      ['entra', 'SYNCING'],
      ['entra', 'SYNCED'],
    ]);
    // Both tiers were attempted; TIER_0's admin account was provisioned
    expect(getOrCreateLinkedAdminIdentity.mock.calls.map(([, tier]) => tier)).toEqual([
      'TIER_0',
      'TIER_2',
    ]);
    expect(setProvisioningStatus).toHaveBeenCalledWith(
      'admin-TIER_0',
      'entra',
      'SYNCED',
      undefined,
      TENANT,
    );
    // The failed tier is on the person's timeline, with the child's own reason
    expect(recordAdminAccountFailed).toHaveBeenCalledTimes(1);
    expect(recordAdminAccountFailed).toHaveBeenCalledWith(
      'identity-1',
      [{ adminTier: 'TIER_2', reason: UPN_TAKEN }],
      TENANT,
      workflowId,
    );

    // The run ends failed, by identity id and tier, without the email
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect(cause.type).toBe('AdminAccountFailed');
    expect(cause.nonRetryable).toBe(true);
    expect(cause.message).toBe(
      `Admin accounts not provisioned for 1 of 1 people (identity identity-1: TIER_2: ${UPN_TAKEN})`,
    );
    expect(cause.message).not.toContain(user.email);
  }, 60_000);

  it('completes when every admin child succeeds', async () => {
    getOrCreateLinkedAdminIdentity.mockImplementation(async (_p: unknown, tier: unknown) => ({
      adminIdentityId: `admin-${String(tier)}`,
      adminProfile: { email: 'adm@x.test' },
    }));

    const handle = await onboard(harness, `t-${TENANT}-onboard-admin-ok`);
    await expect(handle.result()).resolves.toBe(`Dynamic onboarding complete for ${user.email}.`);
    expect(recordAdminAccountFailed).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the patch onboarding:admin-account-failure-not-fatal', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.ADMIN_FAILURE_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (ADMIN_FAILURE_FIXTURE_WORKFLOWS = an index of the pre-patch workflows)',
    async () => {
      // TIER_2 first, so the pre-patch run fails at its first child
      getOrCreateLinkedAdminIdentity.mockImplementation(async () => {
        throw ApplicationFailure.nonRetryable(UPN_TAKEN, 'ConflictException');
      });
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        await addTenantIdAttribute(pre);
        const handle = await onboard(pre, PRE_PATCH_WORKFLOW_ID);
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
        // The pre-patch code: the run failed at the child, the person was not provisioned
        expect(provisionUserToEntra).not.toHaveBeenCalled();
        expect(setProvisioningStatus).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
