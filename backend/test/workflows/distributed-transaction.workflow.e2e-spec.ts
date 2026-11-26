/**
 * End-to-end test for distributedTransactionWorkflow on the time-skipping Temporal test server,
 * with the real DistributedTransactionActivities (Entra and dead-letter mocked, in-process locks).
 * Opt-in via TEMPORAL_E2E=1.
 *
 * Proves:
 *   - The per-system state survives Temporal's JSON payload converter between prepare, commit
 *     and rollback. It used to be a Map, which arrived as {} and failed the commit activity.
 *   - Prepare, commit and both abort paths (prepare refused, one system failing to commit)
 *     report each system's real state.
 *   - A CREATE is refused at prepare when an Entra ID account already has the UPN resolved for
 *     it, the email or the employee id, and its commit creates the account under that UPN only:
 *     it never takes over (and a rollback never deletes) an account that existed before.
 *   - A failed restore reaches the dead-letter queue under the transaction's tenant, and the
 *     transaction ends ROLLBACK_FAILED (rolledBack: false), never ROLLED_BACK.
 *   - A system that fails to commit releases its lock at once: the next transaction for the
 *     same user prepares without waiting for the lock TTL.
 *   - The transaction log the Transaction Viewer reads gets every phase transition and ends at
 *     the phase the workflow itself reports.
 *   - The account state captured before the commit (personal data) goes to the snapshot store:
 *     the history has the reference, not the values, and the rollback still restores from it.
 *   - A DELETE whose account cannot be read first is never committed (no snapshot, no change).
 *   - An UPDATE writes the user's attributes to the Entra account through the connector, and its
 *     rollback writes back the values captured before the commit.
 *   - Prepare refuses a system the commit cannot change (only Entra ID) once, not retried, before
 *     any lock or change.
 *   - Histories recorded by the pre-patch code still replay against the current code.
 *
 * A system failing at commit after Entra ID committed now only happens to a transaction prepared
 * before prepare refused such systems (in flight at the deploy). The tests of that path prepare
 * the way it ran then (preparedBeforeSystemCheck).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { distributedTransactionWorkflow } from '../../src/workflows/distributed-transaction.workflow';
import type { DistributedTransactionRequest } from '../../src/workflows/workflow-types';
import { DistributedTransactionActivities } from '../../src/activities/distributed-transaction.activities';
import { SystemTransactionStatus } from '../../src/shared/dtos/distributed-transaction.dto';
import { MemoryOwnedLockStore } from '../../src/infrastructure/cache/owned-lock.store';
import { MemorySnapshots } from '../helpers/bulk-rollback-fakes';
import { historyText } from '../helpers/history-text';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

type Deps = ConstructorParameters<typeof DistributedTransactionActivities>;

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/distributed-transaction.workflow.ts',
);
const OLD_HISTORY = path.resolve(
  __dirname,
  '../fixtures/distributed-transaction-pre-plain-object.history.json',
);
/** Recorded before ROLLBACK_FAILED: a failed restore, reported ROLLED_BACK. */
const PRE_ROLLBACK_STATUS_HISTORY = path.resolve(
  __dirname,
  '../fixtures/distributed-transaction-pre-rollback-status.history.json',
);

/**
 * Prepare as it ran before it refused systems the commit cannot change: Entra ID through the
 * real prepare, any other system PREPARED next to it. A transaction in flight at the deploy looks
 * like this: its commit fails that system after Entra ID committed, and the rollback restores
 * Entra ID.
 */
async function prepareAsBeforeSystemCheck(
  tx: DistributedTransactionActivities,
  ...[request, tenantId, correlationId]: Parameters<
    DistributedTransactionActivities['prepareTransaction']
  >
) {
  const prepared = await tx.prepareTransaction(
    { ...request, targetSystems: request.targetSystems.filter((s) => s === 'entra-id') },
    tenantId,
    correlationId,
  );
  for (const system of request.targetSystems.filter((s) => s !== 'entra-id')) {
    prepared[system] = { system, status: SystemTransactionStatus.PREPARED, preparedAt: new Date() };
  }
  return prepared;
}

