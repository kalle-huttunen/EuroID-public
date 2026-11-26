/**
 * Orphan cleanups on the time-skipping Temporal test server: dailyReconciliationWorkflow starts
 * them without waiting, the signal route reaches or restarts them, closing a drift by hand stops
 * them. Opt-in via TEMPORAL_E2E=1.
 *
 * The run awaited each cleanup (executeChild) before it recorded the cleanup's workflow id on the
 * drift, and a cleanup waits out grace periods of weeks: the daily run stayed open for weeks, the
 * next orphan's cleanup did not start, and POST /reconciliation/orphans/:driftId/signal answered
 * "Orphan workflow not yet started" for the whole grace period, then 500 once the cleanup had
 * ended. Behind the patch reconciliation:start-orphan-cleanup the run starts the cleanup
 * (startChild, parent close policy ABANDON) under the drift's own id (orphanCleanupWorkflowId),
 * records the id at once and does not wait for its result.
 *
 * Proves:
 *   - While the cleanup still waits in its first grace period (no time skipped), the run has
 *     recorded the cleanup's id and completed, and the signal route
 *     (ReconciliationController.signalOrphan) reaches the cleanup: DELETE deletes the account,
 *     which was never disabled.
 *   - A second run for a drift whose cleanup runs starts no second cleanup and records the
 *     running one's id.
 *   - The signal route starts a fresh cleanup run that applies the action at once for a drift
 *     whose cleanup never ran, and for one whose cleanup has ended (same id, a new run).
 *   - OrphanCleanupService.stop (a drift ignored or corrected by hand) cancels a waiting cleanup.
 *   - A history recorded before the patch (cleanup awaited) still replays.
 *
 * Fixture test/fixtures/reconciliation-pre-start-orphan-cleanup.history.json was recorded with the
 * pre-patch workflow (commit 9236839c), bundled with its children, from backend/:
 *   git show 9236839c:backend/src/workflows/reconciliation.workflow.ts \
 *     > src/workflows/reconciliation-pre-start-orphan-cleanup.workflow.ts
 *   printf '%s\n' "export * from './reconciliation-pre-start-orphan-cleanup.workflow';" \
 *     "export * from './reconcile-batch.workflow';" "export * from './orphan-cleanup.workflow';" \
 *     > src/workflows/reconciliation-pre-start-orphan-cleanup.entry.ts
 *   TEMPORAL_E2E=1 \
 *     RECON_FIXTURE_WORKFLOWS=src/workflows/reconciliation-pre-start-orphan-cleanup.entry.ts \
 *     npx jest -c test/jest-e2e.json reconciliation-orphan-cleanup-start \
 *     -t 'records the pre-patch fixture'
 *   rm src/workflows/reconciliation-pre-start-orphan-cleanup.workflow.ts \
 *     src/workflows/reconciliation-pre-start-orphan-cleanup.entry.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import type { WorkflowHandle } from '@temporalio/client';
import { dailyReconciliationWorkflow, orphanCleanupWorkflow } from '../../src/workflows';
import { orphanCleanupWorkflowId } from '../../src/workflows/orphan-cleanup-id';
import type { ReconciliationConfig } from '../../src/workflows/workflow-types';
import { DEFAULT_PROVISIONING_QUEUE } from '../../src/infrastructure/temporal/task-queue.config';
import type { TemporalClientProvider } from '../../src/infrastructure/temporal/temporal-client.provider';
import { OrphanCleanupService } from '../../src/modules/reconciliation/orphan-cleanup.service';
import { ReconciliationController } from '../../src/modules/reconciliation/reconciliation.controller';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

// The worker's entry module: it exports the children too, so they run on the same worker.
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconciliation-pre-start-orphan-cleanup.history.json',
);
// Child ids derive from the parent's, so the replay runs under the recorded workflow id.
const PRE_PATCH_WORKFLOW_ID = 'recon-e2e-pre-start-orphan-cleanup';

const TENANT = 'tenant-a';
const EXTERNAL_ID = '7c1f6e2a-0b8d-4a51-9d3e-2f4b6c8a1e90';
/** Each drift's own account, so a test's assertions see only its own cleanup's calls. */
const account = (driftId: string) => `orphan-${driftId}@example.com`;
const user = { _id: 'identity-1', email: 'ada@example.com' };

/** What runOrphanDetection returns for the drift. */
const orphanOf = (driftId: string) => ({
  driftId,
  targetSystem: 'entra-id',
  externalId: EXTERNAL_ID,
  accountIdentifier: account(driftId),
  tenantId: TENANT,
});

