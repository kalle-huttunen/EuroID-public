/**
 * Onboarding a person whose policies grant admin operations of more than one tier, end to end on
 * the time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch onboarding:provision-every-admin-tier, onboarding started one
 * adminAccountProvisioningWorkflow with the first operation's tier and every operation, so a
 * TIER_2 helpdesk role and a TIER_0 Global Admin role both landed on one admin identity of the
 * first tier, and the other tier got no admin account.
 *
 * Proves:
 *   - Each tier gets its own admin provisioning child (`admin-provision-<parent>-<identity>-t<n>`),
 *     with the TenantId search attribute, creating that tier's admin identity and given only that
 *     tier's operations; an operation without a tier counts as TIER_1, as before.
 *   - A history recorded before the patch (one child for two tiers) still replays.
 *
 * Fixture test/fixtures/onboarding-pre-every-admin-tier.history.json was recorded with the
 * pre-patch workflow (commit b56b5d71) under the workflow id t-tenant-a-onboard-tiers, from
 * backend/ (the index re-exports the copy so the child runs on the same worker):
 *   git show b56b5d71:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-tiers.workflow.ts
 *   printf "export * from './onboarding-pre-tiers.workflow';\nexport * from './admin-account-provisioning.workflow';\n" \
 *     > src/workflows/index-pre-tiers.ts
 *   TEMPORAL_E2E=1 TIERS_FIXTURE_WORKFLOWS=src/workflows/index-pre-tiers.ts \
 *     npx jest -c test/jest-e2e.json onboarding-admin-tiers -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-tiers.workflow.ts src/workflows/index-pre-tiers.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { getTenantWorkflow } from '../../src/infrastructure/temporal/tenant-workflow';
import { onboardingWorkflow } from '../../src/workflows';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';
import { historyText } from '../helpers/history-text';

// The worker's entry module: it exports the admin provisioning child too
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-every-admin-tier.history.json',
);
const PRE_PATCH_WORKFLOW_ID = 't-tenant-a-onboard-tiers';
const TENANT = 'tenant-a';
const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };

const op = (targetId: string, adminTier?: string) => ({
  type: 'role',
  action: 'add',
  target: 'entra',
  targetId,
  sourcePolicy: 'pam-policy',
  ...(adminTier ? { adminTier } : {}),
});
const ADMIN_OPERATIONS = [
  op('helpdesk-admin-role', 'TIER_2'),
  op('global-admin-role', 'TIER_0'),
  op('reports-reader-role', 'TIER_2'),
  op('groups-admin-role'),
];

describeTemporalE2E('onboarding provisions every admin tier (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getOrCreateLinkedAdminIdentity = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      // onboardingWorkflow: one new hire whose policies grant admin roles of three tiers, no
      // targets of their own (the person's own provisioning is not under test)
      getActiveTargetSystems: async () => [],
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      evaluateUser: async () => ({ operations: [], adminOperations: ADMIN_OPERATIONS }),
      getReviewExcludedTargets: async () => [],
      // adminAccountProvisioningWorkflow: the tier's admin identity
      getOrCreateLinkedAdminIdentity: (...args: unknown[]) =>
        getOrCreateLinkedAdminIdentity(...args),
      setProvisioningStatus: async () => undefined,
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
      settleAdminAccountState: async () => true,
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    getOrCreateLinkedAdminIdentity
      .mockReset()
      .mockImplementation(async (_parent: unknown, tier: unknown) => ({
        adminIdentityId: `admin-${String(tier)}`,
        adminProfile: { email: `adm-${String(tier).toLowerCase()}@example.com` },
      }));
  });

  const onboard = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: h.taskQueue,
      workflowId,
      searchAttributes: { TenantId: [TENANT] },
      memo: { triggeredBy: 'JoinerExecutionService', targetDescription: 'Onboarding: all' },
    });

  const childText = async (workflowId: string) =>
    historyText(await harness.env.client.workflow.getHandle(workflowId).fetchHistory()).join('\n');

  it('starts one admin provisioning child per tier, each with its own operations', async () => {
    const parentId = `t-${TENANT}-onboard-every-tier`;
    await (await onboard(harness, parentId)).result();

    // In the order the tiers first appear; an operation without a tier is TIER_1
    expect(
      getOrCreateLinkedAdminIdentity.mock.calls.map(([parent, tier]) => [parent, tier]),
    ).toEqual([
      ['identity-1', 'TIER_2'],
      ['identity-1', 'TIER_0'],
      ['identity-1', 'TIER_1'],
    ]);

    const tier2 = await childText(`admin-provision-${parentId}-identity-1-t2`);
    expect(tier2).toContain('helpdesk-admin-role');
    expect(tier2).toContain('reports-reader-role');
    expect(tier2).not.toContain('global-admin-role');
    const tier0 = await childText(`admin-provision-${parentId}-identity-1-t0`);
    expect(tier0).toContain('global-admin-role');
    expect(tier0).not.toContain('helpdesk-admin-role');
    const tier1 = await childText(`admin-provision-${parentId}-identity-1-t1`);
    expect(tier1).toContain('groups-admin-role');
    expect(tier1).not.toContain('global-admin-role');

    // Each child carries the parent's tenant
    for (const tier of ['t0', 't1', 't2']) {
      const { description } = await getTenantWorkflow(
        harness.env.client,
        `admin-provision-${parentId}-identity-1-${tier}`,
        TENANT,
      );
      expect(description.status.name).toBe('COMPLETED');
    }
  }, 60_000);

  it('replays a history recorded before the provision-every-admin-tier patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.TIERS_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (TIERS_FIXTURE_WORKFLOWS = an index of the pre-patch workflows)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        await pre.env.connection.operatorService.addSearchAttributes({
          namespace: pre.env.namespace ?? 'default',
          searchAttributes: {
            TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
          },
        });
        const handle = await onboard(pre, PRE_PATCH_WORKFLOW_ID);
        await handle.result();
        // The pre-patch code: one child, the first operation's tier
        expect(getOrCreateLinkedAdminIdentity.mock.calls.map(([, tier]) => tier)).toEqual([
          'TIER_2',
        ]);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
