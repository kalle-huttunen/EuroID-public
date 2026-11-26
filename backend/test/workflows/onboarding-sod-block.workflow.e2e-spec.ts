/**
 * Onboarding when a BLOCK SoD policy refuses a person's access, end to end on the time-skipping
 * Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with stubbed activities; evaluateUser
 * fails as PolicyActivities.evaluateUser does on a BLOCK conflict: not retryable, type
 * SoDViolation, the message naming the SoD policy.
 *
 * Proves:
 *   - The refused person is not provisioned and their policy step is not retried; their
 *     timeline gets the reason (recordOnboardingBlocked); the run then fails (SoDViolation)
 *     naming the identity and the reason, no email address. (A run onboards one person since
 *     the patch onboarding:target-required, so the batch case before it is gone.)
 *   - Any other evaluation failure still fails the run where it happens.
 *   - A history recorded before the patch onboarding:sod-block-fails-person, in which a refused
 *     person's policy step was being retried, still replays.
 *
 * Fixture test/fixtures/onboarding-pre-sod-block.history.json was recorded with the pre-patch
 * workflow (commit ca5a8b11), from backend/:
 *   git show ca5a8b11:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-sod-block.workflow.ts
 *   TEMPORAL_E2E=1 SOD_BLOCK_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-sod-block.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-sod-block -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-sod-block.workflow.ts
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
  '../fixtures/onboarding-pre-sod-block.history.json',
);
const TENANT = 'tenant-a';

const ada = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const bob = { email: 'bob@example.com', firstName: 'Bob', lastName: 'Payables' };
const identityIdOf = (email: string) => `identity-${email.split('@')[0]}`;
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'Finance Team' };
const REASON = 'Segregation of Duties conflict: Payments vs approvals';

describeTemporalE2E('onboarding: a BLOCK SoD policy refuses one person (e2e)', () => {
  let harness: WorkflowTestHarness;
  const evaluateUser = jest.fn();
  const recordOnboardingBlocked = jest.fn();
  const provisionUserToEntra = jest.fn();
  let hires: Array<typeof ada> = [];

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => {
    const byEmail = (email: unknown) => [ada, bob].find((u) => u.email === email);
    return {
      taskQueue: 'provisioning-default',
      activities: {
        getActiveTargetSystems: async () => ['entra'],
        getConnectorConfig: async () => null,
        getEdgeConditions: async () => null,
        getPipelineStatus: async () => 'DEPLOYED',
        recordProvisioningOutcome: async () => undefined,
        fetchNewHires: async () => hires,
        saveToHub: async (user: unknown) => identityIdOf((user as typeof ada).email),
        getUserByEmail: async (email: unknown) => byEmail(email) ?? null,
        getIdentityByEmail: async (email: unknown) => {
          const user = byEmail(email);
          return user ? { _id: identityIdOf(user.email), profile: user, provisioning: [] } : null;
        },
        setProvisioningStatus: async () => undefined,
        evaluateUser: (...args: unknown[]) => evaluateUser(...args),
        // No target excluded by an access review (patch onboarding:review-exclusions)
        getReviewExcludedTargets: async () => [],
        writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
        writebackToHrSource: async () => undefined,
        recordOnboardingBlocked: (...args: unknown[]) => recordOnboardingBlocked(...args),
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
    };
  };

  /** evaluateUser refusing Bob as PolicyActivities does, everyone else evaluated. */
  const refuseBob = (failure: () => Error) =>
    evaluateUser.mockImplementation(async (user: { email: string }) => {
      if (user.email === bob.email) throw failure();
      return { operations: [groupOp] };
    });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    hires = [bob, ada];
    evaluateUser.mockReset();
    recordOnboardingBlocked.mockReset().mockResolvedValue(undefined);
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true });
    refuseBob(() => ApplicationFailure.nonRetryable(REASON, 'SoDViolation'));
  });

  const run = (id: string, input: { targetEmail: string }) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, ...input }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-sod-block-${id}`,
    });

  const evaluatedEmails = () => evaluateUser.mock.calls.map(([user]) => user.email);
  const provisionedEmails = () => provisionUserToEntra.mock.calls.map(([user]) => user.email);

  it('fails the one-person run the same way, provisioning nothing', async () => {
    const error = await run('single', { targetEmail: bob.email }).catch((e: unknown) => e);

    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(recordOnboardingBlocked).toHaveBeenCalledWith(
      'identity-bob',
      REASON,
      TENANT,
      'onboarding-e2e-sod-block-single',
    );
    expect(evaluatedEmails()).toEqual([bob.email]); // Bob's step not retried
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect(cause.type).toBe('SoDViolation');
    expect(cause.nonRetryable).toBe(true);
    expect(cause.message).toContain('identity-bob');
    expect(cause.message).toContain('Payments vs approvals');
    expect(cause.message).not.toContain('@');
  }, 60_000);

  it('still fails the run where it happens on any other evaluation failure', async () => {
    refuseBob(() => ApplicationFailure.nonRetryable('Policy store unreadable', 'Other'));

    const error = await run('other-failure', { targetEmail: bob.email }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(evaluatedEmails()).toEqual([bob.email]);
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(recordOnboardingBlocked).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the patch onboarding:sod-block-fails-person', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.SOD_BLOCK_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (SOD_BLOCK_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // Before the patch the activity threw a plain SoDViolationException: retried forever.
        // Ada is onboarded first, then the run waits at Bob's policy step.
        hires = [ada, bob];
        refuseBob(() => new Error(REASON));
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-sod-block',
        });
        const bobAttempts = () => evaluatedEmails().filter((e) => e === bob.email).length;
        for (let i = 0; i < 100 && bobAttempts() < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(bobAttempts()).toBeGreaterThanOrEqual(3);
        expect(provisionedEmails()).toEqual([ada.email]);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
        await handle.terminate('fixture recorded');
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
