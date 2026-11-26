/**
 * adminAccountProvisioningWorkflow when a target answers without having provisioned the admin
 * account, end to end on the time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * The admin child has no health check: an AD node without a config on the canvas reaches
 * provisionUserToAd with config undefined, which answers `{ success: false, skipped: true }`
 * without throwing. Before the patch admin-account-provisioning:unprovisioned-not-synced the
 * child marked the target SYNCED anyway, counted a success for the circuit breaker and asked for
 * a standing-state settle run for an account that does not exist.
 *
 * Proves, for runs started now:
 *   - Such a target is ERROR with the target's own reason, no provisioning outcome is recorded
 *     for it, and with nothing provisioned no settle run is asked for; the run completes.
 *   - A target that provisions is SYNCED as before.
 *   - A history recorded before the patch (AD SYNCED after the skip) still replays.
 *
 * Fixture test/fixtures/admin-account-provisioning-pre-unprovisioned-not-synced.history.json was
 * recorded with the pre-patch workflow (commit 9f3c929c), from backend/:
 *   git show 9f3c929c:backend/src/workflows/admin-account-provisioning.workflow.ts \
 *     > src/workflows/admin-pre-unprovisioned.workflow.ts
 *   TEMPORAL_E2E=1 ADMIN_UNPROVISIONED_FIXTURE_WORKFLOW=src/workflows/admin-pre-unprovisioned.workflow.ts \
 *     npx jest -c test/jest-e2e.json admin-account-provisioning-unprovisioned -t 'records the pre-patch fixture'
 *   rm src/workflows/admin-pre-unprovisioned.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
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
  '../fixtures/admin-account-provisioning-pre-unprovisioned-not-synced.history.json',
);
const TENANT = 'tenant-a';
const AD_SKIP_REASON = 'AD config missing host or baseDn';
const adminProfile = { email: 'adm-ada@example.com', firstName: 'Ada', lastName: 'Admin' };
const ADMIN_OPERATIONS = [
  {
    type: 'group',
    action: 'add',
    target: 'all',
    targetId: 'domain-admins',
    sourcePolicy: 'pam-policy',
    adminTier: 'TIER_0' as const,
  },
];

describeTemporalE2E('adminAccountProvisioningWorkflow: a target that did not provision (e2e)', () => {
  let harness: WorkflowTestHarness;
  const activeTargets = jest.fn();
  const setProvisioningStatus = jest.fn();
  const recordProvisioningOutcome = jest.fn();
  const settleAdminAccountState = jest.fn();
  const provisionUserToAd = jest.fn();
  const provisionUserToGithub = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getOrCreateLinkedAdminIdentity: async () => ({ adminIdentityId: 'admin-1', adminProfile }),
      getActiveTargetSystems: (...args: unknown[]) => activeTargets(...args),
      // The AD node has no config on the canvas
      getConnectorConfig: async () => null,
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      recordProvisioningOutcome: (...args: unknown[]) => recordProvisioningOutcome(...args),
      settleAdminAccountState: (...args: unknown[]) => settleAdminAccountState(...args),
      provisionUserToGithub: (...args: unknown[]) => provisionUserToGithub(...args),
    },
    queueWorkers: [
      {
        taskQueue: 'provisioning-ad',
        activities: { provisionUserToAd: (...args: unknown[]) => provisionUserToAd(...args) },
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
    activeTargets.mockReset().mockResolvedValue(['ad']);
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    recordProvisioningOutcome.mockReset().mockResolvedValue(undefined);
    settleAdminAccountState.mockReset().mockResolvedValue(true);
    provisionUserToAd
      .mockReset()
      .mockResolvedValue({ success: false, skipped: true, error: AD_SKIP_REASON });
    provisionUserToGithub.mockReset().mockResolvedValue({ success: true, objectId: 'gh-1' });
  });

  const start = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start(adminAccountProvisioningWorkflow, {
      args: [
        {
          parentIdentityId: 'parent-1',
          adminTier: 'TIER_0',
          adminOperations: ADMIN_OPERATIONS,
          tenantId: TENANT,
        },
      ],
      taskQueue: h.taskQueue,
      workflowId,
    });

  /** [system, status, errorMsg] per setProvisioningStatus call. */
  const entries = () =>
    setProvisioningStatus.mock.calls.map(([, system, status, errorMsg]) => [
      system,
      status,
      errorMsg,
    ]);

  it('leaves a target that skipped the provision ERROR with the reason, never SYNCED', async () => {
    await (await start(harness, 'admin-provisioning-e2e-unprovisioned')).result();

    expect(provisionUserToAd).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([
      ['ad', 'SYNCING', undefined],
      ['ad', 'ERROR', AD_SKIP_REASON],
    ]);
    expect(recordProvisioningOutcome).not.toHaveBeenCalled();
    // Nothing was provisioned: no account to settle
    expect(settleAdminAccountState).not.toHaveBeenCalled();
  }, 60_000);

  it('still provisions and settles the targets that did provision', async () => {
    activeTargets.mockResolvedValue(['ad', 'github']);

    await (await start(harness, 'admin-provisioning-e2e-unprovisioned-mixed')).result();

    expect(entries()).toEqual([
      ['ad', 'SYNCING', undefined],
      ['ad', 'ERROR', AD_SKIP_REASON],
      ['github', 'SYNCING', undefined],
      ['github', 'SYNCED', undefined],
    ]);
    expect(recordProvisioningOutcome.mock.calls.map(([, success]) => success)).toEqual([true]);
    expect(settleAdminAccountState).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('replays a history recorded before the patch admin-account-provisioning:unprovisioned-not-synced', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ADMIN_UNPROVISIONED_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ADMIN_UNPROVISIONED_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await start(pre, 'admin-provisioning-e2e-pre-unprovisioned');
        await handle.result();
        // The pre-patch code: AD SYNCED after the skip, a success counted, a settle asked for
        expect(entries().map(([system, status]) => [system, status])).toEqual([
          ['ad', 'SYNCING'],
          ['ad', 'SYNCED'],
        ]);
        expect(settleAdminAccountState).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
