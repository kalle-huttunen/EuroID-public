/**
 * An edit that meets an open mover run (one run per identity: the workflow id is
 * t-<tenant>-mover-<identityId>). MoverService then signals the open run (reevaluateMoverSignal)
 * instead of starting a second one, and the run, once it has recorded its outcome, continues as
 * new with the queued edit: one more evaluation of the identity, with the first run's applied
 * values as the "before" of its own fields and the baseline values the edit sent for the others.
 * Several edits queued during one run make one more evaluation.
 *
 * Workflow code: bundled into moverWorkflow, so it must stay deterministic.
 */
import { continueAsNew, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';
import { isPatched } from './workflow-versioning';
import type { MoverWorkflowInput, RunState } from './mover.workflow';

/**
 * A run with a queued edit continues as new with it after its outcome is recorded, also after a
 * failed run. Histories from before this patch have no such edit: the API dropped the edit
 * (WorkflowExecutionAlreadyStartedError) and a signal without a handler was dropped too.
 */
const REEVALUATE_PATCH = 'mover:reevaluate-queued-edit';

/** What an edit queued for the open run carries (no email: the run reads the identity by id). */
export interface MoverReevaluation {
  changedFields: string[];
  /** The access baseline's values of the fields, as MoverService passes them to a new run. */
  previousAttributes: Record<string, unknown>;
  /** The edit asked for a sync to Entra ID (PATCH /identity/:id?syncToEntra=true). */
  syncToEntra?: boolean;
}

export const reevaluateMoverSignal = defineSignal<[MoverReevaluation]>('reevaluate');

/**
 * Runs from this patch on answer acceptsQueuedEdits (true): they continue with a queued edit.
 * MoverService asks before it signals. A run whose history predates the patch, or one a worker
 * of an older build runs, has no such handler: the API then queues nothing on it and starts a
 * run of its own once it has ended (final review ID3), so an edit is never answered as queued
 * on a run that would drop it.
 */
const QUEUED_EDIT_QUERY_PATCH = 'mover:queued-edit-query';

export const acceptsQueuedEditsQuery = defineQuery<boolean>('acceptsQueuedEdits');

/** Registers acceptsQueuedEdits on runs started from QUEUED_EDIT_QUERY_PATCH on. */
export function registerQueuedEditQuery(): void {
  if (isPatched(QUEUED_EDIT_QUERY_PATCH)) setHandler(acceptsQueuedEditsQuery, () => true);
}

/** Two queued edits as one: every field, the first edit's "before" of a field kept. */
export function mergeReevaluations(
  queued: MoverReevaluation | undefined,
  next: MoverReevaluation,
): MoverReevaluation {
  if (!queued) return next;
  return {
    changedFields: [...new Set([...queued.changedFields, ...next.changedFields])],
    previousAttributes: { ...next.previousAttributes, ...queued.previousAttributes },
    ...(queued.syncToEntra || next.syncToEntra ? { syncToEntra: true } : {}),
  };
}

/**
 * The next run's input. Its "before" of the first run's fields is what that run applied when it
 * completed (no change included), else that run's own "before" (nothing was applied).
 */
export function nextMoverInput(
  input: MoverWorkflowInput,
  state: RunState,
  queued: MoverReevaluation,
  completed: boolean,
): MoverWorkflowInput {
  const applied = completed && state.applied ? state.applied : undefined;
  const firstRunBefore = Object.fromEntries(
    input.changedFields
      .filter((field) => field in (applied ?? input.previousAttributes))
      .map((field) => [field, (applied ?? input.previousAttributes)[field]]),
  );
  const syncToEntra = queued.syncToEntra || (!completed && input.syncToEntra);
  return {
    identityId: input.identityId,
    tenantId: input.tenantId,
    changedFields: [...new Set([...input.changedFields, ...queued.changedFields])],
    previousAttributes: { ...queued.previousAttributes, ...firstRunBefore },
    trigger: 'attribute-change',
    ...(syncToEntra ? { syncToEntra: true } : {}),
  };
}

/** Continues as new with the queued edit, if there is one (REEVALUATE_PATCH). */
export async function continueWithQueuedEdit(
  input: MoverWorkflowInput,
  state: RunState,
  queued: MoverReevaluation | undefined,
  completed: boolean,
): Promise<void> {
  if (!queued || !isPatched(REEVALUATE_PATCH)) return;
  await continueAsNew<(next: MoverWorkflowInput) => Promise<string>>(
    nextMoverInput(input, state, queued, completed),
  );
}
