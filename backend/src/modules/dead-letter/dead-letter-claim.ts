/**
 * Who re-runs a dead-letter entry (2.0dl). Every API replica and every Temporal worker runs the
 * automatic retry, and admins retry and replay by hand, so a re-run starts only after a claim:
 * one conditional update on the state the entry was read in (status, retryCount and, where the
 * entry must be due, nextRetryAt). Of all the processes that read the same state, one gets it.
 *
 * While the re-run lasts the entry is `retrying` and its nextRetryAt is the end of the claim's
 * lease (DLQ_RETRY_LEASE_MS). The outcome is written only while the claim holds (`retrying` with
 * that lease): an entry dismissed meanwhile stays dismissed, and a process whose lease ran out, so
 * that another took the entry over, does not overwrite that one's outcome. A process that stops
 * during a re-run leaves the entry `retrying`; once the lease has run out the automatic retry
 * takes it again, and the unfinished run counts as a failed retry.
 */
import { ConflictException } from '@nestjs/common';
import type { Model, UpdateQuery } from 'mongoose';
import type { DeadLetterEntryDocument } from './schemas/dead-letter.schema';

/** The error of a re-run that never finished: its lease ran out with no outcome recorded. */
export const RETRY_INTERRUPTED =
  'The previous retry did not finish (the process running it stopped); it counts as a failed retry.';

/** Another process or admin holds the entry, or took it since it was read. */
export class RetryInProgressException extends ConflictException {}

/** The state of an entry a claim compares with. */
type ReadState = Pick<DeadLetterEntryDocument, 'status' | 'retryCount' | 'nextRetryAt'>;

/**
 * Takes entry `id`, read in state `read`, for one re-run and answers the end of the lease. A
 * `retrying` entry is taken only once its lease has run out; with dueBy (the automatic retry) a
 * pending one only while its retry is due at that time. Throws RetryInProgressException when the
 * state changed or the lease still runs.
 */
export async function claimEntry(
  model: Model<DeadLetterEntryDocument>,
  id: string,
  read: ReadState,
  leaseMs: number,
  dueBy?: Date,
): Promise<Date> {
  const now = new Date();
  const lease = new Date(now.getTime() + leaseMs);
  const mustBeDue = read.status === 'retrying' || dueBy !== undefined;
  const claimed = await model
    .findOneAndUpdate(
      {
        _id: id,
        status: read.status,
        retryCount: read.retryCount,
        ...(mustBeDue ? { nextRetryAt: { $lte: dueBy ?? now } } : {}),
      },
      { $set: { status: 'retrying', nextRetryAt: lease } },
    )
    .exec();
  if (!claimed) {
    throw new RetryInProgressException(
      `Dead-letter entry ${id} is being retried right now, or was just retried, by the automatic retry or an admin. Reload it to see where it is.`,
    );
  }
  return lease;
}

/** Writes the outcome of a re-run while its claim holds; false once the claim is lost. */
export async function settleClaim(
  model: Model<DeadLetterEntryDocument>,
  id: string,
  lease: Date,
  update: UpdateQuery<DeadLetterEntryDocument>,
): Promise<boolean> {
  const result = await model
    .updateOne({ _id: id, status: 'retrying', nextRetryAt: lease }, update)
    .exec();
  return result.matchedCount > 0;
}
