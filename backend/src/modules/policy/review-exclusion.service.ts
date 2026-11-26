/**
 * Access review exclusions: a revoke in an access review kept as a durable, audited exception.
 *
 * - record (campaign close, through ReviewExclusionRecorder): one active exclusion per identity,
 *   system and entitlement (an account item: the whole system), holding the campaign, the
 *   reviewer, the justification and the time. A retried close or a second campaign revoking the
 *   same access keeps the first. Audited through access_review.exclusion_created, with the
 *   reviewer as actor (an expired item the campaign auto-revoked: the system).
 * - activeForProfile: what PolicyEngineService leaves out of every intent of the identity
 *   (onboarding, mover, re-evaluation, preview, SoD), see review-exclusion-match.ts.
 * - listActive (Access tab, viewer) and lift (policy-admin, through ReviewExclusionLiftService,
 *   which then starts the identity's re-evaluation): a lifted exclusion stops suppressing, so the
 *   next evaluation grants the access again. Audited through access_review.exclusion_lifted with
 *   the admin as actor.
 * - endForOffboarding: an offboarded identity's exclusions end (lifted by the system, reason
 *   "identity offboarded"); they judged that employment, and a rehire is evaluated afresh.
 * - accountExcludedSystems: the systems onboarding leaves out for the identity.
 * - countsByPolicy: per granting policy, how many of its grants reviewers revoked (active and
 *   lifted), so a policy reviewers keep revoking is visible for redesign.
 * Events carry ids only: no reviewer, no justification, no entitlement name. Tenant from the
 * request (or activity) context.
 */
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { systemKey } from '@shared/utils/normalize-system-name';
import {
  ReviewExclusion,
  ReviewExclusionDocument,
  type ReviewExclusionPolicy,
} from './schemas/review-exclusion.schema';
import { exclusionKey, type ReviewExclusionMatch } from './review-exclusion-match';

/** A revoke to keep as an exclusion (ReviewExclusionRecorder builds it from the review item). */
export interface NewReviewExclusion {
  identityId: string;
  targetSystem: string;
  scope: ReviewExclusion['scope'];
  entitlementType: string;
  entitlementName: string;
  entitlementId?: string;
  campaignId: string;
  campaignName: string;
  itemId: string;
  decision: ReviewExclusion['decision'];
  reviewer?: string;
  justification?: string;
  decidedAt?: Date;
  grantingPolicies: ReviewExclusionPolicy[];
}

/** An exclusion as the API returns it. */
export interface ReviewExclusionView extends Omit<
  ReviewExclusion,
  'tenantId' | 'systemKey' | 'entitlementKey'
> {
  _id: string;
}

/** GET /policy/review-exclusions/counts: one row per policy with at least one exclusion. */
export interface PolicyReviewExclusionCount {
  policyId: string;
  policyName: string;
  active: number;
  lifted: number;
}

/** access_review.exclusion_created (access-event-schemas.ts). */
export interface ReviewExclusionCreatedPayload {
  exclusionId: string;
  identityId: string;
  targetSystem: string;
  scope: ReviewExclusion['scope'];
  entitlementType: string;
  entitlementId?: string;
  campaignId: string;
  itemId: string;
  decision: ReviewExclusion['decision'];
  grantingPolicyIds: string[];
}

/** access_review.exclusion_lifted (access-event-schemas.ts). */
export interface ReviewExclusionLiftedPayload {
  exclusionId: string;
  identityId: string;
  targetSystem: string;
  scope: ReviewExclusion['scope'];
  campaignId: string;
  /** Set when the system lifted it (OFFBOARDED_REASON); an admin's lift has none. */
  reason?: string;
}

/** Why the system lifts an identity's exclusions when its offboarding completes. */
export const OFFBOARDED_REASON = 'identity offboarded';

type LeanExclusion = ReviewExclusion & { _id: unknown; __v?: number };

