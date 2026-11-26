/**
 * Cancelling a distributed transaction, on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * The workflow's catch also caught the cancellation: the rollback activity, scheduled in the
 * cancelled scope, never ran, and a cancel during the commit left the systems that did commit in
 * place, reported only as PREPARED (hunt r2-03 N7). Behind the patch
 * distributed-transaction:cancel-rolls-back prepare and commit run to their end, a cancel during
 * or after them rolls back what was committed in a non-cancellable scope, and the run ends with
 * the per-system results.
 *
 * Proves:
 *   - A cancel during the commit: the commit finishes, the committed system is rolled back, the
 *     result says ROLLED_BACK with the system's state.
 *   - A history recorded before the patch (cancelled during the commit, rolled back nothing)
 *     still replays.
 *
 * Fixture test/fixtures/distributed-transaction-pre-cancel-rolls-back.history.json was recorded
 * with the pre-patch workflow (commit 37375def), from backend/:
 *   git show 37375def:backend/src/workflows/distributed-transaction.workflow.ts \
 *     > src/workflows/distributed-transaction-pre-cancel.workflow.ts
 *   TEMPORAL_E2E=1 DISTTX_FIXTURE_WORKFLOW=src/workflows/distributed-transaction-pre-cancel.workflow.ts \
 *     npx jest -c test/jest-e2e.json distributed-transaction-cancel -t 'records the pre-patch fixture'
 *   rm src/workflows/distributed-transaction-pre-cancel.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { distributedTransactionWorkflow } from '../../src/workflows/distributed-transaction.workflow';
import type { DistributedTransactionRequest } from '../../src/workflows/workflow-types';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/distributed-transaction.workflow.ts',
);
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/distributed-transaction-pre-cancel-rolls-back.history.json',
);

const request = (transactionId: string): DistributedTransactionRequest =>
  ({
    transactionId,
    tenantId: 'tenant-a',
    user: {
      sourceSystem: 'csv-hr',
      sourceUserId: 'e-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      status: 'ACTIVE',
      tenantId: 'tenant-a',
    },
    targetSystems: ['entra-id'],
    operation: 'CREATE',
    initiatedBy: 'operator@example.com',
  }) as unknown as DistributedTransactionRequest;

/** A promise the test resolves: the commit waits on it, so the test can cancel meanwhile. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describeTemporalE2E('distributedTransactionWorkflow cancelled (e2e)', () => {
  let harness: WorkflowTestHarness;
  let commitGate = gate();
  let commitStarted = gate();
  const rollbackTransaction = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      saveToHub: async () => 'identity-1',
      prepareTransaction: async () => ({
        'entra-id': { system: 'entra-id', status: 'PREPARED', lockId: 'lock-1#1' },
      }),
      commitTransaction: async () => {
        commitStarted.open();
        await commitGate.opened;
        return {
          'entra-id': {
            system: 'entra-id',
            status: 'COMMITTED',
            lockId: 'lock-1#1',
            createdAccountId: 'obj-1',
          },
        };
      },
      rollbackTransaction: (...args: unknown[]) => rollbackTransaction(...args),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    commitGate = gate();
    commitStarted = gate();
    rollbackTransaction.mockReset().mockImplementation(async (_req, systems) => {
      const restored: Record<string, Record<string, unknown>> = {};
      for (const [system, t] of Object.entries(systems as Record<string, { status: string }>)) {
        restored[system] = t.status === 'COMMITTED' ? { ...t, status: 'ROLLED_BACK' } : { ...t };
      }
      return restored;
    });
  });

  it('rolls back the system the commit changed when the run is cancelled during it', async () => {
    const handle = await harness.env.client.workflow.start(distributedTransactionWorkflow, {
      args: [request('tx-cancel-1')],
      taskQueue: harness.taskQueue,
      workflowId: 'disttx-e2e-cancel-during-commit',
    });
    await commitStarted.opened;
    await handle.cancel();
    commitGate.open();

    const result = await handle.result();

    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(rollbackTransaction.mock.calls[0][1]).toEqual({
      'entra-id': expect.objectContaining({ status: 'COMMITTED', createdAccountId: 'obj-1' }),
    });
    expect(result).toMatchObject({
      success: false,
      phase: 'ROLLED_BACK',
      rolledBack: true,
      systems: { 'entra-id': expect.objectContaining({ status: 'ROLLED_BACK' }) },
    });
    expect(result.error).toContain('cancelled');
  }, 60_000);

  it('replays a history recorded before the cancel-rolls-back patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.DISTTX_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (DISTTX_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(distributedTransactionWorkflow, {
          args: [request('tx-pre-cancel')],
          taskQueue: pre.taskQueue,
          workflowId: 'disttx-e2e-pre-cancel-rolls-back',
        });
        await commitStarted.opened;
        await handle.cancel();
        const result = await handle.result();
        commitGate.open();
        // The pre-patch workflow rolled back nothing: the rollback was scheduled in the
        // cancelled scope
        expect(rollbackTransaction).not.toHaveBeenCalled();
        expect(result.phase).toBe('FAILED');
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
