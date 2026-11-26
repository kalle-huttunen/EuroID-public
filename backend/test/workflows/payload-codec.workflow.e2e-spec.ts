/**
 * The Temporal payload codec end to end, on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * The harness's client and workers run the codec of the API and the worker
 * (src/infrastructure/temporal/temporal-payload-codec.ts, test/helpers/test-payload-codec.ts).
 *
 * Proves:
 *   - A one-person onboarding started with the person's email: the history as the Temporal server
 *     stores it holds neither the address nor the name (input, activity arguments and results,
 *     the result), while the activities and the client get the plaintext.
 *   - A client with another key under the same key id fails loudly on the result, naming the key
 *     id, instead of passing ciphertext on.
 *   - The encrypted history replays with the codec, and does not without it.
 *   - Every replay fixture in test/fixtures/, recorded before the codec, replays with the codec
 *     against the worker's pre-built bundle of src/workflows (as production loads it):
 *     decoding passes unencrypted payloads through.
 *   - Failure messages are not payloads, so the codec leaves them in clear: a one-person run for
 *     an unknown address fails (UserNotFound) without the address in its message or anywhere in
 *     the stored history, and a history recorded while the message still named the address
 *     replays (replay compares the failure command, not its message).
 *
 * Fixture test/fixtures/onboarding-pre-no-email-in-failure.history.json was recorded with the
 * workflow before the UserNotFound message lost the address (commit 9236839c), from backend/:
 *   git show 9236839c:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-no-email.workflow.ts
 *   TEMPORAL_E2E=1 NO_EMAIL_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-no-email.workflow.ts \
 *     npx jest -c test/jest-e2e.json payload-codec -t 'records the pre-change fixture'
 *   rm src/workflows/onboarding-pre-no-email.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Client, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import {
  ENCRYPTED_PAYLOAD_ENCODING,
  PAYLOAD_KEY_ID_METADATA,
  TemporalPayloadCodec,
  TemporalPayloadDecryptionError,
} from '../../src/infrastructure/temporal/temporal-payload-codec';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';
import { historyText } from '../helpers/history-text';
import { TEST_PAYLOAD_KEY_ID, testDataConverter } from '../helpers/test-payload-codec';

const ONBOARDING_PATH = path.resolve(__dirname, '../../src/workflows/onboarding.workflow.ts');
// The worker's entry module (worker.ts bundles src/workflows)
const WORKFLOWS_INDEX = path.resolve(__dirname, '../../src/workflows/index.ts');
const FIXTURES = path.resolve(__dirname, '../fixtures');
const FIXTURE_FILES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.history.json'));
// Child ids derive from the parent's, so these replay under their recorded workflow id
// (child-workflow-tenant.workflow.e2e-spec.ts); the rest under Temporal's default, as their suites
const RECORDED_WORKFLOW_IDS: Record<string, string> = {
  'reconciliation-pre-child-tenant.history.json': 't-tenant-a-daily-recon',
  'onboarding-pre-child-tenant.history.json': 't-tenant-a-onboard-all',
  // reconciliation-orphan-cleanup-start.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID)
  'reconciliation-pre-start-orphan-cleanup.history.json': 'recon-e2e-pre-start-orphan-cleanup',
  // reconciliation-drift-alerts.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its batch children
  // are named after the parent's id
  'reconciliation-pre-drift-threshold-alerts.history.json': 'recon-e2e-pre-drift-threshold-alerts',
  // reconciliation-scan-scope.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its batch children
  // are named after the parent's id
  'reconciliation-pre-scan-scope.history.json': 'recon-e2e-pre-scan-scope',
  // onboarding-admin-tiers.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its admin provisioning
  // child is named after the parent's id
  'onboarding-pre-every-admin-tier.history.json': 't-tenant-a-onboard-tiers',
  // onboarding-pipeline-guard.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its admin provisioning
  // child is named after the parent's id
  'onboarding-pre-pipeline-guard-deployed.history.json': 't-tenant-a-onboard-pre-guard',
  // onboarding-admin-account-failure.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its admin
  // provisioning child is named after the parent's id
  'onboarding-pre-admin-account-failure.history.json': 't-tenant-a-onboard-pre-admin-failure',
  // reconciliation-orphan-detection.workflow.e2e-spec.ts (PRE_PATCH_WORKFLOW_ID): its batch
  // children are named after the parent's id
  'reconciliation-pre-orphan-detection-heartbeat.history.json':
    'recon-e2e-pre-orphan-detection-heartbeat',
};
const TENANT = 'tenant-a';

const PRE_CHANGE_HISTORY = path.join(FIXTURES, 'onboarding-pre-no-email-in-failure.history.json');

const ada = { email: 'ada.codec@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const UNKNOWN = 'nobody.codec@example.com';
const IDENTITY_ID = 'identity-ada';
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'Finance Team' };

type History = temporal.api.history.v1.IHistory;
type Payload = temporal.api.common.v1.IPayload;
const text = (bytes: Uint8Array | null | undefined) => Buffer.from(bytes ?? []).toString();

describeTemporalE2E('Temporal payload codec (e2e)', () => {
  let harness: WorkflowTestHarness;
  const getIdentityByEmail = jest.fn();
  const evaluateUser = jest.fn();
  const provisionUserToEntra = jest.fn();
  let workflowId: string;
  let result: unknown;
  let raw: History;

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: async () => ['entra'],
      getConnectorConfig: async () => null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [],
      saveToHub: async () => IDENTITY_ID,
      getUserByEmail: async (email: unknown) => (email === ada.email ? ada : null),
      getIdentityByEmail: (...args: unknown[]) => getIdentityByEmail(...args),
      setProvisioningStatus: async () => undefined,
      evaluateUser: (...args: unknown[]) => evaluateUser(...args),
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
      recordOnboardingBlocked: async () => undefined,
      // Access review exclusions (onboarding-review-exclusions.ts): none for this person
      getReviewExcludedTargets: async () => [],
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
  });

  /** A one-person run for an address no identity and no Hub user has. */
  const startUnknownPerson = (h: WorkflowTestHarness, id: string) =>
    h.env.client.workflow.start(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: UNKNOWN }],
      taskQueue: h.taskQueue,
      workflowId: id,
    });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: ONBOARDING_PATH, ...workers() });
    getIdentityByEmail.mockImplementation(async (email: unknown) =>
      email === ada.email ? { _id: IDENTITY_ID, profile: ada, provisioning: [] } : null,
    );
    evaluateUser.mockResolvedValue({ operations: [groupOp] });
    provisionUserToEntra.mockResolvedValue({ success: true, objectId: 'entra-obj-ada' });

    workflowId = 'payload-codec-e2e-onboarding';
    const handle = await harness.env.client.workflow.start(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: ada.email }],
      taskQueue: harness.taskQueue,
      workflowId,
    });
    result = await handle.result();
    raw = await handle.fetchHistory();
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  it('stores neither the email nor the name in the history; activities and client get them', () => {
    const stored = Buffer.from(temporal.api.history.v1.History.encode(raw).finish());

    for (const personal of [ada.email, ada.lastName]) {
      expect(stored.includes(personal)).toBe(false);
    }
    // Not vacuous: the input, an activity argument and the result carried the address
    expect(getIdentityByEmail).toHaveBeenCalledWith(ada.email, TENANT, expect.anything());
    expect(provisionUserToEntra.mock.calls[0][0]).toMatchObject({ email: ada.email });
    expect(result).toEqual(expect.stringContaining(ada.email));
    expect(historyText(raw).join('\n')).toContain(ada.email);
  });

  it('encrypts the input and the activity results under the current key id', () => {
    const events = raw.events ?? [];
    const input = events[0]?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];
    const results = events
      .map((e) => e.activityTaskCompletedEventAttributes?.result?.payloads?.[0])
      .filter((p): p is Payload => !!p);

    expect(input).toHaveLength(1);
    expect(results.length).toBeGreaterThan(0);
    for (const payload of [...input, ...results]) {
      expect(text(payload.metadata?.encoding)).toBe(ENCRYPTED_PAYLOAD_ENCODING);
      expect(text(payload.metadata?.[PAYLOAD_KEY_ID_METADATA])).toBe(TEST_PAYLOAD_KEY_ID);
    }
  });

  it('fails loudly, naming the key id, when the key under that id is another one', async () => {
    const otherKey = new TemporalPayloadCodec(() => ({
      currentKeyId: TEST_PAYLOAD_KEY_ID,
      keys: new Map([[TEST_PAYLOAD_KEY_ID, randomBytes(32)]]),
    }));
    const client = new Client({
      connection: harness.env.connection,
      namespace: harness.env.namespace,
      dataConverter: { payloadCodecs: [otherKey] },
    });

    const reading = client.workflow.getHandle(workflowId).result();

    await expect(reading).rejects.toThrow(TemporalPayloadDecryptionError);
    await expect(reading).rejects.toThrow(`key id "${TEST_PAYLOAD_KEY_ID}" did not decrypt`);
  });

  it('fails a run for an unknown person without the address in the failure or the history', async () => {
    const handle = await startUnknownPerson(harness, 'payload-codec-e2e-unknown-person');

    const error = await handle.result().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect(cause.type).toBe('UserNotFound');
    expect(cause.message).not.toContain(UNKNOWN);
    const stored = temporal.api.history.v1.History.encode(await handle.fetchHistory()).finish();
    expect(Buffer.from(stored).includes(UNKNOWN)).toBe(false);
  }, 60_000);

  it('replays a history recorded while the UserNotFound message named the address', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_CHANGE_HISTORY, 'utf8'));

    await expect(
      Worker.runReplayHistory(
        { workflowsPath: ONBOARDING_PATH, dataConverter: testDataConverter },
        history,
      ),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.NO_EMAIL_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-change fixture (NO_EMAIL_FIXTURE_WORKFLOW = the workflow as of 9236839c)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await startUnknownPerson(pre, 'onboarding-e2e-pre-no-email-in-failure');
        const error = await handle.result().catch((e: unknown) => e);
        // Recorded before the change: the message still names the address
        expect(((error as WorkflowFailedError).cause as ApplicationFailure).message).toContain(
          UNKNOWN,
        );
        fs.writeFileSync(PRE_CHANGE_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );

  it('replays the encrypted history with the codec, and not without it', async () => {
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: ONBOARDING_PATH, dataConverter: testDataConverter },
        raw,
        workflowId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      Worker.runReplayHistory({ workflowsPath: ONBOARDING_PATH }, raw, workflowId),
    ).rejects.toThrow();
  }, 60_000);

  describe('replay fixtures recorded before the codec', () => {
    let workflowBundle: { code: string };

    beforeAll(async () => {
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_INDEX });
      workflowBundle = { code };
    }, 120_000);

    it.each(FIXTURE_FILES)('%s replays with the codec', async (file) => {
      const history = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));

      await expect(
        Worker.runReplayHistory(
          { workflowBundle, dataConverter: testDataConverter },
          history,
          RECORDED_WORKFLOW_IDS[file],
        ),
      ).resolves.toBeUndefined();
    }, 60_000);
  });
});