function toView(doc: LeanExclusion): ReviewExclusionView {
  const { _id, tenantId: _t, systemKey: _s, entitlementKey: _k, __v: _v, ...rest } = doc;
  return { ...rest, _id: String(_id) };
}

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

@Injectable()
export class ReviewExclusionService {
  private readonly logger = new Logger(ReviewExclusionService.name);

  constructor(
    @InjectModel(ReviewExclusion.name)
    private readonly model: Model<ReviewExclusionDocument>,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Active exclusions of the profile's identity in the tenant: by its `_id`, else (a policy
   * profile built without it, as the mover and the access preview build it) by its email.
   * `liftedSince` (the "before" side of a mover run or the access preview: the access baseline's
   * time): also the exclusions lifted after it, whose access the review took away and no run has
   * given back since, so the run's delta adds it again.
   */
  async activeForProfile(
    user: { _id?: unknown; email?: string },
    tenantId: string,
    liftedSince?: Date,
  ): Promise<ReviewExclusionMatch[]> {
    const identityId = await this.identityIdOf(user);
    if (!identityId) return [];
    const status = liftedSince
      ? { $or: [{ status: 'active' }, { status: 'lifted', liftedAt: { $gt: liftedSince } }] }
      : { status: 'active' };
    const docs = await this.model
      .find({ tenantId, identityId, ...status })
      .lean<LeanExclusion[]>()
      .exec();
    return docs.map((d) => ({
      id: String(d._id),
      campaignId: d.campaignId,
      systemKey: d.systemKey,
      scope: d.scope,
      entitlementType: d.entitlementType,
      entitlementName: d.entitlementName,
      ...(d.entitlementId ? { entitlementId: d.entitlementId } : {}),
    }));
  }

  /** Keep a revoke as an active exclusion. False when one is already active for that access. */
  async record(input: NewReviewExclusion, tenantId: string): Promise<boolean> {
    const key = {
      tenantId,
      identityId: input.identityId,
      systemKey: systemKey(input.targetSystem),
      entitlementKey: exclusionKey(input),
      status: 'active' as const,
    };
    const { identityId: _identityId, ...fields } = input; // the filter's fields go in on insert
    let upsertedId: unknown;
    try {
      const result = await this.model.updateOne(key, { $setOnInsert: fields }, { upsert: true });
      upsertedId = result.upsertedId;
    } catch (e: unknown) {
      if (isDuplicateKey(e)) return false; // recorded meanwhile by a concurrent close
      throw e;
    }
    if (!upsertedId) return false;

    const payload: ReviewExclusionCreatedPayload = {
      exclusionId: String(upsertedId),
      identityId: input.identityId,
      targetSystem: input.targetSystem,
      scope: input.scope,
      entitlementType: input.entitlementType,
      ...(input.entitlementId ? { entitlementId: input.entitlementId } : {}),
      campaignId: input.campaignId,
      itemId: input.itemId,
      decision: input.decision,
      grantingPolicyIds: input.grantingPolicies.map((p) => p.policyId),
    };
    this.eventEmitter.emit(
      DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED,
      input.identityId,
      payload,
      input.reviewer ? { actor: input.reviewer } : undefined,
    );
    this.logger.log(
      `[ReviewExclusion] ${input.scope} exclusion in ${input.targetSystem} for identity ` +
        `${input.identityId} (campaign ${input.campaignId})`,
    );
    return true;
  }

  /** The identity's active exclusions, newest first. 404 for an identity not in the tenant. */
  async listActive(identityId: string): Promise<{
    identityId: string;
    exclusions: ReviewExclusionView[];
  }> {
    if (!(await this.identityQuery.findById(identityId))) {
      throw new NotFoundException('Identity not found');
    }
    const docs = await this.model
      .find({ tenantId: getCurrentTenantId(), identityId, status: 'active' })
      .sort({ createdAt: -1 })
      .lean<LeanExclusion[]>()
      .exec();
    return { identityId, exclusions: docs.map(toView) };
  }

