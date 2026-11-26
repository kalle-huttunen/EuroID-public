/**
 * Migration: identities.profile.email is stored trimmed and lower-cased.
 *
 * Every write now stores the email in that form and every lookup asks for it
 * (backend/src/shared/utils/email.ts), so an address HR sends as `jane.doe@x.fi` and the IdP as
 * `Jane.Doe@x.fi` is one identity. Emails stored before keep the case their source sent, and
 * lookups would miss them. This migration lower-cases them:
 * - A soft-deleted identity's email always: the unique email index covers live identities only.
 * - A live identity's email when no other live identity of the tenant has the same address in
 *   another case.
 * - Two or more live identities of a tenant with the same address in different cases (a
 *   duplicate person the old exact comparison let in): nothing is changed. The pair is logged
 *   by identity id and raised as a correlation conflict on one of them, pointing at the other
 *   (conflictDetails.incomingIdentityId), so a person merges them from the conflicts list (POST
 *   /identity/:id/resolve-conflict). An identity with an open conflict keeps it; when every
 *   member has one, the group is only logged. Reconcile lower-cases the survivor afterwards.
 *
 * It runs after 20261123000001 (the unique index among live identities), which it relies on.
 * Rerunning it is safe: a group already raised (a member's conflict names another member) is
 * not raised again.
 */
import { Db, ObjectId } from 'mongodb';

const COLLECTION = 'identities';
/** The stored form (normalizeEmail): trimmed, lower-cased. */
const NORMALIZED = { $toLower: { $trim: { input: '$profile.email' } } };

interface Member {
  _id: ObjectId;
  email: string;
  profile?: Record<string, unknown>;
  sources?: Array<{ sourceName?: string }>;
  metadata?: {
    requiresReview?: boolean;
    conflictDetails?: { incomingIdentityId?: string };
  };
}

interface Group {
  _id: { tenantId: string; email: string };
  members: Member[];
}

/** Lower-cases the email of every soft-deleted identity. Returns how many changed. */
async function lowerCaseDeleted(db: Db): Promise<number> {
  const result = await db.collection(COLLECTION).updateMany(
    {
      deletedAt: { $ne: null },
      'profile.email': { $type: 'string' },
      $expr: { $ne: ['$profile.email', NORMALIZED] },
    },
    [{ $set: { 'profile.email': NORMALIZED } }],
  );
  return result.modifiedCount;
}

/**
 * The tenant's live identities grouped by the normalized email, only groups that need work: one
 * whose email is not in the stored form, or several identities with one address.
 */
function liveGroups(db: Db) {
  return db.collection(COLLECTION).aggregate<Group>(
    [
      { $match: { deletedAt: null, 'profile.email': { $type: 'string' } } },
      {
        $group: {
          _id: { tenantId: '$tenantId', email: NORMALIZED },
          members: {
            $push: {
              _id: '$_id',
              email: '$profile.email',
              profile: '$profile',
              sources: '$sources',
              metadata: '$metadata',
            },
          },
        },
      },
      {
        $match: {
          $expr: {
            $or: [
              { $gt: [{ $size: '$members' }, 1] },
              { $ne: [{ $arrayElemAt: ['$members.email', 0] }, '$_id.email'] },
            ],
          },
        },
      },
    ],
    { allowDiskUse: true },
  );
}

const snapshotOf = (member: Member) => ({
  sourceName: member.profile?.sourceSystem ?? member.sources?.[0]?.sourceName,
  firstName: member.profile?.firstName,
  lastName: member.profile?.lastName,
  email: member.email,
  departmentName: member.profile?.departmentName ?? member.profile?.departmentCode,
  jobTitle: member.profile?.jobTitle,
});

/** Whether a member's open conflict already names another member of the group. */
function alreadyRaised(members: Member[]): boolean {
  const ids = new Set(members.map((m) => String(m._id)));
  return members.some(
    (m) =>
      m.metadata?.requiresReview === true &&
      ids.has(String(m.metadata.conflictDetails?.incomingIdentityId ?? '')),
  );
}

/**
 * Raises the group as correlation conflicts: on the oldest member without an open conflict,
 * pointing at the oldest other member, and on each further member without one, pointing at that
 * holder, so each pair can be merged from the conflicts list. Returns the ids flagged.
 */
async function raiseConflicts(db: Db, members: Member[]): Promise<string[]> {
  const ordered = [...members].sort((a, b) => String(a._id).localeCompare(String(b._id)));
  const isFree = (m: Member) => m.metadata?.requiresReview !== true;
  const holder = ordered.find(isFree);
  if (!holder) return [];
  const others = ordered.filter((m) => m !== holder);
  const pairs: Array<[Member, Member]> = [
    [holder, others[0]],
    ...others
      .slice(1)
      .filter(isFree)
      .map((m): [Member, Member] => [m, holder]),
  ];
  for (const [flag, incoming] of pairs) {
    await db.collection(COLLECTION).updateOne(
      { _id: flag._id, 'metadata.requiresReview': { $ne: true } },
      {
        $set: {
          'metadata.correlationConflict': true,
          'metadata.requiresReview': true,
          'metadata.conflictDetails': {
            matchedBy: 'email',
            matchedValue: flag.email,
            confidence: 0,
            existingSnapshot: snapshotOf(flag),
            incomingSnapshot: snapshotOf(incoming),
            incomingIdentityId: String(incoming._id),
          },
        },
      },
    );
  }
  return pairs.map(([flag]) => String(flag._id));
}

export async function up(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return;
  const deleted = await lowerCaseDeleted(db);
  let lowered = 0;
  for await (const group of liveGroups(db)) {
    const { tenantId, email } = group._id;
    if (group.members.length === 1) {
      const [member] = group.members;
      const result = await db
        .collection(COLLECTION)
        .updateOne(
          { _id: member._id, 'profile.email': member.email },
          { $set: { 'profile.email': email } },
        );
      lowered += result.modifiedCount;
      continue;
    }
    const ids = group.members.map((m) => String(m._id)).join(', ');
    if (alreadyRaised(group.members)) continue;
    const flagged = await raiseConflicts(db, group.members);
    console.log(
      `[migration] tenant ${tenantId}: identities ${ids} have one email in different cases; ` +
        (flagged.length > 0
          ? `nothing changed, raised for a merge as correlation conflicts on ${flagged.join(', ')}`
          : 'nothing changed, and each has an open conflict already: merge them by hand'),
    );
  }
  if (deleted + lowered > 0) {
    console.log(
      `[migration] lower-cased the email of ${lowered} live and ${deleted} deleted identities`,
    );
  }
}

/**
 * Changes nothing: the case each email had is not kept, so it cannot be restored. The
 * correlation conflicts raised stay open for review; dismissing one removes it.
 */
export async function down(): Promise<void> {
  console.log(
    '[migration] identity emails stay lower-cased (the original case is not kept); the ' +
      'correlation conflicts raised stay open for review',
  );
}
