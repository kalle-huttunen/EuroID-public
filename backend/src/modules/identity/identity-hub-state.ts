/**
 * The part of an identity that the Golden Record sync (saveOrUpdate) writes: the profile, the
 * source records, the metadata and the soft-delete marker, plus the Entra ID provisioning entry a
 * bulk CREATE or UPDATE writes after it. A bulk rollback captures it just
 * before the write and puts it back (IdentityMutationService.restoreHubState).
 */
import type { Model, UpdateQuery } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import { getSystemType } from '@shared/utils/normalize-system-name';

export interface IdentityHubState {
  id: string;
  profile: unknown;
  sources: unknown[];
  metadata: Record<string, unknown>;
  deletedAt: Date | string | null;
  deletedBy: string | null;
  /**
   * The identity's Entra ID provisioning entries as they were: a bulk CREATE or UPDATE marks
   * Entra ID SYNCED after its write, and the rollback puts the entry back. Absent in snapshots
   * taken before HX-E4, whose rollback leaves the provisioning state as it is.
   */
  entraProvisioning?: unknown[];
}

/** Whether a provisioning entry is Entra ID's (`entra-id`, `entra`, `entraid`). */
export function isEntraEntry(entry: { targetSystem?: string }): boolean {
  return getSystemType(entry.targetSystem) === 'entra';
}

/**
 * How often a restore builds its update again when another writer changed the provisioning
 * entries between its read and its write; then it fails (the rollback activity is retried).
 */
export const HUB_RESTORE_ATTEMPTS = 5;

/** A restore's write: the update, and the filter it may apply under (see hubRestoreUpdate). */
export interface HubRestoreWrite {
  update: UpdateQuery<IdentityDocument>;
  /**
   * Added to the identity's filter: the provisioning entries must still be those the update was
   * built from (absent when the update leaves them alone).
   */
  guard?: Record<string, unknown>;
  /** False when the identity was not found in the tenant while building the update. */
  found: boolean;
}

/**
 * The update that puts a captured state back (IdentityMutationService.restoreHubState): the
 * profile, sources, metadata and soft-delete marker, with a version bump so a concurrent save()
 * of an older copy fails instead of undoing it. With `entraProvisioning` (snapshots from HX-E4
 * on) also the provisioning entries: the identity's current ones except Entra ID's, plus the
 * Entra ID ones captured (none: the entry the bulk operation added goes). That write replaces the
 * whole array, so it applies only while the array is still the one read here (`guard`): an entry
 * another writer changed meanwhile (onboarding, the mover, an access request) is never
 * overwritten; the caller builds the update again. An older snapshot leaves the provisioning
 * state as it is.
 */
export async function hubRestoreUpdate(
  identityModel: Model<IdentityDocument>,
  id: string,
  tenantId: string,
  state: IdentityHubState,
): Promise<HubRestoreWrite> {
  const set: Record<string, unknown> = {
    profile: state.profile,
    sources: state.sources,
    metadata: state.metadata,
  };
  let guard: Record<string, unknown> | undefined;
  let found = true;
  if (Array.isArray(state.entraProvisioning)) {
    const current = await identityModel
      .findOne({ _id: id, tenantId })
      .select('provisioning')
      .lean()
      .exec();
    found = !!current;
    const entries = (current?.provisioning as unknown[] | undefined) ?? null;
    const others = (entries ?? []).filter(
      (entry) => !isEntraEntry(entry as { targetSystem?: string }),
    );
    set.provisioning = [...others, ...state.entraProvisioning];
    // Compared as stored (no Mongoose casting inside $expr): the array read above, or none
    guard = {
      $expr: { $eq: [{ $ifNull: ['$provisioning', null] }, { $literal: entries }] },
    };
  }
  const update: UpdateQuery<IdentityDocument> = { $set: set, $inc: { __v: 1 } };
  if (state.deletedAt === null) update.$unset = { deletedAt: 1, deletedBy: 1 };
  else Object.assign(set, { deletedAt: state.deletedAt, deletedBy: state.deletedBy });
  return { update, guard, found };
}