  /**
   * Lift an active exclusion: the next evaluation grants the access again. 404: no such
   * exclusion for this identity in the tenant; 409: already lifted.
   */
  async lift(identityId: string, exclusionId: string, actor: string): Promise<ReviewExclusionView> {
    const tenantId = getCurrentTenantId();
    const filter = { _id: exclusionId, tenantId, identityId };
    const lifted = await this.model
      .findOneAndUpdate(
        { ...filter, status: 'active' },
        { $set: { status: 'lifted', liftedBy: actor, liftedAt: new Date() } },
        { new: true },
      )
      .lean<LeanExclusion>()
      .exec();
    if (!lifted) {
      const exists = await this.model.exists(filter).exec();
      if (!exists) throw new NotFoundException('No review exclusion with this id for the identity');
      throw new ConflictException('This review exclusion was already lifted');
    }

    const payload: ReviewExclusionLiftedPayload = {
      exclusionId,
      identityId,
      targetSystem: lifted.targetSystem,
      scope: lifted.scope,
      campaignId: lifted.campaignId,
    };
    this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED, identityId, payload, {
      actor,
    });
    return toView(lifted);
  }

  /** systemKeys of the systems the identity has an active account exclusion in. */
  async accountExcludedSystems(identityId: string, tenantId: string): Promise<string[]> {
    const docs = await this.model
      .find({ tenantId, identityId, status: 'active', scope: 'account' })
      .select('systemKey')
      .lean<Array<Pick<ReviewExclusion, 'systemKey'>>>()
      .exec();
    return docs.map((d) => d.systemKey);
  }

  /**
   * The identity's offboarding completed: each active exclusion is lifted by the system with
   * the reason OFFBOARDED_REASON and audited (access_review.exclusion_lifted). Returns how many.
   */
  async endForOffboarding(identityId: string, tenantId: string): Promise<number> {
    const active = await this.model
      .find({ tenantId, identityId, status: 'active' })
      .select('_id')
      .lean<Array<{ _id: unknown }>>()
      .exec();
    let ended = 0;
    for (const { _id } of active) {
      const exclusionId = String(_id);
      const lifted = await this.model
        .findOneAndUpdate(
          { _id: exclusionId, tenantId, status: 'active' },
          {
            $set: {
              status: 'lifted',
              liftedBy: 'system',
              liftedAt: new Date(),
              liftReason: OFFBOARDED_REASON,
            },
          },
          { new: true },
        )
        .lean<LeanExclusion>()
        .exec();
      if (!lifted) continue; // lifted meanwhile
      ended++;
      const payload: ReviewExclusionLiftedPayload = {
        exclusionId,
        identityId,
        targetSystem: lifted.targetSystem,
        scope: lifted.scope,
        campaignId: lifted.campaignId,
        reason: OFFBOARDED_REASON,
      };
      this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED, identityId, payload, {
        actor: 'system:offboarding',
      });
    }
    return ended;
  }

  /** Per granting policy, its exclusions in the tenant: active and lifted. */
  async countsByPolicy(): Promise<PolicyReviewExclusionCount[]> {
    const rows = await this.model
      .aggregate<PolicyReviewExclusionCount>([
        { $match: { tenantId: getCurrentTenantId() } },
        { $unwind: '$grantingPolicies' },
        {
          $group: {
            _id: '$grantingPolicies.policyId',
            policyName: { $last: '$grantingPolicies.policyName' },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            lifted: { $sum: { $cond: [{ $eq: ['$status', 'lifted'] }, 1, 0] } },
          },
        },
        { $project: { _id: 0, policyId: '$_id', policyName: 1, active: 1, lifted: 1 } },
        { $sort: { active: -1, policyId: 1 } },
      ])
      .exec();
    return rows;
  }

  private async identityIdOf(user: { _id?: unknown; email?: string }): Promise<string | null> {
    if (user._id) return String(user._id);
    if (!user.email) return null;
    const found = await this.identityQuery.findByEmail(user.email);
    return found?._id ? String(found._id) : null;
  }
}
