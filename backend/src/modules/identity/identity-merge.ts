/**
 * Merging into the identity that is kept: Merge on a correlation conflict and Link in the
 * uncorrelated queue (IdentityUncorrelatedService). What is merged is another identity, or a
 * record held on the kept identity's conflict (conflict-held-rows.ts).
 *
 * MongoDB runs without a replica set, so there is no transaction. A merge ends fully merged, or
 * with nothing changed and a 4xx that says why:
 * 1. Checks without a write: the incoming identity has no account in a target
 *    (assertHoldsNoAccount: nothing would own it, and the merge neither removes nor moves
 *    accounts), the source limit, and that no other identity took a held record.
 * 2. The incoming identity is soft-deleted (one that offboarding deleted keeps its deletion) and
 *    releases its email (releasedEmail), so no correlation by email finds it. The merge may give
 *    the kept identity that email: reconciliation decides (the email's master, else the primary
 *    HR source's email; a secondary HR source's only when the primary has none), so the kept
 *    identity's email survives only when the rules say so.
 * 3. The kept identity takes the sources (not the incoming identity's links to the accounts
 *    EuroID provisioned for it, which are gone), the caller's metadata changes and the reconciled
 *    profile in one save (ReconciliationService.reconcile): it is never half-merged.
 * When step 3 fails (another identity has the merged email, or the kept identity changed
 * meanwhile), step 2 is undone.
 */
import { ConflictException, HttpException } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { IdentityDocument, LinkedAccount } from './schemas/identity.schema';
import { NOT_DELETED } from './identity.constants';
import { deduplicateAndValidateSources } from './identity-helpers';
import { hasProvisionedAccount, targetAccountId } from './identity-provisioning.service';
import { offboardingTargetKind } from '../../workflows/offboarding-targets';
import { maskEmails } from '../../activities/deprovision-failure';

export interface MergeDeps {
  identityModel: Model<IdentityDocument>;
  /** ReconciliationService.reconcile with the tenant's options: computes the profile and saves. */
  reconcile: (kept: IdentityDocument) => Promise<IdentityDocument>;
  logger: { error: (message: string) => void };
}

/** What is merged into the kept identity. */
export type MergeIncoming = { identity: IdentityDocument } | { heldSource: LinkedAccount };

const CHANGED_MEANWHILE =
  'An identity of this merge changed while merging, so nothing was changed. Reload and try again.';

/** The email a merged-away identity keeps: its own, never deliverable (RFC 2606 `.invalid`). */
export function releasedEmail(identityId: string): string {
  return `merged-${identityId}@released.invalid`;
}

/** Matches every releasedEmail, for a query that leaves merged-away identities out. */
export const RELEASED_EMAIL_PATTERN = /^merged-[0-9a-f]+@released\.invalid$/;

/** Whether a merge took this identity: soft-deleted with its email released. */
export function wasMergedAway(identity: Pick<IdentityDocument, '_id' | 'deletedAt' | 'profile'>) {
  return !!identity.deletedAt && identity.profile?.email === releasedEmail(String(identity._id));
}

/**
 * The target systems the identity has an account in, by the rule the mover uses
 * (hasProvisionedAccount: provisioned, not deprovisioned since), without the targets that keep
 * no account (offboarding reports them not applicable and leaves their entries SYNCED).
 */
export function systemsWithAccount(identity: IdentityDocument): string[] {
  const systems = (identity.provisioning ?? [])
    .filter((p) => offboardingTargetKind(p.targetSystem) !== 'not-applicable')
    .filter((p) => hasProvisionedAccount(p, targetAccountId(identity.sources, p.targetSystem)))
    .map((p) => p.targetSystem);
  return [...new Set(systems)];
}

/** A merge would leave the incoming identity's accounts to a deleted identity: refused. */
function assertHoldsNoAccount(incoming: IdentityDocument): void {
  const systems = systemsWithAccount(incoming);
  if (systems.length === 0) return;
  throw new ConflictException(
    `Identity ${String(incoming._id)} still has an account in ${systems.join(', ')}, so nothing ` +
      'was changed. Delete that identity first (its offboarding removes the accounts), then ' +
      'merge again.',
  );
}

/**
 * The incoming identity's sources the kept identity takes: all but its links to the accounts
 * EuroID provisioned for it (a target source holding a provisioning entry's account id). Those
 * accounts are gone (assertHoldsNoAccount); a link would give the kept identity a removed account,
 * and its data, such as an email the target owns, would overwrite the kept identity's.
 */
function sourcesToTake(incoming: IdentityDocument): LinkedAccount[] {
  const sources = incoming.sources ?? [];
  const accountIds = new Set(
    (incoming.provisioning ?? []).map((p) => targetAccountId(sources, p.targetSystem)),
  );
  return sources.filter((s) => s.sourceRole !== 'target' || !accountIds.has(s.externalId));
}

/**
 * Merge `incoming` into `kept`. `prepareKept` applies the caller's metadata changes (closing the
 * conflict, the correlation status); they are saved with the merge. `deletedBy` marks the
 * incoming identity.
 */
