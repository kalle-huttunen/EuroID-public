/**
 * The scan scope of dailyReconciliationWorkflow (includedDepartments, excludedUsers), on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * The start body accepted both and nothing read them: every identity was scanned and
 * auto-corrected, a VIP listed in excludedUsers included. Behind the patches
 * reconciliation:scan-scope (parent) and reconcile-batch:scan-scope (child) the run hands its
 * scope to the count, to every batch (each batch's page fetch) and to orphan detection. The
 * count, the batch plan over it and each batch's skip/limit must see the same identities, or
 * batches skip or repeat some. The identity query that applies the scope is proven against
 * MongoDB in src/modules/identity/identity-scan-scope.integration.spec.ts; here the activities
 * apply it to an in-memory hub the same way.
 *
 * Proves:
 *   - A scoped run scans each identity in scope exactly once across three batches, and never
 *     scans or corrects an excluded one (by email, ignoring case, or by id) or one outside the
 *     departments.
 *   - A run without a scope (or with empty lists) calls the activities as before and scans all.
 *   - A history recorded before the patch (a scoped config the run ignored) still replays, and so
 *     does a pre-patch batch history.
 *
 * Fixture test/fixtures/reconciliation-pre-scan-scope.history.json was recorded with the
 * pre-patch workflow (commit 50b3dfbf), bundled with its children, from backend/:
 *   git show 50b3dfbf:backend/src/workflows/reconciliation.workflow.ts \
 *     > src/workflows/reconciliation-pre-scan-scope.workflow.ts
 *   printf '%s\n' "export * from './reconciliation-pre-scan-scope.workflow';" \
 *     "export * from './reconcile-batch.workflow';" "export * from './orphan-cleanup.workflow';" \
 *     > src/workflows/reconciliation-pre-scan-scope.entry.ts
 *   TEMPORAL_E2E=1 \
 *     RECON_SCOPE_FIXTURE_WORKFLOWS=src/workflows/reconciliation-pre-scan-scope.entry.ts \
 *     npx jest -c test/jest-e2e.json reconciliation-scan-scope -t 'records the pre-patch fixture'
 *   rm src/workflows/reconciliation-pre-scan-scope.workflow.ts \
 *     src/workflows/reconciliation-pre-scan-scope.entry.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { dailyReconciliationWorkflow } from '../../src/workflows';
import type { ReconciliationConfig, SystemDrift } from '../../src/workflows/workflow-types';
import type { ReconciliationScope } from '../../src/shared/utils/reconciliation-scope';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

// The worker's entry module: it exports the children too, so they run on the same worker.
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const BATCH_WORKFLOW_PATH = path.resolve(
  __dirname,
  '../../src/workflows/reconcile-batch.workflow.ts',
);
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconciliation-pre-scan-scope.history.json',
);
// The pre-scan-scope batch history (recorded before any batch patch of this release)
const PRE_PATCH_BATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconcile-batch-pre-approval-for-deletes.history.json',
);
// Child ids derive from the parent's, so the replay runs under the recorded workflow id.
const PRE_PATCH_WORKFLOW_ID = 'recon-e2e-pre-scan-scope';

const TENANT = 'tenant-a';

interface HubIdentity {
  _id: string;
  email: string;
  departmentName?: string;
  departmentCode?: string;
}

const id = (n: number) => n.toString(16).padStart(24, '0');

/** The tenant's live identities in _id order, as the identity query pages them. */
const HUB: HubIdentity[] = [
  { _id: id(1), email: 'ada@example.com', departmentName: 'Sales' },
  { _id: id(2), email: 'bob@example.com', departmentName: 'R&D' },
  { _id: id(3), email: 'Ceo@Example.com', departmentName: 'Sales' },
  { _id: id(4), email: 'dan@example.com', departmentCode: 'SALES' },
  { _id: id(5), email: 'eve@example.com', departmentName: 'sales' },
  { _id: id(6), email: 'fay@example.com', departmentName: 'Sales Support' },
  { _id: id(7), email: 'gil@example.com', departmentName: 'Sales' },
  { _id: id(8), email: 'hal@example.com', departmentName: 'Sales' },
  { _id: id(9), email: 'ivy@example.com', departmentName: 'Sales' },
];

/** Sales, without the CEO (by email, other case) and Eve (by identity id). */
const SCOPE: ReconciliationScope = {
  includedDepartments: ['sales'],
  excludedUsers: ['ceo@example.com', id(5)],
};
const IN_SCOPE = [id(1), id(4), id(7), id(8), id(9)];

/** The scope as identity-scan-scope.ts applies it (exact, case ignored). */
function inScope(identity: HubIdentity, scope?: ReconciliationScope): boolean {
  const lower = (v?: string) => (v ?? '').toLowerCase();
  const departments = (scope?.includedDepartments ?? []).map(lower);
  if (
    departments.length > 0 &&
    !departments.includes(lower(identity.departmentName)) &&
    !departments.includes(lower(identity.departmentCode))
  ) {
    return false;
  }
  const excluded = (scope?.excludedUsers ?? []).map(lower);
  return !excluded.includes(identity._id) && !excluded.includes(lower(identity.email));
}

const config = (overrides: Partial<ReconciliationConfig>): ReconciliationConfig => ({
  tenantId: TENANT,
  targetSystems: ['entra-id'],
  autoCorrect: true,
  autoCorrectTypes: ['FIELD_MISMATCH'] as ReconciliationConfig['autoCorrectTypes'],
  requireApprovalForDeletes: true,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 0,
  criticalDriftAlertThreshold: 0,
  ...overrides,
});

