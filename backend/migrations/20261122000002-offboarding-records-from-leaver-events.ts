/**
 * Migration: offboarding results move from leaver_events to offboarding_records.
 *
 * Each leaver event kept the per-system result of the offboarding it started (`offboarding`),
 * and offboardings started by DELETE /identity/:id kept theirs nowhere, so a failed target there
 * could not be closed as removed manually. Every offboarding's result is now one
 * offboarding_records document keyed by its workflow id. This copies each stored leaver result
 * there (the newest one per workflow id; a record already there wins), marks the leaver event
 * finished (`offboardingFinishedAt`, which the HR mover reads instead of the result) and removes
 * the result from it. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const EVENTS = 'leaver_events';
const RECORDS = 'offboarding_records';

interface LeaverEventWithResult {
  _id: unknown;
  tenantId: string;
  identityId: string;
  workflowId: string;
  offboarding: Record<string, unknown> & { finishedAt?: Date };
}

export async function up(db: Db): Promise<void> {
  const events = db.collection<LeaverEventWithResult>(EVENTS);
  const records = db.collection(RECORDS);
  const withResult = await events
    .find({ offboarding: { $exists: true }, workflowId: { $type: 'string' } })
    .sort({ 'offboarding.finishedAt': -1 })
    .toArray();

  for (const event of withResult) {
    const { status, hubStatus, systems, finishedAt } = event.offboarding;
    const now = new Date();
    await records.updateOne(
      { tenantId: event.tenantId, workflowId: event.workflowId },
      {
        $setOnInsert: {
          identityId: event.identityId,
          status,
          hubStatus,
          systems,
          finishedAt: finishedAt ?? now,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await events.updateOne(
      { _id: event._id },
      { $set: { offboardingFinishedAt: finishedAt ?? now }, $unset: { offboarding: '' } },
    );
  }
  await events.updateMany({ offboarding: { $exists: true } }, { $unset: { offboarding: '' } });
}

/**
 * Puts each record back on the started leaver events of its workflow id (the result the HR mover
 * of that version reads); records and the finished marker stay.
 */
export async function down(db: Db): Promise<void> {
  const records = db.collection(RECORDS);
  const events = db.collection(EVENTS);
  for await (const record of records.find({})) {
    await events.updateMany(
      { tenantId: record.tenantId, workflowId: record.workflowId, status: 'started' },
      {
        $set: {
          offboarding: {
            status: record.status,
            hubStatus: record.hubStatus,
            systems: record.systems,
            finishedAt: record.finishedAt,
          },
        },
      },
    );
  }
}
