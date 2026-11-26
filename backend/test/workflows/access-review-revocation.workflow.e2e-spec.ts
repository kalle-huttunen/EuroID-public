/**
 * End-to-end test for accessReviewWorkflow's revocation through the connectors on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * worker.ts registers revokeReviewAccess only on the connector queues (provisioning-entra, -ad,
 * -okta, -scim). Here the default-queue worker has neither revokeReviewAccess nor the legacy
 * executeRevocations, so a revocation routed to the wrong queue, or the old Entra-only path,
 * fails the run.
 *
 * Proves:
 *   - Every revoked entitlement is removed on its connector's queue and its outcome recorded,
 *     also when nothing is pending at the end; then the campaign completes.
 *   - An account item (patch access-review:account-revocation) is removed by
 *     revokeReviewAccount on the default queue, next to the memberships on their queues.
 *   - A decision signal while items are still pending does not end the campaign.
 *   - A cancelled run (AccessReviewCampaignService.cancel cancels the workflow) ends there:
 *     nothing is escalated, expired, revoked or completed after the cancel.
 *   - A cancel during a revocation batch (patch access-review-revocation:rethrow-cancellation)
 *     stops the batch: the removals already made are recorded, nothing else is attempted.
 *   - Histories recorded before the patches access-review:connector-revocation,
 *     access-review:account-revocation and access-review-revocation:rethrow-cancellation replay
 *     against the current code.
 *
 * The pre-patch fixture is recorded from the workflow as of 5fdeac79 (pending: run once with
 * RECORD_ACCESS_REVIEW_HISTORY=1 and that version checked out, see the recorder below).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { CancelledFailure } from '@temporalio/common';
import {
  accessReviewWorkflow,
  signalItemDecidedSignal,
} from '../../src/workflows/access-review.workflow';
import type { RevocationTask } from '../../src/shared/types/access-review-revocation';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';
import { decryptedHistory } from '../helpers/test-payload-codec';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/access-review.workflow.ts');
const OLD_HISTORY = path.resolve(
  __dirname,
  '../fixtures/access-review-pre-connector-revocation.history.json',
);
const RECORD = process.env.RECORD_ACCESS_REVIEW_HISTORY === '1';
const PRE_ACCOUNT_HISTORY = path.resolve(
  __dirname,
  '../fixtures/access-review-pre-account-revocation.history.json',
);
const RECORD_PRE_ACCOUNT = process.env.RECORD_ACCESS_REVIEW_ACCOUNT_HISTORY === '1';
const PRE_RETHROW_HISTORY = path.resolve(
  __dirname,
  '../fixtures/access-review-pre-rethrow-cancellation.history.json',
);
const RECORD_PRE_RETHROW = process.env.RECORD_ACCESS_REVIEW_CANCEL_HISTORY === '1';

/** `promise`, or a failure saying what did not happen within `ms` (real time). */
function within<T>(promise: Promise<T>, ms: number, failure: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(failure)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A fetched history as JSON in the form Temporal tools write (Worker.runReplayHistory reads it).
 * Same as historyToJSON from @temporalio/common, which throws on payload metadata: its
 * proto3-json-serializer (2.0.2) cannot write map<string, bytes> values
 * (googleapis/proto3-json-serializer-nodejs#103), so they are base64-encoded first, as proto3
 * JSON writes bytes.
 */
function historyJson(history: unknown): string {
  /* eslint-disable @typescript-eslint/no-require-imports -- recorder only; transitive deps */
  const { temporal } = require('@temporalio/proto');
  const { toProto3JSON } = require('proto3-json-serializer');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const message = temporal.api.history.v1.History.fromObject(history);
  const encodeMetadata = (node: unknown): void => {
    if (!node || typeof node !== 'object' || node instanceof Uint8Array) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
        (node as Record<string, unknown>)[key] = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v,
          ]),
        );
      } else if (Array.isArray(value)) {
        value.forEach(encodeMetadata);
      } else {
        encodeMetadata(value);
      }
    }
  };
  encodeMetadata(message);
  return JSON.stringify(toProto3JSON(message), null, 2);
}