describeTemporalE2E('reconciliation scan scope (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getReconciliationUserCount = jest.fn();
  const fetchHubUsersPage = jest.fn();
  const detectUserDrift = jest.fn();
  const correctDrift = jest.fn();
  const runOrphanDetection = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getWorkflowStartTime: async () => new Date('2026-11-25T00:00:00Z'),
      getReconciliationUserCount: (...args: unknown[]) => getReconciliationUserCount(...args),
      // Batches of two over the count: a scoped run of five identities has three
      getReconciliationBatchPlan: async (_tenantId: unknown, total: unknown) =>
        Array.from({ length: Math.ceil(Number(total) / 2) }, (_, index) => ({
          skip: index * 2,
          limit: Math.min(2, Number(total) - index * 2),
          index,
        })),
      fetchHubUsersPage: (...args: unknown[]) => fetchHubUsersPage(...args),
      detectUserDrift: (...args: unknown[]) => detectUserDrift(...args),
      correctDrift: (...args: unknown[]) => correctDrift(...args),
      runOrphanDetection: (...args: unknown[]) => runOrphanDetection(...args),
      updateDriftWorkflowId: async () => undefined,
      generateReport: async () => ({ reportId: 'report-1', tenantId: TENANT, drifts: [] }),
    },
  });

  const run = (workflowId: string, overrides: Partial<ReconciliationConfig> = {}) =>
    harness.env.client.workflow.execute(dailyReconciliationWorkflow, {
      args: [config(overrides)],
      taskQueue: harness.taskQueue,
      workflowId,
    });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    getReconciliationUserCount
      .mockReset()
      .mockImplementation(
        async (_tenantId: string, scope?: ReconciliationScope) =>
          HUB.filter((i) => inScope(i, scope)).length,
      );
    fetchHubUsersPage
      .mockReset()
      .mockImplementation(
        async (_tenantId: string, pageToken: string, size: number, scope?: ReconciliationScope) => {
          const skip = Number(pageToken);
          const users = HUB.filter((i) => inScope(i, scope)).slice(skip, skip + size);
          return { users, nextPageToken: users.length === size ? String(skip + size) : null };
        },
      );
    detectUserDrift.mockReset().mockImplementation(async (user: HubIdentity) => ({
      userId: user._id,
      email: user.email,
      hasDrift: true,
      hubState: user,
      drifts: [
        {
          system: 'entra-id',
          driftType: 'FIELD_MISMATCH',
          field: 'jobTitle',
          description: 'Field "jobTitle" differs',
          severity: 'MEDIUM',
          autoCorrect: true,
        } as SystemDrift,
      ],
      severity: 'MEDIUM',
      detectedAt: new Date('2026-11-25T00:00:00Z'),
    }));
    correctDrift.mockReset().mockImplementation(async (d: SystemDrift, user: HubIdentity) => ({
      driftId: `${d.system}:${user._id}:${d.driftType}`,
      system: d.system,
      action: 'UPDATE',
      user,
      success: true,
      executedAt: new Date('2026-11-25T00:00:00Z'),
    }));
    runOrphanDetection.mockReset().mockResolvedValue([]);
  });

  const scanned = () => detectUserDrift.mock.calls.map(([user]) => (user as HubIdentity)._id);
  const corrected = () => correctDrift.mock.calls.map(([, user]) => (user as HubIdentity)._id);

  it('scans each identity in scope once across its batches, and corrects no other', async () => {
    const report = await run('recon-e2e-scope', SCOPE);

    expect([...scanned()].sort()).toEqual(IN_SCOPE);
    expect(scanned()).toHaveLength(IN_SCOPE.length);
    expect([...corrected()].sort()).toEqual(IN_SCOPE);
    expect(report.scannedUsers).toBe(IN_SCOPE.length);

    // The count, every batch's fetch and orphan detection got the same scope
    expect(getReconciliationUserCount).toHaveBeenCalledWith(TENANT, SCOPE);
    expect(fetchHubUsersPage).toHaveBeenCalledTimes(3);
    for (const call of fetchHubUsersPage.mock.calls) expect(call[3]).toEqual(SCOPE);
    expect(runOrphanDetection).toHaveBeenCalledWith('entra-id', TENANT, SCOPE);
  }, 60_000);

  it('scans every identity without a scope, calling the activities as before', async () => {
    await run('recon-e2e-no-scope', { includedDepartments: [], excludedUsers: [] });

    expect([...scanned()].sort()).toEqual(HUB.map((i) => i._id));
    expect(scanned()).toHaveLength(HUB.length);
    expect(getReconciliationUserCount.mock.calls).toEqual([[TENANT]]);
    for (const call of fetchHubUsersPage.mock.calls) expect(call).toHaveLength(3);
    expect(runOrphanDetection.mock.calls).toEqual([['entra-id', TENANT]]);
  }, 60_000);

  it('replays a history recorded before the scan-scope patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('replays a batch history recorded before the batch scan-scope patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_BATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: BATCH_WORKFLOW_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.RECON_SCOPE_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (RECON_SCOPE_FIXTURE_WORKFLOWS = entry of the pre-patch bundle)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(dailyReconciliationWorkflow, {
          args: [config(SCOPE)],
          taskQueue: pre.taskQueue,
          workflowId: PRE_PATCH_WORKFLOW_ID,
        });
        await handle.result();
        // The pre-patch run ignored the scope: every identity was scanned and corrected
        expect(scanned()).toHaveLength(HUB.length);
        expect(corrected()).toContain(id(3));
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