export async function mergeIntoKept(
  deps: MergeDeps,
  kept: IdentityDocument,
  incoming: MergeIncoming,
  prepareKept: (kept: IdentityDocument) => void,
  deletedBy: string,
): Promise<IdentityDocument> {
  if ('identity' in incoming) assertHoldsNoAccount(incoming.identity);
  const added = 'identity' in incoming ? sourcesToTake(incoming.identity) : [incoming.heldSource];
  const sources = deduplicateAndValidateSources([...(kept.sources ?? []), ...added.map(plain)]);
  if ('heldSource' in incoming) await assertNotTakenElsewhere(deps, kept, incoming.heldSource);

  const released =
    'identity' in incoming ? await release(deps, incoming.identity, deletedBy) : undefined;
  try {
    kept.sources = sources;
    prepareKept(kept);
    kept.markModified('metadata'); // a Mixed path: changes inside it are saved only when told so
    return await deps.reconcile(kept);
  } catch (err: unknown) {
    if (released) await restore(deps, released);
    throw toMergeError(err);
  }
}

/** A source as plain data: the spread of a Mongoose subdocument holds only its internals. */
function plain(source: LinkedAccount): LinkedAccount {
  const doc = source as unknown as { toObject?: () => LinkedAccount };
  return typeof doc.toObject === 'function' ? doc.toObject() : { ...source };
}

/** A held record that a later sync ingested into another identity is not merged a second time. */
async function assertNotTakenElsewhere(
  deps: MergeDeps,
  kept: IdentityDocument,
  held: LinkedAccount,
): Promise<void> {
  const holder = await deps.identityModel
    .findOne({
      tenantId: kept.tenantId,
      ...NOT_DELETED,
      _id: { $ne: kept._id },
      sources: { $elemMatch: { sourceName: held.sourceName, externalId: held.externalId } },
    })
    .select('_id')
    .lean()
    .exec();
  if (holder) {
    throw new ConflictException(
      `The incoming record now belongs to identity ${String(holder._id)}, so nothing was ` +
        'changed. Dismiss this conflict.',
    );
  }
}

interface Released {
  id: string;
  tenantId: string;
  email: string;
  /** Set when offboarding had soft-deleted it: the merge keeps that deletion. */
  deletedAt?: Date;
  deletedBy?: string;
}

/**
 * Soft-delete the incoming identity (one offboarding deleted stays as it is) and release its
 * email, unless it changed since it was read.
 */
async function release(
  deps: MergeDeps,
  incoming: IdentityDocument,
  deletedBy: string,
): Promise<Released> {
  const prior: Released = {
    id: String(incoming._id),
    tenantId: incoming.tenantId,
    email: incoming.profile.email,
    ...(incoming.deletedAt ? { deletedAt: incoming.deletedAt } : {}),
    deletedBy: incoming.deletedBy,
  };
  const email = { 'profile.email': releasedEmail(prior.id) };
  const result = await deps.identityModel
    .updateOne(
      {
        _id: incoming._id,
        tenantId: prior.tenantId,
        ...(prior.deletedAt ? { deletedAt: prior.deletedAt } : NOT_DELETED),
        ...(incoming.__v !== undefined ? { __v: incoming.__v } : {}),
      },
      {
        $set: prior.deletedAt ? email : { deletedAt: new Date(), deletedBy, ...email },
        $inc: { __v: 1 },
      },
    )
    .exec();
  if (result.matchedCount === 0) throw new ConflictException(CHANGED_MEANWHILE);
  return prior;
}

/** Put the incoming identity back as it was. A failure is logged: there is nothing left to undo. */
async function restore(deps: MergeDeps, prior: Released): Promise<void> {
  const set: Record<string, unknown> = { 'profile.email': prior.email };
  const unset: Record<string, 1> = {};
  if (!prior.deletedAt) {
    unset.deletedAt = 1;
    if (prior.deletedBy) set.deletedBy = prior.deletedBy;
    else unset.deletedBy = 1;
  }
  const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set };
  try {
    await deps.identityModel
      .updateOne({ _id: prior.id, tenantId: prior.tenantId }, { ...update, $inc: { __v: 1 } })
      .exec();
  } catch (err: unknown) {
    const message = maskEmails(err instanceof Error ? err.message : String(err));
    deps.logger.error(
      `Merge failed and identity ${prior.id} could not be put back: it stays soft-deleted ` +
        `with its email released (${message})`,
    );
  }
}

/** A failed merge as an answer the caller can act on. */
function toMergeError(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  const failure = err as { code?: unknown; name?: unknown; keyPattern?: Record<string, unknown> };
  if (failure?.code === 11000) {
    const field =
      Object.keys(failure.keyPattern ?? {})
        .find((key) => key !== 'tenantId')
        ?.replace(/^profile\./, '') ?? 'unique field';
    return new ConflictException(
      `The merge would give the kept identity a value another identity already has (${field}), ` +
        `so nothing was changed. Correct the ${field} in the source record and try again.`,
    );
  }
  if (failure?.name === 'VersionError') return new ConflictException(CHANGED_MEANWHILE);
  return err;
}