/** The drift record the signal route reads (the fields OrphanCleanupService uses). */
interface DriftRecord {
  _id: string;
  type: 'ORPHAN_ACCOUNT';
  status: string;
  tenantId: string;
  targetSystem: string;
  userId: string;
  userEmail: string;
  orphanDetails: { targetSystem: string; externalId: string };
  workflowId?: string;
}
const quarantined = (driftId: string): DriftRecord => ({
  _id: driftId,
  type: 'ORPHAN_ACCOUNT',
  status: 'quarantined',
  tenantId: TENANT,
  targetSystem: 'entra-id',
  userId: EXTERNAL_ID,
  userEmail: account(driftId),
  orphanDetails: { targetSystem: 'entra-id', externalId: EXTERNAL_ID },
});

const reconConfig: ReconciliationConfig = {
  tenantId: TENANT,
  enabled: true,
  cronSchedule: '0 2 * * *',
  targetSystems: ['entra-id'],
  autoCorrect: false,
  autoCorrectTypes: [],
  requireApprovalForDeletes: true,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 100,
  criticalDriftAlertThreshold: 10,
};

/** `promise`, or a failure saying what did not happen within `ms` (real time). */
function within<T>(promise: Promise<T>, ms: number, failure: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(failure)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Polls the status (real time): waiting on the result would let the test server skip time. */
async function waitForStatus(handle: WorkflowHandle, status: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { status: current } = await handle.describe();
    if (current.name === status) return;
    if (Date.now() > deadline) {
      throw new Error(`${handle.workflowId} is ${current.name}, expected ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeTemporalE2E('orphan cleanups: started, signalled, restarted and stopped (e2e)', () => {
  let harness: WorkflowTestHarness;
  let orphanCleanup: OrphanCleanupService;
  const drifts = new Map<string, DriftRecord>();
  let onRecorded: (workflowId: string) => void = () => undefined;
  const runOrphanDetection = jest.fn();
  const updateDriftWorkflowId = jest.fn();
  const disableOrphanAccount = jest.fn();
  const setOrphanDisabledAt = jest.fn();
  const deleteOrphanAccount = jest.fn();
  const updateOrphanDriftStatus = jest.fn();
  const adoptOrphanAccount = jest.fn();

  const workers = (graceDays: number): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    // The queue services start workflows on: the signal route's fresh cleanups run here too
    taskQueue: DEFAULT_PROVISIONING_QUEUE,
    activities: {
      // dailyReconciliationWorkflow: one batch of one user, the orphans runOrphanDetection gives
      getWorkflowStartTime: async () => new Date('2026-11-24T00:00:00Z'),
      getReconciliationUserCount: async () => 1,
      getReconciliationBatchPlan: async () => [{ skip: 0, limit: 1, index: 0 }],
      fetchHubUsersPage: async () => ({ users: [user], nextPageToken: null }),
      detectUserDrift: async () => ({ email: user.email, hasDrift: false, drifts: [] }),
      runOrphanDetection: (...args: unknown[]) => runOrphanDetection(...args),
      updateDriftWorkflowId: (...args: unknown[]) => updateDriftWorkflowId(...args),
      generateReport: async () => ({ reportId: 'report-1', tenantId: TENANT, drifts: [] }),
      // orphanCleanupWorkflow
      getOrphanConfig: async () => ({
        gracePeriodDays: graceDays,
        extendedGraceDays: graceDays,
        autoDeleteAfterExtended: false,
      }),
      emitOrphanDetected: async () => undefined,
      // The account is still an orphan when the cleanup acts (patch recheck-before-acting)
      confirmOrphan: async () => ({ orphan: true }),
      disableOrphanAccount: (...args: unknown[]) => disableOrphanAccount(...args),
      setOrphanDisabledAt: (...args: unknown[]) => setOrphanDisabledAt(...args),
      deleteOrphanAccount: (...args: unknown[]) => deleteOrphanAccount(...args),
      updateOrphanDriftStatus: (...args: unknown[]) => updateOrphanDriftStatus(...args),
      adoptOrphanAccount: (...args: unknown[]) => adoptOrphanAccount(...args),
    },
  });

  /** POST /reconciliation/orphans/:driftId/signal over the drift records above. */
  function signalRoute(): ReconciliationController {
    type Ctor = ConstructorParameters<typeof ReconciliationController>;
    const driftService = {
      getDriftById: async (driftId: string) => drifts.get(driftId) ?? null,
      updateDriftWorkflowId: async (driftId: string, workflowId: string) => {
        const drift = drifts.get(driftId);
        if (drift) drift.workflowId = workflowId;
        return drift ?? null;
      },
    };
    return new ReconciliationController(
      {} as Ctor[0],
      driftService as unknown as Ctor[1],
      orphanCleanup,
      {} as Ctor[3],
    );
  }

  /** Starts a daily run (never awaited: no time skipped) and waits until it completed. */
  async function dailyRun(workflowId: string): Promise<void> {
    const run = await harness.env.client.workflow.start(dailyReconciliationWorkflow, {
      args: [reconConfig],
      taskQueue: harness.taskQueue,
      workflowId,
    });
    await waitForStatus(run, 'COMPLETED', 20_000);
  }

  const cleanupOf = (driftId: string) =>
    harness.env.client.workflow.getHandle(orphanCleanupWorkflowId(TENANT, driftId));

  beforeAll(async () => {
    // A grace period of 30 days: with no time skipped it does not pass during the test
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers(30) });
    // A deployment registers TenantId; the test server must too (services start with it)
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
    orphanCleanup = new OrphanCleanupService({
      getClient: () => harness.env.client,
    } as unknown as TemporalClientProvider);
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    drifts.clear();
    onRecorded = () => undefined;
    runOrphanDetection.mockReset();
    updateDriftWorkflowId.mockReset().mockImplementation(async (driftId, workflowId) => {
      const drift = drifts.get(driftId as string);
      if (drift) drift.workflowId = workflowId as string;
      onRecorded(workflowId as string);
    });
    disableOrphanAccount.mockReset().mockResolvedValue(true);
    setOrphanDisabledAt.mockReset().mockResolvedValue(undefined);
    deleteOrphanAccount.mockReset().mockResolvedValue({ success: true });
    updateOrphanDriftStatus.mockReset().mockResolvedValue(undefined);
    adoptOrphanAccount.mockReset().mockResolvedValue(true);
  });

  // A cleanup left waiting would be time-skipped by a later test's result() and act then
  afterEach(async () => {
    for (const driftId of drifts.keys()) {
      const cleanup = cleanupOf(driftId);
      const running = await cleanup
        .describe()
        .then(({ status }) => status.name === 'RUNNING')
        .catch(() => false);
      if (running) await cleanup.terminate('test done');
    }
  });

  it('records the cleanup id at once; the signal route reaches the waiting cleanup', async () => {
    const parentId = 'recon-e2e-start-orphan-cleanup';
    drifts.set('drift-1', quarantined('drift-1'));
    runOrphanDetection.mockResolvedValue([orphanOf('drift-1')]);
    const recorded = new Promise<string>((resolve) => {
      onRecorded = resolve;
    });
    // Started, never awaited: the test server skips no time, the cleanup stays in its grace period
    const run = await harness.env.client.workflow.start(dailyReconciliationWorkflow, {
      args: [reconConfig],
      taskQueue: harness.taskQueue,
      workflowId: parentId,
    });

    const cleanupId = await within(
      recorded,
      20_000,
      'The run recorded no cleanup id: it still waits for the cleanup to end',
    );
    expect(cleanupId).toBe(orphanCleanupWorkflowId(TENANT, 'drift-1'));
    await waitForStatus(run, 'COMPLETED', 20_000);
    const cleanup = cleanupOf('drift-1');
    expect((await cleanup.describe()).status.name).toBe('RUNNING');

    await expect(signalRoute().signalOrphan('drift-1', { action: 'DELETE' })).resolves.toEqual({
      success: true,
      message: 'Signal DELETE sent',
    });
    await cleanup.result();

    expect(deleteOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      account('drift-1'),
      TENANT,
      undefined,
      EXTERNAL_ID,
    );
    expect(updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-1',
      'corrected',
      'DELETE',
      'workflow-signal',
      TENANT,
    );
    // Still in the first grace period when signalled: never disabled
    expect(disableOrphanAccount).not.toHaveBeenCalledWith('entra-id', account('drift-1'), TENANT);
  }, 60_000);

  // The cleanup started, but its id never reached the drift (the run stopped first)
  it('starts no second cleanup for a drift whose cleanup runs, and records that one', async () => {
    drifts.set('drift-2', quarantined('drift-2'));
    runOrphanDetection.mockResolvedValue([orphanOf('drift-2')]);
    await dailyRun('recon-e2e-collide-1');
    const { runId } = await cleanupOf('drift-2').describe();
    drifts.set('drift-2', quarantined('drift-2'));

    await dailyRun('recon-e2e-collide-2');

    const cleanupId = orphanCleanupWorkflowId(TENANT, 'drift-2');
    expect(updateDriftWorkflowId).toHaveBeenCalledTimes(2);
    expect(updateDriftWorkflowId).toHaveBeenLastCalledWith('drift-2', cleanupId, TENANT);
    const after = await cleanupOf('drift-2').describe();
    expect(after.runId).toBe(runId);
    expect(after.status.name).toBe('RUNNING');
  }, 60_000);

  it('starts a cleanup that deletes at once for a drift whose cleanup never ran', async () => {
    drifts.set('drift-3', quarantined('drift-3'));

    await expect(signalRoute().signalOrphan('drift-3', { action: 'DELETE' })).resolves.toEqual({
      success: true,
      message: 'Signal DELETE sent',
    });
    await cleanupOf('drift-3').result();

    expect(drifts.get('drift-3')?.workflowId).toBe(orphanCleanupWorkflowId(TENANT, 'drift-3'));
    expect(deleteOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      account('drift-3'),
      TENANT,
      undefined,
      EXTERNAL_ID,
    );
    expect(disableOrphanAccount).not.toHaveBeenCalledWith('entra-id', account('drift-3'), TENANT);
  }, 60_000);

  it('starts a fresh run that adopts at once for a drift whose cleanup has ended', async () => {
    drifts.set('drift-4', quarantined('drift-4'));
    // The first cleanup ends without resolving the drift: its delete failed
    deleteOrphanAccount.mockResolvedValueOnce({ success: false, error: 'Entra ID unavailable' });
    await signalRoute().signalOrphan('drift-4', { action: 'DELETE' });
    await cleanupOf('drift-4').result();
    const { runId: endedRun } = await cleanupOf('drift-4').describe();

    await expect(
      signalRoute().signalOrphan('drift-4', { action: 'ADOPT', identityId: 'identity-9' }),
    ).resolves.toEqual({ success: true, message: 'Signal ADOPT sent' });
    await cleanupOf('drift-4').result();

    expect((await cleanupOf('drift-4').describe()).runId).not.toBe(endedRun);
    expect(adoptOrphanAccount).toHaveBeenCalledWith(
      'drift-4',
      'identity-9',
      'entra-id',
      EXTERNAL_ID,
      'workflow-signal',
      TENANT,
    );
    expect(disableOrphanAccount).not.toHaveBeenCalledWith('entra-id', account('drift-4'), TENANT);
  }, 60_000);

  // DriftService.ignoreDrift / autoCorrect of an orphan drift
  it('stops a waiting cleanup when its drift is closed by hand', async () => {
    const cleanupId = orphanCleanupWorkflowId(TENANT, 'drift-5');
    const cleanup = await harness.env.client.workflow.start(orphanCleanupWorkflow, {
      args: [{ ...orphanOf('drift-5') }],
      taskQueue: harness.taskQueue,
      workflowId: cleanupId,
    });

    await orphanCleanup.stop(cleanupId);
    await waitForStatus(cleanup, 'CANCELLED', 20_000);
    // Stopping one that has ended does nothing
    await expect(orphanCleanup.stop(cleanupId)).resolves.toBeUndefined();

    expect(disableOrphanAccount).not.toHaveBeenCalledWith('entra-id', account('drift-5'), TENANT);
    expect(deleteOrphanAccount).not.toHaveBeenCalledWith(
      'entra-id',
      account('drift-5'),
      TENANT,
      undefined,
      EXTERNAL_ID,
    );
    expect(deleteOrphanAccount).not.toHaveBeenCalledWith('entra-id', account('drift-5'), TENANT);
  }, 60_000);

  it('replays a history recorded before the start-orphan-cleanup patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.RECON_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (RECON_FIXTURE_WORKFLOWS = entry of the pre-patch bundle)',
    async () => {
      // A grace period of 1 day: result() skips time, so the awaited cleanup ends
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(1),
      });
      try {
        runOrphanDetection.mockResolvedValue([orphanOf('drift-1')]);
        const run = await pre.env.client.workflow.start(dailyReconciliationWorkflow, {
          args: [reconConfig],
          taskQueue: pre.taskQueue,
          workflowId: PRE_PATCH_WORKFLOW_ID,
        });
        await run.result();
        // The pre-patch run recorded the cleanup id only after the cleanup had ended
        const cleanupId = `${PRE_PATCH_WORKFLOW_ID}-orphan-drift-1-0`;
        expect(updateDriftWorkflowId).toHaveBeenCalledWith('drift-1', cleanupId, TENANT);
        expect(disableOrphanAccount).toHaveBeenCalledTimes(1);
        expect(updateDriftWorkflowId.mock.invocationCallOrder[0]).toBeGreaterThan(
          setOrphanDisabledAt.mock.invocationCallOrder[0],
        );
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await run.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