/**
 * Writes a captured state back (hubRestoreUpdate) and answers whether the identity was found in
 * the tenant. The provisioning entries are written only while they are as read (the update's
 * guard); another writer changing one in between makes the update be built again, up to
 * HUB_RESTORE_ATTEMPTS times, then it throws (the rollback activity is retried).
 */
export async function restoreHubWrite(
  identityModel: Model<IdentityDocument>,
  id: string,
  tenantId: string,
  state: IdentityHubState,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const { update, guard, found } = await hubRestoreUpdate(identityModel, id, tenantId, state);
    if (!found) return false;
    const result = await identityModel
      .updateOne({ _id: id, tenantId, ...(guard ?? {}) }, update)
      .exec();
    if (result.matchedCount > 0 || !guard) return result.matchedCount > 0;
    if (attempt >= HUB_RESTORE_ATTEMPTS) {
      throw new Error(
        `Golden Record ${id} not restored: its provisioning entries changed on each of ` +
          `${HUB_RESTORE_ATTEMPTS} attempts`,
      );
    }
  }
}

/**
 * Called by saveOrUpdate once it knows which identity it will write, before the first write:
 * with that identity's current state, or null when it is about to create a new identity.
 */
export type HubBeforeWrite = (before: IdentityHubState | null) => Promise<void>;

/**
 * A detached JSON copy (as the snapshot store keeps it): later changes to the document do not
 * reach it. Dates and ObjectIds become strings; Mongoose casts them back on restore.
 */
export function hubStateOf(identity: IdentityDocument): IdentityHubState {
  const plain = identity.toObject() as unknown as Record<string, unknown>;
  const state = {
    id: String(identity._id),
    profile: plain.profile,
    sources: (plain.sources as unknown[] | undefined) ?? [],
    metadata: (plain.metadata as Record<string, unknown> | undefined) ?? {},
    deletedAt: (plain.deletedAt as Date | undefined) ?? null,
    deletedBy: (plain.deletedBy as string | undefined) ?? null,
    entraProvisioning: (
      (plain.provisioning as Array<{ targetSystem?: string }> | undefined) ?? []
    ).filter(isEntraEntry),
  };
  return JSON.parse(JSON.stringify(state)) as IdentityHubState;
}

/**
 * The conflict flags a low-confidence correlation match sets on the existing identity it matched
 * (metadata.correlationConflict, requiresReview, conflictDetails), as they were before. A bulk
 * rollback that removes the identity minted for the incoming record puts them back
 * (IdentityMutationService.restoreConflictFlags). Undefined = the field was not set.
 */
export interface ConflictFlagsState {
  id: string;
  correlationConflict?: boolean;
  requiresReview?: boolean;
  conflictDetails?: unknown;
}

/** The metadata fields of ConflictFlagsState. */
export const CONFLICT_FLAG_FIELDS = [
  'correlationConflict',
  'requiresReview',
  'conflictDetails',
] as const;

/**
 * Called by saveOrUpdate just before a low-confidence match flags another identity, with that
 * identity's conflict flags as they are.
 */
export type HubBeforeConflictFlag = (before: ConflictFlagsState) => Promise<void>;

/** A detached JSON copy of the identity's conflict flags (see hubStateOf). */
export function conflictFlagsOf(identity: IdentityDocument): ConflictFlagsState {
  const metadata = (identity.toObject().metadata ?? {}) as Record<string, unknown>;
  const state: ConflictFlagsState = { id: String(identity._id) };
  for (const field of CONFLICT_FLAG_FIELDS) {
    if (metadata[field] !== undefined) {
      (state as unknown as Record<string, unknown>)[field] = metadata[field];
    }
  }
  return JSON.parse(JSON.stringify(state)) as ConflictFlagsState;
}
