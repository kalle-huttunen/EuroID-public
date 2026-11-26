/**
 * Onboarding with an Active Directory target, end to end on the time-skipping Temporal test
 * server, when the AD node has a config on the canvas, has none, or has one that does not work.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with stubbed default-queue activities.
 * The AD queue runs the real checkAdHealth activity on the real AdService config check, with the
 * LDAP client stubbed (its bind answers what a test says); provisioning is a mock. Entra ID on its
 * own queue is the other target.
 *
 * Before the patch onboarding:ad-not-configured the health check called checkAdHealth with config
 * undefined. AdService has no other source for an AD config (no installed connector config, no
 * environment), so it answered false without touching LDAP and every run with AD on the canvas
 * failed with HealthCheckFailed, the Entra ID provisioning of the same run included.
 *
 * Proves:
 *   - AD configured on its canvas node is health-checked on that config, the one provisioning
 *     gets, and provisioned.
 *   - An AD node with no config is left out of the run, as an Entra ID with no config is: no
 *     health check, no provisioning, no provisioning entry; Entra ID is provisioned and the result
 *     names AD as skipped because it is not configured.
 *   - A configured AD whose bind fails, or whose config is incomplete, still fails the run at the
 *     health check (HealthCheckFailed) before anything is provisioned.
 *   - A history recorded before the patch (AD checked with config undefined) still replays.
 *
 * Fixture test/fixtures/onboarding-pre-ad-not-configured.history.json was recorded with the
 * pre-patch workflow (commit 9f3c929c), from backend/:
 *   git show 9f3c929c:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-ad-not-configured.workflow.ts
 *   git show 9f3c929c:backend/src/workflows/onboarding-health-check.ts \
 *     > src/workflows/onboarding-health-check-pre-ad.ts
 *   sed -i "s#'./onboarding-health-check'#'./onboarding-health-check-pre-ad'#" \
 *     src/workflows/onboarding-pre-ad-not-configured.workflow.ts
 *   TEMPORAL_E2E=1 AD_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-ad-not-configured.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-ad-not-configured -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-ad-not-configured.workflow.ts \
 *     src/workflows/onboarding-health-check-pre-ad.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import { AdActivities } from '../../src/activities/ad.activities';
import { AdService } from '../../src/modules/connectors/ad-connector/ad.service';
import type { AdClient } from '../../src/modules/connectors/ad-connector/ad.client';
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
  '../fixtures/onboarding-pre-ad-not-configured.history.json',
);
const TENANT = 'tenant-a';

const user = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  departmentName: 'Engineering',
};
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };
const CANVAS_AD = {
  host: 'dc1.corp.example',
  port: 636,
  useLdaps: true,
  bindDn: 'CN=svc-euroid,OU=Service,DC=corp,DC=example',
  bindPassword: 'not-a-real-password',
  baseDn: 'OU=Users,DC=corp,DC=example',
};

describeTemporalE2E('onboarding: an Active Directory target and its canvas config (e2e)', () => {
  let harness: WorkflowTestHarness;
  /** The canvas nodes' configs (getConnectorConfig); a missing entry is a node without one. */
  let canvasConfigs: Record<string, Record<string, unknown>> = {};
  const setProvisioningStatus = jest.fn();
  const provisionUserToEntra = jest.fn();
  const provisionUserToAd = jest.fn();
  const checkAdHealth = jest.fn();
  /** The LDAP bind of the AD health check (AdClient.healthCheck). */
  const ldapBind = jest.fn();

  // The real AD health check activity and AdService config check; only LDAP is stubbed
  const adService = new AdService({ healthCheck: ldapBind } as unknown as AdClient);
  const ad = new AdActivities(
    adService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra', 'ad'],
      getConnectorConfig: async (id: unknown) => canvasConfigs[id as string] ?? null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [groupOp] }),
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
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
          checkAdHealth: (...args: unknown[]) => checkAdHealth(...args),
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
    canvasConfigs = {};
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    provisionUserToAd.mockReset().mockResolvedValue({
      success: true,
      objectId: 'CN=Ada Lovelace,OU=Users,DC=corp,DC=example',
      skipped: false,
      operations: [],
    });
    checkAdHealth
      .mockReset()
      .mockImplementation((...args: unknown[]) =>
        ad.checkAdHealth(...(args as Parameters<AdActivities['checkAdHealth']>)),
      );
    ldapBind.mockReset().mockResolvedValue(true);
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-ad-${id}`,
    });

  const statusesFor = (system: string) =>
    setProvisioningStatus.mock.calls
      .filter(([, target]) => target === system)
      .map(([, , status]) => status);

  it('health-checks an AD configured on its canvas node on that config, then provisions it', async () => {
    canvasConfigs['ad'] = CANVAS_AD;

    await expect(run('canvas-config')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}.`,
    );

    const workflowId = 'onboarding-e2e-ad-canvas-config';
    expect(checkAdHealth).toHaveBeenCalledWith(CANVAS_AD, TENANT, workflowId);
    // The bind ran on the canvas config
    expect(ldapBind).toHaveBeenCalledTimes(1);
    expect(ldapBind.mock.calls[0][0]).toMatchObject({ host: CANVAS_AD.host });
    expect(provisionUserToAd).toHaveBeenCalledTimes(1);
    // The health check ran on the config provisioning got
    expect(provisionUserToAd.mock.calls[0][2]).toEqual(checkAdHealth.mock.calls[0][0]);
    expect(statusesFor('ad')).toEqual(['SYNCING', 'SYNCED']);
    expect(statusesFor('entra')).toEqual(['SYNCING', 'SYNCED']);
  }, 60_000);

  it('leaves an AD node with no config out of the run and provisions Entra ID', async () => {
    await expect(run('not-configured')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}. Skipped ad: not configured.`,
    );

    expect(checkAdHealth).not.toHaveBeenCalled();
    expect(provisionUserToAd).not.toHaveBeenCalled();
    expect(statusesFor('ad')).toEqual([]);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(statusesFor('entra')).toEqual(['SYNCING', 'SYNCED']);
  }, 60_000);

  /** The run failed at the health check, before anything was provisioned. */
  async function expectHealthCheckFailed(id: string) {
    const error = await run(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('HealthCheckFailed');
    expect(cause?.message).toBe('Critical: ad is unreachable.');
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(provisionUserToAd).not.toHaveBeenCalled();
    expect(setProvisioningStatus).not.toHaveBeenCalled();
  }

  it('still fails the run when the configured AD does not answer the bind', async () => {
    canvasConfigs['ad'] = CANVAS_AD;
    ldapBind.mockResolvedValue(false);

    await expectHealthCheckFailed('unhealthy');
    expect(checkAdHealth).toHaveBeenCalledWith(CANVAS_AD, TENANT, 'onboarding-e2e-ad-unhealthy');
  }, 60_000);

  it('still fails the run on an incomplete canvas config, never calling it not configured', async () => {
    // A node an operator began to configure: a host, no base DN
    canvasConfigs['ad'] = { host: CANVAS_AD.host };

    await expectHealthCheckFailed('incomplete');
    expect(ldapBind).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the patch onboarding:ad-not-configured', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.AD_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (AD_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      // AD configured on the canvas and healthy, Entra ID too: the pre-patch code checks AD with
      // config undefined (stubbed healthy here, as no AdService would answer)
      canvasConfigs['ad'] = CANVAS_AD;
      checkAdHealth.mockResolvedValue(true);
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-ad-not-configured',
        });
        await expect(handle.result()).resolves.toBe('Dynamic onboarding complete for all users.');
        expect(checkAdHealth).toHaveBeenCalledWith(
          undefined,
          TENANT,
          'onboarding-e2e-pre-ad-not-configured',
        );
        expect(provisionUserToAd).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
