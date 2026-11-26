/**
 * Onboarding gives the directory roles a policy assigns, end to end on the time-skipping Temporal
 * test server. Opt-in via TEMPORAL_E2E=1. The real onboardingWorkflow runs with stubbed activities;
 * provisionUserToEntra and provisionUserToAd are mocks on their own queues.
 *
 * Proves:
 *   - A non-admin directory role from a policy (`assign_role`: a `role` operation on Entra ID or
 *     `all`) reaches provisionUserToEntra with the groups and licenses. Entra ID provisioning makes
 *     it and reports it applied, unchanged or failed (EntraEntitlementsService.syncDirectoryRoles).
 *     Before, onboarding passed only groups and licenses, so the role was never given.
 *   - Active Directory still gets groups and licenses only: the AD connector has no directory
 *     roles (AdActivities.provisionUserToAd applies group additions only).
 *   - Only the activity arguments changed, so a history recorded before the change replays
 *     without a patch.
 *
 * Fixture test/fixtures/onboarding-pre-entra-roles.history.json was recorded with the workflow
 * before the change (commit 817b568b), from backend/:
 *   git show 817b568b:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-entra-roles.workflow.ts
 *   TEMPORAL_E2E=1 ENTRA_ROLES_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-entra-roles.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-entra-roles -t 'records the pre-change fixture'
 *   rm src/workflows/onboarding-pre-entra-roles.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/onboarding.workflow.ts');
const PRE_CHANGE_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-entra-roles.history.json',
);
const TENANT = 'tenant-a';
const REPORTS_READER = '4a5d8f65-41da-4de4-8968-e035b65339cf';
const HELPDESK = '729827e3-9c14-49f7-bb1b-9608f156bbb8';

const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const operations = [
  { target: 'all', type: 'group', action: 'add', targetId: 'All Staff' },
  { target: 'entra-id', type: 'role', action: 'add', targetId: REPORTS_READER },
  { target: 'all', type: 'role', action: 'add', targetId: HELPDESK },
  { target: 'entra-id', type: 'license', action: 'add', targetId: 'sku-e3' },
  { target: 'active-directory', type: 'group', action: 'add', targetId: 'CN=Staff,DC=corp' },
  { target: 'entra-id', type: 'attribute', action: 'set', targetId: 'department' },
];

describeTemporalE2E('onboarding: directory roles from policies (e2e)', () => {
  let harness: WorkflowTestHarness;
  const provisionUserToEntra = jest.fn();
  const provisionUserToAd = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra', 'ad'],
      // AD has a canvas config: an AD node without one is left out (onboarding:ad-not-configured)
      getConnectorConfig: async (id: unknown) => (id === 'ad' ? { host: 'dc1.corp' } : null),
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      setProvisioningStatus: async () => undefined,
      evaluateUser: async () => ({ operations }),
      // No target excluded by an access review (patch onboarding:review-exclusions)
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
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
      {
        taskQueue: 'provisioning-ad',
        activities: {
          checkAdHealth: async () => true,
          provisionUserToAd: (...args: unknown[]) => provisionUserToAd(...args),
        },
      },
    ],
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    provisionUserToAd.mockReset().mockResolvedValue({ success: true });
  });

  /** The operations each provisioning activity received, as type:targetId. */
  const passed = (activity: jest.Mock) =>
    (
      activity.mock.calls[0][1] as { operations: Array<{ type: string; targetId: string }> }
    ).operations.map((op) => `${op.type}:${op.targetId}`);

  it("gives Entra ID the policy's directory roles with its groups and licenses", async () => {
    await harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: 'onboarding-e2e-entra-roles',
    });

    expect(passed(provisionUserToEntra)).toEqual([
      'group:All Staff',
      `role:${REPORTS_READER}`,
      `role:${HELPDESK}`,
      'license:sku-e3',
    ]);
    // AD has no directory roles
    expect(passed(provisionUserToAd)).toEqual(['group:All Staff', 'group:CN=Staff,DC=corp']);
  }, 60_000);

  it('replays a history recorded before Entra ID got the directory roles (no patch)', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_CHANGE_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ENTRA_ROLES_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-change fixture (ENTRA_ROLES_FIXTURE_WORKFLOW = the pre-change workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-entra-roles',
        });
        await handle.result();
        // Before the change Entra ID got no role
        expect(passed(provisionUserToEntra)).toEqual(['group:All Staff', 'license:sku-e3']);
        fs.writeFileSync(PRE_CHANGE_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
