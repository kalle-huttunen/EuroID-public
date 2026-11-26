/**
 * The run PATCH /identity/:id starts, and the `workflow` its response reports.
 *
 * Every PATCH that moves a mover trigger attribute of a provisioned identity asks the mover
 * (requestMove, identity.move_requested). While a mover run for the identity is open, the edit is
 * queued on it (`queued: true`): that run evaluates the identity once more when it ends.
 *
 * An edit that changes a mover trigger attribute of an identity provisioned to a target system
 * moves its access: the mover starts (identity.move_requested, answered by MoverEventHandler).
 * Otherwise onboarding syncs (identity.provision_requested): it skips SYNCED targets, and
 * syncToEntra makes it push to the Entra ID account again. Never both: two runs must not change
 * the same identity's access at once. The mover run carries the sync (syncToEntra in its input):
 * it updates the Entra ID account also when it changes no access there, so the identity that
 * already has its account gets no second (onboarding) run. `workflowType` names the run.
 */
import type { Logger } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  isMoverQueuedAnswer,
  type IdentityMoveRequestedPayload,
  type IdentityProvisionRequestedPayload,
} from '@infrastructure/events/event-payloads';
import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { CRITICAL_FIELDS } from './identity.constants';

export type SyncWorkflowType = 'mover' | 'onboarding';

/** `workflow` of the PATCH ?syncToEntra=true response. */
export interface SyncRunReport {
  triggered: boolean;
  workflowType: SyncWorkflowType;
  workflowId?: string;
  trackingUrl?: string;
  /** The edit's access change is queued on the identity's open mover run (`workflowId`). */
  queued?: boolean;
  message?: string;
  error?: string;
}

/** A queued edit, as the response's `message` says it. */
const QUEUED =
  'A mover run for this identity is in progress: it applies this access change when it has finished';

/** A run of the same kind for the identity is in progress (same workflow id). */
const ALREADY_RUNNING: Record<SyncWorkflowType, string> = {
  onboarding:
    'An onboarding run for this identity is already in progress; request the sync again when it has finished',
  mover:
    'A mover run for this identity is already in progress; request the sync again when it has finished',
};

const TRIGGER_FAILED = 'Workflow trigger failed';

/** Starts the mover or else onboarding for an edit saved with syncToEntra, and reports which. */
export async function startSyncRun(
  events: DomainEventEmitterService,
  logger: Logger,
  edit: IdentityMoveRequestedPayload,
): Promise<SyncRunReport> {
  const { identityId } = edit;
  const moved = await requestMove(events, logger, { ...edit, syncToEntra: true });
  if (moved) return moved;
  const synced = await startRun<IdentityProvisionRequestedPayload>(
    events,
    logger,
    'onboarding',
    DomainEventType.IDENTITY_PROVISION_REQUESTED,
    identityId,
    // No email: the onboarding handler reads it from the identity
    { syncToEntra: true },
  );
  return synced ?? { triggered: false, workflowType: 'onboarding', error: TRIGGER_FAILED };
}

/**
 * Whether an edit moves a mover trigger attribute: one it wrote whose value changed (its
 * before-value is in previousAttributes), as MoverEventHandler's movedTriggerFields reads it.
 */
export function movesTriggerAttribute(
  edit: Pick<IdentityMoveRequestedPayload, 'changedFields' | 'previousAttributes'>,
): boolean {
  return edit.changedFields.some(
    (field) => CRITICAL_FIELDS.includes(field) && field in edit.previousAttributes,
  );
}

/**
 * Asks the mover for an edit (identity.move_requested): the run it started, or the open run the
 * edit was queued on; null when the mover does not apply to the identity.
 */
export async function requestMove(
  events: DomainEventEmitterService,
  logger: Logger,
  edit: IdentityMoveRequestedPayload,
): Promise<SyncRunReport | null> {
  const { identityId, changedFields, previousAttributes, syncToEntra } = edit;
  return startRun<IdentityMoveRequestedPayload>(
    events,
    logger,
    'mover',
    DomainEventType.IDENTITY_MOVE_REQUESTED,
    identityId,
    { identityId, changedFields, previousAttributes, ...(syncToEntra ? { syncToEntra } : {}) },
  );
}

/** The report of one start; null when no handler started a run (the mover does not apply). */
async function startRun<P>(
  events: DomainEventEmitterService,
  logger: Logger,
  workflowType: SyncWorkflowType,
  type: DomainEventType,
  identityId: string,
  payload: P,
): Promise<SyncRunReport | null> {
  try {
    const results = await events.emitAndWait<P, unknown>(type, identityId, payload);
    // Listeners of every event (audit, webhooks) answer too: the workflow id is the string
    const workflowId = results.find((r): r is string => typeof r === 'string');
    if (workflowId) {
      return {
        triggered: true,
        workflowType,
        workflowId,
        trackingUrl: temporalWorkflowUrl(workflowId),
      };
    }
    const queued = results.find(isMoverQueuedAnswer);
    return queued
      ? {
          triggered: false,
          queued: true,
          workflowType,
          workflowId: queued.workflowId,
          trackingUrl: temporalWorkflowUrl(queued.workflowId),
          message: QUEUED,
        }
      : null;
  } catch (error: unknown) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      // This run did not start: point at the one still going instead of reporting a failure.
      return {
        triggered: false,
        workflowType,
        workflowId: error.workflowId,
        trackingUrl: temporalWorkflowUrl(error.workflowId),
        error: ALREADY_RUNNING[workflowType],
      };
    }
    const stack = error instanceof Error ? error.stack : String(error);
    logger.error(`Failed to trigger ${workflowType} workflow`, stack);
    return { triggered: false, workflowType, error: TRIGGER_FAILED };
  }
}
