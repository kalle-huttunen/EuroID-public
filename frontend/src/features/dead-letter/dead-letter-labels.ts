/**
 * Dead-letter labels and the rules the backend applies to an entry (`dead-letter.service.ts`):
 * what retry and replay can actually re-run, which statuses allow which action, and the honest
 * outcome text of each action.
 */
import type { DeadLetterStatus, DeadLetterType, IDeadLetterEntry } from '../../interfaces';

export const STATUS_LABEL: Record<DeadLetterStatus, string> = {
  pending: 'Pending',
  retrying: 'Retrying',
  replayed: 'Replayed',
  dismissed: 'Dismissed',
  failed_permanently: 'Failed permanently',
};

/** Ant Design Tag preset per status (theme-driven, no raw colors). */
export const STATUS_TAG: Record<DeadLetterStatus, string> = {
  pending: 'warning',
  retrying: 'processing',
  replayed: 'success',
  dismissed: 'default',
  failed_permanently: 'error',
};

export const TYPE_LABEL: Record<DeadLetterType, string> = {
  event_handler_failure: 'Event handler failed',
  event_validation_failure: 'Invalid event',
  event_chain_depth_exceeded: 'Event loop stopped',
  workflow_terminal: 'Workflow failed',
  connector_non_retryable: 'Connector rejected',
};

export const STATUSES = Object.keys(STATUS_LABEL) as DeadLetterStatus[];
export const TYPES = Object.keys(TYPE_LABEL) as DeadLetterType[];

/** Statuses the backend retries from; replay needs `pending`. */
const RETRYABLE: DeadLetterStatus[] = ['pending', 'retrying'];
/** Still open: dismissing closes it (the backend would also overwrite a closed entry). */
const DISMISSABLE: DeadLetterStatus[] = ['pending', 'retrying', 'failed_permanently'];

/** The domain event a failed handler entry carries, if any. */
export function eventTypeOf(entry: IDeadLetterEntry): string | undefined {
  const eventType = entry.originalPayload?.type;
  const metadata = entry.originalPayload?.metadata;
  const hasMetadata = metadata !== null && typeof metadata === 'object';
  return entry.type === 'event_handler_failure' && typeof eventType === 'string' && hasMetadata
    ? eventType
    : undefined;
}

/**
 * Why retry and replay cannot re-run this entry, or undefined when they can. The backend re-runs
 * only a failed handler's domain event and refuses anything else (409).
 */
export function rerunBlocker(entry: IDeadLetterEntry): string | undefined {
  if (eventTypeOf(entry)) return undefined;
  const fix = 'Fix the cause where it failed, then dismiss this entry.';
  switch (entry.type) {
    case 'event_handler_failure':
      return `It records a failure without the original event (for example an older webhook delivery that ran out of attempts), so there is nothing to re-run. ${fix}`;
    case 'event_validation_failure':
      return `The event failed validation and never reached a handler; emitting it again would fail the same way. ${fix}`;
    case 'event_chain_depth_exceeded':
      return `The event was dropped to stop an event loop; emitting it again could restart the loop. ${fix}`;
    case 'workflow_terminal':
      return `A workflow step failed for good (for example a distributed transaction's rollback). EuroID cannot re-run a workflow from here. ${fix}`;
    case 'connector_non_retryable':
      return `The target system rejected the call in a way retrying cannot fix. ${fix}`;
  }
}

export const canRetry = (e: IDeadLetterEntry) => !rerunBlocker(e) && RETRYABLE.includes(e.status);
export const canReplay = (e: IDeadLetterEntry) => !rerunBlocker(e) && e.status === 'pending';
export const canDismiss = (e: IDeadLetterEntry) => DISMISSABLE.includes(e.status);

export interface ActionOutcome {
  type: 'success' | 'info' | 'warning' | 'error';
  message: string;
  description?: string;
}

/** What re-ran: the failed handler alone, or every handler of the event. */
export function rerunScope(entry: IDeadLetterEntry): string {
  return entry.handler
    ? `The handler that failed (${entry.handler}) ran again with the stored event`
    : 'Every handler of the event ran again';
}

/** What a retry did, read from the entry after it; null when the entry could not be reloaded. */
export function retryOutcome(after: IDeadLetterEntry | null): ActionOutcome {
  if (!after) {
    return {
      type: 'warning',
      message: 'The retry request went through, but the entry could not be reloaded.',
      description: 'Refresh to see its status.',
    };
  }
  const error = after.lastRetryError ?? 'no error message';
  switch (after.status) {
    case 'replayed':
      return {
        type: 'success',
        message: 'Retry succeeded; the entry is closed as replayed.',
        description: `${rerunScope(after)} and completed without an error.`,
      };
    case 'pending':
      return {
        type: 'warning',
        message: `Retry failed: ${error}`,
        description: `Attempt ${after.retryCount} of ${after.maxRetries}. The entry stays pending.`,
      };
    case 'failed_permanently':
      return {
        type: 'error',
        message: `Retry failed: ${error}`,
        description: `The entry reached its retry limit (${after.maxRetries}) and is closed as failed permanently.`,
      };
    default:
      return {
        type: 'info',
        message: `The entry is ${STATUS_LABEL[after.status].toLowerCase()}.`,
        description: 'Refresh in a moment to see how the retry ended.',
      };
  }
}

/** What a replay did, read from the entry after it; null when the entry could not be reloaded. */
export function replayOutcome(after: IDeadLetterEntry | null): ActionOutcome {
  if (!after) {
    return {
      type: 'warning',
      message: 'The replay request went through, but the entry could not be reloaded.',
      description: 'Refresh to see its status.',
    };
  }
  if (after.status === 'replayed') {
    return {
      type: 'success',
      message: 'Replay succeeded; the entry is closed as replayed.',
      description: `${rerunScope(after)} and completed without an error.`,
    };
  }
  if (after.status === 'pending') {
    return {
      type: 'warning',
      message: `Replay failed: ${after.lastRetryError ?? 'no error message'}`,
      description: 'The entry stays pending. A replay does not count as a retry attempt.',
    };
  }
  return {
    type: 'info',
    message: `The entry is ${STATUS_LABEL[after.status].toLowerCase()}.`,
    description: 'Refresh in a moment to see how the replay ended.',
  };
}

export const DISMISS_OUTCOME: ActionOutcome = {
  type: 'success',
  message: 'Entry dismissed. Nothing was re-run.',
};

/** The API's message (a string, or one line per invalid field), else the error's own. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message) && message.length) return message.join('; ');
  return err instanceof Error && err.message ? err.message : fallback;
}
