/**
 * Onboarding whose Entra ID provisioning created the account but did not make a group, directory
 * role or license change, end to end on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with stubbed default-queue activities;
 * the Entra ID queue's provisionUserToEntra is a mock that fails as the real activity does
 * (activities/entra-changes-failure.ts): EntraChangesFailed, not retryable, the created account
 * in the details.
 *
 * Proves:
 *   - The created account is written back to the identity before the target is marked ERROR,
 *     and the run fails: the next run finds and updates that account, never creating another.
 *   - A failure without a created account (the account existed, or any other failure) writes
 *     nothing back and marks the target ERROR, as before.
 *   - A history recorded before the patch onboarding:entra-created-account-writeback, with such
 *     a failure, still replays.
 *
 * Fixture test/fixtures/onboarding-pre-entra-created-writeback.history.json was recorded with the
 * pre-patch workflow (commit 922cc9f3), from backend/:
 *   git show 922cc9f3:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-entra-created-writeback.workflow.ts
 *   TEMPORAL_E2E=1 ENTRA_CREATED_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-entra-created-writeback.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-entra-created-account -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-entra-created-writeback.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
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
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-entra-created-writeback.history.json',
);
const TENANT = 'tenant-a';

const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'Finance Team' };
const REASON =
  'entra-id: 1 of 1 changes failed (add group Finance Team: No Entra ID group has the id or ' +
  'display name "Finance Team"). The other changes were made or were already as requested.';
const CREATED = {
  objectId: 'entra-new',
  generatedAttributes: {
    mail: 'ada.lovelace@corp.test',
    userPrincipalName: 'ada.lovelace@corp.test',
  },
};

describeTemporalE2E('onboarding: Entra ID created the account, a change failed (e2e)', () => {
  let harness: WorkflowTestHarness;
  const setProvisioningStatus = jest.fn();
  const writebackToIdentity = jest.fn();
  const provisionUserToEntra = jest.fn();

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
      evaluateUser: async () => ({ operations: [groupOp] }),
      // No target excluded by an access review (patch onboarding:review-exclusions)
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: (...args: unknown[]) => writebackToIdentity(...args),
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
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-entra-created-${id}`,
    });

  const entraStatuses = () =>
    setProvisioningStatus.mock.calls
      .filter(([, target]) => target === 'entra')
      .map(([, , status]) => status);

  it('writes the created account back, then marks Entra ID ERROR and fails the run', async () => {
    const error = await run('created').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1); // not retried
    expect(writebackToIdentity).toHaveBeenCalledTimes(1);
    expect(writebackToIdentity).toHaveBeenCalledWith(
      'identity-1',
      'entra-id',
      CREATED,
      TENANT,
      'onboarding-e2e-entra-created-created',
    );
    expect(entraStatuses()).toEqual(['SYNCING', 'ERROR']);
    const errorCall = setProvisioningStatus.mock.calls.findIndex(([, , s]) => s === 'ERROR');
    expect(writebackToIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      setProvisioningStatus.mock.invocationCallOrder[errorCall],
    );
    // The entry says why: the activity's reason, not ActivityFailure's "Activity task failed"
    expect(setProvisioningStatus.mock.calls[errorCall][3]).toBe(REASON);
  }, 60_000);

  it('still marks Entra ID ERROR when that writeback fails', async () => {
    writebackToIdentity.mockRejectedValue(ApplicationFailure.nonRetryable('Hub down'));

    await expect(run('writeback-fails')).rejects.toBeInstanceOf(WorkflowFailedError);

    expect(entraStatuses()).toEqual(['SYNCING', 'ERROR']);
  }, 60_000);

  it('writes nothing back when the failure carries no created account', async () => {
    provisionUserToEntra.mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable(REASON, 'EntraChangesFailed');
    });

    await expect(run('existing')).rejects.toBeInstanceOf(WorkflowFailedError);

    expect(writebackToIdentity).not.toHaveBeenCalled();
    expect(entraStatuses()).toEqual(['SYNCING', 'ERROR']);
  }, 60_000);

  it('replays a history recorded before the patch onboarding:entra-created-account-writeback', async () => {
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
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-entra-created-writeback',
        });
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
        expect(writebackToIdentity).not.toHaveBeenCalled();
        expect(entraStatuses()).toEqual(['SYNCING', 'ERROR']);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