const TENANT = 'tenant-a';
const QUEUES = {
  entra: 'provisioning-entra',
  ad: 'provisioning-ad',
  okta: 'provisioning-okta',
  scim: 'provisioning-scim',
} as const;

describeTemporalE2E('accessReviewWorkflow revocation through the connectors (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getCampaignProgress = jest.fn();
  const getRemainingMsUntilDeadline = jest.fn();
  const checkAndEscalateOverdue = jest.fn();
  const expirePendingItems = jest.fn();
  const completeCampaign = jest.fn();
  const listRevocationTasks = jest.fn();
  const recordRevocationResults = jest.fn();
  const revokeReviewAccount = jest.fn();
  const revokedOn: Array<{ queue: string; task: RevocationTask }> = [];
  /** A removal on this queue says it started and then waits until the test lets it finish. */
  let held: { queue: string; started: () => void; until: Promise<void> } | undefined;

  const revokeOn =
    (queue: string) =>
    async (...args: unknown[]) => {
      revokedOn.push({ queue, task: args[0] as RevocationTask });
      if (held?.queue === queue) {
        held.started();
        await held.until;
      }
      return { outcome: 'removed', detail: 'removed from group' };
    };

  const cancelTasks: RevocationTask[] = (['entra', 'ad', 'okta'] as const).map((connector, i) => ({
    itemId: `item-${i}`,
    entitlementIndex: 0,
    connector,
  }));

  /**
   * Cancels the run while the second removal of a batch of three (AD) runs: the Entra ID removal
   * has finished, the Okta one has not started. The AD removal finishes after the run ended.
   */
  async function cancelDuringRevocation(campaignId: string, workflowId: string) {
    listRevocationTasks.mockResolvedValueOnce({ tasks: cancelTasks, more: false });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    held = { queue: QUEUES.ad, started, until: new Promise<void>((resolve) => (release = resolve)) };
    try {
      const handle = await harness.env.client.workflow.start(accessReviewWorkflow, {
        args: [{ campaignId, deadline: new Date(), tenantId: TENANT }],
        taskQueue: harness.taskQueue,
        workflowId,
      });
      await within(running, 5000, 'The AD removal did not start within 5 s');
      await handle.cancel();
      const failure = await handle.result().then(
        () => null,
        (err: unknown) => err,
      );
      return { handle, failure };
    } finally {
      release();
      held = undefined;
    }
  }

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: 'provisioning-default',
      activities: {
        getCampaignProgress: (...args: unknown[]) => getCampaignProgress(...args),
        getRemainingMsUntilDeadline: (...args: unknown[]) => getRemainingMsUntilDeadline(...args),
        checkAndEscalateOverdue: (...args: unknown[]) => checkAndEscalateOverdue(...args),
        expirePendingItems: (...args: unknown[]) => expirePendingItems(...args),
        completeCampaign: (...args: unknown[]) => completeCampaign(...args),
        listRevocationTasks: (...args: unknown[]) => listRevocationTasks(...args),
        recordRevocationResults: (...args: unknown[]) => recordRevocationResults(...args),
        revokeReviewAccount: (...args: unknown[]) => revokeReviewAccount(...args),
        // Only for recording the pre-patch fixture (RECORD_ACCESS_REVIEW_HISTORY=1)
        ...(RECORD ? { executeRevocations: async () => 0 } : {}),
      },
      queueWorkers: Object.values(QUEUES).map((queue) => ({
        taskQueue: queue,
        activities: { revokeReviewAccess: revokeOn(queue) },
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    revokedOn.length = 0;
    getCampaignProgress.mockReset().mockResolvedValue({ total: 4, pending: 0, decided: 4 });
    getRemainingMsUntilDeadline.mockReset().mockResolvedValue(0);
    checkAndEscalateOverdue.mockReset().mockResolvedValue(0);
    expirePendingItems.mockReset().mockResolvedValue(0);
    completeCampaign.mockReset().mockResolvedValue(undefined);
    listRevocationTasks.mockReset().mockResolvedValue({ tasks: [], more: false });
    recordRevocationResults.mockReset().mockResolvedValue(undefined);
    revokeReviewAccount.mockReset();
  });

  it("removes each revoked entitlement on its connector's queue, then completes", async () => {
    const tasks: RevocationTask[] = (['entra', 'ad', 'okta', 'scim'] as const).map(
      (connector, i) => ({ itemId: `item-${i}`, entitlementIndex: 0, connector }),
    );
    listRevocationTasks.mockResolvedValueOnce({ tasks, more: false });
    const workflowId = 'access-review-e2e-revocation';

    await harness.env.client.workflow.execute(accessReviewWorkflow, {
      args: [{ campaignId: 'camp-1', deadline: new Date(), tenantId: TENANT }],
      taskQueue: harness.taskQueue,
      workflowId,
    });

    expect(revokedOn).toEqual(
      tasks.map((task) => ({ queue: QUEUES[task.connector as keyof typeof QUEUES], task })),
    );
    // New runs ask for account items as well (patch access-review:account-revocation)
    expect(listRevocationTasks).toHaveBeenCalledWith('camp-1', TENANT, workflowId, true);
    expect(recordRevocationResults).toHaveBeenCalledWith(
      'camp-1',
      tasks.map(({ itemId, entitlementIndex }) => ({
        itemId,
        entitlementIndex,
        outcome: 'removed',
        detail: 'removed from group',
      })),
      TENANT,
      workflowId,
    );
    expect(expirePendingItems).not.toHaveBeenCalled();
    expect(completeCampaign).toHaveBeenCalledWith('camp-1', TENANT);
  }, 60_000);

  it('removes an account item on the default queue and records its outcome with the rest', async () => {
    const accountTask: RevocationTask = { itemId: 'item-acc', entitlementIndex: 0, connector: 'account' };
    const groupTask: RevocationTask = { itemId: 'item-grp', entitlementIndex: 0, connector: 'okta' };
    listRevocationTasks.mockResolvedValueOnce({ tasks: [accountTask, groupTask], more: false });
    revokeReviewAccount
      .mockRejectedValueOnce(new Error('github: socket hang up')) // retried (CONNECTOR_RETRY)
      .mockResolvedValueOnce({ outcome: 'removed', detail: 'removed from organization' });
    const workflowId = 'access-review-e2e-account';

    await harness.env.client.workflow.execute(accessReviewWorkflow, {
      args: [{ campaignId: 'camp-acc', deadline: new Date(), tenantId: TENANT }],
      taskQueue: harness.taskQueue,
      workflowId,
    });

    expect(listRevocationTasks).toHaveBeenCalledWith('camp-acc', TENANT, workflowId, true);
    expect(revokeReviewAccount).toHaveBeenCalledTimes(2);
    expect(revokeReviewAccount).toHaveBeenLastCalledWith(accountTask, TENANT, workflowId);
    expect(revokedOn).toEqual([{ queue: QUEUES.okta, task: groupTask }]);
    expect(recordRevocationResults).toHaveBeenCalledWith(
      'camp-acc',
      [
        {
          itemId: 'item-acc',
          entitlementIndex: 0,
          outcome: 'removed',
          detail: 'removed from organization',
        },
        { itemId: 'item-grp', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
      ],
      TENANT,
      workflowId,
    );
    expect(completeCampaign).toHaveBeenCalledWith('camp-acc', TENANT);
  }, 60_000);

  it('a decision signal while items are pending does not end the campaign', async () => {
    getRemainingMsUntilDeadline.mockResolvedValue(10 * 60_000);
    getCampaignProgress
      .mockResolvedValueOnce({ total: 3, pending: 3, decided: 0 })
      .mockResolvedValueOnce({ total: 3, pending: 2, decided: 1 })
      .mockResolvedValueOnce({ total: 3, pending: 1, decided: 2 })
      .mockResolvedValue({ total: 3, pending: 0, decided: 3 });

    const handle = await harness.env.client.workflow.start(accessReviewWorkflow, {
      args: [{ campaignId: 'camp-2', deadline: new Date(), tenantId: TENANT }],
      taskQueue: harness.taskQueue,
      workflowId: 'access-review-e2e-early-signal',
    });
    await handle.signal(signalItemDecidedSignal);
    await handle.result();

    expect(getCampaignProgress.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(expirePendingItems).not.toHaveBeenCalled();
    expect(completeCampaign).toHaveBeenCalledWith('camp-2', TENANT);
  }, 60_000);

  it('a cancelled run stops: nothing escalated, expired, revoked or completed after it', async () => {
    getRemainingMsUntilDeadline.mockResolvedValue(60 * 60_000);
    getCampaignProgress.mockResolvedValue({ total: 2, pending: 2, decided: 0 });

    const handle = await harness.env.client.workflow.start(accessReviewWorkflow, {
      args: [{ campaignId: 'camp-3', deadline: new Date(), tenantId: TENANT }],
      taskQueue: harness.taskQueue,
      workflowId: 'access-review-e2e-cancel',
    });
    // Wait (real time; time skips only while a result is awaited) until it waits for the deadline
    for (let i = 0; i < 200 && getRemainingMsUntilDeadline.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(getRemainingMsUntilDeadline).toHaveBeenCalled();
    await handle.cancel();
    const escalationChecks = checkAndEscalateOverdue.mock.calls.length;

    const failure = await handle.result().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect((failure as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
    expect((await handle.describe()).status.name).toBe('CANCELLED');
    expect(checkAndEscalateOverdue).toHaveBeenCalledTimes(escalationChecks);
    expect(expirePendingItems).not.toHaveBeenCalled();
    expect(listRevocationTasks).not.toHaveBeenCalled();
    expect(completeCampaign).not.toHaveBeenCalled();
  }, 60_000);

  // Before the patch the cancel became a `failed` result, the rest of the batch failed at once,
  // and the record was cancelled too: the Entra ID removal made before the cancel went unrecorded.
  it('a cancel during a revocation batch stops it and records the removals already made', async () => {
    const workflowId = 'access-review-e2e-cancel-revocation';

    const { handle, failure } = await cancelDuringRevocation('camp-4', workflowId);

    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect((failure as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
    expect((await handle.describe()).status.name).toBe('CANCELLED');
    expect(revokedOn.map((r) => r.queue)).toEqual([QUEUES.entra, QUEUES.ad]);
    expect(recordRevocationResults).toHaveBeenCalledTimes(1);
    expect(recordRevocationResults).toHaveBeenCalledWith(
      'camp-4',
      [{ itemId: 'item-0', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' }],
      TENANT,
      workflowId,
    );
    expect(completeCampaign).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the rethrow-cancellation patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_RETHROW_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /**
   * Recorder for the fixture above, not a test: recorded from the workflow as of fb91146f with
   * `RECORD_ACCESS_REVIEW_CANCEL_HISTORY=1 TEMPORAL_E2E=1 npx jest --config test/jest-e2e.json
   * --maxWorkers=1 access-review-revocation`. The scenario is the cancel during a batch above.
   */
  (RECORD_PRE_RETHROW ? it : it.skip)(
    'records the history before the rethrow-cancellation patch',
    async () => {
      const { handle, failure } = await cancelDuringRevocation(
        'camp-pre-rethrow',
        'access-review-pre-rethrow-cancellation',
      );
      expect((failure as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
      expect(revokedOn.map((r) => r.queue)).toEqual([QUEUES.entra, QUEUES.ad]);
      fs.writeFileSync(PRE_RETHROW_HISTORY, historyJSON(await handle.fetchHistory()));
    },
    60_000,
  );

  it('replays a history recorded before the connector-revocation patch', async () => {
    if (!fs.existsSync(OLD_HISTORY)) {
      throw new Error(
        `Fixture pending: ${OLD_HISTORY}. Record it with the workflow as of 5fdeac79 ` +
          '(see "records the pre-patch history" in this file).',
      );
    }
    const history = JSON.parse(fs.readFileSync(OLD_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /**
   * Recorder for the fixture above, not a test. With the pre-patch workflow checked out
   * (`git show 5fdeac79:backend/src/workflows/access-review.workflow.ts >
   * backend/src/workflows/access-review.workflow.ts`, restore it afterwards), run
   * `RECORD_ACCESS_REVIEW_HISTORY=1 TEMPORAL_E2E=1 npx jest --config test/jest-e2e.json
   * --maxWorkers=1 access-review-revocation`. The scenario covers what the patch changed: a
   * decision signal ending the loop, then expirePendingItems and executeRevocations.
   */
  (RECORD ? it : it.skip)(
    'records the pre-patch history',
    async () => {
      getRemainingMsUntilDeadline.mockResolvedValue(10 * 60_000);
      getCampaignProgress.mockResolvedValue({ total: 3, pending: 2, decided: 1 });
      const handle = await harness.env.client.workflow.start(accessReviewWorkflow, {
        args: [{ campaignId: 'camp-old', deadline: new Date(), tenantId: TENANT }],
        taskQueue: harness.taskQueue,
        workflowId: 'access-review-pre-connector-revocation',
      });
      await handle.signal(signalItemDecidedSignal);
      await handle.result();
      expect(expirePendingItems).toHaveBeenCalled();
      fs.writeFileSync(OLD_HISTORY, historyJson(decryptedHistory(await handle.fetchHistory())));
    },
    60_000,
  );

  it('replays a history recorded before the account-revocation patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_ACCOUNT_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /**
   * Recorder for the fixture above, not a test: recorded from the workflow as of ca5a8b11 with
   * `RECORD_ACCESS_REVIEW_ACCOUNT_HISTORY=1 TEMPORAL_E2E=1 npx jest --config test/jest-e2e.json
   * --maxWorkers=1 access-review-revocation`. The scenario runs through what the patch changed:
   * one poll of the deadline loop, then a revocation batch on the connector queues.
   */
  (RECORD_PRE_ACCOUNT ? it : it.skip)(
    'records the history before the account-revocation patch',
    async () => {
      getRemainingMsUntilDeadline.mockResolvedValue(10 * 60_000);
      getCampaignProgress
        .mockResolvedValueOnce({ total: 2, pending: 1, decided: 1 })
        .mockResolvedValue({ total: 2, pending: 0, decided: 2 });
      listRevocationTasks.mockResolvedValueOnce({
        tasks: [
          { itemId: 'item-a', entitlementIndex: 0, connector: 'entra' },
          { itemId: 'item-b', entitlementIndex: 1, connector: 'scim' },
        ],
        more: false,
      });
      const handle = await harness.env.client.workflow.start(accessReviewWorkflow, {
        args: [{ campaignId: 'camp-pre-account', deadline: new Date(), tenantId: TENANT }],
        taskQueue: harness.taskQueue,
        workflowId: 'access-review-pre-account-revocation',
      });
      await handle.result();
      expect(revokedOn).toHaveLength(2);
      expect(completeCampaign).toHaveBeenCalledWith('camp-pre-account', TENANT);
      fs.writeFileSync(PRE_ACCOUNT_HISTORY, historyJSON(await handle.fetchHistory()));
    },
    60_000,
  );
});
