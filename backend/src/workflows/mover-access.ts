/**
 * The mover run behind patch mover:identity-by-id (moverWorkflow). Only ids, attribute values the
 * policies read and entitlement ids pass through history:
 * 1. Pipeline guard: only a DEPLOYED pipeline changes access (patch mover:pipeline-guard-deployed).
 * 2. evaluateMoverChange reads the identity by id and returns the entitlement delta of the move
 *    (the policies with the previous and the current attribute values), the values applied and
 *    the target systems the identity is provisioned to.
 * 3. Per active target system, removals then additions through applyMoverAccess on the
 *    connector's own queue (Entra ID, AD, Okta, SCIM; MOVER_OPERATION_TYPES says which kinds of
 *    entitlement each one changes). What no connector applies is reported not-supported with
 *    the reason. A system the identity is not provisioned to is not attempted and reported
 *    no-account; the run goes on. The first failing system stops the run; its provisioning
 *    entry gets the activity's own (masked) message.
 * Patch mover:sync-to-entra: a run started with syncToEntra (PATCH /identity/:id?syncToEntra=true)
 * also updates the Entra ID account where it has no change for Entra ID (applyMoverAccess with
 * no operations: the account's attributes from the current profile), a run without any access
 * change included, so the sync the edit asked for happens without a second (onboarding) run.
 *
 * Workflow code: bundled into moverWorkflow, so it must stay deterministic.
 */
import {
  proxyActivities,
  log,
  workflowInfo,
  ApplicationFailure,
  ActivityFailure,
} from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import type { PipelineActivities } from '../activities/pipeline.activities';
import type { MoverActivities } from '../activities/mover.activities';
import type { MoverAccessActivities } from '../activities/mover-access.activities';
import type { MoverConnector, MoverSystemResult } from '../shared/types/mover';
import { moverSystemPlan, type MoverSystemPlan } from '../shared/utils/entitlement-delta';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { legacyPipelineBlockReason, pipelineBlockReason } from './pipeline-guard';
import type { MoverWorkflowInput, RunState } from './mover.workflow';

/** With syncToEntra, Entra ID is updated also where the run has no change for it. */
const SYNC_TO_ENTRA_PATCH = 'mover:sync-to-entra';

/**
 * Only a DEPLOYED pipeline changes access (pipeline-guard.ts). Histories from before this patch
 * skipped the run only while the pipeline was PAUSED or STOPPED, so a DRAFT or SIMULATED one
 * changed access in the target systems.
 */
const PIPELINE_GUARD_PATCH = 'mover:pipeline-guard-deployed';

const { getActiveTargetSystems } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { getPipelineStatus } = proxyActivities<PipelineActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { setProvisioningStatus } = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '10 seconds',
});
const { evaluateMoverChange } = proxyActivities<MoverActivities>({
  startToCloseTimeout: '30 seconds',
  retry: QUERY_RETRY,
});

type Applier = Pick<MoverAccessActivities, 'applyMoverAccess'>;
const connectorOptions = { startToCloseTimeout: '1m', retry: CONNECTOR_RETRY } as const;
const appliers: Record<MoverConnector, Applier> = {
  entra: proxyActivities<Applier>({ taskQueue: QUEUE_NAMES['entra'], ...connectorOptions }),
  ad: proxyActivities<Applier>({ taskQueue: QUEUE_NAMES['ad'], ...connectorOptions }),
  okta: proxyActivities<Applier>({ taskQueue: QUEUE_NAMES['okta'], ...connectorOptions }),
  scim: proxyActivities<Applier>({ taskQueue: QUEUE_NAMES['scim'], ...connectorOptions }),
};

const NOT_UPDATED: Record<MoverConnector | 'other', string> = {
  entra: 'The mover changes groups, directory roles and licenses in Entra ID, nothing else.',
  ad: 'The mover changes group memberships in Active Directory, nothing else.',
  okta: 'The mover changes group memberships in Okta, nothing else.',
  scim: 'The mover changes group memberships in SCIM targets, nothing else.',
  other: 'The mover updates Entra ID, Active Directory, Okta and SCIM only.',
};

/** Why a system the identity is not provisioned to gets no access change. */
const NO_ACCOUNT =
  'The identity is not provisioned to this system (onboarding has not completed there), so ' +
  'the mover has no account to change.';

/** An Entra ID account updated for the edit's sync, with no access change there. */
const ENTRA_SYNCED =
  'The edit asked for a sync to Entra ID: the account was updated with the current ' +
  'attributes; its access needed no change.';

