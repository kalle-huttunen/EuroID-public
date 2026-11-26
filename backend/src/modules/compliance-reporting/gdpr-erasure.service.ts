/**
 * GDPR Erasure Service (Article 17 — Right to Erasure)
 *
 * Cascading hard-delete of one identity: its own documents here, the other collections that refer
 * to it (gdpr-erasure-scope.ts: deleted, or redacted where the record stays), then the access
 * graph and the Elasticsearch audit index (gdpr-erasure-external-stores.ts). Returns an
 * attestation documenting what was erased, by whom, and when, and which store it could not reach.
 * The person's linked admin identities (`parentIdentityId`) are erased in the same run, first and
 * with the same scope, each with its own erasure entry and listed in the attestation.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import type { UserEventDocument } from '../identity/schemas/user-event.schema';
import type { AuditEventDocument } from '../audit/schemas/audit-event.schema';
import type { ReviewItemDocument } from '../access-review/schemas/review-item.schema';
import type { ReviewExclusionDocument } from '../policy/schemas/review-exclusion.schema';
import type { OutboxEventDocument } from '@infrastructure/events/schemas/outbox-event.schema';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { ERASURE_TARGETS, scopeModel, type ErasureTarget } from './gdpr-erasure-scope';
import { GdprExternalStores } from './gdpr-erasure-external-stores';
import { NhiOwnershipService } from '../nhi/nhi-ownership.service';

export interface ErasureAttestation {
  erasedAt: string;
  erasedBy: string;
  identityId: string;
  collectionsAffected: string[];
  documentCounts: Record<string, number>;
  dryRun: boolean;
  /**
   * Stores the erasure could not reach (`access_graph`, `elasticsearch_audit_events`): they may
   * still hold the person. Empty when every store was reached.
   */
  notReached: string[];
  /**
   * The person's linked admin identities, erased with them (counted, on a dry run): each with
   * its tier and its own counts and unreached stores. Their unreached stores are in `notReached`
   * too. Empty when the person has none.
   */
  linkedAdminIdentities: LinkedAdminErasure[];
}

/** One linked admin identity in the person's attestation. */
export interface LinkedAdminErasure {
  identityId: string;
  adminTier?: string;
  collectionsAffected: string[];
  documentCounts: Record<string, number>;
  notReached: string[];
}

/** One identity's part of an erasure: what eraseOne counted (and deleted) and could not reach. */
type ErasedIdentity = Omit<LinkedAdminErasure, 'identityId' | 'adminTier'>;

/** Audit entries the erasure deletes: the identity's, except the erasure entries themselves. */
const erasableAuditEvents = (identityId: string) => ({
  resourceId: identityId,
  action: { $ne: 'GDPR_ERASURE_EXECUTED' },
});

/**
 * What the erasure entry records about the audit entries it removes: the chain positions of
 * chained entries and the hashes of older entries written without one.
 */
const removedChainEntries = (removed: Array<{ seq?: number; integrityHash?: string }>) => ({
  removedSeqs: removed
    .flatMap((e) => (typeof e.seq === 'number' ? [e.seq] : []))
    .sort((a, b) => a - b),
  removedLegacyHashes: removed.flatMap((e) =>
    typeof e.seq !== 'number' && e.integrityHash ? [e.integrityHash] : [],
  ),
});

/** Outbox events the erasure deletes: published ones; pending and failed ones stay. */
const erasableOutboxEvents = (identityId: string) => ({
  aggregateId: identityId,
  status: 'published',
});

