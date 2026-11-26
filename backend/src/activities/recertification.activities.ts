/**
 * Recertification Scheduler Activities
 *
 * Runs daily via Temporal Schedule. Finds completed campaigns with recurrence enabled
 * and nextRunAt due, clones each, hands the recurrence to the clone and activates it.
 *
 * One campaign of a series clones the next one: once the clone is activated the source stops
 * recurring (recurrence.enabled false, no nextRunAt), and the clone sets its own nextRunAt when
 * it completes. A clone whose activation failed stays DRAFT and the source keeps recurring: the
 * next run activates that clone (the failure counts in `errors`). A cancelled clone never
 * completes, so its series ends.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  ReviewCampaign,
  ReviewCampaignDocument,
  CampaignStatus,
  type RecurrenceFrequency,
} from '../modules/access-review/schemas/review-campaign.schema';
import { AccessReviewService } from '../modules/access-review/access-review.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';

const MONTHS_BY_FREQUENCY: Record<RecurrenceFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function formatDateSuffix(date: Date): string {
  return date.toISOString().slice(0, 7).replace('-', '-'); // YYYY-MM
}

export interface RecertificationSchedulerResult {
  campaignsCreated: number;
  errors: number;
}

@Injectable()
export class RecertificationActivities {
  private readonly logger = new Logger(RecertificationActivities.name);

  constructor(
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    private readonly accessReviewService: AccessReviewService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * Find due recurring campaigns and create + activate the next in the chain.
   * When tenantId is empty, process all tenants.
   */
  async runRecertificationScheduler(
    tenantId: string,
    nowIso: string,
  ): Promise<RecertificationSchedulerResult> {
    const now = new Date(nowIso);
    const tenants = tenantId
      ? [{ tenantId }]
      : (await this.tenantService.findAll())
          .filter((t) => t.status === 'active')
          .map((t) => ({ tenantId: t.tenantId }));

    let campaignsCreated = 0;
    let errors = 0;

    for (const { tenantId: tid } of tenants) {
      try {
        const result = await withTenantContext(tid, async () =>
          this.processTenantRecertifications(tid, now),
        );
        campaignsCreated += result.created;
        errors += result.errors;
      } catch (err: unknown) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Recertification] Failed for tenant ${tid}: ${msg}`);
      }
    }

    return { campaignsCreated, errors };
  }

  private async processTenantRecertifications(
    tenantId: string,
    now: Date,
  ): Promise<{ created: number; errors: number }> {
    const dueCampaigns = await this.campaignModel
      .find({
        tenantId,
        status: CampaignStatus.COMPLETED,
        'recurrence.enabled': true,
        'recurrence.nextRunAt': { $lte: now },
      })
      .lean()
      .exec();

    let created = 0;
    let errors = 0;
    for (const campaign of dueCampaigns) {
      try {
        const clone = await this.cloneOf(tenantId, campaign.campaignId);
        if (clone?.status === CampaignStatus.DRAFT) {
          // An earlier run made the clone and its activation failed: activate it now
          await this.activateClone(clone, campaign as ReviewCampaignDocument);
          created++;
        } else if (clone) {
          // Cloned and activated (or cancelled) already: the source stops without a second clone
          await this.stopRecurrence(tenantId, campaign.campaignId);
        } else {
          await this.cloneAndActivateCampaign(campaign as ReviewCampaignDocument, now);
          created++;
        }
      } catch (err: unknown) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[Recertification] Failed to clone or activate the next campaign of ` +
            `${campaign.campaignId}; the next run tries again: ${msg}`,
        );
      }
    }
    return { created, errors };
  }

  private async cloneAndActivateCampaign(
    completed: ReviewCampaignDocument,
    now: Date,
  ): Promise<ReviewCampaignDocument> {
    const frequency = completed.recurrence?.frequency ?? 'QUARTERLY';
    const dateSuffix = formatDateSuffix(now);
    const newName = `${completed.name} - ${dateSuffix}`;
    const templateId = completed.templateCampaignId ?? completed.campaignId;

    const newCampaign = await this.campaignModel.create({
      tenantId: completed.tenantId,
      campaignId: randomUUID(),
      name: newName,
      description: completed.description,
      scope: completed.scope,
      targetEmploymentTypes: completed.targetEmploymentTypes ?? [
        'FULL_TIME',
        'PART_TIME',
        'CONTRACTOR',
        'INTERN',
        'CONSULTANT',
      ],
      status: CampaignStatus.DRAFT,
      createdBy: completed.createdBy,
      deadline: addMonths(now, MONTHS_BY_FREQUENCY[frequency]),
      autoRevokeOnExpiry: completed.autoRevokeOnExpiry ?? false,
      allowSelfReview: completed.allowSelfReview ?? false,
      selfReviewRiskLevels: completed.selfReviewRiskLevels ?? ['LOW'],
      stats: { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 },
      recurrence: {
        enabled: true,
        frequency,
        previousCampaignId: completed.campaignId,
      },
      escalation: completed.escalation,
      templateCampaignId: templateId,
    });
    await this.activateClone(newCampaign, completed);
    return newCampaign;
  }

  /**
   * Activates the clone, and only then hands it the recurrence (the source stops recurring). A
   * failed activation leaves the source recurring and the clone DRAFT: the next run finds the
   * DRAFT clone and activates it, so one failure never ends the series.
   */
  private async activateClone(
    clone: Pick<ReviewCampaignDocument, 'campaignId' | 'name' | 'templateCampaignId'>,
    completed: ReviewCampaignDocument,
  ): Promise<void> {
    await this.accessReviewService.activate(clone.campaignId);
    // The clone carries the recurrence from here
    await this.stopRecurrence(completed.tenantId, completed.campaignId);

    this.eventEmitter.emit(DomainEventType.RECERTIFICATION_CAMPAIGN_CREATED, clone.campaignId, {
      campaignId: clone.campaignId,
      name: clone.name,
      previousCampaignId: completed.campaignId,
      templateCampaignId: clone.templateCampaignId ?? completed.campaignId,
    });

    this.logger.log(
      `[Recertification] Activated campaign ${clone.campaignId} from ${completed.campaignId}`,
    );
  }

  /** The campaign of the series that names this one as its previous campaign, if any. */
  private cloneOf(
    tenantId: string,
    campaignId: string,
  ): Promise<Pick<
    ReviewCampaignDocument,
    'campaignId' | 'name' | 'status' | 'templateCampaignId'
  > | null> {
    return this.campaignModel
      .findOne({ tenantId, 'recurrence.previousCampaignId': campaignId })
      .select('campaignId name status templateCampaignId')
      .lean()
      .exec() as Promise<ReviewCampaignDocument | null>;
  }

  /** The campaign no longer recurs: its clone carries the series. */
  private async stopRecurrence(tenantId: string, campaignId: string): Promise<void> {
    await this.campaignModel
      .updateOne(
        { tenantId, campaignId },
        { $set: { 'recurrence.enabled': false }, $unset: { 'recurrence.nextRunAt': '' } },
      )
      .exec();
    this.logger.log(`[Recertification] Campaign ${campaignId} handed its recurrence to its clone`);
  }
}
