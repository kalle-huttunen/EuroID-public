/**
 * Onboarding and access review exclusions, end to end on the time-skipping Temporal test server.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with stubbed activities (Entra ID on its
 * own queue, GitHub on the default queue as checkGithubHealth / provisionUserToGithub);
 * getReviewExcludedTargets answers as PolicyActivities does for a person whose GitHub account an
 * access review revoked (an account exclusion of github).
 *
 * Proves (patch onboarding:review-exclusions):
 *   - The excluded target is left out of the person's provisioning: no provisioning call, no
 *     provisioning entry; the other targets are provisioned; the run completes (not a failure)
 *     and its result names the excluded target with its reason.
 *   - Without an exclusion every target is provisioned and the result says nothing of it.
 *   - A history recorded before the patch, which asked nothing, still replays.
 *
 * Fixture test/fixtures/onboarding-pre-review-exclusions.history.json is recorded with the
 * pre-patch workflow (main 9236839c, the commit this change starts from), from backend/:
 *   git show 9236839c:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-review-exclusions.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     REVIEW_EXCLUSIONS_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-review-exclusions.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-review-exclusions -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-review-exclusions.workflow.ts
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
  '../fixtures/onboarding-pre-review-exclusions.history.json',
);
const TENANT = 'tenant-a';
const IDENTITY = 'identity-ada';

const ada = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'Engineering' };

describeTemporalE2E('onboarding: a target an access review excluded (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getReviewExcludedTargets = jest.fn();
  const provisionUserToEntra = jest.fn();
  const provisionUserToGithub = jest.fn();
  const setProvisioningStatus = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra', 'github'],
      getConnectorConfig: async () => null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [],
      saveToHub: async () => IDENTITY,
      getUserByEmail: async () => ada,
      getIdentityByEmail: async () => ({ _id: IDENTITY, profile: ada, provisioning: [] }),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [groupOp] }),
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
      getReviewExcludedTargets: (...args: unknown[]) => getReviewExcludedTargets(...args),
      checkGithubHealth: async () => true,
      provisionUserToGithub: (...args: unknown[]) => provisionUserToGithub(...args),
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
    getReviewExcludedTargets.mockReset().mockResolvedValue(['github']);
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true });
    provisionUserToGithub.mockReset().mockResolvedValue({ success: true });
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: ada.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-review-exclusions-${id}`,
    });

  const statusesOf = (system: string) =>
    setProvisioningStatus.mock.calls.filter(([, target]) => target === system);

  it('leaves the excluded target out, provisions the others and completes', async () => {
    const result = await run('excluded');

    expect(getReviewExcludedTargets).toHaveBeenCalledWith(
      IDENTITY,
      ['entra', 'github'],
      TENANT,
      'onboarding-e2e-review-exclusions-excluded',
    );
    expect(provisionUserToGithub).not.toHaveBeenCalled();
    expect(statusesOf('github')).toEqual([]);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(statusesOf('entra').map(([, , status]) => status)).toContain('SYNCED');
    expect(result).toContain('Left out by an access review exclusion: github.');
  }, 60_000);

  it('provisions every target when nothing is excluded', async () => {
    getReviewExcludedTargets.mockResolvedValue([]);

    const result = await run('none');

    expect(provisionUserToGithub).toHaveBeenCalledTimes(1);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('access review');
  }, 60_000);

  it('replays a history recorded before the patch onboarding:review-exclusions', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.REVIEW_EXCLUSIONS_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (REVIEW_EXCLUSIONS_FIXTURE_WORKFLOW = the pre-patch workflow)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // Before the patch the run asked nothing and provisioned both targets
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT, targetEmail: ada.email }],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-review-exclusions',
        });
        await handle.result();
        expect(getReviewExcludedTargets).not.toHaveBeenCalled();
        expect(provisionUserToGithub).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
