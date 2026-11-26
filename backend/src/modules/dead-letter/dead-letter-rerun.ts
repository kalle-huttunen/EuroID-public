/**
 * What retry and replay re-run for a dead-letter entry, and how they learn whether it worked.
 *
 * - An entry that names its failed `handler` (captured per handler): that handler alone runs
 *   with the stored event, so the event's other handlers (audit, webhooks, timeline) do not run
 *   twice. Its outcome is the handler's own.
 * - An entry with a domain event but no handler (email and webhook retry events, entries from
 *   before 2.0cu, outbox failures): the event is re-emitted to every handler, and the re-run
 *   succeeds only when the emit resolved and every wrapped handler that ran for it succeeded.
 * - Anything else (workflow terminals, connector errors, invalid or looping events, a handler
 *   failure stored without its event) cannot be re-run: ConflictException, dismiss it instead.
 */
import { ConflictException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { trackRerun } from '@infrastructure/events/handler-dispatch';
import type { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import type { DeadLetterType } from './schemas/dead-letter.schema';

/** The parts of an entry a re-run needs. */
export interface RerunnableEntry {
  type: DeadLetterType;
  originalPayload: Record<string, unknown>;
  handler?: string;
}

type StoredEvent = Record<string, unknown> & { type: string; metadata: object };

/** The domain event an entry stores, if it is a handler failure that kept its event. */
export function storedEventOf(entry: RerunnableEntry): StoredEvent | undefined {
  if (entry.type !== 'event_handler_failure') return undefined;
  const payload = entry.originalPayload as { type?: unknown; metadata?: unknown } | undefined;
  return typeof payload?.type === 'string' &&
    typeof payload.metadata === 'object' &&
    payload.metadata !== null
    ? (payload as StoredEvent)
    : undefined;
}

/**
 * Query part selecting the entries this process can re-run: a handler failure with its event,
 * whose handler (if it names one) is registered here. The automatic retry and batch retry pick
 * only these, so entries that need an admin never crowd out the ones they can retry.
 */
export function rerunnableFilter(knownHandlers: string[]): Record<string, unknown> {
  return {
    type: 'event_handler_failure',
    'originalPayload.type': { $exists: true },
    'originalPayload.metadata': { $exists: true },
    $or: [{ handler: null }, { handler: { $in: knownHandlers } }],
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The re-run of one entry, or ConflictException when it has nothing to re-run. The returned
 * function resolves when the re-run succeeded and rejects with the failure otherwise.
 */
export function planRerun(
  id: string,
  entry: RerunnableEntry,
  emitter: Pick<EventEmitter2, 'emitAsync'>,
  handlers: DeadLetterHandlerRegistry | undefined,
): () => Promise<void> {
  const event = storedEventOf(entry);
  if (!event) {
    throw new ConflictException(
      `Dead-letter entry ${id} (${entry.type}) carries no domain event, so there is nothing to re-run. Fix the cause where it failed, then dismiss the entry.`,
    );
  }

  if (entry.handler) {
    const run = handlers?.get(entry.handler);
    if (!run) {
      throw new ConflictException(
        `Dead-letter entry ${id} names handler ${entry.handler}, which is not registered (renamed or removed), so it cannot be re-run. Dismiss the entry.`,
      );
    }
    return async () => {
      await run({ ...event });
    };
  }

  return async () => {
    // A copy per re-run: the handler runs are collected under this object.
    const replayed = { ...event };
    const settle = trackRerun(replayed);
    let emitError: unknown;
    try {
      await emitter.emitAsync(event.type, replayed);
    } catch (err) {
      emitError = err; // a `suppressErrors: false` listener failed
    }
    const failures = await settle();
    if (failures.length > 0) {
      throw new Error(failures.map((f) => `${f.handler}: ${messageOf(f.error)}`).join('; '));
    }
    if (emitError !== undefined) throw emitError;
  };
}
