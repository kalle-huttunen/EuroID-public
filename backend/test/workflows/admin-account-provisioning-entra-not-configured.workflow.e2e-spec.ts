/**
 * adminAccountProvisioningWorkflow when Entra ID has no config anywhere, end to end on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Onboarding leaves an Entra ID without any config out of the person's own run
 * (isEntraConfigured), but its admin provisioning child read the canvas targets and called
 * provisionUserToEntra anyway: the child failed, and since onboarding awaits it, so did the
 * person's onboarding, before any of their own accounts was provisioned.
 *
 * Proves (patch admin-account-provisioning:entra-not-configured):
 *   - Without an Entra ID config the admin account is not provisioned there (no SYNCING entry,
 *     no provisioning call) and the run goes on to the other targets and completes.
 *   - With one, Entra ID is provisioned as before.
 *   - A history recorded before the patch (test/fixtures/admin-account-provisioning-pre-settle-
 *     standing-state.history.json, recorded at commit b56b5d71 with an Entra ID provisioning)
 *     still replays.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { adminAccountProvisioningWorkflow } from '../../src/workflows/admin-account-provisioning.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/admin-account-provisioning.workflow.ts',
);
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/admin-account-provisioning-pre-settle-standing-state.history.json',
);
const TENANT = 'tenant-a';
const adminProfile = { email: 'adm-ada@example.com', firstName: 'Ada', lastName: 'Admin' };
const op = (target: string) => ({
  type: 'group',
  action: 'add',
  target,
  targetId: `${target}-admins`,
  sourcePolicy: 'pam-policy',
  adminTier: 'TIER_1' as const,
});

describeTemporalE2E('adminAccountProvisioningWorkflow: Entra ID not configured (e2e)', () => {
  let harness: WorkflowTestHarness;
  const statuses: Array<[string, string]> = [];
  const isEntraConfigured = jest.fn();
  const provisionUserToEntra = jest.fn();
  const provisionUserToAd = jest.fn();

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: 'provisioning-default',
      activities: {
        getOrCreateLinkedAdminIdentity: async () => ({ adminIdentityId: 'admin-1', adminProfile }),
        getActiveTargetSystems: async () => ['entra', 'ad'],
        getConnectorConfig: async (id: unknown) => (id === 'ad' ? { host: 'dc.corp' } : null),
        setProvisioningStatus: async (...args: unknown[]) => {
          statuses.push([String(args[1]), String(args[2])]);
        },
        writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
        recordProvisioningOutcome: async () => undefined,
        settleAdminAccountState: async () => true,
      },
      queueWorkers: [
        {
          taskQueue: 'provisioning-entra',
          activities: {
            isEntraConfigured: (...args: unknown[]) => isEntraConfigured(...args),
            provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
          },
        },
        {
          taskQueue: 'provisioning-ad',
          activities: { provisionUserToAd: (...args: unknown[]) => provisionUserToAd(...args) },
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    statuses.length = 0;
    isEntraConfigured.mockReset();
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    provisionUserToAd.mockReset().mockResolvedValue({ success: true, objectId: 'CN=adm' });
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(adminAccountProvisioningWorkflow, {
      args: [
        {
          parentIdentityId: 'parent-1',
          adminTier: 'TIER_1',
          adminOperations: [op('all')],
          tenantId: TENANT,
        },
      ],
      taskQueue: harness.taskQueue,
      workflowId: `admin-provisioning-e2e-entra-config-${id}`,
    });

  it('leaves Entra ID out without a config and provisions the other targets', async () => {
    isEntraConfigured.mockResolvedValue(false);

    await expect(run('none')).resolves.toBe('Admin account adm-ada@example.com provisioned.');

    expect(isEntraConfigured).toHaveBeenCalledWith(
      undefined,
      TENANT,
      'admin-provisioning-e2e-entra-config-none',
    );
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(provisionUserToAd).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      ['ad', 'SYNCING'],
      ['ad', 'SYNCED'],
    ]);
  }, 60_000);

  it('provisions Entra ID as before when it has a config', async () => {
    isEntraConfigured.mockResolvedValue(true);

    await run('configured');

    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      ['entra', 'SYNCING'],
      ['entra', 'SYNCED'],
      ['ad', 'SYNCING'],
      ['ad', 'SYNCED'],
    ]);
  }, 60_000);

  it('replays a history recorded before the entra-not-configured patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);
});
