/**
 * Manages certification campaign lifecycle: create, activate, cancel.
 * On activation, resolves the user scope, gathers current entitlements, and
 * generates review items (one per user/entitlement) plus the Temporal workflow.
 */

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID } from 'crypto';
import {
  ReviewCampaign,
  ReviewCampaignDocument,
  CampaignStatus,
  CampaignScope,
} from './schemas/review-campaign.schema';
import { ReviewItem, ReviewItemDocument, ReviewEntitlement } from './schemas/review-item.schema';
import { accessReviewWorkflow } from '../../workflows/access-review.workflow';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IdentityService } from '../identity/identity.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { ReviewTargetAccessService, type ReviewTargets } from './review-target-access.service';
import { accountEntitlements } from './review-account-items';
import { assertKnownSystem, inCampaignScope } from './review-campaign-scope';
import {
  claimActivation,
  refreshActivationClaim,
  releaseFailedActivation,
} from './review-campaign-activation';
import { campaignIdentities, type ProjectedIdentity } from './review-campaign-identities';
import { TEMPORAL_UNREACHABLE_MESSAGE } from './access-review-item.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { ScimToken, ScimTokenDocument } from '../scim-inbound/schemas/scim-token.schema';
import { AdminUser, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import {
  type AccessReviewConfig,
  accessReviewConfig,
} from '@infrastructure/config/access-review.config';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';

export interface CampaignRecurrenceDto {
  enabled: boolean;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
}

export interface CampaignEscalationDto {
  enabled: boolean;
  escalateAfterDays: number;
  escalateTo: 'MANAGER' | 'ADMIN';
}

export interface CreateCampaignDto {
  name: string;
  description?: string;
  scope: CampaignScope;
  deadline: Date;
  autoRevokeOnExpiry?: boolean;
  allowSelfReview?: boolean;
  selfReviewRiskLevels?: string[];
  targetEmploymentTypes?: string[];
  recurrence?: CampaignRecurrenceDto;
  escalation?: CampaignEscalationDto;
}

export interface CampaignFilter {
  status?: CampaignStatus | CampaignStatus[];
  page?: number;
  limit?: number;
}

/** The managerId to look up by employee id: set, not an email, and no managerEmail. */
function managerEmployeeId(identity: {
  managerEmail?: string;
  managerId?: string;
}): string | undefined {
  const id = identity.managerId?.trim();
  return !identity.managerEmail && id && !id.includes('@') ? id : undefined;
}

@Injectable()
export class AccessReviewCampaignService {
  private readonly logger = new Logger(AccessReviewCampaignService.name);

  constructor(
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    @InjectModel(ReviewItem.name)
    private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel(ScimToken.name)
    private readonly scimTokenModel: Model<ScimTokenDocument>,
    @InjectModel(AdminUser.name)
    private readonly adminUserModel: Model<AdminUserDocument>,
    private readonly identityService: IdentityService,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly targetAccess: ReviewTargetAccessService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly temporalClientProvider: TemporalClientProvider,
    @Inject(accessReviewConfig.KEY) private readonly reviewConf: AccessReviewConfig,
    // The target systems a `system` scope may name: connectors that provision
    private readonly connectors: PluginRegistryService,
  ) {}

  private getClient(): Client {
    try {
      return this.temporalClientProvider.getClient();
    } catch {
      // The client reconnects on its own (TemporalClientProvider): a retry is all it takes
      throw new ServiceUnavailableException(TEMPORAL_UNREACHABLE_MESSAGE);
    }
  }

  async createCampaign(dto: CreateCampaignDto, createdBy: string): Promise<ReviewCampaignDocument> {
    assertKnownSystem(
      dto.scope,
      this.connectors.getByCapability('provision').map((m) => m.id),
    );
    const tenantId = getCurrentTenantId();
    const campaignData: Record<string, unknown> = {
      tenantId,
      campaignId: randomUUID(),
      name: dto.name,
      description: dto.description,
      scope: dto.scope,
      targetEmploymentTypes: dto.targetEmploymentTypes ?? [
        'FULL_TIME',
        'PART_TIME',
        'CONTRACTOR',
        'INTERN',
        'CONSULTANT',
      ],
      status: CampaignStatus.DRAFT,
      createdBy,
      deadline: dto.deadline,
      autoRevokeOnExpiry: dto.autoRevokeOnExpiry ?? false,
      allowSelfReview: dto.allowSelfReview ?? false,
      selfReviewRiskLevels: dto.selfReviewRiskLevels ?? ['LOW'],
      stats: { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 },
    };
    if (dto.recurrence?.enabled && dto.recurrence.frequency) {
      campaignData.recurrence = {
        enabled: true,
        frequency: dto.recurrence.frequency,
      };
    }
    if (dto.escalation?.enabled) {
      campaignData.escalation = {
        enabled: true,
        escalateAfterDays: dto.escalation.escalateAfterDays ?? 7,
        escalateTo: dto.escalation.escalateTo ?? 'MANAGER',
      };
    }
    const campaign = await this.campaignModel.create(campaignData);

    this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_CAMPAIGN_CREATED, campaign.campaignId, {
      campaignId: campaign.campaignId,
      name: campaign.name,
      createdBy,
      scope: campaign.scope,
    });

    return campaign;
  }

  async findAll(
    filter: CampaignFilter,
  ): Promise<{ data: ReviewCampaignDocument[]; total: number }> {
    const tenantId = getCurrentTenantId();
    const q: Record<string, unknown> = { tenantId };
    if (filter.status) {
      q.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }

    const total = await this.campaignModel.countDocuments(q).exec();
    const page = filter.page ?? 0;
    const limit = Math.min(filter.limit ?? 50, 100);
    const skip = page * limit;

    const data = await this.campaignModel
      .find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    return { data, total };
  }

  async findOne(campaignId: string): Promise<ReviewCampaignDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.campaignModel.findOne({ campaignId, tenantId }).exec();
    if (!doc) throw new NotFoundException(`Campaign ${campaignId} not found`);
    return doc;
  }

  /**
   * Generates the review items and starts the campaign's workflow. One activation at a time
   * (409 while another runs), and a failed one leaves no items and the campaign DRAFT
   * (review-campaign-activation.ts), so a retry never duplicates items.
   */
  async activate(campaignId: string): Promise<ReviewCampaignDocument> {
    const campaign = await this.findOne(campaignId);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(`Campaign ${campaignId} is not in DRAFT status`);
    }
    const tenantId = getCurrentTenantId();
    const models = [this.campaignModel, this.reviewItemModel] as const;
    const claimMs = this.reviewConf.activationClaimMs;
    const activationId = await claimActivation(...models, tenantId, campaignId, claimMs);
    if (!activationId) {
      throw new ConflictException(
        `Campaign ${campaignId} is being activated, or is no longer a draft`,
      );
    }
    let itemCount: number;
    let workflowId: string;
    try {
      itemCount = await this.generateItems(campaign, tenantId, activationId);
      workflowId = `t-${tenantId || 'default'}-access-review-${campaignId}-${Date.now()}`;
      const stats = {
        totalItems: itemCount,
        approved: 0,
        revoked: 0,
        pending: itemCount,
        expired: 0,
      };
      const live = await this.campaignModel
        .updateOne(
          { campaignId, tenantId, activationId, status: CampaignStatus.DRAFT },
          {
            $set: { status: CampaignStatus.ACTIVE, workflowId, stats },
            $unset: { activationStartedAt: '' },
          },
        )
        .exec();
      if (live.modifiedCount === 0) {
        throw new ConflictException(
          `Campaign ${campaignId} was cancelled, or taken over by another activation, during activation`,
        );
      }
      await this.getClient().workflow.start(accessReviewWorkflow, {
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId,
        args: [{ campaignId, deadline: campaign.deadline, tenantId }],
        searchAttributes: {
          TenantId: [tenantId || 'default'],
        },
      });
    } catch (err: unknown) {
      await releaseFailedActivation(...models, tenantId, campaignId, activationId);
      this.logger.error(
        `[AccessReview] Activation of campaign ${campaignId} failed, its items removed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    const updated = await this.findOne(campaignId);
    this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED, campaignId, {
      campaignId,
      name: campaign.name,
      itemCount,
      deadline: campaign.deadline,
    });

    this.logger.log(
      `[AccessReview] Activated campaign ${campaignId} with ${itemCount} items, workflow ${workflowId}`,
    );
    return updated;
  }

  /**
   * One pending review item per identity in scope and entitlement in scope; returns the count.
   * Before writing each batch of items it renews the claim of `activationId`, and stops
   * (ConflictException) when another activation has taken the campaign over.
   */
  private async generateItems(
    campaign: ReviewCampaignDocument,
    tenantId: string,
    activationId: string,
  ): Promise<number> {
    const { campaignId } = campaign;
    const users = await campaignIdentities(this.identityService, campaign);
    this.logger.log(
      `[AccessReview] Generating items for ${users.length} identities (scope: ${campaign.scope.type})`,
    );

    const batchSize = 50;
    let itemCount = 0;

    const prevDecisionMap = await this.buildPreviousDecisionMap(campaign);
    const targets = await this.targetAccess.loadTargets(tenantId);

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const allEntitlements: Array<{ user: ProjectedIdentity; entitlement: ReviewEntitlement }> =
        [];
      for (const user of batch) {
        const entitlements = await this.gatherEntitlements(user, targets);
        for (const ent of entitlements.filter((e) => inCampaignScope(e, campaign.scope))) {
          allEntitlements.push({ user, entitlement: ent });
        }
      }

      const catalogPairs = allEntitlements
        .filter((e) => e.entitlement.nativeId)
        .map((e) => ({ system: e.entitlement.system, nativeId: e.entitlement.nativeId! }));
      const catalogCache = await this.entitlementCatalog.getCatalogEntriesBatch(catalogPairs);
      // Managers named only by employee id: one indexed lookup per batch
      const employeeIds = [
        ...new Set(batch.map(managerEmployeeId).filter((id): id is string => !!id)),
      ];
      const managersByEmployeeId = employeeIds.length
        ? await this.identityService.findEmailsByEmployeeIds(employeeIds)
        : new Map<string, string>();

      await refreshActivationClaim(this.campaignModel, tenantId, campaignId, activationId);
      for (const { user, entitlement } of allEntitlements) {
        const identityName =
          [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
        const { reviewerId, isSelfReview } = await this.resolveReviewer(
          user,
          entitlement,
          campaign,
          catalogCache,
          managersByEmployeeId,
        );

        const entWithRisk = { ...entitlement };
        if (entitlement.nativeId) {
          const cached = catalogCache.get(`${entitlement.system}:${entitlement.nativeId}`);
          if (cached?.riskLevel) entWithRisk.riskLevel = cached.riskLevel;
        }

        const identityId = user._id?.toString() || user.email;
        const entKey = `${entitlement.system}:${entitlement.nativeId || entitlement.name}`;
        const prev = prevDecisionMap.get(`${identityId}:${entKey}`);

        const itemData: Record<string, unknown> = {
          tenantId,
          itemId: randomUUID(),
          campaignId,
          identityId,
          identityEmail: user.email,
          identityName,
          reviewerId,
          entitlements: [entWithRisk],
          decision: 'pending',
          isSelfReview,
        };
        if (prev && (prev.decision === 'approved' || prev.decision === 'revoked')) {
          itemData.previousDecision = prev.decision;
          itemData.previousDecisionDate = prev.decidedAt;
          itemData.previousCampaignId = campaign.recurrence!.previousCampaignId;
        }

        await this.reviewItemModel.create(itemData);
        itemCount++;
      }
    }
    return itemCount;
  }

  /**
   * Cancel a draft or active campaign and its accessReviewWorkflow (Temporal cancellation: the
   * workflow ends at its next timer or activity). The status is written first: the workflow's
   * activities skip a CANCELLED campaign, so one still running when Temporal cannot be reached
   * escalates, expires, revokes and completes nothing. A recurring campaign's recurrence ends
   * with it (the recertification scheduler clones completed campaigns only). Audited with the
   * admin as actor and the optional reason (access_review.campaign_cancelled).
   */
  async cancel(campaignId: string, reason?: string): Promise<ReviewCampaignDocument> {
    const campaign = await this.findOne(campaignId);
    const cancellable = [CampaignStatus.DRAFT, CampaignStatus.ACTIVE];
    const endRecurrence = campaign.recurrence?.enabled ? { 'recurrence.enabled': false } : {};
    const result = cancellable.includes(campaign.status)
      ? await this.campaignModel
          .updateOne(
            { campaignId, status: { $in: cancellable } },
            { $set: { status: CampaignStatus.CANCELLED, ...endRecurrence } },
          )
          .exec()
      : null;
    if (!result?.modifiedCount) {
      throw new BadRequestException(`Campaign ${campaignId} cannot be cancelled`);
    }
    this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_CAMPAIGN_CANCELLED, campaignId, {
      campaignId,
      name: campaign.name,
      previousStatus: campaign.status,
      ...(reason ? { reason } : {}),
    });
    if (campaign.workflowId) await this.cancelWorkflow(campaignId, campaign.workflowId);
    return this.findOne(campaignId);
  }

  private async cancelWorkflow(campaignId: string, workflowId: string): Promise<void> {
    try {
      await this.temporalClientProvider.getClient().workflow.getHandle(workflowId).cancel();
    } catch (err: unknown) {
      if (err instanceof WorkflowNotFoundError) return; // already ended
      this.logger.error(
        `[AccessReview] Campaign ${campaignId} cancelled, but its workflow ${workflowId} was not: ${err instanceof Error ? err.message : String(err)}. Its activities skip the cancelled campaign.`,
      );
    }
  }

  private async buildPreviousDecisionMap(
    campaign: ReviewCampaignDocument,
  ): Promise<Map<string, { decision: 'approved' | 'revoked'; decidedAt: Date }>> {
    const prevCampaignId = campaign.recurrence?.previousCampaignId;
    if (!prevCampaignId) return new Map();

    const prevItems = await this.reviewItemModel.find({ campaignId: prevCampaignId }).lean().exec();

    const map = new Map<string, { decision: 'approved' | 'revoked'; decidedAt: Date }>();
    for (const item of prevItems) {
      if (item.decision !== 'approved' && item.decision !== 'revoked') continue;
      const ent = item.entitlements?.[0];
      if (!ent || !item.decidedAt) continue;
      const key = `${item.identityId}:${ent.system}:${ent.nativeId || ent.name}`;
      map.set(key, { decision: item.decision, decidedAt: item.decidedAt });
    }
    return map;
  }

  private async resolveReviewer(
    identity: {
      managerEmail?: string;
      managerId?: string;
      email: string;
      employmentType?: string;
      createdBy?: string;
    },
    entitlement: { system: string; nativeId?: string },
    campaign: ReviewCampaignDocument,
    catalogCache?: Map<string, { owner?: string; riskLevel: string }>,
    managersByEmployeeId?: Map<string, string>,
  ): Promise<{ reviewerId: string; isSelfReview: boolean }> {
    if (
      identity.employmentType === 'SERVICE_ACCOUNT' ||
      identity.employmentType === 'ADMIN_ACCOUNT'
    ) {
      return {
        reviewerId: identity.createdBy || this.reviewConf.defaultReviewer,
        isSelfReview: false,
      };
    }
    // A reviewer is matched by the email they sign in with (decide): a managerId that is an HR
    // employee id is the email of the live identity with that employee id; none found (or two),
    // and the owner or default reviewer gets the item
    const employeeId = managerEmployeeId(identity);
    const manager =
      identity.managerEmail ||
      (employeeId ? managersByEmployeeId?.get(employeeId) : identity.managerId);
    if (manager) return { reviewerId: manager, isSelfReview: false };

    if (entitlement.nativeId) {
      const cacheKey = `${entitlement.system}:${entitlement.nativeId}`;
      const cached = catalogCache?.get(cacheKey);
      const owner =
        cached?.owner ??
        (await this.entitlementCatalog.getOwner(entitlement.system, entitlement.nativeId));
      if (owner) return { reviewerId: owner, isSelfReview: false };

      if (campaign.allowSelfReview) {
        const riskLevel =
          cached?.riskLevel ??
          (
            await this.entitlementCatalog.findBySystemAndNativeId(
              entitlement.system,
              entitlement.nativeId,
            )
          )?.riskLevel ??
          'MEDIUM';
        if (campaign.selfReviewRiskLevels?.includes(riskLevel)) {
          return { reviewerId: identity.email, isSelfReview: true };
        }
      }
    }

    return { reviewerId: this.reviewConf.defaultReviewer, isSelfReview: false };
  }

  private async gatherEntitlements(
    user: ProjectedIdentity,
    targets: ReviewTargets,
  ): Promise<ReviewEntitlement[]> {
    const entitlements: ReviewEntitlement[] = [];
    const employmentType = user?.employmentType;

    if (employmentType === 'SERVICE_ACCOUNT') {
      const scimSource = user?.sources?.find((s) => s.sourceName === 'scim-token');
      if (scimSource?.externalId) {
        const token = await this.scimTokenModel.findById(scimSource.externalId).lean().exec();
        if (token?.scopes?.length) {
          for (const scope of token.scopes) {
            const policyManaged = await this.entitlementCatalog.isPolicyManaged(
              'euroid-scim',
              scope,
              scope,
            );
            entitlements.push({
              system: 'euroid-scim',
              type: 'license',
              name: scope,
              nativeId: scope,
              policyManaged,
            });
          }
        }
        user.createdBy = token?.createdBy;
      }
      return entitlements;
    }

    if (employmentType === 'ADMIN_ACCOUNT') {
      const authSource = user?.sources?.find((s) => s.sourceName === 'local-auth');
      if (authSource?.externalId) {
        const admin = await this.adminUserModel.findById(authSource.externalId).lean().exec();
        if (admin?.role) {
          const policyManaged = await this.entitlementCatalog.isPolicyManaged(
            'euroid-admin',
            admin.role,
            admin.role,
          );
          entitlements.push({
            system: 'euroid-admin',
            type: 'group',
            name: admin.role,
            nativeId: admin.role,
            policyManaged,
          });
        }
      }
      return entitlements;
    }

    // Group memberships in Entra ID, AD, Okta and SCIM, each with the account it was found on
    if (!user.email) return entitlements;
    const memberships = await this.targetAccess.gather(
      {
        email: user.email,
        userPrincipalName:
          typeof user.userPrincipalName === 'string' ? user.userPrincipalName : undefined,
        sources: user.sources,
      },
      targets,
    );
    for (const ent of memberships) {
      ent.policyManaged = await this.entitlementCatalog.isPolicyManaged(
        ent.system,
        ent.nativeId ?? ent.name,
        ent.name,
      );
      entitlements.push(ent);
    }

    // Targets without readable memberships: the account itself
    entitlements.push(...accountEntitlements(user));
    return entitlements;
  }
}
