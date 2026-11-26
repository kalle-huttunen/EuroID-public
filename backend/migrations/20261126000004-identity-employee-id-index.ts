/**
 * Migration: the index `identities { tenantId, profile.employeeId }`.
 *
 * An access review now gives the items of a person whose HR record names the manager only by
 * `managerId` (an employee id) to the live identity with that employee id (backend/src/modules/
 * identity/identity-employee-id.ts, AccessReviewCampaignService). The index keeps that lookup to
 * the matching identities instead of every identity of the tenant. Mongoose builds it at start
 * too; built here first, the start finds it in place. The key and options are the schema's
 * (identity.schema.ts), so Mongoose takes it as its own.
 *
 * No document changes. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'identities';
/** Must match EMPLOYEE_ID_INDEX, _KEY and _OPTIONS in identity-employee-id.ts. */
const NAME = 'tenantId_1_profile.employeeId_1';
const KEY = { tenantId: 1, 'profile.employeeId': 1 } as const;
const OPTIONS = { name: NAME };

export async function up(db: Db): Promise<void> {
  // createIndex creates the collection when it is missing and is a no-op for an identical index
  await db.collection(COLLECTION).createIndex(KEY, OPTIONS);
}

/** Drops the index (the review's manager lookup then scans the tenant's identities). */
export async function down(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return;
  const names = (await db.collection(COLLECTION).indexes()).map((i) => i.name);
  if (names.includes(NAME)) await db.collection(COLLECTION).dropIndex(NAME);
}
