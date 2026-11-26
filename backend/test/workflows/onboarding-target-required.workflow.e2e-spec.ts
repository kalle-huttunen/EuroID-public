/**
 * Onboarding needs its person, end to end on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * Before the patch onboarding:target-required a run started without a targetEmail onboarded "all
 * users": fetchNewHires returned every active identity's profile in one activity result, which
 * goes over Temporal's payload limit on a large tenant (hunt 2026-11-25 03 F7). No caller starts
 * that run any more (OnboardingService needs the person).
 *
 * Proves:
 *   - A run started now without a targetEmail fails at once (OnboardingTargetRequired, not
 *     retried) and calls no activity.
 *   - A run started with its person still onboards that person.
 *   - A history of an all-users run recorded before the patch still replays.
 *
 * Fixture test/fixtures/onboarding-pre-target-required.history.json was recorded with the
 * pre-patch workflow (the tree before this patch), from backend/:
 *   TEMPORAL_E2E=1 TARGET_FIXTURE_WORKFLOW=src/workflows/onboarding.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-target-required -t 'records the pre-patch fixture'
 * (Against a later tree: copy the pre-patch onboarding.workflow.ts and onboarding-input.ts under
 * other names first and point the variable at the copy.)
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
  '../fixtures/onboarding-pre-target-required.history.json',
);
const TENANT = 'tenant-a';
const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };

describeTemporalE2E('onboarding needs its person (e2e)', () => {
  let harness: WorkflowTestHarness;
  const activityCalls: string[] = [];
  const provisionUserToEntra = jest.fn();

  /** Every activity records its name, so a test can say none ran. */
  const recorded = (activities: Record<string, (...args: unknown[]) => unknown>) =>
    Object.fromEntries(
      Object.entries(activities).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          activityCalls.push(name);
          return fn(...args);
        },
      ]),
    );

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: recorded({
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      setProvisioningStatus: async () => undefined,
      evaluateUser: async () => ({ operations: [groupOp] }),
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
    }),
    queueWorkers: [
      {
        taskQueue: 'provisioning-entra',
        activities: recorded({
          isEntraConfigured: async () => true,
          checkEntraHealth: async () => true,
          provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
        }),
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
    activityCalls.length = 0;
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
  });

  it('fails a run started without its person at once, before any activity', async () => {
    const error = await harness.env.client.workflow
      .execute(onboardingWorkflow, {
        // The old all-users input: the type now requires targetEmail
        args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
        taskQueue: harness.taskQueue,
        workflowId: 'onboarding-e2e-no-target',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('OnboardingTargetRequired');
    expect((cause as ApplicationFailure).nonRetryable).toBe(true);
    expect(activityCalls).toEqual([]);
  }, 60_000);

  it('still onboards the person a run is started for', async () => {
    const result = await harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: 'onboarding-e2e-with-target',
    });

    expect(result).toBe(`Dynamic onboarding complete for ${user.email}.`);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(activityCalls).not.toContain('fetchNewHires');
  }, 60_000);

  it('replays an all-users history recorded before the patch onboarding:target-required', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.TARGET_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (TARGET_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-target-required',
        });
        // The pre-patch code onboards every identity fetchNewHires returns
        await expect(handle.result()).resolves.toBe('Dynamic onboarding complete for all users.');
        expect(activityCalls).toContain('fetchNewHires');
        expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
