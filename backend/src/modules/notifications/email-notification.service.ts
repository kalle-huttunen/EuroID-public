import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '../identity/identity-pii';
import { EmailDeliveryService, type DispatchResult } from './email-delivery.service';
import { EmailRecipientsService } from './email-recipients.service';
import { MailTransportService } from './mail-transport.service';
import {
  renderAccessExpiring,
  renderApprovalRequested,
  renderReviewAssigned,
  renderReviewEscalated,
  type RenderedEmail,
} from './email-templates';
import { renderDriftThresholdExceeded, type DriftThresholdView } from './drift-threshold-email';
import type { EmailNotificationKind } from './schemas/email-notification.schema';

/** What one notify call did. 'no-recipient': nobody in the tenant matches; 'self': requester. */
export type NotifyResult = DispatchResult | 'no-recipient' | 'self';

export interface ApproverNotice {
  requestId: string;
  stepIndex: number;
  stepCount: number;
  approverEmail?: string;
  approverId?: string;
  /** Set for a ROLE step (not delegated): every active admin user with this role is asked. */
  approverRole?: string;
  requesterId: string;
  requesterEmail?: string;
  entitlements: Array<{ system: string; name: string }>;
}

export interface ReviewerNotice {
  campaignId: string;
  campaignName: string;
  deadline?: Date | string;
  /** ReviewItem.reviewerId: an email (manager, owner, self) or an admin id. */
  reviewerKey: string;
  itemCount: number;
}

export interface EscalationNotice {
  campaignId: string;
  campaignName: string;
  reviewerKey: string;
  daysOverdue?: number;
}

export interface ExpiringAccessNotice {
  identityId: string;
  targetSystem: string;
  expiresAt: Date | string;
  window: 'soon' | 'tomorrow';
}

/** A reconciliation run reached a drift threshold; recipientKey is its notifyEmail. */
export interface DriftThresholdNotice extends DriftThresholdView {
  runId: string;
  recipientKey: string;
}

/** Log form of a recipient key: emails masked, ids as they are. */
function keyForLog(key: string | undefined): string {
  if (!key) return '(none)';
  return key.includes('@') ? maskEmail(key) : key;
}