/** The activity's own message (ActivityFailure only says which activity failed). */
export function reasonOf(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** The system's changes the mover does not apply, if it has any. */
function notSupported(system: string, plan: MoverSystemPlan): MoverSystemResult | null {
  const { added, removed } = plan.notApplied;
  if (added.length === 0 && removed.length === 0) return null;
  const reason = NOT_UPDATED[plan.connector ?? 'other'];
  return { system, outcome: 'not-supported', added, removed, reason };
}

/** A system with changes the identity has no account in: not attempted, the run goes on. */
function noAccount(system: string, plan: MoverSystemPlan): MoverSystemResult {
  return { system, outcome: 'no-account', ...plan.applied, reason: NO_ACCOUNT };
}

export async function runMoverById(
  input: MoverWorkflowInput,
  state: RunState,
  step: (name: string) => void,
): Promise<void> {
  const { identityId, tenantId, changedFields, previousAttributes } = input;
  const correlationId = workflowInfo().workflowId;
  log.info(
    `Mover workflow started for identity ${identityId}, changed: ${changedFields.join(', ')}`,
  );

  // 1. Pipeline guard
  step('PIPELINE_GUARD');
  const pipelineStatus = await getPipelineStatus(tenantId, correlationId);
  const blocked = isPatched(PIPELINE_GUARD_PATCH)
    ? pipelineBlockReason(pipelineStatus)
    : legacyPipelineBlockReason(pipelineStatus);
  if (blocked) {
    log.info(`Pipeline status is ${pipelineStatus}: skipping mover for identity ${identityId}`);
    state.status = 'skipped';
    state.reason = `${blocked.charAt(0).toUpperCase()}${blocked.slice(1)}.`;
    state.summary = `Mover skipped: pipeline ${pipelineStatus}`;
    return;
  }

  // 2. The policies before and after the move (the activity reads the identity by id)
  step('POLICY_EVAL');
  const evaluation = await evaluateMoverChange(
    identityId,
    changedFields,
    previousAttributes,
    tenantId,
    correlationId,
  );
  if (!evaluation) {
    throw ApplicationFailure.nonRetryable(
      `Identity ${identityId} not found in Hub`,
      'IdentityNotFound',
    );
  }
  const delta = { toAdd: evaluation.toAdd, toRemove: evaluation.toRemove };
  state.applied = evaluation.applied;
  state.added = delta.toAdd.length;
  state.removed = delta.toRemove.length;
  log.info(
    `Policy: ${evaluation.operationCounts.before} operations before, ` +
      `${evaluation.operationCounts.after} after; ` +
      `delta +${delta.toAdd.length} add, -${delta.toRemove.length} remove`,
  );

  const unchanged = delta.toAdd.length === 0 && delta.toRemove.length === 0;
  // The sync PATCH /identity/:id?syncToEntra=true asked for: Entra ID is updated in this run
  const syncEntra = input.syncToEntra === true && isPatched(SYNC_TO_ENTRA_PATCH);
  if (unchanged) {
    state.status = 'no-change';
    state.summary = `Mover complete for ${identityId}: no entitlement changes.`;
    if (!syncEntra) {
      log.info(`No entitlement changes for identity ${identityId}, mover complete (no-op)`);
      step('COMPLETED');
      return;
    }
  }
  /** The system has something for its connector to do: changes, or the Entra ID sync. */
  const hasWork = (plan: MoverSystemPlan) =>
    !!plan.connector && (plan.operations.length > 0 || (syncEntra && plan.connector === 'entra'));

  // 3. Discover target systems
  step('DISCOVER_TARGETS');
  const plans = (await getActiveTargetSystems(tenantId, correlationId))
    .filter(Boolean)
    .map((system) => ({ system, plan: moverSystemPlan(delta, system) }));
  const provisioned = new Set(evaluation.provisionedSystems);

  // 4. Apply per target system on the connector's queue (removals first, then additions)
  step('EXECUTE_DELTA');
  for (const [index, { system, plan }] of plans.entries()) {
    const notApplied = notSupported(system, plan);
    if (!plan.connector || !hasWork(plan)) {
      if (notApplied) state.systems.push(notApplied);
      continue;
    }
    if (!provisioned.has(system)) {
      log.info(`System ${system}: identity ${identityId} is not provisioned there, not attempted`);
      state.systems.push(noAccount(system, plan));
      if (notApplied) state.systems.push(notApplied);
      continue;
    }
    log.info(`System ${system}: ${plan.operations.length} changes through ${plan.connector}`);

    await setProvisioningStatus(
      identityId,
      system,
      'SYNCING',
      undefined,
      tenantId,
      undefined,
      undefined,
      correlationId,
    );
    try {
      await appliers[plan.connector].applyMoverAccess(
        { identityId, connector: plan.connector, operations: plan.operations },
        tenantId,
        correlationId,
      );
      await setProvisioningStatus(
        identityId,
        system,
        'SYNCED',
        undefined,
        tenantId,
        undefined,
        undefined,
        correlationId,
      );
      state.systems.push({
        system,
        outcome: 'updated',
        ...plan.applied,
        ...(plan.operations.length === 0 ? { reason: ENTRA_SYNCED } : {}),
      });
      if (notApplied) state.systems.push(notApplied);
    } catch (err: unknown) {
      const reason = reasonOf(err);
      log.error(`Mover access change in ${system} failed: ${reason}`);
      state.systems.push({ system, outcome: 'failed', ...plan.applied, reason });
      if (notApplied) state.systems.push(notApplied);
      for (const rest of plans.slice(index + 1)) {
        if (hasWork(rest.plan)) {
          state.systems.push(
            provisioned.has(rest.system)
              ? { system: rest.system, outcome: 'not-attempted', ...rest.plan.applied }
              : noAccount(rest.system, rest.plan),
          );
        }
        const restNotApplied = notSupported(rest.system, rest.plan);
        if (restNotApplied) state.systems.push(restNotApplied);
      }
      await setProvisioningStatus(
        identityId,
        system,
        'ERROR',
        reason,
        tenantId,
        undefined,
        undefined,
        correlationId,
      );
      throw err;
    }
  }

  // 5. Completed
  step('COMPLETED');
  if (!unchanged) {
    state.summary = `Mover complete for ${identityId}: +${delta.toAdd.length} add, -${delta.toRemove.length} remove.`;
  }
  log.info(state.summary);
}