describeTemporalE2E('distributedTransactionWorkflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  /** Transaction ids whose prepare runs as before the system check. */
  const preparedBeforeSystemCheck = new Set<string>();
  const prepareAttempts = jest.fn();
  const resolveAvailableUpn = jest.fn();
  const existingAccountFor = jest.fn();
  const provisionUserToEntra = jest.fn();
  const deleteUser = jest.fn();
  const capture = jest.fn();
  const updateTransactionPhase = jest.fn();
  const disableEntraUser = jest.fn();
  const getUserByEmail = jest.fn();
  const patchUser = jest.fn();
  const captureUserState = jest.fn();
  const updateUser = jest.fn();
  const restoreUserState = jest.fn();
  const snapshots = new MemorySnapshots();

  beforeAll(async () => {
    const tx = new DistributedTransactionActivities(
      {
        provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
        disableEntraUser: (...args: unknown[]) => disableEntraUser(...args),
      } as unknown as Deps[0],
      {} as Deps[1],
      {
        resolveAvailableUpn: (...args: unknown[]) => resolveAvailableUpn(...args),
        existingAccountFor: (...args: unknown[]) => existingAccountFor(...args),
        getUserByEmail: (...args: unknown[]) => getUserByEmail(...args),
        deleteUser: (...args: unknown[]) => deleteUser(...args),
        patchUser: (...args: unknown[]) => patchUser(...args),
        captureUserState: (...args: unknown[]) => captureUserState(...args),
        updateUser: (...args: unknown[]) => updateUser(...args),
        restoreUserState: (...args: unknown[]) => restoreUserState(...args),
      } as unknown as Deps[2],
      { emit: () => undefined } as unknown as Deps[3],
      { capture: (...args: unknown[]) => capture(...args) } as unknown as Deps[4],
      new MemoryOwnedLockStore(),
      {
        updateTransactionPhase: (...args: unknown[]) => updateTransactionPhase(...args),
      } as unknown as Deps[6],
      snapshots as unknown as Deps[7],
    );

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        saveToHub: async () => 'identity-1',
        prepareTransaction: (...args: unknown[]) => {
          const params = args as Parameters<typeof tx.prepareTransaction>;
          prepareAttempts(params[0].transactionId);
          return preparedBeforeSystemCheck.has(params[0].transactionId)
            ? prepareAsBeforeSystemCheck(tx, ...params)
            : tx.prepareTransaction(...params);
        },
        commitTransaction: (...args: unknown[]) =>
          tx.commitTransaction(...(args as Parameters<typeof tx.commitTransaction>)),
        rollbackTransaction: (...args: unknown[]) =>
          tx.rollbackTransaction(...(args as Parameters<typeof tx.rollbackTransaction>)),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    resolveAvailableUpn
      .mockReset()
      .mockResolvedValue({ chosenUpn: 'ada.lovelace@corp.test', candidatesChecked: [] });
    existingAccountFor.mockReset().mockResolvedValue(null);
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    deleteUser.mockReset().mockResolvedValue(true);
    capture.mockReset().mockResolvedValue(undefined);
    updateTransactionPhase.mockReset().mockResolvedValue(undefined);
    disableEntraUser.mockReset().mockResolvedValue(true);
    getUserByEmail.mockReset().mockResolvedValue(null);
    patchUser.mockReset().mockResolvedValue(undefined);
    captureUserState.mockReset().mockResolvedValue({ existed: false });
    updateUser.mockReset().mockResolvedValue(undefined);
    restoreUserState.mockReset().mockResolvedValue(undefined);
  });

  // One user per test, except where a test reuses one on purpose.
  const userFor = (id: string) => ({
    email: `${id}@example.com`,
    firstName: 'Ada',
    lastName: 'Lovelace',
  });
  /** A transaction prepared before prepare refused systems it cannot change (see above). */
  const runPreparedBeforeSystemCheck = (id: string, targetSystems: string[]) => {
    preparedBeforeSystemCheck.add(`tx-${id}`);
    return run(id, targetSystems);
  };
  const run = (id: string, targetSystems: string[], userId = id) =>
    harness.env.client.workflow.execute(distributedTransactionWorkflow, {
      args: [
        {
          transactionId: `tx-${id}`,
          user: userFor(userId),
          targetSystems,
          operation: 'CREATE',
          tenantId: 'tenant-a',
          initiatedBy: 'e2e',
        } as DistributedTransactionRequest,
      ],
      taskQueue: harness.taskQueue,
      workflowId: `dist-tx-e2e-${id}`,
    });

  it('prepares and commits every system', async () => {
    const result = await run('commit', ['entra-id']);

    expect(result).toMatchObject({
      success: true,
      phase: 'COMMITTED',
      prepareSuccess: true,
      commitSuccess: true,
      rolledBack: false,
    });
    expect(result.systems['entra-id']).toMatchObject({ status: 'COMMITTED' });
    // The lock is keyed by tenant and an email hash: the lockId in the history has no email.
    expect(result.systems['entra-id'].lockId).toMatch(/^tenant-a:entra-id:[0-9a-f]{64}#/);
    // Prepare resolved the account's UPN and found no account in the way; the commit creates
    // the account under that UPN only (it never takes over an existing account)
    expect(existingAccountFor).toHaveBeenCalledWith(userFor('commit'), 'ada.lovelace@corp.test');
    expect(provisionUserToEntra).toHaveBeenCalledWith(
      userFor('commit'),
      undefined,
      undefined,
      'tenant-a',
      undefined,
      undefined,
      undefined,
      'ada.lovelace@corp.test',
    );
  }, 60_000);

  it('aborts before any commit when a system refuses to prepare', async () => {
    existingAccountFor.mockResolvedValue('obj-existing');

    const result = await run('prepare-refused', ['entra-id']);

    expect(result).toMatchObject({ success: false, prepareSuccess: false, commitSuccess: false });
    expect(result.systems).toEqual({});
    expect(existingAccountFor).toHaveBeenCalled();
    expect(provisionUserToEntra).not.toHaveBeenCalled();
  }, 60_000);

  it('refuses a system it cannot change at prepare, once, before any lock or change', async () => {
    const result = await run('unsupported', ['entra-id', 'file-outbound'], 'unsupported-user');

    expect(result).toMatchObject({ success: false, prepareSuccess: false, commitSuccess: false });
    expect(result.systems).toEqual({});
    expect(prepareAttempts.mock.calls.filter(([id]) => id === 'tx-unsupported')).toHaveLength(1);
    expect(resolveAvailableUpn).not.toHaveBeenCalled();
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(updateTransactionPhase).toHaveBeenCalledWith('tx-unsupported', 'FAILED', [
      expect.objectContaining({
        systemName: 'file-outbound',
        status: 'FAILED',
        error: 'Distributed transactions can change entra-id only; not supported: file-outbound',
      }),
    ]);
    // No lock was taken: the next transaction for the user prepares and commits.
    const next = await run('after-unsupported', ['entra-id'], 'unsupported-user');
    expect(next).toMatchObject({ success: true, phase: 'COMMITTED' });
  }, 60_000);

  it('rolls back the committed system when another system fails to commit', async () => {
    const result = await runPreparedBeforeSystemCheck('commit-failed', [
      'entra-id',
      'file-outbound',
    ]);

    expect(result).toMatchObject({
      success: false,
      phase: 'ROLLED_BACK',
      prepareSuccess: true,
      commitSuccess: false,
      rolledBack: true,
      error: 'One or more systems failed to commit',
    });
    expect(result.systems['entra-id']).toMatchObject({ status: 'ROLLED_BACK' });
    expect(result.systems['file-outbound']).toMatchObject({
      status: 'FAILED',
      error: 'Unknown system: file-outbound',
    });
    // By the object id the commit created it under, not the email (hunt 2026-11-25, 01 F5)
    expect(deleteUser).toHaveBeenCalledWith('entra-1');
    expect(deleteUser).not.toHaveBeenCalledWith('commit-failed@example.com');
  }, 60_000);

  it('releases the lock of a system that failed to commit, so the user is not blocked', async () => {
    provisionUserToEntra.mockRejectedValueOnce(new Error('Graph 500'));
    const first = await run('lock-first', ['entra-id'], 'lock');
    expect(first).toMatchObject({
      commitSuccess: false,
      error: 'One or more systems failed to commit',
    });
    expect(first.systems['entra-id']).toMatchObject({ status: 'FAILED', error: 'Graph 500' });

    // Same user right away: prepare must not find entra-id still locked.
    const second = await run('lock-second', ['entra-id'], 'lock');

    expect(second).toMatchObject({ prepareSuccess: true, success: true, phase: 'COMMITTED' });
    expect(provisionUserToEntra).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('reports a failed restore as ROLLBACK_FAILED and sends it to the dead-letter queue', async () => {
    deleteUser.mockRejectedValue(new Error('Graph 503'));

    const result = await runPreparedBeforeSystemCheck('restore-failed', [
      'entra-id',
      'file-outbound',
    ]);

    expect(result).toMatchObject({
      success: false,
      phase: 'ROLLBACK_FAILED',
      rolledBack: false,
      commitSuccess: false,
      error: 'One or more systems failed to commit',
    });
    expect(result.systems['entra-id']).toMatchObject({
      status: 'ROLLBACK_FAILED',
      error: 'Graph 503',
    });
    expect(result.systems['file-outbound']).toMatchObject({ status: 'FAILED' });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'distributed-transaction', tenantId: 'tenant-a' }),
    );
  }, 60_000);

  it('keeps the account state captured before the commit out of the history', async () => {
    // The Entra account as it was before the DELETE: none of it may reach the history.
    getUserByEmail.mockResolvedValue({
      id: 'entra-obj-ada',
      userPrincipalName: 'ada.night@corp.example',
      mail: 'ada.night@corp.example',
      displayName: 'Ada Night Porter',
      accountEnabled: true,
    });
    preparedBeforeSystemCheck.add('tx-snapshot-history');

    const handle = await harness.env.client.workflow.start(distributedTransactionWorkflow, {
      args: [
        {
          transactionId: 'tx-snapshot-history',
          user: userFor('snapshot-history'),
          targetSystems: ['entra-id', 'file-outbound'],
          operation: 'DELETE',
          tenantId: 'tenant-a',
          initiatedBy: 'e2e',
        } as DistributedTransactionRequest,
      ],
      taskQueue: harness.taskQueue,
      workflowId: 'dist-tx-e2e-snapshot-history',
    });
    const result = await handle.result();
    const history = historyText(await handle.fetchHistory()).join('\n');

    // The commit disabled the account, file-outbound failed, and the rollback re-enabled it.
    expect(result).toMatchObject({ phase: 'ROLLED_BACK', rolledBack: true });
    expect(disableEntraUser).toHaveBeenCalledWith(
      'snapshot-history@example.com',
      'tenant-a',
      undefined,
    );
    expect(patchUser).toHaveBeenCalledWith('entra-obj-ada', { accountEnabled: true });
    const ref = result.systems['entra-id'].previousState?.snapshotRef as string;
    expect(result.systems['entra-id'].previousState).toEqual({ snapshotRef: ref });
    expect(history).toContain(ref);
    for (const value of ['ada.night@corp.example', 'Ada Night Porter', 'entra-obj-ada']) {
      expect(history).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }
  }, 60_000);

  it('does not disable an account whose state could not be read before the DELETE', async () => {
    getUserByEmail.mockRejectedValue(new Error('Graph 503'));

    const result = await harness.env.client.workflow.execute(distributedTransactionWorkflow, {
      args: [
        {
          transactionId: 'tx-snapshot-read-fails',
          user: userFor('snapshot-read-fails'),
          targetSystems: ['entra-id'],
          operation: 'DELETE',
          tenantId: 'tenant-a',
          initiatedBy: 'e2e',
        } as DistributedTransactionRequest,
      ],
      taskQueue: harness.taskQueue,
      workflowId: 'dist-tx-e2e-snapshot-read-fails',
    });

    expect(result).toMatchObject({ success: false, prepareSuccess: false, commitSuccess: false });
    expect(result.systems).toEqual({});
    expect(disableEntraUser).not.toHaveBeenCalled();
    expect(patchUser).not.toHaveBeenCalled();
  }, 60_000);

  describe('an UPDATE', () => {
    const before = { jobTitle: 'Night Porter', department: 'Front Desk' };
    const update = (id: string, targetSystems: string[]) =>
      harness.env.client.workflow.execute(distributedTransactionWorkflow, {
        args: [
          {
            transactionId: `tx-${id}`,
            user: { ...userFor(id), jobTitle: 'Day Porter' },
            targetSystems,
            operation: 'UPDATE',
            tenantId: 'tenant-a',
            initiatedBy: 'e2e',
          } as DistributedTransactionRequest,
        ],
        taskQueue: harness.taskQueue,
        workflowId: `dist-tx-e2e-${id}`,
      });

    beforeEach(() => {
      captureUserState.mockResolvedValue({
        existed: true,
        objectId: 'entra-obj-upd',
        attributes: before,
      });
    });

    it('commits the update to the Entra account', async () => {
      const result = await update('update-commit', ['entra-id']);

      expect(result).toMatchObject({ success: true, phase: 'COMMITTED' });
      expect(updateUser).toHaveBeenCalledWith(
        'entra-obj-upd',
        expect.objectContaining({ email: 'update-commit@example.com', jobTitle: 'Day Porter' }),
      );
      // The values captured before the commit stay in the snapshot store.
      expect(JSON.stringify(result)).not.toContain('Night Porter');
    }, 60_000);

    it('writes the captured attributes back when another system fails to commit', async () => {
      preparedBeforeSystemCheck.add('tx-update-rollback');
      const result = await update('update-rollback', ['entra-id', 'file-outbound']);

      expect(result).toMatchObject({ success: false, phase: 'ROLLED_BACK', rolledBack: true });
      expect(updateUser).toHaveBeenCalledTimes(1);
      expect(restoreUserState).toHaveBeenCalledWith('entra-obj-upd', before);
      expect(result.systems['entra-id']).toMatchObject({ status: 'ROLLED_BACK' });
    }, 60_000);
  });

  it('records each phase in the transaction log, ending where the workflow ends', async () => {
    deleteUser.mockRejectedValue(new Error('Graph 503'));

    const result = await runPreparedBeforeSystemCheck('log-phases', ['entra-id', 'file-outbound']);

    const recorded = updateTransactionPhase.mock.calls.filter((c) => c[0] === 'tx-log-phases');
    expect(recorded.map((c) => c[1])).toEqual([
      'PREPARED',
      'COMMITTING',
      'FAILED',
      'ROLLING_BACK',
      'ROLLBACK_FAILED',
    ]);
    expect(recorded[recorded.length - 1][1]).toBe(result.phase);
    expect(recorded[recorded.length - 1][2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemName: 'entra-id', status: 'ROLLBACK_FAILED' }),
      ]),
    );
  }, 60_000);

  it.each([
    ['the plain-object patch', OLD_HISTORY],
    ['the rollback-failed-status patch', PRE_ROLLBACK_STATUS_HISTORY],
  ])(
    'replays a history recorded before %s',
    async (_patch, file) => {
      const history = JSON.parse(fs.readFileSync(file, 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
      ).resolves.toBeUndefined();
    },
    60_000,
  );
});
