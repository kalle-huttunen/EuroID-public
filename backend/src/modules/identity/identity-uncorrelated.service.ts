import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import type { ScoredCandidate } from './correlation/candidate-suggestion.service';
import { CandidateSuggestionService } from './correlation/candidate-suggestion.service';
import { ReconciliationService } from './reconciliation.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { NOT_DELETED, DEFAULT_TENANT } from './identity.constants';
import { ensureTenantId, projectIdentityToUser } from './identity-helpers';
import {
  mergeIntoKept,
  RELEASED_EMAIL_PATTERN,
  systemsWithAccount,
  wasMergedAway,
  type MergeDeps,
} from './identity-merge';

type ConflictDetails = NonNullable<NonNullable<IdentityDocument['metadata']>['conflictDetails']>;

const SPLIT_HELD =
  'The incoming record cannot become an identity of its own: an identity already has its ' +
  'email. Nothing was changed. Merge it into this identity, or correct the email in its source.';
const INCOMING_GONE =
  'The identity of the incoming record no longer exists (merged into another identity, or ' +
  'removed), so nothing was changed. Dismiss the conflict.';
const NOTHING_TO_MERGE =
  'This conflict stores no incoming record to merge, so nothing was changed. The next sync of ' +
  'its source stores it, or dismiss the conflict.';

/** Who a conflict's Merge records as deleting the incoming identity (deletedBy, the event's actor). */
const MERGED_BY = 'merge-resolution';

/** The correlation statuses of the uncorrelated queue. */
const IN_QUEUE = { 'metadata.correlationStatus': { $in: ['uncorrelated', 'ambiguous'] } };

/**
 * An uncorrelated identity that offboarding deleted and that holds no account any more: the queue
 * keeps it, offboarded and ready to link (Link merges it as it merges a live one, keeping its
 * deletion: identity-merge.ts). One that a merge took is gone (wasMergedAway).
 */
function isOffboardedAndLinkable(identity: IdentityDocument): boolean {
  return (
    !!identity.deletedAt && !wasMergedAway(identity) && systemsWithAccount(identity).length === 0
  );
}

/** Close the identity's conflict (flags and details); saved with the identity's next save. */
function clearConflictFlags(identity: IdentityDocument): void {
  identity.metadata = identity.metadata || {};
  identity.metadata.correlationConflict = false;
  identity.metadata.requiresReview = false;
  identity.metadata.conflictDetails = undefined;
  // metadata is Mixed (type: Object): Mongoose saves a change inside it only when told so
  identity.markModified('metadata');
}

/**
 * Uncorrelated queue + conflict resolution + API response formatting.
 */