function expiryDay(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** One outcome for several mails: a failure first, then a sent mail, else the first outcome. */
function combined(results: NotifyResult[]): NotifyResult {
  return results.find((r) => r === 'failed') ?? results.find((r) => r === 'sent') ?? results[0];
}

/**
 * Who gets which email: resolves the recipient inside the tenant, renders the template and
 * hands the mail to EmailDeliveryService. Every method returns what it did and never throws for
 * a send failure (EmailDeliveryService.dispatch catches those).
 */
@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(
    private readonly delivery: EmailDeliveryService,
    private readonly recipients: EmailRecipientsService,
    private readonly transport: MailTransportService,
  ) {}

  isEnabled(): boolean {
    return this.delivery.isEnabled();
  }

  /** The approver of one access request step: an access request is waiting for them. */
  async notifyApprover(tenantId: string, notice: ApproverNotice): Promise<NotifyResult> {
    if (!this.isEnabled()) return 'disabled';
    if (notice.approverRole) return this.notifyRoleHolders(tenantId, notice, notice.approverRole);
    if (notice.approverId && notice.approverId === notice.requesterId) return 'self';
    const to =
      (await this.recipients.resolve(tenantId, notice.approverEmail)) ??
      (await this.recipients.resolve(tenantId, notice.approverId));
    if (!to)
      return this.noRecipient('approval-requested', notice.approverEmail ?? notice.approverId);
    if (notice.requesterEmail && to.toLowerCase() === notice.requesterEmail.toLowerCase()) {
      return 'self';
    }
    return this.sendApprovalRequest(tenantId, notice, to);
  }

  /** A ROLE step: one mail to each active admin user of the tenant with the role, not the requester. */
  private async notifyRoleHolders(
    tenantId: string,
    notice: ApproverNotice,
    role: string,
  ): Promise<NotifyResult> {
    const holders = await this.recipients.roleHolders(tenantId, role);
    const requester = notice.requesterEmail?.toLowerCase();
    const recipients = holders.filter((to) => to.toLowerCase() !== requester);
    if (recipients.length === 0) {
      this.logger.log(
        `No approval-requested email: no active admin user but the requester holds ${role}`,
      );
      return holders.length > 0 ? 'self' : 'no-recipient';
    }
    const results: NotifyResult[] = [];
    for (const to of recipients) results.push(await this.sendApprovalRequest(tenantId, notice, to));
    return combined(results);
  }

  private sendApprovalRequest(
    tenantId: string,
    notice: ApproverNotice,
    to: string,
  ): Promise<DispatchResult> {
    const mail = renderApprovalRequested(
      {
        requestId: notice.requestId,
        stepNumber: notice.stepIndex + 1,
        stepCount: notice.stepCount,
        entitlements: notice.entitlements,
      },
      this.transport.frontendUrl,
    );
    const key = `${notice.requestId}:${notice.stepIndex}:${to.toLowerCase()}`;
    return this.send(tenantId, 'approval-requested', key, to, mail);
  }

  /** A reviewer with pending items in a campaign that was just activated. One mail per campaign. */
  async notifyReviewer(tenantId: string, notice: ReviewerNotice): Promise<NotifyResult> {
    if (!this.isEnabled()) return 'disabled';
    const to = await this.recipients.resolve(tenantId, notice.reviewerKey);
    if (!to) return this.noRecipient('review-assigned', notice.reviewerKey);
    const mail = renderReviewAssigned(
      { campaignName: notice.campaignName, itemCount: notice.itemCount, deadline: notice.deadline },
      this.transport.frontendUrl,
    );
    const key = `${notice.campaignId}:${to.toLowerCase()}`;
    return this.send(tenantId, 'review-assigned', key, to, mail);
  }

  /** The new reviewer of overdue items. One mail per campaign however many items move to them. */
  async notifyEscalatedReviewer(tenantId: string, notice: EscalationNotice): Promise<NotifyResult> {
    if (!this.isEnabled()) return 'disabled';
    const to = await this.recipients.resolve(tenantId, notice.reviewerKey);
    if (!to) return this.noRecipient('review-escalated', notice.reviewerKey);
    const mail = renderReviewEscalated(
      { campaignName: notice.campaignName, daysOverdue: notice.daysOverdue },
      this.transport.frontendUrl,
    );
    const key = `${notice.campaignId}:${to.toLowerCase()}`;
    return this.send(tenantId, 'review-escalated', key, to, mail);
  }

  /** The identity whose time-bound access ends in 7 days, or tomorrow. Once per entry and window. */
  async notifyAccessExpiring(
    tenantId: string,
    notice: ExpiringAccessNotice,
  ): Promise<NotifyResult> {
    if (!this.isEnabled()) return 'disabled';
    const to = await this.recipients.identityEmail(tenantId, notice.identityId);
    if (!to) return this.noRecipient('access-expiring', notice.identityId);
    const mail = renderAccessExpiring(
      { targetSystem: notice.targetSystem, expiresAt: notice.expiresAt, window: notice.window },
      this.transport.frontendUrl,
    );
    const key = [
      notice.window,
      notice.identityId,
      notice.targetSystem,
      expiryDay(notice.expiresAt),
    ].join(':');
    return this.send(tenantId, 'access-expiring', key, to, mail);
  }

  /** The address a reconciliation run named (notifyEmail): its drift alert. Once per run. */
  async notifyDriftThreshold(
    tenantId: string,
    notice: DriftThresholdNotice,
  ): Promise<NotifyResult> {
    if (!this.isEnabled()) return 'disabled';
    const to = await this.recipients.resolve(tenantId, notice.recipientKey);
    if (!to) return this.noRecipient('drift-threshold-exceeded', notice.recipientKey);
    const mail = renderDriftThresholdExceeded(notice, this.transport.frontendUrl);
    const key = `${notice.runId}:${to.toLowerCase()}`;
    return this.send(tenantId, 'drift-threshold-exceeded', key, to, mail);
  }

  private send(
    tenantId: string,
    kind: EmailNotificationKind,
    key: string,
    to: string,
    mail: RenderedEmail,
  ): Promise<DispatchResult> {
    return this.delivery.dispatch(tenantId, { kind, dedupeKey: `${kind}:${key}`, to, ...mail });
  }

  private noRecipient(kind: EmailNotificationKind, key: string | undefined): NotifyResult {
    this.logger.log(`No ${kind} email: ${keyForLog(key)} is not a user of this tenant`);
    return 'no-recipient';
  }
}
