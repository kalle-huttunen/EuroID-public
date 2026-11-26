/**
 * End-to-end test for onboardingWorkflow's Okta and SCIM calls on the time-skipping Temporal
 * test server. Opt-in via TEMPORAL_E2E=1.
 *
 * worker.ts registers Okta and SCIM activities only on their plugin queues (provisioning-okta,
 * provisioning-scim), never on the default queue. Here the default-queue worker has no Okta or
 * SCIM activities either, so a call routed to the default queue fails the run.
 *
 * Proves:
 *   - Okta and SCIM health checks and provisioning run on their own queues.
 *   - provisionUserToScim gets (config, user, tenantId, correlationId), with the SCIM config
 *     from the canvas, and the health check gets that config too.
 *   - A history recorded by the pre-patch code (Okta and SCIM on the default queue, SCIM called
 *     with the provisionUserToX argument order) still replays against the current code.
 *   - The Okta and SCIM ids are written back to the identity (writebackToIdentity with objectId)
 *     whenever no writeback has completed for the target, not only for PENDING entries; a
 *     history recorded before that patch (no writeback for a non-PENDING entry) still replays.
 *   - A history recorded before the patch onboarding:skip-synced-targets, which provisions a
 *     target already SYNCED with its writeback complete again, still replays.
 *
 * Fixture test/fixtures/onboarding-pre-skip-synced.history.json was recorded with the pre-patch
 * workflow (commit d0b4d064), from backend/:
 *   git show d0b4d064:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-skip-synced.workflow.ts
 *   TEMPORAL_E2E=1 ONBOARDING_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-skip-synced.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-connector-queues -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-skip-synced.workflow.ts
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
const OLD_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-queue-routing.history.json',
);
const PRE_WRITEBACK_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-writeback-complete.history.json',
);
const PRE_SKIP_SYNCED_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-skip-synced.history.json',
);

const user = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  departmentName: 'Engineering',
};
const oktaOp = { target: 'okta', type: 'group', action: 'add', targetId: 'okta-engineering' };
const scimOp = { target: 'scim', type: 'group', action: 'add', targetId: 'scim-engineering' };
const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };

describeTemporalE2E('onboardingWorkflow connector queues (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getConnectorConfig = jest.fn();
  const checkOktaHealth = jest.fn();
  const provisionUserToOkta = jest.fn();
  const checkScimHealth = jest.fn();
  const provisionUserToScim = jest.fn();
  const getIdentityByEmail = jest.fn();
  const writebackToIdentity = jest.fn();
  const setProvisioningStatus = jest.fn();

  /** The default-queue worker's activities and the Okta and SCIM queue workers. */
  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['okta', 'scim'],
      getConnectorConfig: (...args: unknown[]) => getConnectorConfig(...args),
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: (...args: unknown[]) => getIdentityByEmail(...args),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [oktaOp, scimOp] }),
      // No target excluded by an access review (patch onboarding:review-exclusions)
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: (...args: unknown[]) => writebackToIdentity(...args),
      writebackToHrSource: async () => undefined,
    },
    queueWorkers: [
      {
        taskQueue: 'provisioning-okta',
        activities: {
          checkOktaHealth: (...args: unknown[]) => checkOktaHealth(...args),
          provisionUserToOkta: (...args: unknown[]) => provisionUserToOkta(...args),
        },
      },
      {
        taskQueue: 'provisioning-scim',
        activities: {
          checkScimHealth: (...args: unknown[]) => checkScimHealth(...args),
          provisionUserToScim: (...args: unknown[]) => provisionUserToScim(...args),
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
    getConnectorConfig
      .mockReset()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    checkOktaHealth.mockReset().mockResolvedValue(true);
    provisionUserToOkta
      .mockReset()
      .mockResolvedValue({ success: true, oktaUserId: 'okta-1', objectId: 'okta-1' });
    checkScimHealth.mockReset().mockResolvedValue({ healthy: true });
    provisionUserToScim
      .mockReset()
      .mockResolvedValue({ success: true, targetUserId: 'scim-1', objectId: 'scim-1' });
    getIdentityByEmail.mockReset().mockResolvedValue({
      _id: 'identity-1',
      profile: user,
      provisioning: [
        { targetSystem: 'okta', status: 'PENDING' },
        { targetSystem: 'scim', status: 'PENDING' },
      ],
    });
    writebackToIdentity.mockReset().mockResolvedValue({ success: true, updatedFields: [] });
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: 'tenant-a', targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-${id}`,
    });

  it('runs Okta and SCIM activities on their own queues with the activity signatures', async () => {
    const workflowId = 'onboarding-e2e-okta-scim';
    await expect(run('okta-scim')).resolves.toContain('Dynamic onboarding complete');

    expect(checkOktaHealth).toHaveBeenCalledWith(undefined, 'tenant-a', workflowId);
    expect(provisionUserToOkta).toHaveBeenCalledTimes(1);
    expect(provisionUserToOkta).toHaveBeenCalledWith(
      user,
      { operations: [oktaOp] },
      undefined,
      'tenant-a',
      workflowId,
    );
    expect(getConnectorConfig).toHaveBeenCalledWith('scim', 'tenant-a', workflowId);
    expect(checkScimHealth).toHaveBeenCalledWith(scimConfig, 'tenant-a', workflowId);
    expect(provisionUserToScim).toHaveBeenCalledTimes(1);
    expect(provisionUserToScim).toHaveBeenCalledWith(scimConfig, user, 'tenant-a', workflowId);
  }, 60_000);

  it('fails the run when the SCIM health check reports unhealthy', async () => {
    checkScimHealth.mockResolvedValue({ healthy: false, error: 'connection refused' });

    await expect(run('scim-unhealthy')).rejects.toThrow();
    expect(checkScimHealth).toHaveBeenCalledTimes(1);
    expect(provisionUserToScim).not.toHaveBeenCalled();
    expect(provisionUserToOkta).not.toHaveBeenCalled();
  }, 60_000);

  it('writes the Okta and SCIM ids back to an identity with no provisioning entry yet', async () => {
    getIdentityByEmail.mockResolvedValue({ _id: 'identity-1', profile: user, provisioning: [] });

    await expect(run('writeback')).resolves.toContain('Dynamic onboarding complete');

    expect(writebackToIdentity).toHaveBeenCalledTimes(2);
    expect(writebackToIdentity).toHaveBeenCalledWith(
      'identity-1',
      'okta',
      expect.objectContaining({ objectId: 'okta-1' }),
      'tenant-a',
      'onboarding-e2e-writeback',
    );
    expect(writebackToIdentity).toHaveBeenCalledWith(
      'identity-1',
      'scim',
      expect.objectContaining({ objectId: 'scim-1' }),
      'tenant-a',
      'onboarding-e2e-writeback',
    );
    // SYNCED with the writeback complete, so the next run skips the target
    for (const system of ['okta', 'scim']) {
      expect(setProvisioningStatus).toHaveBeenCalledWith(
        'identity-1',
        system,
        'SYNCED',
        undefined,
        'tenant-a',
        true,
        undefined,
        'onboarding-e2e-writeback',
      );
    }
  }, 60_000);

  it('replays a history recorded before the writeback-until-complete patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_WRITEBACK_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('replays a history recorded before the queue-routing patch', async () => {
    const history = JSON.parse(fs.readFileSync(OLD_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /** Okta already SYNCED with its writeback complete, SCIM not provisioned yet. */
  const oktaDone = {
    _id: 'identity-1',
    profile: user,
    provisioning: [
      { targetSystem: 'okta', status: 'SYNCED', writebackComplete: true },
      { targetSystem: 'scim', status: 'PENDING' },
    ],
  };

  it('provisions only the target that is not SYNCED yet', async () => {
    // SCIM's entry is ERROR from an earlier failed run: provisioned again
    getIdentityByEmail.mockResolvedValue({
      ...oktaDone,
      provisioning: [oktaDone.provisioning[0], { targetSystem: 'scim', status: 'ERROR' }],
    });

    await expect(run('skip-synced')).resolves.toContain('Dynamic onboarding complete');

    expect(provisionUserToOkta).not.toHaveBeenCalled();
    expect(provisionUserToScim).toHaveBeenCalledTimes(1);
    // The skipped target's entry is left as it is
    expect(setProvisioningStatus.mock.calls.filter(([, system]) => system === 'okta')).toEqual([]);
  }, 60_000);

  it('replays a history recorded before the skip-synced patch (Okta provisioned again)', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_SKIP_SYNCED_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ONBOARDING_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ONBOARDING_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      getIdentityByEmail.mockResolvedValue(oktaDone);
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: 'tenant-a' } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-skip-synced',
        });
        await handle.result();
        // The pre-patch code provisions the SYNCED Okta target again
        expect(provisionUserToOkta).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_SKIP_SYNCED_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