@Injectable()
export class IdentityUncorrelatedService {
  private readonly logger = this.loggerFactory.create(IdentityUncorrelatedService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly reconciliationService: ReconciliationService,
    private readonly candidateSuggestionService: CandidateSuggestionService,
    private readonly identityCorrelation: IdentityCorrelationService,
    private readonly identityOnion: IdentityOnionService,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async getCandidatesForIdentity(identityId: string): Promise<ScoredCandidate[]> {
    // An offboarded identity in the queue gets candidates too
    const identity = await this.identityOnion.findIdentityById(identityId, {
      includeDeleted: true,
    });
    if (!identity || wasMergedAway(identity)) return [];
    const status = identity.metadata?.correlationStatus;
    if (status !== 'uncorrelated' && status !== 'ambiguous') return [];
    const config = await this.identityCorrelation.getCorrelationConfig(
      identity.tenantId || DEFAULT_TENANT,
    );
    return this.candidateSuggestionService.suggestCandidates(identity, config);
  }

  /**
   * The uncorrelated queue: live uncorrelated or ambiguous identities, then those offboarding
   * deleted that hold no account (isOffboardedAndLinkable). Link refuses an identity with an
   * account, so the admin deletes it first; it stays in the queue, and Link then merges its
   * records into the right identity.
   */
  async findUncorrelatedIdentities(tenantId?: string): Promise<IdentityDocument[]> {
    const tid = tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const live = await this.identityModel
      .find({ ...NOT_DELETED, tenantId: tid, ...IN_QUEUE })
      .exec();
    return [...live, ...(await this.findOffboardedInQueue(tid))];
  }

  /** How many identities the queue lists (findUncorrelatedIdentities). */
  async countUncorrelated(tenantId?: string): Promise<number> {
    const tid = tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const live = await this.identityModel
      .countDocuments({ ...NOT_DELETED, tenantId: tid, ...IN_QUEUE })
      .exec();
    return live + (await this.findOffboardedInQueue(tid)).length;
  }

  /** The queue's deleted identities: offboarded, holding no account, not merged away. */
  private async findOffboardedInQueue(tid: string): Promise<IdentityDocument[]> {
    const deleted = await this.identityModel
      .find({
        tenantId: tid,
        deletedAt: { $ne: null },
        ...IN_QUEUE,
        // A merged-away identity keeps its status: left out here, and by wasMergedAway below
        'profile.email': { $not: RELEASED_EMAIL_PATTERN },
      })
      .exec();
    return deleted.filter(isOffboardedAndLinkable);
  }

  async linkUncorrelatedToTarget(
    uncorrelatedId: string,
    targetIdentityId: string,
    actor?: string,
  ): Promise<IdentityDocument | null> {
    // An offboarded identity in the queue is linked too; one that a merge took is gone
    const uncorrelated = await this.identityOnion.findIdentityById(uncorrelatedId, {
      includeDeleted: true,
    });
    const target = await this.identityOnion.findIdentityById(targetIdentityId);
    if (!uncorrelated || !target || wasMergedAway(uncorrelated)) return null;

    const status = uncorrelated.metadata?.correlationStatus;
    if (status !== 'uncorrelated' && status !== 'ambiguous') {
      this.logger.warn(
        `linkUncorrelatedToTarget: identity ${uncorrelatedId} is not uncorrelated (${status})`,
      );
      return null;
    }

    if (String(uncorrelated._id) === String(target._id)) {
      this.logger.warn('linkUncorrelatedToTarget: cannot link identity to itself');
      return null;
    }

    const offboarded = !!uncorrelated.deletedAt;
    const fallbackTenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    ensureTenantId(target, fallbackTenantId);
    const reconciled = await mergeIntoKept(
      await this.mergeDeps(target),
      target,
      { identity: uncorrelated },
      (kept) => {
        kept.metadata = kept.metadata || {};
        kept.metadata.correlationStatus = 'correlated';
        kept.metadata.ambiguousCandidates = undefined;
        // The target's conflict about this very record is settled by the link
        if (kept.metadata.conflictDetails?.incomingIdentityId === uncorrelatedId) {
          clearConflictFlags(kept);
        }
      },
      actor || 'uncorrelated-link',
    );

    this.eventEmitter.emit(
      DomainEventType.IDENTITY_CORRELATED,
      reconciled._id?.toString() ?? '',
      {
        correlationRule: 'manual-link',
        matchedBy: 'manual-link',
        confidence: 1,
        existingIdentityId: reconciled._id?.toString(),
        incomingIdentityId: uncorrelatedId,
      },
      { actor: actor || 'uncorrelated-link' },
    );
    // An offboarded identity was deleted by its offboarding, which reported it then
    if (!offboarded) this.reportMergedAway(uncorrelatedId, actor || 'uncorrelated-link');

    return reconciled;
  }

  /**
   * identity.deleted for the identity a merge or link soft-deleted: the access graph removes its
   * node, the audit log and the timeline record the deletion.
   */
  private reportMergedAway(identityId: string, actor: string): void {
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_DELETED,
      identityId,
      { identityId, reason: 'merged-into-target' },
      { actor },
    );
  }

  /**
   * Accept the identity as a person of its own: it leaves the queue. An offboarded one stays
   * deleted (kept separate, not linked).
   */
  async createStandalone(uncorrelatedId: string, actor?: string): Promise<IdentityDocument | null> {
    const identity = await this.identityOnion.findIdentityById(uncorrelatedId, {
      includeDeleted: true,
    });
    if (!identity || wasMergedAway(identity)) return null;
    const status = identity.metadata?.correlationStatus;
    if (status !== 'uncorrelated' && status !== 'ambiguous') return null;

    identity.metadata = identity.metadata || {};
    identity.metadata.correlationStatus = 'correlated';
    identity.metadata.ambiguousCandidates = undefined;
    // metadata is Mixed (type: Object): Mongoose saves a change inside it only when told so
    identity.markModified('metadata');
    await identity.save();

    this.eventEmitter.emit(
      DomainEventType.IDENTITY_CORRELATED,
      identity._id?.toString() ?? '',
      {
        correlationRule: 'create-standalone',
        matchedBy: 'create-standalone',
        confidence: 1,
        existingIdentityId: identity._id?.toString(),
      },
      { actor: actor || 'uncorrelated-create-standalone' },
    );
    return identity;
  }

  async findIdentitiesWithConflicts(tenantId?: string): Promise<IdentityDocument[]> {
    const tid = tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    return this.identityModel
      .find({
        ...NOT_DELETED,
        tenantId: tid,
        $or: [{ 'metadata.requiresReview': true }, { 'metadata.correlationConflict': true }],
      })
      .exec();
  }

  /**
   * Merge, split or dismiss the identity's conflict. Merge ends fully merged with the conflict
   * closed, or throws a 4xx with nothing changed (identity-merge.ts), among them while the
   * incoming identity has an account in a target: it is offboarded first, then merged. A record
   * held on the conflict (conflict-held-rows.ts) cannot be split off: no identity can take its
   * email.
   */
  async resolveConflict(
    identityId: string,
    action: 'merge' | 'split' | 'dismiss',
  ): Promise<IdentityDocument | null> {
    const identity = await this.identityOnion.findIdentityById(identityId);
    if (!identity || !identity.metadata?.requiresReview) return null;

    const conflictDetails = identity.metadata.conflictDetails;
    if (action === 'merge') return this.mergeConflict(identity, conflictDetails);
    if (action === 'split' && conflictDetails?.incomingSource) {
      throw new ConflictException(SPLIT_HELD);
    }

    clearConflictFlags(identity);
    await identity.save();
    return identity;
  }

