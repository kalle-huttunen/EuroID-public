/**
 * The daily audit archive (WORM export of Merkle checkpoints), on the time-skipping Temporal test
 * server with mocked activities. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch audit-archive:fail-on-export-errors a checkpoint whose export failed (after the
 * activity's retries) was only logged: the run completed with `errors` in its result, so the
 * schedule showed success and an export that failed every night went unnoticed.
 *
 * Proves, for runs started now:
 *   - The other checkpoints are still exported, then the run fails (AuditArchiveExportFailed, not
 *     retried) naming how many failed and which checkpoints, the counts in its details.
 *   - A run where every export succeeds completes with its counts.
 *   - A history recorded before the patch (a failed export, the run completed) still replays.
 *
 * Fixture test/fixtures/audit-archive-pre-fail-on-export-errors.history.json was recorded with the
 * pre-patch workflow (commit 9f3c929c), from backend/:
 *   git show 9f3c929c:backend/src/workflows/audit-archive.workflow.ts \
 *     > src/workflows/audit-archive-pre-fail.workflow.ts
 *   TEMPORAL_E2E=1 AUDIT_ARCHIVE_FIXTURE_WORKFLOW=src/workflows/audit-archive-pre-fail.workflow.ts \
 *     npx jest -c test/jest-e2e.json audit-archive -t 'records the pre-patch fixture'
 *   rm src/workflows/audit-archive-pre-fail.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/audit-archive.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/audit-archive-pre-fail-on-export-errors.history.json',
);
const CHECKPOINTS = [
  { _id: 'root-1', checkpointId: 'cp-1', tenantId: 'tenant-a' },
  { _id: 'root-2', checkpointId: 'cp-2', tenantId: 'tenant-b' },
  { _id: 'root-3', checkpointId: 'cp-3', tenantId: 'tenant-a' },
];

describeTemporalE2E('audit archive workflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  const exportCheckpoint = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getUnarchivedCheckpoints: async () => CHECKPOINTS,
      exportCheckpoint: (...args: unknown[]) => exportCheckpoint(...args),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    exportCheckpoint.mockReset().mockImplementation(async (_tenantId: unknown, rootId: unknown) => {
      if (rootId === 'root-2') {
        throw ApplicationFailure.nonRetryable('Object Lock refused the upload', 'S3Error');
      }
      return { storagePath: `s3://audit/${String(rootId)}.json.gz`, eventCount: 10 };
    });
  });

  const archive = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start('auditArchiveWorkflow', {
      taskQueue: h.taskQueue,
      workflowId,
      args: [{}],
    });

  it('exports the other checkpoints, then fails the run naming the one that failed', async () => {
    const handle = await archive(harness, 'audit-archive-e2e-failed-export');
    const error = await handle.result().catch((e: unknown) => e);

    expect(exportCheckpoint.mock.calls.map(([, rootId]) => rootId)).toEqual([
      'root-1',
      'root-2',
      'root-3',
    ]);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect(cause.type).toBe('AuditArchiveExportFailed');
    expect(cause.nonRetryable).toBe(true);
    expect(cause.message).toBe(
      '1 of 3 audit checkpoints were not exported to WORM storage (cp-2); the others were.',
    );
    expect(cause.details).toEqual([{ checkpointsExported: 2, eventsExported: 20, errors: 1 }]);
  }, 60_000);

  it('completes with its counts when every export succeeds', async () => {
    exportCheckpoint.mockResolvedValue({ storagePath: 's3://audit/x.json.gz', eventCount: 5 });

    const handle = await archive(harness, 'audit-archive-e2e-all-exported');
    await expect(handle.result()).resolves.toEqual({
      checkpointsExported: 3,
      eventsExported: 15,
      errors: 0,
    });
  }, 60_000);

  it('replays a history recorded before the patch audit-archive:fail-on-export-errors', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.AUDIT_ARCHIVE_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (AUDIT_ARCHIVE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await archive(pre, 'audit-archive-e2e-pre-fail-on-export-errors');
        // The pre-patch code: the failed export is only counted, the run completes
        await expect(handle.result()).resolves.toEqual({
          checkpointsExported: 2,
          eventsExported: 20,
          errors: 1,
        });
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