@Injectable()
export class GdprErasureService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel('UserEvent') private readonly userEventModel: Model<UserEventDocument>,
    @InjectModel('AuditEvent') private readonly auditEventModel: Model<AuditEventDocument>,
    @InjectModel('ReviewItem') private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel('ReviewExclusion')
    private readonly reviewExclusionModel: Model<ReviewExclusionDocument>,
    @InjectModel('OutboxEvent') private readonly outboxEventModel: Model<OutboxEventDocument>,
    private readonly auditService: AuditService,
    @InjectConnection() private readonly connection: Connection,
    private readonly externalStores: GdprExternalStores,
    private readonly nhiOwnership: NhiOwnershipService,
  ) {}

  /** The target's model: the one its module registered, or compiled here from its schema. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the targets are different models
  private modelOf(target: ErasureTarget): Model<any> {
    return scopeModel(this.connection, target);
  }

  /** The person's documents in each collection of gdpr-erasure-scope.ts. */
  private async countTargets(tenantId: string, identityId: string) {
    const counts = await Promise.all(
      ERASURE_TARGETS.map((t) =>
        this.modelOf(t).countDocuments(t.filter(tenantId, identityId)).exec(),
      ),
    );
    return Object.fromEntries(ERASURE_TARGETS.map((t, i) => [t.collection, counts[i]]));
  }

  /** Deletes the person's documents, or takes the person out of the ones that stay. */
  private async eraseTargets(tenantId: string, identityId: string): Promise<void> {
    await Promise.all(
      ERASURE_TARGETS.map((t) => {
        const filter = t.filter(tenantId, identityId);
        if (!t.redact) return this.modelOf(t).deleteMany(filter).exec();
        const update = t.redact(identityId);
        return this.modelOf(t)
          .updateMany(filter, update, { updatePipeline: Array.isArray(update) })
          .exec();
      }),
    );
  }

  /**
   * Count documents that would be deleted across all collections for the given identity, with
   * the filters the delete uses: the kept GDPR_ERASURE_EXECUTED entries and the outbox events
   * not yet published are not counted. Used by both dry-run and real erasure for the attestation.
   */
  private async countAffectedDocuments(identityId: string): Promise<Record<string, number>> {
    const [identities, userEvents, auditEvents, reviewItems, reviewExclusions, outboxEvents] =
      await Promise.all([
        this.identityModel.countDocuments({ _id: identityId }).exec(),
        this.userEventModel.countDocuments({ userId: identityId }).exec(),
        this.auditEventModel.countDocuments(erasableAuditEvents(identityId)).exec(),
        this.reviewItemModel.countDocuments({ identityId }).exec(),
        this.reviewExclusionModel.countDocuments({ identityId }).exec(),
        this.outboxEventModel.countDocuments(erasableOutboxEvents(identityId)).exec(),
      ]);

    return {
      identities,
      user_events: userEvents,
      audit_events: auditEvents,
      review_items: reviewItems,
      review_exclusions: reviewExclusions,
      outbox_events: outboxEvents,
    };
  }

  /**
   * Erase all data for a single identity across all collections, its linked admin identities
   * first (an admin identity left behind would keep the person's name and admin UPN). Each
   * identity gets a GDPR_ERASURE_EXECUTED audit entry before its deletion, so the erasure itself
   * is permanently logged. Accounts in connected systems are left as they are, the person's and
   * the admin identities' alike: offboarding (which offboards the linked admin accounts first)
   * removes them.
   *
   * @param dryRun When true, returns what would be deleted without actually deleting.
   */
  async eraseIdentity(
    identityId: string,
    requestedBy: string,
    dryRun = false,
  ): Promise<ErasureAttestation> {
    const identity = await this.identityModel.findById(identityId).lean().exec();
    if (!identity) {
      throw new NotFoundException(`Identity ${identityId} not found`);
    }

    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? identity.tenantId ?? 'unknown';
    const admins = (await this.identityModel
      .find({ parentIdentityId: identityId })
      .select('_id adminTier')
      .lean()
      .exec()) as Array<{ _id: unknown; adminTier?: string }>;

    const linkedAdminIdentities: LinkedAdminErasure[] = [];
    for (const admin of admins) {
      const adminId = String(admin._id);
      const erased = await this.eraseOne(adminId, tenantId, requestedBy, dryRun, {
        parentIdentityId: identityId,
      });
      linkedAdminIdentities.push({
        identityId: adminId,
        ...(admin.adminTier ? { adminTier: admin.adminTier } : {}),
        ...erased,
      });
    }
    const own = await this.eraseOne(identityId, tenantId, requestedBy, dryRun, {
      ...(admins.length
        ? { linkedAdminIdentityIds: linkedAdminIdentities.map((a) => a.identityId) }
        : {}),
    });

    return {
      erasedAt: new Date().toISOString(),
      erasedBy: requestedBy,
      identityId,
      collectionsAffected: own.collectionsAffected,
      documentCounts: own.documentCounts,
      dryRun,
      notReached: [
        ...new Set([...own.notReached, ...linkedAdminIdentities.flatMap((a) => a.notReached)]),
      ],
      linkedAdminIdentities,
    };
  }

  /**
   * One identity's erasure: counts, its GDPR_ERASURE_EXECUTED entry (with `link`: the parent of
   * an admin identity, or the person's admin identities), then the deletes and the stores outside
   * MongoDB. Writes nothing but the entry on a dry run.
   */
  private async eraseOne(
    identityId: string,
    tenantId: string,
    requestedBy: string,
    dryRun: boolean,
    link: { parentIdentityId?: string; linkedAdminIdentityIds?: string[] },
  ): Promise<ErasedIdentity> {
    const external = await this.externalStores.count(tenantId, identityId);
    const counts = {
      ...(await this.countAffectedDocuments(identityId)),
      ...(await this.countTargets(tenantId, identityId)),
      ...external.counts,
    };
    // The audit entries the erasure removes, read before its own entry so that the entry records
    // their chain positions (and the hashes of older entries without one): the chain check then
    // reports the gap they leave as this erasure, not as tampering. Exactly these are deleted.
    const removed = dryRun
      ? []
      : await this.auditEventModel
          .find(erasableAuditEvents(identityId))
          .select('_id seq integrityHash')
          .lean()
          .exec();
    if (!dryRun) counts.audit_events = removed.length;
    const collectionsAffected = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name]) => name);

    // Emit the erasure audit event BEFORE deletion so the audit trail survives
    await this.auditService.log({
      action: 'GDPR_ERASURE_EXECUTED',
      severity: 'critical',
      actor: requestedBy,
      resourceType: 'identity',
      resourceId: identityId,
      resourceName: identityId,
      description: dryRun
        ? `GDPR erasure dry-run for identity ${identityId}`
        : `GDPR erasure executed for identity ${identityId} — ${collectionsAffected.length} collections, ${Object.values(counts).reduce((a, b) => a + b, 0)} documents`,
      payload: {
        metadata: {
          dryRun,
          collectionsAffected,
          documentCounts: counts,
          notReached: external.notReached,
          ...link,
          ...(dryRun ? {} : removedChainEntries(removed)),
        },
      },
      tenantId,
    });

    if (!dryRun) {
      // The owner's agents not marked yet (and not revoked) become ownerless `erased` one by one,
      // each with the AGENT_IDENTITY_OWNERLESS audit entry and the nhi.owner_lost event the
      // offboarding path writes (ids only, no personal data of the owner); the scope's redaction
      // below then takes the owner email out of every agent of the owner
      await this.nhiOwnership.markOwnerless(tenantId, identityId, 'erased');
      // Delete in parallel across all collections. The audit entries are the ones read above, so
      // the erasure entry just written (and earlier erasure entries) stay.
      await Promise.all([
        this.identityModel.deleteOne({ _id: identityId }).exec(),
        this.userEventModel.deleteMany({ userId: identityId }).exec(),
        this.auditEventModel.deleteMany({ _id: { $in: removed.map((e) => e._id) } }).exec(),
        this.reviewItemModel.deleteMany({ identityId }).exec(),
        // Access review exclusions of the subject (active and lifted): the reviewer and the
        // justification with them
        this.reviewExclusionModel.deleteMany({ identityId }).exec(),
        this.outboxEventModel.deleteMany(erasableOutboxEvents(identityId)).exec(),
        this.eraseTargets(tenantId, identityId),
      ]);
    }
    // The graph and the index after MongoDB: an event in flight that writes them again finds no
    // identity (and no email) to write. Their counts are then what was deleted.
    const erased = dryRun ? external : await this.externalStores.erase(tenantId, identityId);
    const reached = Object.entries(erased.counts).filter(([s]) => !erased.notReached.includes(s));

    return {
      collectionsAffected,
      documentCounts: { ...counts, ...Object.fromEntries(reached) },
      notReached: erased.notReached,
    };
  }
}
