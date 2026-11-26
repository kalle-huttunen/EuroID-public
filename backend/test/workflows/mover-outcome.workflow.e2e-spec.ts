/**
 * The mover workflow on the time-skipping Temporal test server with mocked activities: what a
 * run changes, where, what it reports for the identity timeline, and what reaches its history.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * Proves, for runs started now (patches mover:timeline-outcome and mover:identity-by-id):
 *   - A completed run changes Entra ID, Okta and AD access through applyMoverAccess on each
 *     connector's own queue (removals first), reports per system what it added and removed, and
 *     reports as not supported, with the reason, a system no connector updates (GitHub) and a
 *     kind of entitlement a connector does not change (an Okta app). It passes the evaluated
 *     attribute values so the access baseline advances.
 *   - The history carries no email, name or contact data: the input names the identity by id,
 *     and neither the email lookup nor the profile-carrying activities are called.
 *   - A failing system is reported failed with the activity's own message, which also becomes
 *     the system's provisioning error; the systems after it are not attempted; the baseline does
 *     not advance and the workflow still fails.
 *   - A system the identity is not provisioned to (Okta, its onboarding never completed) is not
 *     attempted and gets no provisioning status: it is reported no-account with the reason, the
 *     systems after it are still changed and the run completes. After an earlier failure it is
 *     reported no-account too, not as stopped by the failure.
 *   - A paused pipeline, a policy result without changes and an identity that is gone are
 *     reported (skipped, no-change, failed).
 *   - With syncToEntra (patch mover:sync-to-entra) the run updates the Entra ID account also when
 *     it has no change for Entra ID, a run without any change included, and once when it has;
 *     without an Entra ID account it reports no-account there.
 *   - Histories recorded before mover:timeline-outcome, mover:identity-by-id and
 *     mover:sync-to-entra replay.
 *
 * Fixtures (from backend/):
 * - test/fixtures/mover-pre-timeline-outcome.history.json: recorded from the workflow as of
 *   5fdeac79 with MOVER_FIXTURE_WORKFLOW (see the recorder below).
 * - test/fixtures/mover-pre-identity-by-id.history.json: recorded from the workflow as of
 *   08fd38d4 with:
 *     git show 08fd38d4:backend/src/workflows/mover.workflow.ts > src/workflows/mover-pre-by-id.workflow.ts
 *     TEMPORAL_E2E=1 MOVER_BY_ID_FIXTURE_WORKFLOW=src/workflows/mover-pre-by-id.workflow.ts \
 *       npx jest -c test/jest-e2e.json mover-outcome -t 'records the pre-identity-by-id fixture'
 *     rm src/workflows/mover-pre-by-id.workflow.ts
 * - test/fixtures/mover-pre-sync-to-entra.history.json: a run without access change whose input
 *   carries syncToEntra (as the API starts it now), recorded from the workflow as of 88cc3c80
 *   (before mover:sync-to-entra; it ignores the flag) with:
 *     git show 88cc3c80:backend/src/workflows/mover.workflow.ts \
 *       | sed "s#'./mover-access'#'./mover-access-pre-sync'#" > src/workflows/mover-pre-sync.workflow.ts
 *     git show 88cc3c80:backend/src/workflows/mover-access.ts > src/workflows/mover-access-pre-sync.ts
 *     TEMPORAL_E2E=1 MOVER_SYNC_FIXTURE_WORKFLOW=src/workflows/mover-pre-sync.workflow.ts \
 *       npx jest -c test/jest-e2e.json mover-outcome -t 'records the pre-sync-to-entra fixture'
 *     rm src/workflows/mover-pre-sync.workflow.ts src/workflows/mover-access-pre-sync.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { QUEUE_NAMES } from '../../src/infrastructure/temporal/task-queue.config';
import { computeEntitlementDelta } from '../../src/shared/utils/entitlement-delta';
import { appliedAttributes } from '../../src/shared/utils/access-baseline';
import type { MoverEvaluation, MoverOutcome } from '../../src/shared/types/mover';
import type { MoverWorkflowInput } from '../../src/workflows/mover.workflow';
import { historyJSON } from '../helpers/history-json';
import { historyText } from '../helpers/history-text';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/mover.workflow.ts');
const PRE_TIMELINE = path.resolve(__dirname, '../fixtures/mover-pre-timeline-outcome.history.json');
const PRE_BY_ID = path.resolve(__dirname, '../fixtures/mover-pre-identity-by-id.history.json');
const PRE_SYNC = path.resolve(__dirname, '../fixtures/mover-pre-sync-to-entra.history.json');
const TENANT = 'tenant-a';
const EMAIL = 'ada@acme.test';

type Op = { type: string; action: string; target: string; targetId: string };
const grant = (target: string, targetId: string, type = 'group'): Op => ({
  type,
  action: 'add',
  target,
  targetId,
});

/**
 * The tenant's policies: Sales gets groups in Entra ID and Okta; Engineering other groups there,
 * a group in AD, an Okta app and a GitHub team.
 */
