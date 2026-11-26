/**
 * Migration: close the drifts the old reconciliation comparison raised falsely.
 *
 * Until this release reconciliation (ReconciliationActivities.detectUserDrift) compared hub
 * fields with account fields no account lookup returns, and the hub status with the literals
 * ACTIVE and DISABLED. Every run therefore left open FIELD_MISMATCH drifts on firstName,
 * lastName, email, jobTitle, departmentName, mobilePhone and officeLocation ("the target has
 * none"), and a CRITICAL STATUS_MISMATCH for every leaver, suspended, inactive or guest identity
 * whose account was correctly disabled. The comparison now raises neither
 * (backend/src/activities/reconciliation-account-state.ts).
 *
 * This closes those open drifts in every tenant the way a run closes a drift it no longer finds:
 * status `corrected`, `correctedAt` now. Only drifts the new comparison cannot raise are closed:
 * - FIELD_MISMATCH on one of the seven fields above (no lookup returns them);
 * - STATUS_MISMATCH stored in the old form (the hub status as hub value) whose hub status expects
 *   a disabled account (INACTIVE, SUSPENDED, TERMINATED, DELETED, GUEST) and whose account was
 *   DISABLED.
 * A real drift (a leaver's account still enabled, an active identity's account disabled) and a
 * PENDING identity's (expected enabled unless it is a linked admin account, which the drift does
 * not record) stay open: the next run updates them to the new form or closes them. Ignored and
 * corrected drifts are left as they are. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'drift_records';

/** Hub fields the old comparison read from the account, which no lookup returns. */
const UNREAD_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'jobTitle',
  'departmentName',
  'mobilePhone',
  'officeLocation',
];

/** Hub statuses provisioning writes a disabled account for (targetAccountEnabled). */
const DISABLED_STATUSES = ['INACTIVE', 'SUSPENDED', 'TERMINATED', 'DELETED', 'GUEST'];

export async function up(db: Db): Promise<void> {
  const closed = { status: 'corrected', correctedAt: new Date() };
  const fields = await db
    .collection(COLLECTION)
    .updateMany(
      { status: 'open', type: 'FIELD_MISMATCH', field: { $in: UNREAD_FIELDS } },
      { $set: closed },
    );
  const statuses = await db.collection(COLLECTION).updateMany(
    {
      status: 'open',
      type: 'STATUS_MISMATCH',
      hubValue: { $in: DISABLED_STATUSES },
      targetValue: 'DISABLED',
    },
    { $set: closed },
  );
  console.log(
    `[migration] closed ${fields.modifiedCount} field and ${statuses.modifiedCount} status ` +
      'drifts the old comparison raised falsely',
  );
}

/**
 * No-op: the drifts were false positives, and which ones this closed is not recorded apart from
 * their `correctedAt`. Reopening them would bring the false drifts back.
 */
export async function down(): Promise<void> {
  // Nothing to undo: see above
}
