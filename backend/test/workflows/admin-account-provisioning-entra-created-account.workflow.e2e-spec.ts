/**
 * adminAccountProvisioningWorkflow whose Entra ID provisioning created the admin account but did
 * not make a directory role (or group, license) change, end to end on the time-skipping Temporal
 * test server. Opt-in via TEMPORAL_E2E=1.
 *
 * provisionUserToEntra on the Entra ID queue is a mock that fails as the real activity does
 * (activities/entra-changes-failure.ts): EntraChangesFailed, not retryable, the created account
 * in the details.
 *
 * Proves:
 *   - The created admin account is written back to the admin identity before the target is
 *     marked ERROR, and the run fails: the next run updates that account instead of creating
 *     another.
 *   - A failure without a created account writes nothing back.
 *   - A history recorded before the patch admin-account-provisioning:entra-created-account-
 *     writeback, with such a failure, still replays.
 *
 * Fixture test/fixtures/admin-account-provisioning-pre-entra-created-writeback.history.json was
 * recorded with the pre-patch workflow (commit 922cc9f3), from backend/:
 *   git show 922cc9f3:backend/src/workflows/admin-account-provisioning.workflow.ts \
 *     > src/workflows/admin-account-provisioning-pre-entra-created-writeback.workflow.ts
 *   TEMPORAL_E2E=1 ENTRA_CREATED_FIXTURE_WORKFLOW=src/workflows/admin-account-provisioning-pre-entra-created-writeback.workflow.ts \
 *     npx jest -c test/jest-e2e.json admin-account-provisioning-entra-created -t 'records the pre-patch fixture'
 *   rm src/workflows/admin-account-provisioning-pre-entra-created-writeback.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
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
  '../fixtures/admin-account-provisioning-pre-entra-created-writeback.history.json',
);
const TENANT = 'tenant-a';

const adminProfile = { email: 'adm-ada@example.com', firstName: 'Ada', lastName: 'Admin' };
const roleOp = {
  type: 'role',
  action: 'add',
  target: 'entra',
  targetId: '62e90394-69f5-4237-9190-012177145e10',
  sourcePolicy: 'pam-policy',
  adminTier: 'TIER_0' as const,
};
const REASON =
  'entra-id: 1 of 1 changes failed (add role 62e90394-69f5-4237-9190-012177145e10: Entra API ' +
  'Error (HTTP 403): Authorization_RequestDenied). The other changes were made or were already ' +
  'as requested.';
const CREATED = { objectId: 'entra-admin-new', generatedAttributes: { mail: 'adm-ada@corp.test' } };
const input = {
  parentIdentityId: 'parent-1',
  adminTier: 'TIER_0',
  adminOperations: [roleOp],
  tenantId: TENANT,
};

describeTemporalE2E('adminAccountProvisioningWorkflow: Entra ID created the account (e2e)', () => {
  let harness: WorkflowTestHarness;
  const setProvisioningStatus = jest.fn();
  const writebackToIdentity = jest.fn();
  const provisionUserToEntra = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getOrCreateLinkedAdminIdentity: async () => ({ adminIdentityId: 'admin-1', adminProfile }),
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      writebackToIdentity: (...args: unknown[]) => writebackToIdentity(...args),
      recordProvisioningOutcome: async () => undefined,
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
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    writebackToIdentity.mockReset().mockResolvedValue({ success: true, updatedFields: [] });
    provisionUserToEntra.mockReset().mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable(REASON, 'EntraChangesFailed', CREATED);
    });
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(adminAccountProvisioningWorkflow, {
      args: [input],
      taskQueue: harness.taskQueue,
      workflowId: `admin-provisioning-e2e-entra-created-${id}`,
    });

  const statuses = () => setProvisioningStatus.mock.calls.map(([, system, s]) => [system, s]);

  it('writes the created admin account back, then marks Entra ID ERROR', async () => {
    await expect(run('created')).rejects.toBeInstanceOf(WorkflowFailedError);

    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(writebackToIdentity).toHaveBeenCalledWith('admin-1', 'entra-id', CREATED, TENANT);
    expect(statuses()).toEqual([
      ['entra', 'SYNCING'],
      ['entra', 'ERROR'],
    ]);
    expect(writebackToIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      setProvisioningStatus.mock.invocationCallOrder[1],
    );
    // The entry says why: the activity's reason, not ActivityFailure's "Activity task failed"
    expect(setProvisioningStatus.mock.calls[1][3]).toBe(REASON);
  }, 60_000);

  it('writes nothing back when the failure carries no created account', async () => {
    provisionUserToEntra.mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable(REASON, 'EntraChangesFailed');
    });

    await expect(run('existing')).rejects.toBeInstanceOf(WorkflowFailedError);

    expect(writebackToIdentity).not.toHaveBeenCalled();
    expect(statuses()).toEqual([
      ['entra', 'SYNCING'],
      ['entra', 'ERROR'],
    ]);
  }, 60_000);

  it('replays a history recorded before the entra-created-account-writeback patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ENTRA_CREATED_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ENTRA_CREATED_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // The failure carries the created account, which the pre-patch code does not write back
        const handle = await pre.env.client.workflow.start(adminAccountProvisioningWorkflow, {
          args: [input],
          taskQueue: pre.taskQueue,
          workflowId: 'admin-provisioning-e2e-pre-entra-created-writeback',
        });
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
        expect(writebackToIdentity).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
