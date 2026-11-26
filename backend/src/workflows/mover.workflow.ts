/**
 * Mover Workflow — Handles role/department changes for already-provisioned identities.
 *
 * Started by MoverService: when PATCH /identity/:id changes one of the trigger attributes
 * (departmentName, jobTitle, location, managerEmail; MoverEventHandler), when an operator
 * re-evaluates access (POST /identity/:id/access/re-evaluate, previousAttributes = the access
 * baseline's values of every attribute that changed since access was last applied), or when an
 * HR sync leaves a trigger attribute different from the access baseline (trigger hr-sync,
 * previousAttributes = the baseline's values of those trigger attributes; HrMoverDetectionService).
 * 1. Evaluates policy with NEW attributes → new intent
 * 2. Evaluates policy with OLD attributes → old intent
 * 3. Computes delta: { toAdd, toRemove }
 * 4. Executes removals then additions per target system. The first failing system stops the run.
 * 5. (patch mover:timeline-outcome) Records the result: per system what changed or why it
 *    failed, published for the identity timeline (recordMoverOutcome); a completed run advances
 *    the identity's access baseline. Histories from before the patch replay without it.
 *
 * Patch mover:identity-by-id (runMoverById, mover-access.ts): the input carries no email, one
 * activity reads the identity by id and returns the delta (steps 1-3), and each target's change
 * runs on its connector's queue through applyMoverAccess: Entra ID, AD, Okta and SCIM. No profile
 * or email enters history. Histories from before the patch replay the path below (runMover):
 * the identity looked up by email, its profile passed to evaluateUser and to Entra ID and AD,
 * other systems with changes reported as not supported.
 *
 * Unlike onboarding (which only adds), mover handles both add AND remove operations.
 *
 * Bulkhead: Connector-specific activities are routed to per-connector task queues.
 */

import {
  proxyActivities,
  defineQuery,
  setHandler,
  log,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import type { PolicyActivities } from '../activities/policy.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { PipelineActivities } from '../activities/pipeline.activities';
import type { MoverActivities } from '../activities/mover.activities';
import type { StandardUserDto } from '../shared/dtos/standard-user.dto';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type { MoverOutcome, MoverSystemResult, MoverTrigger } from '../shared/types/mover';
import { getSystemType } from '../shared/utils/normalize-system-name';
import { operationsForSystem } from '../shared/utils/entitlement-delta';
import { appliedAttributes } from '../shared/utils/access-baseline';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { workflowNow } from './workflow-time';
import { reasonOf, runMoverById } from './mover-access';
import {
  continueWithQueuedEdit,
  mergeReevaluations,
  reevaluateMoverSignal,
  registerQueuedEditQuery,
  type MoverReevaluation,
} from './mover-reevaluation';

/** Record the run's result for the identity timeline and advance the access baseline. */
const OUTCOME_PATCH = 'mover:timeline-outcome';
/** Identity by id, no profile in history, every connector with group membership (runMoverById). */
const IDENTITY_BY_ID_PATCH = 'mover:identity-by-id';

// Default queue — config, identity, policy, mover (generic activities)
const { getActiveTargetSystems, getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { getPipelineStatus } = proxyActivities<PipelineActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { getIdentityByEmail, setProvisioningStatus } = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '10 seconds',
});
const { evaluateUser } = proxyActivities<PolicyActivities>({ startToCloseTimeout: '30 seconds' });
const { computeEntitlementDelta } = proxyActivities<MoverActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { recordMoverOutcome } = proxyActivities<MoverActivities>({
  startToCloseTimeout: '10s',
});

