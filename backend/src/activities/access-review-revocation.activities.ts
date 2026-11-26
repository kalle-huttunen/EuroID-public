/**
 * Temporal activities that remove access an access review revoked (accessReviewWorkflow, at
 * campaign close):
 * - listRevocationTasks, recordRevocationResults: default queue (provisioning-default)
 * - revokeReviewAccess: each connector's own queue (provisioning-entra, -ad, -okta, -scim),
 *   registered there by worker.ts through accessReviewRevocationQueueActivities
 * - revokeReviewAccount: default queue; an account item (a target whose memberships EuroID
 *   cannot read) through offboarding's per-target deprovision (ReviewAccountRevocation). Its
 *   outcome also goes on the identity timeline (access_review.account_revoked).
 * - A group membership's outcome goes on the identity timeline too
 *   (access_review.membership_revoked, recordRevocationResults).
 * - Every revoked entitlement listRevocationTasks takes up becomes an access review exclusion
 *   (ReviewExclusionRecorder, policy module): the policy engine no longer grants it, whatever its
 *   removal's outcome, until a policy-admin lifts the exclusion.
 *
 * Only ids travel through workflow history (RevocationTask); the activities read the account,
 * the group and the email from the review item.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { AnyBulkWriteOperation, Model } from 'mongoose';
import { ApplicationFailure } from '@temporalio/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { QUEUE_NAMES } from '@infrastructure/temporal/task-queue.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  type AccessReviewConfig,
  accessReviewConfig,
} from '@infrastructure/config/access-review.config';
import {
  REVOCATION_CONNECTORS,
  type ConnectorRevocationResult,
  type RevocationBatch,
  type RevocationTask,
  type RevocationTaskResult,
  type AccessReviewMembershipRevokedPayload,
} from '@shared/types/access-review-revocation';
import {
  ReviewItem,
  ReviewItemDocument,
  type ReviewEntitlement,
} from '../modules/access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignDocument,
  CampaignStatus,
} from '../modules/access-review/schemas/review-campaign.schema';
import {
  REVIEW_ENTITLEMENT_TYPES,
  routeRevocation,
} from '../modules/access-review/review-revocation';
import { ReviewTargetAccessService } from '../modules/access-review/review-target-access.service';
import { asDeprovisionFailure, DEPROVISION_REJECTED, maskEmails } from './deprovision-failure';
import { ReviewAccountRevocation, type StoredRevocation } from './access-review-account-revocation';
import {
  ReviewExclusionRecorder,
  type ReviewRevocationDecision,
} from '../modules/policy/review-exclusion-recorder.service';

@Injectable()
export class AccessReviewRevocationActivities {
  private readonly logger = new Logger(AccessReviewRevocationActivities.name);

  constructor(
    @InjectModel(ReviewItem.name)
    private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    private readonly targetAccess: ReviewTargetAccessService,
    @Inject(accessReviewConfig.KEY) private readonly reviewConf: AccessReviewConfig,
    private readonly accountRevocation: ReviewAccountRevocation,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly exclusions: ReviewExclusionRecorder,
  ) {}

  /**
   * The next batch of revoked entitlements without a result: entitlements of `revoked` items,
   * and of `expired` items when the campaign has autoRevokeOnExpiry. Entitlements no connector
   * can remove are recorded here as manual-action-needed and not returned. A cancelled
   * campaign revokes nothing. `accounts` (runs with the patch access-review:account-revocation):
   * account items are returned as `account` tasks; runs from before it record them as manual.
   * Each entitlement taken up is recorded as an access review exclusion first: a failed
   * recording writes no manual result, so the retry takes the same entitlements up again.
   */
  async listRevocationTasks(
    campaignId: string,
    tenantId: string,
    correlationId?: string,
    accounts?: boolean,
  ): Promise<RevocationBatch> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const campaign = await this.campaignModel.findOne({ campaignId, tenantId }).lean().exec();
        if (!campaign || campaign.status === CampaignStatus.CANCELLED) {
          return { tasks: [], more: false };
        }
        const decisions = campaign.autoRevokeOnExpiry ? ['revoked', 'expired'] : ['revoked'];
        const limit = this.reviewConf.revocationBatchSize;
        const items = await this.reviewItemModel
          .find({
            campaignId,
            tenantId,
            decision: { $in: decisions },
            entitlements: { $elemMatch: { revocation: { $exists: false } } },
          })
          .sort({ _id: 1 })
          .limit(limit)
          .lean()
          .exec();

        const tasks: RevocationTask[] = [];
        const manual: AnyBulkWriteOperation<ReviewItemDocument>[] = [];
        const revoked: ReviewRevocationDecision[] = [];
        const at = new Date();
        for (const item of items) {
          (item.entitlements ?? []).forEach((ent, entitlementIndex) => {
            if (ent.revocation) return;
            revoked.push(revocationDecision(campaign, item, ent));
            const route = routeRevocation(ent, { accounts });
            if ('connector' in route) {
              tasks.push({ itemId: item.itemId, entitlementIndex, connector: route.connector });
            } else if ('account' in route) {
              tasks.push({ itemId: item.itemId, entitlementIndex, connector: 'account' });
            } else {
              manual.push(
                this.resultWrite(
                  campaignId,
                  tenantId,
                  {
                    itemId: item.itemId,
                    entitlementIndex,
                    outcome: 'manual-action-needed',
                    reason: route.manual,
                  },
                  at,
                ),
              );
            }
          });
        }
        await this.exclusions.record(revoked, tenantId);
        if (manual.length) await this.reviewItemModel.bulkWrite(manual);
        this.logger.log(
          `[AccessReview] Campaign ${campaignId}: ${tasks.length} revocations to run, ` +
            `${manual.length} need manual action`,
        );
        return { tasks, more: items.length === limit };
      },
      { correlationId },
    );
  }

  /**
   * Store each task's outcome on its entitlement, one write each. A result already stored is
   * kept. An outcome this call stored goes on the identity timeline, so a retried call does not
   * repeat the entry: an account item's as access_review.account_revoked, a group membership's as
   * access_review.membership_revoked.
   */
  async recordRevocationResults(
    campaignId: string,
    results: RevocationTaskResult[],
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const at = new Date();
        const valid = results.filter(
          (r) => Number.isInteger(r.entitlementIndex) && r.entitlementIndex >= 0,
        );
        if (!valid.length) return;
        const items = await this.reviewItemModel
          .find({ itemId: { $in: [...new Set(valid.map((r) => r.itemId))] }, campaignId, tenantId })
          .lean()
          .exec();
        const byId = new Map(items.map((i) => [i.itemId, i]));
        for (const r of valid) {
          const { filter, update } = this.resultWrite(campaignId, tenantId, r, at).updateOne;
          const written = await this.reviewItemModel.updateOne(filter, update).exec();
          const item = byId.get(r.itemId);
          if (!written.modifiedCount || !item) continue;
          const type = item.entitlements?.[r.entitlementIndex]?.type;
          if (type === REVIEW_ENTITLEMENT_TYPES.account) {
            this.accountRevocation.announce(campaignId, item, r.entitlementIndex, stored(r));
          } else if (type === REVIEW_ENTITLEMENT_TYPES.group) {
            this.announceMembership(campaignId, item, r.entitlementIndex, stored(r));
          }
        }
      },
      { correlationId },
    );
  }

  /**
   * Remove one revoked account item (runs on the default queue): the identity's account in a
   * target whose memberships EuroID cannot read, through offboarding's per-target deprovision.
   * A failure is thrown as revokeReviewAccess throws its own: retried or final per its kind.
   */
  async revokeReviewAccount(
    task: RevocationTask,
    tenantId: string,
    correlationId?: string,
  ): Promise<ConnectorRevocationResult> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const { item, entitlement } = await this.taskEntitlement(task, tenantId);
        if (entitlement.type !== REVIEW_ENTITLEMENT_TYPES.account) {
          throw ApplicationFailure.nonRetryable(
            'The review entitlement is not an account item',
            DEPROVISION_REJECTED,
          );
        }
        const result = await this.accountRevocation.revoke(
          item.identityId,
          entitlement.system,
          tenantId,
        );
        this.logger.log(
          `[AccessReview] account revocation in ${entitlement.system}, item ${task.itemId}: ` +
            result.outcome,
        );
        return result;
      },
      { correlationId },
    );
  }

  /**
   * Remove one revoked membership through its connector (runs on that connector's queue).
   * 429 waits the target's retry-after, a client error (bad credentials, missing config, an
   * account the target does not know) fails at once, anything else is retried per
   * CONNECTOR_RETRY. Email addresses in failure messages are masked.
   */
  async revokeReviewAccess(
    task: RevocationTask,
    tenantId: string,
    correlationId?: string,
  ): Promise<ConnectorRevocationResult> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const { connector } = task;
        if (connector === 'account') {
          throw ApplicationFailure.nonRetryable(
            'An account item is removed by revokeReviewAccount on the default queue',
            DEPROVISION_REJECTED,
          );
        }
        const { item, entitlement } = await this.taskEntitlement(task, tenantId);
        try {
          const result = await this.targetAccess.revoke(
            connector,
            entitlement,
            { email: item.identityEmail },
            tenantId,
          );
          this.logger.log(
            `[AccessReview] ${task.connector} revocation, item ${task.itemId}: ${result.outcome}`,
          );
          return result;
        } catch (e: unknown) {
          throw asDeprovisionFailure(connector, e);
        }
      },
      { correlationId },
    );
  }

  /**
   * Put a group membership's stored outcome on the identity timeline
   * (access_review.membership_revoked), by the reviewer who revoked the item; an expired item the
   * campaign auto-revokes is the system's. The group by its id only.
   */
  private announceMembership(
    campaignId: string,
    item: Pick<ReviewItem, 'itemId' | 'identityId' | 'decision' | 'decidedBy' | 'entitlements'>,
    entitlementIndex: number,
    result: StoredRevocation,
  ): void {
    const entitlement = item.entitlements?.[entitlementIndex];
    const payload: AccessReviewMembershipRevokedPayload = {
      identityId: item.identityId,
      campaignId,
      itemId: item.itemId,
      targetSystem: entitlement?.system ?? '',
      ...(entitlement?.nativeId ? { groupId: entitlement.nativeId } : {}),
      ...result,
    };
    const actor = item.decision === 'revoked' ? item.decidedBy : undefined;
    this.eventEmitter.emit(
      DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED,
      item.identityId,
      payload,
      actor ? { actor } : undefined,
    );
  }

  /** The task's review item and entitlement; gone is a failure no retry fixes. */
  private async taskEntitlement(task: RevocationTask, tenantId: string) {
    const item = await this.reviewItemModel
      .findOne({ itemId: task.itemId, tenantId })
      .lean()
      .exec();
    const entitlement = item?.entitlements?.[task.entitlementIndex];
    if (!item || !entitlement) {
      throw ApplicationFailure.nonRetryable(
        'The review item or its entitlement no longer exists',
        DEPROVISION_REJECTED,
      );
    }
    return { item, entitlement };
  }

  private resultWrite(campaignId: string, tenantId: string, r: RevocationTaskResult, at: Date) {
    const path = `entitlements.${r.entitlementIndex}.revocation`;
    return {
      updateOne: {
        filter: { itemId: r.itemId, campaignId, tenantId, [path]: { $exists: false } },
        update: { $set: { [path]: { ...stored(r), at } } },
      },
    } satisfies AnyBulkWriteOperation<ReviewItemDocument>;
  }
}