function policyOps(profile: { departmentName?: string }): Op[] {
  if (profile.departmentName === 'Sales') {
    return [grant('entra-id', 'g-sales'), grant('okta', 'okta-sales')];
  }
  if (profile.departmentName === 'Engineering') {
    return [
      grant('entra-id', 'g-eng'),
      grant('okta', 'okta-eng'),
      grant('ad', 'ad-eng'),
      grant('okta', 'app-eng', 'app'),
      grant('github', 'gh-eng'),
    ];
  }
  return [];
}

const PROFILE = {
  email: EMAIL,
  firstName: 'Ada',
  lastName: 'Lovelace',
  mobilePhone: '+358 40 123 4567',
  departmentName: 'Engineering',
  status: 'ACTIVE',
};

/** The systems the identity is provisioned to, as evaluateMoverChange reads them. */
const PROVISIONED = ['entra', 'okta', 'ad'];
let provisionedSystems = PROVISIONED;

const defaultActivities = {
  getPipelineStatus: jest.fn(async () => 'DEPLOYED'),
  /** What MoverActivities.evaluateMoverChange returns: ids and attribute values only. */
  evaluateMoverChange: jest.fn(
    async (
      identityId: string,
      changedFields: string[],
      previousAttributes: Record<string, unknown>,
    ): Promise<MoverEvaluation | null> => {
      if (identityId !== 'id-1') return null;
      const now = policyOps(PROFILE);
      const before = policyOps({ ...PROFILE, ...previousAttributes });
      const delta = computeEntitlementDelta(before, now);
      return {
        applied: appliedAttributes(PROFILE, changedFields),
        toAdd: delta.toAdd,
        toRemove: delta.toRemove,
        operationCounts: { before: before.length, after: now.length },
        provisionedSystems,
      };
    },
  ),
  getActiveTargetSystems: jest.fn(async () => ['entra', 'okta', 'ad', 'github']),
  setProvisioningStatus: jest.fn(async () => undefined),
  recordMoverOutcome: jest.fn(async () => undefined),
  // The path of histories from before mover:identity-by-id (and the fixture recorders)
  getIdentityByEmail: jest.fn(async () => ({ _id: 'id-1', profile: PROFILE, provisioning: [] })),
  evaluateUser: jest.fn(async (profile: { departmentName?: string }) => ({
    operations: policyOps(profile),
  })),
  computeEntitlementDelta: jest.fn(async (oldOps: Op[], newOps: Op[]) =>
    computeEntitlementDelta(oldOps, newOps),
  ),
  getConnectorConfig: jest.fn(async () => ({})),
};
const access = () => ({
  applyMoverAccess: jest.fn(async (..._args: unknown[]) => ({ changed: 2, unchanged: 0 })),
});
const entraActivities = {
  ...access(),
  provisionUserToEntra: jest.fn(async () => ({ success: true })),
};
const adActivities = { ...access(), provisionUserToAd: jest.fn(async () => ({ success: true })) };
const oktaActivities = access();
const scimActivities = access();

const input = (over: Partial<MoverWorkflowInput> = {}): MoverWorkflowInput => ({
  identityId: 'id-1',
  tenantId: TENANT,
  changedFields: ['departmentName'],
  previousAttributes: { departmentName: 'Sales' },
  trigger: 're-evaluate',
  ...over,
});

