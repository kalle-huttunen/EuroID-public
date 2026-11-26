/**
 * Onboarding when a target answers without having done its work, end to end on the time-skipping
 * Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * provisionUserToAd answers `{ success: false, skipped: true, error }` without throwing when its
 * config lacks a host or a base DN, and writebackToIdentity answers `{ success: false }` when the
 * identity is gone. Before the patch onboarding:unprovisioned-not-synced the workflow read
 * neither answer: AD got SYNCED with no account (the mover then counted AD as provisioned, and
 * offboarding failed on the missing DN for good), the circuit breaker counted a success, and the
 * written-back target got `writebackComplete`, so its account id was never written back again.
 *
 * Proves, for runs started now:
 *   - A provision that answers `success: false` leaves the target ERROR with the target's own
 *     reason, records no provisioning outcome for it, goes on with the other targets, and the
 *     result names the target and the reason.
 *   - A write-back that answers `success: false` leaves the target SYNCED without
 *     `writebackComplete`, so the next run provisions and writes back again.
 *   - A history recorded before the patch (AD SYNCED after the skip, the write-back complete)
 *     still replays.
 *
 * Fixture test/fixtures/onboarding-pre-unprovisioned-not-synced.history.json was recorded with the
 * pre-patch workflow (commit 9f3c929c), from backend/:
 *   git show 9f3c929c:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-unprovisioned.workflow.ts
 *   git show 9f3c929c:backend/src/workflows/onboarding-health-check.ts \
 *     > src/workflows/onboarding-health-check-pre-unprovisioned.ts
 *   sed -i "s#'./onboarding-health-check'#'./onboarding-health-check-pre-unprovisioned'#" \
 *     src/workflows/onboarding-pre-unprovisioned.workflow.ts
 *   TEMPORAL_E2E=1 UNPROVISIONED_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-unprovisioned.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-unprovisioned-not-synced -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-unprovisioned.workflow.ts \
 *     src/workflows/onboarding-health-check-pre-unprovisioned.ts
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
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-unprovisioned-not-synced.history.json',
);
const TENANT = 'tenant-a';
const AD_SKIP_REASON = 'AD config missing host or baseDn';

const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };

describeTemporalE2E('onboarding: a target that answers without doing its work (e2e)', () => {
  let harness: WorkflowTestHarness;
  const setProvisioningStatus = jest.fn();
  const recordProvisioningOutcome = jest.fn();
  const writebackToIdentity = jest.fn();
  const provisionUserToEntra = jest.fn();
  const provisionUserToAd = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra', 'ad'],
      // AD has a canvas node with a config, so the health check passes it
      getConnectorConfig: async (id: unknown) => (id === 'ad' ? { host: 'dc1.corp' } : null),
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: (...args: unknown[]) => recordProvisioningOutcome(...args),
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [groupOp] }),
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
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    recordProvisioningOutcome.mockReset().mockResolvedValue(undefined);
    // The identity is gone by the time the account id is written back
    writebackToIdentity.mockReset().mockResolvedValue({ success: false, updatedFields: [] });
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    provisionUserToAd
      .mockReset()
      .mockResolvedValue({ success: false, skipped: true, error: AD_SKIP_REASON });
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-unprovisioned-${id}`,
    });

  /** [status, errorMsg, writebackComplete] per setProvisioningStatus call for the system. */
  const entriesFor = (system: string) =>
    setProvisioningStatus.mock.calls
      .filter(([, target]) => target === system)
      .map(([, , status, errorMsg, , writebackComplete]) => [status, errorMsg, writebackComplete]);

  it('leaves a target that skipped its provision ERROR with the reason, never SYNCED', async () => {
    await expect(run('skipped')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}. Not provisioned to ad: ${AD_SKIP_REASON}.`,
    );

    expect(provisionUserToAd).toHaveBeenCalledTimes(1);
    expect(entriesFor('ad')).toEqual([
      ['SYNCING', undefined, undefined],
      ['ERROR', AD_SKIP_REASON, undefined],
    ]);
    // Only Entra ID's provisioning counts for the circuit breaker
    expect(recordProvisioningOutcome.mock.calls.map(([, success]) => success)).toEqual([true]);
  }, 60_000);

  it('keeps the writeback incomplete when the write-back did not happen', async () => {
    await run('writeback');

    expect(writebackToIdentity).toHaveBeenCalledTimes(1);
    // SYNCED, but not writebackComplete: the next run writes the account id back again
    expect(entriesFor('entra')).toEqual([
      ['SYNCING', undefined, undefined],
      ['SYNCED', undefined, undefined],
    ]);
  }, 60_000);

  it('completes the writeback when the write-back happened', async () => {
    writebackToIdentity.mockResolvedValue({ success: true, updatedFields: ['objectId'] });

    await run('writeback-ok');

    expect(entriesFor('entra')).toEqual([
      ['SYNCING', undefined, undefined],
      ['SYNCED', undefined, true],
    ]);
  }, 60_000);

  it('replays a history recorded before the patch onboarding:unprovisioned-not-synced', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.UNPROVISIONED_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (UNPROVISIONED_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-unprovisioned-not-synced',
        });
        await expect(handle.result()).resolves.toBe('Dynamic onboarding complete for all users.');
        // The pre-patch code: AD SYNCED after the skip, Entra ID's writeback complete
        expect(entriesFor('ad').map(([status]) => status)).toEqual(['SYNCING', 'SYNCED']);
        expect(entriesFor('entra')).toContainEqual(['SYNCED', undefined, true]);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
