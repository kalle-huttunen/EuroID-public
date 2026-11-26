/**
 * Migration: DEPROVISIONED provisioning entries no longer claim a completed writeback.
 *
 * Since the final sweep of 2026-11-23 a deprovision (offboarding, expiry, an access review revoke,
 * a target closed as removed manually) sets the entry's `writebackComplete` back to false
 * (IdentityProvisioningService.updateProvisioningState), so onboarding writes back the account a
 * later provision of that target creates. Entries deprovisioned before that kept
 * `writebackComplete: true`: re-provisioning such a target wrote no account id back, and Okta,
 * SCIM, AD and Entra ID kept the removed account's id for the mover and offboarding. This sets
 * `writebackComplete: false` on every DEPROVISIONED entry of every identity (all tenants, deleted
 * identities included: a rehire's revival undoes the writeback the same way). Rerunning it is
 * safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'identities';
const STALE_ENTRY = { status: 'DEPROVISIONED', writebackComplete: true };

export async function up(db: Db): Promise<void> {
  await db.collection(COLLECTION).updateMany(
    { provisioning: { $elemMatch: STALE_ENTRY } },
    { $set: { 'provisioning.$[entry].writebackComplete': false } },
    {
      arrayFilters: [{ 'entry.status': STALE_ENTRY.status, 'entry.writebackComplete': true }],
    },
  );
}

/**
 * No-op: which entries had `writebackComplete: true` before is not recorded, and an entry the
 * application deprovisioned since has it false by design, so no update restores the old state
 * exactly. A DEPROVISIONED entry with the flag false is correct either way.
 */
export async function down(): Promise<void> {
  // Nothing to undo: see above
}