/** A revoked entitlement as its access review exclusion keeps it. */
function revocationDecision(
  campaign: Pick<ReviewCampaign, 'campaignId' | 'name'>,
  item: Pick<
    ReviewItem,
    'itemId' | 'identityId' | 'decision' | 'decidedBy' | 'decidedAt' | 'justification'
  >,
  ent: Pick<ReviewEntitlement, 'system' | 'type' | 'name' | 'nativeId'>,
): ReviewRevocationDecision {
  const revoked = item.decision === 'revoked';
  return {
    campaignId: campaign.campaignId,
    campaignName: campaign.name,
    itemId: item.itemId,
    identityId: item.identityId,
    decision: revoked ? 'revoked' : 'expired',
    ...(revoked && item.decidedBy ? { decidedBy: item.decidedBy } : {}),
    ...(item.decidedAt ? { decidedAt: item.decidedAt } : {}),
    ...(item.justification ? { justification: item.justification } : {}),
    entitlement: {
      system: ent.system,
      type: ent.type,
      name: ent.name,
      ...(ent.nativeId ? { nativeId: ent.nativeId } : {}),
    },
  };
}

/** The outcome as stored: emails masked in what the target said. */
function stored(r: RevocationTaskResult): StoredRevocation {
  return {
    outcome: r.outcome,
    ...(r.detail ? { detail: maskEmails(r.detail) } : {}),
    ...(r.reason ? { reason: maskEmails(r.reason) } : {}),
  };
}

/**
 * revokeReviewAccess for each connector queue it runs on, keyed by queue name. worker.ts adds
 * these to the queue's plugin activities, so the queue the workflow calls is the queue that
 * registers the activity.
 */
export function accessReviewRevocationQueueActivities(
  activities: AccessReviewRevocationActivities,
): Record<string, Record<string, AccessReviewRevocationActivities['revokeReviewAccess']>> {
  const onQueue = { revokeReviewAccess: activities.revokeReviewAccess.bind(activities) };
  return Object.fromEntries(REVOCATION_CONNECTORS.map((c) => [QUEUE_NAMES[c], onQueue]));
}
