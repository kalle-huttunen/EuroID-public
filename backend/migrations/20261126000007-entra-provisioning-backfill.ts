/**
 * Migration: give live identities that have an Entra ID account but no Entra ID provisioning
 * entry a SYNCED entry.
 *
 * Bulk provisioning recorded the Entra ID object id it created on the identity's `entra-id`
 * target source (HX-E3) but wrote no provisioning entry, so `provisionedSystems` never listed
 * Entra ID for those people: the mover never changed their Entra ID access, and offboarding
 * reached them only through its no-provisioning-state fallback. From this release a bulk CREATE
 * or UPDATE marks the entry SYNCED (HX-E4); this adds it for the identities provisioned before:
 * every identity, in every tenant, that is not soft-deleted, has a target source for Entra ID
 * (`entra-id`, `entra`, `entraid`, any case) with an account id, and has no Entra ID provisioning
 * entry under any of those names. The entry is `entra-id`, SYNCED, with `provisionedAt` and
 * `lastSync` set to now: an account exists, and the migration cannot know more. Rerunning it
 * changes nothing (an identity with an entry is no longer matched).
 */
import { Db } from 'mongodb';

const IDENTITIES = 'identities';
/** The names Entra ID goes by in sources and provisioning entries (getSystemType 'entra'). */
const ENTRA = /^entra(-?id)?$/i;

interface IdentityRow {
  provisioning?: Array<Record<string, unknown>>;
}

export async function up(db: Db): Promise<void> {
  const now = new Date();
  const result = await db.collection<IdentityRow>(IDENTITIES).updateMany(
    {
      deletedAt: null,
      sources: {
        $elemMatch: {
          sourceRole: 'target',
          sourceName: ENTRA,
          externalId: { $exists: true, $nin: [null, ''] },
        },
      },
      provisioning: { $not: { $elemMatch: { targetSystem: ENTRA } } },
    },
    {
      $push: {
        provisioning: {
          targetSystem: 'entra-id',
          status: 'SYNCED',
          provisionedAt: now,
          lastSync: now,
        },
      },
    },
  );
  console.log(
    `[migration] identities: ${result.modifiedCount} with an Entra ID account got a SYNCED ` +
      'Entra ID provisioning entry',
  );
}

/**
 * Leaves the entries: an entry `up` added cannot be told from one a bulk run, onboarding or the
 * mover wrote or updated since, and removing it would hide the account from the mover and
 * offboarding again.
 */
export async function down(): Promise<void> {}