  /** Merge the conflict's incoming record: the identity minted for it, or the record held here. */
  private async mergeConflict(
    identity: IdentityDocument,
    details: ConflictDetails | undefined,
  ): Promise<IdentityDocument> {
    const deps = await this.mergeDeps(identity);
    if (details?.incomingIdentityId) {
      // One that offboarding soft-deleted is merged: its accounts are gone (identity-merge.ts)
      const incoming = await this.identityOnion.findIdentityById(details.incomingIdentityId, {
        includeDeleted: true,
      });
      if (!incoming || wasMergedAway(incoming)) throw new ConflictException(INCOMING_GONE);
      const offboarded = !!incoming.deletedAt;
      const from = { identity: incoming };
      const kept = await mergeIntoKept(deps, identity, from, clearConflictFlags, MERGED_BY);
      // As Link: one that offboarding deleted was reported then
      if (!offboarded) this.reportMergedAway(details.incomingIdentityId, MERGED_BY);
      return kept;
    }
    if (details?.incomingSource) {
      const from = { heldSource: details.incomingSource };
      return mergeIntoKept(deps, identity, from, clearConflictFlags, MERGED_BY);
    }
    throw new ConflictException(NOTHING_TO_MERGE);
  }

  /**
   * The merge's writes, with the kept identity's tenant correlation config loaded first, strictly:
   * defaults would reconcile the merged profile without the field mastery overrides.
   */
  private async mergeDeps(kept: IdentityDocument): Promise<MergeDeps> {
    const correlationConfig = await this.identityCorrelation.getCorrelationConfig(
      kept.tenantId || DEFAULT_TENANT,
      { strict: true },
    );
    return {
      identityModel: this.identityModel,
      reconcile: (identity) =>
        this.reconciliationService.reconcile(identity, {
          fieldMasteryOverrides: correlationConfig.fieldMasteryOverrides,
        }),
      logger: this.logger,
    };
  }

  // ── API Response Formatting ──────────────────────────────────────

  async getConflicts(tenantId?: string): Promise<Array<Record<string, unknown>>> {
    const identities = await this.findIdentitiesWithConflicts(tenantId);
    return identities.map((i) => this.toConflictApiResponse(i));
  }

  async getUncorrelated(tenantId?: string): Promise<Array<Record<string, unknown>>> {
    const identities = await this.findUncorrelatedIdentities(tenantId);
    return identities.map((i) => this.toUncorrelatedApiResponse(i));
  }

  private toIdentityApiResponse(identity: IdentityDocument | null): Record<string, unknown> | null {
    if (!identity) return null;
    const doc = identity.toObject
      ? identity.toObject()
      : (identity as unknown as Record<string, unknown>);
    return doc as Record<string, unknown>;
  }

  private toConflictApiResponse(i: IdentityDocument): Record<string, unknown> {
    const { tenantId: _tenantId, ...rest } = projectIdentityToUser(i) as Record<string, unknown>;
    return rest;
  }

  /** `offboarded`: deleted by its offboarding, no account left, still linkable. */
  private toUncorrelatedApiResponse(i: IdentityDocument): Record<string, unknown> {
    const doc = i.toObject ? i.toObject() : (i as unknown as Record<string, unknown>);
    return { ...projectIdentityToUser(i), sources: doc.sources, offboarded: !!doc.deletedAt };
  }

  async linkUncorrelatedToTargetFormatted(
    uncorrelatedId: string,
    targetIdentityId: string,
    actor?: string,
  ): Promise<{ success: true; identity: Record<string, unknown> } | null> {
    const identity = await this.linkUncorrelatedToTarget(uncorrelatedId, targetIdentityId, actor);
    const doc = this.toIdentityApiResponse(identity);
    return doc ? { success: true, identity: doc } : null;
  }

  async createStandaloneFormatted(
    uncorrelatedId: string,
    actor?: string,
  ): Promise<{ success: true; identity: Record<string, unknown> } | null> {
    const identity = await this.createStandalone(uncorrelatedId, actor);
    const doc = this.toIdentityApiResponse(identity);
    return doc ? { success: true, identity: doc } : null;
  }

  async resolveConflictFormatted(
    identityId: string,
    action: 'merge' | 'split' | 'dismiss',
  ): Promise<{ success: true; identity: Record<string, unknown> } | null> {
    const identity = await this.resolveConflict(identityId, action);
    const doc = this.toIdentityApiResponse(identity);
    return doc ? { success: true, identity: doc } : null;
  }

  async findIdentityByEmailFormatted(
    email: string,
  ): Promise<{ found: boolean; identity: Record<string, unknown> | null }> {
    const identity = await this.identityOnion.findIdentityByEmail(email);
    const doc = this.toIdentityApiResponse(identity);
    return { found: !!doc, identity: doc };
  }

  async findIdentityByIdFormatted(
    id: string,
  ): Promise<{ found: boolean; identity: Record<string, unknown> | null }> {
    const identity = await this.identityOnion.findIdentityById(id);
    const doc = this.toIdentityApiResponse(identity);
    return { found: !!doc, identity: doc };
  }
}