// Connector-specific queues — bulkhead isolation
const entraProxy = proxyActivities<EntraActivities>({
  taskQueue: QUEUE_NAMES['entra'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});
const adProxy = proxyActivities<AdActivities>({
  taskQueue: QUEUE_NAMES['ad'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

/** Get connector proxy for provisioning (routes to correct queue); runs before IDENTITY_BY_ID_PATCH */
function getProvisionProxy(system: string) {
  if (getSystemType(system) === 'entra') return entraProxy;
  if (getSystemType(system) === 'ad') return adProxy;
  return null; // Other connectors: runMoverById
}

// Define the Query — allows frontend to ask "Where are you in the journey?"
export const getMoverStepQuery = defineQuery<string>('getCurrentStep');

export interface MoverWorkflowInput {
  identityId: string;
  /**
   * Only in runs started before patch mover:identity-by-id, which look the identity up by email.
   * MoverService no longer passes it.
   */
  email?: string;
  tenantId: string;
  changedFields: string[];
  /**
   * The changed attributes' values before the change: what the policies are evaluated with for
   * the "before" side. MoverService keeps only attributes the access baseline keeps (no names,
   * contact data or identifiers).
   */
  previousAttributes: Record<string, unknown>;
  /** What started the run. Absent in runs started before re-evaluation existed. */
  trigger?: MoverTrigger;
  /**
   * PATCH /identity/:id?syncToEntra=true: the edit asked for its attributes to reach Entra ID.
   * With patch mover:sync-to-entra the run updates the Entra ID account also when it changes
   * no access there (runMoverById).
   */
  syncToEntra?: boolean;
}

/** What the run found and did so far: the timeline's outcome is built from it. */
export interface RunState {
  status: Exclude<MoverOutcome['status'], 'failed'>;
  reason?: string;
  added: number;
  removed: number;
  systems: MoverSystemResult[];
  /** The attribute values evaluated (set once the profile is read). */
  applied?: Record<string, unknown>;
  summary: string;
}

export async function moverWorkflow(input: MoverWorkflowInput): Promise<string> {
  const reportOutcome = isPatched(OUTCOME_PATCH);
  const byId = isPatched(IDENTITY_BY_ID_PATCH);
  const state: RunState = { status: 'completed', added: 0, removed: 0, systems: [], summary: '' };
  // An edit that met this run (mover-reevaluation.ts): evaluated once more when the run ends
  let queued: MoverReevaluation | undefined;
  setHandler(reevaluateMoverSignal, (edit) => {
    queued = mergeReevaluations(queued, edit);
  });
  registerQueuedEditQuery();
  const outcomeOf = (status: MoverOutcome['status'], reason?: string): MoverOutcome => ({
    identityId: input.identityId,
    workflowId: workflowInfo().workflowId,
    trigger: input.trigger ?? 'attribute-change',
    status,
    changedFields: input.changedFields,
    added: state.added,
    removed: state.removed,
    systems: state.systems,
    ...(reason !== undefined ? { reason } : {}),
    durationMs: workflowNow().getTime() - workflowInfo().startTime.getTime(),
  });

  try {
    if (byId) {
      let currentStep = 'INITIALIZING';
      setHandler(getMoverStepQuery, () => currentStep);
      await runMoverById(input, state, (name) => {
        currentStep = name;
      });
    } else {
      await runMover(input, state, reportOutcome);
    }
  } catch (err: unknown) {
    if (reportOutcome) {
      await recordMoverOutcome(outcomeOf('failed', reasonOf(err)), undefined, input.tenantId);
    }
    await continueWithQueuedEdit(input, state, queued, false);
    throw err;
  }
  const completedRun = state.status === 'completed' || state.status === 'no-change';
  if (reportOutcome) {
    await recordMoverOutcome(
      outcomeOf(state.status, state.reason),
      completedRun ? state.applied : undefined,
      input.tenantId,
    );
  }
  await continueWithQueuedEdit(input, state, queued, completedRun);
  return state.summary;
}

/**
 * The run of histories from before IDENTITY_BY_ID_PATCH. Its activity calls are those of the
 * workflow before OUTCOME_PATCH, in the same order, so old histories replay; with that patch it
 * also fills `state` for the outcome. Logs and new results name the identity by id; the email
 * stays only in pre-patch results.
 */
async function runMover(
  input: MoverWorkflowInput,
  state: RunState,
  reportOutcome: boolean,
): Promise<void> {
  const { identityId, email, tenantId, changedFields, previousAttributes } = input;
  const correlationId = workflowInfo().workflowId;
  const who = reportOutcome ? identityId : email;

  let currentStep = 'INITIALIZING';
  setHandler(getMoverStepQuery, () => currentStep);

  log.info(
    `Mover workflow started for identity ${identityId}, changed: ${changedFields.join(', ')}`,
  );

  // 1. Pipeline guard
  currentStep = 'PIPELINE_GUARD';
  const pipelineStatus = await getPipelineStatus(tenantId, correlationId);
  if (pipelineStatus === 'PAUSED' || pipelineStatus === 'STOPPED') {
    log.info(`Pipeline status is ${pipelineStatus} — skipping mover for identity ${identityId}`);
    state.status = 'skipped';
    state.reason = `The provisioning pipeline is ${pipelineStatus.toLowerCase()}.`;
    state.summary = `Mover skipped: pipeline ${pipelineStatus}`;
    return;
  }

  // 2. Fetch current identity
  currentStep = 'FETCH_IDENTITY';
  const identityRecord = await getIdentityByEmail(email ?? '', tenantId, correlationId);
  if (!identityRecord?.profile) {
    // By identity id in every run: failure messages stay in clear in the history (no codec)
    throw ApplicationFailure.nonRetryable(
      `Identity ${identityId} not found in Hub`,
      'IdentityNotFound',
    );
  }
  const currentProfile = identityRecord.profile;
  state.applied = appliedAttributes(
    currentProfile as unknown as Record<string, unknown>,
    changedFields,
  );

  // 3. Evaluate policy with NEW attributes (current state)
  currentStep = 'POLICY_EVAL_NEW';
  const newIntent = await evaluateUser(currentProfile, tenantId, correlationId);
  log.info(`Policy (new): ${newIntent.operations.length} operations for identity ${identityId}`);

  // 4. Evaluate policy with OLD attributes (reconstruct pre-update profile)
  currentStep = 'POLICY_EVAL_OLD';
  const oldProfile: StandardUserDto = {
    ...currentProfile,
    ...(previousAttributes as Partial<StandardUserDto>),
  };
  const oldIntent = await evaluateUser(oldProfile, tenantId, correlationId);
  log.info(`Policy (old): ${oldIntent.operations.length} operations for identity ${identityId}`);

  // 5. Compute delta
  currentStep = 'COMPUTE_DELTA';
  const delta = await computeEntitlementDelta(
    oldIntent.operations,
    newIntent.operations,
    tenantId,
    correlationId,
  );
  log.info(`Delta: +${delta.toAdd.length} add, -${delta.toRemove.length} remove`);
  state.added = delta.toAdd.length;
  state.removed = delta.toRemove.length;

  if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
    log.info(`No entitlement changes for identity ${identityId}, mover complete (no-op)`);
    currentStep = 'COMPLETED';
    state.status = 'no-change';
    state.summary = `Mover complete for ${who}: no entitlement changes.`;
    return;
  }

  // 6. Discover target systems
  currentStep = 'DISCOVER_TARGETS';
  const targetSystems = (await getActiveTargetSystems(tenantId, correlationId)).filter(Boolean);

  // 7. Execute delta per target system (removals first, then additions)
  currentStep = 'EXECUTE_DELTA';
  for (const [index, system] of targetSystems.entries()) {
    const systemType = getSystemType(system);
    const proxy = getProvisionProxy(system);
    const systemRemoves = operationsForSystem(delta.toRemove, system);
    const systemAdds = operationsForSystem(delta.toAdd, system);
    const changes = {
      added: systemAdds.map((op) => op.targetId),
      removed: systemRemoves.map((op) => op.targetId),
    };

    if (!proxy) {
      log.warn(`No provision proxy for system ${system}, skipping`);
      if (systemRemoves.length > 0 || systemAdds.length > 0) {
        state.systems.push({ system, outcome: 'not-supported', ...changes });
      }
      continue;
    }
    if (systemRemoves.length === 0 && systemAdds.length === 0) continue;

    log.info(`System ${system}: ${systemRemoves.length} removals, ${systemAdds.length} additions`);

    // Mark SYNCING
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
      // Execute combined operations (removals + additions) via provisioning
      const combinedOps = [
        ...systemRemoves.map((op) => ({
          type: op.type as 'group' | 'license',
          action: 'remove' as const,
          targetId: op.targetId,
        })),
        ...systemAdds.map((op) => ({
          type: op.type as 'group' | 'license',
          action: 'add' as const,
          targetId: op.targetId,
        })),
      ];

      if (systemType === 'entra') {
        const entraConfig = await getConnectorConfig('entra-id', tenantId, correlationId);
        await entraProxy.provisionUserToEntra(
          currentProfile,
          { operations: combinedOps },
          (entraConfig as unknown as EntraConfig) ?? undefined,
          tenantId,
          correlationId,
        );
      } else if (systemType === 'ad') {
        const adConfig = await getConnectorConfig('ad', tenantId, correlationId);
        await adProxy.provisionUserToAd(
          currentProfile,
          { operations: combinedOps },
          (adConfig as unknown as AdConfig) ?? undefined,
          tenantId,
          correlationId,
        );
      }

      // Mark SYNCED
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
      state.systems.push({ system, outcome: 'updated', ...changes });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Mover provisioning to ${system} failed: ${message}`);
      state.systems.push({ system, outcome: 'failed', ...changes, reason: reasonOf(err) });
      for (const rest of targetSystems.slice(index + 1)) {
        const added = operationsForSystem(delta.toAdd, rest).map((op) => op.targetId);
        const removed = operationsForSystem(delta.toRemove, rest).map((op) => op.targetId);
        if (added.length > 0 || removed.length > 0) {
          state.systems.push({
            system: rest,
            outcome: getProvisionProxy(rest) ? 'not-attempted' : 'not-supported',
            added,
            removed,
          });
        }
      }
      await setProvisioningStatus(
        identityId,
        system,
        'ERROR',
        message,
        tenantId,
        undefined,
        undefined,
        correlationId,
      );
      throw err;
    }
  }

  // 8. Completed
  currentStep = 'COMPLETED';
  state.summary = `Mover complete for ${who}: +${delta.toAdd.length} add, -${delta.toRemove.length} remove.`;
  log.info(state.summary);
}
