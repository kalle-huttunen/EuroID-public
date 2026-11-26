/**
 * End-to-end test that child workflows carry their parent's tenant, on the time-skipping
 * Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Routes read a workflow by id through getTenantWorkflow(), which answers 404 unless the
 * workflow's TenantId search attribute is the caller's tenant. Services start parents with it;
 * Temporal does not copy it to children, so reconciliation batches, orphan cleanups and admin
 * account provisioning were a 404 for their own tenant.
 *
 * Proves:
 *   - Each child started by dailyReconciliationWorkflow and onboardingWorkflow is readable
 *     through getTenantWorkflow() by the parent's tenant and a 404 for another tenant, and
 *     carries the parent's memo (the dev-tools list shows triggeredBy from it).
 *   - Histories recorded by the pre-patch code (children started without TenantId) still replay
 *     against the current code.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { getTenantWorkflow } from '../../src/infrastructure/temporal/tenant-workflow';
import { dailyReconciliationWorkflow, onboardingWorkflow } from '../../src/workflows';
import type { ReconciliationConfig } from '../../src/workflows/workflow-types';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

// The worker's entry module: it exports the children too, so they run on the same worker.
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const fixture = (name: string) => path.resolve(__dirname, '../fixtures', name);

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const memo = { triggeredBy: 'ReconciliationService', targetDescription: 'Daily recon: entra-id' };
const user = { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };

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

describeTemporalE2E('child workflows carry the parent tenant (e2e)', () => {
  let harness: WorkflowTestHarness;

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: 'provisioning-default',
      activities: {
        // dailyReconciliationWorkflow: one batch of one user, one orphan on entra-id.
        getWorkflowStartTime: async () => new Date('2026-11-22T00:00:00Z'),
        getReconciliationUserCount: async () => 1,
        getReconciliationBatchPlan: async () => [{ skip: 0, limit: 1, index: 0 }],
        fetchHubUsersPage: async () => ({ users: [user], nextPageToken: null }),
        detectUserDrift: async () => ({ email: user.email, hasDrift: false, drifts: [] }),
        runOrphanDetection: async () => [
          {
            driftId: 'drift-1',
            targetSystem: 'entra-id',
            externalId: 'ext-1',
            accountIdentifier: 'orphan@example.com',
            tenantId: TENANT,
          },
        ],
        updateDriftWorkflowId: async () => undefined,
        generateReport: async () => ({ reportId: 'report-1', tenantId: TENANT, drifts: [] }),
        // orphanCleanupWorkflow: grace periods pass (time skipping), the account stays disabled.
        getOrphanConfig: async () => ({
          gracePeriodDays: 1,
          extendedGraceDays: 1,
          autoDeleteAfterExtended: false,
        }),
        emitOrphanDetected: async () => undefined,
        // The account is still an orphan when the cleanup acts (patch recheck-before-acting)
        confirmOrphan: async () => ({ orphan: true }),
        disableOrphanAccount: async () => undefined,
        setOrphanDisabledAt: async () => undefined,
        // onboardingWorkflow: one new hire whose policy grants an admin account, no targets.
        getActiveTargetSystems: async () => [],
        getPipelineStatus: async () => 'DEPLOYED',
        recordProvisioningOutcome: async () => undefined,
        fetchNewHires: async () => [user],
        saveToHub: async () => 'identity-1',
        getUserByEmail: async () => user,
        getIdentityByEmail: async () => ({ _id: 'identity-1', profile: user, provisioning: [] }),
        evaluateUser: async () => ({
          operations: [],
          adminOperations: [
            {
              type: 'group',
              action: 'add',
              target: 'okta',
              targetId: 'admins',
              adminTier: 'TIER_1',
            },
          ],
        }),
        // adminAccountProvisioningWorkflow
        getOrCreateLinkedAdminIdentity: async () => ({
          adminIdentityId: 'admin-1',
          adminProfile: { email: 'adm-ada@example.com' },
        }),
        setProvisioningStatus: async () => undefined,
        writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
        writebackToHrSource: async () => undefined,
      },
    });
    // A deployment registers TenantId (docker-compose / Temporal setup); the test server must too.
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  /** Started the way the services start them: TenantId search attribute and a memo. */
  const startOptions = (workflowId: string) => ({
    taskQueue: harness.taskQueue,
    workflowId,
    searchAttributes: { TenantId: [TENANT] },
    memo,
  });

  async function expectTenantOnly(workflowId: string): Promise<void> {
    const { description } = await getTenantWorkflow(harness.env.client, workflowId, TENANT);
    expect(description.memo).toEqual(memo);
    await expect(getTenantWorkflow(harness.env.client, workflowId, OTHER_TENANT)).rejects.toThrow(
      NotFoundException,
    );
  }

  it('reconciliation batch and orphan-cleanup children are readable by the tenant only', async () => {
    const parentId = `t-${TENANT}-daily-recon`;
    await harness.env.client.workflow.execute(dailyReconciliationWorkflow, {
      args: [reconConfig],
      ...startOptions(parentId),
    });

    await expectTenantOnly(parentId);
    await expectTenantOnly(`${parentId}-batch-0`);
    // The cleanup's id is the drift's own (patch reconciliation:start-orphan-cleanup)
    await expectTenantOnly(`t-${TENANT}-orphan-cleanup-drift-1`);
  }, 60_000);

  it('the admin-account-provisioning child of onboarding is readable by the tenant only', async () => {
    const parentId = `t-${TENANT}-onboard-all`;
    await harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      ...startOptions(parentId),
    });

    // One child per admin tier (patch onboarding:provision-every-admin-tier): TIER_1 here
    await expectTenantOnly(`admin-provision-${parentId}-identity-1-t1`);
  }, 60_000);

  // Child ids derive from the parent's, so the replay runs under the recorded workflow id.
  it.each([
    ['reconciliation', 'reconciliation-pre-child-tenant.history.json', `t-${TENANT}-daily-recon`],
    ['onboarding', 'onboarding-pre-child-tenant.history.json', `t-${TENANT}-onboard-all`],
  ])(
    'replays a %s history recorded before the child tenant patch',
    async (_name, file, workflowId) => {
      const history = JSON.parse(fs.readFileSync(fixture(file), 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, workflowId),
      ).resolves.toBeUndefined();
    },
    60_000,
  );
});