const asActivities = (a: object) => a as unknown as Record<string, (...args: unknown[]) => unknown>;
const queueWorkers = () => [
  { taskQueue: QUEUE_NAMES['entra'], activities: asActivities(entraActivities) },
  { taskQueue: QUEUE_NAMES['ad'], activities: asActivities(adActivities) },
  { taskQueue: QUEUE_NAMES['okta'], activities: asActivities(oktaActivities) },
  { taskQueue: QUEUE_NAMES['scim'], activities: asActivities(scimActivities) },
];

const OKTA_ONLY_GROUPS = 'The mover changes group memberships in Okta, nothing else.';
const OTHER_SYSTEM = 'The mover updates Entra ID, Active Directory, Okta and SCIM only.';
const NO_ACCOUNT =
  'The identity is not provisioned to this system (onboarding has not completed there), so ' +
  'the mover has no account to change.';
const ENTRA_SYNCED =
  'The edit asked for a sync to Entra ID: the account was updated with the current ' +
  'attributes; its access needed no change.';

describeTemporalE2E('mover workflow outcome (timeline)', () => {
  let harness: WorkflowTestHarness;
  let runs = 0;

  async function start(args: MoverWorkflowInput, h: WorkflowTestHarness = harness) {
    return h.env.client.workflow.start('moverWorkflow', {
      taskQueue: h.taskQueue,
      workflowId: `t-${TENANT}-mover-test-${++runs}`,
      args: [args],
    });
  }

  /** The (outcome, applied, tenantId) recordMoverOutcome got. */
  function recorded(): [MoverOutcome, Record<string, unknown> | undefined, string] {
    expect(defaultActivities.recordMoverOutcome).toHaveBeenCalledTimes(1);
    return defaultActivities.recordMoverOutcome.mock.calls[0] as unknown as [
      MoverOutcome,
      Record<string, unknown> | undefined,
      string,
    ];
  }

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      activities: asActivities(defaultActivities),
      queueWorkers: queueWorkers(),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  });

  beforeEach(() => {
    for (const fn of [
      ...Object.values(defaultActivities),
      ...Object.values(entraActivities),
      ...Object.values(adActivities),
      ...Object.values(oktaActivities),
      ...Object.values(scimActivities),
    ]) {
      fn.mockClear();
    }
    defaultActivities.getPipelineStatus.mockImplementation(async () => 'DEPLOYED');
    entraActivities.applyMoverAccess.mockImplementation(async () => ({ changed: 2, unchanged: 0 }));
    oktaActivities.applyMoverAccess.mockImplementation(async () => ({ changed: 2, unchanged: 0 }));
    provisionedSystems = PROVISIONED;
  });

  it('changes each system on its own queue and reports what it did and did not', async () => {
    const handle = await start(input());
    await expect(handle.result()).resolves.toBe('Mover complete for id-1: +5 add, -2 remove.');

    const task = (connector: string, operations: object[]) => [
      { identityId: 'id-1', connector, operations },
      TENANT,
      handle.workflowId,
    ];
    expect(entraActivities.applyMoverAccess.mock.calls).toEqual([
      task('entra', [
        { type: 'group', action: 'remove', targetId: 'g-sales' },
        { type: 'group', action: 'add', targetId: 'g-eng' },
      ]),
    ]);
    expect(oktaActivities.applyMoverAccess.mock.calls).toEqual([
      task('okta', [
        { type: 'group', action: 'remove', targetId: 'okta-sales' },
        { type: 'group', action: 'add', targetId: 'okta-eng' },
      ]),
    ]);
    expect(adActivities.applyMoverAccess.mock.calls).toEqual([
      task('ad', [{ type: 'group', action: 'add', targetId: 'ad-eng' }]),
    ]);
    expect(scimActivities.applyMoverAccess).not.toHaveBeenCalled();

    const [outcome, applied, tenantId] = recorded();
    expect(outcome).toEqual({
      identityId: 'id-1',
      workflowId: handle.workflowId,
      trigger: 're-evaluate',
      status: 'completed',
      changedFields: ['departmentName'],
      added: 5,
      removed: 2,
      systems: [
        { system: 'entra', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] },
        { system: 'okta', outcome: 'updated', added: ['okta-eng'], removed: ['okta-sales'] },
        {
          system: 'okta',
          outcome: 'not-supported',
          added: ['app-eng'],
          removed: [],
          reason: OKTA_ONLY_GROUPS,
        },
        { system: 'ad', outcome: 'updated', added: ['ad-eng'], removed: [] },
        {
          system: 'github',
          outcome: 'not-supported',
          added: ['gh-eng'],
          removed: [],
          reason: OTHER_SYSTEM,
        },
      ],
      durationMs: expect.any(Number),
    });
    expect(applied).toEqual({ departmentName: 'Engineering' });
    expect(tenantId).toBe(TENANT);
    for (const system of ['entra', 'okta', 'ad']) {
      expect(defaultActivities.setProvisioningStatus).toHaveBeenCalledWith(
        'id-1',
        system,
        'SYNCED',
        undefined,
        TENANT,
        undefined,
        undefined,
        handle.workflowId,
      );
    }
  }, 60_000);

  it('keeps the email, names and contact data out of the history', async () => {
    const handle = await start(input());
    await handle.result();

    const text = historyText(await handle.fetchHistory()).join('\n');
    for (const personal of [EMAIL, 'Ada', 'Lovelace', PROFILE.mobilePhone]) {
      expect(text).not.toContain(personal);
    }
    expect(text).toContain('id-1');
    for (const profileCarrying of [
      defaultActivities.getIdentityByEmail,
      defaultActivities.evaluateUser,
      entraActivities.provisionUserToEntra,
      adActivities.provisionUserToAd,
    ]) {
      expect(profileCarrying).not.toHaveBeenCalled();
    }
  }, 60_000);

  it('reports a failing system with its reason and the rest as not attempted', async () => {
    const reason = 'okta: Okta refused the change (HTTP 403)';
    oktaActivities.applyMoverAccess.mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable(reason, 'DeprovisionRejected');
    });

    const handle = await start(input());
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);

    const [outcome, applied] = recorded();
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe(reason);
    expect(outcome.systems).toEqual([
      { system: 'entra', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] },
      { system: 'okta', outcome: 'failed', added: ['okta-eng'], removed: ['okta-sales'], reason },
      {
        system: 'okta',
        outcome: 'not-supported',
        added: ['app-eng'],
        removed: [],
        reason: OKTA_ONLY_GROUPS,
      },
      { system: 'ad', outcome: 'not-attempted', added: ['ad-eng'], removed: [] },
      {
        system: 'github',
        outcome: 'not-supported',
        added: ['gh-eng'],
        removed: [],
        reason: OTHER_SYSTEM,
      },
    ]);
    expect(applied).toBeUndefined();
    expect(adActivities.applyMoverAccess).not.toHaveBeenCalled();
    // The provisioning entry gets the connector's own (masked) message, not the wrapper's
    expect(defaultActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'id-1',
      'okta',
      'ERROR',
      reason,
      TENANT,
      undefined,
      undefined,
      handle.workflowId,
    );
  }, 60_000);

  it('skips a system the identity is not provisioned to and goes on with the next', async () => {
    provisionedSystems = ['entra', 'ad'];

    const handle = await start(input());
    await expect(handle.result()).resolves.toBe('Mover complete for id-1: +5 add, -2 remove.');

    expect(oktaActivities.applyMoverAccess).not.toHaveBeenCalled();
    expect(adActivities.applyMoverAccess).toHaveBeenCalledTimes(1);
    const [outcome, applied] = recorded();
    expect(outcome.status).toBe('completed');
    expect(outcome.systems).toEqual([
      { system: 'entra', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] },
      {
        system: 'okta',
        outcome: 'no-account',
        added: ['okta-eng'],
        removed: ['okta-sales'],
        reason: NO_ACCOUNT,
      },
      {
        system: 'okta',
        outcome: 'not-supported',
        added: ['app-eng'],
        removed: [],
        reason: OKTA_ONLY_GROUPS,
      },
      { system: 'ad', outcome: 'updated', added: ['ad-eng'], removed: [] },
      {
        system: 'github',
        outcome: 'not-supported',
        added: ['gh-eng'],
        removed: [],
        reason: OTHER_SYSTEM,
      },
    ]);
    expect(applied).toEqual({ departmentName: 'Engineering' });
    // No provisioning status for Okta: none is written, and no entry is created there
    const statusSystems = defaultActivities.setProvisioningStatus.mock.calls.map(
      (call) => (call as unknown[])[1],
    );
    expect(statusSystems).not.toContain('okta');
    expect(statusSystems).toEqual(expect.arrayContaining(['entra', 'ad']));
  }, 60_000);

  it('reports a system without an account as such after an earlier failure', async () => {
    provisionedSystems = ['entra', 'ad'];
    const reason = 'entra: Graph refused the change (HTTP 403)';
    entraActivities.applyMoverAccess.mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable(reason, 'DeprovisionRejected');
    });

    const handle = await start(input());
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);

    const [outcome, applied] = recorded();
    expect(outcome.status).toBe('failed');
    expect(outcome.systems).toEqual([
      { system: 'entra', outcome: 'failed', added: ['g-eng'], removed: ['g-sales'], reason },
      {
        system: 'okta',
        outcome: 'no-account',
        added: ['okta-eng'],
        removed: ['okta-sales'],
        reason: NO_ACCOUNT,
      },
      {
        system: 'okta',
        outcome: 'not-supported',
        added: ['app-eng'],
        removed: [],
        reason: OKTA_ONLY_GROUPS,
      },
      { system: 'ad', outcome: 'not-attempted', added: ['ad-eng'], removed: [] },
      {
        system: 'github',
        outcome: 'not-supported',
        added: ['gh-eng'],
        removed: [],
        reason: OTHER_SYSTEM,
      },
    ]);
    expect(applied).toBeUndefined();
    expect(oktaActivities.applyMoverAccess).not.toHaveBeenCalled();
    expect(adActivities.applyMoverAccess).not.toHaveBeenCalled();
  }, 60_000);

  it('reports a paused pipeline as skipped without touching the identity', async () => {
    defaultActivities.getPipelineStatus.mockImplementation(async () => 'PAUSED');

    const handle = await start(input({ trigger: undefined }));
    await expect(handle.result()).resolves.toBe('Mover skipped: pipeline PAUSED');

    const [outcome, applied] = recorded();
    expect(outcome).toMatchObject({
      trigger: 'attribute-change',
      status: 'skipped',
      reason: 'The provisioning pipeline is paused.',
      systems: [],
    });
    expect(applied).toBeUndefined();
    expect(defaultActivities.evaluateMoverChange).not.toHaveBeenCalled();
  }, 60_000);

  it('reports no change and still advances the baseline', async () => {
    const handle = await start(input({ previousAttributes: { departmentName: 'Engineering' } }));
    await expect(handle.result()).resolves.toBe('Mover complete for id-1: no entitlement changes.');

    const [outcome, applied] = recorded();
    expect(outcome).toMatchObject({ status: 'no-change', added: 0, removed: 0, systems: [] });
    expect(applied).toEqual({ departmentName: 'Engineering' });
    expect(defaultActivities.setProvisioningStatus).not.toHaveBeenCalled();
  }, 60_000);

  // Plan 2.0dq: a run without access change in Entra ID pushed no attributes there, so the
  // sync PATCH /identity/:id?syncToEntra=true asked for did not happen
  describe('an edit that asked for a sync to Entra ID (syncToEntra)', () => {
    const synced = (over: Partial<MoverWorkflowInput> = {}) =>
      input({ trigger: 'attribute-change', syncToEntra: true, ...over });

    it('updates the Entra ID account in a run that changes no access', async () => {
      const handle = await start(synced({ previousAttributes: { departmentName: 'Engineering' } }));
      await expect(handle.result()).resolves.toBe(
        'Mover complete for id-1: no entitlement changes.',
      );

      expect(entraActivities.applyMoverAccess.mock.calls).toEqual([
        [{ identityId: 'id-1', connector: 'entra', operations: [] }, TENANT, handle.workflowId],
      ]);
      for (const other of [oktaActivities, adActivities, scimActivities]) {
        expect(other.applyMoverAccess).not.toHaveBeenCalled();
      }
      const [outcome, applied] = recorded();
      expect(outcome).toMatchObject({
        status: 'no-change',
        added: 0,
        removed: 0,
        systems: [
          { system: 'entra', outcome: 'updated', added: [], removed: [], reason: ENTRA_SYNCED },
        ],
      });
      expect(applied).toEqual({ departmentName: 'Engineering' });
      expect(
        defaultActivities.setProvisioningStatus.mock.calls.map((c) => (c as unknown[])[2]),
      ).toEqual(['SYNCING', 'SYNCED']);
    }, 60_000);

    it('updates Entra ID once in a run that changes its access', async () => {
      const handle = await start(synced());
      await expect(handle.result()).resolves.toBe('Mover complete for id-1: +5 add, -2 remove.');

      expect(entraActivities.applyMoverAccess).toHaveBeenCalledTimes(1);
      expect(entraActivities.applyMoverAccess.mock.calls[0][0]).toEqual({
        identityId: 'id-1',
        connector: 'entra',
        operations: [
          { type: 'group', action: 'remove', targetId: 'g-sales' },
          { type: 'group', action: 'add', targetId: 'g-eng' },
        ],
      });
      const [outcome] = recorded();
      expect(outcome.systems[0]).toEqual({
        system: 'entra',
        outcome: 'updated',
        added: ['g-eng'],
        removed: ['g-sales'],
      });
    }, 60_000);

    it('reports the sync as no account where the identity has no Entra ID account', async () => {
      provisionedSystems = ['okta', 'ad'];

      const handle = await start(synced({ previousAttributes: { departmentName: 'Engineering' } }));
      await handle.result();

      expect(entraActivities.applyMoverAccess).not.toHaveBeenCalled();
      const [outcome] = recorded();
      expect(outcome).toMatchObject({
        status: 'no-change',
        systems: [
          { system: 'entra', outcome: 'no-account', added: [], removed: [], reason: NO_ACCOUNT },
        ],
      });
    }, 60_000);

    it('replays a history recorded before mover:sync-to-entra with syncToEntra in its input', async () => {
      // A run the API started with the flag on a worker from before the patch
      const history = JSON.parse(fs.readFileSync(PRE_SYNC, 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
      ).resolves.toBeUndefined();
    }, 60_000);
  });

  it('fails the run for an identity that is gone', async () => {
    const handle = await start(input({ identityId: 'id-x' }));
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);

    const [outcome] = recorded();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'Identity id-x not found in Hub' });
    expect(defaultActivities.getActiveTargetSystems).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the timeline outcome patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_TIMELINE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('replays a history recorded before the identity-by-id patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_BY_ID, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /** Run `workflowFile` (an older mover workflow) once and write its history to `fixture`. */
  async function recordFixture(workflowFile: string, fixture: string, args: MoverWorkflowInput) {
    const pre = await createWorkflowTestHarness({
      workflowsPath: path.resolve(process.cwd(), workflowFile),
      activities: asActivities(defaultActivities),
      queueWorkers: queueWorkers(),
    });
    try {
      const handle = await start(args, pre);
      await handle.result();
      fs.writeFileSync(fixture, historyJSON(await handle.fetchHistory()));
    } finally {
      await pre.shutdown();
    }
  }

  const preTimelineWorkflow = process.env.MOVER_FIXTURE_WORKFLOW;
  (preTimelineWorkflow ? it : it.skip)(
    'records the pre-patch fixture (MOVER_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const { trigger: _absentBeforeThePatch, ...preInput } = input({ email: EMAIL });
      await recordFixture(preTimelineWorkflow ?? '', PRE_TIMELINE, preInput as MoverWorkflowInput);
    },
    120_000,
  );

  const preSyncWorkflow = process.env.MOVER_SYNC_FIXTURE_WORKFLOW;
  (preSyncWorkflow ? it : it.skip)(
    'records the pre-sync-to-entra fixture (MOVER_SYNC_FIXTURE_WORKFLOW = the 88cc3c80 workflow)',
    async () => {
      // No access change, so the run before the patch ends after its evaluation
      await recordFixture(
        preSyncWorkflow ?? '',
        PRE_SYNC,
        input({
          trigger: 'attribute-change',
          syncToEntra: true,
          previousAttributes: { departmentName: 'Engineering' },
        }),
      );
    },
    120_000,
  );

  const preByIdWorkflow = process.env.MOVER_BY_ID_FIXTURE_WORKFLOW;
  (preByIdWorkflow ? it : it.skip)(
    'records the pre-identity-by-id fixture (MOVER_BY_ID_FIXTURE_WORKFLOW = the 08fd38d4 workflow)',
    async () => {
      // As MoverService started runs before the patch: with the email
      await recordFixture(preByIdWorkflow ?? '', PRE_BY_ID, input({ email: EMAIL }));
    },
    120_000,
  );
});
