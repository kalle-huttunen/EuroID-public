/**
 * adminAccountProvisioningWorkflow and the standing state of a linked admin account (disabled
 * outside a privileged session), end to end on the time-skipping Temporal test server. Opt-in
 * via TEMPORAL_E2E=1.
 *
 * The connector mappers create a linked admin account disabled (shared/utils/linked-admin-profile.ts).
 * Provisioning can still leave one enabled: an account it updated with a session state that has
 * changed since it read the profile, an AD account it found existing (provisioning does not touch
 * its userAccountControl). So once the targets are provisioned the run asks for a disable-only
 * privileged session run (settleAdminAccountState), which the activity starts unless a session
 * of the admin identity is open.
 *
 * Proves (patch admin-account-provisioning:settle-standing-state):
 *   - After the targets are provisioned, settleAdminAccountState runs once for the admin
 *     identity; a run that provisioned nothing does not call it.
 *   - A history recorded before the patch still replays.
 *
 * Fixture test/fixtures/admin-account-provisioning-pre-settle-standing-state.history.json was
 * recorded with the pre-patch workflow (commit b56b5d71), from backend/:
 *   git show b56b5d71:backend/src/workflows/admin-account-provisioning.workflow.ts \
 *     > src/workflows/admin-account-provisioning-pre-settle.workflow.ts
 *   TEMPORAL_E2E=1 SETTLE_FIXTURE_WORKFLOW=src/workflows/admin-account-provisioning-pre-settle.workflow.ts \
 *     npx jest -c test/jest-e2e.json admin-account-provisioning-standing-state -t 'records the pre-patch fixture'
 *   rm src/workflows/admin-account-provisioning-pre-settle.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { adminAccountProvisioningWorkflow } from '../../src/workflows/admin-account-provisioning.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/admin-account-provisioning.workflow.ts',
);
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/admin-account-provisioning-pre-settle-standing-state.history.json',
);
const TENANT = 'tenant-a';

const adminProfile = {
  email: 'adm-ada@example.com',
  firstName: 'Ada',
  lastName: 'Admin',
  employmentType: 'ADMIN_ACCOUNT',
  sourceSystem: 'euroid-pam',
  status: 'PENDING',
};
const roleOp = (target: string) => ({
  type: 'role',
  action: 'add',
  target,
  targetId: '62e90394-69f5-4237-9190-012177145e10',
  sourcePolicy: 'pam-policy',
  adminTier: 'TIER_0' as const,
});
const input = (target = 'entra') => ({
  parentIdentityId: 'parent-1',
  adminTier: 'TIER_0',
  adminOperations: [roleOp(target)],
  tenantId: TENANT,
});

describeTemporalE2E('adminAccountProvisioningWorkflow: standing state (e2e)', () => {
  let harness: WorkflowTestHarness;
  const order: string[] = [];
  const settleAdminAccountState = jest.fn();
  const provisionUserToEntra = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getOrCreateLinkedAdminIdentity: async () => ({ adminIdentityId: 'admin-1', adminProfile }),
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      setProvisioningStatus: async (...args: unknown[]) => {
        order.push(`status:${String(args[2])}`);
      },
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      recordProvisioningOutcome: async () => undefined,
      settleAdminAccountState: (...args: unknown[]) => settleAdminAccountState(...args),
    },
    queueWorkers: [
      {
        taskQueue: 'provisioning-entra',
        activities: {
          provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
          // Patch admin-account-provisioning:entra-not-configured (its own suite)
          isEntraConfigured: async () => true,
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
    order.length = 0;
    settleAdminAccountState.mockReset().mockImplementation(async () => {
      order.push('settle');
      return true;
    });
    provisionUserToEntra.mockReset().mockImplementation(async () => {
      order.push('provision');
      return { success: true, objectId: 'entra-admin-1' };
    });
  });

  const run = (id: string, target?: string) =>
    harness.env.client.workflow.execute(adminAccountProvisioningWorkflow, {
      args: [input(target)],
      taskQueue: harness.taskQueue,
      workflowId: `admin-provisioning-e2e-standing-${id}`,
    });

  it('asks for a disable-only run once the targets are provisioned', async () => {
    await expect(run('settle')).resolves.toBe('Admin account adm-ada@example.com provisioned.');

    expect(settleAdminAccountState).toHaveBeenCalledTimes(1);
    expect(settleAdminAccountState).toHaveBeenCalledWith(
      'admin-1',
      TENANT,
      'admin-provisioning-e2e-standing-settle',
    );
    expect(order).toEqual(['status:SYNCING', 'provision', 'status:SYNCED', 'settle']);
  }, 60_000);

  it('asks for nothing when no target was provisioned', async () => {
    // The admin operation targets AD, which is not on the canvas
    await run('nothing', 'ad');
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(settleAdminAccountState).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the settle-standing-state patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.SETTLE_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (SETTLE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(adminAccountProvisioningWorkflow, {
          args: [input()],
          taskQueue: pre.taskQueue,
          workflowId: 'admin-provisioning-e2e-pre-settle-standing-state',
        });
        await handle.result();
        expect(settleAdminAccountState).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
