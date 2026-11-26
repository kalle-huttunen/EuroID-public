/**
 * What the handler wrapper (`HandlerFailureCaptureService`) needs to know about one dispatch of
 * an event, keyed by the event object every listener receives:
 *
 * - awaited: emitted with `emitAndWait`. A handler without `async: true` then answers the caller,
 *   which owns its failure (Nest hands it `undefined`), so the wrapper does not dead-letter it.
 * - rerun: re-emitted by a dead-letter retry. The wrapper reports each handler's outcome to the
 *   retry instead of capturing a new entry, so the retry closes its entry only when all succeeded.
 *
 * Also tags an error with the handler that threw it, so `emit()`'s catch can record the handler of
 * a `suppressErrors: false` listener.
 */

const awaitedEvents = new WeakSet<object>();

export function markAwaited(event: object): void {
  awaitedEvents.add(event);
}

export function isAwaited(event: unknown): boolean {
  return typeof event === 'object' && event !== null && awaitedEvents.has(event);
}

export interface HandlerFailure {
  handler: string;
  error: unknown;
}

type HandlerRun = Promise<HandlerFailure | undefined>;

const reruns = new WeakMap<object, HandlerRun[]>();

/**
 * Start collecting the handler runs of an event a dead-letter retry is about to re-emit. Call the
 * returned function after the emit resolved: it waits for every wrapped handler that ran for the
 * event, `async: true` ones included, and returns those that failed.
 */
export function trackRerun(event: object): () => Promise<HandlerFailure[]> {
  const runs: HandlerRun[] = [];
  reruns.set(event, runs);
  return async () => {
    // EventEmitter2 starts an `async: true` listener with setImmediate during the emit; an
    // immediate queued now runs after those, so every such handler has started (and registered).
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outcomes = await Promise.all(runs);
    reruns.delete(event);
    return outcomes.filter((outcome): outcome is HandlerFailure => outcome !== undefined);
  };
}

/** The run list of a re-emitted event, when a dead-letter retry is collecting it. */
export function rerunOf(event: unknown): HandlerRun[] | undefined {
  return typeof event === 'object' && event !== null ? reruns.get(event) : undefined;
}

const failedHandlers = new WeakMap<object, string>();

/** Record which handler threw err. An outer handler overwrites an inner one's tag. */
export function tagFailedHandler(err: unknown, handler: string): void {
  if (typeof err === 'object' && err !== null) failedHandlers.set(err, handler);
}

export function failedHandlerOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? failedHandlers.get(err) : undefined;
}
