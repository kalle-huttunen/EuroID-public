/**
 * End-to-end test for adminAccountProvisioningWorkflow's Okta and SCIM calls on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * worker.ts registers Okta and SCIM activities only on their plugin queues (provisioning-okta,
 * provisioning-scim), never on the default queue. Here the default-queue worker has no Okta or
 * SCIM activities either, so a call routed to the default queue fails the run.
 *
 * Proves:
 *   - The admin account is provisioned to Okta and SCIM on their own queues.
 *   - provisionUserToScim gets (config, user, tenantId, correlationId), with the SCIM config
 *     from the canvas.
 *   - A history recorded by the pre-patch code (Okta and SCIM on the default queue, SCIM called
 *     with the provisionUserToX argument order) still replays against the current code.
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
const OLD_HISTORY = path.resolve(
  __dirname,
  '../fixtures/admin-account-provisioning-pre-queue-routing.history.json',
);

const adminProfile = { email: 'adm-ada@example.com', firstName: 'Ada', lastName: 'Admin' };
const adminOp = (target: string) => ({
  type: 'group',
  action: 'add',
  target,
  targetId: `${target}-admins`,
  sourcePolicy: 'pam-policy',
  adminTier: 'TIER_1' as const,
});
const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };

describeTemporalE2E('adminAccountProvisioningWorkflow connector queues (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getConnectorConfig = jest.fn();
  const setProvisioningStatus = jest.fn();
  const provisionUserToOkta = jest.fn();
  const provisionUserToScim = jest.fn();

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: 'provisioning-default',
      activities: {
        getOrCreateLinkedAdminIdentity: async () => ({ adminIdentityId: 'admin-1', adminProfile }),
        getActiveTargetSystems: async () => ['okta', 'scim'],
        getConnectorConfig: (...args: unknown[]) => getConnectorConfig(...args),
        setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
        writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
        recordProvisioningOutcome: async () => undefined,
        // Patch admin-account-provisioning:settle-standing-state (its own suite)
        settleAdminAccountState: async () => true,
      },
      queueWorkers: [
        {
          taskQueue: 'provisioning-okta',
          activities: { provisionUserToOkta: (...args: unknown[]) => provisionUserToOkta(...args) },
        },
        {
          taskQueue: 'provisioning-scim',
          activities: { provisionUserToScim: (...args: unknown[]) => provisionUserToScim(...args) },
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    getConnectorConfig
      .mockReset()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    provisionUserToOkta.mockReset().mockResolvedValue({ success: true, oktaUserId: 'okta-1' });
    provisionUserToScim.mockReset().mockResolvedValue({ success: true, targetUserId: 'scim-1' });
  });

  it('provisions the admin account to Okta and SCIM on their own queues', async () => {
    const workflowId = 'admin-provisioning-e2e-okta-scim';
    await expect(
      harness.env.client.workflow.execute(adminAccountProvisioningWorkflow, {
        args: [
          {
            parentIdentityId: 'parent-1',
            adminTier: 'TIER_1',
            adminOperations: [adminOp('okta'), adminOp('scim')],
            tenantId: 'tenant-a',
          },
        ],
        taskQueue: harness.taskQueue,
        workflowId,
      }),
    ).resolves.toBe('Admin account adm-ada@example.com provisioned.');

    const { adminTier: _okta, ...oktaOp } = adminOp('okta');
    expect(provisionUserToOkta).toHaveBeenCalledTimes(1);
    expect(provisionUserToOkta).toHaveBeenCalledWith(
      adminProfile,
      { operations: [oktaOp] },
      undefined,
      'tenant-a',
      workflowId,
    );
    expect(getConnectorConfig).toHaveBeenCalledWith('scim', 'tenant-a', workflowId);
    expect(provisionUserToScim).toHaveBeenCalledTimes(1);
    expect(provisionUserToScim).toHaveBeenCalledWith(
      scimConfig,
      adminProfile,
      'tenant-a',
      workflowId,
    );
    expect(setProvisioningStatus.mock.calls.map(([, system, status]) => [system, status])).toEqual([
      ['okta', 'SYNCING'],
      ['okta', 'SYNCED'],
      ['scim', 'SYNCING'],
      ['scim', 'SYNCED'],
    ]);
  }, 60_000);

  it('replays a history recorded before the queue-routing patch', async () => {
    const history = JSON.parse(fs.readFileSync(OLD_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);
});
