/**
 * Migration: one SCIM group per tenant and display name.
 *
 * POST /scim/v2/Groups checked for a group with the name and then inserted one, on a non-unique
 * `{ tenantId, system, name }` index, so an IdP retrying a create (or two at once) made duplicate
 * groups (r2-02 N6). entitlement_catalog now has a unique partial index on `{ tenantId, name }`
 * for `system: 'scim-inbound', type: 'Group'` rows (entitlement-catalog.schema.ts), and a create
 * that loses the race answers 409 uniqueness.
 *
 * A unique index cannot be built over duplicates, so this migration first merges each tenant's
 * groups of one name into the oldest (createdAt, then _id): its members get the others' members
 * (each once, with their member types), its externalId stays or, without one, is the first
 * other's; access requests naming another of them (`entitlements.catalogEntryId`) and SCIM groups
 * holding another as a member are moved to the oldest; then the others are deleted. Then it
 * builds the index. Rerunning it is safe.
 */
import { Db, ObjectId } from 'mongodb';

const CATALOG = 'entitlement_catalog';
const REQUESTS = 'access_requests';
/** Must match the index in entitlement-catalog.schema.ts. */
const SCIM_GROUP_INDEX = 'scim_group_name_unique';
const SCIM_GROUP = { system: 'scim-inbound', type: 'Group' };

interface MemberType {
  value: string;
  type: string;
}
interface ScimGroupRow {
  _id: ObjectId;
  tenantId?: string;
  name: string;
  createdAt?: Date;
  metadata?: { scimMembers?: string[]; scimMemberTypes?: MemberType[]; externalId?: string };
}

async function hasCollection(db: Db, name: string): Promise<boolean> {
  return db.listCollections({ name }, { nameOnly: true }).hasNext();
}

/** The oldest group of a duplicate set first. */
function byAge(a: ScimGroupRow, b: ScimGroupRow): number {
  const at = a.createdAt?.getTime() ?? 0;
  const bt = b.createdAt?.getTime() ?? 0;
  return at !== bt ? at - bt : String(a._id).localeCompare(String(b._id));
}

/** The oldest group with every member and member type of the set, each once. */
function mergedMetadata(groups: ScimGroupRow[]): ScimGroupRow['metadata'] {
  const [keep, ...others] = groups;
  const members: string[] = [];
  const types: MemberType[] = [];
  for (const g of groups) {
    for (const m of g.metadata?.scimMembers ?? []) if (!members.includes(m)) members.push(m);
    for (const t of g.metadata?.scimMemberTypes ?? []) {
      if (!types.some((k) => k.value === t.value)) types.push(t);
    }
  }
  const externalId =
    keep.metadata?.externalId ?? others.find((g) => g.metadata?.externalId)?.metadata?.externalId;
  return {
    ...(keep.metadata ?? {}),
    scimMembers: members,
    scimMemberTypes: types,
    ...(externalId ? { externalId } : {}),
  };
}

/** Points what names the merged groups (access requests, nested memberships) at the kept one. */
async function moveReferences(db: Db, tenantId: string | undefined, from: string[], to: string) {
  if (await hasCollection(db, REQUESTS)) {
    await db
      .collection(REQUESTS)
      .updateMany(
        { tenantId, 'entitlements.catalogEntryId': { $in: from } },
        { $set: { 'entitlements.$[e].catalogEntryId': to } },
        { arrayFilters: [{ 'e.catalogEntryId': { $in: from } }] },
      );
  }
  const holders = db
    .collection<ScimGroupRow>(CATALOG)
    .find({ tenantId, ...SCIM_GROUP, 'metadata.scimMembers': { $in: from } });
  for await (const holder of holders) {
    const swap = (id: string) => (from.includes(id) ? to : id);
    const members = [...new Set((holder.metadata?.scimMembers ?? []).map(swap))];
    const types: MemberType[] = [];
    for (const t of holder.metadata?.scimMemberTypes ?? []) {
      const moved = { ...t, value: swap(t.value) };
      if (!types.some((k) => k.value === moved.value)) types.push(moved);
    }
    await db
      .collection(CATALOG)
      .updateOne(
        { _id: holder._id },
        { $set: { 'metadata.scimMembers': members, 'metadata.scimMemberTypes': types } },
      );
  }
}

/** Merges each tenant's SCIM groups of one name into the oldest; returns how many were removed. */
async function mergeDuplicates(db: Db): Promise<number> {
  const catalog = db.collection<ScimGroupRow>(CATALOG);
  const sets = catalog.aggregate<{ ids: ObjectId[] }>(
    [
      { $match: SCIM_GROUP },
      { $group: { _id: { tenantId: '$tenantId', name: '$name' }, ids: { $push: '$_id' } } },
      { $match: { 'ids.1': { $exists: true } } },
    ],
    { allowDiskUse: true },
  );
  let removed = 0;
  for await (const set of sets) {
    const groups = (await catalog.find({ _id: { $in: set.ids } }).toArray()).sort(byAge);
    const [keep, ...others] = groups;
    const otherIds = others.map((g) => String(g._id));
    await catalog.updateOne({ _id: keep._id }, { $set: { metadata: mergedMetadata(groups) } });
    await moveReferences(db, keep.tenantId, otherIds, String(keep._id));
    const result = await catalog.deleteMany({ _id: { $in: others.map((g) => g._id) } });
    removed += result.deletedCount;
    console.log(
      `[migration] tenant ${keep.tenantId}: SCIM group ${String(keep._id)} kept, ` +
        `${otherIds.join(', ')} merged into it`,
    );
  }
  return removed;
}

export async function up(db: Db): Promise<void> {
  if (!(await hasCollection(db, CATALOG))) return;
  const catalog = db.collection(CATALOG);
  if ((await catalog.indexes()).some((i) => i.name === SCIM_GROUP_INDEX)) return;
  const removed = await mergeDuplicates(db);
  if (removed > 0) console.log(`[migration] merged ${removed} duplicate SCIM groups`);
  await catalog.createIndex(
    { tenantId: 1, name: 1 },
    { name: SCIM_GROUP_INDEX, unique: true, partialFilterExpression: SCIM_GROUP },
  );
}

/** Drops the unique index. The merged groups are not split again and keep the merged members. */
export async function down(db: Db): Promise<void> {
  if (!(await hasCollection(db, CATALOG))) return;
  const catalog = db.collection(CATALOG);
  if ((await catalog.indexes()).some((i) => i.name === SCIM_GROUP_INDEX)) {
    await catalog.dropIndex(SCIM_GROUP_INDEX);
  }
}
