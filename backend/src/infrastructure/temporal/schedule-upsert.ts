import { ScheduleAlreadyRunning, ScheduleNotFoundError } from '@temporalio/client';
import type { ScheduleClient, ScheduleOptions } from '@temporalio/client';

/** What upsertSchedule did with a schedule. */
export type ScheduleUpsertResult = 'created' | 'updated' | 'recreated' | 'failed';

/** What syncOptionalSchedule did with the schedule of a disabled job. */
export type SchedulePauseResult = 'paused' | 'already-paused' | 'absent' | 'failed';

/** How a pause by the worker is told apart from one by an operator (the schedule's note). */
const DISABLED_NOTE_PREFIX = 'Paused by the EuroID worker: ';

/**
 * Create the schedule, or bring an existing one up to date: its spec (the cron the env gives
 * now) and its action are written again, keeping its policies and state (paused, note). The
 * Temporal server stores the action args as the client encoded them, so the rewrite encodes them
 * with the client's data converter under the current ENCRYPTION_KEY_ID. The worker calls it for
 * each of its schedules at start, which is what key rotation step 2 relies on.
 *
 * Updating reads the stored action first. When no key in the settings decrypts it (the previous
 * key was removed before a worker re-encoded the schedule), the schedule is deleted and created
 * again: its recent run history and a paused state are lost, which the log says. Any other
 * failure is logged and returns 'failed': the worker starts without that schedule's change.
 */
export async function upsertSchedule(
  schedules: ScheduleClient,
  options: ScheduleOptions,
  logger: { log(message: string): void; warn(message: string): void },
): Promise<ScheduleUpsertResult> {
  const { scheduleId } = options;
  try {
    await schedules.create(options);
    logger.log(`Schedule ${scheduleId} created`);
    return 'created';
  } catch (err: unknown) {
    if (!isAlreadyExists(err)) {
      logger.warn(`Could not create schedule ${scheduleId}: ${messageOf(err)}`);
      return 'failed';
    }
  }

  const handle = schedules.getHandle(scheduleId);
  try {
    let resumed = false;
    await handle.update((previous) => {
      // A pause the worker made while the job was disabled ends now; any other pause stays
      resumed = !!previous.state?.paused && isWorkerPause(previous.state.note);
      return {
        ...previous,
        spec: options.spec,
        action: options.action,
        ...(resumed && {
          state: {
            ...previous.state,
            paused: false,
            note: 'Resumed by the EuroID worker: the job is enabled',
          },
        }),
      };
    });
    if (resumed) logger.log(`Schedule ${scheduleId} resumed: its job is enabled again`);
    logger.log(`Schedule ${scheduleId} updated (spec and action args, current encryption key)`);
    return 'updated';
  } catch (err: unknown) {
    if (!isDecryptionError(err)) {
      logger.warn(`Could not update schedule ${scheduleId}: ${messageOf(err)}`);
      return 'failed';
    }
    logger.warn(
      `Schedule ${scheduleId} holds args no configured key decrypts (${messageOf(err)}); ` +
        'deleting and creating it again: its recent runs and a paused state are not kept',
    );
  }

  // Workers starting at once can both get here: a schedule another one deleted (ScheduleNotFound)
  // or created again (already exists) meanwhile is recreated all the same
  try {
    await handle.delete().catch((err: unknown) => {
      if (!(err instanceof ScheduleNotFoundError)) throw err;
    });
    try {
      await schedules.create(options);
    } catch (err: unknown) {
      if (!isAlreadyExists(err)) throw err;
      logger.log(`Schedule ${scheduleId} recreated by another worker meanwhile`);
      return 'recreated';
    }
    logger.log(`Schedule ${scheduleId} recreated`);
    return 'recreated';
  } catch (err: unknown) {
    logger.warn(`Could not recreate schedule ${scheduleId}: ${messageOf(err)}`);
    return 'failed';
  }
}

/**
 * The schedule of an optional job (audit archive, cold-storage archival): created or updated
 * (upsertSchedule) while `job.enabled`, else paused so a job turned off stops running. A pause
 * the worker made is ended by the next start with the job enabled; a schedule an operator paused
 * stays paused either way. A disabled job without a schedule gets none.
 */
export async function syncOptionalSchedule(
  schedules: ScheduleClient,
  options: ScheduleOptions,
  job: { enabled: true } | { enabled: false; reason: string },
  logger: { log(message: string): void; warn(message: string): void },
): Promise<ScheduleUpsertResult | SchedulePauseResult> {
  if (job.enabled) return upsertSchedule(schedules, options, logger);
  const { scheduleId } = options;
  const handle = schedules.getHandle(scheduleId);
  try {
    const { state } = await handle.describe();
    if (state.paused) return 'already-paused';
    await handle.pause(`${DISABLED_NOTE_PREFIX}${job.reason}`);
    logger.log(`Schedule ${scheduleId} paused: ${job.reason}`);
    return 'paused';
  } catch (err: unknown) {
    if (err instanceof ScheduleNotFoundError) return 'absent';
    logger.warn(`Could not pause schedule ${scheduleId} (${job.reason}): ${messageOf(err)}`);
    return 'failed';
  }
}

function isWorkerPause(note: string | undefined): boolean {
  return !!note?.startsWith(DISABLED_NOTE_PREFIX);
}

function isAlreadyExists(err: unknown): boolean {
  if (err instanceof ScheduleAlreadyRunning) return true;
  const message = messageOf(err);
  return message.includes('already exists') || message.includes('ScheduleAlreadyRunning');
}

/** TemporalPayloadDecryptionError (temporal-payload-codec.ts), matched by name: the SDK may wrap it. */
function isDecryptionError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
    if (e.name === 'TemporalPayloadDecryptionError') return true;
  }
  return false;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
