/**
 * Temporal activity heartbeats for long batch activities: record progress as heartbeat details
 * and read the last ones back when Temporal retries the activity. Outside an activity (a service
 * called inline, a unit test without MockActivityEnvironment) heartbeat does nothing and there is
 * no earlier progress.
 */
import { Context } from '@temporalio/activity';

function currentActivity(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

/** Heartbeat with `details` (throttled by the SDK; the last one is what a retry gets). */
export function heartbeat(details?: unknown): void {
  currentActivity()?.heartbeat(details);
}

/** The details of the last heartbeat of an earlier attempt of this activity, if any. */
export function lastHeartbeat<T>(): T | undefined {
  return currentActivity()?.info.heartbeatDetails as T | undefined;
}

/**
 * Heartbeats every `intervalMs` until the returned stop is called, for an activity that waits on
 * one long call with no progress to report between. The activity's context is taken now, so the
 * timer does not depend on async context reaching it. Outside an activity it does nothing.
 */
export function heartbeatEvery(intervalMs: number): () => void {
  const activity = currentActivity();
  if (!activity) return () => undefined;
  const timer = setInterval(() => activity.heartbeat(), intervalMs);
  return () => clearInterval(timer);
}
